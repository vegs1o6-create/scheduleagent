import { afterEach, describe, expect, it, vi } from "vitest";
import { Telegram } from "../src/telegram";
import { GoogleAuth } from "../src/google-auth";

/** Workers kaster «Illegal invocation» hvis fetch kalles med feil `this`. */
function strictFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, access_token: "t", expires_in: 3600 })),
    );
  } as typeof fetch);
}

describe("fetch kalles uten feil this (Cloudflare Workers)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Telegram", async () => {
    strictFetch();
    await expect(new Telegram("tok").sendMessage(1, "hei")).resolves.toBe(1);
  });

  it("GoogleAuth", async () => {
    strictFetch();
    const cache = { get: async () => null, put: async () => undefined };
    const auth = new GoogleAuth({ clientId: "a", clientSecret: "b", refreshToken: "c" }, cache);
    await expect(auth.accessToken(true)).resolves.toBe("t");
  });
});
