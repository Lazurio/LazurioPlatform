import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import type { Writable } from "node:stream";
import {
  type AiProvider,
  type AiServices,
  aiProviders,
  codexDeviceCode,
  codexDevicePage,
  isAiProvider,
} from "./ai";
import { converse, readCodex } from "./ai-probe";
import { activatableTools, findTool, type ToolEntry } from "./catalog";
import { challengeUrl } from "./challenge-url";
import { ghStatus } from "./gh-status";
import { ensureGitIdentity, type GitIdentity } from "./git-identity";
import { plainText } from "./redact";
import {
  createPageCapture,
  loopbackAddress,
  type PageCapture,
  returnsToCli,
  signInCode,
  signInPageHosts,
  signInPageOf,
} from "./sign-in-page";
import {
  ghAccount,
  hasKeyScope,
  linkSshKey,
  machineName,
  removeSshKey,
  type SshContext,
  type SshKeyRemoval,
  type SshLink,
  type SshProofs,
  type SshRunner,
  sshKeyScope,
} from "./ssh-key";
import {
  readSignIn,
  resolveOnPath,
  signInLabel,
  type ToolProcessResult,
  type ToolRunner,
  type ToolSignIn,
} from "./status";

/** The curated sign-in of a `setup: "launchpad"` catalog tool (decision F19),
 * and of the AI CLIs codex and claude (F19's addendum of 2026-10-15). One
 * session per tool at a time, in memory, owned by the process that started
 * it (a `lazurio tools login` command or the Launchpad server). The tool's
 * own sign-in command runs as the current user with a minimal environment;
 * its output is parsed as it arrives and yields a challenge: a URL to open
 * (composio), a device code and its page (gh, and codex by code), a QR
 * payload or a pairing code (wacli), the CLI's own sign-in page (codex,
 * claude). A challenge is sensitive while it is valid: it is returned only
 * to the holder of the session handle and never written to a log, a file,
 * the Folder or an error. The raw output of a tool never leaves this module. */
export type LoginChallenge =
  | Readonly<{ kind: "url"; url: string }>
  | Readonly<{ kind: "device-code"; url: string; code: string }>
  | Readonly<{ kind: "qr"; payload: string; sequence: number }>
  | Readonly<{
      kind: "pair-code";
      phone: string;
      code: string;
      sequence: number;
    }>
  /** codex and claude: the CLI's sign-in page. `view`: where the
   * Environment browser shows it (a Remote Environment); `url`: the page
   * itself, which the CLI opened in the computer's own browser already (a
   * workstation), for a person whose browser did not open. `code`: the page
   * ends on a code the CLI waits for (Claude Code's code page), which the
   * holder hands over with `code`. */
  | Readonly<{ kind: "page"; view?: string; url?: string; code: boolean }>;

export type LoginState =
  | Readonly<{ kind: "none"; tool: string }>
  | Readonly<{
      kind: "pending";
      tool: string;
      /** The handle of the session: poll and cancel name it. */
      session: string;
      challenge?: LoginChallenge;
      /** gh only: signed in, the SSH key of this Machine is being linked.
       * codex and claude: signed in, the running services are asked to read
       * the new sign-in. */
      step?: "ssh-key" | "services";
      /** ISO time after which the session ends as `expired`. */
      expiresAt: string;
    }>
  | Readonly<{
      kind: "signed-in";
      tool: string;
      account?: string;
      organization?: string;
      /** gh only: whether `git clone git@github.com:…` works as `account`
       * (decision F19, addendum 2026-09-28). A gh sign-in always says it. */
      ssh?: SshLink;
      /** gh only: the person's Git identity (`user.name`, `user.email`),
       * found, set from the signed-in GitHub account where it was missing,
       * or not set with its reason (decision F19, addendum 2026-10-14). */
      gitIdentity?: GitIdentity;
      /** The tool was signed in before this session: it connected without
       * showing a challenge, and its probe confirmed it (#98). */
      already?: true;
      /** codex and claude: what became of the running services that read
       * the sign-in (root decision 0201 point 4). */
      services?: AiServices;
    }>
  | Readonly<{ kind: "failed"; tool: string; reason: LoginFailure }>
  /** codex and claude, refused before anything ran: a Remote Environment
   * without its Environment browser, where the page could not return to the
   * CLI; or an Organization that provides the AI here (Codex's provider
   * needs no sign-in, root decision 0201 points 4 and 6). */
  | Readonly<{
      kind: "blocked";
      tool: string;
      reason: "no-environment-browser" | "organization-provided";
    }>
  /** gh on a Team Environment (Matěj 2026-09-28): the Environment became
   * a Team one while the session ran, so it stopped before the next step
   * that changes the account or the Machine. */
  | Readonly<{
      kind: "blocked";
      tool: string;
      reason: "team-environment";
      action: "login" | "ssh-key";
    }>
  | Readonly<{ kind: "expired"; tool: string }>
  | Readonly<{ kind: "cancelled"; tool: string }>;

export type SignedInState = Extract<LoginState, { kind: "signed-in" }>;

export type LoginFailure =
  | "not-installed"
  | "unexpected-url"
  | "unexpected-output"
  | "tool-exit"
  | "not-confirmed"
  | "invalid-phone"
  | "spawn-failed"
  | "not-signed-in"
  /** The kind of Environment could not be read before a step that changes
   * the account or the Machine, so the session stopped (fail closed). */
  | "environment-unreadable"
  /** The tool ran but showed no challenge (link, code, QR or pairing code)
   * within the bound, so the session stopped and its process was killed. */
  | "no-challenge"
  /** codex and claude: the Environment browser did not open the sign-in
   * page, so the CLI was stopped. */
  | "browser-unavailable"
  /** codex: Codex did not answer whether the Organization provides the AI
   * here, so the sign-in did not start (fail closed). */
  | "provider-unknown";

/** One line of the owner's journal about a curated sign-in: the tool and the
 * outcome, never the tool's output, a challenge or an account. */
export type LoginJournalEntry =
  | Readonly<{ tool: string; event: "start" }>
  | Readonly<{
      tool: string;
      event: "end";
      outcome: "signed-in" | "failed" | "blocked" | "expired" | "cancelled";
      reason?: string;
    }>;

export type LogoutResult =
  | Readonly<{
      kind: "logged-out";
      tool: string;
      /** gh and composio forget the sign-in on this Machine only; wacli
       * unlinks the device at WhatsApp. */
      revocation: "local-only" | "remote";
      /** gh only: what happened to this Machine's SSH key on the account. */
      sshKey?: SshKeyRemoval;
    }>
  | Readonly<{
      kind: "logout-failed";
      tool: string;
      reason: "not-installed" | "tool-exit" | "still-signed-in";
    }>;

export type ComposioOrganization = Readonly<{
  id: string;
  name: string;
  current: boolean;
  /** When Composio created it (ISO 8601), where the CLI prints it: Lazurio's
   * build from 0.4.3-lazurio.3 on (decision F42, addendum of 2026-10-26). */
  createdAt?: string;
}>;
export type ComposioOrganizationsResult =
  | Readonly<{
      kind: "composio-organizations";
      organizations: readonly ComposioOrganization[];
    }>
  | Readonly<{
      kind: "composio-organizations-failed";
      reason: "not-installed" | "not-signed-in" | "tool-exit" | "unreadable";
    }>;
export type ComposioSelectResult =
  | Readonly<{
      kind: "composio-organization-selected";
      id: string;
      organization?: string;
    }>
  | Readonly<{
      kind: "composio-organization-failed";
      reason:
        | "not-installed"
        | "unknown-organization"
        | "tool-exit"
        | "unreadable";
    }>;

/** Where the sign-in page of codex and claude opens (F19's addendum of
 * 2026-10-15). */
export type SignInPage =
  /** The computer's own browser, which the CLI opens itself (a workstation):
   * nothing is set for it. */
  | Readonly<{ kind: "own" }>
  /** A Remote Environment without its Environment browser: the page could
   * not return to the CLI there, so the sign-in does not start. */
  | Readonly<{ kind: "none" }>
  /** The Environment browser: the page the CLI would open is taken from it
   * and `open` opens it there, answering the address where the person sees
   * it, or null when it could not open it now. */
  | Readonly<{
      kind: "environment";
      open: (url: string) => Promise<Readonly<{ view: string }> | null>;
    }>;

export type LoginEnvironment = Readonly<{
  path: string | undefined;
  home: string | undefined;
  xdg?: Readonly<Record<string, string>> | undefined;
  platform: string;
  run: ToolRunner;
  /** codex and claude: where the sign-in page opens. Absent: the
   * computer's own browser. */
  signInPage?: SignInPage;
  /** codex and claude, after the CLI's status confirmed the sign-in: what
   * makes the running services read it again (root decision 0201 point 4),
   * given every AI CLI signed in now. Absent: nothing is asked. */
  reload?: (
    tool: AiProvider,
    signedIn: readonly AiProvider[],
  ) => Promise<AiServices>;
  /** Test seams. `codex-device`: codex's sign-in by code. */
  now?: () => number;
  lifetimes?: Partial<
    Record<"gh" | "composio" | "wacli" | AiProvider | "codex-device", number>
  >;
  /** codex and claude on a Remote Environment: how long the sign-in waits
   * for the CLI to hand over the page it opens, once it printed one that
   * does not return to it, before it opens the printed one (default 3 s). */
  pageGraceMs?: number;
  /** How long `start` waits for the first challenge. */
  firstChallengeMs?: number;
  /** How long a sign-in may run without showing its first challenge before
   * it fails as `no-challenge` (default one minute). */
  challengeMs?: number;
  /** How long after `connected` without a challenge the probe may take to
   * confirm before the sign-in fails as `not-confirmed` (default 20 s). */
  connectedMs?: number;
  /** Where the owner journals the start and the end of each sign-in (the
   * Launchpad: its unit's journal). Absent: nothing is journaled. */
  journal?: (entry: LoginJournalEntry) => void;
  /** Each sign-in that ends signed in, once, as it ends: with nobody
   * polling it too, and before its holder can read the outcome (the
   * Launchpad turns the tool's "Používají agenti" on there, decision F19's
   * addendum of 2026-10-28). Absent: nothing follows. */
  afterSignIn?: (outcome: SignedInState) => void;
  probeIntervalMs?: number;
  /** How long wacli's bootstrap sync may run on after pairing. */
  backgroundMs?: number;
  /** The Machine's name in the title of its SSH key (default: the system's
   * host name). */
  machine?: string;
  /** The Team rule of `team-github.ts`, asked again before every step of a
   * gh session that changes the account or the Machine: the end of the
   * device flow, the start of the SSH key linking, each of its writing
   * sub-steps and the final "signed in". True: refused now. Absent: nothing
   * to re-check (a workstation). */
  refused?: (tool: string, action: "login" | "ssh-key") => Promise<boolean>;
  /** The SSH proofs the status of this process keeps (decision F19,
   * addendum 2026-10-19): a gh sign-in or sign-out that starts forgets them,
   * and a link keeps what it proved, so the reading after it does not prove
   * again. Absent: nothing is kept (the CLI). */
  sshProofs?: SshProofs | undefined;
}>;

// The lifetimes of the documented flows: a GitHub device code is valid for
// 15 minutes, a pending Composio login for 10, and WhatsApp pairing gets 5.
// The AI CLIs wait on localhost for as long as they run; their sign-in gets
// 10 minutes, as long as the Environment browser keeps a tab nobody views.
// Codex's code for its sign-in by code is valid for 15 minutes, after which
// Codex stops waiting for it.
const defaultLifetimes = {
  gh: 15 * 60_000,
  composio: 10 * 60_000,
  wacli: 5 * 60_000,
  codex: 10 * 60_000,
  claude: 10 * 60_000,
  "codex-device": 15 * 60_000,
};
// A tool that shows nothing to act on for a minute is not starting its
// sign-in: gh prints its code and composio its link at once, and wacli's
// first QR code follows its connection to WhatsApp within seconds.
const defaultChallengeMs = 60_000;
// After wacli's `connected` without a code, its probe has this long to
// confirm the sign-in (retried every 2 s), within the minute above.
const defaultConnectedMs = 20_000;
const probeTimeoutMs = 10_000;
// Linking the SSH key after the sign-in: every step is bounded by 30 s.
const sshLinkMs = 5 * 60_000;
// The services after an AI sign-in: a unit restart and T3 Code's refresh,
// whose own bound is a minute.
const servicesMs = 3 * 60_000;
// Codex's `account/read` before codex signs in, bounded as GET /api/ai is.
const providerReadMs = 10_000;
const defaultPageGraceMs = 3_000;
const maxCollected = 1024 * 1024;
const maxLine = 16 * 1024;
const maxPendingOutput = 4 * 1024 * 1024;

const ghDevicePage = "https://github.com/login/device";

/** The tools with a curated sign-in: the `launchpad` ones, and the AI CLIs
 * (F19's addendum of 2026-10-15), which are no agent tools of the Folder. */
export function loginTool(name: string): ToolEntry | undefined {
  if (isAiProvider(name)) return findTool(name);
  const entry = activatableTools().find((tool) => tool.name === name);
  return entry?.activation.setup === "launchpad" &&
    ["gh", "composio", "wacli"].includes(name)
    ? entry
    : undefined;
}

/** An international phone number as wacli takes it: `+` and 7 to 15 digits,
 * spaces, dots, dashes and parentheses tolerated in what the operator typed. */
export function normalizePhone(input: string): string | undefined {
  const compact = input.trim().replace(/[\s().-]/g, "");
  return /^\+?[1-9][0-9]{6,14}$/.test(compact)
    ? `+${compact.replace(/^\+/, "")}`
    : undefined;
}

// Only an https URL on exactly the expected host becomes a challenge.
export { challengeUrl };

type Streamed = Readonly<{
  child: ChildProcess;
  exited: Promise<number>;
  kill: () => void;
}>;

// One tool process in its own process group, so a cancel, an expiry or a
// shutdown kills its helpers too. Its input is a pipe only where the sign-in
// hands it something (claude's code); otherwise it reads nothing.
function spawnGroup(
  command: readonly string[],
  env: Readonly<Record<string, string>>,
  input = false,
): Streamed {
  const [executable, ...args] = command;
  if (!executable) throw new Error("A command is required");
  const child = spawn(executable, args, {
    env: { ...env },
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {}
    }
    child.kill("SIGKILL");
  };
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });
  // A process that ends without reading its input closes the pipe.
  child.stdin?.on("error", () => undefined);
  return { child, exited, kill };
}

// A tool process whose output is read line by line as it arrives.
function spawnLines(
  command: readonly string[],
  env: Readonly<Record<string, string>>,
  onLine: (line: string) => void,
  input = false,
): Streamed {
  const streamed = spawnGroup(command, env, input);
  for (const stream of [streamed.child.stdout, streamed.child.stderr]) {
    let buffer = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      // An endless line is not a line any flow expects.
      if (buffer.length > maxLine) buffer = "";
    });
    stream?.on("end", () => {
      if (buffer.length > 0) onLine(buffer);
      buffer = "";
    });
  }
  return streamed;
}

// A tool process whose whole output is kept, bounded, for a parser that
// reads it at the end (JSON of the GitHub API, the SSH greeting).
function spawnCollected(
  command: readonly string[],
  env: Readonly<Record<string, string>>,
): Streamed & { result: Promise<ToolProcessResult> } {
  const streamed = spawnGroup(command, env);
  const collect = (stream: NodeJS.ReadableStream | null) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      let length = 0;
      if (stream === null) return resolve("");
      stream.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > maxCollected) streamed.kill();
        else chunks.push(chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", () => resolve(""));
    });
  const stdout = collect(streamed.child.stdout);
  const stderr = collect(streamed.child.stderr);
  const result = (async () => {
    const exitCode = await streamed.exited;
    return Object.freeze({
      exitCode,
      stdout: await stdout,
      stderr: await stderr,
    });
  })();
  return { ...streamed, result };
}

type Terminal = Extract<
  LoginState,
  { kind: "signed-in" | "failed" | "blocked" | "expired" | "cancelled" }
>;

type Session = {
  id: string;
  tool: string;
  /** gh: a sign-in or the linking of the SSH key of a signed-in gh. */
  action: "login" | "ssh-key";
  expiresAt: number;
  challenge?: LoginChallenge;
  /** A challenge was shown at least once. */
  challenged: boolean;
  /** wacli reported `connected`: the probe decides from here, bounded. */
  connected?: boolean;
  step?: "ssh-key" | "services";
  /** claude: the CLI's input, where a code from its code page goes. */
  input?: Writable;
  /** codex and claude on a Remote Environment: the stand-in for a browser
   * that hands the CLI's page to this session. */
  capture?: PageCapture;
  processes: Set<Streamed>;
  timers: Set<ReturnType<typeof setTimeout>>;
  finished?: Terminal;
  waiters: Set<() => void>;
  sequence: number;
  probing: boolean;
  pendingBytes: number;
};

export function createLoginSessions(environment: LoginEnvironment) {
  const now = environment.now ?? Date.now;
  const lifetimes = { ...defaultLifetimes, ...environment.lifetimes };
  const sessions = new Map<string, Session>();
  // A finished session is kept for its holder's next poll, then dropped.
  const finished = new Map<string, Session>();
  // wacli's bootstrap sync after pairing, left to its own idle exit.
  const background = new Set<Streamed>();
  // The removal of an AI sign-in's private directory, until it is done.
  const cleanups = new Set<Promise<void>>();
  let closed = false;

  // The AI CLIs also get the account's name: Claude Code finds its sign-in
  // in the macOS keychain by it (without it, it answers signed out).
  const processEnv = (tool?: string): Record<string, string> => {
    const env: Record<string, string> = { NO_COLOR: "1" };
    if (environment.path) env.PATH = environment.path;
    if (environment.home) env.HOME = environment.home;
    for (const [name, value] of Object.entries(environment.xdg ?? {}))
      if (/^XDG_[A-Z_]+$/.test(name) && value) env[name] = value;
    if (tool !== undefined && isAiProvider(tool))
      try {
        const { username } = userInfo();
        env.USER = username;
        env.LOGNAME = username;
      } catch {}
    return env;
  };
  const probeEnv = (tool?: string): Record<string, string> => {
    const { NO_COLOR: _, ...env } = processEnv(tool);
    return env;
  };
  const locate = (entry: ToolEntry) =>
    resolveOnPath(entry.command, environment.path, environment.platform);

  async function probe(entry: ToolEntry, path: string): Promise<ToolSignIn> {
    const signInProbe = entry.signInProbe;
    if (signInProbe === undefined) return { state: "unknown" };
    // gh: the JSON status first (gh-status.ts), with the kind of identity.
    if (entry.name === "gh")
      return (
        await ghStatus(
          (command, timeoutMs) =>
            environment.run(command, timeoutMs, probeEnv()),
          path,
          probeTimeoutMs,
        )
      ).signIn;
    try {
      return readSignIn(
        signInProbe,
        await environment.run(
          [path, ...signInProbe.argv],
          probeTimeoutMs,
          probeEnv(entry.name),
        ),
      );
    } catch {
      return { state: "unknown" };
    }
  }

  // The journal names the tool and the outcome only: a challenge, an account
  // or anything the tool printed never reaches it.
  const journal = (entry: LoginJournalEntry) => {
    try {
      environment.journal?.(entry);
    } catch {}
  };
  const ended = (tool: string, outcome: Terminal) =>
    journal({
      tool,
      event: "end",
      outcome: outcome.kind,
      ...(outcome.kind === "failed" || outcome.kind === "blocked"
        ? { reason: outcome.reason }
        : {}),
    });
  // What follows a sign-in is its owner's; it never changes the outcome.
  const followed = (outcome: Terminal) => {
    if (outcome.kind !== "signed-in") return;
    try {
      environment.afterSignIn?.(outcome);
    } catch {}
  };

  const notify = (session: Session) => {
    session.sequence++;
    for (const waiter of session.waiters) waiter();
    session.waiters.clear();
  };
  const current = (session: Session) =>
    sessions.get(session.tool) === session && session.finished === undefined;

  // Ends a session: its processes (unless one is handed to the background),
  // its timers and its challenge go; the holder reads the outcome once.
  function finish(session: Session, outcome: Terminal, keep?: Streamed) {
    if (session.finished !== undefined) return;
    session.finished = outcome;
    delete session.challenge;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    for (const running of session.processes)
      if (running !== keep) running.kill();
    session.processes.clear();
    session.input?.destroy();
    delete session.input;
    if (session.capture !== undefined) {
      const removed = session.capture.close().catch(() => undefined);
      cleanups.add(removed);
      void removed.then(() => cleanups.delete(removed));
      delete session.capture;
    }
    if (sessions.get(session.tool) === session) sessions.delete(session.tool);
    if (outcome.kind !== "cancelled") finished.set(session.tool, session);
    ended(session.tool, outcome);
    followed(outcome);
    notify(session);
  }
  const fail = (session: Session, reason: LoginFailure) =>
    finish(session, { kind: "failed", tool: session.tool, reason });
  const block = (session: Session) =>
    finish(session, {
      kind: "blocked",
      tool: session.tool,
      reason: "team-environment",
      action: session.action,
    });
  // The Team rule asked again before a step that changes the account or the
  // Machine: false when the session ended, is refused now (it ends as
  // `blocked`) or the kind of Environment could not be read (it fails).
  async function mayProceed(session: Session): Promise<boolean> {
    if (!current(session)) return false;
    if (environment.refused === undefined) return true;
    let refused: boolean;
    try {
      refused = await environment.refused(session.tool, session.action);
    } catch {
      if (current(session)) fail(session, "environment-unreadable");
      return false;
    }
    if (!current(session)) return false;
    if (refused) {
      block(session);
      return false;
    }
    return true;
  }
  const setChallenge = (session: Session, challenge: LoginChallenge) => {
    if (!current(session)) return;
    session.challenge = challenge;
    session.challenged = true;
    notify(session);
  };
  const later = (session: Session, ms: number, action: () => void) => {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      action();
    }, ms);
    session.timers.add(timer);
  };
  // Pending output is bounded; once signed in, the output is drained unread.
  const counted =
    (session: Session, handle: (line: string) => void) => (raw: string) => {
      if (!current(session)) return;
      session.pendingBytes += raw.length + 1;
      if (session.pendingBytes > maxPendingOutput) {
        fail(session, "unexpected-output");
        return;
      }
      handle(plainText(raw).trim());
    };

  // "signed-in" when the probe confirmed it and the session ended so;
  // "gone" when the session ended meanwhile for another reason.
  async function confirm(
    session: Session,
    entry: ToolEntry,
    path: string,
    keep?: Streamed,
  ): Promise<"signed-in" | "not-yet" | "gone"> {
    const signIn = await probe(entry, path);
    if (!current(session)) return "gone";
    if (signIn.state !== "signed-in") return "not-yet";
    finish(
      session,
      {
        kind: "signed-in",
        tool: session.tool,
        ...(signIn.account === undefined ? {} : { account: signIn.account }),
        ...(signIn.organization === undefined
          ? {}
          : { organization: signIn.organization }),
        ...(session.challenged ? {} : { already: true as const }),
      },
      keep,
    );
    return "signed-in";
  }

  function track(session: Session, child: Streamed) {
    session.processes.add(child);
  }

  // gh's device flow (`auth login` or `auth refresh`): the one-time code and
  // the device page become the challenge. `--clipboard=false` keeps the code
  // out of the clipboard for this invocation whatever the operator
  // configured; a gh older than the flag (added in 2025) never copies the
  // code and refuses the flag: then the flow runs once more without it.
  // Without a terminal gh prints the code and the page instead of waiting for
  // Enter. The exit code, or undefined when the session ended meanwhile.
  async function ghDeviceFlow(
    session: Session,
    command: readonly string[],
  ): Promise<number | undefined> {
    for (const clipboardFlag of [true, false]) {
      let code: string | undefined;
      let url: string | undefined;
      let unknownFlag = false;
      const child = spawnLines(
        [...command, ...(clipboardFlag ? ["--clipboard=false"] : [])],
        processEnv(),
        counted(session, (line) => {
          if (/unknown flag: --clipboard/.test(line)) unknownFlag = true;
          // Only the lines before the challenge are read for it; what gh
          // prints afterwards is not a sign-in page.
          if (session.challenge !== undefined) return;
          const codeMatch =
            /one-time code(?:\s*\(([A-Z0-9]{4}-[A-Z0-9]{4})\)|:\s*([A-Z0-9]{4}-[A-Z0-9]{4}))/i.exec(
              line,
            );
          if (codeMatch) code = (codeMatch[1] ?? codeMatch[2])?.toUpperCase();
          const urlMatch = /https?:\/\/[^\s"'<>]+/.exec(line);
          if (urlMatch) {
            const accepted = challengeUrl(
              urlMatch[0].replace(/[.,;:!?)]+$/, ""),
              ["github.com"],
            );
            if (accepted === undefined || accepted !== ghDevicePage) {
              fail(session, "unexpected-url");
              return;
            }
            url = accepted;
          }
          if (code !== undefined && url !== undefined)
            setChallenge(session, { kind: "device-code", url, code });
        }),
      );
      track(session, child);
      const exitCode = await child.exited;
      if (!current(session)) return undefined;
      session.processes.delete(child);
      if (exitCode !== 0 && unknownFlag && clipboardFlag) {
        session.pendingBytes = 0;
        continue;
      }
      return exitCode;
    }
    return undefined;
  }

  // A process of the session with its whole output: a cancel, an expiry or a
  // shutdown kills it like every other one.
  const sessionRunner =
    (session: Session): SshRunner =>
    async (command, timeoutMs) => {
      if (!current(session)) throw new Error("The session has ended");
      const child = spawnCollected(command, probeEnv());
      track(session, child);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      try {
        const result = await Promise.race([child.result, expired]);
        if (result === "timeout") child.kill();
        return result;
      } finally {
        if (timer) clearTimeout(timer);
        session.processes.delete(child);
      }
    };

  async function sshContext(session: Session, gh: string): Promise<SshContext> {
    const [keygen, ssh] = await Promise.all([
      resolveOnPath("ssh-keygen", environment.path, environment.platform),
      resolveOnPath("ssh", environment.path, environment.platform),
    ]);
    return {
      home: environment.home ?? "",
      gh,
      keygen,
      ssh,
      run: sessionRunner(session),
      alive: () => current(session),
      proceed: () => mayProceed(session),
      machine: environment.machine ?? machineName(),
    };
  }

  // Steps 2 to 5 of the gh sign-in (decision F19, addendum 2026-09-28): the
  // session says "linking the SSH key", then ends signed in with the SSH
  // outcome, linked or not with its reason.
  async function linkAndFinish(
    session: Session,
    gh: string,
    signedIn: Readonly<{
      account: string;
      scopes: readonly string[] | undefined;
    }>,
  ) {
    // Before the linking starts.
    if (!(await mayProceed(session))) return;
    delete session.challenge;
    session.step = "ssh-key";
    session.expiresAt = now() + sshLinkMs;
    notify(session);
    const ssh: SshLink | "gone" =
      environment.home === undefined
        ? { state: "not-linked", reason: "keygen-failed", fallback: "agent" }
        : !hasKeyScope(signedIn.scopes)
          ? { state: "not-linked", reason: "scope-missing", fallback: "agent" }
          : await linkSshKey(await sshContext(session, gh), signedIn.account);
    if (ssh === "gone" || !current(session)) return;
    // The status of this process reads what the link proved.
    if (ssh.state === "linked")
      environment.sshProofs?.passed(ssh.key.fingerprint, signedIn.account);
    else environment.sshProofs?.forget();
    // The person's Git identity where git has none (decision F19, addendum
    // 2026-10-14), whatever became of the key: commits need it either way.
    // It asks the Team rule again right before it writes.
    const gitIdentity = await ensureGitIdentity({
      git: await resolveOnPath("git", environment.path, environment.platform),
      gh,
      account: signedIn.account,
      run: sessionRunner(session),
      proceed: () => mayProceed(session),
    }).catch(
      (): GitIdentity => ({ state: "not-set", reason: "config-unreadable" }),
    );
    if (gitIdentity === "gone" || !current(session)) return;
    // Before the final "signed in".
    if (!(await mayProceed(session))) return;
    finish(session, {
      kind: "signed-in",
      tool: session.tool,
      account: signedIn.account,
      ssh,
      gitIdentity,
    });
  }

  async function startGh(session: Session, entry: ToolEntry, path: string) {
    // The documented device flow with the key scope in the same code, so the
    // operator enters one code and gh may register the Machine's key.
    const exitCode = await ghDeviceFlow(session, [
      path,
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "ssh",
      "--web",
      "--scopes",
      sshKeyScope,
    ]);
    if (exitCode === undefined || !current(session)) return;
    if (exitCode !== 0) return fail(session, "tool-exit");
    // Before the login is completed.
    if (!(await mayProceed(session))) return;
    const signIn = await probe(entry, path);
    if (!current(session)) return;
    if (signIn.state !== "signed-in") return fail(session, "not-confirmed");
    const signedIn = await ghAccount(sessionRunner(session), path).catch(
      () => undefined,
    );
    if (!current(session)) return;
    if (signedIn === undefined) return fail(session, "not-confirmed");
    await linkAndFinish(session, path, signedIn);
  }

  // "Link SSH key" for a gh that is signed in already: steps 2 to 5, after a
  // scope refresh through the same kind of device-code session when the
  // token cannot manage the account's keys (a gh signed in by hand).
  async function startGhLink(session: Session, path: string) {
    const run = sessionRunner(session);
    let signedIn = await ghAccount(run, path).catch(() => undefined);
    if (!current(session)) return;
    if (signedIn === undefined) return fail(session, "not-signed-in");
    if (!hasKeyScope(signedIn.scopes)) {
      // A scope refresh changes the account's token.
      if (!(await mayProceed(session))) return;
      const exitCode = await ghDeviceFlow(session, [
        path,
        "auth",
        "refresh",
        "--hostname",
        "github.com",
        "--scopes",
        sshKeyScope,
      ]);
      if (exitCode === undefined || !current(session)) return;
      if (!(await mayProceed(session))) return;
      if (exitCode === 0)
        signedIn =
          (await ghAccount(run, path).catch(() => undefined)) ?? signedIn;
      if (!current(session)) return;
    }
    await linkAndFinish(session, path, signedIn);
  }

  async function startComposio(
    session: Session,
    entry: ToolEntry,
    path: string,
  ) {
    // Step one prints the login URL and records a pending login in the
    // tool's own store; `--no-skill-install` keeps agent plugins out.
    // It runs as a process of the session, so a cancel, an expiry or a
    // shutdown ends it like every other one.
    const output: string[] = [];
    const first = spawnLines(
      [path, "login", "--no-wait", "--no-skill-install"],
      processEnv(),
      counted(session, (line) => {
        output.push(line);
      }),
    );
    track(session, first);
    let answered = false;
    later(session, 30_000, () => {
      if (!answered) fail(session, "tool-exit");
    });
    const firstExit = await first.exited;
    answered = true;
    if (!current(session)) return;
    session.processes.delete(first);
    if (firstExit !== 0) return fail(session, "tool-exit");
    const candidate = /https?:\/\/[^\s"'<>]+/.exec(output.join("\n"))?.[0];
    const url =
      candidate === undefined
        ? undefined
        : challengeUrl(candidate, ["dashboard.composio.dev"]);
    if (url === undefined)
      return fail(
        session,
        candidate === undefined ? "unexpected-output" : "unexpected-url",
      );
    session.expiresAt = now() + lifetimes.composio;
    setChallenge(session, { kind: "url", url });
    // Step two completes the pending login once the operator signed in.
    const child = spawnLines(
      [path, "login", "--poll", "--no-skill-install"],
      processEnv(),
      counted(session, () => undefined),
    );
    track(session, child);
    const exitCode = await child.exited;
    if (!current(session)) return;
    if (exitCode !== 0) return fail(session, "tool-exit");
    if ((await confirm(session, entry, path)) === "not-yet")
      fail(session, "not-confirmed");
  }

  async function startWacli(
    session: Session,
    entry: ToolEntry,
    path: string,
    phone: string | undefined,
  ) {
    let sequence = 0;
    let signedIn = false;
    // `--events` gives NDJSON on stderr with the raw QR payload and the
    // pairing code; after pairing the same process runs the bootstrap sync
    // until it is idle for 30 s.
    const child = spawnLines(
      [
        path,
        "auth",
        "--events",
        "--idle-exit",
        "30s",
        ...(phone === undefined ? [] : ["--phone", phone]),
      ],
      processEnv(),
      counted(session, (line) => {
        if (!line.startsWith("{")) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event === null || typeof event !== "object") return;
        const name = (event as { event?: unknown }).event;
        const data = (event as { data?: unknown }).data;
        const field = (key: string) =>
          data !== null && typeof data === "object" && Object.hasOwn(data, key)
            ? (data as Record<string, unknown>)[key]
            : undefined;
        if (name === "qr_code") {
          const payload = field("code");
          if (
            typeof payload !== "string" ||
            payload.length === 0 ||
            payload.length > 1024 ||
            !/^[\x21-\x7e]+$/.test(payload)
          )
            return fail(session, "unexpected-output");
          sequence++;
          setChallenge(session, { kind: "qr", payload, sequence });
        } else if (name === "pair_code") {
          const code = field("code");
          const paired = field("phone");
          if (
            typeof code !== "string" ||
            !/^[A-Z0-9-]{4,16}$/i.test(code) ||
            typeof paired !== "string" ||
            !/^\+?[0-9]{7,15}$/.test(paired)
          )
            return fail(session, "unexpected-output");
          sequence++;
          setChallenge(session, {
            kind: "pair-code",
            phone: paired.startsWith("+") ? paired : `+${paired}`,
            code: code.toUpperCase(),
            sequence,
          });
        } else if (name === "connected") {
          // Connected without a code first: wacli was signed in already
          // (#98), which only the probe confirms; after a code: paired now.
          // Unconfirmed and still without a code, the session ends as
          // not-confirmed a bounded time after the first `connected`.
          if (session.connected !== true && !session.challenged)
            later(
              session,
              environment.connectedMs ?? defaultConnectedMs,
              () => {
                if (current(session) && !session.challenged)
                  fail(session, "not-confirmed");
              },
            );
          session.connected = true;
          void check();
        }
      }),
    );
    track(session, child);
    // Paired means: the read-only status probe says authenticated. It runs
    // while a challenge is shown or after `connected`, one at a time.
    const check = async () => {
      if (session.probing || !current(session) || signedIn) return;
      session.probing = true;
      try {
        signedIn = (await confirm(session, entry, path, child)) === "signed-in";
      } finally {
        session.probing = false;
      }
      if (signedIn) handOff();
    };
    const tick = () => {
      if (!current(session)) return;
      if (session.challenge !== undefined || session.connected === true)
        void check();
      later(session, environment.probeIntervalMs ?? 2_000, tick);
    };
    later(session, environment.probeIntervalMs ?? 2_000, tick);
    // After pairing the process finishes its bootstrap sync on its own,
    // bounded; a shutdown of the owner kills it.
    const handOff = () => {
      background.add(child);
      const timer = setTimeout(
        () => child.kill(),
        environment.backgroundMs ?? 30 * 60_000,
      );
      void child.exited.then(() => {
        clearTimeout(timer);
        background.delete(child);
      });
    };
    const exitCode = await child.exited;
    if (!current(session) || signedIn) return;
    // The process ended before a probe saw the pairing: ask once more.
    if ((await confirm(session, entry, path)) !== "not-yet") return;
    if (current(session))
      fail(session, exitCode === 0 ? "not-confirmed" : "tool-exit");
  }

  // The AI CLIs signed in now: `tool`, which its status just confirmed, and
  // every other one whose own status says so. What T3 Code is asked to turn
  // on (root decision 0201 point 3).
  async function aiSignedIn(tool: AiProvider): Promise<AiProvider[]> {
    const others = await Promise.all(
      aiProviders
        .filter((other) => other !== tool)
        .map(async (other) => {
          const entry = loginTool(other);
          const path = entry && (await locate(entry));
          return entry !== undefined &&
            path !== undefined &&
            (await probe(entry, path)).state === "signed-in"
            ? other
            : undefined;
        }),
    );
    return aiProviders.filter(
      (candidate) => candidate === tool || others.includes(candidate),
    );
  }

  // codex and claude (F19's addendum of 2026-10-15): the CLI's own browser
  // sign-in (`codex login`, `claude auth login`), the default; codex's
  // sign-in by code is `startCodexByCode`. On a Remote Environment
  // `BROWSER` is a private stand-in that hands the page the CLI opens to
  // this session, which opens it in the Environment browser: the page
  // returns to the CLI on 127.0.0.1 inside the Environment. A CLI that hands
  // over nothing within a moment of printing a page that does not return to
  // it (Claude Code's code page) gets the printed one opened, and its code
  // taken over `code`. On a workstation nothing is set: the CLI opens the
  // computer's own browser and the printed page is offered beside it. Signed
  // in is what the CLI's own status confirms after it ended; then the running
  // services are asked to read the sign-in (`aiSignInEnd`).
  async function startAi(
    session: Session,
    entry: ToolEntry,
    path: string,
    tool: AiProvider,
  ) {
    const page = environment.signInPage ?? ({ kind: "own" } as const);
    const capture =
      page.kind === "environment" ? await createPageCapture() : undefined;
    if (capture !== undefined) {
      if (!current(session)) {
        await capture.close();
        return;
      }
      session.capture = capture;
    }
    const env = processEnv(tool);
    if (capture !== undefined) env.BROWSER = capture.browser;
    const grace = environment.pageGraceMs ?? defaultPageGraceMs;
    let printed: string | undefined;
    let printedAt = 0;
    let deciding = false;
    let opening = false;
    // The page to open in the Environment browser: the one the CLI handed
    // over, else the printed one once it returns to the CLI or the grace is
    // over. Each address must be an official sign-in page.
    const decide = async () => {
      if (
        page.kind !== "environment" ||
        capture === undefined ||
        deciding ||
        opening ||
        !current(session)
      )
        return;
      deciding = true;
      try {
        let chosen: string | undefined;
        for (const candidate of await capture.pages()) {
          const accepted = signInPageOf(tool, candidate);
          if (accepted === undefined) {
            if (current(session)) fail(session, "unexpected-url");
            return;
          }
          chosen ??= accepted;
        }
        if (
          chosen === undefined &&
          printed !== undefined &&
          (returnsToCli(printed) || now() - printedAt >= grace)
        )
          chosen = printed;
        if (chosen === undefined || !current(session)) return;
        opening = true;
        const opened = await page.open(chosen).catch(() => null);
        if (!current(session)) return;
        if (opened === null) return fail(session, "browser-unavailable");
        setChallenge(session, {
          kind: "page",
          view: opened.view,
          code: !returnsToCli(chosen),
        });
      } finally {
        deciding = false;
      }
    };
    const child = spawnLines(
      [path, ...(tool === "codex" ? ["login"] : ["auth", "login"])],
      env,
      counted(session, (line) => {
        if (session.challenge !== undefined || opening) return;
        for (const match of line.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
          const candidate = match[0].replace(/[.,;:!?)]+$/, "");
          // The CLI's own listener for the return (Codex prints it).
          if (loopbackAddress(candidate)) continue;
          const accepted = signInPageOf(tool, candidate);
          if (accepted === undefined) return fail(session, "unexpected-url");
          if (printed === undefined) {
            printed = accepted;
            printedAt = now();
          }
        }
        if (printed === undefined) return;
        if (page.kind === "environment") void decide();
        else
          setChallenge(session, {
            kind: "page",
            url: printed,
            code: !returnsToCli(printed),
          });
      }),
      tool === "claude",
    );
    track(session, child);
    if (child.child.stdin) session.input = child.child.stdin;
    if (page.kind === "environment") {
      const tick = () => {
        if (!current(session) || session.challenge !== undefined) return;
        void decide();
        later(session, 100, tick);
      };
      later(session, 100, tick);
    }
    await aiSignInEnd(session, entry, path, tool, child);
  }

  // ChatGPT's sign-in by code (root decision 0201 point 10, F19's addendum
  // of 2026-10-21), the fallback where the page in the Environment browser
  // cannot be finished: `codex login --device-auth`, without the stand-in
  // BROWSER, since the person opens OpenAI's page on any device. Codex
  // prints the page and the one-time code each on a line of its own,
  // coloured even without a terminal (`counted` reads them plain). Only the
  // exact page becomes the challenge, and any other address on a line of
  // its own stops the CLI (`unexpected-url`); the code is the first line of
  // a code's shape after the one that names it. Then the same end as the
  // browser sign-in.
  async function startCodexByCode(
    session: Session,
    entry: ToolEntry,
    path: string,
  ) {
    let url: string | undefined;
    let code: string | undefined;
    let named = false;
    const child = spawnLines(
      [path, "login", "--device-auth"],
      processEnv("codex"),
      counted(session, (line) => {
        if (session.challenge !== undefined) return;
        if (/^https?:\/\/\S+$/.test(line)) {
          if (challengeUrl(line, signInPageHosts.codex) !== codexDevicePage)
            return fail(session, "unexpected-url");
          url = codexDevicePage;
        } else if (named && code === undefined && codexDeviceCode.test(line))
          code = line;
        else if (/one-time code/i.test(line)) named = true;
        if (url !== undefined && code !== undefined)
          setChallenge(session, { kind: "device-code", url, code });
      }),
    );
    track(session, child);
    await aiSignInEnd(session, entry, path, "codex", child);
  }

  // The end of an AI CLI's sign-in, by its page or by code: signed in is
  // what the CLI's own status confirms after it exited 0.
  async function aiSignInEnd(
    session: Session,
    entry: ToolEntry,
    path: string,
    tool: AiProvider,
    child: Streamed,
  ) {
    const exitCode = await child.exited;
    if (!current(session)) return;
    session.processes.delete(child);
    if (exitCode !== 0) return fail(session, "tool-exit");
    const signIn = await probe(entry, path);
    if (!current(session)) return;
    if (signIn.state !== "signed-in") return fail(session, "not-confirmed");
    // Signed in: the running services read the new sign-in (root decision
    // 0201 point 4) before the session says so.
    delete session.challenge;
    session.input?.destroy();
    delete session.input;
    session.step = "services";
    session.expiresAt = now() + servicesMs;
    notify(session);
    const reload = environment.reload;
    const services =
      reload === undefined
        ? undefined
        : await reload(tool, await aiSignedIn(tool)).catch(
            (): AiServices => ({
              t3: { state: "failed", reason: "refused" },
            }),
          );
    if (!current(session)) return;
    finish(session, {
      kind: "signed-in",
      tool,
      ...(signIn.account === undefined ? {} : { account: signIn.account }),
      ...(signIn.organization === undefined
        ? {}
        : { organization: signIn.organization }),
      ...(services === undefined ? {} : { services }),
    });
  }

  const state = (session: Session): LoginState => {
    if (session.finished !== undefined) return session.finished;
    return {
      kind: "pending",
      tool: session.tool,
      session: session.id,
      ...(session.challenge === undefined
        ? {}
        : { challenge: session.challenge }),
      ...(session.step === undefined ? {} : { step: session.step }),
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  };

  function cancelRunning(name: string) {
    const running = sessions.get(name);
    if (running !== undefined)
      finish(running, { kind: "cancelled", tool: name });
    finished.delete(name);
  }

  return {
    /** Starts the tool's sign-in, replacing a running session of the same
     * tool, and waits briefly for the first challenge. `deviceCode`:
     * codex's sign-in by code instead of its browser sign-in. */
    async start(
      name: string,
      options: Readonly<{
        phone?: string;
        sshKey?: boolean;
        deviceCode?: boolean;
      }> = {},
    ): Promise<LoginState> {
      const entry = loginTool(name);
      if (entry === undefined || closed)
        throw new Error("Only a curated catalog tool signs in here");
      if (options.phone !== undefined && name !== "wacli")
        throw new Error("Only wacli pairs with a phone number");
      if (options.sshKey === true && name !== "gh")
        throw new Error("Only gh links an SSH key");
      // Claude has no sign-in by code; the catalog tools have their own.
      if (options.deviceCode === true && name !== "codex")
        throw new Error("Only codex signs in with a code");
      const byCode = options.deviceCode === true;
      journal({ tool: name, event: "start" });
      // Ended before a session exists: journaled like every other end.
      const refused = (reason: LoginFailure): LoginState => {
        const outcome = { kind: "failed", tool: name, reason } as const;
        ended(name, outcome);
        return outcome;
      };
      const phone =
        options.phone === undefined ? undefined : normalizePhone(options.phone);
      if (options.phone !== undefined && phone === undefined)
        return refused("invalid-phone");
      // codex and claude: refused before anything runs where the page could
      // not return to the CLI, or where the Organization provides the AI.
      if (isAiProvider(name)) {
        const blocked = (
          reason: "no-environment-browser" | "organization-provided",
        ): LoginState => {
          const outcome = { kind: "blocked", tool: name, reason } as const;
          ended(name, outcome);
          return outcome;
        };
        // By code the person opens OpenAI's page on any device: it needs no
        // Environment browser.
        if (!byCode && environment.signInPage?.kind === "none")
          return blocked("no-environment-browser");
        // Codex's own `account/read`, asked now, right before its CLI, never
        // from a reading kept for the page (root decision 0201 points 4 and
        // 6): a provider of the Organization that needs no OpenAI sign-in
        // refuses it. An answer that cannot be read starts nothing either
        // (fail closed): whether the sign-in would bypass the Organization's
        // provider is not known. Claude has no such source.
        if (name === "codex") {
          const codex = await readCodex(
            environment,
            converse,
            providerReadMs,
          ).catch(() => ({ state: "unknown" }) as const);
          if (codex.state === "provided")
            return blocked("organization-provided");
          if (codex.state === "unknown") return refused("provider-unknown");
        }
      }
      cancelRunning(name);
      // A gh sign-in or link may change the account or the key: what the
      // status kept no longer holds.
      if (name === "gh") environment.sshProofs?.forget();
      const path = await locate(entry);
      if (path === undefined) return refused("not-installed");
      const lifetime = byCode
        ? lifetimes["codex-device"]
        : lifetimes[name as keyof typeof lifetimes];
      const session: Session = {
        id: randomBytes(16).toString("hex"),
        tool: name,
        action: options.sshKey === true ? "ssh-key" : "login",
        expiresAt: now() + lifetime,
        challenged: false,
        processes: new Set(),
        timers: new Set(),
        waiters: new Set(),
        sequence: 0,
        probing: false,
        pendingBytes: 0,
      };
      sessions.set(name, session);
      const expire = () => {
        if (!current(session)) return;
        const left = session.expiresAt - now();
        if (left > 0) later(session, left, expire);
        else finish(session, { kind: "expired", tool: name });
      };
      later(session, lifetime, expire);
      // A sign-in that shows nothing to act on within the bound ends with a
      // reason instead of waiting out its lifetime. The linking of gh's SSH
      // key has bounded steps of its own and shows no challenge.
      if (session.action === "login")
        later(session, environment.challengeMs ?? defaultChallengeMs, () => {
          if (
            current(session) &&
            !session.challenged &&
            session.step === undefined
          )
            fail(
              session,
              session.connected === true ? "not-confirmed" : "no-challenge",
            );
        });
      const flow = isAiProvider(name)
        ? byCode
          ? startCodexByCode(session, entry, path)
          : startAi(session, entry, path, name)
        : name === "gh"
          ? options.sshKey === true
            ? startGhLink(session, path)
            : startGh(session, entry, path)
          : name === "composio"
            ? startComposio(session, entry, path)
            : startWacli(session, entry, path, phone);
      void flow.catch(() => {
        if (current(session)) fail(session, "spawn-failed");
      });
      // The first challenge, a result or the wait's end, whichever is first.
      await new Promise<void>((resolve) => {
        if (session.challenge !== undefined || session.finished !== undefined)
          return resolve();
        const timer = setTimeout(done, environment.firstChallengeMs ?? 20_000);
        function done() {
          clearTimeout(timer);
          session.waiters.delete(done);
          resolve();
        }
        session.waiters.add(done);
      });
      const result = state(session);
      if (session.finished !== undefined && finished.get(name) === session)
        finished.delete(name);
      return result;
    },

    /** The session's state for the holder of its handle; an outcome is
     * returned once and then the session is gone. */
    poll(name: string, handle: string): LoginState {
      const running = sessions.get(name);
      if (running?.id === handle) return state(running);
      const done = finished.get(name);
      if (done?.id === handle && done.finished !== undefined) {
        finished.delete(name);
        return done.finished;
      }
      return { kind: "none", tool: name };
    },

    /** Resolves on the session's next change or after `ms`. */
    changed(name: string, handle: string, ms: number): Promise<void> {
      const session = sessions.get(name);
      if (session?.id !== handle) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          session?.waiters.delete(done);
          resolve();
        }
        session.waiters.add(done);
      });
    },

    /** claude's code page (F19's addendum of 2026-10-15): the code the page
     * showed, handed to the waiting CLI as one line of its input, only while
     * the session's page is one that ends on a code. Never stored, logged or
     * answered. */
    code(
      name: string,
      handle: string,
      input: unknown,
    ): "accepted" | "invalid-code" | "not-waiting" {
      const running = sessions.get(name);
      if (
        running?.id !== handle ||
        !current(running) ||
        running.challenge?.kind !== "page" ||
        !running.challenge.code ||
        running.input === undefined ||
        running.input.destroyed
      )
        return "not-waiting";
      const code = signInCode(input);
      if (code === undefined) return "invalid-code";
      running.input.write(`${code}\n`);
      return "accepted";
    },

    cancel(name: string, handle: string): LoginState {
      const running = sessions.get(name);
      if (running?.id !== handle) {
        if (finished.get(name)?.id === handle) finished.delete(name);
        return { kind: "none", tool: name };
      }
      finish(running, { kind: "cancelled", tool: name });
      return { kind: "cancelled", tool: name };
    },

    /** Ends a running session of the tool as refused by the Team rule: the
     * Launchpad calls it when a profile change makes the Environment a Team
     * one. The holder's next poll reads the refusal. */
    refuse(name: string): void {
      const running = sessions.get(name);
      if (running !== undefined) block(running);
    },

    /** Runs the tool's own logout command and checks the result with its probe. */
    async logout(name: string): Promise<LogoutResult> {
      const entry = loginTool(name);
      if (entry === undefined || isAiProvider(name))
        throw new Error("Not a curated catalog tool");
      cancelRunning(name);
      if (name === "gh") environment.sshProofs?.forget();
      const path = await locate(entry);
      if (path === undefined)
        return { kind: "logout-failed", tool: name, reason: "not-installed" };
      // gh: before the sign-in is forgotten, the key Lazurio registered for
      // this Machine is removed from the account while the token still can.
      const sshKey =
        name === "gh" && environment.home !== undefined
          ? await removeSshKey({
              home: environment.home,
              gh: path,
              run: (command, timeoutMs) =>
                environment.run(command, timeoutMs, probeEnv()),
            }).catch(
              (): SshKeyRemoval => ({
                state: "not-removed",
                reason: "tool-exit",
              }),
            )
          : undefined;
      const argv =
        name === "gh"
          ? ["auth", "logout", "--hostname", "github.com"]
          : name === "composio"
            ? ["logout"]
            : ["auth", "logout"];
      try {
        const result = await environment.run(
          [path, ...argv],
          60_000,
          processEnv(),
        );
        if (result === "timeout" || result.exitCode !== 0)
          return { kind: "logout-failed", tool: name, reason: "tool-exit" };
      } catch {
        return { kind: "logout-failed", tool: name, reason: "tool-exit" };
      }
      if ((await probe(entry, path)).state === "signed-in")
        return { kind: "logout-failed", tool: name, reason: "still-signed-in" };
      return {
        kind: "logged-out",
        tool: name,
        revocation: name === "wacli" ? "remote" : "local-only",
        ...(sshKey === undefined ? {} : { sshKey }),
      };
    },

    /** gh's sign-in as its probe reports it now, with the kind of its
     * identity: what the Team rule (`team-github.ts`) decides a sign-out on.
     * Only the state, the label and the kind leave; never the output. */
    async ghSignIn(): Promise<ToolSignIn> {
      const entry = loginTool("gh");
      const path = entry && (await locate(entry));
      if (entry === undefined || path === undefined)
        return { state: "unknown" };
      return probe(entry, path);
    },

    /** Composio's organizations of the signed-in account, the current one
     * marked, from the tool's own `orgs list`. */
    async composioOrganizations(): Promise<ComposioOrganizationsResult> {
      const entry = loginTool("composio");
      const path = entry && (await locate(entry));
      if (entry === undefined || path === undefined)
        return {
          kind: "composio-organizations-failed",
          reason: "not-installed",
        };
      let result: Awaited<ReturnType<ToolRunner>>;
      try {
        result = await environment.run(
          [path, "orgs", "list"],
          30_000,
          processEnv(),
        );
      } catch {
        return { kind: "composio-organizations-failed", reason: "tool-exit" };
      }
      if (result === "timeout" || result.exitCode !== 0)
        return { kind: "composio-organizations-failed", reason: "tool-exit" };
      const organizations = parseComposioOrganizations(result.stdout);
      if (organizations === undefined)
        return {
          kind: "composio-organizations-failed",
          reason: /not logged in/i.test(`${result.stdout}\n${result.stderr}`)
            ? "not-signed-in"
            : "unreadable",
        };
      return { kind: "composio-organizations", organizations };
    },

    /** Makes one listed organization the current one, with the tool's own
     * `orgs switch`. */
    async selectComposioOrganization(
      id: string,
    ): Promise<ComposioSelectResult> {
      const listed = await this.composioOrganizations();
      if (listed.kind !== "composio-organizations")
        return {
          kind: "composio-organization-failed",
          reason:
            listed.reason === "not-installed" ? "not-installed" : "unreadable",
        };
      const organization = listed.organizations.find(
        (entry) => entry.id === id,
      );
      if (organization === undefined)
        return {
          kind: "composio-organization-failed",
          reason: "unknown-organization",
        };
      const entry = loginTool("composio");
      const path = entry && (await locate(entry));
      if (entry === undefined || path === undefined)
        return {
          kind: "composio-organization-failed",
          reason: "not-installed",
        };
      try {
        const result = await environment.run(
          [path, "orgs", "switch", "--org-id", organization.id],
          30_000,
          processEnv(),
        );
        if (result === "timeout" || result.exitCode !== 0)
          return { kind: "composio-organization-failed", reason: "tool-exit" };
      } catch {
        return { kind: "composio-organization-failed", reason: "tool-exit" };
      }
      const signIn = await probe(entry, path);
      return {
        kind: "composio-organization-selected",
        id: organization.id,
        ...(signIn.organization === undefined
          ? {}
          : { organization: signIn.organization }),
      };
    },

    /** Resolves when no process of this owner runs any more: the CLI waits
     * for wacli's bootstrap sync before it exits. */
    async settled(): Promise<void> {
      await Promise.all([
        ...[
          ...background,
          ...[...sessions.values()].flatMap((s) => [...s.processes]),
        ].map((child) => child.exited),
        ...cleanups,
      ]);
    },

    /** Drops every session and kills every process: the owner is ending. */
    async close(): Promise<void> {
      closed = true;
      for (const session of [...sessions.values()])
        finish(session, { kind: "cancelled", tool: session.tool });
      finished.clear();
      const running = [...background];
      for (const child of running) child.kill();
      await Promise.all([...running.map((child) => child.exited), ...cleanups]);
    },
  };
}

export type LoginSessions = ReturnType<typeof createLoginSessions>;

// `composio orgs list` prints one JSON array of `{ id, name,
// is_selected_global_org }` on stdout when stdout is not a terminal; Lazurio's
// build adds each one's `created_at` (decision F42, addendum of 2026-10-26).
// A date that is missing or not a date is left out, never a reason to refuse
// the list: then the account's default organization is not told, and the
// person's choice stands.
export function parseComposioOrganizations(
  stdout: string,
): readonly ComposioOrganization[] | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => entry.startsWith("["));
  if (line === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const organizations: ComposioOrganization[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") return undefined;
    const {
      id,
      name,
      created_at: created,
      is_selected_global_org: selected,
    } = item as Record<string, unknown>;
    const label = signInLabel(name);
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
      label === undefined ||
      organizations.some((entry) => entry.id === id)
    )
      return undefined;
    const createdAt =
      typeof created === "string" &&
      created.length <= 64 &&
      !Number.isNaN(Date.parse(created))
        ? created
        : undefined;
    organizations.push({
      id,
      name: label,
      current: selected === true,
      ...(createdAt === undefined ? {} : { createdAt }),
    });
  }
  return organizations;
}
