import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  holderDirectory,
  liveTabsPath,
  writeLiveTabs,
} from "../src/browser/contract/node";
import type { TabFacts } from "../src/browser/contract/platform";
import {
  type BootTime,
  holderFileText,
  parseHolder,
  parseHolderRecords,
} from "../src/browser/contract/pure";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import {
  createLaunchpadHolder,
  HolderFull,
  launchpadHolderOf,
  maxLaunchpadHolds,
  readHolderLabel,
} from "../src/launchpad/new-tab/holder";
import {
  closeTab,
  hubCalls,
  listTabs,
  openTab,
  restoreTab,
} from "../src/launchpad/new-tab/hub-client";
import {
  parseMeminfo,
  parseUnitsMemory,
  readEnvironmentMemory,
  t3codeUnit,
} from "../src/launchpad/new-tab/memory";
import {
  type ModuleUnit,
  runningModules,
} from "../src/launchpad/new-tab/modules";
import {
  createNewTabRoutes,
  type NewTabHost,
  processNewTabHost,
} from "../src/launchpad/new-tab-routes";
import { startLaunchpad } from "../src/launchpad/server";
import type { ModuleHost } from "../src/modules/module-operations";
import type { ServiceManagerProcess } from "../src/modules/service-manager-process";
import {
  applicationUnitName,
  createSystemdUserRunner,
  organizationUnitPrefix,
} from "../src/modules/systemd-user-runner";
import { embeddedIdentity } from "../src/update/identity";
import {
  folderFixture,
  heldBy,
  writePersonalspaceModule,
} from "./fixtures/catalog-folder";
import { binding, entries, withBrowser } from "./fixtures/machine-bindings";
import organizationContext from "./fixtures/machine-context.json";

// Nová karta on the Launchpad (decision F47 step 2): the loopback client to
// the view's hub, the Launchpad's holder file and its reconciliation with the
// hub's list of live tabs, the Environment's memory, the running Modules, and
// the routes that join them. The hub is a loopback fake of its documented
// answers (its real service is tested against this client in
// environment-browser-view.test.ts); systemctl, /proc and the boot clock are
// injected. No real runtime directory, unit or browser is touched.

const origin = "https://browser.workspace.example.lazurio.io";
const id = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");
const boot = "6f2c1d0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const earlierBoot = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const at = (seconds: number, ofBoot: string = boot): BootTime => ({
  boot: ofBoot,
  at: seconds,
});

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporary(prefix: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(
  check: () => boolean | Promise<boolean>,
  ms = 3_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await settle(10);
  }
}

/** One tab as the hub lists it. */
const fact = (n: number, extra: Partial<TabFacts> = {}): TabFacts => ({
  id: id(n),
  url: "https://example.com/",
  title: "Example",
  favicon: null,
  openedAt: "2026-10-11T10:00:00.000Z",
  usedAt: "2026-10-11T10:01:00.000Z",
  opener: { kind: "unknown" },
  agents: [],
  holders: [],
  viewers: 0,
  closing: null,
  grace: null,
  ...extra,
});

type HubRequest = Readonly<{
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: string;
}>;

/** A hub on loopback that records each request and answers as told. */
function fakeHub(
  answer: (request: HubRequest) => Response | Promise<Response>,
) {
  const seen: HubRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const seenRequest = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        headers: request.headers,
        body: await request.text(),
      };
      seen.push(seenRequest);
      return answer(seenRequest);
    },
  });
  cleanups.push(() => server.stop(true));
  const port = server.port;
  if (port === undefined) throw new Error("The fake hub listens on a port");
  return {
    seen,
    entry: Object.freeze({ origin, listenPort: port }),
    stop: () => server.stop(true),
  };
}

/** A hub that keeps its tabs and answers the four requests as the view's
 * hub does (F47 point 6): `heap=1` adds a heap of 1000 of 2000 bytes. */
function standardHub(initial: readonly TabFacts[]) {
  const tabs = new Map(initial.map((tab) => [tab.id, tab]));
  const closing = new Set<string>();
  let next = 0x900;
  const hub = fakeHub(({ method, path, search, body }) => {
    if (path === "/.lazurio/tabs" && method === "GET")
      return Response.json({
        tabs: [...tabs.values()].map((tab) =>
          search === "?heap=1"
            ? { ...tab, heap: { used: 1_000, total: 2_000 } }
            : tab,
        ),
      });
    if (path === "/.lazurio/tabs" && method === "POST") {
      const { url, strip } = JSON.parse(body) as { url: string; strip: string };
      if (!url.startsWith("https://"))
        return Response.json({ error: "invalid-request" }, { status: 400 });
      const tab = fact(next++, { url, opener: { kind: "new-tab", strip } });
      tabs.set(tab.id, tab);
      return Response.json(
        { id: tab.id, view: `${origin}/t/${tab.id}` },
        { status: 201 },
      );
    }
    const action = /^\/\.lazurio\/tabs\/([0-9A-F]{32})\/(close|restore)$/.exec(
      path,
    );
    if (action !== null && method === "POST") {
      const target = action[1] as string;
      if (!tabs.has(target))
        return Response.json({ error: "not-found" }, { status: 404 });
      if (action[2] === "close") {
        closing.add(target);
        return Response.json(
          { closing: "2026-10-11T10:02:08.000Z" },
          { status: 202 },
        );
      }
      if (!closing.delete(target))
        return Response.json({ error: "nothing-to-restore" }, { status: 409 });
      return Response.json({ restored: true });
    }
    return Response.json({ error: "not-found" }, { status: 404 });
  });
  return { ...hub, tabs };
}

const meminfo = [
  "MemTotal:        8130000 kB",
  "MemFree:          500000 kB",
  "MemAvailable:    3130000 kB",
  "",
].join("\n");

/** The account's runtime directory, a service manager answering
 * `systemctl --user show` with `memory` (anything else `[not set]`),
 * `/proc/meminfo` and a boot clock. */
function fakeHost(
  runtimeDirectory: string,
  options: {
    meminfo?: string | null;
    memory?: Readonly<Record<string, string>>;
    clock?: () => BootTime | null;
  } = {},
): NewTabHost & { calls: string[][]; events: string[] } {
  const calls: string[][] = [];
  const events: string[] = [];
  const run: ServiceManagerProcess = async (program, args) => {
    calls.push([program, ...args]);
    if (program !== "systemctl" || args[1] !== "show")
      return { code: 1, stdout: "", stderr: "unsupported" };
    const units = args.slice(args.indexOf("--") + 1);
    return {
      code: 0,
      stdout: units
        .map(
          (unit) =>
            `MemoryCurrent=${options.memory?.[unit] ?? "[not set]"}\nId=${unit}\n`,
        )
        .join("\n"),
      stderr: "",
    };
  };
  return {
    runtimeDirectory,
    run,
    readFile: async (path) => {
      if (path !== "/proc/meminfo") return readFile(path, "utf8");
      const text = options.meminfo === undefined ? meminfo : options.meminfo;
      if (text === null) throw new Error("ENOENT");
      return text;
    },
    bootClock: async () => (options.clock ? options.clock() : at(1_000)),
    log: (event) => events.push(event),
    calls,
    events,
  };
}

// ---- The client of the view's hub (F47 point 6) -------------------------------

test("the hub client asks on loopback without Origin or Sec-Fetch-Site and names each outcome", async () => {
  const hub = standardHub([fact(1), fact(2)]);
  expect(await listTabs(hub.entry, { heap: true })).toEqual({
    kind: "tabs",
    tabs: [
      { ...fact(1), heap: { used: 1_000, total: 2_000 } },
      { ...fact(2), heap: { used: 1_000, total: 2_000 } },
    ],
  });
  // Without `heap` nothing is asked for and nothing is read.
  expect(await listTabs(hub.entry, { heap: false })).toEqual({
    kind: "tabs",
    tabs: [fact(1), fact(2)],
  });
  const opened = await openTab(hub.entry, "https://example.com/new", null);
  expect(opened).toEqual({ kind: "opened", tab: id(0x900) });
  expect(await openTab(hub.entry, "http://example.com", "t3-a")).toEqual({
    kind: "refused",
    reason: "invalid-request",
  });
  expect(await closeTab(hub.entry, id(1).toLowerCase())).toEqual({
    kind: "closing",
    closing: "2026-10-11T10:02:08.000Z",
  });
  expect(await restoreTab(hub.entry, id(1))).toEqual({ kind: "restored" });
  expect(await restoreTab(hub.entry, id(1))).toEqual({
    kind: "refused",
    reason: "nothing-to-restore",
  });
  expect(await closeTab(hub.entry, id(77))).toEqual({
    kind: "refused",
    reason: "not-found",
  });
  // An id that is none is not even asked about.
  const asked = hub.seen.length;
  expect(await closeTab(hub.entry, "../x")).toEqual({
    kind: "refused",
    reason: "invalid-request",
  });
  expect(hub.seen.length).toBe(asked);
  expect(
    hub.seen.map(
      (request) => `${request.method} ${request.path}${request.search}`,
    ),
  ).toEqual([
    "GET /.lazurio/tabs?heap=1",
    "GET /.lazurio/tabs",
    "POST /.lazurio/tabs",
    "POST /.lazurio/tabs",
    `POST /.lazurio/tabs/${id(1)}/close`,
    `POST /.lazurio/tabs/${id(1)}/restore`,
    `POST /.lazurio/tabs/${id(1)}/restore`,
    `POST /.lazurio/tabs/${id(77)}/close`,
  ]);
  expect(JSON.parse(hub.seen[2]?.body ?? "")).toEqual({
    url: "https://example.com/new",
    strip: null,
  });
  // The hub answers these only to a caller on loopback that no browser is.
  for (const request of hub.seen) {
    expect(request.headers.get("host")).toBe(
      `127.0.0.1:${hub.entry.listenPort}`,
    );
    expect(request.headers.get("origin")).toBeNull();
    expect(request.headers.get("sec-fetch-site")).toBeNull();
  }
});

test("the hub client passes on only the hub's own shapes, bounded, and anything else is unreachable", async () => {
  let answer: () => Response = () => Response.json({ tabs: [] });
  const hub = fakeHub(() => answer());
  answer = () =>
    Response.json({
      tabs: [
        // Kept, with what is not of the hub's shape replaced or cut.
        {
          ...fact(1),
          url: `https://example.com/${"a".repeat(5_000)}`,
          title: "t".repeat(1_000),
          favicon: "http://example.com/favicon.ico",
          opener: { kind: "robot" },
          agents: ["codex-1", "../x", 7],
          holders: [
            { strip: "launchpad", label: "L".repeat(300) },
            { strip: "../x", label: "x" },
            "t3-a",
          ],
          grace: { kind: "forever", endsAt: "2026-10-11T10:00:30.000Z" },
          heap: { used: -1, total: 2 },
          extra: "dropped",
        },
        { ...fact(2), opener: { kind: "page", openerId: id(1).toLowerCase() } },
        // Left out: no id, an id that is none, no times, no viewers.
        { ...fact(3), id: undefined },
        { ...fact(4), id: "nope" },
        { ...fact(5), openedAt: "yesterday" },
        { ...fact(6), viewers: -1 },
        null,
      ],
    });
  const listed = await listTabs(hub.entry, { heap: true });
  if (listed.kind !== "tabs") throw new Error("The list was refused");
  expect(listed.tabs.map((tab) => tab.id)).toEqual([id(1), id(2)]);
  const first = listed.tabs[0];
  expect(first?.url.length).toBe(2_048);
  expect(first?.title.length).toBe(500);
  expect(first).toMatchObject({
    favicon: null,
    opener: { kind: "unknown" },
    agents: ["codex-1"],
    holders: [{ strip: "launchpad", label: "L".repeat(200) }],
    grace: null,
    heap: null,
  });
  expect(Object.hasOwn(first ?? {}, "extra")).toBe(false);
  expect(listed.tabs[1]?.opener).toEqual({ kind: "page", openerId: id(1) });
  // At most `maxTabs` tabs.
  answer = () =>
    Response.json({ tabs: Array.from({ length: 600 }, (_, n) => fact(n + 1)) });
  const many = await listTabs(hub.entry, { heap: false });
  expect(many.kind === "tabs" ? many.tabs.length : 0).toBe(hubCalls.maxTabs);
  // Anything that is not one of the hub's answers is unreachable: a 503 (no
  // browser), a 500, a redirect, no JSON, no list, an answer too large.
  const unreachable = {
    kind: "refused",
    reason: "hub-unreachable",
  } as const;
  for (const next of [
    () => Response.json({ error: "browser-unreachable" }, { status: 503 }),
    () => Response.json({ tabs: [fact(1)] }, { status: 503 }),
    () => new Response("broken", { status: 500 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/" },
      }),
    () => new Response("{"),
    () => Response.json({ tabs: "x" }),
    () => Response.json([fact(1)]),
  ]) {
    answer = next;
    expect(await listTabs(hub.entry, { heap: false })).toEqual(unreachable);
  }
  for (const next of [
    () => Response.json({ id: "nope" }, { status: 201 }),
    () =>
      Response.json({ id: id(1), pad: "x".repeat(20_000) }, { status: 201 }),
    () => Response.json({ id: id(1) }, { status: 200 }),
  ]) {
    answer = next;
    expect(await openTab(hub.entry, "https://example.com", null)).toEqual(
      unreachable,
    );
  }
  answer = () => Response.json({ closing: "soon" }, { status: 202 });
  expect(await closeTab(hub.entry, id(1))).toEqual(unreachable);
  answer = () => Response.json({ restored: "yes" });
  expect(await restoreTab(hub.entry, id(1))).toEqual(unreachable);
});

test("the hub client gives up after its timeout, and a hub that is gone is unreachable", async () => {
  const slow = fakeHub(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(Response.json({ tabs: [] })), 2_000),
      ),
  );
  const started = Date.now();
  expect(await listTabs(slow.entry, { heap: false }, 100)).toEqual({
    kind: "refused",
    reason: "hub-unreachable",
  });
  expect(Date.now() - started).toBeLessThan(1_500);
  const gone = fakeHub(() => Response.json({ tabs: [] }));
  gone.stop();
  expect(await openTab(gone.entry, "https://example.com", null)).toEqual({
    kind: "refused",
    reason: "hub-unreachable",
  });
  expect(hubCalls.listTimeoutMs).toBe(3_000);
  expect(hubCalls.openTimeoutMs).toBe(5_000);
});

// ---- The Environment's memory (F47 point 7) -----------------------------------

test("memory: /proc/meminfo and each unit's memory.current, unknown as null", async () => {
  expect(parseMeminfo(meminfo)).toEqual({
    total: 8_130_000 * 1024,
    used: 5_000_000 * 1024,
  });
  expect(parseMeminfo("MemTotal:  8130000 kB\n")).toBeNull();
  expect(parseMeminfo("")).toBeNull();
  // One block per unit, its properties in either order.
  expect(
    Object.fromEntries(
      parseUnitsMemory(
        [
          "Id=a.service\nMemoryCurrent=1024",
          "MemoryCurrent=[not set]\nId=b.service",
          "Id=c.service\nMemoryCurrent=18446744073709551615",
          "Id=d.service\nMemoryCurrent=12x",
          "Id=e.service",
        ].join("\n\n"),
      ),
    ),
  ).toEqual({
    "a.service": 1024,
    "b.service": null,
    "c.service": null,
    "d.service": null,
    "e.service": null,
  });
  const runtime = await temporary("new-tab-memory-");
  const modules = ["lazurio-app-aaa.service", "lazurio-app-bbb.service"];
  const host = fakeHost(runtime, {
    memory: {
      "lazurio-browser.service": "2000000000",
      "lazurio-launchpad.service": "100000000",
      [t3codeUnit]: "300000000",
      "lazurio-app-aaa.service": "400000000",
      "lazurio-app-bbb.service": "200000000",
    },
  });
  const read = await readEnvironmentMemory(host, modules);
  expect(read.memory).toEqual({
    total: 8_130_000 * 1024,
    used: 5_120_000_000,
    browser: 2_000_000_000,
    core: { launchpad: 100_000_000, t3code: 300_000_000 },
    modules: 600_000_000,
    rest: 2_120_000_000,
  });
  expect(read.units.get("lazurio-app-bbb.service")).toBe(200_000_000);
  // One call of the service manager, read only.
  expect(host.calls).toEqual([
    [
      "systemctl",
      "--user",
      "show",
      "--no-pager",
      "--property=Id,MemoryCurrent",
      "--",
      "lazurio-browser.service",
      "lazurio-launchpad.service",
      "t3code.service",
      ...modules,
    ],
  ]);
  // A unit that does not run is unknown, and so is the rest then; no
  // running Module is 0; which run unknown is null.
  const partial = await readEnvironmentMemory(
    fakeHost(runtime, { memory: { "lazurio-browser.service": "5" } }),
    [],
  );
  expect(partial.memory).toMatchObject({
    browser: 5,
    core: { launchpad: null, t3code: null },
    modules: 0,
    rest: null,
  });
  expect((await readEnvironmentMemory(host, null)).memory).toMatchObject({
    modules: null,
    rest: null,
  });
  // The parts may hold more than "used" counts (page cache): never negative.
  const full = await readEnvironmentMemory(
    fakeHost(runtime, {
      memory: {
        "lazurio-browser.service": String(8_000_000_000),
        "lazurio-launchpad.service": "1",
        [t3codeUnit]: "1",
      },
    }),
    [],
  );
  expect(full.memory.rest).toBe(0);
  // Off Linux: no service manager and no /proc. The Launchpad's own host
  // runs the manager's tools only on Linux, with an absolute runtime
  // directory.
  for (const [env, platform] of [
    [{}, "linux"],
    [{ XDG_RUNTIME_DIR: "run/user/1000" }, "linux"],
    [{ XDG_RUNTIME_DIR: "/run/user/1000" }, "darwin"],
  ] as const)
    expect(processNewTabHost(env, platform).run).toBeNull();
  expect(
    processNewTabHost({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux").run,
  ).not.toBeNull();
  const elsewhere = await readEnvironmentMemory(
    { run: null, readFile: fakeHost(runtime, { meminfo: null }).readFile },
    [],
  );
  expect(elsewhere.memory).toEqual({
    total: null,
    used: null,
    browser: null,
    core: { launchpad: null, t3code: null },
    modules: 0,
    rest: null,
  });
  // A manager that fails answers nothing.
  const failing: ServiceManagerProcess = async () => ({
    code: null,
    stdout: "",
    stderr: "",
  });
  expect(
    (await readEnvironmentMemory({ run: failing, readFile: host.readFile }, []))
      .memory.browser,
  ).toBeNull();
});

// ---- The running Modules (F47 point 7) --------------------------------------

/** A user manager that lists `units` (`{unit, active}`) by their prefix. */
function listingManager(
  units: readonly Readonly<{ unit: string; active: string }>[],
  failing = false,
): ServiceManagerProcess {
  return async (_program, args) => {
    if (failing || args[1] !== "list-units")
      return { code: 1, stdout: "", stderr: "unsupported" };
    const prefix = (args.at(-1) ?? "").replace(/\*\.service$/, "");
    return {
      code: 0,
      stdout: JSON.stringify(
        units
          .filter((entry) => entry.unit.startsWith(prefix))
          .map((entry) => ({
            unit: entry.unit,
            load: "loaded",
            active: entry.active,
            sub: entry.active === "failed" ? "failed" : "running",
            description: "Lazurio application",
          })),
      ),
      stderr: "",
    };
  };
}

const runnerHost = (
  run: ServiceManagerProcess,
  kind: "systemd-user" | "session" = "systemd-user",
): Pick<ModuleHost, "runnerKind" | "createRunner"> => ({
  runnerKind: async () => kind,
  createRunner: (_kind, organizationDirectory) =>
    createSystemdUserRunner({
      organizationDirectory,
      runtimeDirectory: "/run/user/1000",
      run,
    }),
});

test("running Modules: each running unit of the catalog named by its Organization, module and app; failed and unknown units are not", async () => {
  await folderFixture(async (folder) => {
    const owner = "someone_GEN3";
    await writePersonalspaceModule(folder, owner, "someone", { id: "notes" });
    const alpha = join(folder, "organizations", "alpha_GEN3");
    const beta = join(folder, "organizations", "beta");
    const app = "app/package.json";
    const unit = (directory: string, company: string, module: string) =>
      applicationUnitName(directory, { company, module, package: app });
    const units = [
      { unit: unit(alpha, "alpha", "web"), active: "active" },
      // Failed: it does not run.
      { unit: unit(alpha, "alpha", "mission-control"), active: "failed" },
      // Under alpha's prefix, but no app of the catalog is named so.
      {
        unit: `${organizationUnitPrefix(alpha)}gone.app-0000000000000000.service`,
        active: "active",
      },
      { unit: unit(beta, "beta", "api"), active: "activating" },
      {
        unit: unit(join(folder, "personalspace", owner), "someone", "notes"),
        active: "active",
      },
    ];
    const modules = await runningModules({
      folder,
      host: runnerHost(listingManager(units)),
      personalspace: heldBy("someone"),
    });
    expect(modules).toEqual([
      { org: "alpha", module: "web", app, unit: units[0]?.unit as string },
      { org: "beta", module: "api", app, unit: units[3]?.unit as string },
      {
        org: "personalspace",
        module: "notes",
        app,
        unit: units[4]?.unit as string,
      },
    ]);
    // Which run is unknown: the manager does not list, apps are a
    // session's, or the catalog cannot be read.
    expect(
      await runningModules({
        folder,
        host: runnerHost(listingManager(units, true)),
      }),
    ).toBeNull();
    expect(
      await runningModules({
        folder,
        host: runnerHost(listingManager(units), "session"),
      }),
    ).toBeNull();
    expect(
      await runningModules({
        folder,
        host: runnerHost(listingManager(units)),
        readCatalog: async () => {
          throw new Error("unreadable");
        },
      }),
    ).toBeNull();
  });
});

// ---- The Launchpad's holder file (F47 point 4) ------------------------------

async function holderWorld(
  options: {
    everyMs?: number;
    debounceMs?: number;
    watch?: Parameters<typeof createLaunchpadHolder>[0]["watch"];
  } = {},
) {
  const runtime = await temporary("launchpad-holder-");
  const env = { XDG_RUNTIME_DIR: runtime };
  const directory = holderDirectory(env) as string;
  const listPath = liveTabsPath(env) as string;
  let clock: BootTime | null = at(100);
  const listReads: number[] = [];
  const make = () =>
    createLaunchpadHolder({
      directory,
      listPath,
      bootClock: async () => clock,
      readFile: async (path) => {
        if (path === listPath) listReads.push(listReads.length);
        return readFile(path, "utf8");
      },
      everyMs: options.everyMs ?? 60_000,
      debounceMs: options.debounceMs ?? 10,
      ...(options.watch === undefined ? {} : { watch: options.watch }),
    });
  const holder = make();
  cleanups.push(() => holder.stop());
  const file = join(directory, "launchpad.json");
  return {
    runtime,
    directory,
    listPath,
    file,
    holder,
    /** Another Launchpad on the same files, as after a restart. */
    restarted: () => {
      const again = make();
      cleanups.push(() => again.stop());
      return again;
    },
    setClock: (next: BootTime | null) => {
      clock = next;
    },
    /** The hub's snapshot of the browser's live tabs. */
    list: (tabs: readonly string[], takenAt: BootTime) =>
      writeLiveTabs(listPath, tabs, takenAt),
    // A file that holds nothing is removed (the contract's holder-file
    // write, F50 point 1): no file holds nothing.
    stored: async () => {
      const text = await readFile(file, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      return text === null
        ? []
        : (parseHolderRecords("launchpad.json", text)?.tabs ?? null);
    },
    listReads,
  };
}

test("a holder file that breaks after a good read is never written over: neither a hold nor a reconciliation writes until a read succeeds", async () => {
  const world = await holderWorld();
  world.setClock(at(10));
  await world.holder.hold(id(1));
  // A list taken after the record that lacks id(1): a reconciliation would
  // drop it and write the file.
  await world.list([], at(20));
  // The file breaks after the good read.
  await writeFile(world.file, "{");
  await world.holder.reconcile();
  expect(await readFile(world.file, "utf8")).toBe("{");
  world.setClock(at(30));
  await expect(world.holder.hold(id(2))).rejects.toThrow("cannot be read");
  expect(await readFile(world.file, "utf8")).toBe("{");
  // Unreadable instead of broken: the same.
  await writeFile(
    world.file,
    holderFileText(
      "launchpad",
      "Launchpad",
      [{ id: id(1), recordedAt: at(10) }],
      embeddedIdentity().version,
    ),
  );
  await chmod(world.file, 0o000);
  try {
    await world.holder.reconcile();
    await expect(world.holder.hold(id(2))).rejects.toThrow("cannot be read");
  } finally {
    await chmod(world.file, 0o600);
  }
  expect((await world.stored())?.map((tab) => tab.id)).toEqual([id(1)]);
  // Readable again: the next operation reads it, drops id(1) by the list and
  // takes the new hold.
  await world.holder.hold(id(2));
  expect((await world.stored())?.map((tab) => tab.id)).toEqual([id(2)]);
});

test("a holder file the Launchpad cannot read takes no hold and is never written over, until a read succeeds", async () => {
  const world = await holderWorld();
  world.setClock(at(50));
  await world.holder.hold(id(1));
  // Another Launchpad on the same file, as after a restart, finds it
  // unreadable: it neither holds nor writes, so id(1) keeps its hold.
  await chmod(world.file, 0o000);
  const again = world.restarted();
  try {
    await again.start();
    await expect(again.hold(id(2))).rejects.toThrow("cannot be read");
    await again.reconcile();
  } finally {
    await chmod(world.file, 0o600);
  }
  expect((await world.stored())?.map((tab) => tab.id)).toEqual([id(1)]);
  // A file that is not a holder file fails the same way.
  const broken = world.restarted();
  const kept = await readFile(world.file, "utf8");
  await writeFile(world.file, "{");
  await expect(broken.hold(id(3))).rejects.toThrow("cannot be read");
  expect(await readFile(world.file, "utf8")).toBe("{");
  await writeFile(world.file, kept);
  // Readable again: the holds it kept are read back, and a new one joins.
  await broken.hold(id(3));
  expect((await world.stored())?.map((tab) => tab.id)).toEqual([id(1), id(3)]);
});

test("release takes hold's path: one operation at a time, the file read again first, a file it cannot read never written over, and a tab not held released already", async () => {
  const runtime = await temporary("launchpad-release-");
  const env = { XDG_RUNTIME_DIR: runtime };
  const directory = holderDirectory(env) as string;
  const file = join(directory, "launchpad.json");
  // Every read of the file is slow and counted: two operations side by
  // side would read it at once.
  let reading = 0;
  let most = 0;
  const holder = createLaunchpadHolder({
    directory,
    listPath: liveTabsPath(env) as string,
    bootClock: async () => at(100),
    readFile: async (path) => {
      if (path !== file) return readFile(path, "utf8");
      reading += 1;
      most = Math.max(most, reading);
      await settle(15);
      try {
        return await readFile(path, "utf8");
      } finally {
        reading -= 1;
      }
    },
  });
  cleanups.push(() => holder.stop());
  const stored = async () =>
    parseHolderRecords(
      "launchpad.json",
      await readFile(file, "utf8"),
    )?.tabs.map((tab) => tab.id) ?? null;
  // Asked together, they run one after another, in the order asked.
  await Promise.all([
    holder.hold(id(1)),
    holder.release(id(1).toLowerCase()),
    holder.hold(id(2)),
  ]);
  expect(most).toBe(1);
  expect(holder.tabs()).toEqual([id(2)]);
  expect(await stored()).toEqual([id(2)]);
  // A tab the file does not hold is released already: nothing is written.
  const written = (await stat(file)).mtimeMs;
  await settle(20);
  await holder.release(id(7));
  expect((await stat(file)).mtimeMs).toBe(written);
  await expect(holder.release("not-a-tab")).rejects.toThrow("Invalid");
  // A file that is not a holder file, or cannot be read, is never written
  // over, and the release fails.
  await writeFile(file, "{");
  await expect(holder.release(id(2))).rejects.toThrow("cannot be read");
  expect(await readFile(file, "utf8")).toBe("{");
  await writeFile(
    file,
    holderFileText(
      "launchpad",
      "Launchpad",
      [{ id: id(2), recordedAt: at(100) }],
      embeddedIdentity().version,
    ),
  );
  await chmod(file, 0o000);
  try {
    await expect(holder.release(id(2))).rejects.toThrow("cannot be read");
  } finally {
    await chmod(file, 0o600);
  }
  expect(await stored()).toEqual([id(2)]);
  // Readable again: the release goes through, and the file that holds
  // nothing any more is removed (the contract's holder-file write, F50
  // point 1).
  await holder.release(id(2));
  expect(holder.tabs()).toEqual([]);
  await expect(readFile(file, "utf8")).rejects.toThrow("ENOENT");
});

test("the Launchpad's holder file is owner-only, replaced atomically, and read back with its record times by the Launchpad alone", async () => {
  const world = await holderWorld();
  world.setClock(at(100.25));
  await world.holder.hold(id(1).toLowerCase());
  world.setClock(at(101));
  await world.holder.hold(id(2));
  expect((await stat(world.file)).mode & 0o777).toBe(0o600);
  expect((await stat(world.directory)).mode & 0o777).toBe(0o700);
  const text = await readFile(world.file, "utf8");
  // Decision F50 point 3: the file names its schema and the Platform release
  // that wrote it, which this source run reports as its development version.
  expect(JSON.parse(text)).toEqual({
    schema: "lazurio.browser-holder.v1",
    contract: embeddedIdentity().version,
    strip: "launchpad",
    label: "Launchpad",
    tabs: [id(1), id(2)],
    recordedAt: { [id(1)]: at(100.25), [id(2)]: at(101) },
  });
  // The hub reads it as any holder file and ignores the times.
  expect(parseHolder("launchpad.json", text)).toEqual({
    strip: "launchpad",
    label: "Launchpad",
    tabs: [id(1), id(2)],
  });
  // A reader never meets half a file, and no temporary file stays.
  let writing = true;
  let reads = 0;
  let torn = 0;
  const reader = (async () => {
    while (writing) {
      const seen = await readFile(world.file, "utf8").catch(() => null);
      if (seen !== null) {
        reads += 1;
        if (parseHolder("launchpad.json", seen) === null) torn += 1;
      }
      await settle(0);
    }
  })();
  for (let n = 3; n < 40; n++) await world.holder.hold(id(n));
  writing = false;
  await reader;
  expect([reads > 0, torn]).toEqual([true, 0]);
  expect(await readdir(world.directory)).toEqual(["launchpad.json"]);
  // A restarted Launchpad has its holds and their times.
  const again = world.restarted();
  await again.start();
  expect(again.tabs()).toEqual(Array.from({ length: 39 }, (_, n) => id(n + 1)));
  expect((await world.stored())?.slice(0, 2)).toEqual([
    { id: id(1), recordedAt: at(100.25) },
    { id: id(2), recordedAt: at(101) },
  ]);
  // A time that is none is null; an id that is none is not a tab.
  expect(
    parseHolderRecords(
      "launchpad.json",
      JSON.stringify({
        strip: "launchpad",
        label: "Launchpad",
        tabs: [id(1), id(2), id(3)],
        recordedAt: {
          [id(1).toLowerCase()]: at(5),
          [id(2)]: { boot: "x", at: 1 },
          nope: at(1),
        },
      }),
    )?.tabs,
  ).toEqual([
    { id: id(1), recordedAt: at(5) },
    { id: id(2), recordedAt: null },
    { id: id(3), recordedAt: null },
  ]);
  await expect(world.holder.hold("../x")).rejects.toThrow();
});

test("reconciliation: a tab closed for everyone, or ended, while no app shows it goes with the hub's next list", async () => {
  const world = await holderWorld();
  await world.list([], at(90));
  await world.holder.start();
  await world.holder.hold(id(1));
  await world.holder.hold(id(2));
  // The hub's snapshot after the tab ended; no view and no strip shows it.
  await world.list([id(2)], at(110));
  // The holder remembers a file after writing it: once its memory has one
  // tab, the file has too (#384).
  await until(() => world.holder.tabs().length === 1);
  expect(await world.stored()).toEqual([{ id: id(2), recordedAt: at(100) }]);
  expect(world.holder.tabs()).toEqual([id(2)]);
});

test("reconciliation: after a browser restart the list of new ids drops every old one", async () => {
  const world = await holderWorld();
  world.setClock(at(100));
  await world.holder.hold(id(1));
  world.setClock(at(101));
  await world.holder.hold(id(2));
  await world.list([id(9)], at(120));
  // A hold reconciles before it writes: the new tab is the only one left.
  world.setClock(at(121));
  await world.holder.hold(id(9));
  expect(world.holder.tabs()).toEqual([id(9)]);
  expect(await world.stored()).toEqual([{ id: id(9), recordedAt: at(121) }]);
});

test("reconciliation: a Launchpad that starts with stored ids that ended meanwhile drops them; one without a time counts as old", async () => {
  const world = await holderWorld();
  await mkdir(world.directory, { recursive: true, mode: 0o700 });
  await writeFile(
    world.file,
    holderFileText(
      "launchpad",
      "Launchpad",
      [
        { id: id(1), recordedAt: at(50) },
        { id: id(2), recordedAt: at(50) },
        { id: id(3), recordedAt: null },
      ],
      embeddedIdentity().version,
    ),
    { mode: 0o600 },
  );
  await world.list([id(2)], at(100));
  await world.holder.start();
  expect(world.holder.tabs()).toEqual([id(2)]);
  expect(await world.stored()).toEqual([{ id: id(2), recordedAt: at(50) }]);
});

test("reconciliation: a tab recorded before the list has it stays", async () => {
  const world = await holderWorld();
  // The snapshot began at 100, before the tab existed.
  await world.list([], at(100));
  world.setClock(at(101));
  await world.holder.hold(id(1));
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([id(1)]);
  // The hub's next snapshot has it.
  await world.list([id(1)], at(130));
  await world.holder.reconcile();
  expect(await world.stored()).toEqual([{ id: id(1), recordedAt: at(101) }]);
});

test("reconciliation: a live tab whose event reaches the hub late is in the snapshot, so it stays", async () => {
  const world = await holderWorld();
  world.setClock(at(100));
  await world.holder.hold(id(7));
  // The hub never heard of the tab; its snapshot asked the browser itself.
  await world.list([id(7)], at(110));
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([id(7)]);
});

test("reconciliation: a tab that ended before the Launchpad recorded it goes only with a list of the same boot taken after the record", async () => {
  const world = await holderWorld();
  // It ended at 99; the hub's snapshot at 99.5 lacks it.
  await world.list([], at(99.5));
  world.setClock(at(100));
  await world.holder.hold(id(6));
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([id(6)]);
  // A list of another boot says nothing about this one.
  await world.list([], at(500, earlierBoot));
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([id(6)]);
  // The periodic snapshot 30 s later began after the record.
  await world.list([], at(130));
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([]);
  expect(await world.stored()).toEqual([]);
});

test("reconciliation: a record from an earlier boot goes when this boot's list lacks it", async () => {
  const world = await holderWorld();
  await mkdir(world.directory, { recursive: true, mode: 0o700 });
  await writeFile(
    world.file,
    holderFileText(
      "launchpad",
      "Launchpad",
      [
        { id: id(1), recordedAt: at(5_000, earlierBoot) },
        { id: id(2), recordedAt: at(5_000, earlierBoot) },
      ],
      embeddedIdentity().version,
    ),
    { mode: 0o600 },
  );
  // Seconds since this boot are fewer than the earlier record's.
  await world.list([id(2)], at(10));
  await world.holder.start();
  expect(world.holder.tabs()).toEqual([id(2)]);
});

test("reconciliation: a list of another boot is ignored, and so is a missing or unreadable list", async () => {
  const world = await holderWorld();
  world.setClock(at(100));
  await world.holder.hold(id(1));
  await world.list([], at(5_000, earlierBoot));
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([id(1)]);
  await rm(world.listPath);
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([id(1)]);
  await writeFile(world.listPath, "{", { mode: 0o600 });
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([id(1)]);
  // Without the boot clock (not Linux) nothing is dropped either.
  await world.list([], at(500));
  world.setClock(null);
  await world.holder.reconcile();
  expect(world.holder.tabs()).toEqual([id(1)]);
});

test("reconciliation: a step of the wall clock changes nothing, since no time here is the wall clock's", async () => {
  const world = await holderWorld();
  await world.list([], at(100));
  const realNow = Date.now;
  try {
    // The wall clock steps back an hour after the snapshot began; the boot
    // clock reads the record as later than it all the same.
    Date.now = () => realNow() - 3_600_000;
    world.setClock(at(100.4));
    await world.holder.hold(id(7));
    await world.holder.reconcile();
    expect(world.holder.tabs()).toEqual([id(7)]);
    // And forward a day: a snapshot begun before the record still drops
    // nothing.
    Date.now = () => realNow() + 86_400_000;
    await world.list([], at(100.2));
    await world.holder.reconcile();
    expect(world.holder.tabs()).toEqual([id(7)]);
  } finally {
    Date.now = realNow;
  }
  expect(await world.stored()).toEqual([{ id: id(7), recordedAt: at(100.4) }]);
});

test("the holder reads the list again on its beat, retries the watch there, and rewrites its file only when a hold went", async () => {
  const watched: string[][] = [];
  let retries = 0;
  const world = await holderWorld({
    everyMs: 40,
    watch: (directories) => {
      watched.push(directories.filter((d): d is string => d !== undefined));
      return {
        retry: () => {
          retries += 1;
        },
        stop: () => undefined,
      };
    },
  });
  await world.list([id(1)], at(90));
  world.setClock(at(100));
  await world.holder.hold(id(1));
  await world.holder.hold(id(2));
  await world.holder.start();
  // The directory the hub replaces its list in.
  expect(watched).toEqual([[join(world.runtime, "lazurio-browser")]]);
  const written = (await stat(world.file)).ino;
  const reads = world.listReads.length;
  await until(() => retries >= 2 && world.listReads.length >= reads + 2);
  // Nothing went: the file is the same one.
  expect((await stat(world.file)).ino).toBe(written);
  await world.list([id(2)], at(110));
  await until(() => world.holder.tabs().length === 1);
  expect(world.holder.tabs()).toEqual([id(2)]);
  expect((await world.stored())?.map((tab) => tab.id)).toEqual([id(2)]);
});

test("a burst of changes to the hub's list is one reconciliation", async () => {
  let changed: () => void = () => undefined;
  const world = await holderWorld({
    debounceMs: 30,
    watch: (_directories, onChange) => {
      changed = onChange;
      return { retry: () => undefined, stop: () => undefined };
    },
  });
  await world.list([id(1)], at(90));
  await world.holder.hold(id(1));
  await world.holder.start();
  const before = world.listReads.length;
  for (let n = 0; n < 5; n++) changed();
  await until(() => world.listReads.length > before);
  await settle(100);
  expect(world.listReads.length - before).toBe(1);
});

test("a hold past the bound is refused and none is dropped for it; the file stays within what the hub reads", async () => {
  const world = await holderWorld();
  for (let n = 1; n <= maxLaunchpadHolds; n++) await world.holder.hold(id(n));
  await expect(world.holder.hold(id(maxLaunchpadHolds + 1))).rejects.toThrow(
    HolderFull,
  );
  // Holding one it has again is no new hold.
  world.setClock(at(200));
  await world.holder.hold(id(1));
  const text = await readFile(world.file, "utf8");
  expect(text.length).toBeLessThan(64 * 1024);
  expect(parseHolder("launchpad.json", text)?.tabs.length).toBe(
    maxLaunchpadHolds,
  );
  expect((await world.stored())?.[0]).toEqual({
    id: id(1),
    recordedAt: at(200),
  });
});

test("a T3 Code thread is named by its holder file's label; another file or none names nothing", async () => {
  const runtime = await temporary("holder-label-");
  const directory = holderDirectory({ XDG_RUNTIME_DIR: runtime }) as string;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "t3-abc.json"),
    JSON.stringify({ strip: "t3-abc", label: " Vlákno o webu ", tabs: [] }),
  );
  await writeFile(
    join(directory, "t3-other.json"),
    JSON.stringify({ strip: "t3-else", label: "Cizí", tabs: [] }),
  );
  expect(await readHolderLabel(runtime, "t3-abc")).toBe("Vlákno o webu");
  expect(await readHolderLabel(runtime, "t3-other")).toBeNull();
  expect(await readHolderLabel(runtime, "t3-none")).toBeNull();
  expect(await readHolderLabel(runtime, "../holders/t3-abc")).toBeNull();
  expect(await readHolderLabel(undefined, "t3-abc")).toBeNull();
  expect(launchpadHolderOf(undefined, { bootClock: async () => null })).toBe(
    null,
  );
  expect(launchpadHolderOf("run/user", { bootClock: async () => null })).toBe(
    null,
  );
});

// ---- The routes (F47 points 4 and 6-8) ---------------------------------------

async function routesWorld(
  options: {
    hub?: ReturnType<typeof fakeHub> | null;
    holder?: boolean;
    modules?: readonly ModuleUnit[] | null;
    memory?: Readonly<Record<string, string>>;
    runtime?: string;
    now?: () => number;
  } = {},
) {
  const runtime = options.runtime ?? (await temporary("new-tab-routes-"));
  const host = fakeHost(runtime, {
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    clock: () => at(100),
  });
  const holder =
    options.holder === false
      ? null
      : launchpadHolderOf(runtime, {
          bootClock: host.bootClock,
          readFile: host.readFile,
        });
  const routes = createNewTabRoutes({
    browser:
      options.hub === null || options.hub === undefined
        ? undefined
        : options.hub.entry,
    holder,
    host,
    modules: async () => (options.modules === undefined ? [] : options.modules),
    headers: { "Cache-Control": "no-store" },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const request = new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const response = await routes.handle(
      request,
      new URL(request.url),
      () => undefined,
    );
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const held = async () => {
    const directory = holderDirectory({ XDG_RUNTIME_DIR: runtime }) as string;
    const text = await readFile(
      join(directory, "launchpad.json"),
      "utf8",
    ).catch(() => null);
    return text === null
      ? []
      : (parseHolderRecords("launchpad.json", text)?.tabs ?? []);
  };
  return { routes, call, host, held, runtime, holder };
}

test("every path answers 404 no-browser where the Environment has no browser", async () => {
  const { routes, call } = await routesWorld({ hub: null });
  expect(routes.handles("/api/new-tab/overview")).toBe(true);
  expect(routes.handles("/api/new-tabs")).toBe(false);
  for (const [method, path, body] of [
    ["GET", "/api/new-tab/overview", undefined],
    ["POST", "/api/new-tab/open", { url: "https://example.com" }],
    ["POST", "/api/new-tab/hold", { tab: id(1) }],
    ["POST", "/api/new-tab/release", { tab: id(1) }],
    ["POST", "/api/new-tab/close", { tab: id(1) }],
    ["POST", "/api/new-tab/restore", { tab: id(1) }],
    ["GET", "/api/new-tab/other", undefined],
  ] as const)
    expect(await call(method, path, body)).toMatchObject({
      status: 404,
      body: { error: "no-browser" },
    });
});

test("the overview joins the hub's tabs, named by who opened them, with the memory and the running Modules", async () => {
  const runtime = await temporary("new-tab-overview-");
  const directory = holderDirectory({ XDG_RUNTIME_DIR: runtime }) as string;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "t3-abc.json"),
    JSON.stringify({ strip: "t3-abc", label: "Vlákno o webu", tabs: [] }),
  );
  const agent = (session: string) =>
    ({ kind: "agent", session }) as const satisfies TabFacts["opener"];
  const hub = standardHub([
    fact(1, { opener: agent("t3-abc"), agents: ["t3-abc"] }),
    fact(2, { opener: agent("t3-nofile") }),
    fact(3, { opener: agent("codex-1a2b") }),
    fact(4, { opener: agent("claude-9") }),
    fact(5, { opener: { kind: "view" }, viewers: 2 }),
    fact(6, {
      opener: { kind: "new-tab", strip: "launchpad" },
      holders: [{ strip: "launchpad", label: "Launchpad" }],
    }),
    fact(7, { opener: { kind: "page", openerId: id(5) } }),
    fact(8),
    fact(9, { opener: agent("bot-x") }),
  ]);
  const modules: ModuleUnit[] = [
    {
      org: "alpha",
      module: "web",
      app: "app/package.json",
      unit: "lazurio-app-aaa.service",
    },
    {
      org: "personalspace",
      module: "notes",
      app: "app/package.json",
      unit: "lazurio-app-bbb.service",
    },
  ];
  const { call } = await routesWorld({
    hub,
    runtime,
    modules,
    memory: {
      "lazurio-browser.service": "2000000000",
      "lazurio-launchpad.service": "100000000",
      [t3codeUnit]: "300000000",
      "lazurio-app-aaa.service": "400000000",
    },
  });
  const answer = await call("GET", "/api/new-tab/overview");
  expect(answer.status).toBe(200);
  expect(answer.cache).toBe("no-store");
  expect(hub.seen.map((request) => request.search)).toEqual(["?heap=1"]);
  const tabs = answer.body.tabs as (TabFacts & { who: unknown })[];
  expect(tabs.map((tab) => [tab.id, tab.who])).toEqual([
    [id(1), { app: "t3code", thread: "Vlákno o webu" }],
    [id(2), { app: "t3code", thread: null }],
    [id(3), { app: "codex" }],
    [id(4), { app: "claude" }],
    [id(5), { person: true }],
    [id(6), { person: true }],
    [id(7), { page: id(5) }],
    [id(8), {}],
    [id(9), {}],
  ]);
  // The hub's facts stay as they were, with each tab's heap.
  expect(tabs[0]).toEqual({
    ...fact(1, { opener: agent("t3-abc"), agents: ["t3-abc"] }),
    heap: { used: 1_000, total: 2_000 },
    who: { app: "t3code", thread: "Vlákno o webu" },
  });
  expect(answer.body.hub).toBe("connected");
  expect(answer.body.memory).toEqual({
    total: 8_130_000 * 1024,
    used: 5_120_000_000,
    browser: 2_000_000_000,
    core: { launchpad: 100_000_000, t3code: 300_000_000 },
    // One Module's memory is unknown, so the sum and the rest are too.
    modules: null,
    rest: null,
  });
  expect(answer.body.modules).toEqual([
    { ...modules[0], memory: 400_000_000, mode: "dev", source: "main" },
    { ...modules[1], memory: null, mode: "dev", source: "main" },
  ]);
  expect(await call("GET", "/api/new-tab/overview?x=1")).toMatchObject({
    status: 400,
    body: { error: "invalid-query" },
  });
});

test("while the hub is unreachable the overview answers 200 with tabs null, and the actions 503", async () => {
  const hub = standardHub([fact(1)]);
  hub.stop();
  const { call } = await routesWorld({ hub, modules: null });
  const answer = await call("GET", "/api/new-tab/overview");
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({
    hub: "unreachable",
    tabs: null,
    modules: null,
    memory: { total: 8_130_000 * 1024, browser: null, rest: null },
  });
  for (const [path, body] of [
    ["/api/new-tab/open", { url: "https://example.com", strip: "launchpad" }],
    ["/api/new-tab/hold", { tab: id(1) }],
    ["/api/new-tab/close", { tab: id(1) }],
    ["/api/new-tab/restore", { tab: id(1) }],
  ] as const)
    expect(await call("POST", path, body)).toMatchObject({
      status: 503,
      body: { error: "hub-unreachable" },
    });
});

test("the actions take exactly their JSON bodies: 405, 415, 413 and 400 never reach the hub", async () => {
  const hub = standardHub([fact(1)]);
  const { call } = await routesWorld({ hub });
  const expectAnswer = async (
    answer: Promise<{ status: number; body: Record<string, unknown> }>,
    status: number,
    error: string,
  ) => expect(await answer).toMatchObject({ status, body: { error } });
  await expectAnswer(
    call("POST", "/api/new-tab/overview", {}),
    405,
    "method-not-allowed",
  );
  for (const path of ["open", "hold", "close", "restore"])
    await expectAnswer(
      call("GET", `/api/new-tab/${path}`),
      405,
      "method-not-allowed",
    );
  await expectAnswer(
    call(
      "POST",
      "/api/new-tab/open",
      JSON.stringify({ url: "https://example.com" }),
      {
        "content-type": "text/plain",
      },
    ),
    415,
    "invalid-content-type",
  );
  await expectAnswer(
    call("POST", "/api/new-tab/open", {
      url: `https://example.com/${"a".repeat(20_000)}`,
    }),
    413,
    "body-too-large",
  );
  for (const body of [
    "{",
    [],
    {},
    { url: "https://example.com", other: 1 },
    { url: "javascript:alert(1)" },
    { url: "file:///etc/passwd" },
    { url: 42 },
    { url: "https://example.com", strip: "../x" },
    { url: "https://example.com", strip: 7 },
  ])
    await expectAnswer(
      call("POST", "/api/new-tab/open", body),
      400,
      "invalid-request",
    );
  for (const path of ["hold", "close", "restore"]) {
    await expectAnswer(
      call("POST", `/api/new-tab/${path}`, { tab: "nope" }),
      400,
      "invalid-tab",
    );
    await expectAnswer(
      call("POST", `/api/new-tab/${path}`, { tab: 7 }),
      400,
      "invalid-tab",
    );
    await expectAnswer(
      call("POST", `/api/new-tab/${path}`, { tab: id(1), url: "x" }),
      400,
      "invalid-request",
    );
  }
  await expectAnswer(call("GET", "/api/new-tab/other"), 404, "not-found");
  expect(hub.seen).toEqual([]);
});

test("open asks the hub for the tab and records the Launchpad's hold before it answers", async () => {
  const hub = standardHub([]);
  const { call, held } = await routesWorld({ hub });
  const opened = await call("POST", "/api/new-tab/open", {
    url: "https://example.com/a",
    strip: "launchpad",
  });
  expect(opened).toMatchObject({
    status: 201,
    body: { tab: id(0x900), view: `${origin}/t/${id(0x900)}` },
  });
  // Held already when the answer came, at the boot clock's time.
  expect(await held()).toEqual([{ id: id(0x900), recordedAt: at(100) }]);
  expect(JSON.parse(hub.seen[0]?.body ?? "")).toEqual({
    url: "https://example.com/a",
    strip: "launchpad",
  });
  // For another strip, or none, the Launchpad holds nothing: that app does.
  for (const body of [
    { url: "https://example.com/b" },
    { url: "https://example.com/c", strip: null },
    { url: "https://example.com/d", strip: "t3-abc" },
  ])
    expect((await call("POST", "/api/new-tab/open", body)).status).toBe(201);
  expect((await held()).map((tab) => tab.id)).toEqual([id(0x900)]);
  expect(
    hub.seen.slice(1).map((request) => JSON.parse(request.body).strip),
  ).toEqual([null, null, "t3-abc"]);
  // No holder file where there is no runtime directory: refused before the
  // hub is asked.
  const without = await routesWorld({ hub, holder: false });
  const asked = hub.seen.length;
  expect(
    await without.call("POST", "/api/new-tab/open", {
      url: "https://example.com/e",
      strip: "launchpad",
    }),
  ).toMatchObject({ status: 503, body: { error: "holder-unavailable" } });
  expect(hub.seen.length).toBe(asked);
  // A hold that cannot be written is said, and journaled.
  const broken = await temporary("new-tab-broken-");
  await writeFile(join(broken, "lazurio-browser"), "not a directory");
  const failing = await routesWorld({ hub, runtime: broken });
  expect(
    await failing.call("POST", "/api/new-tab/open", {
      url: "https://example.com/f",
      strip: "launchpad",
    }),
  ).toMatchObject({ status: 500, body: { error: "hold-failed" } });
  expect(failing.host.events).toEqual(["hold-failed"]);
});

test("hold records the Launchpad's hold of a tab the hub lists, and of no other", async () => {
  const hub = standardHub([fact(1)]);
  const { call, held } = await routesWorld({ hub });
  expect(
    await call("POST", "/api/new-tab/hold", { tab: id(1).toLowerCase() }),
  ).toEqual({ status: 200, cache: "no-store", body: { held: true } });
  expect(await held()).toEqual([{ id: id(1), recordedAt: at(100) }]);
  expect(
    await call("POST", "/api/new-tab/hold", { tab: id(99) }),
  ).toMatchObject({
    status: 404,
    body: { error: "not-found" },
  });
  expect((await held()).map((tab) => tab.id)).toEqual([id(1)]);
  expect(
    hub.seen.map(
      (request) => `${request.method} ${request.path}${request.search}`,
    ),
  ).toEqual(["GET /.lazurio/tabs", "GET /.lazurio/tabs"]);
  const without = await routesWorld({ hub, holder: false });
  expect(
    await without.call("POST", "/api/new-tab/hold", { tab: id(1) }),
  ).toMatchObject({
    status: 503,
    body: { error: "holder-unavailable" },
  });
});

test("close and restore go to the hub and answer its outcome", async () => {
  const hub = standardHub([fact(1)]);
  const { call } = await routesWorld({ hub });
  expect(
    await call("POST", "/api/new-tab/close", { tab: id(1) }),
  ).toMatchObject({
    status: 202,
    body: { closing: "2026-10-11T10:02:08.000Z" },
  });
  expect(
    await call("POST", "/api/new-tab/restore", { tab: id(1) }),
  ).toMatchObject({
    status: 200,
    body: { restored: true },
  });
  expect(
    await call("POST", "/api/new-tab/restore", { tab: id(1) }),
  ).toMatchObject({
    status: 409,
    body: { error: "nothing-to-restore" },
  });
  expect(
    await call("POST", "/api/new-tab/close", { tab: id(2) }),
  ).toMatchObject({
    status: 404,
    body: { error: "not-found" },
  });
  expect(
    await call("POST", "/api/new-tab/restore", { tab: id(2) }),
  ).toMatchObject({
    status: 404,
    body: { error: "not-found" },
  });
  expect(hub.seen.map((request) => request.path)).toEqual([
    `/.lazurio/tabs/${id(1)}/close`,
    `/.lazurio/tabs/${id(1)}/restore`,
    `/.lazurio/tabs/${id(1)}/restore`,
    `/.lazurio/tabs/${id(2)}/close`,
    `/.lazurio/tabs/${id(2)}/restore`,
  ]);
});

test("close answers how long its Vrátit has left on the Environment's clock, the one the hub's deadline is on", async () => {
  // The fake hub's deadline is 2026-10-11T10:02:08.000Z.
  const deadline = Date.parse("2026-10-11T10:02:08.000Z");
  const hub = standardHub([fact(1), fact(2)]);
  let now = deadline - 6_500;
  const { call } = await routesWorld({ hub, now: () => now });
  expect(await call("POST", "/api/new-tab/close", { tab: id(1) })).toEqual({
    status: 202,
    cache: "no-store",
    body: { closing: "2026-10-11T10:02:08.000Z", left: 6_500 },
  });
  // Past the deadline nothing is left, never less than nothing.
  now = deadline + 1_000;
  expect(
    await call("POST", "/api/new-tab/close", { tab: id(2) }),
  ).toMatchObject({ status: 202, body: { left: 0 } });
});

test("release lets go of the Launchpad's hold only, without the hub, and a tab not held is released already", async () => {
  const hub = standardHub([fact(1), fact(2)]);
  const { call, held } = await routesWorld({ hub });
  await call("POST", "/api/new-tab/hold", { tab: id(1) });
  await call("POST", "/api/new-tab/hold", { tab: id(2) });
  hub.seen.length = 0;
  expect(
    await call("POST", "/api/new-tab/release", { tab: id(1).toLowerCase() }),
  ).toEqual({ status: 200, cache: "no-store", body: { released: true } });
  expect((await held()).map((tab) => tab.id)).toEqual([id(2)]);
  // Again, and a tab the Launchpad never held: released already.
  for (const tab of [id(1), id(99)])
    expect(await call("POST", "/api/new-tab/release", { tab })).toEqual({
      status: 200,
      cache: "no-store",
      body: { released: true },
    });
  expect((await held()).map((tab) => tab.id)).toEqual([id(2)]);
  // Neither the hub's tabs nor its other holders are touched.
  expect(hub.seen).toEqual([]);
  expect(hub.tabs.has(id(1))).toBe(true);
  // Exactly a tab id, and only with a holder.
  expect(
    await call("POST", "/api/new-tab/release", { tab: "x", extra: 1 }),
  ).toMatchObject({ status: 400 });
  const without = await routesWorld({ hub, holder: false });
  expect(
    await without.call("POST", "/api/new-tab/release", { tab: id(2) }),
  ).toMatchObject({ status: 503, body: { error: "holder-unavailable" } });
});

test("a release the holder file refuses fails closed: 500, and the file is not written over", async () => {
  const hub = standardHub([fact(1)]);
  const world = await routesWorld({ hub });
  await world.call("POST", "/api/new-tab/hold", { tab: id(1) });
  const directory = holderDirectory({
    XDG_RUNTIME_DIR: world.runtime,
  }) as string;
  const file = join(directory, "launchpad.json");
  await writeFile(file, "{");
  expect(
    await world.call("POST", "/api/new-tab/release", { tab: id(1) }),
  ).toMatchObject({ status: 500, body: { error: "release-failed" } });
  expect(await readFile(file, "utf8")).toBe("{");
  expect(world.host.events).toContain("release-failed");
});

test("the overview says the Launchpad's hold as the Launchpad last wrote it, before the hub reads the file again", async () => {
  // The hub still reports what it read last: a hold of id(2) that the
  // Launchpad no longer has, and none of id(1), which it just took.
  const hub = standardHub([
    fact(1, { holders: [{ strip: "t3-x", label: "Vlákno" }] }),
    fact(2, { holders: [{ strip: "launchpad", label: "Launchpad" }] }),
  ]);
  const { call } = await routesWorld({ hub });
  await call("POST", "/api/new-tab/hold", { tab: id(1) });
  const holders = async () =>
    ((await call("GET", "/api/new-tab/overview")).body.tabs as TabFacts[]).map(
      (tab) => [tab.id, tab.holders.map((hold) => hold.strip)],
    );
  expect(await holders()).toEqual([
    [id(1), ["t3-x", "launchpad"]],
    [id(2), []],
  ]);
  await call("POST", "/api/new-tab/release", { tab: id(1) });
  expect(await holders()).toEqual([
    [id(1), ["t3-x"]],
    [id(2), []],
  ]);
});

// ---- In the Launchpad ---------------------------------------------------------

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("The probe listens on a port");
  return port;
};

const { team: _team, ...withoutTeamOwner } = organizationContext.owner;

test.skipIf(process.platform === "win32")(
  "hosted: Nová karta's routes behind the gateway's admission, and the Launchpad's holder runs from its start to its close",
  async () => {
    const hub = standardHub([fact(1)]);
    const parent = await temporary("launchpad-new-tab-");
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const runtime = join(parent, "run");
    // The view service made the directory of its list before the Launchpad
    // started, so the Launchpad watches it from the start.
    await mkdir(join(runtime, "lazurio-browser"), {
      recursive: true,
      mode: 0o700,
    });
    const preset = "hosted-organization-personal";
    const listenPort = freePort();
    const machineHost = "workspace.example.lazurio.io";
    const handover = {
      ...entries.organization,
      launchpad: { ...entries.organization.launchpad, listen_port: listenPort },
    };
    await initializeHandoverFolder(folder, {
      preset,
      machine: binding({
        ...organizationContext,
        owner: withoutTeamOwner,
        entry: withBrowser(handover, machineHost, hub.entry.listenPort),
      }),
      profile: presetProfile(preset, executionOs(process.platform)),
    });
    const fetcher: AuthFetcher = async (_url, init) =>
      new Headers(init.headers).get("cookie") ===
      "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 });
    const moduleHost: ModuleHost = {
      platform: "linux",
      home: parent,
      path: "/usr/bin:/bin",
      runtimeDirectory: "/run/user/1000",
      platformExecutable: process.execPath,
      runnerKind: async () => "systemd-user",
      createRunner: (_kind, organizationDirectory) =>
        createSystemdUserRunner({
          organizationDirectory,
          runtimeDirectory: "/run/user/1000",
          run: listingManager([]),
        }),
      readJournal: async () => ({ kind: "unavailable" }),
    };
    const newTabHost = fakeHost(runtime, {
      memory: { "lazurio-browser.service": "2000000000" },
      clock: () => at(100),
    });
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher },
      {
        path: parent,
        home: parent,
        platform: process.platform,
        run: async () => "timeout",
      },
      {},
      undefined,
      moduleHost,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      newTabHost,
    );
    let closed = false;
    cleanups.push(async () => {
      if (!closed) await app.close();
    });
    const base = `http://127.0.0.1:${listenPort}`;
    const valid = {
      host: `launchpad.${machineHost}`,
      cookie: "__Secure-lazurio-workspace=valid",
    };
    const sameOrigin = {
      ...valid,
      origin: `https://launchpad.${machineHost}`,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const overview = await fetch(`${base}/api/new-tab/overview`, {
      headers: valid,
    });
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({
      hub: "connected",
      tabs: [{ id: id(1), who: {}, heap: { used: 1_000, total: 2_000 } }],
      memory: { browser: 2_000_000_000 },
      modules: [],
    });
    // Without the session, nothing; a write needs the same-origin proof.
    expect(
      (
        await fetch(`${base}/api/new-tab/overview`, {
          headers: { host: valid.host },
        })
      ).status,
    ).toBe(401);
    const open = (headers: Record<string, string>) =>
      fetch(`${base}/api/new-tab/open`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: "https://example.com/",
          strip: "launchpad",
        }),
      });
    expect(
      (await open({ ...valid, "content-type": "application/json" })).status,
    ).toBe(401);
    expect(hub.seen.filter((request) => request.method === "POST")).toEqual([]);
    const file = join(runtime, "lazurio-browser", "holders", "launchpad.json");
    const listPath = join(runtime, "lazurio-browser", "tabs.json");
    // A file that holds nothing is removed (F50 point 1): no file, no hold.
    const held = async () => {
      const text = await readFile(file, "utf8").catch(() => null);
      return text === null ? [] : parseHolder("launchpad.json", text)?.tabs;
    };
    const opened = await open(sameOrigin);
    expect(opened.status).toBe(201);
    const first = ((await opened.json()) as { tab: string }).tab;
    expect(await held()).toEqual([first]);
    // Started with the Launchpad: the hub's next list reaches it.
    await writeLiveTabs(listPath, [], at(150));
    await until(async () => (await held())?.length === 0);
    const second = ((await (await open(sameOrigin)).json()) as { tab: string })
      .tab;
    expect(await held()).toEqual([second]);
    // Stopped with it: nothing is read or written any more.
    await app.close();
    closed = true;
    await writeLiveTabs(listPath, [], at(200));
    await settle(300);
    expect(await held()).toEqual([second]);
  },
);

test.skipIf(process.platform === "win32")(
  "a workstation's Launchpad has no browser: Nová karta's routes are not found",
  async () => {
    const parent = await temporary("launchpad-new-tab-local-");
    const folder = join(parent, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const app = await startLaunchpad(folder);
    cleanups.push(() => app.close());
    const url = new URL(app.url);
    const answer = await fetch(new URL("/api/new-tab/overview", url), {
      headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
    });
    expect([answer.status, await answer.json()]).toEqual([
      404,
      { error: "no-browser" },
    ]);
  },
);
