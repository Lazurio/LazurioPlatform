import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type ActivatableTool, activatableTools } from "./catalog";
import { ghStatus } from "./gh-status";
import { plainText } from "./redact";
import {
  ghAccount,
  hasKeyScope,
  linkSshKey,
  machineName,
  removeSshKey,
  type SshContext,
  type SshKeyRemoval,
  type SshLink,
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

/** The curated sign-in of a `setup: "launchpad"` catalog tool (decision F19).
 * One session per tool at a time, in memory, owned by the process that
 * started it (a `lazurio tools login` command or the Launchpad server). The
 * tool's own sign-in command runs as the current user with a minimal
 * environment; its output is parsed as it arrives and yields a challenge: a
 * URL to open (composio), a device code and its page (gh), a QR payload or a
 * pairing code (wacli). A challenge is sensitive while it is valid: it is
 * returned only to the holder of the session handle and never written to a
 * log, a file, the Folder or an error. The raw output of a tool never leaves
 * this module. */
export type LoginChallenge =
  | Readonly<{ kind: "url"; url: string }>
  | Readonly<{ kind: "device-code"; url: string; code: string }>
  | Readonly<{ kind: "qr"; payload: string; sequence: number }>
  | Readonly<{
      kind: "pair-code";
      phone: string;
      code: string;
      sequence: number;
    }>;

export type LoginState =
  | Readonly<{ kind: "none"; tool: string }>
  | Readonly<{
      kind: "pending";
      tool: string;
      /** The handle of the session: poll and cancel name it. */
      session: string;
      challenge?: LoginChallenge;
      /** gh only: signed in, the SSH key of this Machine is being linked. */
      step?: "ssh-key";
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
      /** The tool was signed in before this session: it connected without
       * showing a challenge, and its probe confirmed it (#98). */
      already?: true;
    }>
  | Readonly<{ kind: "failed"; tool: string; reason: LoginFailure }>
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
  | "no-challenge";

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

export type LoginEnvironment = Readonly<{
  path: string | undefined;
  home: string | undefined;
  xdg?: Readonly<Record<string, string>> | undefined;
  platform: string;
  run: ToolRunner;
  /** Test seams. */
  now?: () => number;
  lifetimes?: Partial<Record<"gh" | "composio" | "wacli", number>>;
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
}>;

// The lifetimes of the documented flows: a GitHub device code is valid for
// 15 minutes, a pending Composio login for 10, and WhatsApp pairing gets 5.
const defaultLifetimes = {
  gh: 15 * 60_000,
  composio: 10 * 60_000,
  wacli: 5 * 60_000,
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
const maxCollected = 1024 * 1024;
const maxLine = 16 * 1024;
const maxPendingOutput = 4 * 1024 * 1024;

const ghDevicePage = "https://github.com/login/device";

/** The tools with a curated sign-in: the `launchpad` ones. */
export function loginTool(name: string): ActivatableTool | undefined {
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
export function challengeUrl(
  candidate: string,
  hosts: readonly string[],
): string | undefined {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password)
      return undefined;
    if (url.port !== "" || !hosts.includes(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

type Streamed = Readonly<{
  child: ChildProcess;
  exited: Promise<number>;
  kill: () => void;
}>;

// One tool process in its own process group, so a cancel, an expiry or a
// shutdown kills its helpers too.
function spawnGroup(
  command: readonly string[],
  env: Readonly<Record<string, string>>,
): Streamed {
  const [executable, ...args] = command;
  if (!executable) throw new Error("A command is required");
  const child = spawn(executable, args, {
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"],
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
  return { child, exited, kill };
}

// A tool process whose output is read line by line as it arrives.
function spawnLines(
  command: readonly string[],
  env: Readonly<Record<string, string>>,
  onLine: (line: string) => void,
): Streamed {
  const streamed = spawnGroup(command, env);
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
  step?: "ssh-key";
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
  let closed = false;

  const processEnv = (): Record<string, string> => {
    const env: Record<string, string> = { NO_COLOR: "1" };
    if (environment.path) env.PATH = environment.path;
    if (environment.home) env.HOME = environment.home;
    for (const [name, value] of Object.entries(environment.xdg ?? {}))
      if (/^XDG_[A-Z_]+$/.test(name) && value) env[name] = value;
    return env;
  };
  const probeEnv = (): Record<string, string> => {
    const { NO_COLOR: _, ...env } = processEnv();
    return env;
  };
  const locate = (entry: ActivatableTool) =>
    resolveOnPath(entry.command, environment.path, environment.platform);

  async function probe(
    entry: ActivatableTool,
    path: string,
  ): Promise<ToolSignIn> {
    const signInProbe = entry.activation.signInProbe;
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
          probeEnv(),
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
    if (sessions.get(session.tool) === session) sessions.delete(session.tool);
    if (outcome.kind !== "cancelled") finished.set(session.tool, session);
    ended(session.tool, outcome);
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
    entry: ActivatableTool,
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
    // Before the final "signed in".
    if (!(await mayProceed(session))) return;
    finish(session, {
      kind: "signed-in",
      tool: session.tool,
      account: signedIn.account,
      ssh,
    });
  }

  async function startGh(
    session: Session,
    entry: ActivatableTool,
    path: string,
  ) {
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
    entry: ActivatableTool,
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
    entry: ActivatableTool,
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
     * tool, and waits briefly for the first challenge. */
    async start(
      name: string,
      options: Readonly<{ phone?: string; sshKey?: boolean }> = {},
    ): Promise<LoginState> {
      const entry = loginTool(name);
      if (entry === undefined || closed)
        throw new Error("Only a curated catalog tool signs in here");
      if (options.phone !== undefined && name !== "wacli")
        throw new Error("Only wacli pairs with a phone number");
      if (options.sshKey === true && name !== "gh")
        throw new Error("Only gh links an SSH key");
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
      cancelRunning(name);
      const path = await locate(entry);
      if (path === undefined) return refused("not-installed");
      const lifetime = lifetimes[name as keyof typeof lifetimes];
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
      const flow =
        name === "gh"
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
      if (entry === undefined) throw new Error("Not a curated catalog tool");
      cancelRunning(name);
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
      await Promise.all(
        [
          ...background,
          ...[...sessions.values()].flatMap((s) => [...s.processes]),
        ].map((child) => child.exited),
      );
    },

    /** Drops every session and kills every process: the owner is ending. */
    async close(): Promise<void> {
      closed = true;
      for (const session of [...sessions.values()])
        finish(session, { kind: "cancelled", tool: session.tool });
      finished.clear();
      const running = [...background];
      for (const child of running) child.kill();
      await Promise.all(running.map((child) => child.exited));
    },
  };
}

export type LoginSessions = ReturnType<typeof createLoginSessions>;

// `composio orgs list` prints one JSON array of `{ id, name,
// is_selected_global_org }` on stdout when stdout is not a terminal.
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
    organizations.push({ id, name: label, current: selected === true });
  }
  return organizations;
}
