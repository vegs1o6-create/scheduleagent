/**
 * Dato-hjelpere med eksplisitt tidssone (Europe/Oslo).
 *
 * Datoer representeres som "YYYY-MM-DD"-strenger (kalenderdatoer uten tidssone),
 * og all aritmetikk på dem gjøres i UTC slik at sommertid ikke påvirker dem.
 */

export const WEEKDAYS_NO = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"] as const;

export interface ZonedParts {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
  weekday: number; // 1 = mandag ... 7 = søndag
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: weekdayOf(date),
  };
}

export function todayIn(instant: Date, timeZone: string): string {
  return zonedParts(instant, timeZone).date;
}

function toUtcDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = toUtcDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtcDate(d);
}

/** 1 = mandag ... 7 = søndag */
export function weekdayOf(iso: string): number {
  const js = toUtcDate(iso).getUTCDay(); // 0 = søndag
  return js === 0 ? 7 : js;
}

export function mondayOf(iso: string): string {
  return addDays(iso, 1 - weekdayOf(iso));
}

/** ISO-uke, f.eks. "2026-W40". */
export function isoWeek(iso: string): string {
  const thursday = addDays(iso, 4 - weekdayOf(iso));
  const year = Number(thursday.slice(0, 4));
  const jan1 = toUtcDate(`${year}-01-01`);
  const week = Math.floor((toUtcDate(thursday).getTime() - jan1.getTime()) / 86_400_000 / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Mandagen i en ISO-uke ("2026-W40" -> "2026-09-28"). */
export function mondayOfIsoWeek(week: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return null;
  const year = Number(m[1]);
  const jan4 = `${year}-01-04`;
  return addDays(mondayOf(jan4), (Number(m[2]) - 1) * 7);
}

/** Minutter tidssonen ligger foran UTC på et gitt tidspunkt (Oslo: 60 eller 120). */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = toUtcDate(p.date).getTime() + (p.hour * 60 + p.minute) * 60_000;
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** Lokal dato + klokkeslett i tidssonen -> faktisk tidspunkt (UTC). */
export function zonedToUtc(iso: string, time: string, timeZone: string): Date {
  const [h, min] = time.split(":").map(Number) as [number, number];
  const naive = toUtcDate(iso).getTime() + (h * 60 + min) * 60_000;
  // To iterasjoner holder for alle vanlige tidssoner, også rundt sommertid.
  let guess = naive - offsetMinutes(new Date(naive), timeZone) * 60_000;
  guess = naive - offsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess);
}

/** RFC3339 med offset, f.eks. "2026-09-29T08:30:00+02:00". */
export function zonedRfc3339(iso: string, time: string, timeZone: string): string {
  const instant = zonedToUtc(iso, time, timeZone);
  const off = offsetMinutes(instant, timeZone);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  const p = zonedParts(instant, timeZone);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${p.date}T${hh}:${mm}:00${sign}${oh}:${om}`;
}

export function addMinutesToTime(iso: string, time: string, minutes: number): { date: string; time: string } {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  const dayShift = Math.floor(total / 1440);
  const rest = ((total % 1440) + 1440) % 1440;
  return {
    date: addDays(iso, dayShift),
    time: `${String(Math.floor(rest / 60)).padStart(2, "0")}:${String(rest % 60).padStart(2, "0")}`,
  };
}

/** "tirsdag 29.09." */
export function formatDateNo(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${WEEKDAYS_NO[weekdayOf(iso) - 1]} ${d}.${m}.`;
}

/**
 * Tolker vanlige norske relative datouttrykk. Regler:
 * - "i dag", "i morgen", "i overmorgen"
 * - "fredag" / "på fredag": førstkommende fredag etter i dag
 * - "neste fredag" / "fredag neste uke": fredag i neste uke (mandag–søndag)
 * - "denne fredagen" / "fredag denne uken": fredag i inneværende uke
 * Returnerer null for uttrykk den ikke kjenner.
 */
export function resolveRelativeDate(expression: string, today: string): string | null {
  const e = expression.trim().toLowerCase().replace(/\s+/g, " ");
  if (e === "i dag") return today;
  if (e === "i morgen") return addDays(today, 1);
  if (e === "i overmorgen") return addDays(today, 2);
  if (e === "om en uke") return addDays(today, 7);

  const dayIdx = (name: string) => WEEKDAYS_NO.indexOf(name as (typeof WEEKDAYS_NO)[number]) + 1;
  const names = WEEKDAYS_NO.join("|");

  let m = new RegExp(`^neste (${names})$`).exec(e) ?? new RegExp(`^(?:på )?(${names}) neste uke$`).exec(e);
  if (m) return addDays(mondayOf(today), 7 + dayIdx(m[1]!) - 1);

  m = new RegExp(`^(?:på )?(${names}) denne uken?$`).exec(e) ?? new RegExp(`^denne (${names})en$`).exec(e);
  if (m) return addDays(mondayOf(today), dayIdx(m[1]!) - 1);

  m = new RegExp(`^(?:på |til )?(${names})$`).exec(e);
  if (m) {
    const target = dayIdx(m[1]!);
    const diff = (target - weekdayOf(today) + 7) % 7 || 7;
    return addDays(today, diff);
  }
  return null;
}

/**
 * Datokontekst som legges i prompten, slik at Claude ikke trenger å regne selv.
 */
export function buildDateContext(now: Date, timeZone: string): string {
  const today = todayIn(now, timeZone);
  const lines = [
    `I dag er ${formatDateNo(today)} ${today.slice(0, 4)} (${today}), ISO-uke ${isoWeek(today)}, tidssone ${timeZone}.`,
    `Oppslagstabell for relative datoer (bruk denne):`,
    `- "i dag" = ${today}`,
    `- "i morgen" = ${resolveRelativeDate("i morgen", today)}`,
    `- "i overmorgen" = ${resolveRelativeDate("i overmorgen", today)}`,
  ];
  for (const day of WEEKDAYS_NO) {
    lines.push(
      `- "${day}" / "på ${day}" = ${resolveRelativeDate(day, today)}; "neste ${day}" / "${day} neste uke" = ${resolveRelativeDate(`neste ${day}`, today)}`,
    );
  }
  lines.push(`Denne uken: ${mondayOf(today)} til ${addDays(mondayOf(today), 6)}. Neste uke: ${isoWeek(addDays(today, 7))}.`);
  return lines.join("\n");
}
