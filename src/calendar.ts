import type { GoogleEventBody } from "./mapping";
import { log } from "./log";

export interface CalendarEvent {
  id: string;
  htmlLink: string;
  summary?: string;
  description?: string;
  location?: string;
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
  upsert(body: GoogleEventBody): Promise<UpsertResult>;
  patch(eventId: string, body: GoogleEventBody): Promise<CalendarEvent>;
  get(eventId: string): Promise<CalendarEvent | null>;
  delete(eventId: string): Promise<void>;
  list(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
}

interface TokenCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const TOKEN_CACHE_KEY = "google:access_token";

/**
 * Google Calendar via REST + OAuth refresh token.
 * Scopes: calendar.events + calendar.readonly.
 */
export class GoogleCalendar implements CalendarApi {
  constructor(
    private readonly calendarId: string,
    private readonly creds: GoogleCredentials,
    private readonly cache: TokenCache,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.cache.get(TOKEN_CACHE_KEY);
      if (cached) return cached;
    }
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
      }),
    });
    if (!res.ok) {
      log("google_token_error", { status: res.status });
      throw new Error(`Google OAuth feilet (${res.status}). Sjekk GOOGLE_REFRESH_TOKEN.`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    const ttl = Math.max(60, (json.expires_in ?? 3600) - 120);
    await this.cache.put(TOKEN_CACHE_KEY, json.access_token, { expirationTtl: ttl });
    return json.access_token;
  }

  private base(): string {
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`;
  }

  private async request<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.accessToken(retried);
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) return this.request<T>(method, url, body, true);
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

  async upsert(body: GoogleEventBody): Promise<UpsertResult> {
    const key = body.extendedProperties.private.agentKey!;
    const existing = await this.findByAgentKey(key);
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
