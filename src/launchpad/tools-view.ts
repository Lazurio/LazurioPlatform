import type { LoginChallenge, LoginState } from "../tools/login";
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

export type CuratedActions = Readonly<{
  /** The flow the main button opens: install first, or sign in only. */
  primary: Readonly<{ mode: "install" | "login"; label: string }> | null;
  /** A signed-in `launchpad` tool offers "Sign out". */
  logout: boolean;
}>;

/** The curated actions of a `launchpad` tool (decision F19): "Install and
 * sign in" when it is missing, "Sign in" when it is installed and not known
 * to be signed in, "Sign out" when it is signed in. An `agent` tool has none;
 * its prepared prompt is the way. */
export function curatedActions(tool: ToolOverview, copy: Copy): CuratedActions {
  if (tool.setup !== "launchpad") return { primary: null, logout: false };
  if (!tool.installed)
    return {
      primary: { mode: "install", label: copy.toolsInstallAction },
      logout: false,
    };
  if (tool.signIn?.state === "signed-in")
    return { primary: null, logout: true };
  return {
    primary: { mode: "login", label: copy.toolsSignInAction },
    logout: false,
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
] as const;

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
    case "signed-in":
      if (!optionalText(value.account) || !optionalText(value.organization))
        return null;
      return {
        kind: "signed-in",
        tool,
        ...(value.account === undefined ? {} : { account: value.account }),
        ...(value.organization === undefined
          ? {}
          : { organization: value.organization }),
      };
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
      return {
        kind: "pending",
        tool,
        session: value.session,
        expiresAt: value.expiresAt,
        ...(challenge === undefined ? {} : { challenge }),
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
  | "signed-in"
  | "failed";

export type LoginStep = Readonly<{
  label: string;
  state: "done" | "current" | "todo" | "failed";
}>;

/** The plain steps of the flow: installing (only when it installs), waiting
 * for you, signed in. */
export function loginSteps(
  install: boolean,
  phase: LoginPhase,
  failedAt: "installing" | "waiting",
  copy: Copy,
): readonly LoginStep[] {
  const order: readonly ("installing" | "waiting" | "signed-in")[] = install
    ? ["installing", "waiting", "signed-in"]
    : ["waiting", "signed-in"];
  const labels = {
    installing: copy.toolsStepInstalling,
    waiting: copy.toolsStepWaiting,
    "signed-in": copy.toolsStepSignedIn,
  };
  const current =
    phase === "confirm"
      ? -1
      : phase === "failed"
        ? order.indexOf(failedAt)
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

/** What an install answered: whether the sign-in may follow, and one
 * sentence. */
export function installOutcome(
  input: unknown,
  name: string,
  copy: Copy,
): Readonly<{ ok: boolean; message: string; agent: boolean }> {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (value.kind === "installed")
    return {
      ok: true,
      agent: false,
      message: [
        fill(copy.toolsInstalledNow, {
          name,
          version: typeof value.version === "string" ? value.version : "",
        }).replace("  ", " "),
        ...(value.onPath === false ? [copy.toolsInstallNotOnPath] : []),
      ].join(" "),
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
      message: fill(copy.toolsInstallUnsupported, {
        platform: text(value.platform) ? value.platform : "?",
        arch: text(value.arch) ? value.arch : "?",
      }),
    };
  if (value.kind === "install-failed")
    return {
      ok: false,
      agent: true,
      message: fill(copy.toolsInstallFailed, {
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
    };
    return {
      message: copy[reasons[state.reason]],
      agent: state.reason !== "invalid-phone",
      retry: true,
    };
  }
  if (state.kind === "expired")
    return { message: copy.toolsLoginExpired, agent: false, retry: true };
  return { message: copy.toolsLoginEnded, agent: false, retry: true };
}

/** "You are signed in to gh as octocat (Org)." */
export function signedInMessage(state: LoginView, copy: Copy): string {
  if (state.kind !== "signed-in") return "";
  if (state.account === undefined)
    return fill(copy.toolsLoginSignedIn, { name: state.tool });
  const account =
    state.organization === undefined
      ? state.account
      : `${state.account} (${state.organization})`;
  return fill(copy.toolsLoginSignedInAs, { name: state.tool, account });
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

/** One sentence for what a logout did. */
export function logoutOutcome(
  input: unknown,
  name: string,
  copy: Copy,
): ToolChangeOutcome {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (value.kind === "logged-out")
    return {
      kind: "updated",
      reload: false,
      message: fill(
        value.revocation === "remote"
          ? copy.toolsSignedOutRemote
          : copy.toolsSignedOutLocal,
        { name },
      ),
    };
  return {
    kind: "failed",
    reload: false,
    message: fill(copy.toolsSignOutFailed, {
      name,
      reason: text(value.reason) ? value.reason : "?",
    }),
  };
}
