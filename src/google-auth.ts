import { log } from "./log";

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface TokenCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const TOKEN_CACHE_KEY = "google:access_token";

/**
 * OAuth med refresh token, delt mellom Kalender og Drive.
 * Access token caches i KV til litt før det utløper.
 */
export class GoogleAuth {
  constructor(
    private readonly creds: GoogleCredentials,
    private readonly cache: TokenCache,
    // Ikke `= fetch` direkte: kalt som this.fetchImpl(...) gir «Illegal invocation» i Workers.
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async accessToken(forceRefresh = false): Promise<string> {
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

  /** fetch med Bearer-token; prøver én gang til med nytt token ved 401. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const doFetch = async (force: boolean) =>
      this.fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${await this.accessToken(force)}` },
      });
    const res = await doFetch(false);
    return res.status === 401 ? doFetch(true) : res;
  }
}
