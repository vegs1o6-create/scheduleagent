import { z } from "zod";

export interface Env {
  STATE: KVNamespace;
  JOBS: Queue<JobMessage>;

  // Secrets (wrangler secret put ...)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_ALLOWED_CHAT_ID: string;
  ANTHROPIC_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;

  // Vars (wrangler.toml)
  TIMEZONE?: string;
  GOOGLE_CALENDAR_ID: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  REQUIRE_APPROVAL_FOR_TEXT?: string;
  AUTO_APPROVE?: string;
  CHILDREN?: string;
  BOTH_COLOR_ID?: string;
  DEFAULT_EVENT_MINUTES?: string;
  EVENT_REMINDER_MINUTES?: string;
  LOW_CONFIDENCE?: string;
}

/** Jobben som legges i køen: hele Telegram-oppdateringen. */
export interface JobMessage {
  kind: "telegram_update";
  update: unknown;
}

const ChildConfigSchema = z.object({
  name: z.string().min(1),
  colorId: z.string().optional(),
  aliases: z.array(z.string()).default([]),
});
export type ChildConfig = z.infer<typeof ChildConfigSchema>;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Config {
  timezone: string;
  calendarId: string;
  model: string;
  effort: Effort;
  requireApprovalForText: boolean;
  autoApprove: boolean;
  children: ChildConfig[];
  bothColorId: string | undefined;
  defaultEventMinutes: number;
  eventReminderMinutes: number;
  lowConfidence: number;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function loadConfig(env: Env): Config {
  const children = z
    .array(ChildConfigSchema)
    .parse(JSON.parse(env.CHILDREN ?? '[{"name":"Sverre"},{"name":"Astrid"}]'));
  const effort = (env.CLAUDE_EFFORT ?? "medium") as Effort;
  return {
    timezone: env.TIMEZONE || "Europe/Oslo",
    calendarId: env.GOOGLE_CALENDAR_ID,
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    effort: EFFORTS.includes(effort) ? effort : "medium",
    requireApprovalForText: flag(env.REQUIRE_APPROVAL_FOR_TEXT, false),
    autoApprove: flag(env.AUTO_APPROVE, false),
    children,
    bothColorId: env.BOTH_COLOR_ID || undefined,
    defaultEventMinutes: num(env.DEFAULT_EVENT_MINUTES, 60),
    eventReminderMinutes: num(env.EVENT_REMINDER_MINUTES, 60),
    lowConfidence: num(env.LOW_CONFIDENCE, 0.7),
  };
}
