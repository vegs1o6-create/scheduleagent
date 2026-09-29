import type { CalendarApi, CalendarEvent, UpsertResult } from "../src/calendar";
import type { ClaudeApi, TextContext } from "../src/claude";
import type { Deps } from "../src/deps";
import { loadConfig, type Env, type JobMessage } from "../src/env";
import type { DriveApi, DriveFile } from "../src/drive";
import type { GoogleEventBody } from "../src/mapping";
import type { Extraction, TextResult } from "../src/schema";
import { Store } from "../src/store";
import type { Keyboard } from "../src/telegram";

export class FakeKV {
  data = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.data.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export class FakeCalendar implements CalendarApi {
  events = new Map<string, CalendarEvent & { body: GoogleEventBody }>();
  deleted: string[] = [];
  /** Antall "API-kall" (for å sjekke grensen på 50 per kjøring på Workers Free). */
  calls = 0;
  private seq = 0;

  private toEvent(id: string, body: GoogleEventBody) {
    return {
      id,
      htmlLink: `https://calendar.google.com/event?eid=${id}`,
      summary: body.summary,
      description: body.description,
      location: body.location,
      start: body.start,
      end: body.end,
      extendedProperties: body.extendedProperties,
      body,
    };
  }

  async listAgentEvents() {
    this.calls++;
    return [...this.events.values()].filter((e) => e.extendedProperties?.private?.agent === "familiebot");
  }
  async findByAgentKey(agentKey: string) {
    this.calls++;
    return [...this.events.values()].find((e) => e.extendedProperties?.private?.agentKey === agentKey) ?? null;
  }
  async upsert(body: GoogleEventBody, known?: CalendarEvent | null): Promise<UpsertResult> {
    const found = known === undefined ? await this.findByAgentKey(body.extendedProperties.private.agentKey!) : known;
    const existing = found ? this.events.get(found.id) : undefined;
    this.calls++;
    if (existing) {
      if (JSON.stringify(existing.body) === JSON.stringify(body)) return { event: existing, action: "unchanged" };
      const ev = this.toEvent(existing.id, body);
      this.events.set(existing.id, ev);
      return { event: ev, action: "updated" };
    }
    const id = `ev${++this.seq}`;
    const ev = this.toEvent(id, body);
    this.events.set(id, ev);
    return { event: ev, action: "created" };
  }
  async patch(eventId: string, body: GoogleEventBody) {
    const ev = this.toEvent(eventId, body);
    this.events.set(eventId, ev);
    return ev;
  }
  async get(eventId: string) {
    return this.events.get(eventId) ?? null;
  }
  async delete(eventId: string) {
    this.deleted.push(eventId);
    this.events.delete(eventId);
  }
  async list() {
    return [...this.events.values()];
  }
}

export interface SentMessage {
  id: number;
  text: string;
  keyboard?: Keyboard;
  replyTo?: number;
}

export class FakeTelegram {
  sent: SentMessage[] = [];
  removedKeyboards: number[] = [];
  private seq = 1000;
  file = new Uint8Array([37, 80, 68, 70]); // "%PDF"

  async sendMessage(_chat: string | number, text: string, keyboard?: Keyboard, replyTo?: number) {
    const id = ++this.seq;
    this.sent.push({ id, text, keyboard, replyTo });
    return id;
  }
  async editMessage() {}
  async removeKeyboard(_chat: string | number, messageId: number) {
    this.removedKeyboards.push(messageId);
  }
  async answerCallback() {}
  async sendChatAction() {}
  async downloadFile() {
    return { bytes: this.file, path: "documents/file.pdf" };
  }
  last(): SentMessage {
    return this.sent[this.sent.length - 1]!;
  }
  buttons(msg = this.last()): string[] {
    return (msg.keyboard ?? []).flat().map((b) => b.callback_data);
  }
}

export class FakeDrive implements DriveApi {
  files: DriveFile[] = [];
  listCalls: { folderId: string; since: string }[] = [];
  downloads: string[] = [];
  async listNewFiles(folderId: string, since: string) {
    this.listCalls.push({ folderId, since });
    return this.files.filter((f) => f.createdTime > since || f.modifiedTime > since);
  }
  async download(fileId: string) {
    this.downloads.push(fileId);
    return new Uint8Array([37, 80, 68, 70]);
  }
}

export class FakeClaude implements ClaudeApi {
  textResults: TextResult[] = [];
  extractions: Extraction[] = [];
  corrections: Extraction[] = [];
  textCalls: { text: string; ctx: TextContext }[] = [];
  correctionCalls: string[] = [];

  async interpretText(text: string, ctx: TextContext) {
    this.textCalls.push({ text, ctx });
    const r = this.textResults.shift();
    if (!r) throw new Error("FakeClaude: ingen textResult i kø");
    return structuredClone(r);
  }
  async extractDocument() {
    const r = this.extractions.shift();
    if (!r) throw new Error("FakeClaude: ingen extraction i kø");
    return structuredClone(r);
  }
  async applyCorrection(_draft: Extraction, correction: string) {
    this.correctionCalls.push(correction);
    const r = this.corrections.shift();
    if (!r) throw new Error("FakeClaude: ingen correction i kø");
    return structuredClone(r);
  }
}

export const TEST_ENV_VARS = {
  TIMEZONE: "Europe/Oslo",
  GOOGLE_CALENDAR_ID: "test@group.calendar.google.com",
  CHILDREN:
    '[{"name":"Sverre","colorId":"9","aliases":["2C"]},{"name":"Astrid","colorId":"4","aliases":["Friluftsgruppa","Tveteråsen"]}]',
  BOTH_COLOR_ID: "5",
} as const;

export const CHAT_ID = "4242";
/** Tirsdag 29. september 2026 kl. 12:00 i Oslo. */
export const NOW = new Date("2026-09-29T10:00:00Z");

export function makeDeps(overrides: Partial<Env> = {}, now: Date = NOW) {
  const kv = new FakeKV();
  const telegram = new FakeTelegram();
  const calendar = new FakeCalendar();
  const claude = new FakeClaude();
  const drive = new FakeDrive();
  const jobs: JobMessage[] = [];
  const config = loadConfig({ ...TEST_ENV_VARS, ...overrides } as unknown as Env);
  const deps: Deps = {
    config,
    store: new Store(kv as unknown as KVNamespace),
    telegram,
    calendar,
    claude,
    drive,
    enqueue: async (job) => void jobs.push(job),
    chatId: CHAT_ID,
    now: () => now,
  };
  return { deps, kv, telegram, calendar, claude, drive, jobs };
}

let updateSeq = 1;
export function textUpdate(text: string, extra: Record<string, unknown> = {}) {
  const id = updateSeq++;
  return {
    update_id: id,
    message: { message_id: 500 + id, chat: { id: Number(CHAT_ID) }, date: 0, text, ...extra },
  };
}
export function documentUpdate(caption?: string) {
  const id = updateSeq++;
  return {
    update_id: id,
    message: {
      message_id: 500 + id,
      chat: { id: Number(CHAT_ID) },
      date: 0,
      caption,
      document: { file_id: "f1", file_name: "ukeplan.pdf", mime_type: "application/pdf", file_size: 1000 },
    },
  };
}
export function callbackUpdate(data: string, messageId = 1) {
  const id = updateSeq++;
  return {
    update_id: id,
    callback_query: { id: `cb${id}`, from: { id: 1 }, data, message: { message_id: messageId, chat: { id: Number(CHAT_ID) } } },
  };
}
