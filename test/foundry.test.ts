import { afterEach, describe, expect, it, vi } from "vitest";
import { FoundryClient, foundryBaseUrl } from "../src/foundry";
import { loadConfig, type Env } from "../src/env";
import { TEST_ENV_VARS } from "./fakes";
import { UKEPLAN_SVERRE } from "./fixtures/ukeplaner";

const config = loadConfig(TEST_ENV_VARS as unknown as Env);
const settings = {
  endpoint: "https://min-ressurs.openai.azure.com/",
  apiKey: "hemmelig",
  deployment: "gpt-5-mini",
  reasoningEffort: "medium",
};

function responseWith(obj: unknown) {
  return new Response(
    JSON.stringify({
      status: "completed",
      model: "gpt-5-mini",
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(obj) }] },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
  );
}

describe("Microsoft Foundry-klient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normaliserer endepunktet til /openai/v1", () => {
    expect(foundryBaseUrl("https://x.openai.azure.com/")).toBe("https://x.openai.azure.com/openai/v1");
    expect(foundryBaseUrl("https://x.services.ai.azure.com/api/projects/p")).toBe(
      "https://x.services.ai.azure.com/openai/v1",
    );
    expect(() => foundryBaseUrl("")).toThrow("FOUNDRY_ENDPOINT");
  });

  it("sender strict JSON-skjema og api-key, og validerer svaret", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init });
      return responseWith(UKEPLAN_SVERRE);
    });
    const result = await new FoundryClient(settings, config).applyCorrection(UKEPLAN_SVERRE, "punkt 1 er ok", "I dag");
    expect(result.items.length).toBe(UKEPLAN_SVERRE.items.length);
    expect(calls[0]!.url).toBe("https://min-ressurs.openai.azure.com/openai/v1/responses");
    expect((calls[0]!.init!.headers as Record<string, string>)["api-key"]).toBe("hemmelig");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.model).toBe("gpt-5-mini");
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true, name: "extraction" });
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.instructions).toContain("Sverre");
  });

  it("laster opp PDF, bruker file_id og sletter filen etterpå", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url.endsWith("/files")) return new Response(JSON.stringify({ id: "assistant-file-1" }));
      if (url.includes("/files/")) return new Response("{}");
      return responseWith(UKEPLAN_SVERRE);
    });
    const res = await new FoundryClient(settings, config).extractDocument(
      new Uint8Array([37, 80, 68, 70]),
      "application/pdf",
      "Ukeplan 2C.pdf",
      "I dag",
    );
    expect(res.source).toBe("ukeplan");
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^.*\/openai\/v1/, "")}`)).toEqual([
      "POST /files",
      "POST /responses",
      "DELETE /files/assistant-file-1",
    ]);
    const body = JSON.parse(calls[1]!.body as string);
    expect(body.input[0].content[0]).toEqual({ type: "input_file", file_id: "assistant-file-1" });
  });

  it("sender bilder inline som data-URL", async () => {
    let body: { input: { content: { type: string; image_url?: string }[] }[] } | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      body = JSON.parse(init!.body as string);
      return responseWith(UKEPLAN_SVERRE);
    });
    await new FoundryClient(settings, config).extractDocument(new Uint8Array([1, 2, 3]), "image/png", null, "I dag");
    expect(body!.input[0]!.content[0]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,AQID" });
  });

  it("gir forståelig feil ved innholdsfilter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "content_filter", message: "x" } }), { status: 400 }),
    );
    await expect(new FoundryClient(settings, config).applyCorrection(UKEPLAN_SVERRE, "x", "I dag")).rejects.toThrow(
      "innholdsfilter",
    );
  });
});
