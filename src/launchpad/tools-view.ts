import {
  normalizeToolNote,
  type ToolNoteProblem,
  toolNoteLimits,
  toolNoteProblem,
} from "../tools/note";
import type { ToolOverview, ToolsOverview } from "../tools/overview";
import type { ToolSignIn } from "../tools/status";
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

function parseSignIn(input: unknown): ToolSignIn | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    (value.state !== "signed-in" &&
      value.state !== "signed-out" &&
      value.state !== "unknown") ||
    !optionalText(value.account) ||
    !optionalText(value.organization)
  )
    return null;
  return {
    state: value.state,
    ...(value.account === undefined ? {} : { account: value.account }),
    ...(value.organization === undefined
      ? {}
      : { organization: value.organization }),
  };
}

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
      typeof value.standardPath !== "boolean") ||
    !optionalText(value.note)
  )
    return null;
  const signIn =
    value.signIn === undefined ? undefined : parseSignIn(value.signIn);
  if (signIn === null) return null;
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
    ...(signIn === undefined ? {} : { signIn }),
    ...(value.note === undefined ? {} : { note: value.note }),
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
    typeof value.hosted !== "boolean" ||
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
    hosted: value.hosted,
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

/** On a hosted Machine a tool outside `~/.local/bin` is something to look at
 * (decision 0161); on a local workstation any tool on PATH is fine. */
export function toolStatusView(
  tool: ToolOverview,
  copy: Copy,
  hosted: boolean,
): ToolStatusView {
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
    ...(hosted && tool.standardPath === false
      ? [copy.toolsOutsideStandard]
      : []),
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

/** The one line about the sign-in: as whom when the tool tells, not signed
 * in, unknown, or not checked when the page did not ask. */
export function signInLine(tool: ToolOverview, copy: Copy): string {
  const signIn = tool.signIn;
  if (signIn === undefined) return copy.toolsSignInUnchecked;
  if (signIn.state === "signed-out") return copy.toolsSignedOut;
  if (signIn.state === "unknown") return copy.toolsSignInUnknown;
  if (signIn.account === undefined) return copy.toolsSignedIn;
  return signIn.organization === undefined
    ? fill(copy.toolsSignedInAs, { account: signIn.account })
    : fill(copy.toolsSignedInAsOrganization, {
        account: signIn.account,
        organization: signIn.organization,
      });
}

/** The label of the (not yet available) curated action of a `launchpad`
 * tool, or null when there is nothing to do: installed and signed in. */
export function curatedActionLabel(
  tool: ToolOverview,
  copy: Copy,
): string | null {
  if (tool.setup !== "launchpad") return null;
  if (!tool.installed) return copy.toolsInstallAction;
  if (tool.signIn?.state === "signed-in") return null;
  return copy.toolsSignInAction;
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

/** The recorded notes of the page, keys sorted: the one representation. */
export function currentNotes(
  tools: readonly ToolOverview[],
): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const tool of [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  ))
    if (tool.note !== undefined) notes[tool.name] = tool.note;
  return notes;
}

/** The full next set of notes with one tool's note set or removed. */
export function nextNotes(
  tools: readonly ToolOverview[],
  name: string,
  note: string | undefined,
): Record<string, string> {
  const notes = currentNotes(tools);
  if (note === undefined) delete notes[name];
  else notes[name] = note;
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(notes).sort())
    sorted[key] = notes[key] as string;
  return sorted;
}

/** Whether a note may carry an operator's note: required or enabled. */
export function takesNote(tool: ToolOverview): boolean {
  return tool.tier === "required" || tool.enabled;
}

export type NoteDraftView = Readonly<{
  /** The text that would be stored. */
  note: string;
  /** "123 / 600" */
  count: string;
  /** Why it cannot be saved, when it cannot; an empty draft is no problem,
   * it is what Clear stores. */
  problem: string | null;
  /** Save does something: a valid note that differs from the recorded one. */
  savable: boolean;
}>;

/** A typed note checked with the rules of the Folder state. */
export function noteDraftView(
  draft: string,
  recorded: string | undefined,
  copy: Copy,
): NoteDraftView {
  const note = normalizeToolNote(draft);
  const problem: ToolNoteProblem | null =
    note.length === 0 ? null : toolNoteProblem(note);
  const messages: Record<ToolNoteProblem, string> = {
    empty: "",
    "not-normalized": "",
    "too-long": fill(copy.toolsNoteTooLong, {
      max: String(toolNoteLimits.characters),
    }),
    "too-many-lines": fill(copy.toolsNoteTooManyLines, {
      max: String(toolNoteLimits.lines),
    }),
    control: copy.toolsNoteControl,
  };
  return {
    note,
    count: fill(copy.toolsNoteCount, {
      count: String(Array.from(note).length),
      max: String(toolNoteLimits.characters),
    }),
    problem: problem === null ? null : messages[problem] || null,
    savable: note.length > 0 && problem === null && note !== recorded,
  };
}

/** What a recorded change did, for its confirmation and its Undo. */
export type ToolChange = Readonly<{
  name: string;
  action: "enable" | "disable" | "note-save" | "note-clear" | "undo";
  /** Whether the tool is installed: enabling a missing tool says so. */
  installed: boolean;
}>;

export type ToolChangeOutcome = Readonly<{
  kind: "updated" | "unchanged" | "blocked" | "failed";
  message: string;
  /** The state shown is no longer the Folder's: offer a reload. */
  reload: boolean;
  /** The Folder revision the change produced, for an Undo at it. */
  revision?: number;
  /** A tool was added on an Environment whose sign-ins are shared. */
  shared?: boolean;
}>;

/** One readable sentence for whatever an update answered. */
export function toolChangeOutcome(
  result: unknown,
  change: ToolChange,
  copy: Copy,
): ToolChangeOutcome {
  const value =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  if (
    value.kind === "updated" &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1
  ) {
    const done: Record<ToolChange["action"], MessageKey> = {
      enable: "toolsEnabledDone",
      disable: "toolsDisabledDone",
      "note-save": "toolsNoteSaved",
      "note-clear": "toolsNoteCleared",
      undo: "toolsUndone",
    };
    const values = { name: change.name, revision: String(value.revision) };
    return {
      kind: "updated",
      message: [
        fill(copy[done[change.action]], values),
        ...(change.action === "enable" && !change.installed
          ? [fill(copy.toolsEnabledNotInstalled, values)]
          : []),
      ].join(" "),
      reload: false,
      revision: value.revision,
      shared: value.warning === "shared-environment-sign-ins",
    };
  }
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
