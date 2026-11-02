import { describe, expect, it } from "vitest";
import { processUpdate } from "../src/router";
import type { TgUpdate } from "../src/types";
import { callbackUpdate, documentUpdate, makeDeps, textUpdate } from "./fakes";
import { item } from "./fixtures/fritekst";
import { UKEPLAN_ASTRID, UKEPLAN_SVERRE } from "./fixtures/ukeplaner";

type D = ReturnType<typeof makeDeps>;
const run = (deps: D["deps"], u: unknown) => processUpdate(deps, u as TgUpdate);

function notePicker(telegram: D["telegram"]) {
  const m = [...telegram.sent].reverse().find((x) => x.text.includes("på infoskjermen?"));
  if (!m) throw new Error("fant ikke notatspørsmålet");
  return m;
}

async function approve(d: D, plan = UKEPLAN_SVERRE) {
  d.claude.extractions.push(plan);
  await run(d.deps, documentUpdate());
  await run(d.deps, callbackUpdate(d.telegram.buttons().find((b) => b.startsWith("ok:"))!));
}

describe("lekser og beskjeder som notater på infoskjermen", () => {
  it("ukeplan: foreslår info-punktene og legger bare valgte på skjermen", async () => {
    const d = makeDeps();
    await approve(d);
    const p = notePicker(d.telegram);
    expect(p.text).toContain("1. Sverre: Lekse: les s. 12–15");
    expect(p.text).toContain("2. Sverre: Ukens tema: Høst.");
    const buttons = d.telegram.buttons(p);
    expect(buttons.filter((b) => b.startsWith("pt:"))).toHaveLength(2);
    expect(await d.deps.store.getNotes(d.deps.now())).toEqual([]);

    const token = buttons[0]!.split(":")[1];
    await run(d.deps, callbackUpdate(`pt:${token}:0`, p.id));
    expect(p.keyboard!.at(-1)![0]!.text).toContain("Legg på skjermen (1)");
    await run(d.deps, callbackUpdate(`ps:${token}`, p.id));

    const notes = await d.deps.store.getNotes(d.deps.now());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      text: "Sverre: Lekse: les s. 12–15",
      source: "ukeplan",
      // Uke 40 er over mandag 5. oktober kl. 00:00
      expiresAt: "2026-10-05T00:00:00+02:00",
    });
    expect(p.text).toContain("📌 Lagt på infoskjermen");
    expect(d.telegram.buttons(p)).toEqual([]);
  });

  it("notater fra ukeplanen forsvinner når uka er over", async () => {
    const d = makeDeps();
    await approve(d);
    const p = notePicker(d.telegram);
    await run(d.deps, callbackUpdate(`pa:${d.telegram.buttons(p)[0]!.split(":")[1]}`, p.id));
    await run(d.deps, callbackUpdate(d.telegram.buttons(p).at(-1)!, p.id));
    expect(await d.deps.store.getNotes(new Date("2026-10-04T21:59:00Z"))).toHaveLength(2);
    expect(await d.deps.store.getNotes(new Date("2026-10-04T22:00:00Z"))).toHaveLength(0);
  });

  it("samme ukeplan igjen foreslår ikke notater som allerede ligger på skjermen", async () => {
    const d = makeDeps();
    await approve(d);
    let p = notePicker(d.telegram);
    const token = d.telegram.buttons(p)[0]!.split(":")[1];
    await run(d.deps, callbackUpdate(`pt:${token}:0`, p.id));
    await run(d.deps, callbackUpdate(`ps:${token}`, p.id));

    await approve(d);
    p = notePicker(d.telegram);
    expect(p.text).not.toContain("Lekse");
    expect(p.text).toContain("Ukens tema");
    expect(await d.deps.store.getNotes(d.deps.now())).toHaveLength(1);
  });

  it("«Ingen» legger ingenting på skjermen", async () => {
    const d = makeDeps();
    await approve(d, UKEPLAN_ASTRID);
    const p = notePicker(d.telegram);
    expect(p.text).toContain("Astrid: Brannøvelse torsdag (tor 01.10.)");
    await run(d.deps, callbackUpdate(`pn:${d.telegram.buttons(p)[0]!.split(":")[1]}`, p.id));
    expect(p.text).toContain("Ingenting lagt på infoskjermen");
    expect(await d.deps.store.getNotes(d.deps.now())).toEqual([]);
  });

  it("info med dato utløper dagen etter", async () => {
    const d = makeDeps();
    await approve(d, UKEPLAN_ASTRID);
    const p = notePicker(d.telegram);
    await run(d.deps, callbackUpdate(`pt:${d.telegram.buttons(p)[0]!.split(":")[1]}:0`, p.id));
    await run(d.deps, callbackUpdate(d.telegram.buttons(p).at(-1)!, p.id));
    const [note] = await d.deps.store.getNotes(d.deps.now());
    expect(note!.expiresAt).toBe("2026-10-02T00:00:00+02:00");
  });

  it("fritekst med bare info: ja/nei om å legge den på skjermen", async () => {
    const d = makeDeps();
    d.claude.textResults.push({
      intent: "new",
      followup_question: null,
      reply: null,
      extraction: {
        source: "fritekst",
        child: "Astrid",
        week: null,
        general_notes: null,
        items: [item({ type: "info", title: "Ikke send med godteri på bursdag" })],
      },
    });
    await run(d.deps, textUpdate("Astrid skal ikke ha med godteri på bursdagen"));
    const p = notePicker(d.telegram);
    expect(p.text).toContain("Vil du legge dette på infoskjermen?");
    const [yes, no] = d.telegram.buttons(p);
    expect(no).toMatch(/^pn:/);
    await run(d.deps, callbackUpdate(yes!, p.id));
    const notes = await d.deps.store.getNotes(d.deps.now());
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("Astrid: Ikke send med godteri på bursdag");
    expect(notes[0]!.expiresAt).toBeUndefined();
    expect(d.calendar.events.size).toBe(0);
  });

  it("utløpt spørsmål gir en forklaring", async () => {
    const d = makeDeps();
    await run(d.deps, callbackUpdate("ps:ukjent"));
    expect(d.telegram.last().text).toContain("utløpt");
  });
});
