import type { Deps } from "../deps";
import type { Extraction } from "../schema";
import type { EntryRef, WeekplanRecord } from "../store";
import { newId } from "../store";
import { eventDate, planEvents, titleFor, itemChild, resolveChild, type PlannedEvent } from "../mapping";
import { addDays, zonedRfc3339 } from "../dates";
import type { CalendarEvent } from "../calendar";
import { missingCritical } from "../schema";
import { normalizeTitle } from "../key";
import type { Receipt } from "../summary";
import { log } from "../log";

export interface CommitResult {
  receipt: Receipt;
  written: EntryRef[];
  /** Token for å slette oppføringer som er fjernet fra ukeplanen (krever knappetrykk). */
  removalToken?: string;
}

/**
 * Skriver alle punkter i et utkast til kalenderen (idempotent via agentKey)
 * og lager en kvittering. Sletter aldri noe.
 */
export async function commitExtraction(deps: Deps, extraction: Extraction): Promise<CommitResult> {
  const { calendar, config, store } = deps;
  const receipt: Receipt = { created: [], updated: [], unchanged: [], skipped: [], removedFromPlan: [], moved: [] };
  const written: EntryRef[] = [];

  // Planlegg alt først, så vi kan hente eksisterende hendelser i ett kall.
  // Workers Free tillater bare 50 utgående kall per kjøring.
  const plans: { item: Extraction["items"][number]; child: string | null; planned: PlannedEvent[] }[] = [];
  for (const item of extraction.items) {
    const child = itemChild(item, extraction, config);
    const title = titleFor(child, item.title);
    if (item.type === "info") {
      receipt.skipped.push({ title, date: item.date, reason: "info, ikke kalender" });
      continue;
    }
    const missing = missingCritical(item);
    if (missing) {
      receipt.skipped.push({ title, date: null, reason: `mangler ${missing}` });
      continue;
    }
    const planned = await planEvents(item, extraction, config);
    if (planned.length) plans.push({ item, child, planned });
  }

  const existing = await preloadExisting(deps, plans.flatMap((p) => p.planned));
  const lookup = (key: string) => (existing ? (existing.get(key) ?? null) : undefined);

  for (const { item, child, planned } of plans) {
    const [main, ...companions] = planned;
    if (!main) continue;
    const mainRes = await calendar.upsert(main.body, lookup(main.agentKey));
    const companionIds: string[] = [];
    for (const c of companions) companionIds.push((await calendar.upsert(c.body, lookup(c.agentKey))).event.id);

    const line = { title: titleFor(child, item.title), date: eventDate(item), link: mainRes.event.htmlLink };
    if (mainRes.action === "created") receipt.created.push(line);
    else if (mainRes.action === "updated") receipt.updated.push(line);
    else receipt.unchanged.push(line);

    written.push({
      eventId: mainRes.event.id,
      agentKey: main.agentKey,
      htmlLink: mainRes.event.htmlLink,
      child,
      item,
      companionIds,
      created: mainRes.action === "created",
    });
  }

  let removalToken: string | undefined;
  if (extraction.source === "ukeplan" && extraction.week) {
    const planChild = resolveChild(extraction.child, config);
    const previous = await store.getWeekplan(planChild, extraction.week);
    const newKeys = new Set(written.map((w) => w.agentKey));
    if (previous) {
      receipt.previousVersionAt = previous.processedAt;
      const removed = previous.entries.filter((p) => !newKeys.has(p.agentKey));
      for (const r of removed) {
        const movedTo = written.find(
          (w) => normalizeTitle(w.item.title) === normalizeTitle(r.title) && eventDate(w.item) !== r.date,
        );
        const oldTitle = titleFor(planChild, r.title);
        if (movedTo) {
          receipt.moved.push({
            title: titleFor(movedTo.child, movedTo.item.title),
            date: eventDate(movedTo.item),
            link: movedTo.htmlLink,
            reason: `flyttet fra ${r.date}`,
          });
          receipt.created = receipt.created.filter((c) => c.link !== movedTo.htmlLink);
        }
        receipt.removedFromPlan.push({ title: oldTitle, date: r.date, reason: movedTo ? "gammel dato" : undefined });
      }
      if (removed.length) {
        removalToken = newId();
        await store.savePendingUndo({
          token: removalToken,
          label: "fjernet fra ukeplanen",
          entries: removed.map((r) => ({
            eventId: r.eventId,
            agentKey: r.agentKey,
            htmlLink: "",
            child: planChild,
            item: {
              type: "event",
              title: r.title,
              child: null,
              date: r.date,
              start_time: null,
              end_time: null,
              all_day: true,
              location: null,
              bring: [],
              action_required: null,
              deadline: null,
              source_quote: "",
              confidence: 1,
              notes: null,
            },
            companionIds: r.companionIds,
            created: true,
          })),
        });
      }
    }
    const record: WeekplanRecord = {
      child: planChild,
      week: extraction.week,
      processedAt: deps.now().toISOString(),
      entries: written.map((w) => ({
        agentKey: w.agentKey,
        eventId: w.eventId,
        title: w.item.title,
        date: eventDate(w.item) ?? "",
        companionIds: w.companionIds,
      })),
    };
    await store.saveWeekplan(record);
  }

  await store.pushHistory(written);
  log("commit", {
    source: extraction.source,
    week: extraction.week,
    created: receipt.created.length,
    updated: receipt.updated.length,
    unchanged: receipt.unchanged.length,
    skipped: receipt.skipped.length,
    removedFromPlan: receipt.removedFromPlan.length,
    agentKeys: written.map((w) => w.agentKey),
  });
  return { receipt, written, removalToken };
}

/**
 * Henter alle bot-hendelser i datoområdet i ett kall. Returnerer undefined
 * når det ikke lønner seg (ett punkt), og upsert slår da opp selv.
 */
async function preloadExisting(deps: Deps, planned: PlannedEvent[]): Promise<Map<string, CalendarEvent> | undefined> {
  if (planned.length < 2) return undefined;
  const dates = planned.map((p) => p.body.start.date ?? p.body.start.dateTime!.slice(0, 10)).sort();
  const tz = deps.config.timezone;
  const events = await deps.calendar.listAgentEvents(
    zonedRfc3339(addDays(dates[0]!, -1), "00:00", tz),
    zonedRfc3339(addDays(dates[dates.length - 1]!, 2), "00:00", tz),
  );
  const map = new Map<string, CalendarEvent>();
  for (const ev of events) {
    const key = ev.extendedProperties?.private?.agentKey;
    if (key) map.set(key, ev);
  }
  return map;
}
