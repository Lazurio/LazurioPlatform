import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { buddyLayerPaths } from "../folder/outputs";
import type { ToolRunner } from "../tools/status";

// How a change of what Buddy's gateway reads reaches his running
// conversations (decision F64). Hermes does not notice a changed SOUL.md by
// itself: a conversation keeps its stored system prompt while its model,
// provider, session and working directory stay (Lazurio/hermes-agent
// v0.22.4-lazurio.1, agent/conversation_loop.py
// `_stored_prompt_matches_runtime`), and the gateway keeps an agent per
// conversation whose signature covers neither SOUL.md nor its own
// environment (gateway/run_agent_cache.py). So a change takes two steps,
// the installer's (`buddy-install.sh`, step 13):
//
// 1. `hermes sessions repair-prompts <id> --apply --json` for every
//    conversation that holds a stored prompt and can still take a turn
//    (live, or ended in a way Hermes resumes: `resumableConversations`)
//    clears it, so its next turn builds it anew; the store, not the
//    command's exit, says it worked;
// 2. one restart of `hermes-gateway.service` drops the agents it keeps and
//    gives it its drop-in's environment, only while Hermes's own
//    `active-work` verb (gateway/run_active_work_verb.py, the answer its
//    `gateway stop` and `restart` ask before they interrupt anything) names
//    nothing running, and never on units systemd failed to reread. systemd
//    stops the gateway with SIGTERM, which drains what is in flight within
//    the unit's TimeoutStopSec, which Hermes sets to cover its drain.
//
// A restart that waits is not recorded: the gateway's main process started
// before the newest derived file was written (`ExecMainStartTimestamp` against
// the file's time), or systemd still holds older units (`NeedDaemonReload`).
// Stored prompts have no time of their own, and a restart by anyone (systemd
// after a crash, the installer, a reboot) erases the only derived evidence that
// they are stale, so a refresh that is owed is recorded: a marker written
// before SOUL.md changes and removed only after a complete refresh and the
// restart that follows it.
//
// Buddy's prompts are built from his Lazurio layer in the Folder too
// (`buddyLayerPaths`: `.agents/buddy/.hermes.md`, which Hermes loads from his
// working directory, and his Lazurio skills), which a Platform release
// changes through any of the Folder's entry points, none of which knows his
// home. So a complete refresh also records what that layer was when the
// refresh began, and a layer whose bytes are no longer those owes the next
// refresh, whoever changed it (F64's addendum of 2026-10-25).

/** Hermes's own user unit of Buddy's gateway (`hermes gateway install`). */
export const gatewayUnit = "hermes-gateway.service";

/** What `systemctl --user` runs with: the runner and the variables a
 * user-session service manager client needs (`serviceEnvironment`). */
export type ServiceRun = Readonly<{
  run: ToolRunner;
  env: Readonly<Record<string, string>>;
}>;

const serviceTimeoutMs = 60_000;
/** A restart waits for the stop's drain and the start: an idle gateway takes
 * seconds, a drain at most the unit's TimeoutStopSec. */
const restartTimeoutMs = 300_000;

/** `systemctl --user <args>`; false when it did not run, timed out or the
 * manager refused. */
export async function systemctl(
  service: ServiceRun,
  timeoutMs: number,
  ...args: string[]
): Promise<boolean> {
  const result = await service
    .run(["systemctl", "--user", ...args], timeoutMs, service.env, {
      maxBytes: 64 * 1024,
    })
    .catch(() => "timeout" as const);
  return result !== "timeout" && result.exitCode === 0;
}

// ---- The gateway's unit -----------------------------------------------------

/** The gateway's unit as systemd holds it. `startedAt`: when its main process
 * started, in microseconds since the epoch. */
export type GatewayUnit =
  | Readonly<{ state: "running"; startedAt: bigint; needsReload: boolean }>
  | Readonly<{ state: "stopped"; needsReload: boolean }>
  | Readonly<{ state: "absent" }>
  /** No user manager to ask, or an answer that is none. */
  | Readonly<{ state: "unknown" }>;

/** `Sun 2026-10-25 00:42:20.238927 UTC`, systemd's `--timestamp=us+utc`
 * (systemd 255, Ubuntu 24.04); the weekday is not read. */
const usUtc =
  /^\S+ (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6}) UTC$/;

/** A `us+utc` timestamp in microseconds since the epoch; undefined for an
 * empty one (no main process) or any other shape. */
export function microsecondsOf(value: string | undefined): bigint | undefined {
  const match = usUtc.exec(value ?? "");
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, micros] = match.map(Number);
  const milliseconds = Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    minute as number,
    second as number,
  );
  return Number.isNaN(milliseconds)
    ? undefined
    : BigInt(milliseconds) * 1000n + BigInt(micros as number);
}

/** The gateway's unit: `systemctl --user show` of its load and active state,
 * its main process's start (to the microsecond, in UTC) and whether its files
 * changed since systemd last read them. */
export async function gatewayUnitState(
  service: ServiceRun,
): Promise<GatewayUnit> {
  const result = await service
    .run(
      [
        "systemctl",
        "--user",
        "show",
        gatewayUnit,
        "--timestamp=us+utc",
        "--property=LoadState,ActiveState,ExecMainStartTimestamp,NeedDaemonReload",
      ],
      serviceTimeoutMs,
      service.env,
      { maxBytes: 64 * 1024 },
    )
    .catch(() => "timeout" as const);
  if (result === "timeout" || result.exitCode !== 0)
    return Object.freeze({ state: "unknown" });
  const properties = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) properties.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const load = properties.get("LoadState");
  if (load === "not-found") return Object.freeze({ state: "absent" });
  if (load === undefined) return Object.freeze({ state: "unknown" });
  const needsReload = properties.get("NeedDaemonReload") === "yes";
  const active = properties.get("ActiveState");
  const startedAt = microsecondsOf(properties.get("ExecMainStartTimestamp"));
  if (
    (active === "active" ||
      active === "reloading" ||
      active === "activating") &&
    startedAt !== undefined
  )
    return Object.freeze({ state: "running", startedAt, needsReload });
  return Object.freeze({ state: "stopped", needsReload });
}

/** When a file was last written, in microseconds since the epoch; undefined
 * where there is none. */
async function writtenAt(path: string): Promise<bigint | undefined> {
  try {
    return (await lstat(path, { bigint: true })).mtimeNs / 1000n;
  } catch {
    return undefined;
  }
}

/** Whether the running gateway does not run what the files hold: systemd has
 * not reread its units since they changed (`NeedDaemonReload`, which a failed
 * reload leaves so, whoever starts the gateway meanwhile), or its main process
 * started before the newest of `paths` was written. A restart is then pending.
 * A stopped gateway reads them when it starts. */
export async function restartPending(
  unit: GatewayUnit,
  paths: readonly string[],
): Promise<boolean> {
  if (unit.state !== "running") return false;
  if (unit.needsReload) return true;
  for (const path of paths) {
    const at = await writtenAt(path);
    if (at !== undefined && at > unit.startedAt) return true;
  }
  return false;
}

/** systemd rereads the gateway's unit and drop-ins, so its next start, ours or
 * its own `Restart=`, has the drop-in's environment. */
export const reloadUnits = (service: ServiceRun) =>
  systemctl(service, serviceTimeoutMs, "daemon-reload");

/** The one restart: systemd stops the gateway (SIGTERM, drained within the
 * unit's TimeoutStopSec) and starts it again. */
export const restartGateway = (service: ServiceRun) =>
  systemctl(service, restartTimeoutMs, "restart", gatewayUnit);

// ---- Hermes's `active-work` verb -------------------------------------------

/** What Hermes's gateway answers it is running: nothing (`idle`), something
 * a restart would interrupt (`busy`), or no answer (`unknown`), which counts
 * as busy: nothing restarts blind. */
export type ActiveWork = "idle" | "busy" | "unknown";

const controlAnswerBytes = 512 * 1024;
const controlTimeoutMs = 5_000;

/** The control socket of the gateway serving `hermesHome`, found as Hermes's
 * own client finds it (gateway/control_socket.py
 * `resolve_client_socket_path`) and checked as Hermes Desktop checks it: the
 * socket `gateway.sock`, owned by this account and never a link, or, where the
 * home's path is too long for one, the socket the pointer `gateway.sock.path`
 * names, but only `…/hermes-gw-<the home's sha256, 16 hex>/control.sock` in a
 * directory private to this account. */
export async function controlSocketPath(
  hermesHome: string,
): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  try {
    const direct = join(hermesHome, "gateway.sock");
    const info = await lstat(direct).catch(() => undefined);
    if (info !== undefined)
      return info.isSocket() && info.uid === uid ? direct : undefined;
    const pointer = join(hermesHome, "gateway.sock.path");
    const named = await lstat(pointer);
    if (!named.isFile() || named.uid !== uid || named.size > 4096)
      return undefined;
    const text = await readFile(pointer, "utf8");
    // Hermes reads the pointer as `utf-8-sig`: a byte order mark first is not
    // part of the path.
    const target = (
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    ).trim();
    const home = await realpath(hermesHome);
    const leaf = `hermes-gw-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
    if (
      !isAbsolute(target) ||
      basename(target) !== "control.sock" ||
      basename(dirname(target)) !== leaf
    )
      return undefined;
    const parent = await lstat(dirname(target));
    if (
      !parent.isDirectory() ||
      parent.uid !== uid ||
      (parent.mode & 0o077) !== 0
    )
      return undefined;
    const socket = await lstat(target);
    return socket.isSocket() && socket.uid === uid ? target : undefined;
  } catch {
    return undefined;
  }
}

/** One request on the control socket: one JSON line in, one out, then the
 * gateway closes it. Undefined for no answer within the deadline, a larger
 * one or one that is no JSON. */
function controlRequest(path: string, request: Json): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const socket = createConnection({ path });
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const parse = () => {
      const all = Buffer.concat(chunks);
      const end = all.indexOf(10);
      try {
        finish(
          JSON.parse(
            all.subarray(0, end < 0 ? all.length : end).toString("utf8"),
          ),
        );
      } catch {
        finish(undefined);
      }
    };
    const timer = setTimeout(() => finish(undefined), controlTimeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > controlAnswerBytes) return finish(undefined);
      chunks.push(chunk);
      if (chunk.includes(10)) parse();
    });
    socket.on("end", parse);
    socket.on("error", () => finish(undefined));
  });
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Asks the gateway serving `hermesHome` its `active-work` verb. Idle only
 * when it answers, as Hermes's own `gateway restart` counts it
 * (hermes_cli/gateway_lifecycle_guards.py), no unit of work and no active
 * agent. Nothing of the answer is kept: its units name conversations. */
export async function askActiveWork(hermesHome: string): Promise<ActiveWork> {
  const path = await controlSocketPath(hermesHome);
  if (path === undefined) return "unknown";
  const answer = await controlRequest(path, {
    protocol: 1,
    verb: "active-work",
    id: 1,
  });
  if (!isObject(answer) || answer.ok !== true || answer.id !== 1)
    return "unknown";
  const result = answer.result;
  if (!isObject(result) || !Array.isArray(result.active_work)) return "unknown";
  const agents = result.active_agents ?? 0;
  if (typeof agents !== "number" || !Number.isFinite(agents)) return "unknown";
  return Math.max(result.active_work.length, agents) === 0 ? "idle" : "busy";
}

// ---- Stored prompts ---------------------------------------------------------

/** Session ids as Hermes mints them (hermes_state_ids.py): never an option on
 * a command line. A conversation with any other id is not cleared, and the
 * refresh stays incomplete. */
const sessionIdShape = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** At most this many conversations are cleared in one refresh; more leave it
 * incomplete, and the next one goes on with what still holds a prompt. */
export const promptRefreshCap = 500;

/** A conversation and the stored prompt it holds: Hermes keeps it by content
 * hash (`sessions.system_prompt_hash`, v0.22.4-lazurio.1), an older row
 * inline (`system_prompt`). Only the hash, or that an inline prompt is there,
 * is read: never a prompt. `unknown` where the store has neither column. */
type Held = Readonly<{ id: unknown; prompt: string | null }>;

/** End reasons after which Hermes never takes a turn in a row again
 * (Lazurio/hermes-agent v0.22.4-lazurio.3, `hermes_state_common.py`): a
 * compression split goes on in its continuation, and a deliberate boundary
 * (`_BOUNDARY_END_REASONS`: the resets and `/new`) in a new session. Any other
 * end leaves a row that its conversation's next turn reopens with the prompt
 * it stored: the last viewer leaving an ACP session (`acp_disconnect`,
 * `gateway/session_acp_lifecycle.py`), a runtime that closed, was reaped or
 * was evicted (`gateway/session_local_recovery.py` `reopen_local_session`
 * reopens a local conversation's latest row whatever its reason). */
const supersededEndReasons = [
  "compression",
  "new_session",
  "session_reset",
  "session_switch",
  "idle",
  "daily",
  "suspended",
  "resume_pending_expired",
] as const;

type Columns = Readonly<{
  hash: boolean;
  inline: boolean;
  /** Every column of `sessions`. */
  names: ReadonlySet<unknown>;
}>;

/** What a row holds, as one comparable value. */
const heldOf = (columns: Columns, row: Record<string, unknown>) =>
  columns.hash && typeof row.hash === "string"
    ? `hash:${row.hash}`
    : columns.inline && row.inline === 1
      ? "inline"
      : columns.hash || columns.inline
        ? null
        : "unknown";

/** Runs `body` on Hermes's session store, read-only; undefined where it has
 * no `sessions.ended_at` or cannot be read, and `absent` without a store
 * (Buddy has had no conversation). */
async function withStore<T>(
  hermesHome: string,
  body: (store: Database, columns: Columns) => T,
): Promise<T | "absent" | undefined> {
  const path = join(hermesHome, "state.db");
  if ((await lstat(path).catch(() => undefined)) === undefined) return "absent";
  let store: Database | undefined;
  try {
    store = new Database(path, { readonly: true });
    store.exec("PRAGMA busy_timeout = 5000");
    const names = new Set(
      store
        .query("pragma table_info(sessions)")
        .all()
        .map((row) => (row as { name: unknown }).name),
    );
    if (!names.has("ended_at")) return undefined;
    return body(store, {
      hash: names.has("system_prompt_hash"),
      inline: names.has("system_prompt"),
      names,
    });
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}

const selected = (columns: Columns) =>
  `id, ${columns.hash ? "system_prompt_hash" : "null"} as hash, ${columns.inline ? "system_prompt is not null" : "0"} as inline`;

/** Buddy's conversations that hold a stored prompt and can still take a turn,
 * newest first, at most `cap` and whether there were more:
 * - live ones, not ended, as the installer's `live_sessions` selects them;
 * - ended ones Hermes resumes. The web chat's ACP session ends whenever its
 *   last viewer leaves (`acp_disconnect`), and T3 Code's next message reopens
 *   it with the prompt it stored. So an ended row counts unless its end says
 *   its conversation went on in another row or stopped
 *   (`supersededEndReasons`), and only with messages: an editor lists and
 *   loads no empty session (`acp_adapter/catalog.py`). Only where the store
 *   says which rows hold a prompt and why they ended;
 * - never a tool's session or a subagent's run, which Hermes marks
 *   `_delegate_from` (`model_config`). A compression's or a reset's
 *   continuation counts: that is the row a long conversation goes on in.
 *   Without `model_config` every child row is left out, as the installer
 *   leaves them.
 * Every live conversation where the store cannot say whether it holds one. */
export async function resumableConversations(
  hermesHome: string,
  cap: number = promptRefreshCap,
): Promise<
  Readonly<{ held: readonly Held[]; capped: boolean }> | "absent" | undefined
> {
  return withStore(hermesHome, (store, columns) => {
    const { names } = columns;
    const holds = [
      ...(columns.hash ? ["system_prompt_hash is not null"] : []),
      ...(columns.inline ? ["system_prompt is not null"] : []),
    ];
    const where: string[] = [];
    if (holds.length > 0) where.push(`(${holds.join(" or ")})`);
    if (names.has("source")) where.push("coalesce(source, '') != 'tool'");
    if (names.has("model_config"))
      where.push(
        "(case when json_valid(model_config) then json_extract(model_config, '$._delegate_from') end) is null",
      );
    else if (names.has("parent_session_id"))
      where.push("parent_session_id is null");
    const resumed =
      holds.length > 0 && names.has("end_reason")
        ? [
            `coalesce(end_reason, '') not in (${supersededEndReasons.map((reason) => `'${reason}'`).join(", ")})`,
            ...(names.has("message_count")
              ? ["coalesce(message_count, 0) > 0"]
              : []),
          ]
        : undefined;
    where.push(
      resumed === undefined
        ? "ended_at is null"
        : `(ended_at is null or (${resumed.join(" and ")}))`,
    );
    const order =
      ["started_at", "created_at"].find((column) => names.has(column)) ??
      "rowid";
    const rows = store
      .query(
        `select ${selected(columns)} from sessions where ${where.join(" and ")} order by ${order} desc limit ${cap + 1}`,
      )
      .all() as Record<string, unknown>[];
    return Object.freeze({
      held: rows
        .slice(0, cap)
        .map((row) =>
          Object.freeze({ id: row.id, prompt: heldOf(columns, row) }),
        ),
      capped: rows.length > cap,
    });
  });
}

/** What each of `ids` holds now; an id no longer in the store is `gone`. */
async function heldNow(
  hermesHome: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string | null> | undefined> {
  const now = await withStore(hermesHome, (store, columns) => {
    const held = new Map<string, string | null>();
    for (let at = 0; at < ids.length; at += 400) {
      const chunk = ids.slice(at, at + 400);
      const rows = store
        .query(
          `select ${selected(columns)} from sessions where id in (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk) as Record<string, unknown>[];
      for (const row of rows)
        if (typeof row.id === "string") held.set(row.id, heldOf(columns, row));
    }
    return held;
  });
  return now === "absent" ? new Map() : now;
}

/** What clearing the stored prompts did. `refreshed`: every conversation
 * that held a stored prompt and can still take a turn holds it no more.
 * `incomplete`: some still hold the prompt they held (a command that failed
 * or did nothing, an id never passed to a command), or there were more than
 * the cap. `skipped`: nothing could be cleared. Only the last two leave a
 * refresh owed. `live` counts those conversations, the ended ones Hermes
 * resumes included (`resumableConversations`), and `refreshed` those of them
 * that hold their prompt no more. */
export type PromptRefresh =
  | Readonly<{ state: "refreshed"; refreshed: number; live: number }>
  | Readonly<{
      state: "incomplete";
      refreshed: number;
      live: number;
      failed: number;
      capped: boolean;
    }>
  | Readonly<{
      state: "skipped";
      reason: "hermes-missing" | "store-unreadable";
    }>;

/** Clears the stored prompt of every conversation that holds one and can
 * still take a turn, with Hermes's own command, as the installer does; each
 * conversation's next turn builds it from the files as they are now, an ended
 * one's when it is resumed. Its id needs no live row: the command resolves
 * any session and clears what it stores (`hermes_cli/sessions_cmd.py`
 * `_cmd_repair_prompts`, v0.22.4-lazurio.3). A conversation counts as
 * refreshed only when the store no longer holds the prompt it held before:
 * cleared, rebuilt by a turn since, or gone. A store that cannot say which
 * prompt a conversation holds is judged by the commands' exits alone. */
export async function refreshPrompts(
  input: Readonly<{
    home: string;
    hermes: string | undefined;
    path: string | undefined;
    run: ToolRunner;
    /** Tests only: at most this many conversations in one refresh. */
    cap?: number;
  }>,
): Promise<PromptRefresh> {
  if (input.hermes === undefined)
    return Object.freeze({ state: "skipped", reason: "hermes-missing" });
  const hermesHome = join(input.home, ".hermes");
  const live = await resumableConversations(hermesHome, input.cap);
  if (live === undefined)
    return Object.freeze({ state: "skipped", reason: "store-unreadable" });
  if (live === "absent")
    return Object.freeze({ state: "refreshed", refreshed: 0, live: 0 });
  const exits = new Map<string, boolean>();
  for (const { id } of live.held) {
    if (typeof id !== "string" || !sessionIdShape.test(id)) continue;
    const result = await input
      .run(
        [input.hermes, "sessions", "repair-prompts", id, "--apply", "--json"],
        60_000,
        {
          HOME: input.home,
          HERMES_HOME: hermesHome,
          ...(input.path ? { PATH: input.path } : {}),
        },
        { maxBytes: 64 * 1024 },
      )
      .catch(() => "timeout" as const);
    exits.set(id, result !== "timeout" && result.exitCode === 0);
  }
  const now = await heldNow(hermesHome, [...exits.keys()]);
  const stale = live.held.filter(({ id, prompt }) => {
    if (typeof id !== "string" || !exits.has(id)) return true;
    if (prompt === "unknown") return exits.get(id) !== true;
    if (now === undefined) return true;
    const after = now.has(id) ? now.get(id) : null;
    return after !== null && after === prompt;
  }).length;
  const refreshed = live.held.length - stale;
  return stale === 0 && !live.capped
    ? Object.freeze({ state: "refreshed", refreshed, live: live.held.length })
    : Object.freeze({
        state: "incomplete",
        refreshed,
        live: live.held.length,
        failed: stale,
        capped: live.capped,
      });
}

// ---- A refresh that is owed -------------------------------------------------

/** Buddy's state directory, beside the installer's records. */
export const buddyStateDirectory = (home: string): string =>
  join(home, ".local", "state", "lazurio", "buddy");
const stateDirectory = buddyStateDirectory;

/** The record that Buddy's stored prompts are owed a refresh: written before
 * SOUL.md changes, or before a refresh his changed Lazurio layer owes,
 * removed only after a complete refresh and the restart that follows it (or
 * with no gateway running), so a failure, a cap or anyone's restart in
 * between leaves it for the next apply. In Buddy's state directory, beside
 * the installer's records; the Platform's own file. */
export const promptRefreshOwedPath = (home: string): string =>
  join(stateDirectory(home), "prompt-refresh-owed.json");

/** A file of the Platform's own in Buddy's state directory: 0600 in a 0700
 * directory, written whole and renamed into place. */
export async function writeBuddyStateFile(
  path: string,
  document: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.lazurio`;
  const file = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(`${JSON.stringify(document)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

/** Whether the owed refresh is recorded: anything at the marker's place
 * counts. */
export async function promptRefreshMarked(home: string): Promise<boolean> {
  return (
    (await lstat(promptRefreshOwedPath(home)).catch(() => undefined)) !==
    undefined
  );
}

/** Records that a refresh is owed, unless it already is. */
export async function owePromptRefresh(
  home: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (await promptRefreshMarked(home)) return;
  await writeBuddyStateFile(promptRefreshOwedPath(home), {
    schema_version: "lazurio.buddy-prompt-refresh.v1",
    owed_since: `${now().toISOString().slice(0, 19)}Z`,
  });
}

/** The owed refresh is done. */
export const settlePromptRefresh = (home: string): Promise<void> =>
  rm(promptRefreshOwedPath(home), { force: true });

// ---- What the stored prompts were built from --------------------------------

/** Buddy's Lazurio layer as his prompts would be built from it now.
 * `layerDigest`: a sha256 over each file of `buddyLayerPaths`, in order, of
 * its path, then its bytes, or a token of its own where it is absent or
 * unreadable. `unreadable`: some file is no regular file (a link, which is
 * never followed, included), is larger than `layerFileBytes`, or could not be
 * read. */
export type PromptInputs = Readonly<{
  layerDigest: string;
  unreadable: boolean;
}>;

/** A rendered file of the layer is a few kilobytes; a larger one counts as
 * unreadable. */
const layerFileBytes = 1024 * 1024;

/** One file of the layer: its bytes, `absent`, or `unreadable`. */
async function layerFile(
  path: string,
): Promise<Buffer | "absent" | "unreadable"> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > layerFileBytes) return "unreadable";
      const bytes = await handle.readFile();
      return bytes.byteLength > layerFileBytes ? "unreadable" : bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "absent"
      : "unreadable";
  }
}

/** Buddy's Lazurio layer in `folder`, read only: never a reason to fail. The
 * paths are the Folder's own, so a Folder that moves keeps its digest. */
export async function readPromptInputs(folder: string): Promise<PromptInputs> {
  const hash = createHash("sha256");
  let unreadable = false;
  for (const path of buddyLayerPaths) {
    const file = await layerFile(join(folder, path));
    hash.update(`${path}\0`);
    if (typeof file === "string") {
      hash.update(`${file}\0`);
      if (file === "unreadable") unreadable = true;
    } else {
      hash.update(`file ${file.byteLength}\0`);
      hash.update(file);
    }
  }
  return Object.freeze({ layerDigest: hash.digest("hex"), unreadable });
}

/** What Buddy's stored prompts were last completely refreshed from: the
 * digest of his Lazurio layer as it was when that refresh began. Written only
 * after a complete refresh and the restart that follows it, with the owed
 * marker's removal, never by a reading. Beside the marker; the Platform's own
 * file. */
export const promptInputsPath = (home: string): string =>
  join(stateDirectory(home), "prompt-inputs.json");

const promptInputsSchema = "lazurio.buddy-prompt-inputs.v1";
const promptInputsBytes = 4096;

/** The layer digest the last complete refresh recorded; undefined where none
 * is: no record, or one that is no regular file of at most 4 KiB holding this
 * schema and a digest. A digest that is not a layer's never equals one. */
export async function recordedPromptInputs(
  home: string,
): Promise<string | undefined> {
  try {
    const handle = await open(
      promptInputsPath(home),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > promptInputsBytes) return undefined;
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const record: unknown = JSON.parse(text);
    return isObject(record) &&
      record.schema_version === promptInputsSchema &&
      typeof record.layer_digest === "string"
      ? record.layer_digest
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `inputs` are not what the last complete refresh was built from;
 * no record counts, so the first apply after this record exists refreshes
 * once. */
export async function promptInputsChanged(
  home: string,
  inputs: PromptInputs,
): Promise<boolean> {
  return inputs.layerDigest !== (await recordedPromptInputs(home));
}

/** Records `inputs` as what the stored prompts were built from, after a
 * complete refresh that began with them. */
export const recordPromptInputs = (
  home: string,
  inputs: PromptInputs,
): Promise<void> =>
  writeBuddyStateFile(promptInputsPath(home), {
    schema_version: promptInputsSchema,
    layer_digest: inputs.layerDigest,
  });

/** Whether a refresh of Buddy's stored prompts is owed: its marker is there,
 * or his Lazurio layer in `folder` is not the one the last complete refresh
 * was built from (none recorded counts). Reads only, so the read without
 * `--apply` and the Launchpad's readings count a changed layer as owed and
 * write nothing; an apply turns it into the marker before it refreshes. */
export async function promptRefreshOwed(
  home: string,
  folder: string,
): Promise<boolean> {
  if (await promptRefreshMarked(home)) return true;
  return promptInputsChanged(home, await readPromptInputs(folder));
}
