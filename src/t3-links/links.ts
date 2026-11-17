import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AssignedEnvironment,
  assignedEnvironments,
  isEnvironmentId,
  type MachineBinding,
} from "../folder/machine-binding";
import { acquireFileLock, type FileLock } from "../platform/flock";
import { readOwnFile, replaceFile } from "../ssh-access/environments";
import type { ToolRunner } from "../tools/status";
import {
  chatT3Home,
  type LinkedSetting,
  setLinkedEnvironments,
} from "./settings";

// Links between T3 Code servers along the edge from a person's Personal
// Environment to the Work Environments assigned to them (root decision 0157,
// amended 2026-11-17, with 0246, 0247 and 0091; plan step R4c). The
// Organization records the edge in its Deployment Repo and its Owner
// confirms it; Lazurio never creates or removes one. Inside an edge that
// exists, Lazurio pairs, renews and ends the link itself, and T3 Code stays
// as it is, so threads use its standard tools (`t3_environment_links`,
// `environmentId`, `delegate_task` with `target.environmentId`).
//
// Each end acts only on what its own handover says, once per tick
// (`syncT3Links`):
//
// - **The source**, a personal Machine, links its Chat's T3 Code to each
//   assigned Work Environment (`assignedEnvironments`, the same peers its SSH
//   routes come from) at `https://t3code.<Environment id>.lazurio.io`, whose
//   gateway passes the four paths of the link only from this Machine's
//   tailnet address and only while the Organization records the edge. It
//   turns the Chat's beta switch on, asks the target over the managed SSH
//   route (`ssh <Environment id>`) for a one-time pairing code with a short
//   life (`t3 auth pairing create`), links with it under the label its own
//   running T3 Code answers with (`t3 environment link` with
//   `T3CODE_ENVIRONMENT_LABEL`), reads the link back and revokes on the
//   target the sessions of its earlier links, so one session stays. A link
//   is renewed by the same steps once it has less than seven days left
//   (T3 Code's token lives 30 days and has no refresh), when T3 Code reports
//   it expired or failing, or when it is gone; a failed attempt is retried
//   after a quarter of an hour. When an edge goes, its link is forgotten
//   here (`t3 environment unlink`); the target ends its own session. The beta
//   switch goes off with the last link, only where Lazurio turned it on.
// - **The target**, a work Machine, turns its Chat's beta switch on while
//   its handover names an inbound SSH peer that is a personal Machine (the
//   edge seen from this end) and, when such a peer goes, revokes every
//   session of a linked T3 Code (`T3 Code · <label>`, subject `mcp-client`)
//   and, with the last one, turns the switch off where Lazurio turned it on.
//   Turning the switch off already makes T3 Code refuse linked clients.
//
// The pairing code is a secret: it travels from the target's standard
// output, over SSH, into this process's memory and onto the command line of
// the one `t3 environment link` that spends it, a run of seconds; it lives
// two minutes and is revoked on the target when that run fails. It is never
// written to a file, a log, the state or a report, and neither is the token,
// which only T3 Code holds. Every value that reaches the target's shell is
// one checked token. What is recorded (`~/.local/state/lazurio/t3-links.json`,
// 0600) is which links Lazurio made, until when, which inbound peers it saw,
// whether it turned the switch on and when an attempt last failed.
//
// The first link into each Work Environment is meant to be confirmed once
// by the person with a button in Lazurio (0157); until that confirmation is
// built with the rework of Lazurio Auth, Lazurio pairs inside an edge the
// Owner confirmed without it, as 0157 allows.

/** Renew a link once it has this little left of T3 Code's 30 days. */
export const renewBeforeMs = 7 * 24 * 60 * 60_000;
/** Wait this long after a failed attempt before the next one. */
export const retryAfterMs = 15 * 60_000;
/** How long a pairing code the target issues lives. */
export const pairingTtl = "2m";
/** What the source's agents may do in a linked Work Environment. */
export const linkAccess = "full-access";
/** How T3 Code names a linked T3 Code's session on the target. */
export const linkClientPrefix = "T3 Code · ";
/** How often the Launchpad looks at the links. */
export const t3LinksEveryMs = 5 * 60_000;

/** The address of a Work Environment's T3 Code, from its Environment id
 * (`<machine>.<organization>`); null for anything else. */
export function t3LinkOrigin(environment: string): string | null {
  return isEnvironmentId(environment)
    ? `https://t3code.${environment}.lazurio.io`
    : null;
}

export type T3LinkRole =
  | Readonly<{ kind: "source"; targets: readonly AssignedEnvironment[] }>
  | Readonly<{ kind: "target"; sources: readonly string[] }>
  | Readonly<{ kind: "none" }>;

/** What this Machine is for the links, from its own handover only. */
export function t3LinkRole(
  machine: MachineBinding | null | undefined,
): T3LinkRole {
  if (machine?.kind === "personal-vm")
    return {
      kind: "source",
      targets: assignedEnvironments(machine).filter(
        (target) => t3LinkOrigin(target.environment) !== null,
      ),
    };
  if (machine?.kind === "workspace-vm")
    return {
      kind: "target",
      sources: [
        ...new Set(
          (machine.relationships?.peers ?? [])
            .filter(
              (peer) =>
                peer.kind === "personal-vm" &&
                peer.ssh !== null &&
                (peer.ssh.direction === "inbound" ||
                  peer.ssh.direction === "both"),
            )
            .map((peer) => peer.name),
        ),
      ].sort(),
    };
  return { kind: "none" };
}

// ---- State ----------------------------------------------------------------

export type LinkFailure =
  | "label-unknown"
  | "target-unreachable"
  | "pairing-refused"
  | "link-refused"
  | "link-unconfirmed";

type RecordedLink = Readonly<{ peerEnvironmentId: string; expiresAt: string }>;
type FailedAttempt = Readonly<{ at: string; cause: LinkFailure }>;

export type T3LinksState = Readonly<{
  version: 1;
  /** Whether Lazurio turned the Chat's beta switch on. */
  enabledByLazurio: boolean;
  /** The links Lazurio made, by Environment id (source). */
  links: Readonly<Record<string, RecordedLink>>;
  /** The last failed attempt, by Environment id (source). */
  attempts: Readonly<Record<string, FailedAttempt>>;
  /** The inbound personal peers seen last (target). */
  sources: readonly string[];
}>;

export const emptyT3LinksState: T3LinksState = Object.freeze({
  version: 1,
  enabledByLazurio: false,
  links: {},
  attempts: {},
  sources: [],
});

export const t3LinksStatePath = (home: string) =>
  join(home, ".local", "state", "lazurio", "t3-links.json");
const t3LinksLockPath = (home: string) =>
  join(home, ".local", "state", "lazurio", "t3-links.lock");

const failures: readonly LinkFailure[] = [
  "label-unknown",
  "target-unreachable",
  "pairing-refused",
  "link-refused",
  "link-unconfirmed",
];
const idToken = /^[A-Za-z0-9-]{1,64}$/;
const peerName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

/** The state as recorded, exactly; null when it is there but is not. */
export function parseT3LinksState(value: unknown): T3LinksState | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.enabledByLazurio !== "boolean" ||
    !isRecord(value.links) ||
    !isRecord(value.attempts) ||
    !Array.isArray(value.sources)
  )
    return null;
  const links: Record<string, RecordedLink> = {};
  for (const [environment, link] of Object.entries(value.links)) {
    if (
      !isEnvironmentId(environment) ||
      !isRecord(link) ||
      typeof link.peerEnvironmentId !== "string" ||
      !idToken.test(link.peerEnvironmentId) ||
      !instant(link.expiresAt)
    )
      return null;
    links[environment] = {
      peerEnvironmentId: link.peerEnvironmentId,
      expiresAt: link.expiresAt,
    };
  }
  const attempts: Record<string, FailedAttempt> = {};
  for (const [environment, attempt] of Object.entries(value.attempts)) {
    if (
      !isEnvironmentId(environment) ||
      !isRecord(attempt) ||
      !instant(attempt.at) ||
      !failures.includes(attempt.cause as LinkFailure)
    )
      return null;
    attempts[environment] = {
      at: attempt.at,
      cause: attempt.cause as LinkFailure,
    };
  }
  if (
    !value.sources.every(
      (name) => typeof name === "string" && peerName.test(name),
    )
  )
    return null;
  return {
    version: 1,
    enabledByLazurio: value.enabledByLazurio,
    links,
    attempts,
    sources: [...(value.sources as string[])].sort(),
  };
}

/** The recorded state; empty when there is none, null when a file is there
 * that is not the state. */
export async function readT3LinksState(
  home: string,
  uid: number | undefined,
): Promise<T3LinksState | null> {
  const observed = await readOwnFile(t3LinksStatePath(home), uid).catch(
    () => ({ kind: "refused" }) as const,
  );
  if (observed.kind === "missing") return emptyT3LinksState;
  if (observed.kind !== "file") return null;
  try {
    return parseT3LinksState(JSON.parse(observed.bytes.toString("utf8")));
  } catch {
    return null;
  }
}

async function writeT3LinksState(home: string, state: T3LinksState) {
  const path = t3LinksStatePath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await replaceFile(
    dirname(path),
    "t3-links.json",
    Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"),
    0o600,
  );
}

// ---- T3 Code's answers ------------------------------------------------------

export type LocalLink = Readonly<{
  environmentId: string;
  urls: readonly string[];
  expiresAt: number;
  status: string;
  lastError: string | null;
}>;
export type LinkSession = Readonly<{
  sessionId: string;
  subject: string;
  label: string | null;
}>;

// T3 Code may log before its answer (Lazurio/t3code#210), so the answer is
// read from the first line that opens it.
function jsonFrom(stdout: string, open: "[" | "{"): unknown {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith(open));
  if (start === -1) return undefined;
  try {
    return JSON.parse(lines.slice(start).join("\n"));
  } catch {
    return undefined;
  }
}

/** `t3 environment list --json`. */
export function parseLocalLinks(stdout: string): LocalLink[] | undefined {
  const value = jsonFrom(stdout, "[");
  if (!Array.isArray(value)) return undefined;
  const links: LocalLink[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.environmentId !== "string" ||
      !idToken.test(item.environmentId) ||
      !Array.isArray(item.urls) ||
      !item.urls.every((url) => typeof url === "string") ||
      !instant(item.expiresAt) ||
      typeof item.status !== "string" ||
      !(item.lastError === null || typeof item.lastError === "string")
    )
      return undefined;
    links.push({
      environmentId: item.environmentId,
      urls: item.urls as string[],
      expiresAt: Date.parse(item.expiresAt),
      status: item.status,
      lastError: item.lastError,
    });
  }
  return links;
}

/** `t3 auth session list --json`, without anything but what is needed. */
export function parseSessions(stdout: string): LinkSession[] | undefined {
  const value = jsonFrom(stdout, "[");
  if (!Array.isArray(value)) return undefined;
  const sessions: LinkSession[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.sessionId !== "string" ||
      !idToken.test(item.sessionId) ||
      typeof item.subject !== "string"
    )
      return undefined;
    const client = isRecord(item.client) ? item.client : {};
    sessions.push({
      sessionId: item.sessionId,
      subject: item.subject,
      label: typeof client.label === "string" ? client.label : null,
    });
  }
  return sessions;
}

/** `t3 auth pairing create --json`: its id and the code itself, which never
 * leaves this process but for the one command that spends it. */
export function parsePairing(
  stdout: string,
): Readonly<{ id: string; credential: string }> | undefined {
  const value = jsonFrom(stdout, "{");
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !idToken.test(value.id) ||
    typeof value.credential !== "string" ||
    !/^[A-Za-z0-9._~+/=-]{8,512}$/.test(value.credential)
  )
    return undefined;
  return { id: value.id, credential: value.credential };
}

const isLinkSession = (session: LinkSession) =>
  session.subject === "mcp-client" &&
  session.label !== null &&
  session.label.startsWith(linkClientPrefix);

// ---- Effects ------------------------------------------------------------------

export type T3LinkSeams = Readonly<{
  run: ToolRunner;
  now: () => number;
  /** The user's home, absolute. */
  home: string;
  uid: number | undefined;
  /** The PATH the commands run with. */
  path: string | undefined;
  /** The local `t3`, absolute. */
  t3: string;
  /** The label this Environment's running Chat T3 Code answers with; none
   * when it does not answer. */
  label: () => Promise<string | undefined>;
}>;

const remoteTimeoutMs = 45_000;
const localTimeoutMs = 60_000;
const safeToken = /^[A-Za-z0-9._:-]+$/;

const base = (seams: T3LinkSeams) => join(seams.home, chatT3Home);
const environment = (seams: T3LinkSeams) => ({
  HOME: seams.home,
  ...(seams.path ? { PATH: seams.path } : {}),
});

/** `t3 <command…>` on the target, over the managed route `ssh <id>`, as its
 * account and on its Chat's home. Every argument is one checked token. */
async function onTarget(
  seams: T3LinkSeams,
  target: string,
  command: readonly string[],
  positional: string | null = null,
) {
  if (
    !isEnvironmentId(target) ||
    !command.every((part) => safeToken.test(part)) ||
    (positional !== null && !idToken.test(positional))
  )
    return undefined;
  const remote = [
    '"$HOME/.local/bin/t3"',
    ...command,
    "--base-dir",
    '"$HOME/.t3"',
    ...(positional === null ? [] : [positional]),
  ].join(" ");
  const result = await seams
    .run(
      [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        target,
        remote,
      ],
      remoteTimeoutMs,
      environment(seams),
      { maxBytes: 256 * 1024 },
    )
    .catch(() => "timeout" as const);
  return result === "timeout" || result.exitCode !== 0 ? undefined : result;
}

async function local(
  seams: T3LinkSeams,
  command: readonly string[],
  extra: Readonly<Record<string, string>> = {},
) {
  const result = await seams
    .run([seams.t3, ...command], localTimeoutMs, {
      ...environment(seams),
      ...extra,
    })
    .catch(() => "timeout" as const);
  return result === "timeout" || result.exitCode !== 0 ? undefined : result;
}

const listLocalLinks = async (seams: T3LinkSeams) => {
  const result = await local(seams, [
    "environment",
    "list",
    "--base-dir",
    base(seams),
    "--json",
  ]);
  return result === undefined ? undefined : parseLocalLinks(result.stdout);
};

const targetSessions = async (seams: T3LinkSeams, target: string) => {
  const result = await onTarget(seams, target, [
    "auth",
    "session",
    "list",
    "--json",
  ]);
  return result === undefined ? undefined : parseSessions(result.stdout);
};

type Linked = Readonly<{ kind: "linked"; link: LocalLink; revoked: number }>;
type Failed = Readonly<{ kind: "failed"; cause: LinkFailure }>;

/** One pairing and link into `target`, and the sessions of the earlier links
 * of this source revoked there once the new one is in place. */
async function pairAndLink(
  seams: T3LinkSeams,
  target: string,
  origin: string,
  label: string,
): Promise<Linked | Failed> {
  const client = `${linkClientPrefix}${label}`;
  const before = await targetSessions(seams, target);
  if (before === undefined)
    return { kind: "failed", cause: "target-unreachable" };
  const issued = await onTarget(seams, target, [
    "auth",
    "pairing",
    "create",
    "--ttl",
    pairingTtl,
    "--label",
    "lazurio-link",
    "--json",
  ]);
  const pairing =
    issued === undefined ? undefined : parsePairing(issued.stdout);
  if (pairing === undefined)
    return { kind: "failed", cause: "pairing-refused" };
  const linked = await local(
    seams,
    [
      "environment",
      "link",
      "--base-dir",
      base(seams),
      "--pairing-code",
      pairing.credential,
      "--access",
      linkAccess,
      origin,
    ],
    { T3CODE_ENVIRONMENT_LABEL: label },
  );
  if (linked === undefined) {
    // An unspent code is not left behind.
    await onTarget(seams, target, ["auth", "pairing", "revoke"], pairing.id);
    return { kind: "failed", cause: "link-refused" };
  }
  const link = (await listLocalLinks(seams))?.find((found) =>
    found.urls.includes(origin),
  );
  if (link === undefined) return { kind: "failed", cause: "link-unconfirmed" };
  const earlier = before.filter(
    (session) => session.subject === "mcp-client" && session.label === client,
  );
  const after = await targetSessions(seams, target);
  const known = new Set(earlier.map((session) => session.sessionId));
  const fresh = (after ?? []).filter(
    (session) =>
      session.subject === "mcp-client" &&
      session.label === client &&
      !known.has(session.sessionId),
  );
  let revoked = 0;
  // Only once the new session is seen, so a link is never left without one.
  if (fresh.length > 0)
    for (const session of earlier)
      if (
        (await onTarget(
          seams,
          target,
          ["auth", "session", "revoke"],
          session.sessionId,
        )) !== undefined
      )
        revoked += 1;
  return { kind: "linked", link, revoked };
}

export type T3LinkResult =
  | Readonly<{ environment: string; result: "current"; expiresAt: string }>
  | Readonly<{
      environment: string;
      result: "linked" | "renewed";
      expiresAt: string;
      revoked: number;
    }>
  | Readonly<{
      environment: string;
      result: "waiting" | "failed";
      cause: LinkFailure;
    }>;

export type T3LinksReport =
  | Readonly<{ role: "none" }>
  | Readonly<{ role: "source" | "target"; result: "idle" }>
  | Readonly<{
      role: "source";
      result: "synced";
      setting: LinkedSetting | "kept";
      links: readonly T3LinkResult[];
      unlinked: readonly string[];
      stateRecovered?: true;
    }>
  | Readonly<{
      role: "target";
      result: "synced";
      setting: LinkedSetting | "kept";
      sources: readonly string[];
      revoked: number | "failed";
      stateRecovered?: true;
    }>;

const iso = (time: number) => new Date(time).toISOString();
const switchedOff = (setting: LinkedSetting) =>
  setting === "written" || setting === "unchanged" || setting === "absent";

async function reconcileSource(
  seams: T3LinkSeams,
  targets: readonly AssignedEnvironment[],
  state: T3LinksState,
) {
  const now = seams.now();
  let enabledByLazurio = state.enabledByLazurio;
  const links: Record<string, RecordedLink> = { ...state.links };
  const attempts: Record<string, FailedAttempt> = { ...state.attempts };
  const desired = new Set(targets.map((target) => target.environment));
  let setting: LinkedSetting | "kept" = "kept";
  if (desired.size > 0) {
    setting = await setLinkedEnvironments(seams.home, true);
    if (setting === "written") enabledByLazurio = true;
  }
  const results: T3LinkResult[] = [];
  const unlinked: string[] = [];
  // A link whose edge went: forgotten here; the target ends its session.
  for (const [name, link] of Object.entries(links)) {
    if (desired.has(name)) continue;
    const forgotten = await local(seams, [
      "environment",
      "unlink",
      "--base-dir",
      base(seams),
      link.peerEnvironmentId,
    ]);
    if (forgotten !== undefined) {
      delete links[name];
      unlinked.push(name);
    }
  }
  for (const name of Object.keys(attempts))
    if (!desired.has(name)) delete attempts[name];
  const switchedOn = setting === "written" || setting === "unchanged";
  const listed =
    desired.size > 0 && switchedOn ? await listLocalLinks(seams) : undefined;
  let label: string | undefined | null = null;
  if (listed !== undefined)
    for (const name of desired) {
      const origin = t3LinkOrigin(name) as string;
      const found = listed.find((link) => link.urls.includes(origin));
      if (
        found !== undefined &&
        found.status !== "expired" &&
        found.lastError === null &&
        found.expiresAt - now > renewBeforeMs
      ) {
        links[name] = {
          peerEnvironmentId: found.environmentId,
          expiresAt: iso(found.expiresAt),
        };
        delete attempts[name];
        results.push({
          environment: name,
          result: "current",
          expiresAt: iso(found.expiresAt),
        });
        continue;
      }
      const attempt = attempts[name];
      if (
        attempt !== undefined &&
        now - Date.parse(attempt.at) < retryAfterMs
      ) {
        results.push({
          environment: name,
          result: "waiting",
          cause: attempt.cause,
        });
        continue;
      }
      if (label === null) label = await seams.label().catch(() => undefined);
      const outcome: Linked | Failed =
        label === undefined
          ? { kind: "failed", cause: "label-unknown" }
          : await pairAndLink(seams, name, origin, label);
      if (outcome.kind === "failed") {
        attempts[name] = { at: iso(now), cause: outcome.cause };
        results.push({
          environment: name,
          result: "failed",
          cause: outcome.cause,
        });
        continue;
      }
      links[name] = {
        peerEnvironmentId: outcome.link.environmentId,
        expiresAt: iso(outcome.link.expiresAt),
      };
      delete attempts[name];
      results.push({
        environment: name,
        result: found === undefined ? "linked" : "renewed",
        expiresAt: iso(outcome.link.expiresAt),
        revoked: outcome.revoked,
      });
    }
  // The switch goes off with the last link, only where Lazurio turned it on.
  if (
    desired.size === 0 &&
    enabledByLazurio &&
    Object.keys(links).length === 0
  ) {
    setting = await setLinkedEnvironments(seams.home, false);
    if (switchedOff(setting)) enabledByLazurio = false;
  }
  const next: T3LinksState = {
    version: 1,
    enabledByLazurio,
    links,
    attempts,
    sources: state.sources,
  };
  return { state: next, report: { setting, links: results, unlinked } };
}

/** Revokes every session of a linked T3 Code here; the count, or undefined
 * when T3 Code could not be asked or refused. */
async function revokeLinkSessions(seams: T3LinkSeams) {
  const listed = await local(seams, [
    "auth",
    "session",
    "list",
    "--base-dir",
    base(seams),
    "--json",
  ]);
  const sessions =
    listed === undefined ? undefined : parseSessions(listed.stdout);
  if (sessions === undefined) return undefined;
  let revoked = 0;
  for (const session of sessions.filter(isLinkSession)) {
    const done = await local(seams, [
      "auth",
      "session",
      "revoke",
      "--base-dir",
      base(seams),
      session.sessionId,
    ]);
    if (done === undefined) return undefined;
    revoked += 1;
  }
  return revoked;
}

async function reconcileTarget(
  seams: T3LinkSeams,
  sources: readonly string[],
  state: T3LinksState,
) {
  let enabledByLazurio = state.enabledByLazurio;
  let setting: LinkedSetting | "kept" = "kept";
  if (sources.length > 0) {
    setting = await setLinkedEnvironments(seams.home, true);
    if (setting === "written") enabledByLazurio = true;
  }
  if (sources.length === 0 && enabledByLazurio) {
    // Off first: T3 Code then refuses every linked client at once.
    setting = await setLinkedEnvironments(seams.home, false);
    if (switchedOff(setting)) enabledByLazurio = false;
  }
  const gone = state.sources.filter((name) => !sources.includes(name));
  let revoked: number | "failed" = 0;
  if (gone.length > 0) revoked = (await revokeLinkSessions(seams)) ?? "failed";
  const next: T3LinksState = {
    version: 1,
    enabledByLazurio,
    links: state.links,
    attempts: state.attempts,
    // A revocation that failed is tried again by the next tick.
    sources:
      revoked === "failed"
        ? [...new Set([...state.sources, ...sources])].sort()
        : [...sources],
  };
  return { state: next, report: { setting, sources: [...sources], revoked } };
}

/** One look at the links of this Machine, from its own handover. */
export async function syncT3Links(
  seams: T3LinkSeams,
  machine: MachineBinding | null | undefined,
): Promise<T3LinksReport> {
  const role = t3LinkRole(machine);
  if (role.kind === "none") return { role: "none" };
  const recorded = await readT3LinksState(seams.home, seams.uid);
  const state = recorded ?? emptyT3LinksState;
  const recovered =
    recorded === null ? ({ stateRecovered: true } as const) : {};
  // Nothing to do and nothing of Lazurio's to undo: T3 Code is not asked.
  if (
    recorded !== null &&
    !state.enabledByLazurio &&
    Object.keys(state.links).length === 0 &&
    state.sources.length === 0 &&
    (role.kind === "source"
      ? role.targets.length === 0
      : role.sources.length === 0)
  )
    return { role: role.kind, result: "idle" };
  if (role.kind === "source") {
    const { state: next, report } = await reconcileSource(
      seams,
      role.targets,
      state,
    );
    await writeT3LinksState(seams.home, next);
    return { role: "source", result: "synced", ...report, ...recovered };
  }
  const { state: next, report } = await reconcileTarget(
    seams,
    role.sources,
    state,
  );
  await writeT3LinksState(seams.home, next);
  return { role: "target", result: "synced", ...report, ...recovered };
}

/** `work` under the one lock of every writer of the links, the Launchpad's
 * tick and `lazurio machine t3-links` alike: a kernel `flock`, released
 * when its holder ends. */
export async function withT3LinksLock<T>(
  home: string,
  work: () => Promise<T>,
): Promise<T | Readonly<{ result: "busy" }>> {
  const path = t3LinksLockPath(home);
  let lock: FileLock;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    lock = await acquireFileLock(path, { timeoutMs: 15_000 });
  } catch {
    return { result: "busy" };
  }
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

/** The live loop of the links: every tick reads the handover again, so an
 * edge added or removed takes effect at the next tick; one tick at a time,
 * never awaited and never a reason for its caller to fail. Returns its
 * stop. */
export function runT3Links(
  tick: () => Promise<unknown>,
  timer: Readonly<{
    everyMs: number;
    setInterval: (tick: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  }>,
): () => void {
  let stopped = false;
  let running = false;
  const once = () => {
    if (stopped || running) return;
    running = true;
    void tick()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  once();
  const handle = timer.setInterval(once, timer.everyMs);
  return () => {
    stopped = true;
    timer.clearInterval(handle);
  };
}
