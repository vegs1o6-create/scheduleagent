import type { Deps } from "../deps";
import type { TgMessage } from "../types";
import type { EntryRef } from "../store";
import type { Extraction } from "../schema";
import { missingCritical } from "../schema";
import { buildDateContext, formatDateNo } from "../dates";
import { eventDate, planEvents, titleFor } from "../mapping";
import { escapeHtml as e } from "../telegram";
import { formatSummary } from "../summary";
import { draftKeyboard, presentDraft } from "./drafts";
import { askForReminders } from "./reminders";
import { commitExtraction } from "./commit";
import { log } from "../log";

export async function handleText(deps: Deps, msg: TgMessage): Promise<void> {
  const text = (msg.text ?? "").trim();
  if (!text) return;
  const { store, telegram, claude, config } = deps;
  const dateContext = buildDateContext(deps.now(), config.timezone);
  const mode = await store.getMode();
  await telegram.sendChatAction(deps.chatId, "typing");

  // 1) Rettelser til et utkast etter trykk på [Rett].
  if (mode?.kind === "awaiting_correction") {
    await store.clearMode();
    const draft = await store.getDraft(mode.draftId);
    if (!draft || draft.status !== "pending") {
      await telegram.sendMessage(deps.chatId, "Fant ikke utkastet lenger. Send det på nytt.");
      return;
    }
    const updated = await claude.applyCorrection(draft.extraction, text, dateContext);
    log("draft_corrected", { draftId: draft.id, items: updated.items.length });
    if (draft.summaryMessageId) await telegram.removeKeyboard(deps.chatId, draft.summaryMessageId);
    draft.extraction = updated;
    draft.summaryMessageId = await telegram.sendMessage(
      deps.chatId,
      formatSummary(updated, config, "🔁 Oppdatert utkast"),
      draftKeyboard(draft.id),
    );
    await store.saveDraft(draft);
    return;
  }

  // 2) Svar på et oppfølgingsspørsmål, eller ny melding.
  const followup = mode?.kind === "awaiting_followup" ? mode : null;
  if (followup) await store.clearMode();

  const replied = msg.reply_to_message ? await store.getLinkedEntries(msg.reply_to_message.message_id) : null;
  const repliedEntry = replied?.[replied.length - 1] ?? null;
  const lastEntry = followup ? null : await store.lastEntry();

  const result = await claude.interpretText(text, {
    dateContext,
    lastEntry: lastEntry ? { child: lastEntry.child, item: lastEntry.item } : null,
    repliedEntry: repliedEntry ? { child: repliedEntry.child, item: repliedEntry.item } : null,
    followup: followup ? { originalText: followup.originalText, question: followup.question } : null,
  });
  log("text_interpreted", { intent: result.intent, items: result.extraction.items.length });

  if (result.intent === "not_calendar") {
    await telegram.sendMessage(
      deps.chatId,
      e(result.reply ?? "Fant ikke noe å legge i kalenderen. Skriv /hjelp for eksempler."),
    );
    return;
  }

  if (result.intent === "correction") {
    const target = repliedEntry ?? lastEntry;
    if (target && result.extraction.items[0]) {
      await applyEntryCorrection(deps, target, result.extraction, msg.message_id);
      return;
    }
    // Ingenting å rette: behandles som ny oppføring.
  }

  const needsDate = result.extraction.items.find((it) => missingCritical(it));
  if (result.intent === "needs_followup" || needsDate) {
    if (followup) {
      await telegram.sendMessage(
        deps.chatId,
        "Jeg fikk fortsatt ikke tak i datoen. Send hele beskjeden på nytt med dato, f.eks. «Sverre fotball torsdag kl 17».",
      );
      return;
    }
    const question =
      result.followup_question ?? `Hvilken dag gjelder «${needsDate?.title ?? "dette"}»?`;
    await store.setMode({ kind: "awaiting_followup", originalText: text, question });
    await telegram.sendMessage(deps.chatId, `❓ ${e(question)}`);
    return;
  }

  const extraction: Extraction = { ...result.extraction, source: "fritekst" };
  if (!extraction.items.length) {
    await telegram.sendMessage(deps.chatId, "Fant ikke noe å legge i kalenderen.");
    return;
  }

  if (config.requireApprovalForText) {
    await presentDraft(deps, extraction, "text");
    return;
  }

  // Bare info? Vis oppsummering uten å skrive noe.
  if (extraction.items.every((it) => it.type === "info")) {
    await telegram.sendMessage(deps.chatId, formatSummary(extraction, config, "ℹ️ Notert (ikke kalender)"));
    return;
  }

  const { written, receipt } = await commitExtraction(deps, extraction);
  const lines = written.map((w) => {
    const date = eventDate(w.item);
    const when = `${date ? formatDateNo(date) : ""}${w.item.start_time ? ` kl. ${w.item.start_time}` : ""}`;
    const warn = w.item.confidence < config.lowConfidence ? " ⚠️" : "";
    const verb = w.created ? "✅" : "🔁";
    return `${verb} <a href="${e(w.htmlLink)}">${e(titleFor(w.child, w.item.title))}</a> – ${e(when)}${warn}`;
  });
  for (const s of receipt.skipped) lines.push(`⏭️ ${e(s.title)} – <i>${e(s.reason ?? "")}</i>`);
  if (written.some((w) => w.item.confidence < config.lowConfidence)) {
    lines.push("<i>⚠️ usikker tolkning – svar på denne meldingen for å rette.</i>");
  }
  const receiptId = await telegram.sendMessage(deps.chatId, lines.join("\n"), undefined, msg.message_id);
  await store.linkMessage(receiptId, written);
  await store.linkMessage(msg.message_id, written);
  await askForReminders(deps, written, extraction);
}

/** "nei, kl. 09": oppdaterer eksisterende hendelse i stedet for å lage en ny. */
async function applyEntryCorrection(
  deps: Deps,
  target: EntryRef,
  extraction: Extraction,
  userMessageId: number,
): Promise<void> {
  const { calendar, telegram, store, config } = deps;
  const item = extraction.items[0]!;
  const fixed: Extraction = {
    ...extraction,
    source: "fritekst",
    child: extraction.child ?? target.child,
    items: [{ ...item, child: item.child ?? target.child }],
  };
  const existing = await calendar.get(target.eventId);
  if (!existing) {
    await telegram.sendMessage(deps.chatId, "Fant ikke den forrige hendelsen i kalenderen lenger. Send den på nytt.");
    return;
  }
  // Behold varsel hvis brukeren har valgt det for denne oppføringen.
  const withReminders = target.reminder === true || existing.extendedProperties?.private?.reminder === "on";
  const planned = await planEvents(fixed.items[0]!, fixed, config, { withReminders });
  const [main, ...companions] = planned;
  if (!main) {
    await telegram.sendMessage(deps.chatId, "Rettelsen manglet dato, så jeg endret ingenting.");
    return;
  }
  const event = await calendar.patch(target.eventId, main.body);
  const companionIds: string[] = [];
  for (let i = 0; i < companions.length; i++) {
    const oldId = target.companionIds[i];
    if (oldId) {
      companionIds.push((await calendar.patch(oldId, companions[i]!.body)).id);
    } else {
      companionIds.push((await calendar.upsert(companions[i]!.body)).event.id);
    }
  }
  const leftover = target.companionIds.slice(companions.length);

  const updated: EntryRef = {
    ...target,
    eventId: event.id,
    agentKey: main.agentKey,
    htmlLink: event.htmlLink,
    child: main.child,
    item: main.item,
    companionIds: [...companionIds, ...leftover],
    reminder: withReminders,
  };
  const history = await store.getHistory();
  const group = history[0]?.map((x) => (x.eventId === target.eventId ? updated : x));
  if (group && group.some((x) => x.eventId === updated.eventId)) await store.replaceLatestHistory(group);
  else await store.pushHistory([updated]);

  const date = eventDate(main.item);
  const when = `${date ? formatDateNo(date) : ""}${main.item.start_time ? ` kl. ${main.item.start_time}` : ""}`;
  let text = `✏️ Oppdatert: <a href="${e(event.htmlLink)}">${e(main.body.summary)}</a> – ${e(when)}`;
  if (leftover.length) text += `\n<i>Den gamle «frist i dag»-påminnelsen ligger fortsatt i kalenderen.</i>`;
  const receiptId = await telegram.sendMessage(deps.chatId, text, undefined, userMessageId);
  await store.linkMessage(receiptId, [updated]);
  await store.linkMessage(userMessageId, [updated]);
  log("entry_corrected", { eventId: event.id, agentKey: main.agentKey });
}

