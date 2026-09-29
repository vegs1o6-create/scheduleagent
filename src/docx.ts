/**
 * Uttrekk av tekst fra Word-filer (.docx) uten eksterne biblioteker.
 *
 * En .docx er en zip med XML. Vi leser zip-katalogen selv, pakker ut med
 * den innebygde DecompressionStream("deflate-raw") og gjør om
 * word/document.xml (+ topp-/bunntekst) til ren tekst. Tabeller blir
 * "| celle | celle |"-linjer slik at Claude ser kolonnene (ukedager o.l.).
 */

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Finn "End of central directory" (signatur 0x06054b50) bakfra.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Filen er ikke en gyldig Word-fil (.docx).");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Ødelagt Word-fil (zip-katalog).");
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    entries.push({
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen)),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = entry.localHeaderOffset;
  if (view.getUint32(o, true) !== 0x04034b50) throw new Error("Ødelagt Word-fil (lokal header).");
  const start = o + 30 + view.getUint16(o + 26, true) + view.getUint16(o + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`Ukjent komprimering i Word-filen (${entry.method}).`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

/** WordprocessingML -> tekst. Avsnitt blir linjer, tabellrader blir "| a | b |". */
export function wordXmlToText(xml: string): string {
  type Frame = { kind: "body" | "cell"; lines: string[] } | { kind: "row"; cells: string[] };
  const stack: Frame[] = [{ kind: "body", lines: [] }];
  let para = "";
  const container = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]!;
      if (f.kind !== "row") return f;
    }
    return stack[0] as { kind: "body"; lines: string[] };
  };

  const re = /<(\/?)w:(p|tbl|tr|tc|t|tab|br|cr)\b[^>]*?(\/?)>|<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [whole, closing, tag, selfClosing] = m;
    if (whole === "</w:t>") continue;
    if (tag === "t" && !closing) {
      if (selfClosing) continue;
      const end = xml.indexOf("</w:t>", re.lastIndex);
      if (end < 0) break;
      para += decodeEntities(xml.slice(re.lastIndex, end));
      re.lastIndex = end + 6;
      continue;
    }
    if (tag === "tab") para += "\t";
    else if (tag === "br" || tag === "cr") para += "\n";
    else if (tag === "p" && (closing || selfClosing)) {
      const line = para.replace(/[ \t]+$/g, "");
      container().lines.push(line);
      para = "";
    } else if (tag === "tc") {
      if (!closing) stack.push({ kind: "cell", lines: [] });
      else {
        const cell = stack.pop();
        const row = stack[stack.length - 1];
        if (cell?.kind === "cell" && row?.kind === "row") {
          row.cells.push(cell.lines.map((l) => l.trim()).filter(Boolean).join(" / ").replace(/\n/g, " / "));
        }
      }
    } else if (tag === "tr") {
      if (!closing) stack.push({ kind: "row", cells: [] });
      else {
        const row = stack.pop();
        if (row?.kind === "row" && row.cells.some((c) => c)) container().lines.push(`| ${row.cells.join(" | ")} |`);
      }
    } else if (tag === "tbl") {
      container().lines.push("");
    }
  }
  const body = stack[0] as { lines: string[] };
  return body.lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface DocxContent {
  text: string;
  /** Største innebygde bilde (hvis ukeplanen er limt inn som bilde). */
  largestImage: { bytes: Uint8Array; mediaType: "image/png" | "image/jpeg" } | null;
}

/** Leser en .docx og returnerer teksten (inkl. topp-/bunntekst) og ev. største bilde. */
export async function extractDocx(bytes: Uint8Array): Promise<DocxContent> {
  const entries = readZipEntries(bytes);
  const main = entries.find((e) => e.name === "word/document.xml");
  if (!main) throw new Error("Fant ikke innholdet i Word-filen (word/document.xml mangler).");
  const decoder = new TextDecoder();
  const parts: string[] = [];

  const headers = entries.filter((e) => /^word\/header\d*\.xml$/.test(e.name));
  for (const h of headers) {
    const t = wordXmlToText(decoder.decode(await readZipEntry(bytes, h)));
    if (t) parts.push(`[Topptekst]\n${t}`);
  }
  parts.push(wordXmlToText(decoder.decode(await readZipEntry(bytes, main))));
  const footers = entries.filter((e) => /^word\/footer\d*\.xml$/.test(e.name));
  for (const f of footers) {
    const t = wordXmlToText(decoder.decode(await readZipEntry(bytes, f)));
    if (t) parts.push(`[Bunntekst]\n${t}`);
  }

  const images = entries
    .filter((e) => /^word\/media\/.+\.(png|jpe?g)$/i.test(e.name))
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize);
  const img = images[0];
  const largestImage = img
    ? {
        bytes: await readZipEntry(bytes, img),
        mediaType: (/\.png$/i.test(img.name) ? "image/png" : "image/jpeg") as "image/png" | "image/jpeg",
      }
    : null;

  // Fjern duplikate topp-/bunntekster (Word har ofte like for første/partall/oddetall).
  const unique = [...new Set(parts.filter(Boolean))];
  return { text: unique.join("\n\n").trim(), largestImage };
}

/** Hvor mye tekst som trengs før vi stoler på teksten i stedet for et innlimt bilde. */
export const MIN_DOCX_TEXT = 40;
