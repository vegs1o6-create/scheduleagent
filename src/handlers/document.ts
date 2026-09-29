import type { Deps } from "../deps";
import type { TgMessage } from "../types";
import type { MediaType } from "../claude";
import { buildDateContext } from "../dates";
import { escapeHtml as e } from "../telegram";
import { approveExtraction, presentDraft } from "./drafts";
import { log } from "../log";

const MAX_BYTES = 20 * 1024 * 1024; // Telegram getFile-grense

const MIME_MAP: Record<string, MediaType> = {
  "application/pdf": "application/pdf",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

function mediaFromName(name: string | undefined): MediaType | null {
  const ext = name?.toLowerCase().split(".").pop();
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  return null;
}

/** Ukeplan som PDF eller bilde: last ned, trekk ut med Claude, vis utkast. */
export async function handleDocument(deps: Deps, msg: TgMessage): Promise<void> {
  const { telegram, store, claude, config } = deps;
  await store.clearMode();

  let fileId: string;
  let mediaType: MediaType | null;
  let size: number | undefined;
  if (msg.document) {
    fileId = msg.document.file_id;
    mediaType = MIME_MAP[msg.document.mime_type ?? ""] ?? mediaFromName(msg.document.file_name);
    size = msg.document.file_size;
  } else if (msg.photo?.length) {
    const largest = [...msg.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
    fileId = largest.file_id;
    mediaType = "image/jpeg";
    size = largest.file_size;
  } else {
    return;
  }

  if (!mediaType) {
    await telegram.sendMessage(deps.chatId, "Jeg støtter bare PDF og bilder (jpg/png).");
    return;
  }
  if (size && size > MAX_BYTES) {
    await telegram.sendMessage(deps.chatId, "Filen er for stor (maks 20 MB).");
    return;
  }

  const progressId = await telegram.sendMessage(deps.chatId, "📄 Leser ukeplanen … (kan ta opptil et minutt)");
  await telegram.sendChatAction(deps.chatId, "typing");

  const { bytes } = await telegram.downloadFile(fileId);
  log("file_downloaded", { mediaType, bytes: bytes.length, messageId: msg.message_id });

  const extraction = await claude.extractDocument(
    bytes,
    mediaType,
    msg.caption?.trim() || null,
    buildDateContext(deps.now(), config.timezone),
  );
  log("weekplan_extracted", {
    child: extraction.child,
    week: extraction.week,
    items: extraction.items.length,
    lowConfidence: extraction.items.filter((i) => i.confidence < config.lowConfidence).length,
  });
  await store.setLastWeekplanAt(deps.now().toISOString());

  await telegram.editMessage(
    deps.chatId,
    progressId,
    `📄 Ukeplan lest: ${extraction.items.length} punkter${extraction.child ? ` for ${e(extraction.child)}` : ""}.`,
  );

  if (config.autoApprove) {
    await approveExtraction(deps, extraction);
    return;
  }
  await presentDraft(deps, extraction, "pdf");
}
