import { executorToolName, vaultToolName } from "../tools/catalog";
import type { LoginChallenge, LoginState } from "../tools/login";
import {
  normalizeToolNote,
  type ToolNoteProblem,
  toolNoteLimits,
  toolNoteProblem,
} from "../tools/note";
import type { ToolOverview, ToolsOverview } from "../tools/overview";
import {
  type SshKeyFacts,
  type SshLink,
  type SshLinkFailure,
  type SshStatus,
  sshLinkFailures,
} from "../tools/ssh-key";
import type { ToolSignIn } from "../tools/status";
import { type GhIdentity, githubActionRefused } from "../tools/team-github";
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

const fingerprint = (value: unknown): value is string =>
  typeof value === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);

function parseSshStatus(input: unknown): SshStatus | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    (value.state !== "linked" &&
      value.state !== "not-linked" &&
      value.state !== "unknown") ||
    (value.reason !== undefined &&
      !["no-key", "not-registered", "scope-missing", "unreadable"].includes(
        value.reason as string,
      )) ||
    (value.fingerprint !== undefined && !fingerprint(value.fingerprint))
  )
    return null;
  return {
    state: value.state,
    ...(value.reason === undefined
      ? {}
      : { reason: value.reason as NonNullable<SshStatus["reason"]> }),
    ...(value.fingerprint === undefined
      ? {}
      : { fingerprint: value.fingerprint as string }),
  };
}

const identities: readonly GhIdentity[] = [
  "person",
  "app",
  "variable",
  "unknown",
];

function parseSignIn(input: unknown): ToolSignIn | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    (value.state !== "signed-in" &&
      value.state !== "signed-out" &&
      value.state !== "unknown") ||
    !optionalText(value.account) ||
    !optionalText(value.organization) ||
    (value.identity !== undefined &&
      !identities.includes(value.identity as GhIdentity))
  )
    return null;
  const ssh = value.ssh === undefined ? undefined : parseSshStatus(value.ssh);
  if (ssh === null) return null;
  return {
    state: value.state,
    ...(value.account === undefined ? {} : { account: value.account }),
    ...(value.organization === undefined
      ? {}
      : { organization: value.organization }),
    ...(ssh === undefined ? {} : { ssh }),
    ...(value.identity === undefined
      ? {}
      : { identity: value.identity as GhIdentity }),
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
    typeof value.offered !== "boolean" ||
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
    offered: value.offered,
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

/** The tools with a row of their own, which says where they are not offered
 * yet (the vault, decision F43; Executor, F44). */
const ownRows: readonly string[] = [vaultToolName, executorToolName];

/** Required, Recommended, Optional, each in catalog order; a tier without a
 * tool has no heading. A tool this Environment does not offer is listed only
 * while it is switched on, so that it can be switched off (decision F44),
 * or when its own row says why it is not here. */
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
      tools: tools.filter(
        (tool) =>
          tool.tier === tier &&
          (tool.offered || tool.enabled || ownRows.includes(tool.name)),
      ),
    }))
    .filter((group) => group.tools.length > 0);
}

// What each tool is for, in a sentence for an office person (Matěj
// 2026-10-04, the wireframe's Settings → Nástroje). Only the page says it:
// `activation.purpose` of the catalog is rendered into the agents' generated
// files and stays as it is.
const descriptionKeys: Readonly<Record<string, MessageKey>> = {
  gh: "toolsDescriptionGh",
  composio: "toolsDescriptionComposio",
  bitwarden: "toolsDescriptionBitwarden",
  executor: "toolsDescriptionExecutor",
  wacli: "toolsDescriptionWacli",
  gogcli: "toolsDescriptionGogcli",
  neon: "toolsDescriptionNeon",
};

/** The one sentence under a tool's name: what it is for, in plain words;
 * the catalog's purpose for a tool this page has no sentence for. */
export function toolDescription(
  tool: Pick<ToolOverview, "name" | "purpose">,
  copy: Copy,
): string {
  const key = Object.hasOwn(descriptionKeys, tool.name)
    ? descriptionKeys[tool.name]
    : undefined;
  return key === undefined ? tool.purpose : copy[key];
}

/** The state under a tool's name (Matěj 2026-10-04): connected as whom, not
 * connected, or not added yet; the version and the rest are in its
 * details. A tool switched on for agents that is not installed yet says
 * instead that agents start using it once it is (Matěj 2026-10-09): the
 * row's live state, so it is said only while it is true, never kept from
 * the moment the switch was flipped. The SSH key of gh is part of it only
 * when it needs the person (not linked) and on a Team Environment, which
 * works through Lazurio for GitHub. */
export function connectionLine(
  tool: ToolOverview,
  copy: Copy,
  brokered = false,
): Readonly<{ text: string; state: string; ssh: string | null }> {
  if (!tool.installed)
    return {
      // A required tool has no switch: it is only not added yet.
      text:
        tool.enabled && tool.tier !== "required"
          ? fill(copy.toolsEnabledNotInstalled, { name: tool.name })
          : copy.toolsNotAdded,
      state: "missing",
      ssh: null,
    };
  const ssh = tool.signIn?.ssh;
  // The line without the key's state; the key follows as its own part.
  let text = signInLine(tool, copy, brokered);
  if (tool.signIn !== undefined && ssh !== undefined) {
    const { ssh: _, ...signIn } = tool.signIn;
    text = signInLine({ ...tool, signIn }, copy, brokered);
  }
  const key =
    ssh === undefined
      ? null
      : brokered
        ? copy.toolsSshTeam
        : ssh.state === "not-linked"
          ? copy.toolsSshNotLinked
          : null;
  return {
    text,
    state: tool.signIn?.state ?? "unchecked",
    ssh: key,
  };
}

/** Whether a sign-in that just completed in this Launchpad turns the tool's
 * "Používají agenti" on (Matěj 2026-10-04), so that it works without a
 * second step: only a tool that has the switch (not a required one) and has
 * it off, and never when the tool was signed in before the sign-in started.
 * A person may turn it off again. */
export function autoEnable(
  tool: Pick<ToolOverview, "tier" | "enabled"> | undefined,
  state: LoginView,
): boolean {
  return (
    state.kind === "signed-in" &&
    state.already !== true &&
    tool !== undefined &&
    tool.tier !== "required" &&
    !tool.enabled
  );
}

/** The title of a tool's sign-in dialog: "Připojit GitHub", "Připojit
 * aplikace" (Composio), otherwise "Připojit <tool>". */
export function loginTitle(
  name: string,
  mode: "install" | "login" | "ssh",
  copy: Copy,
): string {
  if (mode === "ssh") return fill(copy.toolsLoginTitleSsh, { name });
  if (name === "gh") return copy.toolsLoginTitleGh;
  if (name === "composio") return copy.toolsLoginTitleComposio;
  return fill(
    mode === "install" ? copy.toolsLoginTitleInstall : copy.toolsLoginTitle,
    { name },
  );
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
  /** Installed outside the standard place on a hosted Machine (decision
   * 0161 point 6): the card offers "Fix with an agent" and says nothing a
   * person would have to decode (Matěj 2026-10-05). */
  fix: boolean;
}>;

/** On a hosted Machine a tool outside `~/.local/bin` is something an agent
 * straightens (decision 0161); on a local workstation any tool on PATH is
 * fine. People see no sentence about paths, only the fix action. */
export function toolStatusView(
  tool: ToolOverview,
  copy: Copy,
  hosted: boolean,
  team = false,
): ToolStatusView {
  if (!tool.installed)
    return {
      state: "missing",
      headline: copy.toolsNotInstalled,
      path: null,
      notes: [],
      fix: false,
    };
  const notes =
    tool.versionError === undefined
      ? []
      : [fill(copy.toolsVersionError, { error: tool.versionError })];
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
    // A Team's gh is the Organization's brokered gh, which the Machine
    // installs where it belongs: nothing to fix.
    fix: hosted && tool.standardPath === false && !(team && tool.name === "gh"),
  };
}

/** The one line about the sign-in: as whom when the tool tells, not signed
 * in, unknown, or not checked when the page did not ask. On a Team
 * Environment (`brokered`) gh working as the Organization's App identity is
 * not a sign-in of anybody: "Works as lazurio-for-github[bot]". */
export function signInLine(
  tool: ToolOverview,
  copy: Copy,
  brokered = false,
): string {
  const signIn = tool.signIn;
  if (signIn === undefined) return copy.toolsSignInUnchecked;
  if (signIn.state === "signed-out") return copy.toolsSignedOut;
  if (signIn.state === "unknown") return copy.toolsSignInUnknown;
  if (
    brokered &&
    tool.name === "gh" &&
    signIn.identity === "app" &&
    signIn.account !== undefined
  )
    return fill(copy.toolsWorksAs, { account: signIn.account });
  const who =
    signIn.account === undefined
      ? copy.toolsSignedIn
      : signIn.organization === undefined
        ? fill(copy.toolsSignedInAs, { account: signIn.account })
        : fill(copy.toolsSignedInAsOrganization, {
            account: signIn.account,
            organization: signIn.organization,
          });
  // gh: "Signed in as octocat · SSH key linked" (decision F19, addendum
  // 2026-09-28).
  if (signIn.ssh === undefined) return who;
  const ssh =
    signIn.ssh.state === "linked"
      ? copy.toolsSshLinked
      : signIn.ssh.state === "not-linked"
        ? copy.toolsSshNotLinked
        : copy.toolsSshUnknown;
  return `${who} · ${ssh}`;
}

export type CuratedActions = Readonly<{
  /** The flow the main button opens: install first, or sign in only; on a
   * Team Environment gh is installed only (`install-only`). */
  primary: Readonly<{
    mode: "install" | "login" | "install-only";
    label: string;
  }> | null;
  /** A signed-in `launchpad` tool offers "Sign out". */
  logout: boolean;
  /** A signed-in gh whose SSH key is not known to be linked offers "Link
   * SSH key". */
  linkSsh: boolean;
}>;

/** The curated actions of a `launchpad` tool (decision F19): "Install and
 * sign in" when it is missing, "Sign in" when it is installed and not known
 * to be signed in, "Sign out" when it is signed in. An `agent` tool has none;
 * its prepared prompt is the way. On a Team Environment (`brokered`: the
 * preset's brokered Organization identity, which the status answers as
 * `sharedEnvironment`) gh follows the server's rule (Matěj 2026-09-28):
 * no sign-in and no SSH key, and "Sign out" only while a person's account is
 * signed in there, never for the Organization's identity. */
export function curatedActions(
  tool: ToolOverview,
  copy: Copy,
  brokered = false,
): CuratedActions {
  if (tool.setup !== "launchpad")
    return { primary: null, logout: false, linkSsh: false };
  if (githubActionRefused({ brokered, tool: tool.name, action: "login" }))
    return {
      // A Team Machine normally has gh from the Organization's broker; a
      // missing one is installed, never signed in.
      primary: tool.installed
        ? null
        : { mode: "install-only", label: copy.toolsInstallOnlyAction },
      linkSsh: false,
      logout: !githubActionRefused({
        brokered,
        tool: tool.name,
        action: "logout",
        signIn: tool.signIn,
      }),
    };
  if (!tool.installed)
    return {
      primary: { mode: "install", label: copy.toolsInstallAction },
      logout: false,
      linkSsh: false,
    };
  if (tool.signIn?.state === "signed-in")
    return {
      primary: null,
      logout: true,
      linkSsh:
        tool.name === "gh" &&
        tool.signIn.ssh !== undefined &&
        tool.signIn.ssh.state !== "linked",
    };
  return {
    primary: { mode: "login", label: copy.toolsSignInAction },
    logout: false,
    linkSsh: false,
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
  /** Whether the tool is installed now: only then does an enable say that
   * agents use it; until then its row says when they will. */
  installed: boolean;
}>;

export type ToolChangeOutcome = Readonly<{
  kind: "updated" | "unchanged" | "blocked" | "failed";
  /** One plain sentence on the tool's row: never the Folder, its revision,
   * a path or a command (Matěj 2026-10-09). */
  message: string;
  /** The technical part, for the tool's Details only. */
  detail?: string;
  /** The state shown is no longer the Folder's: offer a reload. */
  reload: boolean;
  /** The Folder revision the change produced, for an Undo at it. */
  revision?: number;
  /** A tool was added on an Environment whose sign-ins are shared. */
  shared?: boolean;
}>;

/** One plain sentence for whatever an update answered, and the technical
 * part apart from it. */
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
    // A tool that is not installed yet is only switched on: its row says
    // that agents start using it once it is, and the confirmation does not
    // say otherwise.
    const done: Record<ToolChange["action"], MessageKey> = {
      enable: change.installed ? "toolsEnabledDone" : "toolsSwitchedOn",
      disable: "toolsDisabledDone",
      "note-save": "toolsNoteSaved",
      "note-clear": "toolsNoteCleared",
      undo: "toolsUndone",
    };
    return {
      kind: "updated",
      message: fill(copy[done[change.action]], { name: change.name }),
      reload: false,
      revision: value.revision,
      shared: value.warning === "shared-environment-sign-ins",
    };
  }
  if (value.kind === "unchanged")
    return { kind: "unchanged", message: copy.toolsUnchanged, reload: true };
  if (value.kind === "blocked" && typeof value.reason === "string") {
    if (value.reason === "stale-revision")
      return { kind: "blocked", message: copy.toolsBlockedStale, reload: true };
    if (value.reason === "drift" && typeof value.path === "string")
      return {
        kind: "blocked",
        message: copy.toolsBlockedDrift,
        detail: fill(copy.toolsBlockedDriftDetail, { path: value.path }),
        reload: true,
      };
    if (value.reason === "incomplete-state")
      return {
        kind: "blocked",
        message: copy.toolsBlockedIncomplete,
        detail: copy.toolsBlockedIncompleteDetail,
        reload: true,
      };
    // A reason this page has no sentence for is named, never hidden: in
    // the Details.
    return {
      kind: "blocked",
      message: copy.toolsBlockedOther,
      detail: fill(copy.toolsBlockedOtherDetail, { reason: value.reason }),
      reload: true,
    };
  }
  return {
    kind: "failed",
    message: copy.toolsFailed,
    detail: copy.toolsFailedDetail,
    reload: true,
  };
}

/** The last act on one tool's row and what the server answered to it
 * (Matěj 2026-10-09: a notice never contradicts the live state). It holds
 * no sentence: the row says it again from the tool as the page shows it, at
 * every render. */
export type ToolNotice = Readonly<{
  name: string;
  /** The Folder revision it belongs to: the one a change produced, where
   * its Undo applies, or the one the page showed when it was made. */
  revision: number;
  act: Readonly<
    | { kind: "change"; action: ToolChange["action"]; answer: unknown }
    | { kind: "team-install" | "logout"; answer: unknown }
  >;
  /** The selection and the notes before a recorded change: what Undo
   * restores, at `revision`. */
  undo: Readonly<{
    tools: readonly string[];
    notes: Readonly<Record<string, string>>;
  }> | null;
}>;

/** What a notice says now, from its tool as the page shows it. */
export function toolNoticeView(
  notice: ToolNotice,
  tool: Pick<ToolOverview, "installed">,
  copy: Copy,
): ToolChangeOutcome {
  const act = notice.act;
  if (act.kind === "change")
    return toolChangeOutcome(
      act.answer,
      { name: notice.name, action: act.action, installed: tool.installed },
      copy,
    );
  return act.kind === "team-install"
    ? teamInstallOutcome(act.answer, notice.name, copy)
    : logoutOutcome(act.answer, notice.name, copy);
}

/** Whether a notice still holds after the page read the tools: only at its
 * own revision and while its tool is listed. Another revision means the
 * Folder changed since, elsewhere, and its Undo would be refused. */
export function noticeHolds(
  notice: Pick<ToolNotice, "name" | "revision">,
  overview: Pick<ToolsOverview, "revision" | "tools">,
): boolean {
  return (
    notice.revision === overview.revision &&
    overview.tools.some((tool) => tool.name === notice.name)
  );
}

/** The line above the tools: when they were read. The Folder and its
 * revision are nothing a person needs here (Matěj 2026-10-09); Settings →
 * General shows the revision. */
export function checkedLine(at: Date, locale: "cs" | "en", copy: Copy): string {
  return fill(copy.toolsChecked, {
    time: at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
  });
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

/** A login answer of the server, accepted only in its exact form; a pending
 * WhatsApp login may carry its QR code as SVG drawn by the server. */
export type LoginView = LoginState & { qrSvg?: string };

const loginFailures = [
  "not-installed",
  "unexpected-url",
  "unexpected-output",
  "tool-exit",
  "not-confirmed",
  "invalid-phone",
  "spawn-failed",
  "not-signed-in",
  "environment-unreadable",
  "no-challenge",
] as const;

function parseKeyFacts(input: unknown): SshKeyFacts | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  return text(value.path) &&
    value.path.length <= 4096 &&
    fingerprint(value.fingerprint) &&
    typeof value.created === "boolean"
    ? {
        path: value.path,
        fingerprint: value.fingerprint,
        created: value.created,
      }
    : null;
}

/** The SSH outcome of a gh sign-in, only in its exact form. */
function parseSshLink(input: unknown): SshLink | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.state === "linked") {
    const key = parseKeyFacts(value.key);
    if (
      key === null ||
      (value.registration !== "added" &&
        value.registration !== "already-registered") ||
      (value.knownHosts !== "added" && value.knownHosts !== "present")
    )
      return null;
    return {
      state: "linked",
      key,
      registration: value.registration,
      knownHosts: value.knownHosts,
    };
  }
  if (value.state !== "not-linked") return null;
  if (
    !sshLinkFailures.includes(value.reason as SshLinkFailure) ||
    value.fallback !== "agent" ||
    !optionalText(value.provedAs)
  )
    return null;
  const key = value.key === undefined ? undefined : parseKeyFacts(value.key);
  if (key === null) return null;
  return {
    state: "not-linked",
    reason: value.reason as SshLinkFailure,
    ...(key === undefined ? {} : { key }),
    ...(value.provedAs === undefined ? {} : { provedAs: value.provedAs }),
    fallback: "agent",
  };
}

function parseChallenge(input: unknown): LoginChallenge | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const sequence =
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 1
      ? value.sequence
      : null;
  if (value.kind === "device-code") {
    const url = loginLink(value.url, "github.com");
    return url !== null &&
      url === "https://github.com/login/device" &&
      typeof value.code === "string" &&
      /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value.code)
      ? { kind: "device-code", url, code: value.code }
      : null;
  }
  if (value.kind === "url") {
    const url = loginLink(value.url, "dashboard.composio.dev");
    return url === null ? null : { kind: "url", url };
  }
  if (value.kind === "qr")
    return typeof value.payload === "string" && sequence !== null
      ? { kind: "qr", payload: value.payload, sequence }
      : null;
  if (value.kind === "pair-code")
    return typeof value.phone === "string" &&
      /^\+[0-9]{7,15}$/.test(value.phone) &&
      typeof value.code === "string" &&
      /^[A-Z0-9-]{4,16}$/.test(value.code) &&
      sequence !== null
      ? { kind: "pair-code", phone: value.phone, code: value.code, sequence }
      : null;
  return null;
}

export function parseLoginState(input: unknown): LoginView | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!text(value.tool) || !/^[a-z0-9][a-z0-9-]*$/.test(value.tool))
    return null;
  const tool = value.tool;
  switch (value.kind) {
    case "none":
    case "expired":
    case "cancelled":
      return { kind: value.kind, tool };
    // The Team rule stopped the session (Matěj 2026-09-28).
    case "blocked":
      return value.reason === "team-environment" &&
        (value.action === "login" || value.action === "ssh-key")
        ? {
            kind: "blocked",
            tool,
            reason: "team-environment",
            action: value.action,
          }
        : null;
    case "failed":
      return loginFailures.includes(
        value.reason as (typeof loginFailures)[number],
      )
        ? {
            kind: "failed",
            tool,
            reason: value.reason as (typeof loginFailures)[number],
          }
        : null;
    case "signed-in": {
      if (!optionalText(value.account) || !optionalText(value.organization))
        return null;
      if (value.already !== undefined && value.already !== true) return null;
      const ssh = value.ssh === undefined ? undefined : parseSshLink(value.ssh);
      if (ssh === null) return null;
      return {
        kind: "signed-in",
        tool,
        ...(value.account === undefined ? {} : { account: value.account }),
        ...(value.organization === undefined
          ? {}
          : { organization: value.organization }),
        ...(ssh === undefined ? {} : { ssh }),
        ...(value.already === true ? { already: true as const } : {}),
      };
    }
    case "pending": {
      if (
        typeof value.session !== "string" ||
        !/^[0-9a-f]{32}$/.test(value.session) ||
        typeof value.expiresAt !== "string"
      )
        return null;
      const challenge =
        value.challenge === undefined
          ? undefined
          : parseChallenge(value.challenge);
      if (challenge === null) return null;
      if (value.qrSvg !== undefined && typeof value.qrSvg !== "string")
        return null;
      if (value.step !== undefined && value.step !== "ssh-key") return null;
      return {
        kind: "pending",
        tool,
        session: value.session,
        expiresAt: value.expiresAt,
        ...(challenge === undefined ? {} : { challenge }),
        ...(value.step === "ssh-key" ? { step: "ssh-key" as const } : {}),
        ...(typeof value.qrSvg === "string" ? { qrSvg: value.qrSvg } : {}),
      };
    }
    default:
      return null;
  }
}

/** Only an https link on exactly the expected host is shown as a link. */
export function loginLink(value: unknown, host: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === host &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The server's QR drawing becomes an image source only in the exact form
 * the server draws (a white square, one black path of module runs): never
 * markup inserted into the page, and nothing a tool printed. */
export function qrImageSource(svg: string | undefined): string | null {
  if (svg === undefined || svg.length > 200_000) return null;
  const match =
    /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d{2,3}) \1" shape-rendering="crispEdges"><rect width="\1" height="\1" fill="#fff"\/><path fill="#000" d="(?:M\d+ \d+h\d+v1h-\d+z)*"\/><\/svg>$/.exec(
      svg,
    );
  if (match === null) return null;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export type LoginPhase =
  | "confirm"
  | "installing"
  | "waiting"
  | "linking"
  | "signed-in"
  | "failed";

export type LoginStepName =
  | "installing"
  | "waiting"
  | "linking"
  | "signed-in"
  | "linked";

export type LoginStep = Readonly<{
  label: string;
  state: "done" | "current" | "todo" | "failed";
}>;

/** The steps of one flow: installing (only when it installs), waiting for
 * you, linking the SSH key (gh), signed in. "Link SSH key" of a signed-in gh
 * is linking and linked, with waiting for you first when a device code has
 * to widen the sign-in. */
export function loginStepOrder(
  flow: Readonly<{
    mode: "install" | "login" | "ssh";
    tool: string;
    /** "Link SSH key" showed a device code. */
    refresh?: boolean;
  }>,
): readonly LoginStepName[] {
  if (flow.mode === "ssh")
    return flow.refresh === true
      ? ["waiting", "linking", "linked"]
      : ["linking", "linked"];
  return [
    ...(flow.mode === "install" ? (["installing"] as const) : []),
    "waiting",
    ...(flow.tool === "gh" ? (["linking"] as const) : []),
    "signed-in",
  ];
}

/** Each step marked done, in progress, next or did not finish. */
export function loginSteps(
  order: readonly LoginStepName[],
  phase: LoginPhase,
  failedAt: "installing" | "waiting" | "linking",
  copy: Copy,
): readonly LoginStep[] {
  const labels: Record<LoginStepName, string> = {
    installing: copy.toolsStepInstalling,
    waiting: copy.toolsStepWaiting,
    linking: copy.toolsStepLinking,
    "signed-in": copy.toolsStepSignedIn,
    linked: copy.toolsStepLinked,
  };
  const current =
    phase === "confirm"
      ? -1
      : phase === "failed"
        ? order.indexOf(failedAt)
        : phase === "signed-in"
          ? order.length - 1
          : order.indexOf(phase);
  return order.map((step, index) => ({
    label: labels[step],
    state:
      phase === "failed" && index === current
        ? "failed"
        : phase === "signed-in" && index === current
          ? "done"
          : index < current
            ? "done"
            : index === current
              ? "current"
              : "todo",
  }));
}

const sshFailureKeys: Record<SshLinkFailure, MessageKey> = {
  "not-signed-in": "toolsSshFailureNotSignedIn",
  "scope-missing": "toolsSshFailureScopeMissing",
  "keygen-missing": "toolsSshFailureKeygenMissing",
  "keygen-failed": "toolsSshFailureKeygenFailed",
  "key-passphrase": "toolsSshFailureKeyPassphrase",
  "key-incomplete": "toolsSshFailureKeyIncomplete",
  "key-unreadable": "toolsSshFailureKeyUnreadable",
  "key-in-use": "toolsSshFailureKeyInUse",
  "register-failed": "toolsSshFailureRegisterFailed",
  "host-keys-unavailable": "toolsSshFailureHostKeysUnavailable",
  "host-key-mismatch": "toolsSshFailureHostKeyMismatch",
  "known-hosts-failed": "toolsSshFailureKnownHostsFailed",
  "ssh-missing": "toolsSshFailureSshMissing",
  "proof-failed": "toolsSshFailureProofFailed",
  "proof-other-account": "toolsSshFailureProofOtherAccount",
};

/** What a gh sign-in did with the SSH key: linked with the key it uses, or
 * not linked with the reason and the agent as the next step. */
export function sshOutcome(
  state: LoginView,
  copy: Copy,
): Readonly<{ linked: boolean; message: string; detail: string }> | null {
  if (state.kind !== "signed-in" || state.ssh === undefined) return null;
  const account = state.account ?? "gh";
  const ssh = state.ssh;
  if (ssh.state === "linked")
    return {
      linked: true,
      message: fill(copy.toolsSshLinkedDone, { account }),
      detail: fill(
        ssh.key.created ? copy.toolsSshKeyCreated : copy.toolsSshKeyReused,
        { path: ssh.key.path, fingerprint: ssh.key.fingerprint },
      ),
    };
  return {
    linked: false,
    message: fill(copy.toolsSshNotLinkedDone, { account }),
    detail: fill(copy[sshFailureKeys[ssh.reason]], {
      path: ssh.key?.path ?? "~/.ssh",
      account: ssh.provedAs ?? "?",
    }),
  };
}

/** The notice of "Install" on a Team Environment's gh row: what the
 * installation did, and that the Environment works in GitHub through Lazurio
 * for GitHub instead of a sign-in. */
export function teamInstallOutcome(
  input: unknown,
  name: string,
  copy: Copy,
): ToolChangeOutcome {
  const outcome = installOutcome(input, name, copy);
  const detail = outcome.detail === undefined ? {} : { detail: outcome.detail };
  return outcome.ok
    ? {
        kind: "updated",
        reload: false,
        message: `${outcome.message} ${copy.toolsTeamGithub}`,
        ...detail,
      }
    : { kind: "failed", reload: false, message: outcome.message, ...detail };
}

/** What an install answered: whether the sign-in may follow, one plain
 * sentence, and the technical part (where agents look for tools, the
 * platform, the step and its reason) for the Details (Matěj 2026-10-09). */
export function installOutcome(
  input: unknown,
  name: string,
  copy: Copy,
): Readonly<{ ok: boolean; message: string; agent: boolean; detail?: string }> {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (value.kind === "installed")
    return {
      ok: true,
      agent: false,
      message: fill(copy.toolsInstalledNow, {
        name,
        version: typeof value.version === "string" ? value.version : "",
      }).replace("  ", " "),
      ...(value.onPath === false ? { detail: copy.toolsInstallNotOnPath } : {}),
    };
  if (value.kind === "already-installed")
    return {
      ok: true,
      agent: false,
      message: fill(copy.toolsAlreadyInstalled, { name }),
    };
  if (value.kind === "unsupported-platform")
    return {
      ok: false,
      agent: true,
      message: copy.toolsInstallUnsupported,
      detail: fill(copy.toolsInstallUnsupportedDetail, {
        platform: text(value.platform) ? value.platform : "?",
        arch: text(value.arch) ? value.arch : "?",
      }),
    };
  if (value.kind === "install-failed")
    return {
      ok: false,
      agent: true,
      message: copy.toolsInstallFailed,
      detail: fill(copy.toolsInstallFailedDetail, {
        stage: text(value.stage) ? value.stage : "?",
        reason: text(value.reason) ? value.reason : "?",
      }),
    };
  if (value.kind === "blocked" && value.reason === "busy")
    return { ok: false, agent: false, message: copy.toolsInstallBusy };
  return { ok: false, agent: true, message: copy.toolsLoginUnreadable };
}

/** One sentence for a login that ended without a sign-in, and whether the
 * prepared agent prompt is the next step. */
export function loginEndMessage(
  state: LoginView,
  copy: Copy,
): Readonly<{ message: string; agent: boolean; retry: boolean }> {
  if (state.kind === "failed") {
    const reasons: Record<(typeof loginFailures)[number], MessageKey> = {
      "not-installed": "toolsLoginFailureNotInstalled",
      "unexpected-url": "toolsLoginFailureUrl",
      "unexpected-output": "toolsLoginFailureOutput",
      "tool-exit": "toolsLoginFailureExit",
      "not-confirmed": "toolsLoginFailureNotConfirmed",
      "invalid-phone": "toolsLoginPhoneInvalid",
      "spawn-failed": "toolsLoginFailureSpawn",
      "not-signed-in": "toolsLoginFailureNotSignedIn",
      "environment-unreadable": "toolsLoginFailureEnvironment",
      "no-challenge": "toolsLoginFailureNoChallenge",
    };
    return {
      message: copy[reasons[state.reason]],
      agent:
        state.reason !== "invalid-phone" &&
        state.reason !== "not-signed-in" &&
        state.reason !== "environment-unreadable",
      retry: true,
    };
  }
  if (state.kind === "blocked")
    return { message: copy.toolsTeamGithub, agent: false, retry: false };
  if (state.kind === "expired")
    return { message: copy.toolsLoginExpired, agent: false, retry: true };
  return { message: copy.toolsLoginEnded, agent: false, retry: true };
}

/** What the dialog's status line and detail say while a sign-in runs: before
 * the first answer and while the tool has shown nothing to act on, the status
 * names the step and the detail says what happens and for how long at most,
 * never the same sentence twice; with a challenge the status says it waits
 * for you and the challenge is the detail. */
export function loginProgress(
  state: LoginView | null,
  copy: Copy,
): Readonly<{ status: string; detail: string | null }> {
  if (state?.kind === "pending" && state.step === "ssh-key")
    return { status: copy.toolsLoginLinking, detail: null };
  if (state?.kind === "pending" && state.challenge !== undefined)
    return { status: copy.toolsLoginWaiting, detail: null };
  return {
    status: copy.toolsLoginStarting,
    detail: copy.toolsLoginStartingDetail,
  };
}

/** How long the dialog waits for one answer of the Launchpad: longer than
 * the start's own wait for the first challenge (20 s). */
export const loginAnswerMs = 45_000;

/** One request of the dialog, awaited at most `ms`: a request that never
 * settles ends as not answered instead of leaving the dialog waiting. A
 * failed request answers `null`, which no parser accepts. */
export async function answerWithin(
  request: Promise<Readonly<{ value: unknown }>>,
  ms: number,
): Promise<Readonly<{ answered: true; value: unknown } | { answered: false }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ answered: false }>((resolve) => {
    timer = setTimeout(() => resolve({ answered: false }), ms);
  });
  try {
    return await Promise.race([
      request.then(
        ({ value }) => ({ answered: true as const, value }),
        () => ({ answered: true as const, value: null }),
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** "You are signed in to gh as octocat (Org)." */
export function signedInMessage(state: LoginView, copy: Copy): string {
  if (state.kind !== "signed-in") return "";
  // Signed in before this sign-in started (#98): nothing was paired now.
  const already = state.already === true;
  if (state.account === undefined)
    return fill(
      already ? copy.toolsLoginAlreadySignedIn : copy.toolsLoginSignedIn,
      { name: state.tool },
    );
  const account =
    state.organization === undefined
      ? state.account
      : `${state.account} (${state.organization})`;
  return fill(
    already ? copy.toolsLoginAlreadySignedInAs : copy.toolsLoginSignedInAs,
    { name: state.tool, account },
  );
}

export type OrganizationChoice = Readonly<{
  id: string;
  label: string;
  current: boolean;
}>;

/** Composio's organizations for the select, the current one marked. */
export function organizationChoices(
  input: unknown,
  copy: Copy,
): readonly OrganizationChoice[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    value.kind !== "composio-organizations" ||
    !Array.isArray(value.organizations)
  )
    return null;
  const choices: OrganizationChoice[] = [];
  for (const entry of value.organizations) {
    if (!entry || typeof entry !== "object") return null;
    const { id, name, current } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
      !text(name) ||
      typeof current !== "boolean"
    )
      return null;
    choices.push({
      id,
      current,
      label: current ? fill(copy.toolsComposioOrgCurrent, { name }) : name,
    });
  }
  return choices;
}

/** One sentence for what a logout did; the key's fingerprint and the reason
 * of a failure are for the Details (Matěj 2026-10-09). */
export function logoutOutcome(
  input: unknown,
  name: string,
  copy: Copy,
): ToolChangeOutcome {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (value.kind === "logged-out") {
    const removal =
      value.sshKey !== null && typeof value.sshKey === "object"
        ? (value.sshKey as Record<string, unknown>)
        : undefined;
    const print =
      removal !== undefined && fingerprint(removal.fingerprint)
        ? removal.fingerprint
        : null;
    const ssh: Record<string, MessageKey> = {
      removed: "toolsSshRemoved",
      "not-registered": "toolsSshRemovalNotRegistered",
      "no-key": "toolsSshRemovalNoKey",
      "kept-not-lazurio": "toolsSshRemovalKept",
      "not-removed": "toolsSshRemovalFailed",
    };
    const key =
      typeof removal?.state === "string" && Object.hasOwn(ssh, removal.state)
        ? ssh[removal.state]
        : removal === undefined
          ? undefined
          : "toolsSshRemovalFailed";
    return {
      kind: "updated",
      reload: false,
      message: [
        fill(
          value.revocation === "remote"
            ? copy.toolsSignedOutRemote
            : copy.toolsSignedOutLocal,
          { name },
        ),
        ...(key === undefined ? [] : [copy[key]]),
      ].join(" "),
      ...(print === null
        ? {}
        : {
            detail: fill(copy.toolsSshKeyFingerprint, { fingerprint: print }),
          }),
    };
  }
  // A Team Environment signs out only a person's account left there.
  if (value.kind === "blocked" && value.reason === "team-environment")
    return {
      kind: "failed",
      reload: false,
      message: `${copy.toolsTeamGithub} ${copy.toolsTeamGithubLogout}`,
    };
  return {
    kind: "failed",
    reload: false,
    message: fill(copy.toolsSignOutFailed, { name }),
    ...(text(value.reason)
      ? {
          detail: fill(copy.toolsSignOutFailedDetail, { reason: value.reason }),
        }
      : {}),
  };
}
