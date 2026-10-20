import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hubRequestOf,
  parseHubTab,
  type TabFacts,
} from "../src/browser/contract/platform";
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
  sessionFamily,
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

test("the quiet clock is the latest use of any kind", () => {
  expect(
    quietSince({
      openedAt: 10,
      viewedAt: 40,
      agentAt: 30,
      activeAt: 20,
      unsavedAt: 0,
    }),
  ).toBe(40);
  expect(
    quietSince({
      openedAt: 10,
      viewedAt: 0,
      agentAt: 0,
      activeAt: 0,
      unsavedAt: 55,
    }),
  ).toBe(55);
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

test("a thread's sessions are one family: a session and its numbered siblings", () => {
  expect(sessionFamily("codex-019a")).toBe("codex-019a");
  expect(sessionFamily("codex-019a-2")).toBe("codex-019a");
  expect(sessionFamily("t3-thread-12")).toBe("t3-thread");
  // A long number is part of the name, not a sibling's.
  expect(sessionFamily("claude-1234")).toBe("claude-1234");
});

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

test("a thread's page at the same address, but for its fragment, is the window of its new session; another query or another thread's page never is", async () => {
  const world = await threadWorld();
  // The thread's first session shows the vault; another thread shows the
  // Module; the thread's strip holds a third page.
  await world.bind("codex-a", id(1));
  await world.bind("codex-b", id(2));
  world.pages.set(id(1), "https://vault.example.com/#/vault");
  world.pages.set(id(2), "https://module.example.com/");
  world.pages.set(id(3), "https://docs.example.com/guide?a=1");
  await writeFile(
    join(world.holders, "codex-a.json"),
    JSON.stringify({ strip: "codex-a", label: "", tabs: [id(3)] }),
  );
  const seams = world.seams();
  expect(
    await threadPage("codex-a-2", "https://vault.example.com/#/send", seams),
  ).toBe(id(1));
  expect(
    await threadPage("codex-a-2", "https://docs.example.com/guide?a=1", seams),
  ).toBe(id(3));
  // Another query is another page.
  expect(
    await threadPage("codex-a-2", "https://docs.example.com/guide?a=2", seams),
  ).toBeNull();
  expect(
    await threadPage("codex-a-2", "https://module.example.com/", seams),
  ).toBeNull();
  // A page that is gone is none.
  world.pages.delete(id(1));
  expect(
    await threadPage("codex-a-2", "https://vault.example.com/", seams),
  ).toBeNull();
  // Without the browser's addresses nothing is shared.
  world.pages.set(id(1), "https://vault.example.com/#/vault");
  expect(
    await threadPage(
      "codex-a-2",
      "https://vault.example.com/",
      world.seams(false),
    ),
  ).toBeNull();
  // The window: the new session is bound to that page, nothing is created.
  expect(
    await ensureThreadWindow(
      "codex-a-2",
      "https://vault.example.com/#/vault",
      seams,
    ),
  ).toEqual({ session: "codex-a-2", targetId: id(1), created: false });
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
    "codex-a-2",
    "--no-pin-tab",
    "tab",
    id(1),
  ]);
  // Another thread's page: a window of its own.
  expect(
    await ensureThreadWindow("codex-c", "https://module.example.com/", seams),
  ).toEqual({ session: "codex-c", targetId: id(0x900), created: true });
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
