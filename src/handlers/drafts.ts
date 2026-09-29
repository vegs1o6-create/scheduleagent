import type { Deps } from "../deps";
import type { Extraction } from "../schema";
import { newId, type Draft } from "../store";
import { formatReceipt, formatSummary } from "../summary";
import type { Keyboard } from "../telegram";
import { commitExtraction } from "./commit";
import { askForReminders } from "./reminders";

export function draftKeyboard(draftId: string): Keyboard {
  return [
    [
      { text: "✅ OK", callback_data: `ok:${draftId}` },
      { text: "✏️ Rett", callback_data: `fix:${draftId}` },
      { text: "✖️ Avbryt", callback_data: `no:${draftId}` },
    ],
  ];
}

/** Lager et utkast og sender oppsummering med [OK] [Rett] [Avbryt]. */
export async function presentDraft(deps: Deps, extraction: Extraction, origin: Draft["origin"]): Promise<Draft> {
  const draft: Draft = {
    id: newId(),
    extraction,
    createdAt: deps.now().toISOString(),
    status: "pending",
    origin,
  };
  const text = formatSummary(extraction, deps.config);
  draft.summaryMessageId = await deps.telegram.sendMessage(deps.chatId, text, draftKeyboard(draft.id));
  await deps.store.saveDraft(draft);
  return draft;
}

/** Skriver et utkast til kalenderen og sender kvittering. */
export async function approveExtraction(deps: Deps, extraction: Extraction): Promise<void> {
  const result = await commitExtraction(deps, extraction);
  const keyboard: Keyboard | undefined = result.removalToken
    ? [
        [
          { text: `🗑️ Slett fjernede (${result.receipt.removedFromPlan.length})`, callback_data: `undo:${result.removalToken}` },
          { text: "Behold", callback_data: `keep:${result.removalToken}` },
        ],
      ]
    : undefined;
  const msgId = await deps.telegram.sendMessage(deps.chatId, formatReceipt(result.receipt), keyboard);
  if (result.written.length) await deps.store.linkMessage(msgId, result.written);
  if (extraction.source === "ukeplan") await deps.store.setLastWeekplanAt(deps.now().toISOString());
  await askForReminders(deps, result.written, extraction);
}
