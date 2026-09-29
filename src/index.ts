import type { Env, JobMessage } from "./env";
import { loadConfig } from "./env";
import type { Deps } from "./deps";
import { Store } from "./store";
import { Telegram } from "./telegram";
import { GoogleAuth } from "./google-auth";
import { GoogleCalendar } from "./calendar";
import { GoogleDrive } from "./drive";
import { ClaudeClient } from "./claude";
import { handleWebhook } from "./webhook";
import { handleSetup } from "./setup";
import { processUpdate } from "./router";
import { handleSundayReminder } from "./handlers/cron";
import { handleDriveFile, pollDrive } from "./handlers/drive";
import { escapeHtml } from "./telegram";
import type { TgUpdate } from "./types";
import { log } from "./log";

/** Cron-uttrykkene i wrangler.toml. */
export const CRON_DRIVE_POLL = "*/5 * * * *";
export const CRON_SUNDAY = "0 16,17 * * SUN";

export function buildDeps(env: Env): Deps {
  const config = loadConfig(env);
  const store = new Store(env.STATE);
  const auth = new GoogleAuth(
    {
      clientId: (env.GOOGLE_CLIENT_ID ?? "").trim(),
      clientSecret: (env.GOOGLE_CLIENT_SECRET ?? "").trim(),
      refreshToken: (env.GOOGLE_REFRESH_TOKEN ?? "").trim(),
    },
    env.STATE,
  );
  return {
    config,
    store,
    telegram: new Telegram((env.TELEGRAM_BOT_TOKEN ?? "").trim()),
    calendar: new GoogleCalendar(config.calendarId, auth),
    drive: new GoogleDrive(auth),
    claude: new ClaudeClient((env.ANTHROPIC_API_KEY ?? "").trim(), config, env.ANTHROPIC_WORKSPACE_ID),
    enqueue: async (job) => {
      await env.JOBS.send(job);
    },
    chatId: (env.TELEGRAM_ALLOWED_CHAT_ID ?? "").trim(),
    now: () => new Date(),
  };
}

export async function processJob(deps: Deps, job: JobMessage): Promise<void> {
  if (job.kind === "telegram_update") {
    await processUpdate(deps, job.update as TgUpdate);
    return;
  }
  if (job.kind === "drive_file") {
    try {
      await handleDriveFile(deps, job.file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("drive_file_failed", { fileId: job.file.id, error: message });
      await deps.telegram
        .sendMessage(
          deps.chatId,
          `⚠️ Klarte ikke å lese «${escapeHtml(job.file.name)}» fra Drive: ${escapeHtml(message)}\nLast opp filen på nytt for å prøve igjen.`,
        )
        .catch(() => undefined);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") {
      return handleWebhook(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/setup") {
      return handleSetup(request, env);
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
        await processJob(deps, message.body);
      } catch (err) {
        log("queue_job_failed", { id: message.id, error: String(err) });
      }
      // Ack uansett: feil er rapportert til brukeren, og nye forsøk kunne gitt doble meldinger.
      message.ack();
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const deps = buildDeps(env);
    const job =
      controller.cron === CRON_SUNDAY
        ? handleSundayReminder(deps)
        : pollDrive(deps).catch((err) => log("drive_poll_failed", { error: String(err) }));
    ctx.waitUntil(job.then(() => undefined));
  },
} satisfies ExportedHandler<Env, JobMessage>;
