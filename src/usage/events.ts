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

/** The model families a name may be reduced to: a fixed list, never the source's text. */
const modelFamilies: readonly string[] = [
  "claude",
  "gpt",
  "o1",
  "o3",
  "o4",
  "codex",
  "gemini",
];

/**
 * The shapes of published model names, one fixed grammar per family: a tier
 * word from a closed list, a version of one or two digits with at most one
 * one-digit minor, and a release date. No shape repeats a part, so no
 * combination of numbers or words can spell anything else.
 */
const knownModels: readonly RegExp[] = [
  // claude-opus-5-5, claude-sonnet-4-20250514
  /^claude-(?:opus|sonnet|haiku|fable)-\d{1,2}(?:-\d)?(?:-20[2-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))?$/,
  // claude-3-5-sonnet-20241022
  /^claude-\d(?:-\d)?-(?:opus|sonnet|haiku)(?:-20[2-3]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))?$/,
  // gpt-6.1-sol, gpt-4o-mini, gpt-5-codex, gpt-4o-2024-08-06
  /^gpt-\d{1,2}(?:\.\d)?o?(?:-(?:mini|nano|pro|sol|turbo|codex|chat))?(?:-20[2-3]\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))?$/,
  // o3, o4-mini, o3-pro
  /^o[134](?:-(?:mini|pro))?$/,
  // codex-mini
  /^codex-(?:mini|max)$/,
  // gemini-2.5-pro, gemini-2.0-flash-lite
  /^gemini-\d(?:\.\d)?-(?:pro|flash|flash-lite)(?:-preview)?$/,
];

/**
 * The model as the contract may carry it. The source's value is untrusted
 * text, so only a whole published name of a known shape is sent as it is. A
 * name of a known family in any other shape (a private fine-tune, a version
 * of many numbers) is reduced to the family from the fixed list; anything
 * else, a URL, a path or a provider prefix included, is `other`; a missing
 * value is `unknown`.
 */
export function safeModel(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "unknown";
  const name = value.trim().toLowerCase();
  if (knownModels.some((shape) => shape.test(name))) return name;
  const family = modelFamilies.find(
    (candidate) => name === candidate || name.startsWith(`${candidate}-`),
  );
  return family ?? "other";
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
