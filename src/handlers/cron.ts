import type { Deps } from "../deps";
import { mondayOf, zonedParts, zonedToUtc } from "../dates";
import { log } from "../log";

/**
 * Søndag kl. 18 (Europe/Oslo): minn på å sende ukeplanen hvis ingen er
 * behandlet siden mandag denne uken. Cron kjører både 16 og 17 UTC; bare
 * kjøringen som faktisk treffer kl. 18 lokal tid gjør noe.
 */
export async function handleSundayReminder(deps: Deps): Promise<"sent" | "skipped"> {
  const { config, store } = deps;
  const now = zonedParts(deps.now(), config.timezone);
  if (now.weekday !== 7 || now.hour !== 18) {
    log("cron_skip", { reason: "not_sunday_18", local: `${now.date} ${now.hour}` });
    return "skipped";
  }
  if (!(await store.markOnce(`sunday:${now.date}`, 2 * 86_400))) return "skipped";

  const since = zonedToUtc(mondayOf(now.date), "00:00", config.timezone);
  const last = await store.getLastWeekplanAt();
  if (last && new Date(last) >= since) {
    log("cron_skip", { reason: "weekplan_received", last });
    return "skipped";
  }
  await deps.telegram.sendMessage(deps.chatId, "📬 Husk å sende ukeplanen for neste uke.");
  log("cron_reminder_sent", { date: now.date });
  return "sent";
}
