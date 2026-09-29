import { describe, expect, it } from "vitest";
import { agentKey, normalizeTitle } from "../src/key";

describe("nøkkelgenerering", () => {
  it("normaliserer tittel", () => {
    expect(normalizeTitle("  Tur til Østmarka! ")).toBe("tur til ostmarka");
    expect(normalizeTitle("Svarslipp – høsttur")).toBe("svarslipp hosttur");
    expect(normalizeTitle("Blåbær-tur, ÆRE")).toBe("blabaer tur aere");
    expect(normalizeTitle("Café")).toBe("cafe");
  });

  it("er stabil og uavhengig av formatering", async () => {
    const a = await agentKey("Sverre", "2026-10-01", "Tur til Østmarka");
    const b = await agentKey(" sverre ", "2026-10-01", "tur til østmarka!!");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("endres med barn, dato og tittel", async () => {
    const base = await agentKey("Sverre", "2026-10-01", "Fotball");
    expect(await agentKey("Astrid", "2026-10-01", "Fotball")).not.toBe(base);
    expect(await agentKey("Sverre", "2026-10-02", "Fotball")).not.toBe(base);
    expect(await agentKey("Sverre", "2026-10-01", "Svømming")).not.toBe(base);
    expect(await agentKey(null, "2026-10-01", "Fotball")).not.toBe(base);
  });

  it("gir kjent verdi (fanger utilsiktede endringer i algoritmen)", async () => {
    // sha256("sverre|2026-10-01|fotball"), første 16 bytes
    const expected = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sverre|2026-10-01|fotball"))),
    ]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await agentKey("Sverre", "2026-10-01", "Fotball")).toBe(expected);
  });
});
