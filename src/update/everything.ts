import { randomBytes } from "node:crypto";
import type { SyncEntry, SyncProgress, SyncRun } from "../content/sync";
import {
  type ModuleBunResolver,
  prewarmModuleRuntimes,
  type RuntimePrewarm,
  type RuntimeReason,
} from "../modules/bun-runtime";
import type { BuiltProgress, BuiltRefresh } from "../modules/module-operations";

// One `lazurio update` (root decision 0212 point 3, decision F9's second
// amendment of 2026-10-24): the same command on a computer and on an Environment
// brings everything the user owns up to date, in parts that keep their own
// cores, locks and outcomes. In order:
//
//   1. content: the clean primary checkouts of the Organizations this
//      Environment holds on their published branch (`syncContent`);
//   2. tools: the Bun each app of the module checkouts the content just
//      fast-forwarded pins (decision F62), made available with the resolver
//      a start uses (`prewarmModuleRuntimes`), before any build, so a build
//      never waits for its module's Bun (DEV-6682); its one answer about the
//      network holds for the builds of the same run;
//   3. builds: every built app someone opened whose checkout moved past its
//      build, built and swapped in (`refreshBuilt`, decision F58);
//   4. product: Lazurio itself to the newest public release, last, because
//      its activation restarts the Launchpad (docs/update.md).
//
// A part that fails, or cannot run, is one item of the answer and never
// stops the next: content never waits for the product, nor the product for
// content. The answer is a list of items, one per repository, pinned Bun,
// built app and product, and while it runs each item's step. The CLI prints
// it, and the Launchpad runs the same composition as a job
// (`createUpdateJobs`) for the Aktualizovat button of Nová karta.

/** Why the content part did not run. */
export const contentNotRunReasons = [
  "folder-unreadable",
  "not-for-this-environment",
  "content-busy",
  "not-installed",
] as const;
export type ContentNotRun = (typeof contentNotRunReasons)[number];

/** A content part that does not run here, and why. */
export const contentNotRun = (why: ContentNotRun) =>
  Object.freeze({ kind: "not-run" as const, reason: why });

/** Why a part answered as a whole: it threw (`partFailed`), or Lazurio is
 * not installed here (`productNotInstalled`). Items, not the update's error
 * contexts (`updateErrorReasons`). */
export const partFailed = "operation-failed";
export const productNotInstalled = "not-installed";

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
  | Readonly<{
      part: "product";
      result: "not-run";
      reason: typeof productNotInstalled;
    }>;

/** A module checkout the content part fast-forwarded in this run, as the
 * synchronization names it: the Organization's GitHub login, its root
 * relative to the Folder and the module's path relative to the root. */
export type MovedModule = Readonly<{
  organization: string;
  root: string;
  path: string;
}>;

/** The registry did not answer (decision F62): the first such refusal ends
 * the pre-warm of the run. */
export const runtimeUnavailable = "runtime-unavailable" satisfies RuntimeReason;
/** A download that did not verify, or a program that reports another
 * version (decision F62): tampered or broken, so a warning. */
export const runtimeIntegrityFailed =
  "runtime-integrity-failed" satisfies RuntimeReason;

/** The tools part's answer for one Bun an app pins (decision F62), by its
 * pin (`bun@x.y.z`). `cached`: there already (the user's Bun is that
 * version, or the runtime cache holds it), nothing fetched; `fetched`: now
 * in the runtime cache; `refused`: it could not be had, with the reason a
 * start would give (a `runtime-*` reason, or `operation-failed`), and
 * `warning` for a download that did not verify; `not-fetched`: neither the
 * user's Bun nor the cache has it, and it was not fetched because the
 * registry did not answer for an earlier pin of this run. */
export type ToolsItem = Readonly<{ part: "tools"; packageManager: string }> &
  (
    | Readonly<{ result: "cached" | "fetched" }>
    | Readonly<{ result: "refused"; reason: string; warning?: true }>
    | Readonly<{ result: "not-fetched"; reason: typeof runtimeUnavailable }>
  );

/** One item of the answer. */
export type UpdateItem =
  | (Readonly<{ part: "content" }> & SyncEntry)
  | Readonly<{ part: "content"; result: "not-run"; reason: ContentNotRun }>
  | ToolsItem
  | (Readonly<{ part: "build" }> & BuiltRefresh)
  | ProductItem
  | Readonly<{
      part: "content" | "build" | "tools" | "product";
      result: "failed";
      reason: typeof partFailed;
    }>;

/** What the builds of one run know about the network: its pre-warm found
 * the registry not answering (`runtime-unavailable`, and nothing else).
 * Memory of that run only, never kept for the next. */
export type UpdateNetwork = Readonly<{ registryUnavailable: boolean }>;

/** An item while it is under way. A pin's `fetching` lasts while its Bun is
 * made available: a fetch, or only the moment it takes to find it there. */
export type UpdateStep =
  | (Readonly<{ part: "content" }> &
      Omit<SyncProgress, "entry" | "step"> &
      Readonly<{ step: "checking" | "fetching" | "fast-forwarding" }>)
  | Readonly<{ part: "tools"; packageManager: string; step: "fetching" }>
  | (Readonly<{ part: "build" }> & BuiltProgress)
  | Readonly<{ part: "product"; step: "checking" }>;

export type UpdateLine = UpdateItem | UpdateStep;

export type UpdateParts = Readonly<{
  /** Synchronize content, reporting each repository as it goes; a reason
   * when it cannot run here at all. */
  content: (
    onProgress: (progress: SyncProgress) => void,
  ) => Promise<SyncRun | Readonly<{ kind: "not-run"; reason: ContentNotRun }>>;
  /** The Bun the apps of the module checkouts this run fast-forwarded pin
   * (decision F62): their pins as the checkouts now declare them, with how
   * many could not be read (`runtimePins` of the module core), and the
   * resolver a start uses (the module core's `resolveBun`). Absent: no tools
   * part. */
  tools?: Readonly<{
    pins: (
      moved: readonly MovedModule[],
    ) => Promise<Readonly<{ pins: readonly string[]; unreadable: number }>>;
    resolve: ModuleBunResolver;
  }>;
  /** Build what changed (`refreshBuilt`), told what the run's pre-warm
   * found about the network. */
  builds: (
    onProgress: (progress: BuiltProgress) => void,
    network: UpdateNetwork,
  ) => Promise<readonly BuiltRefresh[]>;
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
  if (line.part === "tools")
    return "packageManager" in line ? `tools\0${line.packageManager}` : "tools";
  return line.part;
};

/** One pin's pre-warm as an item. */
function toolsItem(result: RuntimePrewarm): ToolsItem {
  if (result.kind !== "refused")
    return Object.freeze({
      part: "tools" as const,
      packageManager: result.packageManager,
      result: result.kind,
    });
  return Object.freeze({
    part: "tools" as const,
    packageManager: result.packageManager,
    result: "refused" as const,
    reason: result.reason,
    ...(result.reason === runtimeIntegrityFailed
      ? { warning: true as const }
      : {}),
  });
}

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
    set({ part, result: "failed", reason: partFailed });
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  // 1. Content, waiting a while for another content operation.
  const moved: MovedModule[] = [];
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
    const why: ContentNotRun | null =
      run.kind === "busy"
        ? "content-busy"
        : run.kind === "not-run" || run.kind === "not-allowed"
          ? run.reason
          : null;
    if (why !== null) set({ part: "content", result: "not-run", reason: why });
    else if (run.kind === "content-sync")
      for (const entry of run.entries) {
        set({ part: "content", ...entry });
        if (entry.kind === "module" && entry.result === "fast-forwarded")
          moved.push(
            Object.freeze({
              organization: entry.organization,
              root: entry.root,
              path: entry.path,
            }),
          );
      }
  } catch {
    failed("content");
  }

  // 2. Tools (DEV-6682): the Bun each app of the checkouts the content just
  // moved pins (decision F62), before any build, so that a build never waits
  // for it. A pin can change only with a commit, and this run's commits are
  // those the content brought; nothing moved, nothing to read. One pin at a
  // time, each a line as soon as it is known. The first time the registry
  // does not answer ends the fetches: each pin after that one is only looked
  // up without the network, `cached` when the user's Bun or the cache has
  // it, otherwise `not-fetched`. That one answer about the network holds for
  // the builds of this run, and for nothing after it. A pin that cannot be
  // had is an item, never a failed update. Pins that could not be read are
  // one failed item of the part, after the others are pre-warmed.
  let registryUnavailable = false;
  const tools = parts.tools;
  if (tools !== undefined && moved.length > 0)
    try {
      const local: ModuleBunResolver = (input) =>
        tools.resolve({ ...input, fetch: false });
      const { pins, unreadable } = await tools.pins(moved);
      for (const packageManager of new Set(pins)) {
        if (!registryUnavailable)
          set({ part: "tools", packageManager, step: "fetching" });
        for (const result of await prewarmModuleRuntimes(
          registryUnavailable ? local : tools.resolve,
          [packageManager],
        )) {
          const unanswered =
            result.kind === "refused" && result.reason === runtimeUnavailable;
          set(
            registryUnavailable && unanswered
              ? {
                  part: "tools",
                  packageManager,
                  result: "not-fetched",
                  reason: runtimeUnavailable,
                }
              : toolsItem(result),
          );
          if (unanswered) registryUnavailable = true;
        }
      }
      if (unreadable > 0) failed("tools");
    } catch {
      failed("tools");
    }

  // 3. Builds of what changed, the content's new commits among them, told
  // what the pre-warm found about the network.
  try {
    const built = await parts.builds(
      (progress) => set({ part: "build", ...progress }),
      Object.freeze({ registryUnavailable }),
    );
    for (const answer of built) set({ part: "build", ...answer });
  } catch {
    failed("build");
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

/** A pin in words: `bun@1.4.3` is Bun 1.4.3. */
const bunOf = (packageManager: string) =>
  packageManager.startsWith("bun@")
    ? `Bun ${packageManager.slice("bun@".length)}`
    : packageManager;

/** What `lazurio update` prints of content, tools and builds, before the
 * product's own lines: a repository that moved or is left as it is, and a
 * summary; a pinned Bun fetched or not; a built app that was built or could
 * not be. Nothing where the part had nothing to do here (an Environment that
 * keeps no Organization, a Bun that was there already). */
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
    if (item.part !== "tools") continue;
    if (!("packageManager" in item)) {
      lines.push(
        "The Bun the moved modules pin could not all be read (operation-failed); a start or build of their apps names why.",
      );
      continue;
    }
    const bun = bunOf(item.packageManager);
    if (item.result === "fetched")
      lines.push(`Fetched ${bun} for the apps that pin it.`);
    else if (item.result === "not-fetched")
      lines.push(
        `${bun} was not tried: the registry did not answer this run (${item.reason}).`,
      );
    else if (item.result === "refused")
      lines.push(
        item.warning
          ? `Warning: ${bun} did not verify and was discarded (${item.reason}).`
          : item.reason === runtimeUnavailable
            ? `${bun} was not fetched: the registry did not answer (${item.reason}).`
            : `${bun} was not fetched (${item.reason}).`,
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
