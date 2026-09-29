import { describe, expect, it } from "vitest";
import { processUpdate } from "../src/router";
import type { TgUpdate } from "../src/types";
import { callbackUpdate, documentUpdate, makeDeps, textUpdate } from "./fakes";
import { CORRECTION, FRITEKST } from "./fixtures/fritekst";
import { UKEPLAN_SVERRE } from "./fixtures/ukeplaner";

type D = ReturnType<typeof makeDeps>;
const run = (deps: D["deps"], u: unknown) => processUpdate(deps, u as TgUpdate);

function picker(telegram: D["telegram"]) {
  const m = [...telegram.sent].reverse().find((x) => x.text.includes("Vil du ha varsel"));
  if (!m) throw new Error("fant ikke varselspørsmålet");
  return m;
}

async function approveWeekplan(d: D) {
  d.claude.extractions.push(UKEPLAN_SVERRE);
  await run(d.deps, documentUpdate());
  const ok = d.telegram.buttons().find((b) => b.startsWith("ok:"))!;
  await run(d.deps, callbackUpdate(ok));
}

const eventBy = (d: D, title: string) => [...d.calendar.events.values()].find((e) => e.summary === title)!;

describe("varsler: ingen som standard, botten spør etterpå", () => {
  it("ukeplan: spør med én knapp per oppføring, og lagrer bare valgte", async () => {
    const d = makeDeps();
    await approveWeekplan(d);
    const p = picker(d.telegram);
    const buttons = d.telegram.buttons(p);
    // 5 oppføringer + «Velg alle», «Ingen varsler», «Lagre»
    expect(buttons.filter((b) => b.startsWith("rt:"))).toHaveLength(5);
    expect(p.text).toContain("Svarslipp høsttur");
    expect(p.text).toContain("2 dager før kl. 18 + samme dag kl. 07:30");
    expect([...d.calendar.events.values()].every((e) => e.body.reminders.overrides?.length === 0)).toBe(true);

    // Velg fristen (nr. 4) og gym (nr. 1), lagre
    const [token] = buttons[0]!.split(":").slice(1);
    await run(d.deps, callbackUpdate(`rt:${token}:3`, p.id));
    await run(d.deps, callbackUpdate(`rt:${token}:0`, p.id));
    expect(d.telegram.buttons(p).at(-1)).toBe(`rs:${token}`);
    expect(p.keyboard!.at(-1)![0]!.text).toContain("Lagre varsler (2)");
    await run(d.deps, callbackUpdate(`rs:${token}`, p.id));

    const frist = eventBy(d, "Sverre: Svarslipp høsttur");
    expect(frist.body.reminders.overrides).toEqual([{ method: "popup", minutes: 30 * 60 }]);
    expect(frist.body.extendedProperties.private.reminder).toBe("on");
    expect(eventBy(d, "⏰ Frist i dag – Sverre: Svarslipp høsttur")).toBeDefined();
    expect(eventBy(d, "Sverre: Gym").body.reminders.overrides).toEqual([{ method: "popup", minutes: 300 }]);
    expect(eventBy(d, "Sverre: Foreldremøte").body.reminders.overrides).toEqual([]);
    expect(p.text).toContain("🔔 Varsel lagt til");
    expect(d.telegram.buttons(p)).toEqual([]);
  });

  it("«Ingen varsler» endrer ingenting", async () => {
    const d = makeDeps();
    await approveWeekplan(d);
    const p = picker(d.telegram);
    const token = d.telegram.buttons(p)[0]!.split(":")[1];
    await run(d.deps, callbackUpdate(`rn:${token}`, p.id));
    expect(p.text).toContain("Ingen varsler lagt til");
    expect([...d.calendar.events.values()].every((e) => e.body.reminders.overrides?.length === 0)).toBe(true);
  });

  it("fritekst: ja/nei-spørsmål for én oppføring", async () => {
    const d = makeDeps();
    d.claude.textResults.push(FRITEKST[0]!.result);
    await run(d.deps, textUpdate(FRITEKST[0]!.text));
    const p = picker(d.telegram);
    expect(p.text).toContain("Vil du ha varsel på denne?");
    const [yes, no] = d.telegram.buttons(p);
    expect(yes).toMatch(/^rs:/);
    expect(no).toMatch(/^rn:/);
    await run(d.deps, callbackUpdate(yes!, p.id));
    expect(eventBy(d, "Sverre: Fotball").body.reminders.overrides).toEqual([{ method: "popup", minutes: 60 }]);
  });

  it("varsel beholdes ved rettelse og ved ny versjon av ukeplanen, og spørres ikke om igjen", async () => {
    const d = makeDeps();
    d.claude.textResults.push(FRITEKST[0]!.result, CORRECTION);
    await run(d.deps, textUpdate(FRITEKST[0]!.text));
    await run(d.deps, callbackUpdate(d.telegram.buttons(picker(d.telegram))[0]!, picker(d.telegram).id));
    await run(d.deps, textUpdate("nei, kl. 09"));
    const fotball = eventBy(d, "Sverre: Fotball");
    expect(fotball.start.dateTime).toBe("2026-10-01T09:00:00+02:00");
    expect(fotball.body.reminders.overrides).toEqual([{ method: "popup", minutes: 60 }]);

    // Ukeplan to ganger: varsel valgt på fristen første gang skal beholdes
    await approveWeekplan(d);
    let p = picker(d.telegram);
    const token = d.telegram.buttons(p)[0]!.split(":")[1];
    await run(d.deps, callbackUpdate(`rt:${token}:3`, p.id));
    await run(d.deps, callbackUpdate(`rs:${token}`, p.id));
    const before = d.telegram.sent.length;
    await approveWeekplan(d);
    expect(eventBy(d, "Sverre: Svarslipp høsttur").body.reminders.overrides).toEqual([{ method: "popup", minutes: 1800 }]);
    p = picker(d.telegram);
    expect(d.telegram.sent.indexOf(p)).toBeGreaterThanOrEqual(before);
    expect(p.text).not.toContain("Svarslipp");
    expect(d.telegram.buttons(p).filter((b) => b.startsWith("rt:"))).toHaveLength(4);
  });

  it("/angre sletter også 07:30-hendelsen som kom med varselet", async () => {
    const d = makeDeps();
    d.claude.textResults.push({
      intent: "new",
      followup_question: null,
      reply: null,
      extraction: {
        source: "fritekst",
        child: "Sverre",
        week: null,
        general_notes: null,
        items: [{ ...UKEPLAN_SVERRE.items[3]! }],
      },
    });
    await run(d.deps, textUpdate("svarslipp innen fredag"));
    await run(d.deps, callbackUpdate(d.telegram.buttons(picker(d.telegram))[0]!, picker(d.telegram).id));
    expect(d.calendar.events.size).toBe(2);
    await run(d.deps, textUpdate("/angre"));
    await run(d.deps, callbackUpdate(d.telegram.buttons()[0]!));
    expect(d.calendar.events.size).toBe(0);
  });
});
