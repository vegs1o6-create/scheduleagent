/**
 * Stabil idempotensnøkkel: hash(barn + dato + normalisert tittel).
 * Lagres i extendedProperties.private.agentKey på kalenderhendelsen.
 */

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // fjern aksenter (å -> a, é -> e)
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeChild(child: string | null | undefined): string {
  return (child ?? "").trim().toLowerCase();
}

export async function agentKey(child: string | null | undefined, date: string, title: string): Promise<string> {
  const input = `${normalizeChild(child)}|${date}|${normalizeTitle(title)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
