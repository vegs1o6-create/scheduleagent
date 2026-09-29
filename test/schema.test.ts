import { describe, expect, it } from "vitest";
import { missingCritical, validateExtraction, validateTextResult } from "../src/schema";
import { UKEPLAN_ASTRID, UKEPLAN_BEGGE, UKEPLAN_SVERRE } from "./fixtures/ukeplaner";
import { FRITEKST, item } from "./fixtures/fritekst";

describe("JSON-validering", () => {
  it.each([
    ["Sverre (2C)", UKEPLAN_SVERRE],
    ["Astrid (Friluftsgruppa)", UKEPLAN_ASTRID],
    ["begge (høstferie)", UKEPLAN_BEGGE],
  ])("godtar eksempel-ukeplan for %s", (_name, fixture) => {
    const parsed = validateExtraction(structuredClone(fixture));
    expect(parsed.items).toHaveLength(fixture.items.length);
    expect(parsed.source).toBe("ukeplan");
  });

  it.each(FRITEKST.map((f) => [f.text, f.result] as const))("godtar fritekst-svar: %s", (_t, result) => {
    expect(validateTextResult(structuredClone(result)).intent).toBe(result.intent);
  });

  it("normaliserer rotete verdier fra modellen", () => {
    const parsed = validateExtraction({
      source: "fritekst",
      child: "",
      week: "  ",
      general_notes: "null",
      items: [
        {
          ...item({ type: "event", title: "  Fotball  " }),
          date: "2026-10-01",
          start_time: "9:00",
          end_time: "",
          all_day: true,
          location: "",
          bring: ["", " sko "],
          confidence: 1.4,
        },
      ],
    });
    expect(parsed.child).toBeNull();
    expect(parsed.week).toBeNull();
    expect(parsed.general_notes).toBeNull();
    const it0 = parsed.items[0]!;
    expect(it0.title).toBe("Fotball");
    expect(it0.start_time).toBe("09:00");
    expect(it0.end_time).toBeNull();
    expect(it0.all_day).toBe(false); // har klokkeslett
    expect(it0.location).toBeNull();
    expect(it0.bring).toEqual(["sko"]);
    expect(it0.confidence).toBe(1);
  });

  it("setter all_day når starttid mangler", () => {
    const parsed = validateExtraction({
      source: "fritekst",
      child: null,
      week: null,
      general_notes: null,
      items: [{ ...item({ type: "event", title: "X", date: "2026-10-01" }), all_day: false }],
    });
    expect(parsed.items[0]!.all_day).toBe(true);
  });

  it.each([
    ["ugyldig dato", { date: "2026-02-30" }],
    ["feil datoformat", { date: "01.10.2026" }],
    ["ugyldig klokkeslett", { start_time: "25:00" }],
    ["confidence som tekst", { confidence: "høy" }],
    ["ukjent type", { type: "møte" }],
    ["tom tittel", { title: "   " }],
    ["ugyldig fristdato", { deadline: "fredag" }],
  ])("avviser %s", (_name, patch) => {
    const raw = {
      source: "fritekst",
      child: null,
      week: null,
      general_notes: null,
      items: [{ ...item({ type: "event", title: "Test", date: "2026-10-01" }), ...patch }],
    };
    expect(() => validateExtraction(raw)).toThrow();
  });

  it("avviser ugyldig uke og manglende felter", () => {
    expect(() =>
      validateExtraction({ source: "ukeplan", child: null, week: "uke 40", items: [], general_notes: null }),
    ).toThrow();
    expect(() => validateExtraction({ source: "ukeplan", items: [] })).toThrow();
    expect(() => validateExtraction("ikke json-objekt")).toThrow();
  });

  it("finner punkter som mangler kritisk info", () => {
    expect(missingCritical(item({ type: "event", title: "X" }))).toBe("dato");
    expect(missingCritical(item({ type: "info", title: "X" }))).toBeNull();
    expect(missingCritical(item({ type: "deadline", title: "X", deadline: "2026-10-02" }))).toBeNull();
    expect(missingCritical(item({ type: "event", title: "X", date: "2026-10-02" }))).toBeNull();
  });
});
