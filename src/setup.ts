import { anthropicClient } from "./claude";
import type { Env } from "./env";
import { aiProvider, loadConfig } from "./env";
import { FoundryClient, foundryBaseUrl, foundrySettings } from "./foundry";
import { GoogleAuth } from "./google-auth";
import { GoogleCalendar } from "./calendar";
import { GoogleDrive } from "./drive";
import { timingSafeEqual } from "./webhook";
import { addDays, todayIn, zonedRfc3339 } from "./dates";
import { log } from "./log";

/** Secrets som må finnes; nøkkelen til modellen avhenger av AI_PROVIDER. */
function requiredSecrets(env: Env): string[] {
  return [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "TELEGRAM_ALLOWED_CHAT_ID",
    aiProvider(env) === "anthropic" ? "ANTHROPIC_API_KEY" : "FOUNDRY_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
  ];
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function check(name: string, fn: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function telegram<T>(env: Env, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN?.trim()}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(json.description ?? `HTTP ${res.status}`);
  return json.result as T;
}

/**
 * GET /setup?key=<TELEGRAM_WEBHOOK_SECRET>
 *
 * Kobler Telegram-webhooken til denne workeren og sjekker at alle nøklene
 * virker, slik at oppsettet kan gjøres fra nettleseren. Beskyttet med
 * webhook-secreten. Viser aldri verdiene til hemmelighetene.
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = (url.searchParams.get("key") ?? "").trim();
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  if (!secret || !timingSafeEqual(key, secret)) {
    log("setup_rejected", { hasSecret: Boolean(secret) });
    // Hjelpsom feilmelding uten å avsløre verdien (bare lengden).
    const present = requiredSecrets(env).map(
      (n) => `  ${(env as unknown as Record<string, string | undefined>)[n]?.trim() ? "✅" : "❌"} ${n}`,
    ).join("\n");
    const reason = !secret
      ? "Workeren finner ingen TELEGRAM_WEBHOOK_SECRET.\n" +
        "Sjekk under Settings → Variables and Secrets at den finnes, at Type er «Secret» (ikke «Text»),\n" +
        "og at du trykket Deploy etter at du lagret den.\n\n" +
        `Dette er hva workeren på ${url.host} finner (bare ja/nei, ingen verdier):\n${present}`
      : `Nøkkelen i adressen stemmer ikke med TELEGRAM_WEBHOOK_SECRET.\n` +
        `Workerens secret er ${secret.length} tegn lang; nøkkelen i adressen er ${key.length} tegn.` +
        (key.length === 0 ? "\nDu har ikke tatt med ?key=... i adressen." : "") +
        (/[^A-Za-z0-9_-]/.test(key) ? "\nNøkkelen inneholder tegn utenom A-Z, a-z, 0-9, _ og -. Bruk bare disse." : "");
    return new Response(
      `Feil eller manglende nøkkel.\n\n${reason}\n\nBruk: /setup?key=<verdien du la inn som TELEGRAM_WEBHOOK_SECRET i Cloudflare>\n`,
      { status: 401, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  const checks: Check[] = [];
  const required = requiredSecrets(env);
  const missing = required.filter((n) => !(env as unknown as Record<string, string | undefined>)[n]?.trim());
  checks.push({
    name: "Secrets i Cloudflare",
    ok: missing.length === 0,
    detail: missing.length ? `Mangler: ${missing.join(", ")}` : `Alle ${required.length} er lagt inn`,
  });

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    checks.push({
      name: "Webhook-secret",
      ok: false,
      detail: "TELEGRAM_WEBHOOK_SECRET kan bare inneholde A-Z, a-z, 0-9, _ og - (maks 256 tegn). Lag en ny uten mellomrom eller spesialtegn.",
    });
  }

  checks.push(
    await check("Telegram-bot", async () => {
      const me = await telegram<{ username: string }>(env, "getMe");
      return `@${me.username}`;
    }),
  );

  const webhookUrl = `${url.origin}/telegram`;
  checks.push(
    await check("Telegram-webhook", async () => {
      await telegram(env, "setWebhook", {
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
      });
      const info = await telegram<{ url: string; pending_update_count: number; last_error_message?: string }>(
        env,
        "getWebhookInfo",
      );
      return `Satt til ${info.url}${info.last_error_message ? ` (siste feil fra Telegram: ${info.last_error_message})` : ""}`;
    }),
  );

  checks.push(
    await check("Chat-ID", async () => {
      const chat = await telegram<{ type: string; first_name?: string }>(env, "getChat", {
        chat_id: env.TELEGRAM_ALLOWED_CHAT_ID.trim(),
      });
      return `Fant chatten (${chat.first_name ?? chat.type})`;
    }),
  );

  const config = loadConfig(env);
  const auth = new GoogleAuth(
    {
      clientId: env.GOOGLE_CLIENT_ID?.trim() ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
      refreshToken: env.GOOGLE_REFRESH_TOKEN?.trim() ?? "",
    },
    env.STATE,
  );
  const googleOk = await check("Google-innlogging", async () => {
    await auth.accessToken(true);
    return "Refresh token virker";
  });
  checks.push(googleOk);

  if (googleOk.ok) {
    checks.push(
      await check("Google Kalender", async () => {
        const today = todayIn(new Date(), config.timezone);
        const events = await new GoogleCalendar(config.calendarId, auth).list(
          zonedRfc3339(today, "00:00", config.timezone),
          zonedRfc3339(addDays(today, 7), "00:00", config.timezone),
        );
        return `Leser kalenderen (${events.length} hendelser de neste 7 dagene)`;
      }),
    );
    if (config.driveFolderId) {
      checks.push(
        await check("Google Drive-mappe", async () => {
          const files = await new GoogleDrive(auth).listNewFiles(
            config.driveFolderId!,
            new Date(Date.now() - 30 * 86_400_000).toISOString(),
          );
          return `Leser mappen (${files.length} PDF/bilder siste 30 dager)`;
        }),
      );
    }
  }

  if (aiProvider(env) === "foundry") {
    const settings = foundrySettings(env);
    checks.push(
      await check("Microsoft Foundry", async () => {
        const base = foundryBaseUrl(settings.endpoint);
        const model = await new FoundryClient(settings, config).ping();
        return `Deployment «${settings.deployment}» svarer (${model}) på ${base}`;
      }),
    );
  } else {
    checks.push(
      await check("Claude API", async () => {
        try {
          const model = await anthropicClient(env.ANTHROPIC_API_KEY?.trim() ?? "", env.ANTHROPIC_WORKSPACE_ID).models.retrieve(
            config.model,
          );
          return `Nøkkelen virker (${model.id})`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("anthropic-workspace-id")) {
            throw new Error(
              "Nøkkelen er ikke knyttet til et workspace. Enten: lag en ny nøkkel inne i et workspace på console.anthropic.com " +
                "og bytt ANTHROPIC_API_KEY, eller legg inn workspace-ID-en (wrkspc_…) som secret ANTHROPIC_WORKSPACE_ID.",
            );
          }
          throw err;
        }
      }),
    );
  }

  const allOk = checks.every((c) => c.ok);
  const lines = [
    allOk ? "✅ Alt er klart! Send /hjelp til boten i Telegram." : "⚠️ Noe må fikses (se ❌ under).",
    "",
    ...checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`),
    "",
    "Du kan åpne denne siden igjen når som helst for å sjekke oppsettet.",
  ];
  log("setup_run", { ok: allOk, failed: checks.filter((c) => !c.ok).map((c) => c.name) });
  return new Response(lines.join("\n") + "\n", {
    status: allOk ? 200 : 500,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
