import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import { adminSession, type BrainHttp, keyWorks } from "./admin";
import { type BrainPaths, brainKeyNames, brainUrl } from "./pin";

// The keys Lazurio mints over the brain's admin API and hands over beside
// the admin token, 0600, in the Launchpad's shape `{url, token}`:
//   launchpad  read          the Launchpad's memory page (R11b's key, kept)
//   executor   read, write   Executor's MCP server Brain for every agent
//   probe      read          doctor's and setup's own checks
// One path mints each: a key that still works is kept, otherwise a new one
// is minted, handed over, and every other active key of that name revoked,
// so neither a key Machines minted nor an orphan of an earlier run stays.
// Lazurio's record of the ids is its own state file; Machines' ledger
// (`~/.local/state/lazurio/buddy/managed.json`) is only read, once, for the
// id of the Launchpad's key Machines minted, and never written.

export type BrainKeyKind = keyof typeof brainKeyNames;

export const brainKeyScopes: Readonly<Record<BrainKeyKind, readonly string[]>> =
  Object.freeze({
    launchpad: Object.freeze(["read"]),
    executor: Object.freeze(["read", "write"]),
    probe: Object.freeze(["read"]),
  });

export type BrainState = Readonly<{
  keys?: Partial<Record<BrainKeyKind, Readonly<{ id: string }>>>;
  /** The vault's connection: which repository the brain was put on and
   * when `sync.on_commit` and git durability were switched on for it. */
  vault?: Readonly<{
    repo?: string;
    onCommit?: string;
    durability?: string;
    rebuild?: Readonly<{ state: string; at: string; backup?: string }>;
  }>;
  /** The owner's consent to take the interim installer's brain over, and
   * how the takeover went. */
  takeover?: Readonly<{
    consent?: string;
    state?: "done" | "restored" | `failed-${string}`;
    at?: string;
  }>;
  /** Search by meaning, once switched on for this brain (`./meaning.ts`). */
  meaning?: Readonly<{ provider: string; dimensions: number; at: string }>;
  /** The last attempt to switch it on, while it is not on. */
  meaningAttempt?: Readonly<{
    provider: string;
    result: "started" | "restored" | "stopped";
    at: string;
    backup?: string;
    reason?: string;
  }>;
  /** The last move of the brain to a pin (`./move.ts`). */
  move?: MoveRecord;
  release?: Readonly<{
    commit: string;
    version: string;
    command: string;
    source: "lazurio" | "interim";
  }>;
}>;

export type MoveRecord = Readonly<{
  /** The pinned commit this move goes to. */
  to: string;
  from: string;
  at: string;
  /** moving: the units name the pin, not yet accepted; done; held: back on
   * the previous release after a refused move to `to`, not tried again
   * before another pin; stopped:…: the server stays stopped for a person. */
  result: "moving" | "done" | "held" | `stopped:${string}` | `waits:${string}`;
  pages?: number;
  /** The copy, a directory name in the home. */
  backup?: string;
  failedAttempt?: string;
  reason?: string;
  /** Whether ~/.gbrain is the brain before the move (or its restored copy). */
  brainIntact?: boolean;
  /** The release the brain ran before the move. */
  previous?: Readonly<{ command: string; version: string; commit?: string }>;
}>;

/** One closed label per key: what setup prints, never a value. */
export type KeyOutcome = "kept" | "minted" | "failed";

export async function readBrainState(paths: BrainPaths): Promise<BrainState> {
  try {
    const value = JSON.parse(await readFile(paths.state, "utf8")) as unknown;
    return typeof value === "object" && value !== null
      ? (value as BrainState)
      : {};
  } catch {
    return {};
  }
}

export async function writeBrainState(
  paths: BrainPaths,
  state: BrainState,
): Promise<void> {
  await mkdir(dirname(paths.state), { recursive: true, mode: 0o700 });
  await writeDurableFile(
    dirname(paths.state),
    basename(paths.state),
    Buffer.from(`${JSON.stringify(state, null, 2)}\n`),
  );
}

const handoverPath = (paths: BrainPaths, kind: BrainKeyKind) =>
  ({
    launchpad: paths.launchpadKey,
    executor: paths.executorKey,
    probe: paths.probeKey,
  })[kind];

async function handedOverToken(path: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      token?: unknown;
    };
    return typeof value.token === "string" ? value.token : undefined;
  } catch {
    return undefined;
  }
}

/** The id of the Launchpad's key Machines minted (R11b), read once from
 * their ledger where Lazurio has no record of its own yet. */
async function machinesLaunchpadId(home: string): Promise<string | undefined> {
  try {
    const ledger = JSON.parse(
      await readFile(
        join(home, ".local", "state", "lazurio", "buddy", "managed.json"),
        "utf8",
      ),
    ) as { gbrain_launchpad_key?: { id?: unknown } };
    const id = ledger.gbrain_launchpad_key?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** An owner session of the brain's admin API, or null. The admin token is
 * read here and nowhere else of the Platform; only `lazurio brain setup`
 * (this module and the vault's connection) uses the session. */
export async function ownerSession(
  paths: BrainPaths,
  http: BrainHttp,
  base: string,
): Promise<Awaited<ReturnType<typeof adminSession>>> {
  let adminToken: string;
  try {
    adminToken = (await readFile(paths.adminToken, "utf8")).trim();
  } catch {
    return null;
  }
  return adminSession(http, base, adminToken);
}

/** Converges every key; returns the closed labels and the new state. */
export async function convergeBrainKeys(
  input: Readonly<{ paths: BrainPaths; http: BrainHttp; base?: string }>,
): Promise<
  Readonly<{
    outcomes: Readonly<Record<BrainKeyKind, KeyOutcome>>;
    state: BrainState;
  }>
> {
  const { paths, http } = input;
  const base = input.base ?? brainUrl;
  const state = await readBrainState(paths);
  const ids: Partial<Record<BrainKeyKind, Readonly<{ id: string }>>> = {
    ...(state.keys ?? {}),
  };
  if (ids.launchpad === undefined) {
    const id = await machinesLaunchpadId(paths.home);
    if (id !== undefined) ids.launchpad = Object.freeze({ id });
  }
  const outcomes = {} as Record<BrainKeyKind, KeyOutcome>;
  let session: Awaited<ReturnType<typeof adminSession>> | undefined;
  const owner = async () => {
    if (session === undefined) session = await ownerSession(paths, http, base);
    return session;
  };
  for (const kind of Object.keys(brainKeyNames) as BrainKeyKind[]) {
    const name = brainKeyNames[kind];
    const path = handoverPath(paths, kind);
    const current = await handedOverToken(path);
    let keep: string | undefined;
    if (current !== undefined && (await keyWorks(http, base, current))) {
      outcomes[kind] = "kept";
      keep = ids[kind]?.id;
    } else {
      const admin = await owner();
      const minted =
        admin === null ? null : await admin.mint(name, brainKeyScopes[kind]);
      if (minted === null) {
        outcomes[kind] = "failed";
        continue;
      }
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeDurableFile(
          dirname(path),
          basename(path),
          Buffer.from(
            `${JSON.stringify({ url: base, token: minted.token })}\n`,
          ),
        );
      } catch {
        await admin?.revoke(minted.id);
        outcomes[kind] = "failed";
        continue;
      }
      ids[kind] = Object.freeze({ id: minted.id });
      keep = minted.id;
      outcomes[kind] = "minted";
    }
    // Every other active key of this name goes: an earlier one, Machines'
    // where Lazurio took it over, or an orphan of a run that died.
    if (keep !== undefined) {
      const admin = await owner();
      const keys = admin === null ? null : await admin.keys();
      for (const key of keys ?? [])
        if (key.name === name && key.id !== keep && key.status === "active")
          await admin?.revoke(key.id);
    }
  }
  const next: BrainState = Object.freeze({
    ...state,
    keys: Object.freeze(ids),
  });
  await writeBrainState(paths, next);
  return Object.freeze({ outcomes: Object.freeze(outcomes), state: next });
}
