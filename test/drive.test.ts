import { describe, expect, it, vi } from "vitest";
import worker, { CRON_DRIVE_POLL, CRON_SUNDAY, processJob } from "../src/index";
import { handleDriveFile, pollDrive } from "../src/handlers/drive";
import type { DriveFile } from "../src/drive";
import type { Env } from "../src/env";
import { callbackUpdate, makeDeps } from "./fakes";
import { UKEPLAN_ASTRID, UKEPLAN_SVERRE } from "./fixtures/ukeplaner";

const FOLDER = { DRIVE_FOLDER_ID: "1AbC_folder-ID" };

function file(id: string, createdTime: string, md5 = `md5-${id}`, name = `${id}.pdf`): DriveFile {
  return { id, name, mimeType: "application/pdf", md5Checksum: md5, createdTime, modifiedTime: createdTime, size: "1000" };
}

describe("Google Drive-mappe", () => {
  it("er av når DRIVE_FOLDER_ID er tom", async () => {
    const { deps, drive } = makeDeps();
    expect(await pollDrive(deps)).toBe(0);
    expect(drive.listCalls).toHaveLength(0);
  });

  it("første kjøring ser bare på det siste døgnet", async () => {
    const { deps, drive, jobs } = makeDeps(FOLDER);
    drive.files = [file("gammel", "2026-09-20T10:00:00.000Z"), file("ny", "2026-09-29T09:30:00.000Z")];
    expect(await pollDrive(deps)).toBe(1);
    expect(drive.listCalls[0]).toEqual({ folderId: "1AbC_folder-ID", since: "2026-09-28T10:00:00.000Z" });
    expect(jobs).toEqual([{ kind: "drive_file", file: drive.files[1] }]);
  });

  it("legger hver fil i køen bare én gang, men tar ny versjon av samme fil", async () => {
    const { deps, drive, jobs, kv } = makeDeps(FOLDER);
    drive.files = [file("a", "2026-09-29T09:30:00.000Z")];
    await pollDrive(deps);
    const writesAfterFirst = kv.data.size;
    await pollDrive(deps);
    expect(jobs).toHaveLength(1);
    expect(kv.data.size).toBe(writesAfterFirst); // ingen nye KV-skriv når ingenting er nytt

    // Filen erstattes i Drive (nytt innhold -> ny md5)
    drive.files = [{ ...file("a", "2026-09-29T09:30:00.000Z", "md5-v2"), modifiedTime: "2026-09-29T09:55:00.000Z" }];
    await pollDrive(deps);
    expect(jobs).toHaveLength(2);
  });

  it("søker med overlapp fra forrige kjøring", async () => {
    const { deps, drive } = makeDeps(FOLDER);
    drive.files = [file("a", "2026-09-29T09:30:00.000Z")];
    await pollDrive(deps);
    await pollDrive(deps);
    expect(drive.listCalls[1]!.since).toBe("2026-09-29T09:20:00.000Z");
  });

  it("behandler en Drive-PDF: laster ned, leser med Claude og viser utkast med knapper", async () => {
    const { deps, drive, telegram, claude, calendar } = makeDeps(FOLDER);
    claude.extractions.push(UKEPLAN_SVERRE);
    await handleDriveFile(deps, file("f1", "2026-09-29T09:30:00.000Z", "x", "Ukeplan 2C uke 40.pdf"));
    expect(drive.downloads).toEqual(["f1"]);
    expect(telegram.sent[0]!.text).toContain("Ny fil i Drive: <b>Ukeplan 2C uke 40.pdf</b>");
    expect(telegram.buttons().map((b) => b.split(":")[0])).toEqual(["ok", "fix", "no"]);
    expect(calendar.events.size).toBe(0);

    await processJob(deps, { kind: "telegram_update", update: callbackUpdate(telegram.buttons()[0]!) });
    expect(calendar.events.size).toBe(6);
  });

  it("feil i Drive-jobben rapporteres i Telegram", async () => {
    const { deps, telegram } = makeDeps(FOLDER); // ingen extraction i kø -> Claude-feil
    await processJob(deps, { kind: "drive_file", file: file("f1", "2026-09-29T09:30:00.000Z", "x", "plan.pdf") });
    expect(telegram.last().text).toContain("Klarte ikke å lese «plan.pdf» fra Drive");
  });

  it("hopper over filtyper som ikke støttes", async () => {
    const { deps, telegram, drive } = makeDeps(FOLDER);
    await handleDriveFile(deps, { ...file("d", "2026-09-29T09:30:00.000Z"), name: "notat.docx", mimeType: "application/vnd.openxmlformats" });
    expect(telegram.last().text).toContain("Hoppet over «notat.docx»");
    expect(drive.downloads).toHaveLength(0);
  });
});

describe("Workers Free: utgående kall", () => {
  it("en ukeplan skrives med ett oppslag totalt, ikke ett per punkt", async () => {
    const { deps, telegram, claude, calendar } = makeDeps();
    claude.extractions.push(UKEPLAN_SVERRE, UKEPLAN_ASTRID);
    await handleDriveFile(deps, file("f1", "2026-09-29T09:30:00.000Z"));
    calendar.calls = 0;
    await processJob(deps, { kind: "telegram_update", update: callbackUpdate(telegram.buttons()[0]!) });
    // 1 forhåndslasting + 6 skriv (5 punkter + 07:30-fristen)
    expect(calendar.calls).toBe(7);
  });
});

describe("cron-ruting", () => {
  it("sender riktig cron til riktig jobb", async () => {
    const env = {
      STATE: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
      JOBS: { send: vi.fn() },
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_ALLOWED_CHAT_ID: "1",
      GOOGLE_CALENDAR_ID: "c",
      DRIVE_FOLDER_ID: "",
    } as unknown as Env;
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    // Drive av og ikke søndag 18: ingen av jobbene gjør eksterne kall
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await worker.scheduled({ cron: CRON_DRIVE_POLL } as ScheduledController, env, ctx);
    await worker.scheduled({ cron: CRON_SUNDAY } as ScheduledController, env, ctx);
    await Promise.all(waits);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("cron-uttrykkene i wrangler.toml stemmer med koden", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toContain(`"${CRON_DRIVE_POLL}"`);
    expect(toml).toContain(`"${CRON_SUNDAY}"`);
  });
});
