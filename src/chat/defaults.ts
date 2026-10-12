import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";

// Product choice belongs here. T3 owns its settings and records its last
// managed write; neither Machines nor this reader edits settings.json.
export const recommendedChatModel = Object.freeze({
  instanceId: "codex",
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
});

type Selection = Readonly<{
  instanceId: string;
  model: string;
  options?: readonly Readonly<{ id: string; value: string | boolean }>[];
}>;
export type ChatDefaults = Readonly<{
  kind: "chat-defaults";
  state: "managed" | "custom" | "outdated" | "unavailable";
  reason?: "t3-launcher-missing" | "t3-defaults-unavailable";
  modelAvailable?: boolean;
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
      JSON.stringify(
        [...(a.options ?? [])].sort((x, y) => x.id.localeCompare(y.id)),
      ) ===
        JSON.stringify(
          [...(b.options ?? [])].sort((x, y) => x.id.localeCompare(y.id)),
        );

export async function chatDefaults(
  tools: ToolsEnvironment,
  options: Readonly<{ apply?: boolean; folder?: string }> = {},
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
          selection: recommendedChatModel,
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
      state: same(current, recommendedChatModel)
        ? "managed"
        : current !== null && !same(current, managed)
          ? "custom"
          : "outdated",
      ...(typeof body.modelAvailable === "boolean"
        ? { modelAvailable: body.modelAvailable }
        : {}),
    };
  } catch {
    return unavailable;
  }
}
