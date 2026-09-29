import type { Deps } from "../deps";
import type { Extraction } from "../schema";
import type { EntryRef, ReminderPicker } from "../store";
import { newId } from "../store";
import { eventDate, planEvents, reminderLabel, resolveChild, titleFor } from "../mapping";
import { formatDateNo } from "../dates";
import { escapeHtml as e, type Keyboard } from "../telegram";
import { log } from "../log";

const MAX_BUTTON_TITLE = 28;

function shortTitle(entry: EntryRef): string {
  const t = titleFor(entry.child, entry.item.title);
  return t.length > MAX_BUTTON_TITLE ? `${t.slice(0, MAX_BUTTON_TITLE - 1)}…` : t;
}

function shortDate(entry: EntryRef): string {
  const d = eventDate(entry.item);
  if (!d) return "";
  const [day, date] = formatDateNo(d).split(" ");
  return `${day!.slice(0, 3)} ${date}`;
}

function pickerText(p: ReminderPicker): string {
  const lines = p.entries.map(
    (x, i) =>
      `${i + 1}. ${e(titleFor(x.child, x.item.title))} – ${e(shortDate(x))} <i>(${e(reminderLabel(x.item))})</i>`,
  );
  const intro =
    p.entries.length === 1
      ? "🔔 Vil du ha varsel på denne?"
      : "🔔 Vil du ha varsel på noen av disse?\nTrykk på dem du vil ha varsel for, og så «Lagre varsler».";
  return `${intro}\n\n${lines.join("\n")}`;
}

function pickerKeyboard(p: ReminderPicker): Keyboard {
  if (p.entries.length === 1) {
    return [
      [
        { text: "🔔 Ja, legg til varsel", callback_data: `rs:${p.token}` },
        { text: "Nei takk", callback_data: `rn:${p.token}` },
      ],
    ];
  }
  const rows: Keyboard = p.entries.map((x, i) => [
    {
      text: `${p.selected.includes(i) ? "✅" : "⬜"} ${i + 1}. ${shortTitle(x)} ${shortDate(x)}`,
      callback_data: `rt:${p.token}:${i}`,
    },
  ]);
  rows.push([
    { text: "Velg alle", callback_data: `ra:${p.token}` },
    { text: "Ingen varsler", callback_data: `rn:${p.token}` },
  ]);
  rows.push([{ text: `💾 Lagre varsler (${p.selected.length})`, callback_data: `rs:${p.token}` }]);
  return rows;
}

/**
 * Etter at oppføringer er skrevet (uten varsler): spør om noen skal ha varsel.
 * Oppføringer som allerede har varsel, tas ikke med.
 */
export async function askForReminders(deps: Deps, written: EntryRef[], extraction: Extraction): Promise<void> {
  const entries = written.filter((w) => !w.reminder && w.item.type !== "info");
  if (!entries.length) return;
  const picker: ReminderPicker = {
    token: newId(),
    entries,
    context: {
      source: extraction.source,
      week: extraction.week,
      child: resolveChild(extraction.child, deps.config),
    },
    selected: entries.length === 1 ? [0] : [],
  };
  picker.messageId = await deps.telegram.sendMessage(deps.chatId, pickerText(picker), pickerKeyboard(picker));
  await deps.store.saveReminderPicker(picker);
}

/** Knappene rt (velg/fjern), ra (alle), rn (ingen) og rs (lagre). */
export async function handleReminderCallback(
  deps: Deps,
  action: string,
  token: string,
  arg: string | undefined,
  messageId: number | undefined,
): Promise<void> {
  const { store, telegram } = deps;
  const picker = await store.getReminderPicker(token);
  if (!picker) {
    if (messageId) await telegram.removeKeyboard(deps.chatId, messageId);
    await telegram.sendMessage(deps.chatId, "Dette varselspørsmålet er utløpt. Bruk /uke for å se oppføringene.");
    return;
  }
  const msgId = messageId ?? picker.messageId;

  if (action === "rt" || action === "ra") {
    if (action === "ra") picker.selected = picker.entries.map((_x, i) => i);
    else {
      const i = Number(arg);
      if (!Number.isInteger(i) || i < 0 || i >= picker.entries.length) return;
      picker.selected = picker.selected.includes(i)
        ? picker.selected.filter((s) => s !== i)
        : [...picker.selected, i].sort((a, b) => a - b);
    }
    await store.saveReminderPicker(picker);
    if (msgId) await telegram.editMessage(deps.chatId, msgId, pickerText(picker), pickerKeyboard(picker));
    return;
  }

  if (action === "rn" || (action === "rs" && picker.selected.length === 0)) {
    await store.clearReminderPicker(token);
    if (msgId) await telegram.editMessage(deps.chatId, msgId, "🔕 Ingen varsler lagt til.");
    return;
  }

  if (action === "rs") {
    // Fjern spørsmålet først, så et dobbelt trykk ikke gjør jobben to ganger.
    await store.clearReminderPicker(token);
    const chosen = picker.selected.map((i) => picker.entries[i]!).filter(Boolean);
    const updated: EntryRef[] = [];
    for (const entry of chosen) {
      const extraction: Extraction = {
        source: picker.context.source,
        week: picker.context.week,
        child: entry.child,
        items: [],
        general_notes: null,
      };
      const [main, ...companions] = await planEvents({ ...entry.item, child: null }, extraction, deps.config, {
        withReminders: true,
      });
      if (!main) continue;
      await deps.calendar.patch(entry.eventId, main.body);
      const companionIds = [...entry.companionIds];
      for (const c of companions) {
        const id = (await deps.calendar.upsert(c.body)).event.id;
        if (!companionIds.includes(id)) companionIds.push(id);
      }
      updated.push({ ...entry, reminder: true, companionIds });
    }
    await store.updateHistoryEntries(updated);
    log("reminders_added", { eventIds: updated.map((u) => u.eventId) });
    const lines = updated.map((u) => `• ${e(titleFor(u.child, u.item.title))} – <i>${e(reminderLabel(u.item))}</i>`);
    if (msgId) await telegram.editMessage(deps.chatId, msgId, `🔔 Varsel lagt til:\n${lines.join("\n")}`);
  }
}
