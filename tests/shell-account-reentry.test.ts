import { afterEach, expect, test } from "bun:test";
import { readAccount } from "../src/launchpad/account";
import {
  accountCacheKey,
  createReentry,
  pageReentry,
  type Reentry,
  readAccountJson,
  reentryGuardMs,
  reentryKey,
  rememberAccount,
  sessionRefused,
} from "../src/shell/account";
import {
  parseShell,
  parseShellAccount,
  type Shell,
} from "../src/shell/contract";
import { createShellState } from "../src/shell/state";
import { accountDocument } from "./fixtures/account-document";
import { spyStore } from "./fixtures/shell-state";

// F37's addendum of 2026-10-12: when the Environment's gateway refuses the
// account with a `401` (the session went stale), the page re-enters the
// Environment once, by reloading itself, so that the gateway signs the person
// in again; the rail keeps the remembered account meanwhile. A tab re-enters
// at most once within `reentryGuardMs`; a `403` or `404` never navigates.
// Every case below goes through the rail's own state and the page's account
// read, with the tab's memory (`sessionStorage`), the origin's memory
// (`localStorage`), the clock and the navigation observed. Example names only.

const quiet = () => {};
const parsedLocal = parseShell({
  schema: "lazurio.shell.v1",
  locale: "en",
  current: "local.example",
  operator: { initials: "A", login: "ada", avatar: null },
  environments: [
    {
      id: "local.example",
      label: "Local",
      kind: "work",
      organizations: ["example"],
      assignee: "ada",
      apps: {
        apps: "https://launchpad.local.example.lazurio.io/",
        chat: null,
        automate: null,
      },
    },
  ],
  organizations: [
    {
      slug: "example",
      name: "Example",
      avatar: null,
      dashboard: "https://dashboard.lazurio.ai/orgs/example",
    },
  ],
  dashboard: "https://dashboard.lazurio.ai/",
  account: "https://dashboard.lazurio.ai/settings",
  addOrganization: "https://dashboard.lazurio.ai/add-organization",
});
if (parsedLocal === null) throw new Error("Invalid local fixture");
const local: Shell = parsedLocal;
const person = parseShellAccount(accountDocument());
if (person === null) throw new Error("Invalid account fixture");

const answer = (status: number) =>
  new Response(JSON.stringify(accountDocument()), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** One browser tab on one origin: its `sessionStorage` (the guard), the
 * origin's `localStorage` (the remembered account), a clock, and every
 * navigation a page of the tab began. */
function tab() {
  const session = spyStore();
  const origin = spyStore();
  const navigations: number[] = [];
  let clock = 1_700_000_000_000;
  /** The page's re-entry, as `pageReentry` makes it in a browser. */
  const reentry = (): Reentry =>
    createReentry(
      session,
      () => navigations.push(clock),
      () => clock,
    );
  return {
    session,
    origin,
    navigations,
    reentry,
    advance(ms: number) {
      clock += ms;
    },
    /** One page load: the rail's state reads the account once, answered
     * with `statuses` in turn (the last one repeats). */
    async load(...statuses: number[]) {
      const lines: string[] = [];
      let calls = 0;
      let read: Promise<unknown> = Promise.resolve(null);
      const state = createShellState({
        source: () => "origin",
        read: () => {
          read = readAccountJson(
            async () => {
              const status = statuses[Math.min(calls, statuses.length - 1)];
              calls += 1;
              return answer(status ?? 200);
            },
            100,
            (line) => lines.push(line),
            origin,
            [0, 0],
            reentry(),
          );
          return read;
        },
        report: quiet,
        store: origin,
        log: (line) => lines.push(line),
      });
      state.provideShell(local);
      state.requestAccount();
      const value = await read;
      // The state takes the answer on the next turn.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { state, lines, value, calls: () => calls };
    },
  };
}

test("a 401 re-enters the Environment once, and the rail keeps the person's account meanwhile", async () => {
  const browser = tab();
  rememberAccount(person, "ada", browser.origin);
  const page = await browser.load(401);
  expect(browser.navigations).toHaveLength(1);
  expect(page.calls()).toBe(1);
  expect(page.value).toBeNull();
  // The rail does not shrink while the page reloads: the remembered account
  // stays drawn and kept.
  expect(page.state.drawn()?.environments.length).toBeGreaterThan(1);
  expect(browser.origin.values.has(accountCacheKey)).toBe(true);
  expect(browser.session.values.get(reentryKey)).toBe(
    String(browser.navigations[0]),
  );
  expect(page.lines).toEqual([
    "Lazurio shell: the account was refused (401); the page re-enters the Environment to sign in again.",
  ]);
});

test("a second 401 within the guard does not navigate: it is final, as before", async () => {
  const browser = tab();
  rememberAccount(person, "ada", browser.origin);
  await browser.load(401);
  expect(browser.navigations).toHaveLength(1);
  // The page the re-entry led to is refused again: no second navigation,
  // and the remembered account goes, so the rail shows this Environment.
  browser.advance(60_000);
  const again = await browser.load(401);
  expect(browser.navigations).toHaveLength(1);
  expect(again.state.drawn()?.environments).toHaveLength(1);
  expect(browser.origin.values.has(accountCacheKey)).toBe(false);
  expect(again.lines).toEqual([
    "Lazurio shell: no account (401); the rail shows this Environment only.",
  ]);
  // Up to the end of the guard, still none.
  browser.advance(reentryGuardMs - 60_000 - 1);
  await browser.load(401);
  expect(browser.navigations).toHaveLength(1);
  // Once the guard is over, a refusal re-enters once more.
  browser.advance(1);
  await browser.load(401);
  expect(browser.navigations).toHaveLength(2);
});

test("a 403 or a 404 never navigates and stays final, removing the remembered account", async () => {
  for (const status of [403, 404]) {
    const browser = tab();
    rememberAccount(person, "ada", browser.origin);
    const page = await browser.load(status);
    expect([status, browser.navigations]).toEqual([status, []]);
    expect(page.state.drawn()?.environments).toHaveLength(1);
    expect(browser.origin.values.has(accountCacheKey)).toBe(false);
    expect(browser.session.calls).toEqual([]);
  }
});

test("a success never clears the guard: an account success then a Launchpad 401 on every page load reloads once per guard, never in a loop", async () => {
  const browser = tab();
  await browser.load(401);
  expect(browser.navigations).toHaveLength(1);
  // The reloaded page signs in and reads the account, but the Launchpad
  // keeps answering 401 on its own: each page load is an account success
  // followed by a Launchpad refusal.
  for (let load = 0; load < 3; load += 1) {
    browser.advance(10_000);
    const signedIn = await browser.load(200);
    expect(signedIn.state.drawn()?.environments.length).toBeGreaterThan(1);
    expect(browser.session.values.has(reentryKey)).toBe(true);
    expect(browser.reentry().refused()).toBe(false);
  }
  expect(browser.navigations).toHaveLength(1);
  // A separate expiry after the guard re-enters again, once.
  browser.advance(reentryGuardMs);
  expect(browser.reentry().refused()).toBe(true);
  expect(browser.navigations).toHaveLength(2);
  expect(browser.reentry().refused()).toBe(false);
  expect(browser.navigations).toHaveLength(2);
});

test("a refusal after a transient failure re-enters too, and the read stops there", async () => {
  const browser = tab();
  const page = await browser.load(503, 401, 200);
  expect(page.calls()).toBe(2);
  expect(browser.navigations).toHaveLength(1);
  expect(page.value).toBeNull();
});

test("Apps shares the page's read: a re-entry is one navigation for the rail and Apps together", async () => {
  const browser = tab();
  let calls = 0;
  const shared = readAccountJson(
    async () => {
      calls += 1;
      return answer(401);
    },
    100,
    quiet,
    browser.origin,
    [0],
    browser.reentry(),
  );
  const state = createShellState({
    source: () => "origin",
    read: () => shared,
    report: quiet,
    store: browser.origin,
  });
  state.provideShell(local);
  state.requestAccount();
  expect(await readAccount(() => shared)).toBeNull();
  expect(calls).toBe(1);
  expect(browser.navigations).toHaveLength(1);
});

test("without a tab memory, or with one that fails, nothing navigates: the refusal stays final", async () => {
  const navigations: string[] = [];
  const navigate = () => navigations.push("navigate");
  expect(createReentry(null, navigate).refused()).toBe(false);
  const failing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(createReentry(failing, navigate).refused()).toBe(false);
  const full = { ...spyStore(), setItem: failing.setItem };
  expect(createReentry(full, navigate).refused()).toBe(false);
  expect(navigations).toEqual([]);
  // Through the read: the remembered account goes, as before.
  const origin = spyStore();
  rememberAccount(person, "ada", origin);
  await readAccountJson(
    async () => answer(401),
    100,
    quiet,
    origin,
    [0],
    createReentry(null, navigate),
  );
  expect(origin.values.has(accountCacheKey)).toBe(false);
  expect(navigations).toEqual([]);
});

test("a guard that is unreadable or from a later clock does not block a re-entry", () => {
  const now = 1_700_000_000_000;
  for (const kept of ["not a time", String(now + 60_000)]) {
    const session = spyStore();
    session.values.set(reentryKey, kept);
    let navigations = 0;
    const reentry = createReentry(
      session,
      () => {
        navigations += 1;
      },
      () => now,
    );
    expect([kept, reentry.refused(), navigations]).toEqual([kept, true, 1]);
    expect([kept, reentry.refused(), navigations]).toEqual([kept, false, 1]);
  }
});

test("one guard per tab: the Launchpad's denial right after the account's re-entry does not navigate again", () => {
  const session = spyStore();
  let navigations = 0;
  const navigate = () => {
    navigations += 1;
  };
  const account = createReentry(session, navigate, () => 1_000);
  const launchpad = createReentry(session, navigate, () => 2_000);
  expect(account.refused()).toBe(true);
  expect(launchpad.refused()).toBe(false);
  expect(navigations).toBe(1);
});

test("what counts as a refused session: a 401, or the sign-in redirect a manual request sees", () => {
  expect(sessionRefused({ status: 401, type: "basic" })).toBe(true);
  expect(sessionRefused({ status: 0, type: "opaqueredirect" })).toBe(true);
  for (const [status, type] of [
    [200, "basic"],
    [403, "basic"],
    [404, "basic"],
    [503, "basic"],
    [0, "error"],
  ] as const)
    expect([status, type, sessionRefused({ status, type })]).toEqual([
      status,
      type,
      false,
    ]);
});

// The browser's default: the tab's `sessionStorage` and a reload, for the
// top-level page only.
const scope = globalThis as { window?: unknown };
afterEach(() => {
  delete scope.window;
});

function browserWindow(framed: boolean) {
  const session = spyStore();
  const reloads: string[] = [];
  const self = {};
  scope.window = {
    self,
    top: framed ? {} : self,
    sessionStorage: session,
    location: { reload: () => reloads.push("reload") },
  };
  return { session, reloads };
}

test("in a browser, the top-level page re-enters by reloading itself, once", () => {
  const { session, reloads } = browserWindow(false);
  expect(pageReentry().refused()).toBe(true);
  expect(pageReentry().refused()).toBe(false);
  expect(reloads).toEqual(["reload"]);
  expect(session.values.has(reentryKey)).toBe(true);
});

test("a framed page never re-enters: the sign-in would land in its frame", () => {
  const { session, reloads } = browserWindow(true);
  expect(pageReentry().refused()).toBe(false);
  expect(reloads).toEqual([]);
  expect(session.calls).toEqual([]);
});
