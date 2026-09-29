/**
 * Strukturert logging. Logger hva som ble lest og skrevet (ID-er, nøkler,
 * antall), aldri hemmeligheter eller fulle meldingstekster.
 */
const SECRET_KEYS = /token|secret|key|authorization|password/i;

export function log(event: string, data: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    safe[k] = SECRET_KEYS.test(k) && k !== "agentKey" && k !== "agentKeys" ? "[redacted]" : v;
  }
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...safe }));
}
