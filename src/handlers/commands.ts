import type { Deps } from "../deps";
import type { CalendarEvent } from "../calendar";
import { addDays, formatDateNo, isoWeek, mondayOf, todayIn, zonedParts, zonedRfc3339 } from "../dates";
import { escapeHtml as e } from "../telegram";
import { newId } from "../store";
import { titleFor } from "../mapping";

export const HELP_TEXT = `<b>Familiebot</b> 👨‍👩‍👧‍👦

<b>Skriv fritt</b>, f.eks.:
• «Sverre har fotball torsdag kl 17–18:30»
• «Astrid skal ha med matpakke og ekstra votter i morgen»
• «Svarslipp til skoleturen må leveres innen fredag»
• Rettelse: «nei, kl. 09» (retter siste oppføring, eller svar på kvitteringen)

<b>Send ukeplan</b> som PDF eller bilde. Du får en oppsummering med [OK] [Rett] [Avbryt]; ingenting lagres før du trykker OK.

<b>Kommandoer</b>
/uke – denne ukens oppføringer
/neste – de neste 7 dagene
/angre – slett siste opprettede oppføring (med bekreftelse)
/hjelp – denne teksten`;

export async function handleCommand(deps: Deps, text: string): Promise<void> {
  const { telegram, store, config } = deps;
  const command = text.split(/\s+/)[0]!.split("@")[0]!.toLowerCase();
  await store.clearMode();
  const today = todayIn(deps.now(), config.timezone);

  switch (command) {
    case "/start":
    case "/hjelp":
    case "/help":
      await telegram.sendMessage(deps.chatId, HELP_TEXT);
      return;

    case "/uke": {
      const monday = mondayOf(today);
      const events = await deps.calendar.list(
        zonedRfc3339(monday, "00:00", config.timezone),
        zonedRfc3339(addDays(monday, 7), "00:00", config.timezone),
      );
      await telegram.sendMessage(
        deps.chatId,
        formatEventList(`📅 Uke ${Number(isoWeek(today).slice(6))}`, events, config.timezone),
      );
      return;
    }

    case "/neste": {
      const events = await deps.calendar.list(
        deps.now().toISOString(),
        zonedRfc3339(addDays(today, 8), "00:00", config.timezone),
      );
      await telegram.sendMessage(deps.chatId, formatEventList("📅 De neste 7 dagene", events, config.timezone));
      return;
    }

    case "/angre": {
      const history = await store.getHistory();
      const group = history[0]?.filter((x) => x.created) ?? [];
      if (!group.length) {
        await telegram.sendMessage(deps.chatId, "Det er ingen nylig opprettet oppføring å angre.");
        return;
      }
      const token = newId();
      await store.savePendingUndo({ token, entries: group, label: "angre" });
      const lines = group.map(
        (x) =>
          `• <a href="${e(x.htmlLink)}">${e(titleFor(x.child, x.item.title))}</a>${x.item.date ? ` – ${e(formatDateNo(x.item.date))}` : ""}`,
      );
      await telegram.sendMessage(deps.chatId, `Vil du slette ${group.length === 1 ? "denne" : "disse"}?\n${lines.join("\n")}`, [
        [
          { text: "🗑️ Ja, slett", callback_data: `undo:${token}` },
          { text: "Nei", callback_data: `keep:${token}` },
        ],
      ]);
      return;
    }

    default:
      await telegram.sendMessage(deps.chatId, "Ukjent kommando. Skriv /hjelp for oversikt.");
  }
}

export function formatEventList(heading: string, events: CalendarEvent[], timeZone: string): string {
  if (!events.length) return `<b>${e(heading)}</b>\n\nIngen oppføringer.`;
  const out = [`<b>${e(heading)}</b>`];
  let currentDay = "";
  for (const ev of events) {
    let day: string;
    let time = "";
    if (ev.start.date) {
      day = ev.start.date;
    } else {
      const p = zonedParts(new Date(ev.start.dateTime!), timeZone);
      day = p.date;
      time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} `;
    }
    if (day !== currentDay) {
      currentDay = day;
      const label = formatDateNo(day);
      out.push("", `<u>${e(label.charAt(0).toUpperCase() + label.slice(1))}</u>`);
    }
    const title = e(ev.summary ?? "(uten tittel)");
    out.push(`• ${time ? `<b>${time.trim()}</b> ` : ""}<a href="${e(ev.htmlLink)}">${title}</a>`);
  }
  return out.join("\n");
}
