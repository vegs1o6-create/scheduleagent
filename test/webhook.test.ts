import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { timingSafeEqual } from "../src/webhook";
import { FakeKV } from "./fakes";

const SECRET = "hemmelig-webhook-secret_123";

function makeEnv() {
  const sent: unknown[] = [];
  const env = {
    STATE: new FakeKV(),
    JOBS: { send: vi.fn(async (m: unknown) => void sent.push(m)) },
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_ALLOWED_CHAT_ID: "4242",
    GOOGLE_CALENDAR_ID: "x",
  } as unknown as Env;
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return { env, ctx, sent };
}

function req(body: unknown, secret?: string, path = "/telegram") {
  return new Request(`https://bot.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const msg = (chatId: number) => ({ update_id: 1, message: { message_id: 1, chat: { id: chatId }, date: 0, text: "hei" } });

describe("webhook-verifisering", () => {
  it("avviser kall uten secret-header", async () => {
    const { env, ctx, sent } = makeEnv();
    const res = await worker.fetch(req(msg(4242)), env, ctx);
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("avviser feil secret", async () => {
    const { env, ctx, sent } = makeEnv();
    const res = await worker.fetch(req(msg(4242), "feil"), env, ctx);
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("ignorerer andre chat-ID-er stille (200, ingen jobb, ingen svar)", async () => {
    const { env, ctx, sent } = makeEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await worker.fetch(req(msg(999), SECRET), env, ctx);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("ignorerer knappetrykk fra andre chatter", async () => {
    const { env, ctx, sent } = makeEnv();
    const update = { update_id: 2, callback_query: { id: "x", from: { id: 9 }, data: "ok:abc", message: { message_id: 1, chat: { id: 999 } } } };
    const res = await worker.fetch(req(update, SECRET), env, ctx);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("legger gyldige meldinger i køen og svarer 200", async () => {
    const { env, ctx, sent } = makeEnv();
    const res = await worker.fetch(req(msg(4242), SECRET), env, ctx);
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ kind: "telegram_update", update: msg(4242) }]);
  });

  it("svarer 200 på ugyldig JSON uten å legge i kø", async () => {
    const { env, ctx, sent } = makeEnv();
    const res = await worker.fetch(req("{ikke json", SECRET), env, ctx);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("svarer 200 selv om køen feiler", async () => {
    const { env, ctx } = makeEnv();
    (env.JOBS.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("kø nede"));
    const res = await worker.fetch(req(msg(4242), SECRET), env, ctx);
    expect(res.status).toBe(200);
  });

  it("404 for andre stier og metoder", async () => {
    const { env, ctx } = makeEnv();
    expect((await worker.fetch(req(msg(4242), SECRET, "/annet"), env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request("https://bot.example/telegram"), env, ctx)).status).toBe(404);
  });

  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("oppsettside (/setup)", () => {
  it("krever riktig nøkkel", async () => {
    const { env, ctx } = makeEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const none = await worker.fetch(new Request("https://bot.example/setup"), env, ctx);
    const wrong = await worker.fetch(new Request("https://bot.example/setup?key=feil"), env, ctx);
    expect(none.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("setter webhooken til egen adresse og viser status uten å lekke secrets", async () => {
    const { env, ctx } = makeEnv();
    const calls: { url: string; body?: string }[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = String(input);
      calls.push({ url: u, body: init?.body as string | undefined });
      const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
      if (u.endsWith("/getMe")) return json({ username: "familie_bot" });
      if (u.endsWith("/setWebhook")) return json(true);
      if (u.endsWith("/getWebhookInfo")) return json({ url: "https://bot.example/telegram", pending_update_count: 0 });
      if (u.endsWith("/getChat")) return json({ type: "private", first_name: "Vegard" });
      return new Response("{}", { status: 400 });
    });
    const res = await worker.fetch(new Request(`https://bot.example/setup?key=${SECRET}`), env, ctx);
    const text = await res.text();
    const setWebhook = calls.find((c) => c.url.endsWith("/setWebhook"))!;
    expect(JSON.parse(setWebhook.body!)).toMatchObject({ url: "https://bot.example/telegram", secret_token: SECRET });
    expect(text).toContain("✅ Telegram-bot: @familie_bot");
    expect(text).toContain("✅ Telegram-webhook: Satt til https://bot.example/telegram");
    expect(text).toContain("❌ Secrets i Cloudflare: Mangler: FOUNDRY_API_KEY");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("123:abc");
    fetchSpy.mockRestore();
  });
});

describe("toleranse for mellomrom i secrets", () => {
  it("godtar secret med linjeskift/mellomrom fra dashboardet", async () => {
    const { env, ctx, sent } = makeEnv();
    (env as unknown as Record<string, string>).TELEGRAM_WEBHOOK_SECRET = ` ${SECRET}\n`;
    const res = await worker.fetch(req(msg(4242), SECRET), env, ctx);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("/setup forklarer hvorfor nøkkelen ble avvist, uten å vise den", async () => {
    const { env, ctx } = makeEnv();
    const wrong = await (await worker.fetch(new Request("https://bot.example/setup?key=feil"), env, ctx)).text();
    expect(wrong).toContain(`secret er ${SECRET.length} tegn lang; nøkkelen i adressen er 4 tegn`);
    expect(wrong).not.toContain(SECRET);
    (env as unknown as Record<string, string | undefined>).TELEGRAM_WEBHOOK_SECRET = undefined;
    const missing = await (await worker.fetch(new Request("https://bot.example/setup?key=x"), env, ctx)).text();
    expect(missing).toContain("finner ingen TELEGRAM_WEBHOOK_SECRET");
    expect(missing).toContain("✅ TELEGRAM_BOT_TOKEN");
    expect(missing).toContain("❌ FOUNDRY_API_KEY");
    expect(missing).not.toContain("123:abc");
  });
});
