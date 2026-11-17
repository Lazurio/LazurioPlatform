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
import type { OpenT3Rpc, T3Rpc } from "./rpc";
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
// Each end acts only on its own handover:
//
// - **The source**, a personal Machine, links its running Chat to each
//   assigned Work Environment through the Chat's own RPC (`rpc.ts`): the
//   beta switch through `server.updateSettings`, the link through
//   `peerLinks.link` with a one-time code the target issues for it over the
//   managed SSH route (`lazurio machine t3-link-pair` there). A link is
//   Lazurio's only by the peer id it recorded; a link at the same address
//   that Lazurio did not make is the person's and is never renewed or
//   forgotten. Renewal comes seven days before T3 Code's 30-day token ends
//   or when the link fails; a failed attempt waits fifteen minutes.
// - **The target**, a work Machine, records which inbound source asked for a
//   code under which label, before it issues one. When an inbound edge goes,
//   it revokes exactly the sessions of that source's label, and with its last
//   edge it turns the switch off where Lazurio turned it on.
//
// Every change that opens something is written to the state first, as an
// intent (the switch Lazurio is turning on, the pairing under way, the
// source and label a code is issued for), and confirmed after it, so a look
// cut off at any point leaves a state from which the next look knows what to
// undo. A state that is there but cannot be read, or that is missing while
// something of Lazurio's may be open, closes: the switch goes off and, on
// the target, every session of a linked T3 Code is revoked; only then is a
// new state written, and the next look builds again from the handover.
//
// The pairing code goes from the target's T3 Code to its Lazurio, over SSH
// into this process and into the RPC request on loopback; it is never on a
// command line, in a file, a log, the state or a report.

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

// ---- Labels -------------------------------------------------------------------

/** A label as T3 Code keeps one: trimmed, one line, at most 128 characters. */
export function environmentLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label.length > 0 && label.length <= 128 && !/\p{Cc}/u.test(label)
    ? label
    : undefined;
}

/** A label as one shell-safe token (base64url of its UTF-8). */
export const encodeLabel = (label: string) =>
  Buffer.from(label, "utf8").toString("base64url");
export function decodeLabel(token: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) return undefined;
  const label = Buffer.from(token, "base64url").toString("utf8");
  return encodeLabel(label) === token ? environmentLabel(label) : undefined;
}

// ---- State ----------------------------------------------------------------

export type LinkFailure =
  | "label-unknown"
  | "target-unreachable"
  | "pairing-refused"
  | "link-refused";

type RecordedLink = Readonly<{ peerEnvironmentId: string; expiresAt: string }>;
type FailedAttempt = Readonly<{ at: string; cause: LinkFailure }>;

export type T3LinksState = Readonly<{
  version: 2;
  /** Lazurio turned the Chat's beta switch on, or is turning it on. */
  enabledByLazurio: boolean;
  /** Source: the links Lazurio made, by Environment id, with their peer id. */
  links: Readonly<Record<string, RecordedLink>>;
  /** Source: a pairing under way, by Environment id, since when. */
  pending: Readonly<Record<string, string>>;
  /** Source: the last failed attempt, by Environment id. */
  attempts: Readonly<Record<string, FailedAttempt>>;
  /** Target: the inbound sources, each with the label it paired under. */
  inbound: Readonly<Record<string, string | null>>;
}>;

export const emptyT3LinksState: T3LinksState = Object.freeze({
  version: 2,
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
  "label-unknown",
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

/** The state as recorded, exactly; null for anything else. */
export function parseT3LinksState(value: unknown): T3LinksState | null {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
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
      !instant(link.expiresAt)
    )
      return null;
    links[name] = {
      peerEnvironmentId: link.peerEnvironmentId,
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
  const inbound: Record<string, string | null> = {};
  for (const [name, label] of Object.entries(value.inbound)) {
    if (
      !peerName.test(name) ||
      !(label === null || environmentLabel(label) === label)
    )
      return null;
    inbound[name] = label as string | null;
  }
  return {
    version: 2,
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
    !instant(item.expiresAt) ||
    !(item.lastError === null || typeof item.lastError === "string")
  )
    return undefined;
  return {
    environmentId: item.environmentId,
    urls: item.urls as string[],
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
  /** This Machine's tailnet node, as the edges name it; none when unknown. */
  node: string | null;
  /** The label the running Chat answers with; none when it does not. */
  label: () => Promise<string | undefined>;
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

const targetSessions = async (seams: T3LinkSeams, target: string) => {
  const result = await onTarget(seams, target, "t3", [
    "auth",
    "session",
    "list",
    "--json",
  ]);
  return result === undefined ? undefined : parseSessions(result.stdout);
};

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

// ---- The source -------------------------------------------------------------

type Linked = Readonly<{ kind: "linked"; link: LinkSummary; revoked: number }>;
type Failed = Readonly<{ kind: "failed"; cause: LinkFailure }>;

/** One pairing and link into `target`; then the sessions of this source's
 * earlier links there are revoked, once the new one is seen. */
async function pairAndLink(
  seams: T3LinkSeams,
  rpc: T3Rpc,
  target: string,
  origin: string,
  label: string,
  node: string,
): Promise<Linked | Failed> {
  const client = `${linkClientPrefix}${label}`;
  const before = await targetSessions(seams, target);
  if (before === undefined)
    return { kind: "failed", cause: "target-unreachable" };
  const issued = await onTarget(seams, target, "lazurio", [
    "machine",
    "t3-link-pair",
    "--source",
    node,
    "--label",
    encodeLabel(label),
  ]);
  const pairing =
    issued === undefined ? undefined : parsePairing(issued.stdout);
  if (pairing === undefined)
    return { kind: "failed", cause: "pairing-refused" };
  const answer = await rpc.request("peerLinks.link", {
    url: origin,
    pairingCode: pairing.credential,
    access: linkAccess,
  });
  const link = answer.ok ? linkSummary(answer.value) : undefined;
  if (link === undefined) {
    // An unspent code is not left behind.
    await onTarget(
      seams,
      target,
      "t3",
      ["auth", "pairing", "revoke"],
      pairing.id,
    );
    return { kind: "failed", cause: "link-refused" };
  }
  const earlier = before.filter(
    (session) => session.subject === "mcp-client" && session.label === client,
  );
  const known = new Set(earlier.map((session) => session.sessionId));
  const fresh = ((await targetSessions(seams, target)) ?? []).filter(
    (session) =>
      session.subject === "mcp-client" &&
      session.label === client &&
      !known.has(session.sessionId),
  );
  let revoked = 0;
  if (fresh.length > 0)
    for (const session of earlier)
      if (
        (await onTarget(
          seams,
          target,
          "t3",
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
    }>
  | Readonly<{ environment: string; result: "person-link" }>;

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
    }>;

const iso = (time: number) => new Date(time).toISOString();

async function reconcileSource(
  seams: T3LinkSeams,
  rpc: T3Rpc,
  targets: readonly AssignedEnvironment[],
  initial: T3LinksState,
  persist: Persist,
): Promise<T3LinksReport> {
  const now = seams.now();
  let state = initial;
  const update = async (next: T3LinksState) => {
    state = next;
    await persist(state);
  };
  const desired = new Set(targets.map((target) => target.environment));
  const on = await linkedEnvironmentsOn(seams.home);
  let switched: SwitchResult = on === null ? "unknown" : "kept";
  if (desired.size > 0 && on === false) {
    // Intent first: Lazurio owns the switch from before it turns it on.
    await update({ ...state, enabledByLazurio: true });
    switched = (await setSwitch(rpc, true)) ? "on" : "failed";
  }
  const unlinked: string[] = [];
  // Only links Lazurio made, by their recorded peer id.
  for (const [name, link] of Object.entries(state.links)) {
    if (desired.has(name)) continue;
    const answer = await rpc.request("peerLinks.unlink", {
      environmentId: link.peerEnvironmentId,
    });
    if (!answer.ok) continue;
    const { [name]: _gone, ...links } = state.links;
    await update({ ...state, links });
    unlinked.push(name);
  }
  const stale = Object.keys({ ...state.pending, ...state.attempts }).filter(
    (name) => !desired.has(name),
  );
  if (stale.length > 0)
    await update({
      ...state,
      pending: Object.fromEntries(
        Object.entries(state.pending).filter(([name]) => desired.has(name)),
      ),
      attempts: Object.fromEntries(
        Object.entries(state.attempts).filter(([name]) => desired.has(name)),
      ),
    });
  const results: T3LinkResult[] = [];
  const switchOn =
    desired.size > 0 && (on === true || switched === "on")
      ? await rpc.request("peerLinks.list", {})
      : undefined;
  const listed = switchOn?.ok ? parseLinkList(switchOn.value) : undefined;
  let label: string | undefined | null = null;
  if (listed !== undefined)
    for (const name of desired) {
      const origin = t3LinkOrigin(name) as string;
      const found = listed.find((link) => link.urls.includes(origin));
      const recorded = state.links[name];
      // A link at this address is Lazurio's when its peer id is the one
      // recorded, or when a pairing of Lazurio's was cut off before it was
      // recorded; any other one that still works is the person's.
      const ours =
        found !== undefined &&
        (recorded?.peerEnvironmentId === found.environmentId ||
          state.pending[name] !== undefined);
      if (found !== undefined && !ours && found.status !== "expired") {
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
        const { [name]: _done, ...pending } = state.pending;
        const { [name]: _ok, ...attempts } = state.attempts;
        await update({
          ...state,
          links: {
            ...state.links,
            [name]: {
              peerEnvironmentId: found.environmentId,
              expiresAt: iso(found.expiresAt),
            },
          },
          pending,
          attempts,
        });
        results.push({
          environment: name,
          result: "current",
          expiresAt: iso(found.expiresAt),
        });
        continue;
      }
      const attempt = state.attempts[name];
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
      let outcome: Linked | Failed;
      if (label === undefined || seams.node === null)
        outcome = { kind: "failed", cause: "label-unknown" };
      else {
        // Intent first: a pairing cut off here is still known as Lazurio's.
        await update({
          ...state,
          pending: { ...state.pending, [name]: iso(now) },
        });
        outcome = await pairAndLink(
          seams,
          rpc,
          name,
          origin,
          label,
          seams.node,
        );
      }
      const { [name]: _settled, ...pending } = state.pending;
      if (outcome.kind === "failed") {
        await update({
          ...state,
          pending,
          attempts: {
            ...state.attempts,
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
      const { [name]: _cleared, ...attempts } = state.attempts;
      await update({
        ...state,
        links: {
          ...state.links,
          [name]: {
            peerEnvironmentId: outcome.link.environmentId,
            expiresAt: iso(outcome.link.expiresAt),
          },
        },
        pending,
        attempts,
      });
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
    state.enabledByLazurio &&
    Object.keys(state.links).length === 0 &&
    Object.keys(state.pending).length === 0
  ) {
    if (on === false || (await setSwitch(rpc, false))) {
      await update({ ...state, enabledByLazurio: false });
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

/** Revokes the sessions of linked T3 Code here that `which` selects; the
 * count, or undefined when T3 Code could not be asked or refused one. */
async function revokeLinkSessions(
  seams: T3LinkSeams,
  which: (session: LinkSession) => boolean,
) {
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
  for (const session of sessions.filter(
    (session) => isLinkSession(session) && which(session),
  )) {
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
  rpc: T3Rpc,
  sources: readonly string[],
  initial: T3LinksState,
  persist: Persist,
): Promise<T3LinksReport> {
  let state = initial;
  const update = async (next: T3LinksState) => {
    state = next;
    await persist(state);
  };
  // Every current source is recorded before anything is opened for it.
  const unseen = sources.filter((name) => !(name in state.inbound));
  if (unseen.length > 0)
    await update({
      ...state,
      inbound: {
        ...state.inbound,
        ...Object.fromEntries(unseen.map((name) => [name, null])),
      },
    });
  const on = await linkedEnvironmentsOn(seams.home);
  let switched: SwitchResult = on === null ? "unknown" : "kept";
  if (sources.length > 0 && on === false) {
    await update({ ...state, enabledByLazurio: true });
    switched = (await setSwitch(rpc, true)) ? "on" : "failed";
  }
  // With the last edge, off first: T3 Code then refuses every linked client
  // at once; only where Lazurio turned it on.
  if (sources.length === 0 && state.enabledByLazurio && on !== false)
    switched = (await setSwitch(rpc, false)) ? "off" : "failed";
  let revoked: number | "failed" = 0;
  for (const [name, label] of Object.entries(state.inbound)) {
    if (sources.includes(name)) continue;
    // Exactly the sessions of the label this source paired under.
    const count =
      label === null
        ? 0
        : await revokeLinkSessions(
            seams,
            (session) => session.label === `${linkClientPrefix}${label}`,
          );
    if (count === undefined) {
      revoked = "failed";
      continue;
    }
    if (revoked !== "failed") revoked += count;
    const { [name]: _gone, ...inbound } = state.inbound;
    await update({ ...state, inbound });
  }
  if (
    sources.length === 0 &&
    state.enabledByLazurio &&
    switched !== "failed" &&
    Object.keys(state.inbound).length === 0
  )
    await update({ ...state, enabledByLazurio: false });
  return {
    role: "target",
    result: "synced",
    switch: switched,
    sources: [...sources],
    revoked,
  };
}

// ---- Closing ------------------------------------------------------------------

/** Whether something of Lazurio's may be open without a state that says so:
 * the switch on, or on the target a session of a linked T3 Code. */
async function mayBeOpen(seams: T3LinkSeams, role: "source" | "target") {
  if ((await linkedEnvironmentsOn(seams.home)) !== false) return true;
  if (role === "source") return false;
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
  return (await revokeLinkSessions(seams, () => true)) !== undefined;
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
        | "label-invalid"
        | "state-unusable"
        | "server-down"
        | "switch-failed"
        | "close-failed"
        | "pairing-failed";
    }>;

/** On the target: a one-time code for the inbound source `source` that links
 * under `label`, issued only while this Machine's handover names `source` as
 * an inbound edge. The source and its label are recorded, and the switch is
 * on, before the code exists. */
export async function issueLinkPairing(
  seams: T3LinkSeams,
  machine: MachineBinding | null | undefined,
  source: string,
  encodedLabel: string,
): Promise<PairingAnswer> {
  const role = t3LinkRole(machine);
  if (role.kind !== "target")
    return { kind: "refused", reason: "not-a-target" };
  if (!role.sources.includes(source))
    return { kind: "refused", reason: "not-a-source" };
  const label = decodeLabel(encodedLabel);
  if (label === undefined) return { kind: "refused", reason: "label-invalid" };
  const recorded = await readT3LinksState(seams.home, seams.uid);
  // A damaged state is the look's to close; no code is issued over it.
  if (recorded.kind === "damaged")
    return { kind: "refused", reason: "state-unusable" };
  let state = recorded.kind === "recorded" ? recorded.state : emptyT3LinksState;
  const rpcs = lazyRpc(seams);
  try {
    const rpc = await rpcs.get();
    if (typeof rpc === "string")
      return { kind: "refused", reason: "server-down" };
    // A missing state while something may be open closes first, as a look
    // does: the switch off and every linked session revoked, so no session
    // outlives the ownership a new state would no longer record. No code is
    // issued when closing fails.
    if (
      recorded.kind === "missing" &&
      (await mayBeOpen(seams, "target")) &&
      !(await close(seams, rpc, "target"))
    )
      return { kind: "refused", reason: "close-failed" };
    const on = await linkedEnvironmentsOn(seams.home);
    if (on === null) return { kind: "refused", reason: "switch-failed" };
    state = {
      ...state,
      enabledByLazurio: state.enabledByLazurio || !on,
      inbound: { ...state.inbound, [source]: label },
    };
    await writeT3LinksState(seams.home, state);
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
  return pairing === undefined
    ? { kind: "refused", reason: "pairing-failed" }
    : { kind: "issued", ...pairing };
}

// ---- Lock and loop ------------------------------------------------------------

/** `work` under the one lock of every writer of the links, the Launchpad's
 * tick and `lazurio machine t3-links` or `t3-link-pair` alike: a kernel
 * `flock`, released when its holder ends. */
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
