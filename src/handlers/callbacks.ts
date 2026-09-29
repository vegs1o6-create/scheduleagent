import type { Deps } from "../deps";
import type { TgCallbackQuery } from "../types";
import { escapeHtml as e } from "../telegram";
import { approveExtraction } from "./drafts";
import { titleFor } from "../mapping";
import { log } from "../log";

/**
 * Knappetrykk. Formatet er "<handling>:<id>":
 *  ok/fix/no  – godkjenn, rett eller avbryt et utkast
 *  undo/keep  – bekreft eller avvis sletting (/angre og fjernede ukeplanpunkter)
 */
export async function handleCallback(deps: Deps, cb: TgCallbackQuery): Promise<void> {
  const { telegram, store } = deps;
  const [action, id] = (cb.data ?? "").split(":");
  const messageId = cb.message?.message_id;
  if (!action || !id) return;
  log("callback", { action, id });

  if (action === "ok" || action === "fix" || action === "no") {
    const draft = await store.getDraft(id);
    if (!draft || draft.status !== "pending") {
      if (messageId) await telegram.removeKeyboard(deps.chatId, messageId);
      await telegram.sendMessage(deps.chatId, "Dette utkastet er allerede behandlet eller utløpt.");
      return;
    }
    if (action === "fix") {
      await store.setMode({ kind: "awaiting_correction", draftId: draft.id });
      await telegram.sendMessage(
        deps.chatId,
        "✏️ Skriv rettelsene dine, f.eks. «punkt 3 er på torsdag», «fjern punkt 5» eller «turen er for Astrid».",
      );
      return;
    }
    if (messageId) await telegram.removeKeyboard(deps.chatId, messageId);
    if (action === "no") {
      draft.status = "cancelled";
      await store.saveDraft(draft);
      await store.clearMode();
      await telegram.sendMessage(deps.chatId, "✖️ Avbrutt. Ingenting ble lagret.");
      return;
    }
    // ok: marker først, så et dobbelt trykk ikke skriver to ganger.
    draft.status = "committed";
    await store.saveDraft(draft);
    await store.clearMode();
    await approveExtraction(deps, draft.extraction);
    return;
  }

  if (action === "undo" || action === "keep") {
    const pending = await store.getPendingUndo(id);
    if (messageId) await telegram.removeKeyboard(deps.chatId, messageId);
    if (!pending) {
      await telegram.sendMessage(deps.chatId, "Denne forespørselen er utløpt.");
      return;
    }
    await store.clearPendingUndo(id);
    if (action === "keep") {
      await telegram.sendMessage(deps.chatId, "👍 Ok, ingenting ble slettet.");
      return;
    }
    const deletedIds: string[] = [];
    for (const entry of pending.entries) {
      for (const eventId of [entry.eventId, ...entry.companionIds]) {
        await deps.calendar.delete(eventId);
        deletedIds.push(eventId);
      }
    }
    await store.removeFromHistory(deletedIds);
    log("deleted_after_confirmation", { label: pending.label, eventIds: deletedIds });
    const lines = pending.entries.map((x) => `• ${e(titleFor(x.child, x.item.title))}${x.item.date ? ` (${x.item.date})` : ""}`);
    await telegram.sendMessage(deps.chatId, `🗑️ Slettet:\n${lines.join("\n")}`);
  }
}
