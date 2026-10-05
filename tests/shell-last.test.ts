import { afterEach, expect, test } from "bun:test";
import { parseShell, type Shell } from "../src/shell/contract";
import {
  appOf,
  createLastReport,
  lastPath,
  lastVisit,
} from "../src/shell/last";

// Root decision 0185 S8: once per full page load of Apps, Chat or Automate
// the shell library tells the person's account where they are
// (`PUT /.lazurio/account/last`): fire and forget, silent on failure, never
// blocking the page. Its own module (src/shell/last.ts), apart from the
// rail's merge of the account's Environments.

const shell = parseShell({
  schema: "lazurio.shell.v1",
  locale: "cs",
  current: "vm-01.example",
  operator: { initials: null, login: null, avatar: null },
  environments: [
    {
      id: "vm-01.example",
      label: "Team Sales",
      kind: "team",
      organizations: ["example"],
      assignee: null,
      apps: {
        apps: "https://launchpad.vm-01.example.lazurio.io/",
        chat: "https://t3code.vm-01.example.lazurio.io/",
        automate: null,
      },
    },
  ],
  organizations: [
    {
      slug: "example",
      name: "Example Company",
      avatar: null,
      dashboard: "https://dashboard.lazurio.ai/orgs/example",
    },
  ],
  dashboard: "https://dashboard.lazurio.ai/",
  account: "https://dashboard.lazurio.ai/settings",
  addOrganization: null,
}) as Shell;

test("what a page reports: this Environment as the document names it, the app and the space's Organization slug", () => {
  expect(shell).not.toBeNull();
  expect(lastVisit(shell, "chat", "example")).toEqual({
    environment: "vm-01.example",
    app: "chat",
    organization: "example",
  });
  // By the document's own slug, whatever case the host named it in.
  expect(lastVisit(shell, "apps", "EXAMPLE")?.organization).toBe("example");
  expect(lastVisit(shell, "apps", "personal")?.organization).toBeNull();
  expect(lastVisit(shell, "apps", "unknown")?.organization).toBeNull();
});

test("the app an element names: Chat, Apps or Automate; Settings and nothing are none", () => {
  expect(appOf("chat")).toBe("chat");
  expect(appOf("apps")).toBe("apps");
  expect(appOf("automate")).toBe("automate");
  expect(appOf("settings")).toBeNull();
  expect(appOf(null)).toBeNull();
  expect(appOf("Chat")).toBeNull();
});

test("once per page load, and only once an app is known", async () => {
  const sent: string[] = [];
  const report = createLastReport(async (body) => {
    sent.push(body);
  });
  report(shell, null, "example");
  expect(sent).toEqual([]);
  report(shell, "apps", "example");
  report(shell, "chat", "example");
  report(shell, "apps", "example");
  expect(sent.map((body) => JSON.parse(body))).toEqual([
    { environment: "vm-01.example", app: "apps", organization: "example" },
  ]);
});

test("a failure is silent: a refused or broken report never reaches the page", async () => {
  const rejected = createLastReport(() =>
    Promise.reject(new TypeError("offline")),
  );
  expect(() => rejected(shell, "apps", "example")).not.toThrow();
  const throwing = createLastReport(() => {
    throw new Error("no fetch");
  });
  expect(() => throwing(shell, "apps", "example")).not.toThrow();
  // Give a rejected promise its turn: nothing is left unhandled.
  await new Promise((done) => setTimeout(done, 0));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the report is a same-origin PUT that outlives the page, and its answer is not read", async () => {
  const seen: { input: unknown; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push({ input, init });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  createLastReport()(shell, "automate", "example");
  await new Promise((done) => setTimeout(done, 0));
  expect(seen).toHaveLength(1);
  expect(seen[0]?.input).toBe(lastPath);
  expect(seen[0]?.input).toBe("/.lazurio/account/last");
  expect(seen[0]?.init?.method).toBe("PUT");
  expect(seen[0]?.init?.credentials).toBe("same-origin");
  expect(seen[0]?.init?.keepalive).toBe(true);
  expect(new Headers(seen[0]?.init?.headers).get("content-type")).toBe(
    "application/json",
  );
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    environment: "vm-01.example",
    app: "automate",
    organization: "example",
  });
});
