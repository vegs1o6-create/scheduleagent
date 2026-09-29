import type { Deps } from "../deps";
import type { TgMessage } from "../types";
import type { MediaType } from "../claude";
import { buildDateContext } from "../dates";
import { escapeHtml as e } from "../telegram";
import { approveExtraction, presentDraft } from "./drafts";
import { log } from "../log";

const MAX_TELEGRAM_BYTES = 20 * 1024 * 1024; // Telegram getFile-grense

const MIME_MAP: Record<string, MediaType> = {
  "application/pdf": "application/pdf",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

export function mediaTypeOf(mime: string | undefined, name: string | undefined): MediaType | null {
  const byMime = MIME_MAP[(mime ?? "").toLowerCase()];
  if (byMime) return byMime;
  const ext = name?.toLowerCase().split(".").pop();
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  return null;
}

/**
 * Felles for Telegram og Google Drive: les ukeplanen med Claude og vis
 * utkastet med [OK] [Rett] [Avbryt] (eller lagre direkte ved AUTO_APPROVE).
 */
export async function processWeekplan(
  deps: Deps,
  input: { bytes: Uint8Array; mediaType: MediaType; caption: string | null; progressText: string },
): Promise<void> {
  const { telegram, store, claude, config } = deps;
  const progressId = await telegram.sendMessage(deps.chatId, input.progressText);
  await telegram.sendChatAction(deps.chatId, "typing");

  const extraction = await claude.extractDocument(
    input.bytes,
    input.mediaType,
    input.caption,
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

/** Ukeplan sendt som PDF eller bilde i Telegram. */
export async function handleDocument(deps: Deps, msg: TgMessage): Promise<void> {
  const { telegram, store } = deps;
  await store.clearMode();

  let fileId: string;
  let mediaType: MediaType | null;
  let size: number | undefined;
  if (msg.document) {
    fileId = msg.document.file_id;
    mediaType = mediaTypeOf(msg.document.mime_type, msg.document.file_name);
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
  if (size && size > MAX_TELEGRAM_BYTES) {
    await telegram.sendMessage(deps.chatId, "Filen er for stor (maks 20 MB via Telegram). Legg den i Drive-mappen i stedet.");
    return;
  }

  const { bytes } = await telegram.downloadFile(fileId);
  log("file_downloaded", { mediaType, bytes: bytes.length, messageId: msg.message_id });
  await processWeekplan(deps, {
    bytes,
    mediaType,
    caption: msg.caption?.trim() || null,
    progressText: "📄 Leser ukeplanen … (kan ta opptil et minutt)",
  });
}
