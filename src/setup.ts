import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { loadConfig } from "./env";
import { GoogleAuth } from "./google-auth";
import { GoogleCalendar } from "./calendar";
import { GoogleDrive } from "./drive";
import { timingSafeEqual } from "./webhook";
import { addDays, todayIn, zonedRfc3339 } from "./dates";
import { log } from "./log";

const REQUIRED_SECRETS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_ALLOWED_CHAT_ID",
  "ANTHROPIC_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
] as const;

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
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
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
  const key = url.searchParams.get("key") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(key, env.TELEGRAM_WEBHOOK_SECRET)) {
    log("setup_rejected", {});
    return new Response(
      "Feil eller manglende nøkkel.\n\nBruk: /setup?key=<verdien du la inn som TELEGRAM_WEBHOOK_SECRET i Cloudflare>\n",
      { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const checks: Check[] = [];
  const missing = REQUIRED_SECRETS.filter((n) => !(env as unknown as Record<string, string | undefined>)[n]?.trim());
  checks.push({
    name: "Secrets i Cloudflare",
    ok: missing.length === 0,
    detail: missing.length ? `Mangler: ${missing.join(", ")}` : "Alle 7 er lagt inn",
  });

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
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
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
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
    { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN },
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

  checks.push(
    await check("Claude API", async () => {
      const model = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).models.retrieve(config.model);
      return `Nøkkelen virker (${model.id})`;
    }),
  );

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
