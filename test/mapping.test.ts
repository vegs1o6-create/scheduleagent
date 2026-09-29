import { describe, expect, it } from "vitest";
import { planEvents, resolveChild, titleFor } from "../src/mapping";
import type { Extraction } from "../src/schema";
import { item } from "./fixtures/fritekst";
import { makeDeps } from "./fakes";

const { config } = makeDeps().deps;

function extraction(child: string | null, items: Extraction["items"]): Extraction {
  return { source: "fritekst", child, week: null, items, general_notes: null };
}

describe("barn, tittel og farge", () => {
  it("gjenkjenner navn, alias og 'begge'", () => {
    expect(resolveChild("sverre", config)).toBe("Sverre");
    expect(resolveChild("2C", config)).toBe("Sverre");
    expect(resolveChild("Friluftsgruppa", config)).toBe("Astrid");
    expect(resolveChild("Begge", config)).toBe("begge");
    expect(resolveChild("Ola", config)).toBeNull();
    expect(resolveChild(null, config)).toBeNull();
  });

  it("formaterer tittel", () => {
    expect(titleFor("Sverre", "Fotball")).toBe("Sverre: Fotball");
    expect(titleFor("begge", "Høstferie")).toBe("Begge: Høstferie");
    expect(titleFor(null, "Tannlege")).toBe("Tannlege");
  });
});

describe("kalenderregler", () => {
  it("event med tid: vanlig hendelse med farge, sted og standardlengde", async () => {
    const it0 = item({ type: "event", title: "Fotball", date: "2026-10-01", start_time: "17:00", all_day: false, location: "Tveita" });
    const [ev] = await planEvents(it0, extraction("Sverre", [it0]), config, { withReminders: true });
    expect(ev!.body.summary).toBe("Sverre: Fotball");
    expect(ev!.body.colorId).toBe("9");
    expect(ev!.body.location).toBe("Tveita");
    expect(ev!.body.start).toEqual({ dateTime: "2026-10-01T17:00:00+02:00", timeZone: "Europe/Oslo" });
    expect(ev!.body.end).toEqual({ dateTime: "2026-10-01T18:00:00+02:00", timeZone: "Europe/Oslo" });
    expect(ev!.body.reminders.overrides).toEqual([{ method: "popup", minutes: 60 }]);
    expect(ev!.body.extendedProperties.private.agentKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("event uten tid: heldagshendelse", async () => {
    const it0 = item({ type: "event", title: "Høstfeiring", date: "2026-10-02" });
    const [ev] = await planEvents(it0, extraction("Astrid", [it0]), config);
    expect(ev!.body.start).toEqual({ date: "2026-10-02" });
    expect(ev!.body.end).toEqual({ date: "2026-10-03" });
    expect(ev!.body.colorId).toBe("4");
    expect(ev!.body.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it("deadline: heldag på fristdato, varsel 2 dager før kl 18 og egen 07:30-påminnelse", async () => {
    const it0 = item({ type: "deadline", title: "Svarslipp", date: "2026-10-02", deadline: "2026-10-02", action_required: "Lever svarslipp" });
    const events = await planEvents(it0, extraction("Sverre", [it0]), config, { withReminders: true });
    expect(events).toHaveLength(2);
    const [main, morning] = events;
    expect(main!.body.start).toEqual({ date: "2026-10-02" });
    // 2 dager før kl 18:00 = 30 timer før midnatt
    expect(main!.body.reminders.overrides).toEqual([{ method: "popup", minutes: 30 * 60 }]);
    expect(main!.body.description).toContain("Må gjøres: Lever svarslipp");
    expect(morning!.body.start.dateTime).toBe("2026-10-02T07:30:00+02:00");
    expect(morning!.body.summary).toBe("⏰ Frist i dag – Sverre: Svarslipp");
    expect(morning!.agentKey).toBe(`${main!.agentKey}-am`);
  });

  it("reminder/bring: popup kvelden før kl 19 og ta med-liste i beskrivelsen", async () => {
    const it0 = item({ type: "reminder", title: "Gym", date: "2026-09-28", bring: ["gymtøy", "innesko"], source_quote: "husk gymtøy" });
    const [ev] = await planEvents(it0, extraction("Sverre", [it0]), config, { withReminders: true });
    expect(ev!.body.start).toEqual({ date: "2026-09-28" });
    expect(ev!.body.reminders.overrides).toEqual([{ method: "popup", minutes: 5 * 60 }]);
    expect(ev!.body.description).toContain("• gymtøy\n• innesko");
    expect(ev!.body.description).toContain("Fra kilden: «husk gymtøy»");
  });

  it("event med tid og ta med-liste får både vanlig varsel og kvelden før", async () => {
    const it0 = item({ type: "event", title: "Tur", date: "2026-09-30", start_time: "08:15", all_day: false, bring: ["matpakke"] });
    const [ev] = await planEvents(it0, extraction("Sverre", [it0]), config, { withReminders: true });
    // 19:00 dagen før -> 08:15 = 13t15m
    expect(ev!.body.reminders.overrides).toEqual([
      { method: "popup", minutes: 60 },
      { method: "popup", minutes: 13 * 60 + 15 },
    ]);
  });

  it("kvelden før regnes riktig over sommertidsskiftet", async () => {
    // Søndag 25.10.2026 kl 10:00 (natten har 25 timer) -> lørdag 19:00 er 16 timer før
    const it0 = item({ type: "reminder", title: "Kamp", date: "2026-10-25", start_time: "10:00", all_day: false });
    const [ev] = await planEvents(it0, extraction("Sverre", [it0]), config, { withReminders: true });
    expect(ev!.body.reminders.overrides).toEqual([{ method: "popup", minutes: 16 * 60 }]);
  });

  it("som standard: ingen varsler og ingen ekstra 07:30-hendelse for frister", async () => {
    const d = item({ type: "deadline", title: "Svarslipp", date: "2026-10-02", deadline: "2026-10-02" });
    const events = await planEvents(d, extraction("Sverre", [d]), config);
    expect(events).toHaveLength(1);
    expect(events[0]!.body.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(events[0]!.body.extendedProperties.private.reminder).toBe("off");
    const r = item({ type: "reminder", title: "Gym", date: "2026-09-28", bring: ["gymtøy"] });
    const [ev] = await planEvents(r, extraction("Sverre", [r]), config);
    expect(ev!.body.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it("heldagshendelse med varsel valgt: kvelden før kl 19", async () => {
    const it0 = item({ type: "event", title: "Høstfeiring", date: "2026-10-02" });
    const [ev] = await planEvents(it0, extraction("Astrid", [it0]), config, { withReminders: true });
    expect(ev!.body.reminders.overrides).toEqual([{ method: "popup", minutes: 5 * 60 }]);
    expect(ev!.body.extendedProperties.private.reminder).toBe("on");
  });

  it("info skrives ikke til kalenderen", async () => {
    const it0 = item({ type: "info", title: "Ukens tema", date: "2026-10-01" });
    expect(await planEvents(it0, extraction("Sverre", [it0]), config)).toEqual([]);
  });

  it("'begge' gir 'Begge:' og gul farge; barn på punktet overstyrer toppnivå", async () => {
    const a = item({ type: "event", title: "Høstferie", date: "2026-10-05" });
    const [ev] = await planEvents(a, extraction("begge", [a]), config);
    expect(ev!.body.summary).toBe("Begge: Høstferie");
    expect(ev!.body.colorId).toBe("5");
    const b = item({ type: "event", title: "Svømming", date: "2026-10-05", child: "Astrid" });
    const [ev2] = await planEvents(b, extraction("Sverre", [b]), config);
    expect(ev2!.body.summary).toBe("Astrid: Svømming");
  });
});
