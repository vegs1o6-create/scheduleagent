import type { Deps } from "../deps";
import type { DriveFile } from "../drive";
import { escapeHtml as e } from "../telegram";
import { mediaTypeOf, processWeekplan } from "./document";
import { log } from "../log";

const MAX_DRIVE_BYTES = 30 * 1024 * 1024;
/** Overlapp i søket, slik at filer som lastes opp akkurat mens vi sjekker ikke glipper. */
const OVERLAP_MS = 10 * 60_000;
/** Første gang: se bare på filer fra det siste døgnet (ikke hele arkivet). */
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60_000;

function version(file: DriveFile): string {
  return file.md5Checksum ?? file.modifiedTime;
}

/**
 * Kjøres av cron hvert 5. minutt: finner nye/endrede PDF-er og bilder i
 * Drive-mappen og legger dem i køen. Skriver bare til KV når noe er nytt
 * (KV-grensen på Workers Free er 1000 skriv per døgn).
 */
export async function pollDrive(deps: Deps): Promise<number> {
  const folderId = deps.config.driveFolderId;
  if (!folderId) return 0;
  const { store } = deps;
  const now = deps.now().getTime();
  const cursor = await store.getDriveCursor();
  const sinceMs = cursor ? new Date(cursor).getTime() - OVERLAP_MS : now - FIRST_RUN_LOOKBACK_MS;
  const since = new Date(sinceMs).toISOString();

  const files = await deps.drive.listNewFiles(folderId, since);
  let queued = 0;
  let newest = cursor ? new Date(cursor).getTime() : 0;
  for (const file of files) {
    if ((await store.getDriveDone(file.id)) === version(file)) continue;
    await store.setDriveDone(file.id, version(file));
    await deps.enqueue({ kind: "drive_file", file });
    queued++;
    newest = Math.max(newest, new Date(file.createdTime).getTime(), new Date(file.modifiedTime).getTime());
    log("drive_file_queued", { fileId: file.id, mimeType: file.mimeType });
  }
  if (queued && newest) await store.setDriveCursor(new Date(Math.min(newest, now)).toISOString());
  return queued;
}

/** Behandler én fil fra Drive (kjøres i køen). */
export async function handleDriveFile(deps: Deps, file: DriveFile): Promise<void> {
  const mediaType = mediaTypeOf(file.mimeType, file.name);
  if (!mediaType) {
    await deps.telegram.sendMessage(deps.chatId, `📁 Hoppet over «${e(file.name)}» i Drive: bare PDF og bilder støttes.`);
    return;
  }
  if (file.size && Number(file.size) > MAX_DRIVE_BYTES) {
    await deps.telegram.sendMessage(deps.chatId, `📁 «${e(file.name)}» er for stor (maks 30 MB).`);
    return;
  }
  await deps.store.clearMode();
  const bytes = await deps.drive.download(file.id);
  await processWeekplan(deps, {
    bytes,
    mediaType,
    caption: `Filnavn: ${file.name}`,
    progressText: `📁 Ny fil i Drive: <b>${e(file.name)}</b>\n📄 Leser ukeplanen … (kan ta opptil et minutt)`,
  });
}
