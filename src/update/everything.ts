import { randomBytes } from "node:crypto";
import type { SyncEntry, SyncProgress, SyncRun } from "../content/sync";
import type { BuiltProgress, BuiltRefresh } from "../modules/module-operations";

// One `lazurio update` (root decision 0212 point 3, decision F9's second
// amendment of 2026-10-24): the same command on a computer and on an Environment
// brings everything the user owns up to date, in parts that keep their own
// cores, locks and outcomes. In order:
//
//   1. content: the clean primary checkouts of the Organizations this
//      Environment holds on their published branch (`syncContent`);
//   2. builds: every built app someone opened whose checkout moved past its
//      build, built and swapped in (`refreshBuilt`, decision F58);
//   3. tools: what the modules declare (DEV-6682; a seam, nothing yet);
//   4. product: Lazurio itself to the newest public release, last, because
//      its activation restarts the Launchpad (docs/update.md).
//
// A part that fails, or cannot run, is one item of the answer and never
// stops the next: content never waits for the product, nor the product for
// content. The answer is a list of items, one per repository, built app and
// product, and while it runs each item's step. The CLI prints it, and the
// Launchpad runs the same composition as a job (`createUpdateJobs`) for the
// Aktualizovat button of Nová karta.

/** Why the content part did not run. */
export type ContentNotRun =
  | "folder-unknown"
  | "folder-unreadable"
  | "not-for-this-environment"
  | "content-busy"
  | "not-installed";

/** The product part's answer. */
export type ProductItem =
  | Readonly<{ part: "product"; result: "current"; version: string }>
  /** The CLI switched the version itself. */
  | Readonly<{
      part: "product";
      result: "updated";
      from: string;
      to: string;
    }>
  /** The Launchpad started `lazurio update` in its own unit, which
   * outlives the restart it causes (docs/update.md "Activation"). */
  | Readonly<{ part: "product"; result: "started"; to: string }>
  | Readonly<{ part: "product"; result: "failed"; code: string }>
  | Readonly<{ part: "product"; result: "not-run"; reason: "not-installed" }>;

/** One item of the answer. */
export type UpdateItem =
  | (Readonly<{ part: "content" }> & SyncEntry)
  | Readonly<{ part: "content"; result: "not-run"; reason: ContentNotRun }>
  | (Readonly<{ part: "build" }> & BuiltRefresh)
  | ProductItem
  | Readonly<{
      part: "content" | "build" | "tools" | "product";
      result: "failed";
      reason: "operation-failed";
    }>;

/** An item while it is under way. */
export type UpdateStep =
  | (Readonly<{ part: "content" }> &
      Omit<SyncProgress, "entry" | "step"> &
      Readonly<{ step: "checking" | "fetching" | "fast-forwarding" }>)
  | (Readonly<{ part: "build" }> & BuiltProgress)
  | Readonly<{ part: "product"; step: "checking" }>;

export type UpdateLine = UpdateItem | UpdateStep;

export type UpdateParts = Readonly<{
  /** Synchronize content, reporting each repository as it goes; a reason
   * when it cannot run here at all. */
  content: (
    onProgress: (progress: SyncProgress) => void,
  ) => Promise<SyncRun | Readonly<{ kind: "not-run"; reason: ContentNotRun }>>;
  /** Build what changed (`refreshBuilt`). */
  builds: (
    onProgress: (progress: BuiltProgress) => void,
  ) => Promise<readonly BuiltRefresh[]>;
  /** The tools the modules declare (DEV-6682): none yet. */
  tools?: () => Promise<readonly UpdateItem[]>;
  /** Lazurio itself, last. */
  product: () => Promise<ProductItem>;
}>;

/** How long the content part waits for another content operation (the
 * Launchpad's hourly round, an installation) before it answers busy, and
 * how often it asks again. */
export const contentBusyWaitMs = 120_000;
export const contentBusyPollMs = 2_000;

const keyOf = (line: UpdateLine): string => {
  if (line.part === "content")
    return "path" in line
      ? `content\0${line.organization.toLowerCase()}\0${line.root}\0${line.path}`
      : "content";
  if (line.part === "build")
    return "app" in line
      ? `build\0${line.organization}\0${line.module}\0${line.app}`
      : "build";
  return line.part;
};

/** Runs the parts in order; `onChange` hears every line as it stands after
 * each change. The answer: every item, in the order the parts gave them. */
export async function updateEverything(
  parts: UpdateParts,
  onChange: (lines: readonly UpdateLine[]) => void = () => {},
  options: Readonly<{
    busyWaitMs?: number;
    busyPollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }> = {},
): Promise<readonly UpdateItem[]> {
  const lines = new Map<string, UpdateLine>();
  const set = (line: UpdateLine) => {
    lines.set(keyOf(line), Object.freeze(line));
    try {
      onChange(Object.freeze([...lines.values()]));
    } catch {}
  };
  const failed = (part: UpdateItem["part"]) =>
    set({ part, result: "failed", reason: "operation-failed" });
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  // 1. Content, waiting a while for another content operation.
  try {
    const onProgress = (progress: SyncProgress) => {
      if (progress.step === "done") {
        if (progress.entry !== undefined)
          set({ part: "content", ...progress.entry });
        return;
      }
      const { entry: _entry, ...where } = progress;
      set({ part: "content", ...where, step: progress.step });
    };
    const deadline = Date.now() + (options.busyWaitMs ?? contentBusyWaitMs);
    let run = await parts.content(onProgress);
    while (run.kind === "busy" && Date.now() < deadline) {
      await sleep(options.busyPollMs ?? contentBusyPollMs);
      run = await parts.content(onProgress);
    }
    if (run.kind === "busy")
      set({ part: "content", result: "not-run", reason: "content-busy" });
    else if (run.kind === "not-run" || run.kind === "not-allowed")
      set({ part: "content", result: "not-run", reason: run.reason });
    else for (const entry of run.entries) set({ part: "content", ...entry });
  } catch {
    failed("content");
  }

  // 2. Builds of what changed, the content's new commits among them.
  try {
    const built = await parts.builds((progress) =>
      set({ part: "build", ...progress }),
    );
    for (const answer of built) set({ part: "build", ...answer });
  } catch {
    failed("build");
  }

  // 3. The tools the modules declare (DEV-6682).
  try {
    for (const item of (await parts.tools?.()) ?? []) set(item);
  } catch {
    failed("tools");
  }

  // 4. Lazurio itself, last: its activation restarts the Launchpad.
  try {
    set({ part: "product", step: "checking" });
    set(await parts.product());
  } catch {
    failed("product");
  }
  return Object.freeze(
    [...lines.values()].filter((line): line is UpdateItem => "result" in line),
  );
}

// ---- The Launchpad's job -----------------------------------------------------

// `POST /api/update/everything` starts one run of the composition in the
// Launchpad's process, `GET /api/update/everything` reads the newest. One at a
// time: a start while one runs answers that run, so a second click joins it.
// Memory of this process only: a product activation restarts the Launchpad
// and the job goes with it, while what the run did stays in its owners'
// records (the content's record, the builds' states, the product's selector).

export type UpdateJob = Readonly<{
  id: string;
  state: "running" | "succeeded";
  /** Each line as it stands: an item's step while under way, then its
   * answer. */
  lines: readonly UpdateLine[];
}>;

export function createUpdateJobs(
  input: Readonly<{
    run: (onChange: (lines: readonly UpdateLine[]) => void) => Promise<unknown>;
  }>,
) {
  let latest: {
    id: string;
    state: UpdateJob["state"];
    lines: readonly UpdateLine[];
  } | null = null;
  let running: Promise<void> | null = null;
  const snapshot = (): UpdateJob | null =>
    latest === null
      ? null
      : Object.freeze({
          id: latest.id,
          state: latest.state,
          lines: latest.lines,
        });
  return Object.freeze({
    /** Starts a run, or answers the one under way. */
    start(): Readonly<{ job: string; joined: boolean }> {
      if (latest !== null && latest.state === "running")
        return Object.freeze({ job: latest.id, joined: true });
      const job: {
        id: string;
        state: UpdateJob["state"];
        lines: readonly UpdateLine[];
      } = {
        id: randomBytes(16).toString("hex"),
        state: "running",
        lines: Object.freeze([]),
      };
      latest = job;
      running = input
        .run((lines) => {
          job.lines = lines;
        })
        .catch(() => undefined)
        .then(() => {
          job.state = "succeeded";
          running = null;
        });
      return Object.freeze({ job: job.id, joined: false });
    },
    /** The newest run of this Launchpad, running or ended; null before the
     * first. */
    latest: snapshot,
    /** Resolves when no run is under way (shutdown, tests). */
    async settled(): Promise<void> {
      while (running !== null) await running;
    },
  });
}

// ---- In words, for the CLI -------------------------------------------------

const short = (commit: string | undefined) => commit?.slice(0, 12) ?? "";

const where = (entry: SyncEntry) =>
  entry.path === "." ? entry.root : `${entry.root}/${entry.path}`;

/** What `lazurio update` prints of content and builds, before the product's
 * own lines: a repository that moved or is left as it is, and a summary;
 * a built app that was built or could not be. Nothing where the part had
 * nothing to do here (no Folder, or an Environment that keeps no
 * Organization). */
export function everythingText(items: readonly UpdateItem[]): string[] {
  const lines: string[] = [];
  const entries: SyncEntry[] = [];
  for (const item of items) {
    if (item.part !== "content") continue;
    if ("path" in item) entries.push(item);
    else if (item.result === "not-run") {
      if (item.reason === "content-busy")
        lines.push(
          "Content was not synchronized: another content operation kept the Folder busy (content-busy). Run lazurio update again.",
        );
      else if (item.reason === "folder-unreadable")
        lines.push(
          "Content was not synchronized: the Folder's state could not be read (folder-unreadable).",
        );
    } else
      lines.push("Content was not synchronized: it failed (operation-failed).");
  }
  for (const entry of entries) {
    if (entry.result === "fast-forwarded")
      lines.push(
        `${where(entry)} (${entry.branch}): fast-forwarded ${short(entry.from)}..${short(entry.to)}`,
      );
    else if (entry.result !== "current" && entry.result !== "absent")
      lines.push(
        `${where(entry)} (${entry.branch}): ${entry.result}${entry.reason === undefined ? "" : ` ${entry.reason}`}, left as it is`,
      );
  }
  if (entries.length > 0) {
    const moved = entries.filter(
      (entry) => entry.result === "fast-forwarded",
    ).length;
    const left = entries.filter(
      (entry) =>
        !["current", "fast-forwarded", "absent"].includes(entry.result),
    ).length;
    lines.push(
      `Content: ${entries.length} repositories checked, ${moved} fast-forwarded, ${left} left as they are.`,
    );
  }
  for (const item of items) {
    if (item.part !== "build") continue;
    if (!("app" in item)) {
      lines.push("Builds failed (operation-failed).");
      continue;
    }
    const name = `${item.organization}/${item.module} (${item.app})`;
    if (item.result === "built")
      lines.push(`Built ${name} at ${short(item.commit)}.`);
    else if (item.result === "failed")
      lines.push(
        `${name} was not built${item.reason === undefined ? "" : ` (${item.reason})`}; what runs stays as it was.`,
      );
  }
  return lines;
}
