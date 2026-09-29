/**
 * Bygger små .docx-filer (zip) i testene, uten eksterne biblioteker.
 */
import { deflateRawSync } from "node:zlib";

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

export function buildZip(files: Record<string, string | Uint8Array>, compress = true): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? enc.encode(content) : content;
    const data = compress ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nameBytes = enc.encode(name);
    const crc = crc32(raw);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, compress ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, compress ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text: string) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (...paras: string[]) => `<w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr>${paras.map(p).join("")}</w:tc>`;
const row = (...cells: string[]) => `<w:tr><w:trPr/>${cells.join("")}</w:tr>`;

/** En typisk ukeplan fra Word: overskrift, tabell med ukedager, og beskjeder. */
export const UKEPLAN_DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${p("Ukeplan 2C")}
<w:tbl><w:tblPr><w:tblW w:w="0"/></w:tblPr><w:tblGrid><w:gridCol/></w:tblGrid>
${row(cell(""), cell("Mandag"), cell("Tirsdag"), cell("Onsdag"))}
${row(cell("Husk"), cell("Gymtøy &amp; innesko"), cell(""), cell("Tur til Østmarka", "Oppmøte 08:15"))}
</w:tbl>
${p("Beskjed: Svarslipp &lt;høsttur&gt; leveres innen fredag.")}
<w:p><w:r><w:t>Lekse:</w:t><w:tab/><w:t>les s. 12–15</w:t></w:r></w:p>
</w:body></w:document>`;

export const HEADER_XML = `<w:hdr ${W}>${p("Uke 40 – Tveita skole")}</w:hdr>`;

export function ukeplanDocx(compress = true): Uint8Array {
  return buildZip(
    {
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": UKEPLAN_DOCX_XML,
      "word/header1.xml": HEADER_XML,
      "word/header2.xml": HEADER_XML, // duplikat (første side) – skal bare med én gang
    },
    compress,
  );
}

/** Word-fil der ukeplanen bare er et innlimt bilde. */
export function bildeDocx(): Uint8Array {
  return buildZip({
    "word/document.xml": `<w:document ${W}><w:body><w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>`,
    "word/media/image1.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8]),
    "word/media/image2.jpeg": new Uint8Array([255, 216, 255]),
  });
}
