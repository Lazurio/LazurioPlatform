import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hubRequestOf,
  parseHubTab,
  type TabFacts,
} from "../src/browser/contract/platform";
import {
  availableShare,
  browserPressurePath,
  type PressureCandidate,
  parsePressure,
  pressureLimits,
  pressureOrder,
  pressureSource,
  pressureTimes,
  underPressure,
} from "../src/browser/people/pressure";
import { parseClientMessage } from "../src/browser/people/protocol";
import {
  addressKey,
  parseSleepState,
  quietSince,
  type SleepRecord,
  sleepableAddress,
  sleepStateSchema,
  sleepStateText,
  sleepTimes,
} from "../src/browser/people/sleep";
import {
  ensureThreadWindow,
  threadPage,
  type WindowSeams,
} from "../src/browser/window";

// Decision F57: the rules of sleeping tabs that read without a browser, the
// view's report of a hidden page, and `lazurio browser window` reusing a page
// its thread shows already. The hub's own cases are in
// environment-browser-view.test.ts against a scripted DevTools peer.

const id = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("the times: a tab sleeps after 20 minutes without use, a page has 5 s to close or object", () => {
  expect(sleepTimes).toEqual({
    idleMs: 1_200_000,
    closeWaitMs: 5_000,
    wakeRetryMs: 2_000,
  });
});

test("one page is its address but for the fragment: the origin, the path and the query count, and only web pages are pages", () => {
  expect(addressKey("https://vault.example.com/#/vault")).toBe(
    "https://vault.example.com/",
  );
  expect(addressKey("https://vault.example.com/#/send")).toBe(
    addressKey("https://vault.example.com/#/vault"),
  );
  expect(addressKey("https://example.com/list?page=2#top")).toBe(
    "https://example.com/list?page=2",
  );
  // Two searches are two pages.
  expect(addressKey("https://example.com/search?q=a")).not.toBe(
    addressKey("https://example.com/search?q=b"),
  );
  expect(addressKey("http://localhost:3000/a/b")).toBe(
    "http://localhost:3000/a/b",
  );
  expect(addressKey("https://example.com/a")).not.toBe(
    addressKey("https://example.com/a/"),
  );
  expect(addressKey("about:blank")).toBeNull();
  expect(addressKey("chrome://settings")).toBeNull();
  expect(addressKey("not an address")).toBeNull();
});

test("a tab sleeps only with an address the hub opens again by itself", () => {
  expect(sleepableAddress("https://example.com/a?x=1")).toBe(true);
  expect(sleepableAddress("http://localhost:5173/")).toBe(true);
  expect(sleepableAddress("about:blank")).toBe(false);
  expect(sleepableAddress("")).toBe(false);
  expect(sleepableAddress("data:text/html,hi")).toBe(false);
  expect(sleepableAddress("chrome-error://chromewebdata/")).toBe(false);
  // Never the view of an Environment browser (F50, C16).
  expect(
    sleepableAddress(`https://browser.vm.example.lazurio.io/t/${id(1)}`),
  ).toBe(false);
});

test("the quiet clock is the latest use of any kind, and a page asked to close that stayed awake counts from then", () => {
  expect(
    quietSince({
      openedAt: 10,
      viewedAt: 40,
      agentAt: 30,
      activeAt: 20,
      unsavedAt: 0,
      askedAt: 0,
    }),
  ).toBe(40);
  expect(
    quietSince({
      openedAt: 10,
      viewedAt: 0,
      agentAt: 0,
      activeAt: 0,
      unsavedAt: 55,
      askedAt: 0,
    }),
  ).toBe(55);
  // A page that hung or objected is asked again an idle time later.
  expect(
    quietSince({
      openedAt: 10,
      viewedAt: 40,
      agentAt: 0,
      activeAt: 0,
      unsavedAt: 0,
      askedAt: 70,
    }),
  ).toBe(70);
});

const record = (n: number, extra: Partial<SleepRecord> = {}): SleepRecord => ({
  id: id(n),
  url: `https://example.com/${n}`,
  title: `Tab ${n}`,
  favicon: "https://example.com/favicon.ico",
  opener: { kind: "new-tab", strip: "launchpad" },
  openedAt: 1_000,
  usedAt: 2_000,
  sleptAt: 3_000,
  reason: "idle",
  ...extra,
});

test("what the hub writes down reads back the same: the browser, the tombstones and the woken tabs' ids", () => {
  const state = {
    browser: "c6b5a1e0-browser",
    sleeping: [
      record(1),
      record(2, { opener: { kind: "agent", session: "codex-a" } }),
    ],
    aliases: new Map([[id(100), id(3)]]),
  };
  const text = sleepStateText(state);
  expect(JSON.parse(text).schema).toBe(sleepStateSchema);
  expect(parseSleepState(text)).toEqual(state);
});

test("a written state that is not one is none, and a record that is no tombstone is left out", () => {
  expect(parseSleepState("")).toBeNull();
  expect(parseSleepState("{")).toBeNull();
  expect(
    parseSleepState(JSON.stringify({ schema: "other", browser: "b" })),
  ).toBeNull();
  expect(
    parseSleepState(
      JSON.stringify({ schema: sleepStateSchema, browser: "", sleeping: [] }),
    ),
  ).toBeNull();
  const parsed = parseSleepState(
    JSON.stringify({
      schema: sleepStateSchema,
      browser: "b",
      sleeping: [
        record(1),
        // An id in lower case is the tab's id, in upper case.
        { ...record(2), id: id(2).toLowerCase() },
        // No tombstone: an address the hub cannot open again, no id, a
        // reason it does not know, a time that is none, the same id again.
        { ...record(3), url: "about:blank" },
        { ...record(4), id: "tab-4" },
        { ...record(5), reason: "tired" },
        { ...record(6), sleptAt: "yesterday" },
        record(1),
        // A favicon only over https, an opener of no known kind.
        {
          ...record(7),
          favicon: "http://example.com/i.ico",
          opener: { kind: "robot" },
        },
      ],
      aliases: { [id(100)]: id(7), [id(101)]: id(101), x: id(7) },
    }),
  );
  expect(parsed?.sleeping.map((tab) => tab.id)).toEqual([id(1), id(2), id(7)]);
  expect(parsed?.sleeping[2]).toMatchObject({
    favicon: null,
    opener: { kind: "unknown" },
  });
  expect(parsed?.aliases).toEqual(new Map([[id(100), id(7)]]));
});

test("the view says when the person's browser hides or shows its page; anything else is no such message", () => {
  expect(parseClientMessage('{"t":"visible","visible":false}')).toEqual({
    t: "visible",
    visible: false,
  });
  expect(parseClientMessage('{"t":"visible","visible":true}')).toEqual({
    t: "visible",
    visible: true,
  });
  expect(parseClientMessage('{"t":"visible","visible":"no"}')).toBeNull();
  expect(parseClientMessage('{"t":"visible"}')).toBeNull();
  const hello = {
    t: "hello" as const,
    width: 800,
    height: 600,
    dpr: 1,
    resize: true,
  };
  expect(
    parseClientMessage(JSON.stringify({ ...hello, visible: false })),
  ).toMatchObject({ visible: false });
  // A page from before says nothing and counts as shown.
  expect(parseClientMessage(JSON.stringify(hello))).toEqual(hello);
  expect(
    parseClientMessage(JSON.stringify({ ...hello, visible: 1 })),
  ).toBeNull();
});

// ---- `lazurio browser window` reuses a page its thread shows already ---------

async function threadWorld() {
  root = await realpath(await mkdtemp(join(tmpdir(), "browser-sleep-")));
  const sockets = join(root, "sockets");
  const holders = join(root, "runtime", "lazurio-browser", "holders");
  await mkdir(sockets, { recursive: true });
  await mkdir(holders, { recursive: true });
  const bind = (session: string, targetId: string) =>
    writeFile(
      join(sockets, `${session}.target`),
      JSON.stringify({ targetId, url: "about:blank", pinned: true }),
    );
  const calls: unknown[] = [];
  const pages = new Map<string, string>();
  const seams = (withPages = true): WindowSeams => ({
    env: {
      HOME: "/home/operator",
      AGENT_BROWSER_SOCKET_DIR: sockets,
      XDG_RUNTIME_DIR: join(root as string, "runtime"),
    },
    run: async (command) => {
      calls.push([...command]);
      return { exitCode: 0, stdout: "" };
    },
    targets: async () => new Set(pages.keys()),
    cdp: async (method, params) => {
      calls.push([method, params]);
      return { targetId: id(0x900) };
    },
    ...(withPages ? { pages: async () => pages } : {}),
  });
  return { sockets, holders, bind, calls, pages, seams };
}

/** A thread's strip as T3 Code's server writes it (F47 point 4). */
const holdFor = (
  world: Awaited<ReturnType<typeof threadWorld>>,
  strip: string,
  tabs: readonly string[],
) =>
  writeFile(
    join(world.holders, `${strip}.json`),
    JSON.stringify({ strip, label: strip, tabs }),
  );

test("a T3 Code thread's page at the same address, but for its fragment, is the window of its session; another query, another thread's page or a session without a strip never is", async () => {
  const world = await threadWorld();
  // The thread's strip holds the vault and a guide; another thread's strip
  // holds a Module.
  await holdFor(world, "t3-a", [id(1), id(3)]);
  await holdFor(world, "t3-b", [id(2)]);
  world.pages.set(id(1), "https://vault.example.com/#/vault");
  world.pages.set(id(2), "https://module.example.com/");
  world.pages.set(id(3), "https://docs.example.com/guide?a=1");
  const seams = world.seams();
  expect(
    await threadPage("t3-a", "https://vault.example.com/#/send", seams),
  ).toBe(id(1));
  expect(
    await threadPage("t3-a", "https://docs.example.com/guide?a=1", seams),
  ).toBe(id(3));
  // Another query is another page.
  expect(
    await threadPage("t3-a", "https://docs.example.com/guide?a=2", seams),
  ).toBeNull();
  // Another thread's page.
  expect(
    await threadPage("t3-a", "https://module.example.com/", seams),
  ).toBeNull();
  // A session with no strip of its own reuses nothing, not even a page a
  // session of a similar name is bound to.
  await world.bind("codex-a", id(1));
  expect(
    await threadPage("codex-a-2", "https://vault.example.com/", seams),
  ).toBeNull();
  expect(
    await threadPage("codex-a", "https://vault.example.com/", seams),
  ).toBeNull();
  // A page that is gone is none.
  world.pages.delete(id(1));
  expect(
    await threadPage("t3-a", "https://vault.example.com/", seams),
  ).toBeNull();
  // Without the browser's addresses nothing is shared.
  world.pages.set(id(1), "https://vault.example.com/#/vault");
  expect(
    await threadPage("t3-a", "https://vault.example.com/", world.seams(false)),
  ).toBeNull();
  // The window: the session is bound to that page, nothing is created.
  expect(
    await ensureThreadWindow(
      "t3-a",
      "https://vault.example.com/#/vault",
      seams,
    ),
  ).toEqual({ session: "t3-a", targetId: id(1), created: false });
  expect(
    world.calls.some(
      (call) => Array.isArray(call) && call[0] === "Target.createTarget",
    ),
  ).toBe(false);
  expect(world.calls).toContainEqual([
    "/home/operator/.local/bin/agent-browser",
    "--cdp",
    "9222",
    "--session",
    "t3-a",
    "--no-pin-tab",
    "tab",
    id(1),
  ]);
});

test("two threads whose names differ by a trailing -2 are two threads: neither ever gets the other's page", async () => {
  const world = await threadWorld();
  const private1 = "https://private.example/page";
  const private2 = "https://private.example/other";
  // `t3-thread-2` is a thread of its own, with its binding and its strip.
  await world.bind("t3-thread-2", id(0xa));
  await holdFor(world, "t3-thread-2", [id(0xa)]);
  await holdFor(world, "t3-thread", [id(0xb)]);
  world.pages.set(id(0xa), private1);
  world.pages.set(id(0xb), private2);
  const seams = world.seams();
  expect(await threadPage("t3-thread", private1, seams)).toBeNull();
  expect(await threadPage("t3-thread-2", private2, seams)).toBeNull();
  // Each one's own page is its own.
  expect(await threadPage("t3-thread-2", private1, seams)).toBe(id(0xa));
  expect(await threadPage("t3-thread", private2, seams)).toBe(id(0xb));
  // A strip with only the other thread's page: a window of its own.
  await holdFor(world, "t3-thread", []);
  expect(await ensureThreadWindow("t3-thread", private1, seams)).toEqual({
    session: "t3-thread",
    targetId: id(0x900),
    created: true,
  });
  // A holder file whose strip names another thread holds nothing here.
  await writeFile(
    join(world.holders, "t3-thread.json"),
    JSON.stringify({ strip: "t3-thread-2", label: "", tabs: [id(0xa)] }),
  );
  expect(await threadPage("t3-thread", private1, seams)).toBeNull();
});

test("the hub's list says which tab sleeps and which has unsaved input, only where it applies; Uspat and Probudit are paths of the hub", () => {
  const tab = {
    id: id(1),
    url: "https://example.com/",
    title: "Example",
    favicon: null,
    openedAt: "2026-10-20T10:00:00.000Z",
    usedAt: "2026-10-20T10:01:00.000Z",
    opener: { kind: "unknown" },
    agents: [],
    holders: [],
    viewers: 0,
    closing: null,
    grace: null,
  } satisfies TabFacts;
  expect(parseHubTab(tab, false)).toEqual(tab);
  expect(
    parseHubTab(
      {
        ...tab,
        sleeping: { since: "2026-10-20T10:21:00.000Z", reason: "idle" },
        unsaved: "2026-10-20T10:20:00.000Z",
      },
      false,
    ),
  ).toEqual({
    ...tab,
    sleeping: { since: "2026-10-20T10:21:00.000Z", reason: "idle" },
    unsaved: "2026-10-20T10:20:00.000Z",
  });
  // Anything else of them is left out, never guessed.
  expect(
    parseHubTab(
      {
        ...tab,
        sleeping: { since: "2026-10-20T10:21:00.000Z", reason: "tired" },
        unsaved: "soon",
      },
      false,
    ),
  ).toEqual(tab);
  expect(hubRequestOf(`/.lazurio/tabs/${id(1)}/sleep`)).toEqual({
    kind: "sleep",
    targetId: id(1),
  });
  expect(hubRequestOf(`/.lazurio/tabs/${id(1).toLowerCase()}/wake`)).toEqual({
    kind: "wake",
    targetId: id(1),
  });
  expect(hubRequestOf(`/.lazurio/tabs/${id(1)}/nap`)).toBeNull();
});

// ---- The pressure rule (decision F57 point 6) ----------------------------------

test("the pressure rule's limits and times are the provisional defaults F57 names, until Ring 0 measures them", () => {
  expect(pressureLimits).toEqual({
    startSomePercent: 10,
    startAvailable: 0.1,
    stopSomePercent: 2,
    stopAvailable: 0.15,
  });
  expect(pressureTimes).toEqual({
    readEveryMs: 5_000,
    coolDownMs: 15_000,
    quietMs: 60_000,
  });
});

test("pressure starts at either limit and ends only once every signal is past its stop: no flapping in between", () => {
  const at = (some: number | null, available: number | null) => ({
    some,
    available,
  });
  // Calm: neither limit.
  expect(underPressure(false, at(5, 0.5))).toBe(false);
  // PSI at its start limit, or memory short, alone is enough.
  expect(underPressure(false, at(10, 0.5))).toBe(true);
  expect(underPressure(false, at(0, 0.09))).toBe(true);
  // Between the limits it stays as it was.
  expect(underPressure(true, at(5, 0.5))).toBe(true);
  expect(underPressure(true, at(1, 0.12))).toBe(true);
  expect(underPressure(false, at(5, 0.12))).toBe(false);
  // It ends only below 2 % and above 15 % together.
  expect(underPressure(true, at(1.9, 0.16))).toBe(false);
  expect(underPressure(true, at(2, 0.16))).toBe(true);
  expect(underPressure(true, at(1, 0.15))).toBe(true);
  // A signal that cannot be read counts for neither side.
  expect(underPressure(false, at(null, 0.05))).toBe(true);
  expect(underPressure(true, at(null, 0.2))).toBe(false);
  expect(underPressure(false, at(25, null))).toBe(true);
  expect(underPressure(true, at(1, null))).toBe(false);
  // Nothing read: off, whatever it was.
  expect(underPressure(true, at(null, null))).toBe(false);
});

test("PSI reads as its some avg10 in percent and meminfo as the share available; anything else is nothing", () => {
  expect(
    parsePressure(
      "some avg10=19.04 avg60=6.12 avg300=1.50 total=123456\nfull avg10=17.00 avg60=5.00 avg300=1.00 total=99999\n",
    ),
  ).toBe(19.04);
  expect(
    parsePressure(
      "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    ),
  ).toBe(0);
  // `full` is never higher than `some`, and alone it is no reading.
  expect(
    parsePressure("full avg10=17.00 avg60=5.00 avg300=1.00 total=1\n"),
  ).toBeNull();
  expect(parsePressure("")).toBeNull();
  expect(parsePressure("some avg10=abc avg60=0.00\n")).toBeNull();
  expect(parsePressure("some avg10=250.00 avg60=0.00\n")).toBeNull();
  expect(
    availableShare(
      "MemTotal:        8000000 kB\nMemFree:          100000 kB\nMemAvailable:    2000000 kB\n",
    ),
  ).toBe(0.25);
  expect(availableShare("MemTotal:        8000000 kB\n")).toBeNull();
  expect(availableShare("MemTotal: 0 kB\nMemAvailable: 0 kB\n")).toBeNull();
});

const candidate = (
  name: string,
  extra: Partial<PressureCandidate> = {},
): PressureCandidate & { name: string } => ({
  name,
  viewed: false,
  agent: false,
  thread: false,
  held: true,
  unsaved: false,
  quietSince: 1_000,
  askedAt: 0,
  ...extra,
});

test("under pressure the tabs nothing holds go first, then the held ones, and those with unsaved input last, each the least recently used first", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const times = { quietMs: 60_000, askAgainMs: 1_200_000 };
  const order = pressureOrder(
    [
      candidate("held, used later", { quietSince: 500_000 }),
      candidate("unsaved, used long ago", { unsaved: true, quietSince: 10 }),
      candidate("held, used earlier", { quietSince: 400_000 }),
      candidate("unheld, used later", { held: false, quietSince: 600_000 }),
      candidate("unheld, used earlier", { held: false, quietSince: 300_000 }),
      candidate("unsaved, used later", { unsaved: true, quietSince: 700_000 }),
    ],
    now,
    times,
  ).map((c) => c.name);
  expect(order).toEqual([
    "unheld, used earlier",
    "unheld, used later",
    "held, used earlier",
    "held, used later",
    "unsaved, used long ago",
    "unsaved, used later",
  ]);
});

test("the pressure rule never takes a tab someone views, an agent works in or worked in recently, a T3 Code thread holds, one just used, or one that just refused to close", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const times = { quietMs: 60_000, askAgainMs: 1_200_000 };
  const order = pressureOrder(
    [
      candidate("viewed", { viewed: true, held: false }),
      candidate("agent", { agent: true, held: false }),
      candidate("thread", { thread: true }),
      candidate("just used", { quietSince: now - 59_999 }),
      candidate("refused", { unsaved: true, askedAt: now - 1_199_999 }),
      candidate("refused long ago", {
        unsaved: true,
        askedAt: now - 1_200_000,
      }),
      candidate("quiet a minute", { quietSince: now - 60_000 }),
    ],
    now,
    times,
  ).map((c) => c.name);
  expect(order).toEqual(["quiet a minute", "refused long ago"]);
  // Every exclusion at once leaves nothing to take.
  expect(
    pressureOrder(
      [candidate("viewed", { viewed: true }), candidate("t", { thread: true })],
      now,
      times,
    ),
  ).toEqual([]);
});

test("the browser's PSI is in its unit's cgroup next to the view's own; a cgroup it cannot start from gives none", () => {
  expect(
    browserPressurePath(
      "/user.slice/user-1000.slice/user@1000.service/app.slice/lazurio-browser-view.service",
    ),
  ).toBe(
    "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/lazurio-browser.service/memory.pressure",
  );
  expect(browserPressurePath("/")).toBeNull();
  expect(browserPressurePath("/lazurio-browser-view.service")).toBeNull();
  expect(browserPressurePath("relative/path")).toBeNull();
  expect(browserPressurePath("/a/../b/view.service")).toBeNull();
});

test("the source reads the higher PSI of the browser and the Environment and the memory available; what it cannot read it leaves out, logged once, and with nothing read the rule is off", async () => {
  const own =
    "/user.slice/user-1000.slice/user@1000.service/app.slice/lazurio-browser-view.service";
  const browserFile =
    "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/lazurio-browser.service/memory.pressure";
  const psi = (some: number) =>
    `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
  const files = new Map<string, string>([
    [browserFile, psi(14)],
    ["/proc/pressure/memory", psi(3)],
    ["/proc/meminfo", "MemTotal: 8000 kB\nMemAvailable: 2000 kB\n"],
  ]);
  const logs: string[] = [];
  let groupReads = 0;
  const source = pressureSource({
    log: (line) => logs.push(line),
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined)
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return text;
    },
    ownControlGroup: async () => {
      groupReads++;
      return own;
    },
  });
  expect(await source()).toEqual({ some: 14, available: 0.25 });
  files.set("/proc/pressure/memory", psi(21));
  expect(await source()).toEqual({ some: 21, available: 0.25 });
  expect(logs).toEqual([]);
  // The browser's unit is stopped: its cgroup is gone. Logged once.
  files.delete(browserFile);
  expect(await source()).toEqual({ some: 21, available: 0.25 });
  expect(await source()).toEqual({ some: 21, available: 0.25 });
  expect(logs).toEqual([
    `memory pressure: ${browserFile} cannot be read (ENOENT)`,
  ]);
  // Nothing to read at all, as on a system without PSI or /proc: off.
  files.clear();
  expect(await source()).toEqual({ some: null, available: null });
  expect(await source()).toEqual({ some: null, available: null });
  expect(logs.filter((line) => line.includes("rule is off"))).toHaveLength(1);
  expect(logs.filter((line) => line.includes("/proc/meminfo"))).toHaveLength(1);
  // The view's own cgroup is read once.
  expect(groupReads).toBe(1);
  // A view without a cgroup of its own reads the Environment's alone.
  const alone: string[] = [];
  const environmentOnly = pressureSource({
    log: (line) => alone.push(line),
    readFile: async (path) => {
      if (path === "/proc/pressure/memory") return psi(4);
      if (path === "/proc/meminfo")
        return "MemTotal: 1000 kB\nMemAvailable: 500 kB\n";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    ownControlGroup: async () => null,
  });
  expect(await environmentOnly()).toEqual({ some: 4, available: 0.5 });
  expect(await environmentOnly()).toEqual({ some: 4, available: 0.5 });
  expect(alone).toHaveLength(1);
  expect(alone[0]).toContain("cgroup is unknown");
});
