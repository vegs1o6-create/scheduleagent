import type { GoogleAuth } from "./google-auth";
import { log } from "./log";
import { DOCX_MIME } from "./docx";

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime: string;
  createdTime: string;
  size?: string;
}

export interface DriveApi {
  /** PDF-er, Word-filer, Google Docs og bilder i mappen som er lagt inn eller endret etter `since` (RFC3339). */
  listNewFiles(folderId: string, since: string): Promise<DriveFile[]>;
  /** Laster ned filen. Google Docs eksporteres som .docx. */
  download(file: Pick<DriveFile, "id" | "mimeType">): Promise<Uint8Array>;
}

/** Google Drive (scope: drive.readonly). Boten leser bare, den flytter eller sletter aldri filer. */
export class GoogleDrive implements DriveApi {
  constructor(private readonly auth: GoogleAuth) {}

  async listNewFiles(folderId: string, since: string): Promise<DriveFile[]> {
    const safeFolder = folderId.replace(/[^A-Za-z0-9_-]/g, "");
    const q = [
      `'${safeFolder}' in parents`,
      "trashed = false",
      `(mimeType = 'application/pdf' or mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = '${DOCX_MIME}' or mimeType = '${GOOGLE_DOC_MIME}')`,
      `(modifiedTime > '${since}' or createdTime > '${since}')`,
    ].join(" and ");
    const params = new URLSearchParams({
      q,
      fields: "files(id,name,mimeType,md5Checksum,modifiedTime,createdTime,size)",
      orderBy: "createdTime",
      pageSize: "20",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const res = await this.auth.fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (!res.ok) {
      log("drive_api_error", { op: "list", status: res.status, detail: (await res.text()).slice(0, 300) });
      throw new Error(`Google Drive list feilet (${res.status})`);
    }
    const json = (await res.json()) as { files?: DriveFile[] };
    log("drive_listed", { count: json.files?.length ?? 0, since });
    return json.files ?? [];
  }

  async download(file: Pick<DriveFile, "id" | "mimeType">): Promise<Uint8Array> {
    const id = encodeURIComponent(file.id);
    const url =
      file.mimeType === GOOGLE_DOC_MIME
        ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(DOCX_MIME)}`
        : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
    const res = await this.auth.fetch(url);
    if (!res.ok) {
      log("drive_api_error", { op: "download", status: res.status, fileId: file.id });
      throw new Error(`Nedlasting fra Google Drive feilet (${res.status})`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    log("drive_downloaded", { fileId: file.id, bytes: bytes.length, exported: file.mimeType === GOOGLE_DOC_MIME });
    return bytes;
  }
}
