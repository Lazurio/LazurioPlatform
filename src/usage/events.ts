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

const modelName = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** A model name the contract accepts, or none. */
export function usableModel(value: unknown): string | undefined {
  return typeof value === "string" && modelName.test(value) ? value : undefined;
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
