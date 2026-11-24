import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { type AiReading, aiState } from "../tools/ai";
import {
  askCodex,
  type Converse,
  converse,
  readClaude,
  readCodex,
} from "../tools/ai-probe";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";

// Product choice belongs here. T3 owns its settings and records its last
// managed write; neither Machines nor this reader edits settings.json.
// This is Chat's model where the Environment's Codex configuration pins none.
export const recommendedChatModel = Object.freeze({
  instanceId: "codex",
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "medium" }],
});

/** Chat's model where Codex cannot work here and Claude Code is signed in
 * (F51's addendum of 2026-11-24, LazurioPlatform#1197): T3 Code's Claude
 * instance with its default chat model and effort (T3's model manifest,
 * `claudeAgent.defaults.chat`). */
export const recommendedClaudeModel = Object.freeze({
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "medium" }],
});

/** Whether the AI as read says Chat should run on Claude: Codex answered
 * that it cannot work (signed out or not installed) and Claude Code is
 * signed in. Codex provided by the Organization, signed in, or not known
 * keeps Codex, as before. */
export function claudeOnly(ai: AiReading): boolean {
  const state = (provider: string) =>
    ai.providers.find((reading) => reading.provider === provider)?.state;
  const codex = state("codex");
  return (
    (codex === "signed-out" || codex === "not-installed") &&
    state("claude") === "signed-in"
  );
}

type Selection = Readonly<{
  instanceId: string;
  model: string;
  options?: readonly Readonly<{ id: string; value: string | boolean }>[];
}>;
export type ChatDefaults = Readonly<{
  kind: "chat-defaults";
  state: "managed" | "custom" | "outdated" | "unavailable";
  /** Whose model the Platform recommends here, once that is known: Codex's
   * (ChatGPT) or Claude's (F51's addendum of 2026-11-24). */
  ai?: "codex" | "claude";
  reason?:
    | "t3-launcher-missing"
    | "t3-defaults-unavailable"
    | "t3-answer-unreadable"
    | "codex-config-unreadable";
}>;
const selection = (value: unknown): value is Selection => {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.instanceId === "string" &&
    typeof v.model === "string" &&
    (v.options === undefined ||
      (Array.isArray(v.options) &&
        v.options.every(
          (x) =>
            x !== null &&
            typeof x === "object" &&
            typeof x.id === "string" &&
            ["string", "boolean"].includes(typeof x.value),
        )))
  );
};
const same = (a: Selection | null, b: Selection | null): boolean =>
  a === null || b === null
    ? a === b
    : a.instanceId === b.instanceId &&
      a.model === b.model &&
      (a.options === undefined || b.options === undefined
        ? a.options === b.options
        : a.options.length === b.options.length &&
          a.options.every(
            (x, i) =>
              x.id === b.options?.[i]?.id && x.value === b.options?.[i]?.value,
          ));

/** The `model` of Codex's `config/read` result (`{ config, origins,
 * layers }`): a one-line name without control characters, null when the
 * configuration pins none, or undefined for any other answer. */
export function configuredCodexModel(
  result: unknown,
): string | null | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const config = (result as Record<string, unknown>).config;
  if (config === null || typeof config !== "object") return undefined;
  const model = (config as Record<string, unknown>).model;
  if (model === null || model === undefined) return null;
  return typeof model === "string" && /^[^\p{Cc}\s]{1,256}$/u.test(model)
    ? model
    : undefined;
}

/** The AI as Chat's model needs it: Claude Code first, and Codex's sign-in
 * only where Claude is signed in, so the usual reading starts Codex once,
 * for its configuration. */
async function aiForChat(
  tools: ToolsEnvironment,
  talk: Converse,
): Promise<AiReading> {
  const claude = await readClaude(tools, 10_000).catch(
    () => ({ provider: "claude", state: "unknown" }) as const,
  );
  if (claude.state !== "signed-in")
    return { state: aiState([claude]), providers: [claude] };
  const codex = await readCodex(tools, talk, 10_000).catch(
    () => ({ provider: "codex", state: "unknown" }) as const,
  );
  return { state: aiState([codex, claude]), providers: [codex, claude] };
}

/** Chat's model (root decision 0209, 0204's addendum of 2026-10-19): the one
 * this Environment's Codex configuration pins, as Codex itself resolves its
 * layers (a system file Machines writes, the operator's own), never by
 * reading its files and never from an Organization setting; the Platform's
 * own when Codex answers that it pins none. Same effort either way.
 * Undefined when Codex could not be asked or gave no usable answer: the
 * model is then not known, and a gateway that admits only the pinned model
 * would refuse the Platform's own, so nothing may be written.
 * Where Codex cannot work and Claude Code is signed in (`claudeOnly`), the
 * model is Claude's (F51's addendum of 2026-11-24): a Chat on Codex would
 * not answer there. */
export async function recommendedChatSelection(
  tools: ToolsEnvironment,
  talk: Converse = converse,
  reading?: AiReading,
): Promise<Selection | undefined> {
  if (claudeOnly(reading ?? (await aiForChat(tools, talk))))
    return recommendedClaudeModel;
  const answer = await askCodex(tools, talk, 10_000, "config/read", {
    includeLayers: false,
  }).catch(() => "no-answer" as const);
  const model =
    typeof answer === "string"
      ? undefined
      : configuredCodexModel(answer.result);
  if (model === undefined) return undefined;
  return model === null
    ? recommendedChatModel
    : Object.freeze({ ...recommendedChatModel, model });
}

// T3's answer is one JSON line, the last one on its stdout. T3 may log before
// it on stdout (a migration-history warning when its data directory was opened
// by a later T3 build, Lazurio/t3code#210), so a line before the answer is not
// a failure. No JSON object on the last non-empty line is an unreadable answer.
function t3Answer(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .at(-1);
  if (line === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function chatDefaults(
  tools: ToolsEnvironment,
  options: Readonly<{
    apply?: boolean;
    folder?: string;
    /** Tests only: the conversation with Codex's app-server. */
    converse?: Converse;
    /** Tests only: the AI as read, instead of asking both CLIs. */
    ai?: AiReading;
  }> = {},
): Promise<ChatDefaults> {
  const unavailable = {
    kind: "chat-defaults",
    state: "unavailable",
    reason: "t3-defaults-unavailable",
  } as const;
  const executable = await resolveOnPath("t3", tools.path, tools.platform);
  if (executable === undefined)
    return { ...unavailable, reason: "t3-launcher-missing" };
  if (!tools.home || (options.apply && !options.folder)) return unavailable;
  try {
    // Without Codex's answer T3 is neither asked nor changed.
    const recommended = await recommendedChatSelection(
      tools,
      options.converse,
      options.ai,
    );
    if (recommended === undefined)
      return { ...unavailable, reason: "codex-config-unreadable" };
    const ai =
      recommended.instanceId === recommendedClaudeModel.instanceId
        ? ("claude" as const)
        : ("codex" as const);
    const known = { ...unavailable, ai };
    const command = [
      executable,
      "lazurio",
      "model",
      "--base-dir",
      join(tools.home, ".t3"),
    ];
    if (options.apply && options.folder)
      command.push(
        JSON.stringify({
          folder: await realpath(options.folder),
          selection: recommended,
        }),
      );
    const result = await tools.run(
      command,
      15_000,
      { HOME: tools.home, ...(tools.path ? { PATH: tools.path } : {}) },
      { maxBytes: 32 * 1024 },
    );
    if (result === "timeout" || result.exitCode !== 0) return known;
    const body = t3Answer(result.stdout);
    if (body === undefined) return { ...known, reason: "t3-answer-unreadable" };
    if (
      body.version !== 1 ||
      !(body.current === null || selection(body.current)) ||
      !(body.lastManaged === null || selection(body.lastManaged))
    )
      return known;
    const current = body.current as Selection | null;
    const managed = body.lastManaged as Selection | null;
    return {
      kind: "chat-defaults",
      ai,
      state: same(current, recommended)
        ? "managed"
        : current !== null && !same(current, managed)
          ? "custom"
          : "outdated",
    };
  } catch {
    return unavailable;
  }
}
