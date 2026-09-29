import type { Config } from "./env";
import type { Extraction, Item } from "./schema";
import { formatDateNo, isoWeek } from "./dates";
import { eventDate, itemChild } from "./mapping";
import { escapeHtml as e } from "./telegram";

interface Numbered {
  n: number;
  item: Item;
  child: string | null;
}

function line(x: Numbered, config: Config, withDate: boolean): string {
  const it = x.item;
  const warn = it.confidence < config.lowConfidence ? "⚠️ " : "";
  const date = eventDate(it);
  const when = [
    withDate && date ? formatDateNo(date) : "",
    it.start_time ? `kl. ${it.start_time}${it.end_time ? `–${it.end_time}` : ""}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  let s = `${x.n}. ${warn}${when ? `<b>${e(when)}</b> ` : ""}${e(it.title)}`;
  if (it.location) s += ` (${e(it.location)})`;
  if (it.bring.length) s += `\n    🎒 ${e(it.bring.join(", "))}`;
  if (it.action_required) s += `\n    ✅ ${e(it.action_required)}`;
  if (warn && it.notes) s += `\n    <i>${e(it.notes)}</i>`;
  return s;
}

function childLabel(child: string | null): string {
  if (!child) return "Uten barn";
  return child === "begge" ? "Begge" : child;
}

/** Lesbar oppsummering av et utkast: frister/husk øverst, så dag for dag per barn. */
export function formatSummary(extraction: Extraction, config: Config, heading?: string): string {
  const all: Numbered[] = extraction.items.map((item, i) => ({
    n: i + 1,
    item,
    child: itemChild(item, extraction, config),
  }));
  const top = all.filter(
    (x) => x.item.type === "deadline" || x.item.type === "reminder" || (x.item.type === "event" && x.item.action_required),
  );
  const topSet = new Set(top);
  const days = all.filter((x) => x.item.type === "event" && !topSet.has(x) && eventDate(x.item));
  const undated = all.filter((x) => x.item.type !== "info" && !eventDate(x.item));
  const info = all.filter((x) => x.item.type === "info");

  const out: string[] = [];
  const who = extraction.child ? childLabel(extraction.child) : null;
  const title =
    heading ??
    (extraction.source === "ukeplan"
      ? `📋 Ukeplan${extraction.week ? ` uke ${Number(extraction.week.slice(6))}` : ""}${who ? ` – ${who}` : ""}`
      : "📝 Utkast");
  out.push(`<b>${e(title)}</b>`);

  if (top.length) {
    out.push("", "<b>⏰ Frister og husk</b>");
    top
      .sort((a, b) => (eventDate(a.item) ?? "9999").localeCompare(eventDate(b.item) ?? "9999"))
      .forEach((x) => out.push(line(x, config, true) + (x.child && x.child !== extraction.child ? ` [${e(childLabel(x.child))}]` : "")));
  }

  if (days.length) {
    const byChild = new Map<string, Numbered[]>();
    for (const x of days) {
      const k = childLabel(x.child);
      byChild.set(k, [...(byChild.get(k) ?? []), x]);
    }
    for (const [child, list] of byChild) {
      out.push("", `<b>📅 ${e(child)}</b>`);
      const byDate = new Map<string, Numbered[]>();
      for (const x of list.sort((a, b) =>
        `${eventDate(a.item)}${a.item.start_time ?? ""}`.localeCompare(`${eventDate(b.item)}${b.item.start_time ?? ""}`),
      )) {
        const d = eventDate(x.item)!;
        byDate.set(d, [...(byDate.get(d) ?? []), x]);
      }
      for (const [date, entries] of byDate) {
        out.push(`<u>${e(capitalize(formatDateNo(date)))}</u>`);
        entries.forEach((x) => out.push(line(x, config, false)));
      }
    }
  }

  if (undated.length) {
    out.push("", "<b>⚠️ Mangler dato (hoppes over hvis ikke rettet)</b>");
    undated.forEach((x) => out.push(line(x, config, false)));
  }

  if (info.length || extraction.general_notes) {
    out.push("", "<b>ℹ️ Info (skrives ikke til kalenderen)</b>");
    info.forEach((x) => out.push(line(x, config, true)));
    if (extraction.general_notes) out.push(e(extraction.general_notes));
  }

  if (!extraction.items.length) out.push("", "Fant ingen punkter.");
  if (all.some((x) => x.item.confidence < config.lowConfidence)) {
    out.push("", "⚠️ = usikkert, sjekk før du godkjenner.");
  }
  return out.join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface ReceiptLine {
  title: string;
  date: string | null;
  link?: string;
  reason?: string;
}

export interface Receipt {
  created: ReceiptLine[];
  updated: ReceiptLine[];
  unchanged: ReceiptLine[];
  skipped: ReceiptLine[];
  removedFromPlan: ReceiptLine[];
  moved: ReceiptLine[];
  previousVersionAt?: string;
}

function receiptLine(r: ReceiptLine): string {
  const title = r.link ? `<a href="${e(r.link)}">${e(r.title)}</a>` : e(r.title);
  return `• ${r.date ? `${e(formatDateNo(r.date))} ` : ""}${title}${r.reason ? ` – <i>${e(r.reason)}</i>` : ""}`;
}

export function formatReceipt(r: Receipt): string {
  const out: string[] = ["<b>✅ Lagret i kalenderen</b>"];
  if (r.previousVersionAt) {
    out.push(
      `\n🔄 <b>Denne ukeplanen erstatter en tidligere versjon</b> (behandlet ${e(r.previousVersionAt.slice(0, 10))}).`,
    );
  }
  const section = (label: string, list: ReceiptLine[]) => {
    if (!list.length) return;
    out.push("", `<b>${label} (${list.length})</b>`, ...list.map(receiptLine));
  };
  section("Opprettet", r.created);
  section("Oppdatert", r.updated);
  section("Flyttet/endret dato", r.moved);
  section("Uendret", r.unchanged);
  section("Hoppet over", r.skipped);
  section("⚠️ Ikke lenger med i ukeplanen", r.removedFromPlan);
  if (r.removedFromPlan.length) out.push("Disse ligger fortsatt i kalenderen. Trykk under hvis de skal slettes.");
  return out.join("\n");
}

export function weekLabel(iso: string): string {
  return `uke ${Number(isoWeek(iso).slice(6))}`;
}
