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
