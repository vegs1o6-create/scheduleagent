import type { Config } from "./env";
import type { Extraction, Item } from "./schema";
import { addDays, addMinutesToTime, zonedRfc3339, zonedToUtc } from "./dates";
import { agentKey } from "./key";

export const AGENT_TAG = "familiebot";

export interface GoogleEventBody {
  summary: string;
  description: string;
  location?: string;
  colorId?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  reminders: { useDefault: boolean; overrides?: { method: "popup"; minutes: number }[] };
  extendedProperties: { private: Record<string, string> };
}

/** Et planlagt kalenderskriv: én eller flere hendelser per punkt. */
export interface PlannedEvent {
  agentKey: string;
  item: Item;
  child: string | null;
  body: GoogleEventBody;
}

/** "sverre" / "2C" / "Begge" -> kanonisk navn ("Sverre", "begge") eller null. */
export function resolveChild(raw: string | null | undefined, config: Config): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (["begge", "both", "alle", "begge barna"].includes(v)) return "begge";
  for (const c of config.children) {
    if (c.name.toLowerCase() === v) return c.name;
    if (c.aliases.some((a) => a.toLowerCase() === v)) return c.name;
  }
  for (const c of config.children) {
    if (v.includes(c.name.toLowerCase())) return c.name;
  }
  return null;
}

export function itemChild(item: Item, extraction: Extraction, config: Config): string | null {
  return resolveChild(item.child, config) ?? resolveChild(extraction.child, config);
}

export function titleFor(child: string | null, title: string): string {
  if (!child) return title;
  if (child === "begge") return `Begge: ${title}`;
  return `${child}: ${title}`;
}

export function colorFor(child: string | null, config: Config): string | undefined {
  if (!child) return undefined;
  if (child === "begge") return config.bothColorId;
  return config.children.find((c) => c.name === child)?.colorId;
}

/** Datoen punktet skal ligge på i kalenderen. */
export function eventDate(item: Item): string | null {
  if (item.type === "deadline") return item.deadline ?? item.date;
  return item.date;
}

function describe(item: Item, extraction: Extraction): string {
  const lines: string[] = [];
  if (item.bring.length) lines.push(`Ta med / husk:\n${item.bring.map((b) => `• ${b}`).join("\n")}`);
  if (item.action_required) lines.push(`Må gjøres: ${item.action_required}`);
  if (item.type === "deadline" && item.deadline) lines.push(`Frist: ${item.deadline}`);
  if (item.notes) lines.push(`Merknad: ${item.notes}`);
  if (item.source_quote) lines.push(`Fra kilden: «${item.source_quote}»`);
  lines.push(`Kilde: ${extraction.source}${extraction.week ? ` (${extraction.week})` : ""}`);
  lines.push(`Opprettet av familiebot`);
  return lines.join("\n\n");
}

/** Minutter fra et lokalt klokkeslett til hendelsens start (til popup-påminnelser). */
function minutesBefore(
  startDate: string,
  startTime: string,
  remindDate: string,
  remindTime: string,
  tz: string,
): number {
  const start = zonedToUtc(startDate, startTime, tz).getTime();
  const remind = zonedToUtc(remindDate, remindTime, tz).getTime();
  return Math.round((start - remind) / 60_000);
}

/**
 * Oversetter et punkt til én eller flere Google-hendelser, etter reglene:
 * - event med tid: vanlig hendelse, ellers heldag
 * - deadline: heldag på fristdato
 * - info: ingenting
 *
 * Som standard lages ingen varsler. Med `withReminders`:
 * - deadline: varsel 2 dager før kl 18:00, pluss en kort "frist i dag"-
 *   hendelse kl 07:30 samme dag (Google tillater ikke varsler etter
 *   starten på en heldagshendelse)
 * - reminder / bring / heldag: popup kvelden før kl 19:00
 * - avtale med klokkeslett: popup EVENT_REMINDER_MINUTES før
 */
export interface PlanOptions {
  /** Legg på popup-varsler (standard: av, brukeren velger etter uttrekket). */
  withReminders?: boolean;
}

const NO_REMINDERS: GoogleEventBody["reminders"] = { useDefault: false, overrides: [] };

export async function planEvents(
  item: Item,
  extraction: Extraction,
  config: Config,
  options: PlanOptions = {},
): Promise<PlannedEvent[]> {
  if (item.type === "info") return [];
  const date = eventDate(item);
  if (!date) return [];

  const withReminders = options.withReminders ?? false;
  const tz = config.timezone;
  const child = itemChild(item, extraction, config);
  const key = await agentKey(child, date, item.title);
  const colorId = colorFor(child, config);
  const base = {
    summary: titleFor(child, item.title),
    description: describe(item, extraction),
    ...(item.location ? { location: item.location } : {}),
    ...(colorId ? { colorId } : {}),
  };
  const props = (k: string, extra: Record<string, string> = {}) => ({
    private: {
      agentKey: k,
      agent: AGENT_TAG,
      type: item.type,
      reminder: withReminders ? "on" : "off",
      ...(child ? { child } : {}),
      ...extra,
    },
  });

  if (item.type === "deadline") {
    const main: GoogleEventBody = {
      ...base,
      start: { date },
      end: { date: addDays(date, 1) },
      reminders: withReminders
        ? {
            useDefault: false,
            overrides: [{ method: "popup", minutes: minutesBefore(date, "00:00", addDays(date, -2), "18:00", tz) }],
          }
        : NO_REMINDERS,
      extendedProperties: props(key),
    };
    const planned: PlannedEvent[] = [{ agentKey: key, item, child, body: main }];
    if (withReminders) {
      const morningKey = `${key}-am`;
      planned.push({
        agentKey: morningKey,
        item,
        child,
        body: {
          ...base,
          summary: `⏰ Frist i dag – ${titleFor(child, item.title)}`,
          start: { dateTime: zonedRfc3339(date, "07:30", tz), timeZone: tz },
          end: { dateTime: zonedRfc3339(date, "07:45", tz), timeZone: tz },
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
          extendedProperties: props(morningKey, { companionOf: key }),
        },
      });
    }
    return planned;
  }

  const eveningBefore = item.type === "reminder" || item.bring.length > 0;
  const overrides: { method: "popup"; minutes: number }[] = [];

  let start: GoogleEventBody["start"];
  let end: GoogleEventBody["end"];
  if (item.start_time) {
    const endLocal = item.end_time && item.end_time > item.start_time
      ? { date, time: item.end_time }
      : addMinutesToTime(date, item.start_time, config.defaultEventMinutes);
    start = { dateTime: zonedRfc3339(date, item.start_time, tz), timeZone: tz };
    end = { dateTime: zonedRfc3339(endLocal.date, endLocal.time, tz), timeZone: tz };
    if (item.type === "event") overrides.push({ method: "popup", minutes: config.eventReminderMinutes });
    if (eveningBefore) {
      overrides.push({
        method: "popup",
        minutes: minutesBefore(date, item.start_time, addDays(date, -1), "19:00", tz),
      });
    }
  } else {
    start = { date };
    end = { date: addDays(date, 1) };
    // Heldag: kvelden før kl 19 (også for vanlige heldagshendelser når varsel er valgt).
    overrides.push({ method: "popup", minutes: minutesBefore(date, "00:00", addDays(date, -1), "19:00", tz) });
  }

  const body: GoogleEventBody = {
    ...base,
    start,
    end,
    reminders: withReminders ? { useDefault: false, overrides } : NO_REMINDERS,
    extendedProperties: props(key),
  };
  return [{ agentKey: key, item, child, body }];
}

/** Kort beskrivelse av standardvarselet for et punkt (vises i spørsmålet). */
export function reminderLabel(item: Item): string {
  if (item.type === "deadline") return "2 dager før kl. 18 + samme dag kl. 07:30";
  if (item.start_time) {
    return item.type === "reminder" || item.bring.length > 0 ? "kvelden før kl. 19 + 1 t før" : "1 t før";
  }
  return "kvelden før kl. 19";
}
