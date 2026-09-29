import { describe, expect, it } from "vitest";
import { DOCX_MIME, extractDocx, wordXmlToText } from "../src/docx";
import { mediaTypeOf } from "../src/handlers/document";
import { handleDriveFile } from "../src/handlers/drive";
import { processUpdate } from "../src/router";
import type { TgUpdate } from "../src/types";
import { CHAT_ID, makeDeps } from "./fakes";
import { UKEPLAN_SVERRE } from "./fixtures/ukeplaner";
import { UKEPLAN_DOCX_XML, bildeDocx, buildZip, ukeplanDocx } from "./fixtures/docx";

describe("Word (.docx) til tekst", () => {
  it("gjør om avsnitt, tabeller, tabulator og XML-tegn", () => {
    const text = wordXmlToText(UKEPLAN_DOCX_XML);
    expect(text).toContain("Ukeplan 2C");
    expect(text).toContain("|  | Mandag | Tirsdag | Onsdag |");
    expect(text).toContain("| Husk | Gymtøy & innesko |  | Tur til Østmarka / Oppmøte 08:15 |");
    expect(text).toContain("Beskjed: Svarslipp <høsttur> leveres innen fredag.");
    expect(text).toContain("Lekse:\tles s. 12–15");
    expect(text).not.toContain("<w:");
  });

  it.each([
    ["komprimert", true],
    ["ukomprimert", false],
  ])("pakker ut %s .docx med topptekst én gang", async (_n, compress) => {
    const { text, largestImage } = await extractDocx(ukeplanDocx(compress));
    expect(text.startsWith("[Topptekst]\nUke 40 – Tveita skole")).toBe(true);
    expect(text.match(/Uke 40/g)).toHaveLength(1);
    expect(text).toContain("| Husk | Gymtøy & innesko |");
    expect(largestImage).toBeNull();
  });

  it("finner største innlimte bilde når dokumentet bare har bilde", async () => {
    const { text, largestImage } = await extractDocx(bildeDocx());
    expect(text).toBe("");
    expect(largestImage?.mediaType).toBe("image/png");
    expect([...largestImage!.bytes.slice(0, 4)]).toEqual([137, 80, 78, 71]);
  });

  it("gir forståelig feil for filer som ikke er .docx", async () => {
    await expect(extractDocx(new Uint8Array([1, 2, 3]))).rejects.toThrow("ikke en gyldig Word-fil");
    await expect(extractDocx(buildZip({ "annet.txt": "hei" }))).rejects.toThrow("word/document.xml mangler");
  });

  it("gjenkjenner .docx på MIME-type og filnavn", () => {
    expect(mediaTypeOf(DOCX_MIME, "x")).toBe(DOCX_MIME);
    expect(mediaTypeOf("application/octet-stream", "Ukeplan uke 40.DOCX")).toBe(DOCX_MIME);
    expect(mediaTypeOf("application/msword", "gammel.doc")).toBeNull();
  });
});

describe("Word-ukeplan inn i botten", () => {
  it("fra Telegram: teksten sendes til Claude og utkast vises", async () => {
    const { deps, telegram, claude } = makeDeps();
    telegram.file = ukeplanDocx();
    claude.extractions.push(UKEPLAN_SVERRE);
    const update = {
      update_id: 9001,
      message: {
        message_id: 1,
        chat: { id: Number(CHAT_ID) },
        date: 0,
        document: { file_id: "d1", file_name: "Ukeplan uke 40.docx", mime_type: DOCX_MIME, file_size: 5000 },
      },
    };
    await processUpdate(deps, update as TgUpdate);
    expect(claude.textDocuments).toHaveLength(1);
    expect(claude.textDocuments[0]).toContain("| Husk | Gymtøy & innesko |");
    expect(telegram.buttons().map((b) => b.split(":")[0])).toEqual(["ok", "fix", "no"]);
  });

  it("fra Telegram: Word-fil med bare bilde sendes som bilde", async () => {
    const { deps, telegram, claude } = makeDeps();
    telegram.file = bildeDocx();
    claude.extractions.push(UKEPLAN_SVERRE);
    const update = {
      update_id: 9002,
      message: { message_id: 2, chat: { id: Number(CHAT_ID) }, date: 0, document: { file_id: "d2", file_name: "plan.docx" } },
    };
    await processUpdate(deps, update as TgUpdate);
    expect(claude.textDocuments).toHaveLength(0);
    expect(claude.imageDocuments).toEqual(["image/png"]);
  });

  it("fra Drive: .docx og Google Docs (eksportert som .docx) behandles", async () => {
    const { deps, drive, claude, telegram } = makeDeps({ DRIVE_FOLDER_ID: "f" });
    claude.extractions.push(UKEPLAN_SVERRE, UKEPLAN_SVERRE);
    drive.contents.set("w1", ukeplanDocx());
    drive.contents.set("g1", ukeplanDocx());
    const base = { createdTime: "2026-09-29T09:00:00Z", modifiedTime: "2026-09-29T09:00:00Z" };
    await handleDriveFile(deps, { id: "w1", name: "Ukeplan.docx", mimeType: DOCX_MIME, ...base });
    await handleDriveFile(deps, { id: "g1", name: "Ukeplan (Google Docs)", mimeType: "application/vnd.google-apps.document", ...base });
    expect(claude.textDocuments).toHaveLength(2);
    expect(telegram.originalTexts.filter((t) => t.includes("Ny fil i Drive"))).toHaveLength(2);
  });
});
