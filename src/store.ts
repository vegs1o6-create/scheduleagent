import type { Extraction, Item } from "./schema";

/** Et utkast som venter på [OK] [Rett] [Avbryt]. */
export interface Draft {
  id: string;
  extraction: Extraction;
  createdAt: string;
  status: "pending" | "committed" | "cancelled";
  summaryMessageId?: number;
  origin: "pdf" | "text";
}

/** Én skrevet kalenderhendelse, koblet til punktet den kom fra. */
export interface EntryRef {
  eventId: string;
  agentKey: string;
  htmlLink: string;
  child: string | null;
  item: Item;
  /** Hjelpehendelser (f.eks. "frist i dag kl 07:30") som hører til. */
  companionIds: string[];
  /** true hvis boten opprettet hendelsen (ikke bare oppdaterte en eksisterende). */
  created: boolean;
}

export type Mode =
  | { kind: "awaiting_followup"; originalText: string; question: string }
  | { kind: "awaiting_correction"; draftId: string };

export interface WeekplanRecord {
  child: string | null;
  week: string;
  processedAt: string;
  entries: { agentKey: string; eventId: string; title: string; date: string; companionIds: string[] }[];
}

export interface PendingUndo {
  token: string;
  entries: EntryRef[];
  label: string;
}

const DAY = 86_400;

/** Tynn innpakning over KV med typede nøkler. */
export class Store {
  constructor(private readonly kv: KVNamespace) {}

  private async getJson<T>(key: string): Promise<T | null> {
    return (await this.kv.get(key, "json")) as T | null;
  }
  private async putJson(key: string, value: unknown, ttl?: number): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);
  }

  // Dedup av Telegram-oppdateringer (køen leverer minst én gang).
  async seenUpdate(updateId: number): Promise<boolean> {
    const key = `seen:${updateId}`;
    if (await this.kv.get(key)) return true;
    await this.kv.put(key, "1", { expirationTtl: 2 * DAY });
    return false;
  }

  getDraft(id: string) {
    return this.getJson<Draft>(`draft:${id}`);
  }
  saveDraft(d: Draft) {
    return this.putJson(`draft:${d.id}`, d, 14 * DAY);
  }

  async getMode(): Promise<Mode | null> {
    return this.getJson<Mode>("mode");
  }
  setMode(mode: Mode) {
    return this.putJson("mode", mode, DAY);
  }
  /**
   * Skriver "null" i stedet for å slette: KV kan cache "finnes ikke"-svar i
   * opptil et minutt, så en nøkkel som alltid finnes gir ferskere lesing.
   */
  async clearMode() {
    await this.kv.put("mode", "null", { expirationTtl: DAY });
  }

  /** Stabel med sist opprettede oppføringer (nyeste først). */
  async getHistory(): Promise<EntryRef[][]> {
    return (await this.getJson<EntryRef[][]>("history")) ?? [];
  }
  async pushHistory(entries: EntryRef[]): Promise<void> {
    if (!entries.length) return;
    const h = await this.getHistory();
    h.unshift(entries);
    await this.putJson("history", h.slice(0, 20));
  }
  async replaceLatestHistory(entries: EntryRef[]): Promise<void> {
    const h = await this.getHistory();
    if (h.length) h[0] = entries;
    else h.unshift(entries);
    await this.putJson("history", h.slice(0, 20));
  }
  async removeFromHistory(eventIds: string[]): Promise<void> {
    const ids = new Set(eventIds);
    const h = (await this.getHistory())
      .map((group) => group.filter((e) => !ids.has(e.eventId)))
      .filter((group) => group.length > 0);
    await this.putJson("history", h);
  }
  async lastEntry(): Promise<EntryRef | null> {
    const h = await this.getHistory();
    return h[0]?.[h[0].length - 1] ?? null;
  }

  // Kobling Telegram message_id -> kalenderhendelser.
  linkMessage(messageId: number, entries: EntryRef[]) {
    return this.putJson(`msg:${messageId}`, entries, 60 * DAY);
  }
  getLinkedEntries(messageId: number) {
    return this.getJson<EntryRef[]>(`msg:${messageId}`);
  }

  getWeekplan(child: string | null, week: string) {
    return this.getJson<WeekplanRecord>(`weekplan:${child ?? "ukjent"}:${week}`);
  }
  saveWeekplan(r: WeekplanRecord) {
    return this.putJson(`weekplan:${r.child ?? "ukjent"}:${r.week}`, r, 120 * DAY);
  }

  async setLastWeekplanAt(iso: string) {
    await this.kv.put("meta:last_weekplan_at", iso);
  }
  getLastWeekplanAt() {
    return this.kv.get("meta:last_weekplan_at");
  }

  savePendingUndo(p: PendingUndo) {
    return this.putJson(`undo:${p.token}`, p, DAY);
  }
  getPendingUndo(token: string) {
    return this.getJson<PendingUndo>(`undo:${token}`);
  }
  async clearPendingUndo(token: string) {
    await this.kv.delete(`undo:${token}`);
  }

  async markOnce(key: string, ttl: number): Promise<boolean> {
    if (await this.kv.get(`once:${key}`)) return false;
    await this.kv.put(`once:${key}`, "1", { expirationTtl: ttl });
    return true;
  }
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
