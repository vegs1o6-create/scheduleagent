import type { Env, JobMessage } from "./env";
import { loadConfig } from "./env";
import type { Deps } from "./deps";
import { Store } from "./store";
import { Telegram } from "./telegram";
import { GoogleCalendar } from "./calendar";
import { ClaudeClient } from "./claude";
import { handleWebhook } from "./webhook";
import { processUpdate } from "./router";
import { handleSundayReminder } from "./handlers/cron";
import type { TgUpdate } from "./types";
import { log } from "./log";

export function buildDeps(env: Env): Deps {
  const config = loadConfig(env);
  const store = new Store(env.STATE);
  return {
    config,
    store,
    telegram: new Telegram(env.TELEGRAM_BOT_TOKEN),
    calendar: new GoogleCalendar(
      config.calendarId,
      {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        refreshToken: env.GOOGLE_REFRESH_TOKEN,
      },
      env.STATE,
    ),
    claude: new ClaudeClient(env.ANTHROPIC_API_KEY, config),
    chatId: env.TELEGRAM_ALLOWED_CHAT_ID.trim(),
    now: () => new Date(),
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") {
      return handleWebhook(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    const deps = buildDeps(env);
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "telegram_update") {
          await processUpdate(deps, message.body.update as TgUpdate);
        }
      } catch (err) {
        log("queue_job_failed", { id: message.id, error: String(err) });
      }
      // Ack uansett: feil er rapportert til brukeren, og nye forsøk kunne gitt doble meldinger.
      message.ack();
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleSundayReminder(buildDeps(env)).then(() => undefined));
  },
} satisfies ExportedHandler<Env, JobMessage>;
