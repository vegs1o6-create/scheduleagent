import type { Deps } from "../deps";
import type { Extraction } from "../schema";
import type { NotePicker } from "../store";
import { newId } from "../store";
import { itemChild, resolveChild } from "../mapping";
import { addDays, formatDateNo, mondayOfIsoWeek, zonedRfc3339 } from "../dates";
import { agentKey } from "../key";
import { escapeHtml as e, type Keyboard } from "../telegram";
import { log } from "../log";

const MAX_BUTTON_TEXT = 34;

function childPrefix(child: string | null): string {
  if (!child) return "";
  return child === "begge" ? "Begge: " : `${child}: `;
}

function shortDate(iso: string): string {
  const [day, date] = formatDateNo(iso).split(" ");
  return `${day!.slice(0, 3)} ${date}`;
}

/**
 * Lekser, beskjeder og annen info fra uttrekket som kan bli notater på
 * infoskjermen. Utløper når uka er over (ukeplan) eller dagen etter datoen.
 */
export async function noteCandidates(deps: Deps, extraction: Extraction): Promise<NotePicker["candidates"]> {
  const { config } = deps;
  const tz = config.timezone;
  const weekEnd = extraction.week ? mondayOfIsoWeek(extraction.week) : null;
  const weekExpiry = weekEnd ? zonedRfc3339(addDays(weekEnd, 7), "00:00", tz) : undefined;
  const scope = extraction.week ?? "";
  const out: NotePicker["candidates"] = [];

  for (const item of extraction.items) {
    if (item.type !== "info") continue;
    const child = itemChild(item, extraction, config);
    const when = item.date ? ` (${shortDate(item.date)})` : "";
    const text = `${childPrefix(child)}${item.title}${when}`;
    const expiresAt = item.date ? zonedRfc3339(addDays(item.date, 1), "00:00", tz) : weekExpiry;
    out.push({ text, key: await agentKey(child, scope || item.date || "", `note ${item.title}`), ...(expiresAt ? { expiresAt } : {}) });
  }
  if (extraction.general_notes) {
    const child = resolveChild(extraction.child, config);
    out.push({
      text: `${childPrefix(child)}${extraction.general_notes}`,
      key: await agentKey(child, scope, `note ${extraction.general_notes}`),
      ...(weekExpiry ? { expiresAt: weekExpiry } : {}),
    });
  }
  return out;
}

function pickerText(p: NotePicker): string {
  const intro =
    p.candidates.length === 1
      ? "📌 Vil du legge dette på infoskjermen?"
      : "📌 Vil du legge noe av dette på infoskjermen?\nTrykk på det du vil ha med, og så «Legg på skjermen».";
  const lines = p.candidates.map((c, i) => `${i + 1}. ${e(c.text)}`);
  return `${intro}\n\n${lines.join("\n")}`;
}

function pickerKeyboard(p: NotePicker): Keyboard {
  if (p.candidates.length === 1) {
    return [
      [
        { text: "📌 Ja, legg på skjermen", callback_data: `ps:${p.token}` },
        { text: "Nei takk", callback_data: `pn:${p.token}` },
      ],
    ];
  }
  const rows: Keyboard = p.candidates.map((c, i) => {
    const t = c.text.length > MAX_BUTTON_TEXT ? `${c.text.slice(0, MAX_BUTTON_TEXT - 1)}…` : c.text;
    return [{ text: `${p.selected.includes(i) ? "✅" : "⬜"} ${i + 1}. ${t}`, callback_data: `pt:${p.token}:${i}` }];
  });
  rows.push([
    { text: "Velg alle", callback_data: `pa:${p.token}` },
    { text: "Ingen", callback_data: `pn:${p.token}` },
  ]);
  rows.push([{ text: `📌 Legg på skjermen (${p.selected.length})`, callback_data: `ps:${p.token}` }]);
  return rows;
}

/** Spør hvilke lekser/beskjeder som skal bli notater på infoskjermen. */
/** Returnerer true hvis spørsmålet ble sendt. */
export async function askForNotes(deps: Deps, extraction: Extraction): Promise<boolean> {
  const notes = await deps.store.getNotes(deps.now());
  const existing = new Set(notes.map((n) => n.key).filter(Boolean));
  const candidates = (await noteCandidates(deps, extraction)).filter((c) => !existing.has(c.key));
  if (!candidates.length) return false;
  const picker: NotePicker = {
    token: newId(),
    candidates,
    selected: candidates.length === 1 ? [0] : [],
  };
  picker.messageId = await deps.telegram.sendMessage(deps.chatId, pickerText(picker), pickerKeyboard(picker));
  await deps.store.saveNotePicker(picker);
  return true;
}

/** Knappene pt (velg/fjern), pa (alle), pn (ingen) og ps (legg på skjermen). */
export async function handleNoteCallback(
  deps: Deps,
  action: string,
  token: string,
  arg: string | undefined,
  messageId: number | undefined,
): Promise<void> {
  const { store, telegram } = deps;
  const picker = await store.getNotePicker(token);
  if (!picker) {
    if (messageId) await telegram.removeKeyboard(deps.chatId, messageId);
    await telegram.sendMessage(deps.chatId, "Dette spørsmålet er utløpt. Bruk /notat for å legge til notater.");
    return;
  }
  const msgId = messageId ?? picker.messageId;

  if (action === "pt" || action === "pa") {
    if (action === "pa") picker.selected = picker.candidates.map((_c, i) => i);
    else {
      const i = Number(arg);
      if (!Number.isInteger(i) || i < 0 || i >= picker.candidates.length) return;
      picker.selected = picker.selected.includes(i)
        ? picker.selected.filter((s) => s !== i)
        : [...picker.selected, i].sort((a, b) => a - b);
    }
    await store.saveNotePicker(picker);
    if (msgId) await telegram.editMessage(deps.chatId, msgId, pickerText(picker), pickerKeyboard(picker));
    return;
  }

  if (action === "pn" || (action === "ps" && picker.selected.length === 0)) {
    await store.clearNotePicker(token);
    if (msgId) await telegram.editMessage(deps.chatId, msgId, "Ingenting lagt på infoskjermen.");
    return;
  }

  if (action === "ps") {
    await store.clearNotePicker(token);
    const added: string[] = [];
    let expires = false;
    for (const i of picker.selected) {
      const c = picker.candidates[i];
      if (!c) continue;
      await store.addNote(c.text, "ukeplan", deps.now(), { key: c.key, ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}) });
      added.push(c.text);
      expires ||= Boolean(c.expiresAt);
    }
    log("notes_added_from_extraction", { count: added.length });
    if (msgId) {
      await telegram.editMessage(
        deps.chatId,
        msgId,
        `📌 Lagt på infoskjermen:\n${added.map((t) => `• ${e(t)}`).join("\n")}` +
          (expires ? "\n\n<i>De forsvinner av seg selv når uka (eller datoen) er over.</i>" : ""),
      );
    }
  }
}
