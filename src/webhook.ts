import type { Env, JobMessage } from "./env";
import { updateChatId, type TgUpdate } from "./types";
import { log } from "./log";

/** Sammenligning i konstant tid (lekker ikke hvor mange tegn som stemmer). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function verifySecret(request: Request, secret: string | undefined): boolean {
  const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  const expected = secret?.trim();
  if (!header || !expected) return false;
  return timingSafeEqual(header, expected);
}

export function isAllowedChat(update: TgUpdate, allowedChatId: string): boolean {
  const chatId = updateChatId(update);
  return chatId !== null && String(chatId) === String(allowedChatId).trim();
}

/**
 * Telegram-webhooken: verifiserer, filtrerer på chat-ID og legger jobben i
 * køen. Svarer alltid raskt (200 for gyldige kall), og svarer aldri andre chatter.
 */
export async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!verifySecret(request, env.TELEGRAM_WEBHOOK_SECRET)) {
    log("webhook_rejected", { reason: "bad_secret" });
    return new Response("unauthorized", { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    log("webhook_ignored", { reason: "invalid_json" });
    return new Response("ok");
  }

  if (!isAllowedChat(update, env.TELEGRAM_ALLOWED_CHAT_ID)) {
    // Ingen svar til ukjente chatter. Logg bare ID-en.
    log("webhook_ignored", { reason: "chat_not_allowed", chatId: updateChatId(update), updateId: update.update_id });
    return new Response("ok");
  }

  // Fjern "laster"-indikatoren på knappen med en gang.
  if (update.callback_query) {
    const id = update.callback_query.id;
    ctx.waitUntil(
      fetch(`https://api.telegram.org/bot${(env.TELEGRAM_BOT_TOKEN ?? "").trim()}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: id }),
      }).catch(() => undefined),
    );
  }

  try {
    const job: JobMessage = { kind: "telegram_update", update };
    await env.JOBS.send(job);
    log("webhook_enqueued", { updateId: update.update_id });
  } catch (err) {
    log("webhook_enqueue_failed", { updateId: update.update_id, error: String(err) });
  }
  return new Response("ok");
}
