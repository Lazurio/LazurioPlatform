import { createHash } from "node:crypto";
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
// One path mints each: a key that still works is kept and nothing is
// revoked; otherwise a new one is minted, handed over, and every other active
// key of that name revoked, so neither a key Machines minted nor an orphan of
// an earlier run stays. One run at a time (`brainSetup`'s lock).
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

/** A key Lazurio knows: its id; for one Lazurio minted, a digest of its
 * token (which handover it is) and, until every earlier key of its name is
 * revoked, `sweep`. */
export type KeyRecord = Readonly<{
  id: string;
  digest?: string;
  sweep?: boolean;
}>;

export type BrainState = Readonly<{
  keys?: Partial<Record<BrainKeyKind, KeyRecord>>;
  /** The vault's connection: which repository the brain was put on and
   * when `sync.on_commit` and git durability were switched on for it. */
  vault?: Readonly<{
    repo?: string;
    onCommit?: string;
    durability?: string;
    /** A rebuild's journal, written before each stage: `stopping`,
     * `moving`, `started` (a run that finds one of these recovers it),
     * `done`, `restored-after-…`, or `restore-failed-after-…` (stopped for a
     * person). `vaultDir` and `moveAside` say what the move touches. */
    rebuild?: Readonly<{
      state: string;
      at: string;
      backup?: string;
      vaultDir?: string;
      moveAside?: boolean;
    }>;
  }>;
  /** How taking the interim installer's brain over went, and the time of
   * the consent it ran with (a record only: no run reads it as consent). */
  takeover?: Readonly<{
    consent?: string;
    /** `taking-over`: the journal of a takeover in progress, written before
     * the first unit; a run that finds it puts the interim installer's
     * units back first (`resumeTakeover`). `restore-failed-…`: the way back
     * did not complete; stopped for a person. */
    state?:
      | "taking-over"
      | "done"
      | "restored"
      | `failed-${string}`
      | `restore-failed-${string}`
      /** Refused before anything changed. */
      | `refused-${string}`;
    at?: string;
    /** While taking over: the release the interim installer ran, and the
     * unit names that were not there before (removed on the way back). */
    release?: Readonly<{ commit: string; version: string }>;
    created?: readonly string[];
  }>;
  /** Search by meaning, once switched on for this brain (`./meaning.ts`). */
  meaning?: Readonly<{ provider: string; dimensions: number; at: string }>;
  /** The SHA-256 of the model's unit as Lazurio last wrote it: a unit of
   * that name is Lazurio's only if it is that or what it writes now. */
  meaningUnit?: string;
  /** The night window the person chose for search by meaning to compute in
   * (`lazurio brain night`, `./night.ts`); the default where absent. */
  night?: Readonly<{ start: string; end: string; timeZone: string }>;
  /** The last attempt to switch it on, while it is not on: `stopping` is
   * written before the server stops and `started` once the copy is whole;
   * a run that finds either recovers it first. `filling`: the model is on
   * and the server runs with it, while the vectors still missing are
   * computed in short windows (`phase: "filling"` on the window's own
   * `stopping` and `started`, whose copy is `windowBackup`). */
  meaningAttempt?: Readonly<{
    provider: string;
    /** `restoring`: a way back began (its renames may be half done); a run
     * that finds it finishes them (`./meaning.ts`, `restoreCopy`). */
    result:
      | "stopping"
      | "started"
      | "restoring"
      | "filling"
      | "restored"
      | "stopped";
    at: string;
    backup?: string;
    reason?: string;
    phase?: "filling";
    windowBackup?: string;
    /** Chunks gbrain said were left after the last window. */
    remaining?: number;
    /** Windows run, and the windows in a row that made no progress. */
    windows?: number;
    stalled?: number;
  }>;
  /** Lazurio's install of a pin, from before its brain is created until its
   * release is recorded: the brain under it is Lazurio's own, and a run
   * that finds it resumes every step (`./setup.ts`). */
  install?: Readonly<{ commit: string; at: string }>;
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
/** `incomplete`: minted and handed over, but an earlier key of its name
 * could not be listed or revoked; the next run tries again. */
export type KeyOutcome = "kept" | "minted" | "incomplete" | "failed";

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

/** Which token a record's key is, without the token: a digest of it. */
const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 32);

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
  const ids: Partial<Record<BrainKeyKind, KeyRecord>> = {
    ...(state.keys ?? {}),
  };
  if (ids.launchpad === undefined) {
    const id = await machinesLaunchpadId(paths.home);
    if (id !== undefined) ids.launchpad = Object.freeze({ id });
  }
  const persist = async () => {
    const current = await readBrainState(paths);
    await writeBrainState(paths, { ...current, keys: { ...ids } });
  };
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
    const record = ids[kind];
    // The handover is the key Lazurio minted under this record only where
    // its token is the one the record's digest names.
    const bound =
      record?.digest !== undefined &&
      current !== undefined &&
      record.digest === tokenDigest(current);
    if (record?.sweep && !bound) {
      // A run died between recording a mint and handing it over: that key
      // was never handed to anyone, so it goes.
      const admin = await owner();
      if (admin === null || !(await admin.revoke(record.id))) {
        outcomes[kind] = "incomplete";
        continue;
      }
      delete ids[kind];
      await persist();
    }
    let keep: string | undefined;
    if (current !== undefined && (await keyWorks(http, base, current))) {
      // The key handed over works and is kept. Earlier keys of its name are
      // revoked only where Lazurio minted it (its id is certain); otherwise
      // (another manager may have minted it) revoking "every other" key
      // could revoke the very one in use.
      outcomes[kind] = "kept";
      if (bound && record?.sweep) keep = record.id;
    } else {
      const admin = await owner();
      const minted =
        admin === null ? null : await admin.mint(name, brainKeyScopes[kind]);
      if (minted === null) {
        outcomes[kind] = "failed";
        continue;
      }
      // Recorded before it is handed over: the next run knows its id, which
      // handover it is, and that earlier keys of its name still go.
      const before = ids[kind];
      ids[kind] = Object.freeze({
        id: minted.id,
        digest: tokenDigest(minted.token),
        sweep: true,
      });
      await persist();
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
        if (await admin?.revoke(minted.id)) {
          if (before === undefined) delete ids[kind];
          else ids[kind] = before;
          await persist();
        }
        outcomes[kind] = "failed";
        continue;
      }
      keep = minted.id;
      outcomes[kind] = "minted";
    }
    // Only for a key whose id is certain: every other active key of this
    // name goes, an earlier one, Machines' where Lazurio took it over, or an
    // orphan of a run that died. Until all are gone the record says so, and
    // the next run tries again.
    if (keep !== undefined) {
      const admin = await owner();
      const keys = admin === null ? null : await admin.keys();
      let swept = keys !== null;
      for (const key of keys ?? [])
        if (
          key.name === name &&
          key.id !== keep &&
          key.status === "active" &&
          !(await admin?.revoke(key.id))
        )
          swept = false;
      if (swept) {
        const { sweep: _done, ...rest } = ids[kind] as KeyRecord;
        ids[kind] = Object.freeze(rest);
        await persist();
      } else outcomes[kind] = "incomplete";
    }
  }
  const next: BrainState = Object.freeze({
    ...state,
    keys: Object.freeze(ids),
  });
  await writeBrainState(paths, next);
  return Object.freeze({ outcomes: Object.freeze(outcomes), state: next });
}
