import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { askCodex, type Converse, converse } from "../tools/ai-probe";
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

type Selection = Readonly<{
  instanceId: string;
  model: string;
  options?: readonly Readonly<{ id: string; value: string | boolean }>[];
}>;
export type ChatDefaults = Readonly<{
  kind: "chat-defaults";
  state: "managed" | "custom" | "outdated" | "unavailable";
  reason?:
    | "t3-launcher-missing"
    | "t3-defaults-unavailable"
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

/** Chat's model (root decision 0209, 0204's addendum of 2026-10-19): the one
 * this Environment's Codex configuration pins, as Codex itself resolves its
 * layers (a system file Machines writes, the operator's own), never by
 * reading its files and never from an Organization setting; the Platform's
 * own when Codex answers that it pins none. Same effort either way.
 * Undefined when Codex could not be asked or gave no usable answer: the
 * model is then not known, and a gateway that admits only the pinned model
 * would refuse the Platform's own, so nothing may be written. */
export async function recommendedChatSelection(
  tools: ToolsEnvironment,
  talk: Converse = converse,
): Promise<Selection | undefined> {
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

export async function chatDefaults(
  tools: ToolsEnvironment,
  options: Readonly<{
    apply?: boolean;
    folder?: string;
    /** Tests only: the conversation with Codex's app-server. */
    converse?: Converse;
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
    const recommended = await recommendedChatSelection(tools, options.converse);
    if (recommended === undefined)
      return { ...unavailable, reason: "codex-config-unreadable" };
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
    if (result === "timeout" || result.exitCode !== 0) return unavailable;
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      body.version !== 1 ||
      !(body.current === null || selection(body.current)) ||
      !(body.lastManaged === null || selection(body.lastManaged))
    )
      return unavailable;
    const current = body.current as Selection | null;
    const managed = body.lastManaged as Selection | null;
    return {
      kind: "chat-defaults",
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
