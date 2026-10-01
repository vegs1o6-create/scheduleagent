import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../src/calendar";
import { DISPLAY_HTML, displayData, groupByDay, handleDisplay, type DisplayDeps } from "../src/display";
import type { Env } from "../src/env";
import { processUpdate } from "../src/router";
import type { TgUpdate } from "../src/types";
import { callbackUpdate, makeDeps, NOW, textUpdate } from "./fakes";

const TZ = "Europe/Oslo";
const ev = (summary: string, start: CalendarEvent["start"], end: CalendarEvent["end"], colorId?: string): CalendarEvent => ({
  id: summary,
  htmlLink: "",
  summary,
  start,
  end,
  colorId,
});

function displayDeps(events: CalendarEvent[] = []) {
  const { deps } = makeDeps();
  const calls: string[] = [];
  const d: DisplayDeps = {
    config: deps.config,
    store: deps.store,
    listEvents: async (id) => {
      calls.push(id);
      return events;
    },
    calendarIds: ["familie"],
    days: 14,
    now: () => NOW,
  };
  return { d, calls };
}

const env = { DISPLAY_KEY: "hemmelig" } as unknown as Env;
const req = (path: string, body?: unknown) =>
  new Request(`https://x.dev${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined);

describe("infoskjerm: gruppering", () => {
  it("grupperer per dag i Oslo-tid, heldag først, og bruker fargene fra kalenderen", () => {
    const days = groupByDay(
      [
        ev("Sverre: Fotball", { dateTime: "2026-09-29T15:00:00Z" }, { dateTime: "2026-09-29T16:30:00Z" }, "9"),
        ev("Astrid: Tur", { date: "2026-09-29" }, { date: "2026-09-30" }, "4"),
        ev("Sent", { dateTime: "2026-09-29T22:30:00Z" }, { dateTime: "2026-09-29T23:00:00Z" }),
      ],
      "2026-09-29",
      3,
      TZ,
    );
    expect(days.map((d) => d.relative)).toEqual(["I dag", "I morgen", null]);
    expect(days[0]!.label).toBe("Tirsdag 29.09.");
    expect(days[0]!.events.map((e) => [e.time, e.title, e.color])).toEqual([
      [null, "Astrid: Tur", "#e67c73"],
      ["17:00–18:30", "Sverre: Fotball", "#3f51b5"],
    ]);
    // 22:30 UTC = 00:30 neste dag i Oslo
    expect(days[1]!.events.map((e) => e.time)).toEqual(["00:30–01:00"]);
  });

  it("heldag over flere dager vises hver dag, også når den startet før i dag", () => {
    const days = groupByDay([ev("Høstferie", { date: "2026-09-28" }, { date: "2026-10-01" })], "2026-09-29", 5, TZ);
    expect(days.map((d) => d.events.length)).toEqual([1, 1, 0, 0, 0]);
  });
});

describe("infoskjerm: HTTP", () => {
  it("krever DISPLAY_KEY", async () => {
    const { d } = displayDeps();
    expect((await handleDisplay(req("/skjerm?key=feil"), env, d)).status).toBe(401);
    expect((await handleDisplay(req("/skjerm"), {} as Env, d)).status).toBe(503);
    const ok = await handleDisplay(req("/skjerm?key=hemmelig"), env, d);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(DISPLAY_HTML);
  });

  it("data inneholder kalender, forklaring og notater; notater kan legges til og fjernes", async () => {
    const { d, calls } = displayDeps([
      ev("Sverre: Fotball", { dateTime: "2026-09-29T15:00:00Z" }, { dateTime: "2026-09-29T16:00:00Z" }, "9"),
    ]);
    const add = await handleDisplay(req("/skjerm/notater?key=hemmelig", { text: "  Kjøp melk  " }), env, d);
    const { note } = (await add.json()) as { note: { id: string; text: string } };
    expect(note.text).toBe("Kjøp melk");

    const data = (await (await handleDisplay(req("/skjerm/data?key=hemmelig"), env, d)).json()) as Awaited<
      ReturnType<typeof displayData>
    >;
    expect(calls).toEqual(["familie"]);
    expect(data.today).toBe("2026-09-29");
    expect(data.days).toHaveLength(14);
    expect(data.days[0]!.events[0]!.title).toBe("Sverre: Fotball");
    expect(data.legend.map((l) => l.name)).toEqual(["Sverre", "Astrid", "Begge"]);
    expect(data.notes.map((n) => n.text)).toEqual(["Kjøp melk"]);
    expect(data.weather).toBeNull();

    const del = await handleDisplay(req("/skjerm/notater/slett?key=hemmelig", { id: note.id }), env, d);
    expect(await del.json()).toEqual({ removed: true, notes: [] });
    expect((await handleDisplay(req("/skjerm/notater?key=hemmelig", { text: " " }), env, d)).status).toBe(400);
  });
});

describe("infoskjerm: Telegram", () => {
  const run = (deps: ReturnType<typeof makeDeps>["deps"], u: unknown) => processUpdate(deps, u as TgUpdate);

  it("/notat legger til, /notater viser med knapper, og knappen fjerner notatet", async () => {
    const { deps, telegram, claude } = makeDeps();
    await run(deps, textUpdate("/notat Bytte vinterdekk"));
    expect(telegram.last().text).toContain("Bytte vinterdekk");
    expect(claude.textCalls).toHaveLength(0);
    const [note] = await deps.store.getNotes();
    expect(note!.source).toBe("telegram");

    await run(deps, textUpdate("/notater"));
    expect(telegram.buttons()).toEqual([`nd:${note!.id}`]);

    await run(deps, callbackUpdate(`nd:${note!.id}`));
    expect(telegram.last().text).toContain("Fjernet");
    expect(await deps.store.getNotes()).toEqual([]);
  });

  it("/notat uten tekst forklarer bruken", async () => {
    const { deps, telegram } = makeDeps();
    await run(deps, textUpdate("/notat"));
    expect(telegram.last().text).toContain("/notat Kjøpe");
    expect(await deps.store.getNotes()).toEqual([]);
  });
});

describe("infoskjerm: vær", () => {
  it("tar med været, og en feil i værkallet stopper ikke kalenderen", async () => {
    const { d } = displayDeps();
    const day = { date: "2026-09-29", symbol: "fair_day", max: 14, min: 6, precipitation: 0 };
    expect((await displayData({ ...d, weather: async () => [day] })).weather).toEqual([day]);
    const failing = await displayData({ ...d, weather: async () => Promise.reject(new Error("nede")) });
    expect(failing.weather).toBeNull();
    expect(failing.days).toHaveLength(14);
  });
});

describe("infoskjerm: flere kalendere", () => {
  it("slår sammen kalenderne, og viser resten når én feiler", async () => {
    const { d } = displayDeps();
    const listEvents = async (id: string) => {
      if (id === "feil") throw new Error("403");
      return [ev(`Fra ${id}`, { date: "2026-09-29" }, { date: "2026-09-30" })];
    };
    const data = await displayData({ ...d, listEvents, calendarIds: ["familie", "jobb", "feil"] });
    expect(data.days[0]!.events.map((e) => e.title)).toEqual(["Fra familie", "Fra jobb"]);
    expect(data.calendarErrors).toBe(1);
    await expect(displayData({ ...d, listEvents, calendarIds: ["feil"] })).rejects.toThrow("403");
  });
});
