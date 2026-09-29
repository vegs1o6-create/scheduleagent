#!/usr/bin/env node
/**
 * Henter en Google OAuth refresh token for familiebot.
 *
 * Bruk:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-refresh-token.mjs
 *
 * Krever en OAuth-klient av typen "Desktop app" i Google Cloud Console.
 * Scopes: calendar.events + calendar.readonly, og drive.readonly for
 * Drive-mappen med ukeplaner (sett INCLUDE_DRIVE=false for å droppe den).
 * Skriver refresh token til terminalen – lim den inn med
 *   npx wrangler secret put GOOGLE_REFRESH_TOKEN
 * og ikke lagre den noe annet sted.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Sett GOOGLE_CLIENT_ID og GOOGLE_CLIENT_SECRET som miljøvariabler først.");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8765);
const redirectUri = `http://127.0.0.1:${PORT}/callback`;
const state = randomBytes(16).toString("hex");
const scopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  ...(process.env.INCLUDE_DRIVE === "false" ? [] : ["https://www.googleapis.com/auth/drive.readonly"]),
];

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: scopes.join(" "),
  access_type: "offline",
  prompt: "consent",
  state,
}).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("Ugyldig state");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`Ingen kode: ${url.searchParams.get("error") ?? "ukjent feil"}`);
    return;
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = await tokenRes.json();
  if (!json.refresh_token) {
    res.writeHead(500).end("Fikk ikke refresh token. Se terminalen.");
    console.error("Svar fra Google (uten tokens):", { error: json.error, error_description: json.error_description });
    server.close();
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Ferdig! Gå tilbake til terminalen.");
  console.log("\nRefresh token (lim inn i `npx wrangler secret put GOOGLE_REFRESH_TOKEN`):\n");
  console.log(json.refresh_token);
  console.log("\nGitte scopes:", json.scope);
  server.close();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Åpne denne lenken i nettleseren og logg inn med Google-kontoen som eier kalenderen:\n");
  console.log(authUrl.toString());
});
