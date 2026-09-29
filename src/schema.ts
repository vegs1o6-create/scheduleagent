import { z } from "zod";

/**
 * Skjemaet Claude skal returnere. Holdes fritt for regex/min/max slik at det
 * kan brukes direkte som structured output; strengere validering skjer i
 * `validateExtraction` etterpå.
 */
export const ItemSchema = z.object({
  type: z.enum(["event", "reminder", "deadline", "info"]),
  title: z.string().describe("Kort tittel uten barnets navn"),
  child: z
    .string()
    .nullable()
    .describe("Overstyrer barn for dette punktet (barnets navn eller 'begge'), ellers null"),
  date: z.string().nullable().describe("YYYY-MM-DD, eller null hvis datoen ikke er kjent"),
  start_time: z.string().nullable().describe("HH:MM eller null"),
  end_time: z.string().nullable().describe("HH:MM eller null"),
  all_day: z.boolean(),
  location: z.string().nullable(),
  bring: z.array(z.string()).describe("Ting som må huskes/tas med"),
  action_required: z.string().nullable().describe("Hva forelderen må gjøre, ellers null"),
  deadline: z.string().nullable().describe("YYYY-MM-DD eller null"),
  source_quote: z.string().describe("Kort utdrag fra kilden"),
  confidence: z.number().describe("0.0–1.0"),
  notes: z.string().nullable().describe("Forklaring ved usikkerhet, ellers null"),
});

export const ExtractionSchema = z.object({
  source: z.enum(["ukeplan", "fritekst"]),
  child: z.string().nullable().describe("Barnets navn, 'begge' eller null"),
  week: z.string().nullable().describe("ISO-uke som 2026-W40, eller null"),
  items: z.array(ItemSchema),
  general_notes: z.string().nullable(),
});

/** Innpakning for fritekst: tolkning av intensjon + eventuelt oppfølgingsspørsmål. */
export const TextResultSchema = z.object({
  intent: z
    .enum(["new", "correction", "needs_followup", "not_calendar"])
    .describe(
      "new = nye oppføringer; correction = rettelse av siste oppføring; needs_followup = kritisk info mangler; not_calendar = ingenting å legge inn",
    ),
  followup_question: z.string().nullable().describe("Ett kort spørsmål på norsk hvis intent=needs_followup"),
  reply: z.string().nullable().describe("Kort svar til brukeren hvis intent=not_calendar"),
  extraction: ExtractionSchema,
});

export type Item = z.infer<typeof ItemSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;
export type TextResult = z.infer<typeof TextResultSchema>;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return d.toISOString().slice(0, 10) === s;
}

const StrictItemSchema = ItemSchema.extend({
  title: z.string().trim().min(1).max(200),
  date: z.string().refine(isRealDate, "Ugyldig dato").nullable(),
  start_time: z.string().regex(TIME_RE, "Ugyldig klokkeslett").nullable(),
  end_time: z.string().regex(TIME_RE, "Ugyldig klokkeslett").nullable(),
  deadline: z.string().refine(isRealDate, "Ugyldig fristdato").nullable(),
  confidence: z.number().min(0).max(1),
  bring: z.array(z.string().trim().min(1)),
});

export const StrictExtractionSchema = ExtractionSchema.extend({
  week: z.string().regex(WEEK_RE, "Ugyldig uke").nullable(),
  items: z.array(StrictItemSchema),
});

/**
 * Streng validering + normalisering av det Claude returnerer.
 * - tomme strenger -> null
 * - uten starttid -> all_day
 * - klokkeslett "9:00" -> "09:00"
 */
export function validateExtraction(raw: unknown): Extraction {
  const pre = ExtractionSchema.parse(raw);
  const normalized: Extraction = {
    ...pre,
    child: blankToNull(pre.child),
    week: blankToNull(pre.week),
    general_notes: blankToNull(pre.general_notes),
    items: pre.items.map((it) => {
      const start = padTime(blankToNull(it.start_time));
      const end = padTime(blankToNull(it.end_time));
      return {
        ...it,
        title: it.title.trim(),
        child: blankToNull(it.child),
        date: blankToNull(it.date),
        start_time: start,
        end_time: start ? end : null,
        all_day: start ? false : true,
        location: blankToNull(it.location),
        action_required: blankToNull(it.action_required),
        deadline: blankToNull(it.deadline),
        notes: blankToNull(it.notes),
        bring: it.bring.map((b) => b.trim()).filter(Boolean),
        confidence: Math.min(1, Math.max(0, it.confidence)),
      };
    }),
  };
  return StrictExtractionSchema.parse(normalized);
}

export function validateTextResult(raw: unknown): TextResult {
  const pre = TextResultSchema.parse(raw);
  return {
    ...pre,
    followup_question: blankToNull(pre.followup_question),
    reply: blankToNull(pre.reply),
    extraction: validateExtraction(pre.extraction),
  };
}

function blankToNull(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t === "" || t.toLowerCase() === "null" ? null : t;
}

function padTime(t: string | null): string | null {
  if (!t) return null;
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(t);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : t;
}

/** Punkter som mangler noe kritisk for å kunne skrives til kalenderen. */
export function missingCritical(item: Item): string | null {
  if (item.type === "info") return null;
  if (item.type === "deadline") return item.deadline || item.date ? null : "dato";
  return item.date ? null : "dato";
}
