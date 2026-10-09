import { expect, test } from "bun:test";
import {
  parseShell,
  parseShellSignedOut,
  type Shell,
} from "../src/shell/contract";
import {
  createGuideRegistration,
  type ServiceWorkers,
} from "../src/shell/offline-guide";
import { escapeHtml, renderOfflineGuide } from "../src/shell/offline-page";
import { OFFLINE_WORKER_PATH } from "../src/shell/offline-policy";
import { createShellState } from "../src/shell/state";

// Decision F41: the shell registers the offline guide's worker where the
// Environment's document says it keeps the guide, once per page load, and
// checks it for an update at the same time, so a changed worker reaches the
// browser on the next load. Where it keeps no guide (any more), the shell
// registers nothing and only checks the guide's worker registered before: its
// address then serves the retiring worker. The Dashboard never acts.

const appsOf = (id: string, kind: string) => {
  if (kind === "workstation") return { apps: "/", chat: null, automate: null };
  return {
    apps: `https://launchpad.${id}.lazurio.io/`,
    chat: `https://t3code.${id}.lazurio.io/`,
    automate: null,
  };
};

const documentOf = (current: string | null, kind = "work") => ({
  schema: "lazurio.shell.v1",
  locale: "cs",
  current,
  operator: { initials: "MS", login: "example-person", avatar: null },
  environments:
    current === null
      ? []
      : [
          {
            id: current,
            label: null,
            kind,
            organizations:
              kind === "personal" || kind === "workstation" ? [] : ["example"],
            assignee: null,
            apps: appsOf(current, kind),
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
  dashboard: "https://dashboard.lazurio.ai/home",
  account: "https://dashboard.lazurio.ai/settings/account",
  addOrganization: "https://dashboard.lazurio.ai/add-organization",
});

const shellOf = (
  current: string | null,
  options: { kind?: string; guide?: boolean } = {},
): Shell => {
  const shell = parseShell({
    ...documentOf(current, options.kind),
    ...(options.guide ? { offlineGuide: true } : {}),
  });
  if (shell === null) throw new Error("invalid fixture");
  return shell;
};

/** The browser's service workers, with one registration found or none. */
const spyWorkers = (found?: string) => {
  const calls: unknown[][] = [];
  const looked: string[] = [];
  let updates = 0;
  const registration = (script: string) => ({
    active: { scriptURL: script },
    update: async () => {
      updates += 1;
    },
  });
  const workers: ServiceWorkers = {
    register: async (url, options) => {
      calls.push([url, options]);
      return registration(`https://launchpad.vm-01.example.lazurio.io${url}`);
    },
    getRegistration: async (scope) => {
      looked.push(scope);
      return found === undefined ? undefined : registration(found);
    },
  };
  return { workers, calls, looked, updates: () => updates };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("`offlineGuide` in lazurio.shell.v1: optional and additive, kept when true, refused in another shape or without a current Environment", () => {
  const document = documentOf("vm-01.example");
  expect(parseShell(document)?.offlineGuide).toBeUndefined();
  expect(parseShell({ ...document, offlineGuide: true })?.offlineGuide).toBe(
    true,
  );
  expect(parseShell({ ...document, offlineGuide: false })).not.toBeNull();
  expect(
    parseShell({ ...document, offlineGuide: false })?.offlineGuide,
  ).toBeUndefined();
  for (const wrong of ["true", 1, null, {}])
    expect(parseShell({ ...document, offlineGuide: wrong })).toBeNull();
  expect(parseShell({ ...documentOf(null), offlineGuide: true })).toBeNull();
  expect(parseShell({ ...documentOf(null), offlineGuide: false })).toBeNull();
});

test("where the Environment keeps the guide: the worker is registered at its one address for the whole origin, without the HTTP cache, and checked for an update", async () => {
  const spy = spyWorkers();
  createGuideRegistration(spy.workers)(
    shellOf("vm-01.example", { guide: true }),
  );
  await settle();
  expect(spy.calls).toEqual([
    [OFFLINE_WORKER_PATH, { scope: "/", updateViaCache: "none" }],
  ]);
  expect(spy.looked).toEqual([]);
  expect(spy.updates()).toBe(1);
});

test("where it keeps no guide: nothing is registered, and only the guide's worker registered before is checked, which its address now retires", async () => {
  const before = spyWorkers(
    `https://launchpad.vm-01.example.lazurio.io${OFFLINE_WORKER_PATH}`,
  );
  createGuideRegistration(before.workers)(shellOf("vm-01.example"));
  await settle();
  expect(before.calls).toEqual([]);
  expect(before.looked).toEqual(["/"]);
  expect(before.updates()).toBe(1);

  // None registered: nothing to check, and no load registers one just to
  // remove it.
  const none = spyWorkers();
  createGuideRegistration(none.workers)(shellOf("vm-01.example"));
  await settle();
  expect([none.calls, none.updates()]).toEqual([[], 0]);

  // Another worker of the origin is never touched.
  const other = spyWorkers("https://launchpad.vm-01.example.lazurio.io/sw.js");
  createGuideRegistration(other.workers)(shellOf("vm-01.example"));
  await settle();
  expect([other.calls, other.updates()]).toEqual([[], 0]);
});

test("a page that belongs to no Environment never acts, and a page acts once, whatever documents follow", async () => {
  const dashboard = spyWorkers(
    `https://dashboard.lazurio.ai${OFFLINE_WORKER_PATH}`,
  );
  createGuideRegistration(dashboard.workers)(shellOf(null));
  await settle();
  expect([dashboard.calls, dashboard.looked, dashboard.updates()]).toEqual([
    [],
    [],
    0,
  ]);

  const spy = spyWorkers();
  const register = createGuideRegistration(spy.workers);
  register(shellOf("vm-01.example", { guide: true }));
  register(shellOf("vm-01.example", { guide: true }));
  register(shellOf("vm-01.example"));
  await settle();
  expect(spy.calls.length).toBe(1);
  expect(spy.looked).toEqual([]);
});

test("a browser without service workers, or a failing registration, leaves the page as it is", async () => {
  createGuideRegistration(null)(shellOf("vm-01.example", { guide: true }));
  const failing = createGuideRegistration({
    register: async () => {
      throw new Error("refused");
    },
    getRegistration: async () => {
      throw new Error("refused");
    },
  });
  expect(() =>
    failing(shellOf("vm-01.example", { guide: true })),
  ).not.toThrow();
  await settle();
});

test("the shell's state asks the registration with a person's document, never with the signed-out one", () => {
  const asked: (string | null)[] = [];
  const state = createShellState({
    source: () => "origin",
    read: async () => null,
    report: () => undefined,
    store: null,
    log: () => undefined,
    guide: (shell) => asked.push(shell.current),
  });
  const signedOut = parseShellSignedOut({
    schema: "lazurio.shell-signed-out.v1",
    locale: "cs",
    signIn: "https://dashboard.lazurio.ai/sign-in",
  });
  if (signedOut === null) throw new Error("invalid fixture");
  state.provideShell(signedOut);
  expect(asked).toEqual([]);
  state.provideShell(shellOf("vm-01.example", { guide: true }));
  expect(asked).toEqual(["vm-01.example"]);
});

test("the guide page names the Environment, its Organization and the tailnet, escaped", () => {
  const page = renderOfflineGuide({
    locale: "cs",
    environment: "Team <Sales>",
    organization: "Acme & Co",
    tailnet: "headscale.example.lazurio.io",
    docs: "https://documentation.lazurio.ai/cs/guide/tailscale/",
    dashboard: "https://dashboard.lazurio.ai/home",
  });
  expect(page).toContain("Team &lt;Sales&gt;");
  expect(page).toContain("Acme &amp; Co");
  expect(page).toContain("headscale.example.lazurio.io");
  expect(page).toContain(
    "https://documentation.lazurio.ai/cs/guide/tailscale/",
  );
  expect(page).not.toContain("<Sales>");
  // It stands alone: nothing is loaded from the network.
  expect(page).not.toMatch(/<(link|img)\b|\ssrc="|url\((?!#)/);
  // No status line once connected (Admin, 2026-10-09): the page reloads at
  // once into the Environment.
  expect(page).not.toContain("Připojeno");
  expect(page).not.toContain('class="status"');
  expect(page).toContain(".then(function(){location.reload()}");
  expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
});

test("the guide page leads back to the Dashboard without the tailnet: the rail's logo and a button", () => {
  const input = {
    locale: "cs" as const,
    environment: "Team",
    organization: "Example",
    tailnet: "headscale.example.lazurio.io",
    docs: "https://documentation.lazurio.ai/cs/guide/tailscale/",
  };
  const page = renderOfflineGuide({
    ...input,
    dashboard: "https://dashboard.lazurio.ai/home?x=1&y=2",
  });
  const href = 'href="https://dashboard.lazurio.ai/home?x=1&amp;y=2"';
  expect(page).toContain(
    `<nav class="rail" aria-label="Lazurio"><a class="home" ${href}`,
  );
  expect(page).toContain(`<a class="back" ${href}>`);
  expect(page).toContain("Zpět do Dashboardu");
  expect(
    renderOfflineGuide({
      ...input,
      locale: "en",
      dashboard: "https://dashboard.lazurio.ai/home",
    }),
  ).toContain("Back to the Dashboard");
  // Only an https address: none, a path on the unreachable origin or another
  // scheme draws the logo without a link and no way back.
  for (const dashboard of [
    null,
    "/home",
    "javascript:alert(1)",
    "http://dashboard.lazurio.ai/home",
  ]) {
    const without = renderOfflineGuide({ ...input, dashboard });
    expect(without).toContain(
      '<nav class="rail" aria-label="Lazurio"><span class="home">',
    );
    expect(without).not.toContain('class="back"');
    expect(without).not.toContain("Zpět do Dashboardu");
  }
});
