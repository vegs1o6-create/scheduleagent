import { z } from "zod";
import {
  correctionPrompt,
  documentPrompt,
  systemPrompt,
  textPrompt,
  type ClaudeApi,
  type MediaType,
  type TextContext,
} from "./claude";
import type { Config, Env } from "./env";
import {
  ExtractionSchema,
  TextResultSchema,
  validateExtraction,
  validateTextResult,
  type Extraction,
  type TextResult,
} from "./schema";
import { log } from "./log";

/**
 * OpenAI-modell hostet i Microsoft Foundry (Azure OpenAI), via v1-API-et
 * (`https://<ressurs>.openai.azure.com/openai/v1/responses`). Samme prompt,
 * skjema og validering som Claude-klienten; bare transporten er annerledes.
 */

export interface FoundrySettings {
  /** F.eks. https://<ressurs>.openai.azure.com/ eller https://<ressurs>.services.ai.azure.com/ */
  endpoint: string;
  apiKey: string;
  /** Navnet på deploymenten i Foundry (ikke nødvendigvis modellnavnet). */
  deployment: string;
  /** low/medium/high for resonneringsmodeller (gpt-5, o-serien). Tom = sendes ikke. */
  reasoningEffort: string | null;
}

export function foundrySettings(env: Env): FoundrySettings {
  return {
    endpoint: env.FOUNDRY_ENDPOINT ?? "",
    apiKey: (env.FOUNDRY_API_KEY ?? "").trim(),
    deployment: env.FOUNDRY_DEPLOYMENT?.trim() || "gpt-5-mini",
    reasoningEffort: env.FOUNDRY_REASONING_EFFORT?.trim() || null,
  };
}

/** Normaliserer det brukeren limer inn til .../openai/v1. Bare opprinnelsen brukes. */
export function foundryBaseUrl(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error("FOUNDRY_ENDPOINT mangler.");
  let origin: string;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    throw new Error(`FOUNDRY_ENDPOINT er ikke en gyldig adresse: ${trimmed}`);
  }
  return `${origin}/openai/v1`;
}

/** JSON Schema for structured outputs (strict: alle felt required, additionalProperties false). */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "output", target: "draft-7" }) as Record<
    string,
    unknown
  >;
  return rest;
}

const SCHEMAS = {
  text: { name: "text_result", schema: jsonSchema(TextResultSchema) },
  extraction: { name: "extraction", schema: jsonSchema(ExtractionSchema) },
} as const;

type InputContent =
  | { type: "input_text"; text: string }
  | { type: "input_file"; file_id: string }
  | { type: "input_image"; image_url: string; detail: "high" };

interface ResponsesResult {
  status?: string;
  model?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const json = JSON.parse(body) as { error?: { message?: string; code?: string } };
    if (json.error?.code === "content_filter") {
      return "Azure sitt innholdsfilter stoppet forespørselen. Prøv å formulere den annerledes.";
    }
    if (json.error?.message) return `Foundry: ${json.error.message} (HTTP ${res.status})`;
  } catch {
    // ikke JSON
  }
  return `Foundry svarte HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
}

export class FoundryClient implements ClaudeApi {
  constructor(
    private readonly settings: FoundrySettings,
    private readonly config: Config,
  ) {}

  /** Regnes ut ved hvert kall, slik at et feil endepunkt gir en feilmelding i Telegram i stedet for krasj. */
  private get baseUrl(): string {
    return foundryBaseUrl(this.settings.endpoint);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "api-key": this.settings.apiKey, ...extra };
  }

  /** Lite testkall som brukes av /setup. */
  async ping(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ model: this.settings.deployment, input: "Svar med ordet ok.", max_output_tokens: 16 }),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    const json = (await res.json()) as ResponsesResult;
    return json.model ?? this.settings.deployment;
  }

  private async run(schemaName: keyof typeof SCHEMAS, content: InputContent[]): Promise<unknown> {
    const started = Date.now();
    const effort = this.settings.reasoningEffort;
    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        model: this.settings.deployment,
        instructions: systemPrompt(this.config),
        input: [{ role: "user", content }],
        max_output_tokens: 16000,
        store: false,
        ...(effort ? { reasoning: { effort } } : {}),
        text: { format: { type: "json_schema", strict: true, ...SCHEMAS[schemaName] } },
      }),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    const json = (await res.json()) as ResponsesResult;
    log("foundry_call", {
      schema: schemaName,
      model: json.model,
      status: json.status,
      input_tokens: json.usage?.input_tokens,
      output_tokens: json.usage?.output_tokens,
      ms: Date.now() - started,
    });
    const parts = (json.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
    if (parts.some((p) => p.type === "refusal")) {
      throw new Error("Modellen avviste forespørselen. Prøv å formulere den annerledes.");
    }
    if (json.status === "incomplete") {
      const reason = json.incomplete_details?.reason;
      throw new Error(
        reason === "content_filter"
          ? "Azure sitt innholdsfilter stoppet svaret. Prøv å formulere den annerledes."
          : "Svaret fra modellen ble for langt og ble kuttet. Prøv å dele opp.",
      );
    }
    const text = parts
      .filter((p) => p.type === "output_text")
      .map((p) => p.text ?? "")
      .join("");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Modellen returnerte ikke gyldig JSON.");
    }
  }

  async interpretText(text: string, ctx: TextContext): Promise<TextResult> {
    const raw = await this.run("text", [{ type: "input_text", text: textPrompt(text, ctx) }]);
    return validateTextResult(raw);
  }

  async extractDocument(
    data: Uint8Array,
    mediaType: MediaType,
    caption: string | null,
    dateContext: string,
  ): Promise<Extraction> {
    const text: InputContent = { type: "input_text", text: documentPrompt("file", caption, dateContext) };
    if (mediaType !== "application/pdf") {
      // Bilder sendes inline; de er som regel små (Telegram komprimerer dem).
      const image: InputContent = {
        type: "input_image",
        image_url: `data:${mediaType};base64,${toBase64(data)}`,
        detail: "high",
      };
      return { ...validateExtraction(await this.run("extraction", [image, text])), source: "ukeplan" };
    }
    // PDF lastes opp i stedet for base64 (sparer CPU-tid i Workeren) og slettes etterpå.
    const fileId = await this.uploadPdf(data);
    try {
      const raw = await this.run("extraction", [{ type: "input_file", file_id: fileId }, text]);
      return { ...validateExtraction(raw), source: "ukeplan" };
    } finally {
      await fetch(`${this.baseUrl}/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: this.headers() })
        .then((r) => log("foundry_file_deleted", { fileId, ok: r.ok }))
        .catch((err) => log("foundry_file_delete_failed", { fileId, error: String(err) }));
    }
  }

  private async uploadPdf(data: Uint8Array): Promise<string> {
    const form = new FormData();
    // Foundry støtter foreløpig ikke purpose "user_data" for PDF-er; "assistants" er anbefalt løsning.
    form.append("purpose", "assistants");
    form.append("file", new Blob([data], { type: "application/pdf" }), "ukeplan.pdf");
    const res = await fetch(`${this.baseUrl}/files`, { method: "POST", headers: this.headers(), body: form });
    if (!res.ok) throw new Error(await errorMessage(res));
    const { id } = (await res.json()) as { id: string };
    log("foundry_file_uploaded", { fileId: id, bytes: data.length });
    return id;
  }

  async extractDocumentText(docText: string, caption: string | null, dateContext: string): Promise<Extraction> {
    const raw = await this.run("extraction", [
      { type: "input_text", text: `Ukeplan (Word):\n<dokument>\n${docText}\n</dokument>` },
      { type: "input_text", text: documentPrompt("word", caption, dateContext) },
    ]);
    return { ...validateExtraction(raw), source: "ukeplan" };
  }

  async applyCorrection(draft: Extraction, correction: string, dateContext: string): Promise<Extraction> {
    const raw = await this.run("extraction", [
      { type: "input_text", text: correctionPrompt(draft, correction, dateContext) },
    ]);
    return validateExtraction(raw);
  }
}
