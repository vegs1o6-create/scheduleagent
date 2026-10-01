import { AGENT_TAG, type GoogleEventBody } from "./mapping";
import type { GoogleAuth } from "./google-auth";
import { log } from "./log";

export interface CalendarEvent {
  id: string;
  htmlLink: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export interface UpsertResult {
  event: CalendarEvent;
  action: "created" | "updated" | "unchanged";
}

/** Grensesnittet resten av koden bruker (gjør testing enkelt). */
export interface CalendarApi {
  findByAgentKey(agentKey: string): Promise<CalendarEvent | null>;
  /** Alle hendelser boten har laget i et tidsrom (ett kall i stedet for ett per punkt). */
  listAgentEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
  /**
   * Oppretter eller oppdaterer via agentKey. `existing` kan sendes inn fra en
   * forhåndslasting (null = vet at den ikke finnes) for å spare API-kall.
   */
  upsert(body: GoogleEventBody, existing?: CalendarEvent | null): Promise<UpsertResult>;
  patch(eventId: string, body: GoogleEventBody): Promise<CalendarEvent>;
  get(eventId: string): Promise<CalendarEvent | null>;
  delete(eventId: string): Promise<void>;
  list(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
}

/**
 * Google Calendar via REST + OAuth refresh token.
 * Scopes: calendar.events + calendar.readonly.
 */
export class GoogleCalendar implements CalendarApi {
  constructor(
    private readonly calendarId: string,
    private readonly auth: GoogleAuth,
  ) {}

  private base(): string {
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`;
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.auth.fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (method === "DELETE" && (res.status === 204 || res.status === 410 || res.status === 404)) {
      return undefined as T;
    }
    if (!res.ok) {
      const text = await res.text();
      log("google_api_error", { method, status: res.status, detail: text.slice(0, 300) });
      throw new Error(`Google Calendar ${method} feilet (${res.status})`);
    }
    return (await res.json()) as T;
  }

  async listAgentEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      privateExtendedProperty: `agent=${AGENT_TAG}`,
      timeMin,
      timeMax,
      singleEvents: "true",
      maxResults: "250",
    });
    const res = await this.request<{ items?: CalendarEvent[] }>("GET", `${this.base()}?${params}`);
    log("calendar_preloaded", { count: res.items?.length ?? 0, timeMin, timeMax });
    return res.items ?? [];
  }

  async findByAgentKey(agentKey: string): Promise<CalendarEvent | null> {
    const params = new URLSearchParams({
      privateExtendedProperty: `agentKey=${agentKey}`,
      maxResults: "5",
      showDeleted: "false",
    });
    const res = await this.request<{ items?: CalendarEvent[] }>("GET", `${this.base()}?${params}`);
    return res.items?.[0] ?? null;
  }

  async get(eventId: string): Promise<CalendarEvent | null> {
    try {
      const ev = await this.request<CalendarEvent & { status?: string }>(
        "GET",
        `${this.base()}/${encodeURIComponent(eventId)}`,
      );
      return ev.status === "cancelled" ? null : ev;
    } catch {
      return null;
    }
  }

  async upsert(body: GoogleEventBody, known?: CalendarEvent | null): Promise<UpsertResult> {
    const key = body.extendedProperties.private.agentKey!;
    const existing = known === undefined ? await this.findByAgentKey(key) : known;
    if (existing) {
      if (sameContent(existing, body)) {
        log("calendar_unchanged", { eventId: existing.id, agentKey: key });
        return { event: existing, action: "unchanged" };
      }
      const event = await this.patch(existing.id, body);
      return { event, action: "updated" };
    }
    const event = await this.request<CalendarEvent>("POST", this.base(), body);
    log("calendar_created", { eventId: event.id, agentKey: key });
    return { event, action: "created" };
  }

  async patch(eventId: string, body: GoogleEventBody): Promise<CalendarEvent> {
    const event = await this.request<CalendarEvent>("PATCH", `${this.base()}/${encodeURIComponent(eventId)}`, body);
    log("calendar_updated", { eventId, agentKey: body.extendedProperties.private.agentKey });
    return event;
  }

  async delete(eventId: string): Promise<void> {
    await this.request<void>("DELETE", `${this.base()}/${encodeURIComponent(eventId)}`);
    log("calendar_deleted", { eventId });
  }

  async list(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    const res = await this.request<{ items?: CalendarEvent[] }>("GET", `${this.base()}?${params}`);
    log("calendar_listed", { count: res.items?.length ?? 0, timeMin, timeMax });
    return res.items ?? [];
  }
}

function sameContent(existing: CalendarEvent, body: GoogleEventBody): boolean {
  const norm = (s: { date?: string; dateTime?: string }) =>
    s.date ?? (s.dateTime ? new Date(s.dateTime).toISOString() : "");
  return (
    existing.summary === body.summary &&
    (existing.description ?? "") === body.description &&
    (existing.location ?? "") === (body.location ?? "") &&
    norm(existing.start) === norm(body.start) &&
    norm(existing.end) === norm(body.end)
  );
}
