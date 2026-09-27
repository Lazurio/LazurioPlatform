import type { ToolOverview, ToolsOverview } from "../tools/overview";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

/** What the browser shows on the tools screen: pure, so it is testable
 * without a DOM. Text comes from the messages; values are filled in here.
 * Everything returned is text for `textContent`, never markup. */
type Copy = Readonly<Record<MessageKey, string>>;

const tiers = ["required", "recommended", "optional"] as const;
type Tier = (typeof tiers)[number];

const text = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("\0");
const optionalText = (value: unknown): value is string | undefined =>
  value === undefined || text(value);

function parseTool(input: unknown): ToolOverview | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    !text(value.name) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(value.name) ||
    !text(value.command) ||
    !tiers.includes(value.tier as Tier) ||
    (value.setup !== "launchpad" && value.setup !== "agent") ||
    typeof value.enabled !== "boolean" ||
    typeof value.installed !== "boolean" ||
    !text(value.purpose) ||
    !text(value.usage) ||
    !text(value.source) ||
    !text(value.prompt) ||
    !optionalText(value.path) ||
    !optionalText(value.realPath) ||
    !optionalText(value.version) ||
    !optionalText(value.versionError) ||
    (value.standardPath !== undefined &&
      typeof value.standardPath !== "boolean")
  )
    return null;
  return {
    name: value.name,
    command: value.command,
    tier: value.tier as Tier,
    setup: value.setup,
    enabled: value.enabled,
    installed: value.installed,
    purpose: value.purpose,
    usage: value.usage,
    source: value.source,
    prompt: value.prompt,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.realPath === undefined ? {} : { realPath: value.realPath }),
    ...(value.version === undefined ? {} : { version: value.version }),
    ...(value.versionError === undefined
      ? {}
      : { versionError: value.versionError }),
    ...(value.standardPath === undefined
      ? {}
      : { standardPath: value.standardPath }),
  };
}

/** The server's answer, accepted only in its exact expected form; anything
 * else is "could not be read", never a half-rendered screen. */
export function parseToolsOverview(input: unknown): ToolsOverview | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    value.kind !== "tools-status" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    (value.locale !== "cs" && value.locale !== "en") ||
    typeof value.sharedEnvironment !== "boolean" ||
    !text(value.mcpPrompt) ||
    !Array.isArray(value.tools)
  )
    return null;
  const tools: ToolOverview[] = [];
  for (const entry of value.tools) {
    const tool = parseTool(entry);
    if (tool === null || tools.some((other) => other.name === tool.name))
      return null;
    tools.push(tool);
  }
  return {
    kind: "tools-status",
    revision: value.revision,
    locale: value.locale,
    sharedEnvironment: value.sharedEnvironment,
    mcpPrompt: value.mcpPrompt,
    tools,
  };
}

export type ToolGroup = Readonly<{
  tier: Tier;
  title: string;
  note: string;
  tools: readonly ToolOverview[];
}>;

/** Required, Recommended, Optional, each in catalog order; a tier without a
 * tool has no heading. */
export function toolGroups(
  tools: readonly ToolOverview[],
  copy: Copy,
): readonly ToolGroup[] {
  const headings: Record<Tier, readonly [MessageKey, MessageKey]> = {
    required: ["toolsTierRequired", "toolsTierRequiredNote"],
    recommended: ["toolsTierRecommended", "toolsTierRecommendedNote"],
    optional: ["toolsTierOptional", "toolsTierOptionalNote"],
  };
  return tiers
    .map((tier) => ({
      tier,
      title: copy[headings[tier][0]],
      note: copy[headings[tier][1]],
      tools: tools.filter((tool) => tool.tier === tier),
    }))
    .filter((group) => group.tools.length > 0);
}

export type ToolStatusView = Readonly<{
  /** `ready`: installed and its version read; `attention`: installed with
   * something to look at; `missing`: not installed. */
  state: "ready" | "attention" | "missing";
  headline: string;
  /** Where the tool is, when it is installed. */
  path: string | null;
  /** Things to look at, one sentence each. */
  notes: readonly string[];
}>;

export function toolStatusView(tool: ToolOverview, copy: Copy): ToolStatusView {
  if (!tool.installed)
    return {
      state: "missing",
      headline: copy.toolsNotInstalled,
      path: null,
      notes: [],
    };
  const notes = [
    ...(tool.versionError === undefined
      ? []
      : [fill(copy.toolsVersionError, { error: tool.versionError })]),
    ...(tool.standardPath === false ? [copy.toolsOutsideStandard] : []),
  ];
  return {
    state: notes.length === 0 ? "ready" : "attention",
    headline:
      tool.version === undefined
        ? copy.toolsInstalledNoVersion
        : fill(copy.toolsInstalled, { version: tool.version }),
    path:
      tool.path === undefined
        ? null
        : tool.realPath !== undefined && tool.realPath !== tool.path
          ? `${tool.path} → ${tool.realPath}`
          : tool.path,
    notes,
  };
}

/** The full next selection a request carries: the enabled tools that are not
 * required, with one of them switched, sorted and unique. */
export function nextSelection(
  tools: readonly ToolOverview[],
  name: string,
  enable: boolean,
): string[] {
  const names = new Set(
    tools
      .filter((tool) => tool.tier !== "required" && tool.enabled)
      .map((tool) => tool.name),
  );
  if (enable) names.add(name);
  else names.delete(name);
  return [...names].sort();
}

/** The files a previewed change rewrites, as the preview names them. */
export function previewedFiles(preview: unknown): string[] {
  if (!preview || typeof preview !== "object") return [];
  const files = (preview as Record<string, unknown>).files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) =>
    typeof file?.path === "string" ? [file.path as string] : [],
  );
}

export type ToolChangeOutcome = Readonly<{
  kind: "previewed" | "updated" | "unchanged" | "blocked" | "failed";
  message: string;
  /** The state shown is no longer the Folder's: offer a reload. */
  reload: boolean;
}>;

/** One readable sentence for whatever a preview or an update answered. */
export function toolChangeOutcome(
  result: unknown,
  change: Readonly<{ name: string; enable: boolean; installed: boolean }>,
  copy: Copy,
): ToolChangeOutcome {
  const value =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  if (value.kind === "profile-change") {
    const files = previewedFiles(value);
    return {
      kind: "previewed",
      message: [
        fill(
          change.enable ? copy.toolsConfirmEnable : copy.toolsConfirmDisable,
          { name: change.name },
        ),
        ...(files.length === 0
          ? []
          : [fill(copy.toolsConfirmFiles, { files: files.join(", ") })]),
        ...(change.enable && !change.installed
          ? [fill(copy.toolsConfirmNotInstalled, { name: change.name })]
          : []),
      ].join(" "),
      reload: false,
    };
  }
  if (value.kind === "updated" && typeof value.revision === "number")
    return {
      kind: "updated",
      message: fill(
        change.enable ? copy.toolsEnabledDone : copy.toolsDisabledDone,
        { name: change.name, revision: String(value.revision) },
      ),
      reload: false,
    };
  if (value.kind === "unchanged")
    return { kind: "unchanged", message: copy.toolsUnchanged, reload: true };
  if (value.kind === "blocked" && typeof value.reason === "string") {
    const message =
      value.reason === "stale-revision"
        ? copy.toolsBlockedStale
        : value.reason === "drift" && typeof value.path === "string"
          ? fill(copy.toolsBlockedDrift, { path: value.path })
          : value.reason === "incomplete-state"
            ? copy.toolsBlockedIncomplete
            : fill(copy.toolsBlockedOther, { reason: value.reason });
    return { kind: "blocked", message, reload: true };
  }
  return { kind: "failed", message: copy.toolsFailed, reload: true };
}

/** Only an https address of the catalog becomes a link. */
export function sourceLink(source: string): string | null {
  try {
    const url = new URL(source);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
