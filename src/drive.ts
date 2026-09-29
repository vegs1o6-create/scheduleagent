import type { GoogleAuth } from "./google-auth";
import { log } from "./log";

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
  /** PDF-er og bilder i mappen som er lagt inn eller endret etter `since` (RFC3339). */
  listNewFiles(folderId: string, since: string): Promise<DriveFile[]>;
  download(fileId: string): Promise<Uint8Array>;
}

/** Google Drive (scope: drive.readonly). Boten leser bare, den flytter eller sletter aldri filer. */
export class GoogleDrive implements DriveApi {
  constructor(private readonly auth: GoogleAuth) {}

  async listNewFiles(folderId: string, since: string): Promise<DriveFile[]> {
    const safeFolder = folderId.replace(/[^A-Za-z0-9_-]/g, "");
    const q = [
      `'${safeFolder}' in parents`,
      "trashed = false",
      "(mimeType = 'application/pdf' or mimeType = 'image/jpeg' or mimeType = 'image/png')",
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

  async download(fileId: string): Promise<Uint8Array> {
    const res = await this.auth.fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    );
    if (!res.ok) {
      log("drive_api_error", { op: "download", status: res.status, fileId });
      throw new Error(`Nedlasting fra Google Drive feilet (${res.status})`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    log("drive_downloaded", { fileId, bytes: bytes.length });
    return bytes;
  }
}
