import { describe, expect, it } from "vitest";
import { processUpdate } from "../src/router";
import { handleSundayReminder } from "../src/handlers/cron";
import type { TgUpdate } from "../src/types";
import { callbackUpdate, documentUpdate, makeDeps, textUpdate } from "./fakes";
import { CORRECTION, FOLLOWUP_ANSWER, FRITEKST } from "./fixtures/fritekst";
import { UKEPLAN_ASTRID, UKEPLAN_SVERRE, UKEPLAN_SVERRE_REVIDERT } from "./fixtures/ukeplaner";

const run = (deps: ReturnType<typeof makeDeps>["deps"], u: unknown) => processUpdate(deps, u as TgUpdate);

function lastReceipt(telegram: { sent: { text: string; keyboard?: unknown }[] }) {
  const r = [...telegram.sent].reverse().find((m) => m.text.includes("Lagret i kalenderen"));
  if (!r) throw new Error("fant ingen kvittering");
  return r as Parameters<ReturnType<typeof makeDeps>["telegram"]["buttons"]>[0] & { text: string };
}

function draftIdFrom(buttons: string[]): string {
  const ok = buttons.find((b) => b.startsWith("ok:"));
  if (!ok) throw new Error("fant ingen OK-knapp");
  return ok.slice(3);
}

describe("inngang 1: tekst", () => {
  it("oppretter hendelse direkte og svarer med kvittering og lenke", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.textResults.push(FRITEKST[0]!.result);
    await run(deps, textUpdate(FRITEKST[0]!.text));

    expect(calendar.events.size).toBe(1);
    const ev = [...calendar.events.values()][0]!;
    expect(ev.summary).toBe("Sverre: Fotball");
    expect(ev.start.dateTime).toBe("2026-10-01T17:00:00+02:00");
    expect(ev.end.dateTime).toBe("2026-10-01T18:30:00+02:00");
    const receipt = telegram.sent.find((m) => m.text.includes(ev.htmlLink))!;
    expect(receipt.text).toContain("✅");
    // Ingen varsler som standard – botten spør etterpå
    expect(ev.body.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(telegram.last().text).toContain("Vil du ha varsel");
    // Datokonteksten sendes med
    expect(claude.textCalls[0]!.ctx.dateContext).toContain("2026-09-29");
  });

  it("samme melding to ganger gir ikke duplikat (idempotens)", async () => {
    const { deps, calendar, claude } = makeDeps();
    claude.textResults.push(FRITEKST[1]!.result, FRITEKST[1]!.result);
    await run(deps, textUpdate(FRITEKST[1]!.text));
    await run(deps, textUpdate(FRITEKST[1]!.text));
    expect(calendar.events.size).toBe(1);
    expect([...calendar.events.values()][0]!.summary).toBe("Astrid: Matpakke og ekstra votter");
  });

  it("stiller ett oppfølgingsspørsmål når dato mangler, og oppretter etter svar", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.textResults.push(FRITEKST[2]!.result, FOLLOWUP_ANSWER);
    await run(deps, textUpdate("Tannlege for Sverre"));
    expect(calendar.events.size).toBe(0);
    expect(telegram.last().text).toContain("Hvilken dag og når er tannlegetimen?");

    await run(deps, textUpdate("fredag kl 10"));
    expect(claude.textCalls[1]!.ctx.followup).toEqual({
      originalText: "Tannlege for Sverre",
      question: "Hvilken dag og når er tannlegetimen?",
    });
    expect(calendar.events.size).toBe(1);
    expect([...calendar.events.values()][0]!.start.dateTime).toBe("2026-10-02T10:00:00+02:00");
  });

  it("rettelse («nei, kl. 09») oppdaterer siste oppføring i stedet for å lage ny", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.textResults.push(FRITEKST[0]!.result, CORRECTION);
    await run(deps, textUpdate(FRITEKST[0]!.text));
    const id = [...calendar.events.keys()][0]!;

    await run(deps, textUpdate("nei, kl. 09"));
    expect(claude.textCalls[1]!.ctx.lastEntry?.item.title).toBe("Fotball");
    expect(calendar.events.size).toBe(1);
    expect(calendar.events.get(id)!.start.dateTime).toBe("2026-10-01T09:00:00+02:00");
    expect(telegram.last().text).toContain("✏️ Oppdatert");
  });

  it("REQUIRE_APPROVAL_FOR_TEXT=true gir utkast med knapper i stedet for direkte skriving", async () => {
    const { deps, telegram, calendar, claude } = makeDeps({ REQUIRE_APPROVAL_FOR_TEXT: "true" });
    claude.textResults.push(FRITEKST[0]!.result);
    await run(deps, textUpdate(FRITEKST[0]!.text));
    expect(calendar.events.size).toBe(0);
    const id = draftIdFrom(telegram.buttons());
    await run(deps, callbackUpdate(`ok:${id}`));
    expect(calendar.events.size).toBe(1);
  });
});

describe("inngang 2: ukeplan (PDF)", () => {
  it("viser oppsummering med frister øverst, ⚠️ og knapper – skriver ingenting før OK", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.extractions.push(UKEPLAN_ASTRID);
    await run(deps, documentUpdate());

    expect(calendar.events.size).toBe(0);
    const summary = telegram.last();
    expect(telegram.buttons(summary).map((b) => b.split(":")[0])).toEqual(["ok", "fix", "no"]);
    const text = summary.text;
    expect(text).toContain("Ukeplan uke 40 – Astrid");
    expect(text.indexOf("Frister og husk")).toBeLessThan(text.indexOf("📅"));
    expect(text).toContain("⚠️");
    expect(text).toContain("10. oktober er en lørdag");
    expect(text).toContain("Info (skrives ikke til kalenderen)");
  });

  it("OK skriver til kalenderen og gir kvittering; info hoppes over", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.extractions.push(UKEPLAN_SVERRE);
    await run(deps, documentUpdate());
    await run(deps, callbackUpdate(`ok:${draftIdFrom(telegram.buttons())}`));

    // 5 kalenderpunkter (ingen 07:30-hendelse når varsel ikke er valgt)
    expect(calendar.events.size).toBe(5);
    const receipt = lastReceipt(telegram).text;
    expect(receipt).toContain("Opprettet (5)");
    expect(receipt).toContain("Hoppet over (1)");
    expect(receipt).toContain("info, ikke kalender");
  });

  it("dobbelt trykk på OK skriver ikke to ganger", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.extractions.push(UKEPLAN_SVERRE);
    await run(deps, documentUpdate());
    const id = draftIdFrom(telegram.buttons());
    await run(deps, callbackUpdate(`ok:${id}`));
    await run(deps, callbackUpdate(`ok:${id}`));
    expect(calendar.events.size).toBe(5);
    expect(telegram.last().text).toContain("allerede behandlet");
  });

  it("Avbryt lagrer ingenting", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.extractions.push(UKEPLAN_SVERRE);
    await run(deps, documentUpdate());
    await run(deps, callbackUpdate(`no:${draftIdFrom(telegram.buttons())}`));
    expect(calendar.events.size).toBe(0);
    expect(telegram.last().text).toContain("Avbrutt");
  });

  it("Rett: fritekst-rettelse brukes på utkastet og gir ny oppsummering", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.extractions.push(UKEPLAN_ASTRID);
    const corrected = {
      ...UKEPLAN_ASTRID,
      items: UKEPLAN_ASTRID.items.map((i) =>
        i.title.startsWith("Planleggingsdag") ? { ...i, date: "2026-10-09", confidence: 1, notes: null } : i,
      ),
    };
    claude.corrections.push(corrected);
    await run(deps, documentUpdate());
    const id = draftIdFrom(telegram.buttons());
    await run(deps, callbackUpdate(`fix:${id}`));
    expect(telegram.last().text).toContain("Skriv rettelsene");

    await run(deps, textUpdate("planleggingsdagen er fredag 9. oktober"));
    expect(claude.correctionCalls).toEqual(["planleggingsdagen er fredag 9. oktober"]);
    expect(telegram.last().text).toContain("Oppdatert utkast");
    expect(calendar.events.size).toBe(0);

    await run(deps, callbackUpdate(`ok:${draftIdFrom(telegram.buttons())}`));
    const stengt = [...calendar.events.values()].find((e) => e.summary?.includes("Planleggingsdag"));
    expect(stengt!.start.date).toBe("2026-10-09");
  });

  it("ny versjon av ukeplanen oppdaterer i stedet for å duplisere, og nevner endringer", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.extractions.push(UKEPLAN_SVERRE, UKEPLAN_SVERRE_REVIDERT);
    await run(deps, documentUpdate());
    await run(deps, callbackUpdate(`ok:${draftIdFrom(telegram.buttons())}`));
    expect(calendar.events.size).toBe(5);

    await run(deps, documentUpdate());
    await run(deps, callbackUpdate(`ok:${draftIdFrom(telegram.buttons())}`));
    const receipt = lastReceipt(telegram);
    expect(receipt.text).toContain("erstatter en tidligere versjon");
    expect(receipt.text).toContain("Flyttet/endret dato (1)");
    expect(receipt.text).toContain("Ikke lenger med i ukeplanen (2)");
    expect(receipt.text).toContain("Uendret (3)");
    expect(receipt.text).not.toContain("Opprettet");
    // Ingenting slettes automatisk: gamle tur + bibliotek ligger fortsatt der
    expect(calendar.deleted).toEqual([]);
    expect(calendar.events.size).toBe(6);

    // Sletting krever eksplisitt knappetrykk
    const del = telegram.buttons(receipt).find((b) => b.startsWith("undo:"))!;
    await run(deps, callbackUpdate(del));
    expect(calendar.deleted).toHaveLength(2);
    expect(calendar.events.size).toBe(4);
  });
});

describe("kommandoer", () => {
  it("/angre krever bekreftelse, og sletter først etter knappetrykk", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.textResults.push(FRITEKST[0]!.result);
    await run(deps, textUpdate(FRITEKST[0]!.text));
    await run(deps, textUpdate("/angre"));
    expect(calendar.events.size).toBe(1);
    expect(telegram.last().text).toContain("Vil du slette");

    const [yes, no] = telegram.buttons();
    expect(no).toMatch(/^keep:/);
    await run(deps, callbackUpdate(yes!));
    expect(calendar.events.size).toBe(0);
    expect(telegram.last().text).toContain("🗑️ Slettet");

    await run(deps, textUpdate("/angre"));
    expect(telegram.last().text).toContain("ingen nylig opprettet");
  });

  it("/angre + Nei sletter ingenting", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.textResults.push(FRITEKST[0]!.result);
    await run(deps, textUpdate(FRITEKST[0]!.text));
    await run(deps, textUpdate("/angre"));
    await run(deps, callbackUpdate(telegram.buttons()[1]!));
    expect(calendar.events.size).toBe(1);
  });

  it("/uke og /hjelp", async () => {
    const { deps, telegram, calendar, claude } = makeDeps();
    claude.textResults.push(FRITEKST[0]!.result);
    await run(deps, textUpdate(FRITEKST[0]!.text));
    await run(deps, textUpdate("/uke"));
    expect(telegram.last().text).toContain("Uke 40");
    expect(telegram.last().text).toContain("Sverre: Fotball");
    expect(calendar.events.size).toBe(1);
    await run(deps, textUpdate("/hjelp"));
    expect(telegram.last().text).toContain("/angre");
  });
});

describe("sikkerhet i behandlingen", () => {
  it("ignorerer oppdateringer fra andre chatter også i køen", async () => {
    const { deps, telegram } = makeDeps();
    await run(deps, { update_id: 999, message: { message_id: 1, chat: { id: 1 }, date: 0, text: "/hjelp" } });
    expect(telegram.sent).toHaveLength(0);
  });

  it("samme update_id behandles bare én gang", async () => {
    const { deps, telegram } = makeDeps();
    const u = textUpdate("/hjelp");
    await run(deps, u);
    await run(deps, u);
    expect(telegram.sent).toHaveLength(1);
  });

  it("feil rapporteres til brukeren uten å slette noe", async () => {
    const { deps, telegram, calendar } = makeDeps();
    await run(deps, textUpdate("noe")); // FakeClaude har ingen svar -> kaster
    expect(telegram.last().text).toContain("⚠️ Noe gikk galt");
    expect(calendar.deleted).toEqual([]);
  });
});

describe("søndagspåminnelse", () => {
  const sunday18Summer = new Date("2026-10-04T16:00:00Z"); // 18:00 Oslo
  const sunday17Summer = new Date("2026-10-04T15:00:00Z");
  const sunday18Winter = new Date("2026-11-08T17:00:00Z"); // 18:00 Oslo

  it("sender påminnelse søndag 18:00 når ingen ukeplan er mottatt", async () => {
    const { deps, telegram } = makeDeps({}, sunday18Summer);
    expect(await handleSundayReminder(deps)).toBe("sent");
    expect(telegram.last().text).toContain("Husk å sende ukeplanen");
    // Andre kjøring samme dag sender ikke igjen
    expect(await handleSundayReminder(deps)).toBe("skipped");
  });

  it("også om vinteren (17 UTC)", async () => {
    const { deps } = makeDeps({}, sunday18Winter);
    expect(await handleSundayReminder(deps)).toBe("sent");
  });

  it("ikke på feil klokkeslett", async () => {
    const { deps, telegram } = makeDeps({}, sunday17Summer);
    expect(await handleSundayReminder(deps)).toBe("skipped");
    expect(telegram.sent).toHaveLength(0);
  });

  it("ikke hvis ukeplan er behandlet siden mandag", async () => {
    const { deps, telegram } = makeDeps({}, sunday18Summer);
    await deps.store.setLastWeekplanAt("2026-09-29T08:00:00Z"); // tirsdag
    expect(await handleSundayReminder(deps)).toBe("skipped");
    expect(telegram.sent).toHaveLength(0);
  });

  it("sender hvis siste ukeplan er fra forrige uke", async () => {
    const { deps } = makeDeps({}, sunday18Summer);
    await deps.store.setLastWeekplanAt("2026-09-27T10:00:00Z"); // søndag før
    expect(await handleSundayReminder(deps)).toBe("sent");
  });
});

