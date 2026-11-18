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
import type { OpenT3Rpc, RpcAnswer, T3Rpc } from "./rpc";
import {
  chatT3Home,
  linkedEnvironmentsKey,
  linkedEnvironmentsOn,
} from "./settings";

// Links between T3 Code servers along the edge from a person's Personal
// Environment to the Work Environments assigned to them (root decision 0157,
// amended 2026-11-17, with 0246, 0247 and 0091). The Organization records the
// edge in its Deployment Repo and its Owner confirms it; Lazurio never
// creates or removes one. Inside an edge that exists Lazurio pairs, renews
// and ends the link itself, and T3 Code stays as it is: threads use its
// standard tools. The whole behaviour is described in `docs/t3-links.md`.
//
// What Lazurio owns, it knows only by identifiers T3 Code itself gave in
// answer to Lazurio's own requests, never by a label, an address or a time.
// An outcome that is not certain is never taken as ownership; it is kept as
// an intent until it can no longer change anything.
//
// - **The source**, a personal Machine, links its running Chat to each
//   assigned Work Environment through the Chat's own RPC (`rpc.ts`): the beta
//   switch through `server.updateSettings`, the link through `peerLinks.link`
//   with a one-time code the target issues for it over the managed SSH route
//   (`lazurio machine t3-link-pair` there). A link is Lazurio's by its peer id
//   and the moment T3 Code linked it (`linkedAt`); T3 Code keeps one link per
//   peer, so a link the person made over it is the person's from then on.
//   Only T3 Code's answer to Lazurio's own request proves a link Lazurio's:
//   after a lost answer or a refusal nothing is ever taken as Lazurio's, and
//   the pairing under way only holds the Environment until its code has
//   certainly expired, also when the edge went meanwhile.
// - **The target**, a work Machine, issues one code at a time, and none
//   while another code is out. Before it does,
//   it records which source it is for and which sessions of linked T3 Code
//   exist already; the new session that appears after it belongs to that
//   source, by its id. Renewal revokes the source's earlier sessions once its
//   new one is there; removal of the edge revokes exactly the sessions it
//   owns, and with the last edge the switch goes off where Lazurio turned it
//   on.
//
// Every change that opens something is written to the state first. A state
// that is there but cannot be read, or that is missing while something may
// be open, closes: the switch goes off and, on the target, every session of a
// linked T3 Code is revoked; only then is a new state written.
//
// The pairing code goes from the target's T3 Code to its Lazurio, over SSH
// into this process and into the RPC request on loopback; it is never on a
// command line, in a file, a log, the state or a report.

/** Renew a link once it has this little left of T3 Code's 30 days. */
export const renewBeforeMs = 7 * 24 * 60 * 60_000;
/** Wait this long after a refused attempt before the next one. */
export const retryAfterMs = 15 * 60_000;
/** How long a pairing code the target issues lives. */
export const pairingTtl = "2m";
/** After this, a code has certainly expired and its session, if any, been
 * issued: T3 Code's code lives two minutes and the sign-in that spends it
 * ends within its request's time. */
export const pairingSettledAfterMs = 5 * 60_000;
/** A source's pairing under way is certainly over after this. */
export const pendingSettledAfterMs = 10 * 60_000;
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
  | "node-unknown"
  | "target-unreachable"
  | "pairing-refused"
  | "link-refused";

type RecordedLink = Readonly<{
  peerEnvironmentId: string;
  linkedAt: string;
  expiresAt: string;
}>;
type FailedAttempt = Readonly<{ at: string; cause: LinkFailure }>;
/** Target: a code issued for a source, not yet settled. */
type IssuedPairing = Readonly<{
  /** T3 Code's id of the code; null until it is known. */
  pairingId: string | null;
  issuedAt: string;
  /** The sessions of linked T3 Code that existed before the code. */
  before: readonly string[];
}>;
type Inbound = Readonly<{
  /** The sessions this source owns, by T3 Code's id. */
  sessions: readonly string[];
  pairing: IssuedPairing | null;
}>;

export type T3LinksState = Readonly<{
  version: 3;
  /** Lazurio turned the Chat's beta switch on, or is turning it on. */
  enabledByLazurio: boolean;
  /** Source: the links Lazurio made, by Environment id. */
  links: Readonly<Record<string, RecordedLink>>;
  /** Source: a pairing under way, by Environment id, since when. */
  pending: Readonly<Record<string, string>>;
  /** Source: the last refused attempt, by Environment id. */
  attempts: Readonly<Record<string, FailedAttempt>>;
  /** Target: the inbound sources and what each owns. */
  inbound: Readonly<Record<string, Inbound>>;
}>;

export const emptyT3LinksState: T3LinksState = Object.freeze({
  version: 3,
  enabledByLazurio: false,
  links: {},
  pending: {},
  attempts: {},
  inbound: {},
});

export const t3LinksStatePath = (home: string) =>
  join(home, ".local", "state", "lazurio", "t3-links.json");
const t3LinksLockPath = (home: string) =>
  join(home, ".local", "state", "lazurio", "t3-links.lock");

const failures: readonly LinkFailure[] = [
  "node-unknown",
  "target-unreachable",
  "pairing-refused",
  "link-refused",
];
const idToken = /^[A-Za-z0-9-]{1,64}$/;
const peerName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((id) => typeof id === "string" && idToken.test(id));

/** The state as recorded, exactly; null for anything else. */
export function parseT3LinksState(value: unknown): T3LinksState | null {
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    typeof value.enabledByLazurio !== "boolean" ||
    !isRecord(value.links) ||
    !isRecord(value.pending) ||
    !isRecord(value.attempts) ||
    !isRecord(value.inbound)
  )
    return null;
  const links: Record<string, RecordedLink> = {};
  for (const [name, link] of Object.entries(value.links)) {
    if (
      !isEnvironmentId(name) ||
      !isRecord(link) ||
      typeof link.peerEnvironmentId !== "string" ||
      !idToken.test(link.peerEnvironmentId) ||
      !instant(link.linkedAt) ||
      !instant(link.expiresAt)
    )
      return null;
    links[name] = {
      peerEnvironmentId: link.peerEnvironmentId,
      linkedAt: link.linkedAt,
      expiresAt: link.expiresAt,
    };
  }
  const pending: Record<string, string> = {};
  for (const [name, at] of Object.entries(value.pending)) {
    if (!isEnvironmentId(name) || !instant(at)) return null;
    pending[name] = at;
  }
  const attempts: Record<string, FailedAttempt> = {};
  for (const [name, attempt] of Object.entries(value.attempts)) {
    if (
      !isEnvironmentId(name) ||
      !isRecord(attempt) ||
      !instant(attempt.at) ||
      !failures.includes(attempt.cause as LinkFailure)
    )
      return null;
    attempts[name] = { at: attempt.at, cause: attempt.cause as LinkFailure };
  }
  const inbound: Record<string, Inbound> = {};
  for (const [name, entry] of Object.entries(value.inbound)) {
    if (!peerName.test(name) || !isRecord(entry) || !ids(entry.sessions))
      return null;
    const pairing = entry.pairing;
    if (
      pairing !== null &&
      !(
        isRecord(pairing) &&
        (pairing.pairingId === null ||
          (typeof pairing.pairingId === "string" &&
            idToken.test(pairing.pairingId))) &&
        instant(pairing.issuedAt) &&
        ids(pairing.before)
      )
    )
      return null;
    inbound[name] = {
      sessions: [...entry.sessions],
      pairing:
        pairing === null
          ? null
          : {
              pairingId: pairing.pairingId as string | null,
              issuedAt: pairing.issuedAt as string,
              before: [...(pairing.before as string[])],
            },
    };
  }
  return {
    version: 3,
    enabledByLazurio: value.enabledByLazurio,
    links,
    pending,
    attempts,
    inbound,
  };
}

export type RecordedState =
  | Readonly<{ kind: "recorded"; state: T3LinksState }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "damaged" }>;

/** The recorded state: missing, recorded, or damaged (a file is there that
 * is not the state, or cannot be read). */
export async function readT3LinksState(
  home: string,
  uid: number | undefined,
): Promise<RecordedState> {
  const observed = await readOwnFile(t3LinksStatePath(home), uid).catch(
    () => ({ kind: "refused" }) as const,
  );
  if (observed.kind === "missing") return { kind: "missing" };
  if (observed.kind !== "file") return { kind: "damaged" };
  try {
    const state = parseT3LinksState(
      JSON.parse(observed.bytes.toString("utf8")),
    );
    return state === null ? { kind: "damaged" } : { kind: "recorded", state };
  } catch {
    return { kind: "damaged" };
  }
}

export async function writeT3LinksState(home: string, state: T3LinksState) {
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

export type LinkSummary = Readonly<{
  environmentId: string;
  urls: readonly string[];
  linkedAt: number;
  expiresAt: number;
  status: string;
  lastError: string | null;
}>;
export type LinkSession = Readonly<{
  sessionId: string;
  subject: string;
  label: string | null;
}>;

function linkSummary(item: unknown): LinkSummary | undefined {
  if (
    !isRecord(item) ||
    typeof item.environmentId !== "string" ||
    !idToken.test(item.environmentId) ||
    !Array.isArray(item.urls) ||
    !item.urls.every((url) => typeof url === "string") ||
    !instant(item.linkedAt) ||
    !instant(item.expiresAt) ||
    !(item.lastError === null || typeof item.lastError === "string")
  )
    return undefined;
  return {
    environmentId: item.environmentId,
    urls: item.urls as string[],
    linkedAt: Date.parse(item.linkedAt),
    expiresAt: Date.parse(item.expiresAt),
    status: typeof item.status === "string" ? item.status : "reachable",
    lastError: item.lastError,
  };
}

/** `peerLinks.list`'s answer. */
export function parseLinkList(value: unknown): LinkSummary[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.links)) return undefined;
  const links = value.links.map(linkSummary);
  return links.every((link) => link !== undefined)
    ? (links as LinkSummary[])
    : undefined;
}

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

/** `t3 auth pairing list --json`: the ids of the codes still active. */
export function parsePairingIds(stdout: string): string[] | undefined {
  const value = jsonFrom(stdout, "[");
  if (!Array.isArray(value)) return undefined;
  const found: string[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !idToken.test(item.id)
    )
      return undefined;
    found.push(item.id);
  }
  return found;
}

/** A pairing as T3 Code prints it (`t3 auth pairing create --json`) and as
 * `lazurio machine t3-link-pair` passes it on: its id and the code, which
 * never leaves memory but for the RPC request that spends it. */
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

/** A session of a linked T3 Code. Only for closing, which errs on the side
 * of revoking: ownership never rests on this. */
const isLinkSession = (session: LinkSession) =>
  session.subject === "mcp-client" &&
  session.label !== null &&
  session.label.startsWith(linkClientPrefix);

/** A refusal T3 Code answered: certain that nothing was linked. A timeout, a
 * closed socket or a defect is not: the link may exist. */
const certainRefusal = (answer: RpcAnswer) =>
  !answer.ok &&
  (answer.error.startsWith("PeerLinkError") ||
    answer.error.startsWith("EnvironmentAuthorizationError"));

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
  /** This Machine's tailnet node, as the edges name it; none when unknown. */
  node: string | null;
  /** The running Chat's RPC, for one look. */
  rpc: OpenT3Rpc;
}>;

const remoteTimeoutMs = 45_000;
const localTimeoutMs = 60_000;
const safeToken = /^[A-Za-z0-9._:-]+$/;

const base = (seams: T3LinkSeams) => join(seams.home, chatT3Home);
const environment = (seams: T3LinkSeams) => ({
  HOME: seams.home,
  ...(seams.path ? { PATH: seams.path } : {}),
});
const iso = (time: number) => new Date(time).toISOString();

/** A command on the target, over the managed route `ssh <id>`, as its
 * account: its `t3` on its Chat's home, or its `lazurio`. Every argument is
 * one checked token. */
async function onTarget(
  seams: T3LinkSeams,
  target: string,
  program: "t3" | "lazurio",
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
    `"$HOME/.local/bin/${program}"`,
    ...command,
    ...(program === "t3" ? ["--base-dir", '"$HOME/.t3"'] : []),
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

async function local(seams: T3LinkSeams, command: readonly string[]) {
  const result = await seams
    .run([seams.t3, ...command], localTimeoutMs, environment(seams))
    .catch(() => "timeout" as const);
  return result === "timeout" || result.exitCode !== 0 ? undefined : result;
}

const localSessions = async (seams: T3LinkSeams) => {
  const listed = await local(seams, [
    "auth",
    "session",
    "list",
    "--base-dir",
    base(seams),
    "--json",
  ]);
  return listed === undefined ? undefined : parseSessions(listed.stdout);
};

const localPairings = async (seams: T3LinkSeams) => {
  const listed = await local(seams, [
    "auth",
    "pairing",
    "list",
    "--base-dir",
    base(seams),
    "--json",
  ]);
  return listed === undefined ? undefined : parsePairingIds(listed.stdout);
};

/** Revokes these sessions here; false when T3 Code refused one. A session
 * already gone counts as revoked (T3 Code answers it so). */
async function revokeSessions(seams: T3LinkSeams, sessions: readonly string[]) {
  for (const sessionId of sessions)
    if (
      (await local(seams, [
        "auth",
        "session",
        "revoke",
        "--base-dir",
        base(seams),
        sessionId,
      ])) === undefined
    )
      return false;
  return true;
}

/** The running Chat's RPC, opened at most once per look and closed after. */
function lazyRpc(seams: T3LinkSeams) {
  let opened: Promise<T3Rpc | "server-down" | "refused"> | undefined;
  return {
    get: () => {
      opened ??= seams.rpc();
      return opened;
    },
    async close() {
      if (opened === undefined) return;
      const rpc = await opened;
      if (typeof rpc !== "string") await rpc.close();
    },
  };
}

async function setSwitch(rpc: T3Rpc, on: boolean) {
  const answer = await rpc.request("server.updateSettings", {
    patch: { [linkedEnvironmentsKey]: on },
  });
  return answer.ok;
}

type Persist = (state: T3LinksState) => Promise<void>;
function stateUpdater(initial: T3LinksState, persist: Persist) {
  let state = initial;
  return {
    get: () => state,
    async set(next: T3LinksState) {
      state = next;
      await persist(state);
    },
  };
}
const without = <T>(record: Readonly<Record<string, T>>, key: string) => {
  const { [key]: _gone, ...rest } = record;
  return rest;
};

// ---- The source -------------------------------------------------------------

export type T3LinkResult =
  | Readonly<{ environment: string; result: "current"; expiresAt: string }>
  | Readonly<{
      environment: string;
      result: "linked" | "renewed";
      expiresAt: string;
    }>
  | Readonly<{
      environment: string;
      result: "waiting" | "failed";
      cause: LinkFailure;
    }>
  | Readonly<{ environment: string; result: "uncertain" | "person-link" }>;

export type SwitchResult = "on" | "off" | "kept" | "unknown" | "failed";

export type T3LinksReport =
  | Readonly<{ role: "none" }>
  | Readonly<{ role: "source" | "target"; result: "idle" }>
  | Readonly<{
      role: "source" | "target";
      result: "server-down" | "closed" | "close-failed";
      state?: "missing" | "damaged";
    }>
  | Readonly<{
      role: "source";
      result: "synced";
      switch: SwitchResult;
      links: readonly T3LinkResult[];
      unlinked: readonly string[];
    }>
  | Readonly<{
      role: "target";
      result: "synced";
      switch: SwitchResult;
      sources: readonly string[];
      revoked: number | "failed";
      /** Removed sources whose last code is still being settled. */
      settling: readonly string[];
    }>;

/** Is this link the one Lazurio recorded: the same peer and the same moment
 * T3 Code linked it? A link the person made over it has another moment. */
const isRecorded = (link: LinkSummary, recorded: RecordedLink | undefined) =>
  recorded !== undefined &&
  link.environmentId === recorded.peerEnvironmentId &&
  link.linkedAt === Date.parse(recorded.linkedAt);

const recordOf = (link: LinkSummary): RecordedLink => ({
  peerEnvironmentId: link.environmentId,
  linkedAt: iso(link.linkedAt),
  expiresAt: iso(link.expiresAt),
});

type PairOutcome =
  | Readonly<{ kind: "linked"; link: LinkSummary }>
  | Readonly<{ kind: "refused"; cause: LinkFailure }>
  | Readonly<{ kind: "uncertain" }>;

/** One pairing and link into `target`. The target settles its sessions
 * after it (`t3-link-settle`), and again on its own look. */
async function pairAndLink(
  seams: T3LinkSeams,
  rpc: T3Rpc,
  target: string,
  origin: string,
  node: string,
): Promise<PairOutcome> {
  const issued = await onTarget(seams, target, "lazurio", [
    "machine",
    "t3-link-pair",
    "--source",
    node,
  ]);
  if (issued === undefined)
    return { kind: "refused", cause: "target-unreachable" };
  const pairing = parsePairing(issued.stdout);
  if (pairing === undefined)
    return { kind: "refused", cause: "pairing-refused" };
  const answer = await rpc.request("peerLinks.link", {
    url: origin,
    pairingCode: pairing.credential,
    access: linkAccess,
  });
  const link = answer.ok ? linkSummary(answer.value) : undefined;
  if (link === undefined && certainRefusal(answer))
    // An unspent code is not left behind.
    await onTarget(
      seams,
      target,
      "t3",
      ["auth", "pairing", "revoke"],
      pairing.id,
    );
  await onTarget(seams, target, "lazurio", [
    "machine",
    "t3-link-settle",
    "--source",
    node,
  ]);
  if (link !== undefined) return { kind: "linked", link };
  return certainRefusal(answer)
    ? { kind: "refused", cause: "link-refused" }
    : { kind: "uncertain" };
}

async function reconcileSource(
  seams: T3LinkSeams,
  rpc: T3Rpc,
  targets: readonly AssignedEnvironment[],
  initial: T3LinksState,
  persist: Persist,
): Promise<T3LinksReport> {
  const now = seams.now();
  const state = stateUpdater(initial, persist);
  const desired = new Set(targets.map((target) => target.environment));
  const on = await linkedEnvironmentsOn(seams.home);
  let switched: SwitchResult = on === null ? "unknown" : "kept";
  if (desired.size > 0 && on === false) {
    // Intent first: Lazurio owns the switch from before it turns it on.
    await state.set({ ...state.get(), enabledByLazurio: true });
    switched = (await setSwitch(rpc, true)) ? "on" : "failed";
  }
  const results: T3LinkResult[] = [];
  const unlinked: string[] = [];
  const listing = await rpc.request("peerLinks.list", {});
  const listed = listing.ok ? parseLinkList(listing.value) : undefined;
  // Without T3 Code's list nothing is settled, forgotten or linked.
  if (listed !== undefined) {
    const at = (name: string) =>
      listed.find((link) => link.urls.includes(t3LinkOrigin(name) as string));
    // A pairing whose answer never came is never taken as Lazurio's: T3
    // Code's list cannot tell its link from one the person made after it,
    // and nothing else proves it. It holds the Environment until its code
    // has certainly expired, so no second pairing runs over it, and then
    // ends, wherever its edge is now. A link it may have made is the
    // person's from then on; the target revokes the session of its code by
    // its own record when the edge goes, so nothing stays open.
    for (const [name, since] of Object.entries(state.get().pending))
      if (now - Date.parse(since) >= pendingSettledAfterMs)
        await state.set({
          ...state.get(),
          pending: without(state.get().pending, name),
        });
    // Lazurio's own links whose edge went, by their recorded identity.
    for (const [name, recorded] of Object.entries(state.get().links)) {
      if (desired.has(name)) continue;
      const found = at(name);
      if (found !== undefined && isRecorded(found, recorded)) {
        const answer = await rpc.request("peerLinks.unlink", {
          environmentId: recorded.peerEnvironmentId,
        });
        if (!answer.ok) continue;
        unlinked.push(name);
      }
      // Gone already, or the person's now: no longer Lazurio's either way.
      await state.set({
        ...state.get(),
        links: without(state.get().links, name),
      });
    }
    for (const name of Object.keys(state.get().attempts))
      if (!desired.has(name))
        await state.set({
          ...state.get(),
          attempts: without(state.get().attempts, name),
        });
    const switchOn = on === true || switched === "on";
    for (const name of desired) {
      if (!switchOn) break;
      const origin = t3LinkOrigin(name) as string;
      const found = at(name);
      const recorded = state.get().links[name];
      if (state.get().pending[name] !== undefined) {
        results.push({ environment: name, result: "uncertain" });
        continue;
      }
      const ours = found !== undefined && isRecorded(found, recorded);
      if (recorded !== undefined && !ours)
        // Lazurio's link is gone or was replaced by the person's.
        await state.set({
          ...state.get(),
          links: without(state.get().links, name),
        });
      // A link Lazurio did not record is the person's whatever its status:
      // an expired one stays theirs to renew or remove (docs/t3-links.md).
      if (found !== undefined && !ours) {
        results.push({ environment: name, result: "person-link" });
        continue;
      }
      if (
        found !== undefined &&
        ours &&
        found.status !== "expired" &&
        found.lastError === null &&
        found.expiresAt - now > renewBeforeMs
      ) {
        results.push({
          environment: name,
          result: "current",
          expiresAt: iso(found.expiresAt),
        });
        continue;
      }
      const attempt = state.get().attempts[name];
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
      if (seams.node === null) {
        await state.set({
          ...state.get(),
          attempts: {
            ...state.get().attempts,
            [name]: { at: iso(now), cause: "node-unknown" },
          },
        });
        results.push({
          environment: name,
          result: "failed",
          cause: "node-unknown",
        });
        continue;
      }
      // Intent first: a pairing cut off from here on is settled later.
      await state.set({
        ...state.get(),
        pending: { ...state.get().pending, [name]: iso(now) },
      });
      const outcome = await pairAndLink(seams, rpc, name, origin, seams.node);
      // Only T3 Code's own answer to this request proves a link Lazurio's.
      if (outcome.kind === "uncertain") {
        results.push({ environment: name, result: "uncertain" });
        continue;
      }
      const pending = without(state.get().pending, name);
      if (outcome.kind === "refused") {
        await state.set({
          ...state.get(),
          pending,
          attempts: {
            ...state.get().attempts,
            [name]: { at: iso(now), cause: outcome.cause },
          },
        });
        results.push({
          environment: name,
          result: "failed",
          cause: outcome.cause,
        });
        continue;
      }
      await state.set({
        ...state.get(),
        links: { ...state.get().links, [name]: recordOf(outcome.link) },
        pending,
        attempts: without(state.get().attempts, name),
      });
      results.push({
        environment: name,
        result: ours ? "renewed" : "linked",
        expiresAt: iso(outcome.link.expiresAt),
      });
    }
  }
  // The switch goes off with the last link, only where Lazurio turned it on.
  const current = state.get();
  if (
    listed !== undefined &&
    desired.size === 0 &&
    current.enabledByLazurio &&
    Object.keys(current.links).length === 0 &&
    Object.keys(current.pending).length === 0
  ) {
    if (on === false || (await setSwitch(rpc, false))) {
      await state.set({ ...state.get(), enabledByLazurio: false });
      switched = "off";
    } else switched = "failed";
  }
  return {
    role: "source",
    result: "synced",
    switch: switched,
    links: results,
    unlinked,
  };
}

// ---- The target -------------------------------------------------------------

/** Settles the codes the target issued: once a code is spent or gone, the
 * sessions of linked T3 Code that appeared after it and that nobody owns are
 * its source's, by id, and that source's earlier sessions are revoked; a
 * code with no such session is over once it has certainly expired. Only one
 * code is out at a time, so what appeared after it is its own. False when T3
 * Code could not be asked or refused a revocation; the code then stays. */
async function settlePairings(
  seams: T3LinkSeams,
  state: ReturnType<typeof stateUpdater>,
  only?: string,
): Promise<boolean> {
  const open = Object.entries(state.get().inbound).filter(
    ([name, entry]) => entry.pairing !== null && (only ?? name) === name,
  );
  if (open.length === 0) return true;
  const [sessions, active] = [
    await localSessions(seams),
    await localPairings(seams),
  ];
  if (sessions === undefined || active === undefined) return false;
  const now = seams.now();
  for (const [name, entry] of open) {
    const pairing = entry.pairing as IssuedPairing;
    const owned = new Set(
      Object.values(state.get().inbound).flatMap((other) => other.sessions),
    );
    const before = new Set(pairing.before);
    const fresh = sessions
      .filter(
        (session) =>
          isLinkSession(session) &&
          !before.has(session.sessionId) &&
          !owned.has(session.sessionId),
      )
      .map((session) => session.sessionId);
    const expired = now - Date.parse(pairing.issuedAt) >= pairingSettledAfterMs;
    const spent =
      pairing.pairingId !== null && !active.includes(pairing.pairingId);
    if (fresh.length > 0 && (spent || expired)) {
      // Renewal: the earlier sessions go once the new one is there.
      if (!(await revokeSessions(seams, entry.sessions))) return false;
      await state.set({
        ...state.get(),
        inbound: {
          ...state.get().inbound,
          [name]: { sessions: fresh, pairing: null },
        },
      });
    } else if (expired)
      await state.set({
        ...state.get(),
        inbound: {
          ...state.get().inbound,
          [name]: { sessions: entry.sessions, pairing: null },
        },
      });
  }
  return true;
}

async function reconcileTarget(
  seams: T3LinkSeams,
  rpc: T3Rpc,
  sources: readonly string[],
  initial: T3LinksState,
  persist: Persist,
): Promise<T3LinksReport> {
  const state = stateUpdater(initial, persist);
  // Every current source is recorded before anything is opened for it.
  const unseen = sources.filter((name) => !(name in state.get().inbound));
  if (unseen.length > 0)
    await state.set({
      ...state.get(),
      inbound: {
        ...state.get().inbound,
        ...Object.fromEntries(
          unseen.map((name) => [name, { sessions: [], pairing: null }]),
        ),
      },
    });
  const on = await linkedEnvironmentsOn(seams.home);
  let switched: SwitchResult = on === null ? "unknown" : "kept";
  if (sources.length > 0 && on === false) {
    await state.set({ ...state.get(), enabledByLazurio: true });
    switched = (await setSwitch(rpc, true)) ? "on" : "failed";
  }
  // With the last edge, off first: T3 Code then refuses every linked client
  // at once; only where Lazurio turned it on.
  if (sources.length === 0 && state.get().enabledByLazurio && on !== false)
    switched = (await setSwitch(rpc, false)) ? "off" : "failed";
  let revoked: number | "failed" = 0;
  const gone = Object.keys(state.get().inbound).filter(
    (name) => !sources.includes(name),
  );
  // A code still out for a source whose edge went is revoked, and what it
  // may have opened is settled before that source is let go.
  for (const name of gone) {
    const pairing = state.get().inbound[name]?.pairing;
    if (pairing?.pairingId)
      await local(seams, [
        "auth",
        "pairing",
        "revoke",
        "--base-dir",
        base(seams),
        pairing.pairingId,
      ]);
  }
  if (!(await settlePairings(seams, state))) revoked = "failed";
  for (const name of gone) {
    const entry = state.get().inbound[name];
    if (entry === undefined || entry.pairing !== null) continue;
    if (!(await revokeSessions(seams, entry.sessions))) {
      revoked = "failed";
      continue;
    }
    if (revoked !== "failed") revoked += entry.sessions.length;
    await state.set({
      ...state.get(),
      inbound: without(state.get().inbound, name),
    });
  }
  // A code of a removed edge that is still settling keeps its source until
  // the next look settles it.
  const settling = gone.filter((name) => state.get().inbound[name]?.pairing);
  if (
    sources.length === 0 &&
    state.get().enabledByLazurio &&
    switched !== "failed" &&
    Object.keys(state.get().inbound).length === 0
  )
    await state.set({ ...state.get(), enabledByLazurio: false });
  return {
    role: "target",
    result: "synced",
    switch: switched,
    sources: [...sources],
    revoked,
    settling,
  };
}

// ---- Closing ------------------------------------------------------------------

/** Whether something of Lazurio's may be open without a state that says so:
 * the switch on, or on the target a session of a linked T3 Code. */
async function mayBeOpen(seams: T3LinkSeams, role: "source" | "target") {
  if ((await linkedEnvironmentsOn(seams.home)) !== false) return true;
  if (role === "source") return false;
  const sessions = await localSessions(seams);
  return sessions === undefined || sessions.some(isLinkSession);
}

/** Fails closed: the switch off and, on the target, every session of a
 * linked T3 Code revoked. True only when both are done. */
async function close(
  seams: T3LinkSeams,
  rpc: T3Rpc,
  role: "source" | "target",
) {
  if (
    (await linkedEnvironmentsOn(seams.home)) !== false &&
    !(await setSwitch(rpc, false))
  )
    return false;
  if (role === "source") return true;
  const sessions = await localSessions(seams);
  return (
    sessions !== undefined &&
    (await revokeSessions(
      seams,
      sessions.filter(isLinkSession).map((session) => session.sessionId),
    ))
  );
}

// ---- One look -----------------------------------------------------------------

/** One look at the links of this Machine, from its own handover. */
export async function syncT3Links(
  seams: T3LinkSeams,
  machine: MachineBinding | null | undefined,
): Promise<T3LinksReport> {
  const role = t3LinkRole(machine);
  if (role.kind === "none") return { role: "none" };
  const edges =
    role.kind === "source" ? role.targets.length : role.sources.length;
  const recorded = await readT3LinksState(seams.home, seams.uid);
  // Nothing to do and, by a recorded state, nothing of Lazurio's to undo:
  // T3 Code is not asked. Only a recorded state says so; a missing one is
  // looked at first, below.
  if (
    edges === 0 &&
    recorded.kind === "recorded" &&
    !recorded.state.enabledByLazurio &&
    Object.keys(recorded.state.links).length === 0 &&
    Object.keys(recorded.state.pending).length === 0 &&
    Object.keys(recorded.state.inbound).length === 0
  )
    return { role: role.kind, result: "idle" };
  const rpcs = lazyRpc(seams);
  const persist: Persist = (state) => writeT3LinksState(seams.home, state);
  try {
    let state: T3LinksState;
    if (recorded.kind === "recorded") state = recorded.state;
    else if (
      recorded.kind === "missing" &&
      !(await mayBeOpen(seams, role.kind))
    ) {
      // Shown to be closed: an empty state from here on, so the next looks
      // without an edge are idle without asking T3 Code again.
      state = emptyT3LinksState;
      await persist(state);
      if (edges === 0) return { role: role.kind, result: "idle" };
    } else {
      // Missing while something may be open, or damaged: fail closed. The
      // new state is written only once everything is closed.
      const rpc = await rpcs.get();
      const closed =
        typeof rpc !== "string" && (await close(seams, rpc, role.kind));
      if (closed) await persist(emptyT3LinksState);
      return {
        role: role.kind,
        result: closed ? "closed" : "close-failed",
        state: recorded.kind,
      };
    }
    const rpc = await rpcs.get();
    if (typeof rpc === "string")
      return { role: role.kind, result: "server-down" };
    return role.kind === "source"
      ? await reconcileSource(seams, rpc, role.targets, state, persist)
      : await reconcileTarget(seams, rpc, role.sources, state, persist);
  } finally {
    await rpcs.close();
  }
}

// ---- The target's half of a pairing ----------------------------------------

export type PairingAnswer =
  | Readonly<{ kind: "issued"; id: string; credential: string }>
  | Readonly<{
      kind: "refused";
      reason:
        | "not-a-target"
        | "not-a-source"
        | "state-unusable"
        | "server-down"
        | "switch-failed"
        | "close-failed"
        | "busy"
        | "pairing-failed";
    }>;

/** The target's state for one of its commands, or why there is none: a
 * damaged one is refused, a missing one closes what may be open first. */
async function targetState(
  seams: T3LinkSeams,
  rpc: T3Rpc,
): Promise<T3LinksState | "state-unusable" | "close-failed"> {
  const recorded = await readT3LinksState(seams.home, seams.uid);
  if (recorded.kind === "damaged") return "state-unusable";
  if (recorded.kind === "recorded") return recorded.state;
  if (
    (await mayBeOpen(seams, "target")) &&
    !(await close(seams, rpc, "target"))
  )
    return "close-failed";
  await writeT3LinksState(seams.home, emptyT3LinksState);
  return emptyT3LinksState;
}

/** On the target: a one-time code for the inbound source `source`, issued
 * only while this Machine's handover names `source` as an inbound edge and
 * no other source's code is out. The source, the time and the sessions that
 * exist already are recorded, and the switch is on, before the code exists;
 * its id follows it. */
export async function issueLinkPairing(
  seams: T3LinkSeams,
  machine: MachineBinding | null | undefined,
  source: string,
): Promise<PairingAnswer> {
  const role = t3LinkRole(machine);
  if (role.kind !== "target")
    return { kind: "refused", reason: "not-a-target" };
  if (!role.sources.includes(source))
    return { kind: "refused", reason: "not-a-source" };
  const rpcs = lazyRpc(seams);
  let state: ReturnType<typeof stateUpdater>;
  try {
    const rpc = await rpcs.get();
    if (typeof rpc === "string")
      return { kind: "refused", reason: "server-down" };
    const found = await targetState(seams, rpc);
    if (typeof found === "string") return { kind: "refused", reason: found };
    state = stateUpdater(found, (next) => writeT3LinksState(seams.home, next));
    // This source's own code still out is revoked: a new one replaces it.
    const own = state.get().inbound[source]?.pairing;
    if (own?.pairingId)
      await local(seams, [
        "auth",
        "pairing",
        "revoke",
        "--base-dir",
        base(seams),
        own.pairingId,
      ]);
    if (!(await settlePairings(seams, state)))
      return { kind: "refused", reason: "busy" };
    // No code while another is out, Lazurio's or one the person issued, so
    // the one session that appears for this code is its own.
    const active = await localPairings(seams);
    if (
      active === undefined ||
      active.length > 0 ||
      Object.values(state.get().inbound).some((entry) => entry.pairing !== null)
    )
      return { kind: "refused", reason: "busy" };
    const sessions = await localSessions(seams);
    const on = await linkedEnvironmentsOn(seams.home);
    if (sessions === undefined || on === null)
      return { kind: "refused", reason: "switch-failed" };
    const entry = state.get().inbound[source] ?? {
      sessions: [],
      pairing: null,
    };
    await state.set({
      ...state.get(),
      enabledByLazurio: state.get().enabledByLazurio || !on,
      inbound: {
        ...state.get().inbound,
        [source]: {
          sessions: entry.sessions,
          pairing: {
            pairingId: null,
            issuedAt: iso(seams.now()),
            before: sessions
              .filter(isLinkSession)
              .map((session) => session.sessionId),
          },
        },
      },
    });
    if (!on && !(await setSwitch(rpc, true)))
      return { kind: "refused", reason: "switch-failed" };
  } finally {
    await rpcs.close();
  }
  const issued = await local(seams, [
    "auth",
    "pairing",
    "create",
    "--base-dir",
    base(seams),
    "--ttl",
    pairingTtl,
    "--label",
    "lazurio-link",
    "--json",
  ]);
  const pairing =
    issued === undefined ? undefined : parsePairing(issued.stdout);
  if (pairing === undefined)
    return { kind: "refused", reason: "pairing-failed" };
  const entry = state.get().inbound[source] as Inbound;
  await state.set({
    ...state.get(),
    inbound: {
      ...state.get().inbound,
      [source]: {
        ...entry,
        pairing: { ...(entry.pairing as IssuedPairing), pairingId: pairing.id },
      },
    },
  });
  return { kind: "issued", ...pairing };
}

/** On the target, right after a source's link attempt: its code settled at
 * once rather than at the next look. */
export async function settleLinkPairing(
  seams: T3LinkSeams,
  machine: MachineBinding | null | undefined,
  source: string,
): Promise<"settled" | "pending" | "refused"> {
  if (t3LinkRole(machine).kind !== "target") return "refused";
  const recorded = await readT3LinksState(seams.home, seams.uid);
  if (recorded.kind !== "recorded") return "refused";
  const state = stateUpdater(recorded.state, (next) =>
    writeT3LinksState(seams.home, next),
  );
  if (!(await settlePairings(seams, state, source))) return "refused";
  return state.get().inbound[source]?.pairing ? "pending" : "settled";
}

// ---- Lock and loop ------------------------------------------------------------

/** `work` under the one lock of every writer of the links, the Launchpad's
 * tick and `lazurio machine t3-links`, `t3-link-pair` and `t3-link-settle`
 * alike: a kernel `flock`, released when its holder ends. */
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
