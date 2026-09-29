/**
 * Fritekst-setninger og hva Claude forventes å svare (brukt som mock).
 * "I dag" i testene er tirsdag 2026-09-29.
 */
import type { Item, TextResult } from "../../src/schema";

export function item(partial: Partial<Item> & Pick<Item, "type" | "title">): Item {
  return {
    child: null,
    date: null,
    start_time: null,
    end_time: null,
    all_day: true,
    location: null,
    bring: [],
    action_required: null,
    deadline: null,
    source_quote: "",
    confidence: 0.95,
    notes: null,
    ...partial,
  };
}

export const FRITEKST: { text: string; result: TextResult }[] = [
  {
    text: "Sverre har fotball torsdag kl 17–18:30 på Tveita",
    result: {
      intent: "new",
      followup_question: null,
      reply: null,
      extraction: {
        source: "fritekst",
        child: "Sverre",
        week: null,
        items: [
          item({
            type: "event",
            title: "Fotball",
            date: "2026-10-01",
            start_time: "17:00",
            end_time: "18:30",
            all_day: false,
            location: "Tveita",
            source_quote: "fotball torsdag kl 17–18:30",
          }),
        ],
        general_notes: null,
      },
    },
  },
  {
    text: "Astrid må ha med matpakke og ekstra votter i morgen",
    result: {
      intent: "new",
      followup_question: null,
      reply: null,
      extraction: {
        source: "fritekst",
        child: "Astrid",
        week: null,
        items: [
          item({
            type: "reminder",
            title: "Matpakke og ekstra votter",
            date: "2026-09-30",
            bring: ["matpakke", "ekstra votter"],
            source_quote: "matpakke og ekstra votter i morgen",
          }),
        ],
        general_notes: null,
      },
    },
  },
  {
    text: "Tannlege for Sverre",
    result: {
      intent: "needs_followup",
      followup_question: "Hvilken dag og når er tannlegetimen?",
      reply: null,
      extraction: {
        source: "fritekst",
        child: "Sverre",
        week: null,
        items: [item({ type: "event", title: "Tannlege", confidence: 0.4, notes: "Dato mangler" })],
        general_notes: null,
      },
    },
  },
];

/** Svaret på oppfølgingsspørsmålet "Hvilken dag ...?" -> "fredag kl 10". */
export const FOLLOWUP_ANSWER: TextResult = {
  intent: "new",
  followup_question: null,
  reply: null,
  extraction: {
    source: "fritekst",
    child: "Sverre",
    week: null,
    items: [
      item({
        type: "event",
        title: "Tannlege",
        date: "2026-10-02",
        start_time: "10:00",
        all_day: false,
        source_quote: "fredag kl 10",
      }),
    ],
    general_notes: null,
  },
};

/** "nei, kl. 09" etter fotball-oppføringen. */
export const CORRECTION: TextResult = {
  intent: "correction",
  followup_question: null,
  reply: null,
  extraction: {
    source: "fritekst",
    child: "Sverre",
    week: null,
    items: [
      item({
        type: "event",
        title: "Fotball",
        date: "2026-10-01",
        start_time: "09:00",
        end_time: "10:30",
        all_day: false,
        location: "Tveita",
        source_quote: "nei, kl. 09",
      }),
    ],
    general_notes: null,
  },
};
