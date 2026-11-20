import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  CustomServerInput,
  CustomServerSettings,
} from "../integrations/custom-server";
import type { ToolRunner } from "../tools/status";
import { writeDurableFile } from "../update/durable-file";
import { meaningPauseMs } from "./meaning";
import type { BrainPaths } from "./pin";

// The person's brain at the Launchpad's start (plan LZD-0033 R11a, step 4),
// where it sets Executor up (decision F44): once Executor's own setup has
// ended, the Launchpad runs `lazurio brain setup --json` as a child process
// (the admin token is read by that process alone, never by the Launchpad's)
// and reads only its closed labels. Where Lazurio's server answers, Executor
// gets the custom remote server Brain with the Executor key's handover, so
// every agent of the Environment reads and writes the brain over MCP
// without an instruction. Never awaited by the start and never a reason for
// it to fail; its journal line holds closed labels only.

/** The closed labels `lazurio brain setup --json` prints. */
export type BrainSetupLabels = Readonly<{
  server: string;
  move?: string;
  takeover?: string;
  vault?: string;
  meaning?: string;
}>;

/** How long the Launchpad lets one setup run: longer than its longest
 * supported step, the first embedding of a brain switched to search by
 * meaning (gbrain's `embed`, limited to 6 hours; 86 minutes were measured for
 * ten times the largest measured brain), with the copy, a migration and the
 * start around it. A setup it ends anyway leaves its gbrain command
 * running in its own group; the next setup ends that writer before it
 * recovers or starts anything (`./writers.ts`). */
export const setupTimeoutMs = 8 * 3_600_000;

/** Machines' mark that they hand the brain over on this host (C1). */
export const brainHandoverMark = "/etc/lazurio/brain-handover";

/** Setup at the Launchpad's start, and once more as soon as Machines mark
 * the handover. A converging apply restarts the Launchpad before it writes
 * the mark as its last step, so the start's setup can answer
 * `waits-machines`. Until the next start nothing would run it again, so it
 * runs again when the mark appears, checked every `waitMs`, for at most
 * `waits` checks. A Launchpad that closes (`signal` aborted) ends the wait
 * at once, its pending sleep included, and never starts another setup, not
 * even when a check of the mark it began before closing then succeeds.
 * `report` hears the first answer while it waits. */
/** Whether a run's search by meaning waits for another run: `waits-idle`
 * or `waits:…` (filling, a failed window, the model not ready). */
export const meaningWaits = (labels: BrainSetupLabels | null) =>
  labels?.meaning === "waits-idle" ||
  labels?.meaning?.startsWith("waits:") === true;

export async function brainSetupAtStart(
  input: Readonly<{
    run: () => Promise<BrainSetupLabels | null>;
    handover: () => Promise<boolean>;
    signal: AbortSignal;
    report?: (labels: BrainSetupLabels) => void;
    /** After every run, with its labels: the Launchpad hands the brain to
     * Executor there, so agents reach it while windows are left. */
    settled?: (labels: BrainSetupLabels | null) => Promise<void>;
    waitMs?: number;
    waits?: number;
    /** The pause before the next window's run (`meaningPauseMs`), and how
     * many such runs one start makes at most. */
    fillMs?: number;
    fills?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  }>,
): Promise<BrainSetupLabels | null> {
  const { signal } = input;
  if (signal.aborted) return null;
  const sleep = input.sleep ?? abortableSleep;
  const run = async () => {
    const labels = await input.run();
    if (!signal.aborted) await input.settled?.(labels).catch(() => undefined);
    return labels;
  };
  let labels = await run();
  if (labels?.server === "waits-machines" && !signal.aborted) {
    input.report?.(labels);
    for (let i = 0; i < (input.waits ?? 720); i++) {
      await sleep(input.waitMs ?? 60_000, signal);
      if (signal.aborted) return labels;
      const marked = await input.handover().catch(() => false);
      if (signal.aborted) return labels;
      if (marked) {
        labels = await run();
        break;
      }
    }
  }
  // Search by meaning that waits (windows left, Buddy working before a
  // window, a window that failed and is tried again, the model not ready
  // yet): the next run after a pause, while this start lasts and at most
  // `fills` runs (a day at the default pause); a later start goes on from
  // the brain's own record. It ends at `on`, `held`, a stop for a person or
  // any other answer.
  for (let i = 0; i < (input.fills ?? 288); i++) {
    if (labels === null || !meaningWaits(labels) || signal.aborted) break;
    input.report?.(labels);
    await sleep(input.fillMs ?? meaningPauseMs, signal);
    if (signal.aborted) break;
    labels = await run();
  }
  return labels;
}

/** A sleep that ends early when `signal` is aborted. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Runs `lazurio brain setup --json` as a child process of `executable`;
 * null when it did not finish or printed no labels. */
export async function runBrainSetup(
  input: Readonly<{
    executable: string;
    run: ToolRunner;
    env: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<BrainSetupLabels | null> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env))
    if (value !== undefined) env[name] = value;
  const result = await input
    .run([input.executable, "brain", "setup", "--json"], setupTimeoutMs, env)
    .catch(() => "timeout" as const);
  if (result === "timeout") return null;
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof value.server !== "string") return null;
    const label = (key: string) =>
      typeof value[key] === "string" ? { [key]: value[key] as string } : {};
    return Object.freeze({
      server: value.server,
      ...label("move"),
      ...label("takeover"),
      ...label("vault"),
      ...label("meaning"),
    });
  } catch {
    return null;
  }
}

/** Where Lazurio's server answers after setup: Executor may reach it. */
export const brainAnswers = (labels: BrainSetupLabels | null) =>
  labels !== null &&
  ["installed", "started", "running", "moved", "held", "waits-move"].includes(
    labels.server,
  );

/** What the Launchpad's custom servers of Executor offer (Integrations →
 * Vlastní, decision F42): the one path a custom server is added or saved. */
export type BrainServerSessions = Readonly<{
  addCustom(
    server: CustomServerInput,
  ): Promise<Readonly<{ kind: string; app?: string; reason?: string }>>;
  customSettings(
    id: string,
  ): Promise<CustomServerSettings | Readonly<{ kind: "blocked" }>>;
  updateCustom(
    id: string,
    server: CustomServerInput,
  ): Promise<Readonly<{ kind: string }>>;
  /** The ids of the custom servers of a name; null when unreadable. */
  customIdsNamed(name: string): Promise<readonly string[] | null>;
}>;

export type BrainServerResult =
  | "added"
  | "kept"
  | "updated"
  | "no-key"
  | "name-taken"
  | "failed";

/** Lazurio's record of the server it added: its id in Executor and which
 * key it carries, as a short digest of the key, never the key. */
const recordPath = (paths: BrainPaths) =>
  join(dirname(paths.state), "executor.json");

const digestOf = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Executor's custom remote server Brain with the Executor key (read,
 * write): added once, kept while it carries the key handed over, saved
 * again with the new key after setup minted one. A server of that name
 * Lazurio did not add is left alone (`name-taken`).
 *
 * Each add is marked: its record (`pending`, a fresh nonce) is written
 * first, and the server is added with a header named by that nonce. Where
 * an add created the server but did not connect it, or the record of its id
 * was not written, the next run completes only the server that carries its
 * own mark. A server of that name without it (one that was there before,
 * or one created meanwhile) stays someone's. */
export async function convergeBrainServer(
  paths: BrainPaths,
  sessions: BrainServerSessions,
): Promise<BrainServerResult> {
  const handover = await readJson(paths.executorKey);
  const url = handover?.url;
  const token = handover?.token;
  if (
    typeof url !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) ||
    typeof token !== "string" ||
    token.length < 16
  )
    return "no-key";
  const server: CustomServerInput = Object.freeze({
    type: "http",
    name: "Brain",
    url: `${url}/mcp`,
    bearer: Object.freeze({ value: token }),
    headers: Object.freeze([]),
  });
  const digest = digestOf(token);
  const record = await readJson(recordPath(paths));
  /** The server's id, recorded as Lazurio's; with the key's digest only
   * once a save with that key succeeded (until then a run saves again). */
  const write = async (slug: string, saved: boolean) => {
    await mkdir(dirname(recordPath(paths)), { recursive: true, mode: 0o700 });
    await writeDurableFile(
      dirname(recordPath(paths)),
      basename(recordPath(paths)),
      Buffer.from(
        `${JSON.stringify(saved ? { slug, key: digest } : { slug })}\n`,
      ),
    );
  };
  /** Saves Lazurio's server as it should be (the key, no attempt's mark).
   * Its id is recorded first, so a save that dies half way, or a run that
   * dies after it, is saved again by the next run, never lost. */
  const own = async (
    id: string,
    result: "added" | "updated",
  ): Promise<BrainServerResult> => {
    await write(id, false);
    const saved = await sessions.updateCustom(id, server);
    if (saved.kind !== "saved" && saved.kind !== "connected") return "failed";
    await write(id, true);
    return result;
  };
  const slug = typeof record?.slug === "string" ? record.slug : undefined;
  if (slug !== undefined) {
    const settings = await sessions.customSettings(slug);
    if (settings.kind === "custom-server" && settings.type === "http") {
      if (record?.key === digest && settings.url === server.url) return "kept";
      return own(slug, "updated");
    }
  }
  const ids = await sessions.customIdsNamed(server.name);
  if (ids === null) return "failed";
  // Lazurio's recorded server whose settings could not be read now is
  // still Lazurio's: kept on record and tried again, never taken for
  // someone's. Only a listing without it confirms it is gone.
  if (slug !== undefined && ids.includes(slug)) return "failed";
  const nonce = typeof record?.pending === "string" ? record.pending : null;
  if (nonce !== null) {
    // An earlier add of Lazurio's may have created it: only the server that
    // carries that attempt's own header, which nobody else knows, is
    // completed with the key; its header goes with the save.
    const mine: string[] = [];
    for (const id of ids) {
      const settings = await sessions.customSettings(id);
      // A server whose settings cannot be read now may be the marked one:
      // the pending record stays, and the next run looks again.
      if (settings.kind !== "custom-server") return "failed";
      if (
        settings.kind === "custom-server" &&
        settings.type === "http" &&
        settings.url === server.url &&
        settings.headers.includes(attemptHeader(nonce))
      )
        mine.push(id);
    }
    if (mine.length === 1) return own(mine[0] as string, "added");
  }
  if (ids.length > 0) {
    // A server of that name this attempt did not create: someone's.
    await rm(recordPath(paths), { force: true }).catch(() => undefined);
    return "name-taken";
  }
  // The attempt's own mark, before the add: a header whose name carries a
  // fresh nonce, recorded first, so a later run tells this add's server
  // from any other, whatever happens between.
  const fresh = randomBytes(12).toString("hex");
  try {
    await mkdir(dirname(recordPath(paths)), { recursive: true, mode: 0o700 });
    await writeDurableFile(
      dirname(recordPath(paths)),
      basename(recordPath(paths)),
      Buffer.from(`${JSON.stringify({ pending: fresh })}\n`),
    );
  } catch {
    return "failed";
  }
  const added = await sessions.addCustom({
    ...server,
    headers: Object.freeze([
      Object.freeze({ name: attemptHeader(fresh), value: "1" }),
    ]),
  });
  if (added.kind === "blocked" && added.reason === "name-taken") {
    // Another server of that name came first: never Lazurio's to complete.
    await rm(recordPath(paths), { force: true }).catch(() => undefined);
    return "name-taken";
  }
  if (added.kind !== "connected" || typeof added.app !== "string")
    return "failed";
  // Its id recorded, then saved again without the attempt's header.
  return own(added.app, "added");
}

/** The header that marks one attempt's server: its name carries the nonce
 * (Executor shows a header's name, never its value). */
const attemptHeader = (nonce: string) => `X-Lazurio-Attempt-${nonce}`;
