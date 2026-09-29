import type { Deps } from "./deps";
import type { TgUpdate } from "./types";
import { updateChatId } from "./types";
import { handleCallback } from "./handlers/callbacks";
import { handleCommand } from "./handlers/commands";
import { handleDocument } from "./handlers/document";
import { handleText } from "./handlers/text";
import { escapeHtml } from "./telegram";
import { log } from "./log";

/** Behandler én Telegram-oppdatering (kjøres fra køen). */
export async function processUpdate(deps: Deps, update: TgUpdate): Promise<void> {
  // Dobbeltsjekk chat-ID også her (forsvar i dybden).
  if (String(updateChatId(update)) !== String(deps.chatId).trim()) {
    log("update_ignored", { reason: "chat_not_allowed", updateId: update.update_id });
    return;
  }
  if (await deps.store.seenUpdate(update.update_id)) {
    log("update_ignored", { reason: "duplicate", updateId: update.update_id });
    return;
  }

  try {
    if (update.callback_query) {
      await handleCallback(deps, update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg) return; // redigerte meldinger o.l. ignoreres
    log("message_received", {
      updateId: update.update_id,
      messageId: msg.message_id,
      kind: msg.document ? "document" : msg.photo ? "photo" : msg.text ? "text" : "other",
      textLength: msg.text?.length,
    });
    if (msg.document || msg.photo) {
      await handleDocument(deps, msg);
    } else if (msg.text?.startsWith("/")) {
      await handleCommand(deps, msg.text);
    } else if (msg.text) {
      await handleText(deps, msg);
    } else {
      await deps.telegram.sendMessage(deps.chatId, "Jeg forstår tekst, PDF og bilder. Skriv /hjelp for mer.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("update_failed", { updateId: update.update_id, error: message });
    await deps.telegram
      .sendMessage(deps.chatId, `⚠️ Noe gikk galt: ${escapeHtml(message)}\nIngenting ble slettet. Prøv igjen.`)
      .catch(() => undefined);
  }
}
