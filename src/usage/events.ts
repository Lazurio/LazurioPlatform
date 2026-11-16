import { createHash } from "node:crypto";

// The usage events an Organization's Work Environment may deliver to the
// Dashboard (`lazurio.usage-event.v1`; proposed, see docs/usage-producer.md).
// The shape is the Dashboard's; this file only builds it. Every string is a
// closed value, a UUID, a module slug or a model name: no event can carry a
// prompt, a reply, a title, a path, a URL or a person. Who the events belong
// to is decided by the Dashboard from the Environment's own token.

export const usageEventSchemaVersion = "lazurio.usage-event.v1";

/** Events per delivery, as the Dashboard accepts them. */
export const usageBatchMaxEvents = 100;

export type UsageEventType =
  | "app.opened"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "model.usage";

export type UsageOrigin = "interactive" | "automation";
export type UsageHarness =
  | "codex"
  | "claude-code"
  | "cursor"
  | "hermes"
  | "mausbot"
  | "other";

/** One event on the wire. Optional keys are left out, never sent empty. */
export type UsageEvent = Readonly<{
  event_id: string;
  occurred_at: string;
  type: UsageEventType;
  origin: UsageOrigin;
  app?: string;
  task_id?: string;
  parent_task_id?: string;
  harness?: UsageHarness;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
}>;

/**
 * A stable UUID for one occurrence, from a key that names it in its source
 * (`run:<id>:started`). The same occurrence read twice gets the same id, so
 * a repeated delivery is a no-op at the Dashboard. The key itself never
 * leaves the Environment: only its digest does, shaped as a version 8 UUID.
 */
export function usageId(key: string): string {
  const hex = createHash("sha256")
    .update(`lazurio.usage.v1\0${key}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The harness a provider name stands for; anything unknown is `other`. */
export function harnessOf(provider: string): UsageHarness {
  const name = provider.toLowerCase();
  if (name.includes("codex")) return "codex";
  if (name.includes("claude")) return "claude-code";
  if (name.includes("cursor")) return "cursor";
  return "other";
}

/** The model families whose names may be sent. */
const modelFamilies: ReadonlySet<string> = new Set([
  "claude",
  "gpt",
  "o1",
  "o3",
  "o4",
  "codex",
  "gemini",
  "grok",
  "llama",
  "mistral",
  "deepseek",
  "qwen",
]);
/** The words a published model name uses after its family. */
const modelWords: ReadonlySet<string> = new Set([
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "mini",
  "nano",
  "pro",
  "flash",
  "lite",
  "sol",
  "turbo",
  "preview",
  "instruct",
  "latest",
  "codex",
  "max",
  "high",
  "medium",
  "low",
  "chat",
  "coder",
  "reasoner",
  "thinking",
  "exp",
]);
/**
 * The bounded numeric parts of a published name: a version (`5`, `6.1`,
 * `4o`, at most two digits per part), a release date (`20241022`) or a size
 * (`70b`). A longer number can be a private identifier and is never sent.
 */
const modelNumbers: readonly RegExp[] = [
  /^\d{1,2}(?:\.\d{1,2}){0,2}[a-z]?$/,
  /^20[2-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/,
  /^\d{1,3}b$/,
];
/** Parts of a model name after its family. */
const modelPartsMax = 5;

/**
 * The model as the contract may carry it. The source's value is untrusted
 * text, so it is rebuilt from known parts only: a known family, then
 * versions and published model words. `unknown` when the source has no
 * model; `other` for anything else, a URL, a path, a provider prefix or a
 * private label of a fine-tuned model included.
 */
export function safeModel(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "unknown";
  const parts = value.trim().toLowerCase().split("-");
  const [family, ...rest] = parts;
  if (
    family === undefined ||
    !modelFamilies.has(family) ||
    rest.length > modelPartsMax
  )
    return "other";
  return rest.every(
    (part) =>
      modelWords.has(part) || modelNumbers.some((shape) => shape.test(part)),
  )
    ? parts.join("-")
    : "other";
}

/** An instant as RFC 3339 UTC, or null for anything that is not one. */
export function instant(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** The delivery body of some events. */
export function usageBatch(events: readonly UsageEvent[]): string {
  return JSON.stringify({ schema_version: usageEventSchemaVersion, events });
}
