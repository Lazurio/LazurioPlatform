import { expect, test } from "bun:test";
import { readAccount } from "../src/launchpad/account";
import {
  accountCacheKey,
  readAccountJson,
  rememberAccount,
} from "../src/shell/account";
import { parseShell, parseShellAccount } from "../src/shell/contract";
import { createShellState } from "../src/shell/state";
import { accountDocument } from "./fixtures/account-document";
import { spyStore } from "./fixtures/shell-state";

const quiet = () => {};
const answer = (status: number) =>
  new Response(JSON.stringify(accountDocument()), { status });
const local = parseShell({
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

test("a first account read recovers for both the rail and Apps without reloading", async () => {
  let calls = 0;
  const shared = readAccountJson(
    async () => answer(++calls === 1 ? 503 : 200),
    100,
    quiet,
    null,
    [0],
  );
  const state = createShellState({
    source: () => "origin",
    read: () => shared,
    report: quiet,
    store: null,
  });
  expect(local).not.toBeNull();
  if (local === null) throw new Error("Invalid local fixture");
  state.provideShell(local);
  state.requestAccount();
  state.requestAccount();
  expect(state.drawn()?.environments).toHaveLength(1);
  const apps = await readAccount(() => shared);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(apps).not.toBeNull();
  expect(state.drawn()?.environments.length).toBeGreaterThan(1);
  expect(calls).toBe(2);
});

test("a timed out request is aborted and a later attempt recovers", async () => {
  let calls = 0;
  let aborted = false;
  const read = await readAccountJson(
    (_path, init) => {
      if (++calls > 1) return Promise.resolve(answer(200));
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }),
      );
    },
    10,
    quiet,
    null,
    [0],
  );
  expect(aborted).toBe(true);
  expect(parseShellAccount(read)).not.toBeNull();
  expect(calls).toBe(2);
});

test("temporary network and server failures recover, but the retry budget is finite", async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    let calls = 0;
    expect(
      await readAccountJson(
        async () => answer(++calls < 3 ? status : 200),
        100,
        quiet,
        null,
        [0, 0],
      ),
    ).not.toBeNull();
    expect(calls).toBe(3);
  }
  let calls = 0;
  const lines: string[] = [];
  expect(
    await readAccountJson(
      async () => {
        calls++;
        throw new TypeError("network unavailable");
      },
      100,
      (line) => lines.push(line),
      null,
      [0, 0],
    ),
  ).toBeNull();
  expect(calls).toBe(3);
  expect(lines).toHaveLength(1);
});

test("a refusal stops recovery immediately and clears the remembered account", async () => {
  for (const status of [401, 403, 404]) {
    const store = spyStore();
    const account = parseShellAccount(accountDocument());
    if (account === null) throw new Error("Invalid account fixture");
    rememberAccount(account, account.operator.login, store);
    expect(store.values.has(accountCacheKey)).toBe(true);
    let calls = 0;
    expect(
      await readAccountJson(
        async () => answer(++calls === 1 ? 503 : status),
        100,
        quiet,
        store,
        [0, 0],
      ),
    ).toBeNull();
    expect(calls).toBe(2);
    expect(store.values.has(accountCacheKey)).toBe(false);
  }
});

test("other client errors and malformed success are terminal", async () => {
  for (const response of [
    answer(400),
    answer(429),
    new Response("<html>sign in</html>"),
  ]) {
    let calls = 0;
    expect(
      await readAccountJson(
        async () => {
          calls++;
          return response;
        },
        100,
        quiet,
        null,
        [0, 0],
      ),
    ).toBeNull();
    expect(calls).toBe(1);
  }
});
