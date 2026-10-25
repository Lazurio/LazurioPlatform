import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOpenSync, openedModule } from "../src/content/open-sync";
import type { SyncEntry, SyncRequest } from "../src/content/sync";
import {
  type BunInstaller,
  createModuleBunResolver,
  type ModuleBunResolver,
  type RuntimeReason,
} from "../src/modules/bun-runtime";
import type { BuiltRefresh } from "../src/modules/module-operations";
import { PreparationRefused } from "../src/modules/preparation-refusal";
import type {
  Catalog,
  CatalogOrganization,
} from "../src/organizations/catalog";
import {
  createUpdateJobs,
  everythingText,
  type UpdateItem,
  type UpdateLine,
  type UpdateParts,
  updateEverything,
} from "../src/update/everything";

// One `lazurio update` (root decision 0212 points 3 and 4, decision F9's
// second amendment of 2026-10-24) without processes: the order of its parts,
// that a failing part never stops another, the content's wait for another
// content operation, the tools part's pre-warm of the Bun the moved modules
// pin (with the resolver a start uses and Bun's installer as a fake), the
// Launchpad's job that a second click joins, the words of the CLI, and the
// Open of one module. The parts' own cores run for real in
// tests/module-built.test.ts.

const at = "2026-10-24T12:00:00.000Z";
const entry = (path: string, extra: Partial<SyncEntry> = {}): SyncEntry => ({
  organization: "Alpha",
  root: "organizations/alpha",
  path,
  kind: path === "." ? "root" : "module",
  branch: "main",
  result: "current",
  at,
  ...extra,
});
const built = (extra: Partial<BuiltRefresh> = {}): BuiltRefresh => ({
  organization: "alpha",
  module: "site",
  app: "app/package.json",
  result: "built",
  commit: "b".repeat(40),
  ...extra,
});
const moved = entry("workspace/site", {
  result: "fast-forwarded",
  from: "a".repeat(40),
  to: "b".repeat(40),
});
const current = {
  part: "product",
  result: "current",
  version: "0.1.12",
} as const;
/** A resolver for a part that must not resolve anything. */
const unasked: ModuleBunResolver = async () => {
  throw new Error("Not asked");
};

test("the parts run in order, content, tools and builds before Lazurio itself, and each line is heard under way and then with its answer", async () => {
  const order: string[] = [];
  const seen: UpdateLine[][] = [];
  const items = await updateEverything(
    {
      content: async (progress) => {
        order.push("content");
        const where = {
          organization: "Alpha",
          root: "organizations/alpha",
          path: "workspace/site",
          kind: "module",
          branch: "main",
        } as const;
        progress({ ...where, step: "checking" });
        progress({ ...where, step: "fetching", to: "b".repeat(40) });
        progress({ ...where, step: "done", entry: moved });
        return {
          kind: "content-sync",
          at,
          organizations: ["Alpha"],
          entries: [entry("."), moved],
        };
      },
      builds: async (progress) => {
        order.push("builds");
        progress({
          organization: "alpha",
          module: "site",
          app: "app/package.json",
          step: "building",
          commit: "b".repeat(40),
        });
        return [built()];
      },
      tools: {
        pins: async () => {
          order.push("tools");
          return [];
        },
        resolve: unasked,
      },
      product: async () => {
        order.push("product");
        return current;
      },
    },
    (lines) => seen.push([...lines]),
  );
  expect(order).toEqual(["content", "tools", "builds", "product"]);
  expect(items).toEqual([
    { part: "content", ...moved },
    { part: "content", ...entry(".") },
    { part: "build", ...built() },
    current,
  ]);
  // The module's line: checking, the newer commit while it is fetched, its
  // answer; then its build under way, and Lazurio's check.
  const site = seen.flatMap((lines) =>
    lines.flatMap((line) =>
      line.part === "content" &&
      "path" in line &&
      line.path === "workspace/site"
        ? [
            "step" in line
              ? `${line.step}${line.to === undefined ? "" : ` ${line.to.slice(0, 7)}`}`
              : line.result,
          ]
        : [],
    ),
  );
  expect([...new Set(site)]).toEqual([
    "checking",
    "fetching bbbbbbb",
    "fast-forwarded",
  ]);
  for (const part of ["build", "product"])
    expect(
      seen.some((lines) =>
        lines.some((line) => line.part === part && "step" in line),
      ),
    ).toBe(true);
});

test("a part that fails is one item and never stops the next: content's answers stay when Lazurio fails, and Lazurio is updated when content fails", async () => {
  const parts: UpdateParts = {
    content: async () => ({
      kind: "content-sync",
      at,
      organizations: ["Alpha"],
      entries: [entry(".")],
    }),
    builds: async () => [built()],
    product: async () => {
      throw new Error("network");
    },
  };
  expect(await updateEverything(parts)).toEqual([
    { part: "content", ...entry(".") },
    { part: "build", ...built() },
    { part: "product", result: "failed", reason: "operation-failed" },
  ]);
  expect(
    await updateEverything({
      ...parts,
      content: async () => {
        throw new Error("git");
      },
      builds: async () => {
        throw new Error("bun");
      },
      product: async () => ({
        part: "product",
        result: "updated",
        from: "0.1.11",
        to: "0.1.12",
      }),
    }),
  ).toEqual([
    { part: "content", result: "failed", reason: "operation-failed" },
    { part: "build", result: "failed", reason: "operation-failed" },
    { part: "product", result: "updated", from: "0.1.11", to: "0.1.12" },
  ]);
  // A content part that cannot run here says why.
  expect(
    await updateEverything({
      content: async () => ({
        kind: "not-allowed",
        reason: "not-for-this-environment",
      }),
      builds: async () => [],
      product: async () => current,
    }),
  ).toEqual([
    { part: "content", result: "not-run", reason: "not-for-this-environment" },
    current,
  ]);
});

test("content waits for another content operation a while, then says it was busy; the rest runs either way", async () => {
  let calls = 0;
  const slept: number[] = [];
  const free = await updateEverything(
    {
      content: async () => {
        calls += 1;
        return calls < 3
          ? { kind: "busy" }
          : {
              kind: "content-sync",
              at,
              organizations: [],
              entries: [entry(".")],
            };
      },
      builds: async () => [],
      product: async () => current,
    },
    undefined,
    {
      busyPollMs: 5,
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  );
  expect(calls).toBe(3);
  expect(slept).toEqual([5, 5]);
  expect(free[0]).toEqual({ part: "content", ...entry(".") });
  expect(
    await updateEverything(
      {
        content: async () => ({ kind: "busy" }),
        builds: async () => [],
        product: async () => current,
      },
      undefined,
      { busyWaitMs: 0 },
    ),
  ).toEqual([
    { part: "content", result: "not-run", reason: "content-busy" },
    current,
  ]);
});

// ---- The tools part: the Bun the moved modules pin (decision F62) -----------

// The resolver a start uses (`createModuleBunResolver`), with #626's seams: a
// fixed system, plenty of space, its own map of fetches under way, and Bun's
// installer as a fake that lays out, for each version, a program reporting
// it, or refuses as told. The user's Bun is the one running these tests. No
// network.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let scratch = "";
beforeAll(async () => {
  if (supported)
    scratch = await realpath(await mkdtemp(join(tmpdir(), "update-tools-")));
});
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function runtimes(
  name: string,
  refuse: (version: string) => RuntimeReason | undefined = () => undefined,
) {
  const home = join(scratch, name);
  await mkdir(home, { recursive: true, mode: 0o700 });
  /** Every version Bun's installer was asked for, in order. */
  const asked: string[] = [];
  const install: BunInstaller = async (input) => {
    asked.push(input.version);
    const refused = refuse(input.version);
    if (refused !== undefined) return { kind: "refused", reason: refused };
    const program = join(
      input.directory,
      "node_modules",
      input.packageName,
      "bin",
      "bun",
    );
    await mkdir(dirname(program), { recursive: true });
    await writeFile(program, `#!/bin/sh\necho '${input.version}'\n`);
    await chmod(program, 0o755);
    return { kind: "installed" };
  };
  const resolve = createModuleBunResolver({
    home,
    userBun: process.execPath,
    path: "/usr/bin:/bin",
    install,
    system: async () => ({
      platform: "linux",
      arch: "arm64",
      libc: "glibc",
      avx2: null,
    }),
    freeBytes: async () => 10 * 1024 ** 3,
    fetches: new Map(),
  });
  return { resolve, asked };
}

/** The tools part's items of an answer. */
const toolsOf = (items: readonly UpdateItem[]) =>
  items.filter((item) => item.part === "tools");

/** One run whose content fast-forwarded site, with these pins. */
const runWith = (
  pins: readonly string[],
  resolve: ModuleBunResolver,
  onChange?: (lines: readonly UpdateLine[]) => void,
) =>
  updateEverything(
    {
      content: async () => ({
        kind: "content-sync",
        at,
        organizations: ["Alpha"],
        entries: [moved],
      }),
      tools: { pins: async () => pins, resolve },
      builds: async () => [],
      product: async () => current,
    },
    onChange,
  );

posixTest(
  "tools come after content and before any build: the Bun a moved module's apps pin and the cache does not hold is fetched before the build that needs it",
  async () => {
    const { resolve, asked } = await runtimes("before-build");
    const order: string[] = [];
    const checkouts: unknown[] = [];
    const seen: UpdateLine[][] = [];
    const items = await updateEverything(
      {
        content: async () => ({
          kind: "content-sync",
          at,
          organizations: ["Alpha"],
          entries: [
            entry(".", { result: "fast-forwarded", to: "c".repeat(40) }),
            moved,
            entry("workspace/site/db", {
              kind: "data",
              result: "fast-forwarded",
              to: "d".repeat(40),
            }),
            entry("workspace/docs"),
          ],
        }),
        tools: {
          pins: async (moving) => {
            checkouts.push(moving);
            order.push("tools");
            return ["bun@1.4.99", "bun@1.4.99"];
          },
          resolve,
        },
        builds: async () => {
          // What the installer was asked for by the time the build starts.
          order.push(`builds after [${asked.join(", ")}]`);
          return [built()];
        },
        product: async () => current,
      },
      (lines) => seen.push([...lines]),
    );
    // Only the module checkouts this run fast-forwarded: not the root, a
    // data mount or a module that was current.
    expect(checkouts).toEqual([
      [
        {
          organization: "Alpha",
          root: "organizations/alpha",
          path: "workspace/site",
        },
      ],
    ]);
    expect(order).toEqual(["tools", "builds after [1.4.99]"]);
    expect(asked).toEqual(["1.4.99"]);
    expect(items.map((item) => item.part)).toEqual([
      "content",
      "content",
      "content",
      "content",
      "tools",
      "build",
      "product",
    ]);
    expect(toolsOf(items)).toEqual([
      { part: "tools", packageManager: "bun@1.4.99", result: "fetched" },
    ]);
    // The pin's line: under way, then its answer.
    expect([
      ...new Set(
        seen.flatMap((lines) =>
          lines.flatMap((line) =>
            line.part === "tools" && "packageManager" in line
              ? ["step" in line ? line.step : line.result]
              : [],
          ),
        ),
      ),
    ]).toEqual(["fetching", "fetched"]);
    // The next run finds it in the cache and fetches nothing.
    expect(toolsOf(await runWith(["bun@1.4.99"], resolve))).toEqual([
      { part: "tools", packageManager: "bun@1.4.99", result: "cached" },
    ]);
    expect(asked).toEqual(["1.4.99"]);
    // Nothing moved: no pins are read and nothing is resolved.
    let read = false;
    const still = await updateEverything({
      content: async () => ({
        kind: "content-sync",
        at,
        organizations: ["Alpha"],
        entries: [entry("."), entry("workspace/site")],
      }),
      tools: {
        pins: async () => {
          read = true;
          return ["bun@1.4.98"];
        },
        resolve: unasked,
      },
      builds: async () => [],
      product: async () => current,
    });
    expect(read).toBe(false);
    expect(toolsOf(still)).toEqual([]);
  },
);

posixTest(
  "offline: the first runtime-unavailable ends the pre-warm for the run, and the pins after it are not fetched, with no further attempt",
  async () => {
    const { resolve, asked } = await runtimes("offline", (version) =>
      version === "1.4.98" ? "runtime-unavailable" : undefined,
    );
    const items = await runWith(
      ["bun@1.4.97", "bun@1.4.98", "bun@1.4.99", `bun@${Bun.version}`],
      resolve,
    );
    expect(asked).toEqual(["1.4.97", "1.4.98"]);
    expect(toolsOf(items)).toEqual([
      { part: "tools", packageManager: "bun@1.4.97", result: "fetched" },
      {
        part: "tools",
        packageManager: "bun@1.4.98",
        result: "refused",
        reason: "runtime-unavailable",
      },
      {
        part: "tools",
        packageManager: "bun@1.4.99",
        result: "not-fetched",
        reason: "runtime-unavailable",
      },
      {
        part: "tools",
        packageManager: `bun@${Bun.version}`,
        result: "not-fetched",
        reason: "runtime-unavailable",
      },
    ]);
    // The rest of the run goes on.
    expect(items.at(-1)).toEqual(current);
  },
);

posixTest(
  "every other refusal is an item with its reason and the pre-warm goes on; a download that did not verify is a warning",
  async () => {
    const { resolve, asked } = await runtimes("refusals", (version) =>
      version === "1.4.96"
        ? "runtime-integrity-failed"
        : version === "1.4.97"
          ? "runtime-version-unknown"
          : version === "1.4.98"
            ? "runtime-disk-full"
            : undefined,
    );
    const items = await runWith(
      ["bun@1.4.96", "bun@1.4.97", "bun@1.4.98", "bun@1.4.99"],
      resolve,
    );
    expect(asked).toEqual(["1.4.96", "1.4.97", "1.4.98", "1.4.99"]);
    expect(toolsOf(items)).toEqual([
      {
        part: "tools",
        packageManager: "bun@1.4.96",
        result: "refused",
        reason: "runtime-integrity-failed",
        warning: true,
      },
      {
        part: "tools",
        packageManager: "bun@1.4.97",
        result: "refused",
        reason: "runtime-version-unknown",
      },
      {
        part: "tools",
        packageManager: "bun@1.4.98",
        result: "refused",
        reason: "runtime-disk-full",
      },
      { part: "tools", packageManager: "bun@1.4.99", result: "fetched" },
    ]);
  },
);

posixTest(
  "the user's own Bun is not fetched: a pin of exactly that version is there already",
  async () => {
    const { resolve, asked } = await runtimes("user-bun");
    expect(toolsOf(await runWith([`bun@${Bun.version}`], resolve))).toEqual([
      {
        part: "tools",
        packageManager: `bun@${Bun.version}`,
        result: "cached",
      },
    ]);
    expect(asked).toEqual([]);
  },
);

test("the update never fails because of tools: pins that cannot be read and a resolver that throws are items, and builds and Lazurio run either way", async () => {
  const builds: string[] = [];
  const parts = (tools: NonNullable<UpdateParts["tools"]>): UpdateParts => ({
    content: async () => ({
      kind: "content-sync",
      at,
      organizations: ["Alpha"],
      entries: [moved],
    }),
    tools,
    builds: async () => {
      builds.push("ran");
      return [built()];
    },
    product: async () => current,
  });
  expect(
    await updateEverything(
      parts({
        pins: async () => {
          throw new Error("catalog");
        },
        resolve: unasked,
      }),
    ),
  ).toEqual([
    { part: "content", ...moved },
    { part: "tools", result: "failed", reason: "operation-failed" },
    { part: "build", ...built() },
    current,
  ]);
  // A resolver that throws something other than a refusal, and one that
  // refuses: each its item, never a throw.
  const items = await updateEverything(
    parts({
      pins: async () => ["bun@1.4.98", "bun@1.4.99"],
      resolve: async ({ packageManager, owner }) => {
        if (packageManager === "bun@1.4.98") throw new Error("broken");
        throw new PreparationRefused(
          "runtime-unsupported-platform",
          join(owner, "package.json"),
          "Pinned Bun runtime unavailable",
        );
      },
    }),
  );
  expect(toolsOf(items)).toEqual([
    {
      part: "tools",
      packageManager: "bun@1.4.98",
      result: "refused",
      reason: "operation-failed",
    },
    {
      part: "tools",
      packageManager: "bun@1.4.99",
      result: "refused",
      reason: "runtime-unsupported-platform",
    },
  ]);
  expect(items.at(-2)).toEqual({ part: "build", ...built() });
  expect(items.at(-1)).toEqual(current);
  expect(builds).toEqual(["ran", "ran"]);
});

test("the Launchpad's job: one run at a time, a second start joins it, the newest stays readable after it ended", async () => {
  let finish: () => void = () => {};
  let report: (lines: readonly UpdateLine[]) => void = () => {};
  let runs = 0;
  const jobs = createUpdateJobs({
    run: (onChange) => {
      runs += 1;
      report = onChange;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  expect(jobs.latest()).toBeNull();
  const first = jobs.start();
  expect(first.joined).toBe(false);
  expect(jobs.latest()).toEqual({ id: first.job, state: "running", lines: [] });
  report([{ part: "product", step: "checking" }]);
  expect(jobs.start()).toEqual({ job: first.job, joined: true });
  expect(runs).toBe(1);
  expect(jobs.latest()?.lines).toEqual([{ part: "product", step: "checking" }]);
  report([current]);
  finish();
  await jobs.settled();
  expect(jobs.latest()).toEqual({
    id: first.job,
    state: "succeeded",
    lines: [current],
  });
  const third = jobs.start();
  expect(third.joined).toBe(false);
  expect(third.job).not.toBe(first.job);
  expect(runs).toBe(2);
  finish();
  await jobs.settled();
  // A run that throws still ends.
  const failing = createUpdateJobs({
    run: () => Promise.reject(new Error("x")),
  });
  failing.start();
  await failing.settled();
  expect(failing.latest()?.state).toBe("succeeded");
});

test("the CLI's words: what moved, what is left and a summary, what was built or not; nothing where there was nothing to do", () => {
  const items: UpdateItem[] = [
    { part: "content", ...entry(".") },
    { part: "content", ...moved },
    {
      part: "content",
      ...entry("workspace/docs", { result: "blocked", reason: "dirty" }),
    },
    { part: "content", ...entry("workspace/gone", { result: "absent" }) },
    { part: "build", ...built() },
    {
      part: "build",
      ...built({
        module: "blog",
        result: "failed",
        reason: "build-script-failed",
      }),
    },
    { part: "build", ...built({ module: "docs", result: "current" }) },
  ];
  expect(everythingText(items)).toEqual([
    `organizations/alpha/workspace/site (main): fast-forwarded ${"a".repeat(12)}..${"b".repeat(12)}`,
    "organizations/alpha/workspace/docs (main): blocked dirty, left as it is",
    "Content: 4 repositories checked, 1 fast-forwarded, 1 left as they are.",
    `Built alpha/site (app/package.json) at ${"b".repeat(12)}.`,
    "alpha/blog (app/package.json) was not built (build-script-failed); what runs stays as it was.",
  ]);
  expect(
    everythingText([
      { part: "content", result: "not-run", reason: "not-installed" },
      {
        part: "content",
        result: "not-run",
        reason: "not-for-this-environment",
      },
    ]),
  ).toEqual([]);
  expect(
    everythingText([
      { part: "content", result: "not-run", reason: "content-busy" },
    ]),
  ).toEqual([
    "Content was not synchronized: another content operation kept the Folder busy (content-busy). Run lazurio update again.",
  ]);
  // The tools part: what was fetched or not, the warning first in its line,
  // nothing for a Bun that was there already.
  expect(
    everythingText([
      { part: "content", ...moved },
      { part: "tools", packageManager: "bun@1.4.99", result: "fetched" },
      { part: "tools", packageManager: `bun@${Bun.version}`, result: "cached" },
      {
        part: "tools",
        packageManager: "bun@1.4.96",
        result: "refused",
        reason: "runtime-integrity-failed",
        warning: true,
      },
      {
        part: "tools",
        packageManager: "bun@1.4.97",
        result: "refused",
        reason: "runtime-version-unknown",
      },
      {
        part: "tools",
        packageManager: "bun@1.4.98",
        result: "refused",
        reason: "runtime-unavailable",
      },
      {
        part: "tools",
        packageManager: "bun@1.4.95",
        result: "not-fetched",
        reason: "runtime-unavailable",
      },
      { part: "tools", result: "failed", reason: "operation-failed" },
    ]).slice(2),
  ).toEqual([
    "Fetched Bun 1.4.99 for the apps that pin it.",
    "Warning: Bun 1.4.96 did not verify and was discarded (runtime-integrity-failed).",
    "Bun 1.4.97 was not fetched (runtime-version-unknown).",
    "Bun 1.4.98 was not fetched: the registry did not answer (runtime-unavailable).",
    "Bun 1.4.95 was not tried: the registry did not answer this run (runtime-unavailable).",
    "Tools failed (operation-failed).",
  ]);
});

// ---- The Open of one module ---------------------------------------------------

const module = {
  organization: "Alpha",
  root: "organizations/alpha",
  path: "workspace/site",
} as const;

function openWorld(record: readonly SyncEntry[] | null = null) {
  let clock = 1_000_000;
  const requests: SyncRequest[] = [];
  const pending: (() => void)[] = [];
  const sync = createOpenSync({
    now: () => clock,
    record: async () => record,
    sync: (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        pending.push(() =>
          resolve({
            kind: "content-sync",
            at,
            organizations: ["Alpha"],
            entries: [],
          }),
        );
      });
    },
  });
  return {
    sync,
    requests,
    finish: () => {
      for (const done of pending.splice(0)) done();
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("an Open synchronizes exactly that module in the background, once per module in 5 minutes", async () => {
  const world = openWorld();
  // Returns at once: the answer never waits for the synchronization, which
  // is still under way here.
  expect(world.sync.opened(module)).toBeUndefined();
  await Bun.sleep(0);
  expect(world.requests).toEqual([
    { organization: "Alpha", repository: "workspace/site" },
  ]);
  // Opened again, and again through the gateway's ensure: nothing more.
  world.sync.opened(module);
  world.advance(4 * 60_000);
  world.sync.opened({ ...module, organization: "alpha" });
  await Bun.sleep(0);
  expect(world.requests).toHaveLength(1);
  // Another module is its own.
  world.sync.opened({ ...module, path: "workspace/docs" });
  await Bun.sleep(0);
  expect(world.requests.at(-1)).toEqual({
    organization: "Alpha",
    repository: "workspace/docs",
  });
  // Five minutes after the first: once more.
  world.advance(60_000);
  world.sync.opened(module);
  await Bun.sleep(0);
  expect(world.requests).toHaveLength(3);
  world.finish();
  await world.sync.settled();
});

test("an Open never synchronizes a checkout the last round left blocked, nor one of a blocked root; the hourly round tries those again", async () => {
  for (const blocked of [
    entry("workspace/site", { result: "blocked", reason: "dirty" }),
    entry(".", { result: "blocked", reason: "wrong-branch" }),
  ]) {
    const world = openWorld([blocked]);
    world.sync.opened(module);
    await world.sync.settled();
    world.advance(10 * 60_000);
    world.sync.opened(module);
    await world.sync.settled();
    expect(world.requests).toEqual([]);
  }
  // Another module's or another Organization's blocked checkout is not this
  // one's.
  const world = openWorld([
    entry("workspace/docs", { result: "blocked", reason: "dirty" }),
    entry(".", {
      organization: "Beta",
      root: "organizations/beta",
      result: "blocked",
      reason: "dirty",
    }),
  ]);
  world.sync.opened(module);
  await Bun.sleep(0);
  expect(world.requests).toHaveLength(1);
  world.finish();
  await world.sync.settled();
});

test("the module an answer names, as the synchronization names it: by the Organization's GitHub login, never the Personalspace", () => {
  const group = (
    directory: string,
    organization: string,
    forgeLogin?: string,
  ): CatalogOrganization => ({
    directory,
    organization,
    displayName: organization,
    ...(forgeLogin === undefined ? {} : { forgeLogin }),
    state: "current",
    issues: [],
    executable: true,
    teams: [],
    repositories: [],
    modules: [
      {
        organization,
        module: "site",
        path: "workspace/site",
        teams: ["workspace"],
        teamsSource: "default",
        apps: [],
        defaultApp: null,
        state: "current",
        executable: true,
      },
    ],
  });
  const catalog: Catalog = {
    kind: "catalog",
    organizations: [
      group("alpha_GEN3", "alpha", "Alpha"),
      group("beta", "beta"),
    ],
    personalspace: group("personalspace", "personalspace", "someone"),
  };
  expect(
    openedModule(catalog, { organization: "alpha", module: "site" }),
  ).toEqual({
    organization: "Alpha",
    root: "organizations/alpha_GEN3",
    path: "workspace/site",
  });
  expect(
    openedModule(catalog, { organization: "alpha", module: "other" }),
  ).toBeNull();
  expect(
    openedModule(catalog, { organization: "beta", module: "site" }),
  ).toBeNull();
  expect(
    openedModule(catalog, { organization: "personalspace", module: "site" }),
  ).toBeNull();
});
