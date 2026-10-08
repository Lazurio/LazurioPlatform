import { expect, test } from "bun:test";
import {
  parseShell,
  parseShellSignedOut,
  type Shell,
} from "../src/shell/contract";
import {
  createGuideRegistration,
  guidesHere,
  type RegisterWorker,
} from "../src/shell/offline-guide";
import { escapeHtml, renderOfflineGuide } from "../src/shell/offline-page";
import { OFFLINE_WORKER_PATH } from "../src/shell/offline-policy";
import { createShellState } from "../src/shell/state";

// Decision F41: the shell registers the offline guide's worker on an
// Environment's own page, once per page load, and checks it for an update at
// the same time, so a changed worker reaches the browser on the next load.
// The Dashboard and a workstation never register one.

const appsOf = (id: string, kind: string) => {
  if (kind === "workstation") return { apps: "/", chat: null, automate: null };
  return {
    apps: `https://launchpad.${id}.lazurio.io/`,
    chat: `https://t3code.${id}.lazurio.io/`,
    automate: null,
  };
};

const shellOf = (current: string | null, kind = "work"): Shell => {
  const shell = parseShell({
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
                kind === "personal" || kind === "workstation"
                  ? []
                  : ["example"],
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
  if (shell === null) throw new Error("invalid fixture");
  return shell;
};

const spyRegister = () => {
  const calls: unknown[][] = [];
  let updates = 0;
  const register: RegisterWorker = async (url, options) => {
    calls.push([url, options]);
    return {
      update: async () => {
        updates += 1;
      },
    };
  };
  return { register, calls, updates: () => updates };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("only an Environment's own page guides: never the Dashboard, never a workstation", () => {
  expect(guidesHere(shellOf("vm-01.example"))).toBe(true);
  expect(guidesHere(shellOf("example-person", "personal"))).toBe(true);
  expect(guidesHere(shellOf(null))).toBe(false);
  expect(guidesHere(shellOf("local", "workstation"))).toBe(false);
});

test("the worker is registered at its one address for the whole origin, without the HTTP cache, and checked for an update", async () => {
  const spy = spyRegister();
  const register = createGuideRegistration(spy.register);
  register(shellOf("vm-01.example"));
  await settle();
  expect(spy.calls).toEqual([
    [OFFLINE_WORKER_PATH, { scope: "/", updateViaCache: "none" }],
  ]);
  expect(spy.updates()).toBe(1);
});

test("one registration per page load, whatever documents follow", async () => {
  const spy = spyRegister();
  const register = createGuideRegistration(spy.register);
  register(shellOf(null));
  register(shellOf("local", "workstation"));
  register(shellOf("vm-01.example"));
  register(shellOf("vm-01.example"));
  await settle();
  expect(spy.calls.length).toBe(1);
});

test("a browser without service workers, or a failing registration, leaves the page as it is", async () => {
  createGuideRegistration(null)(shellOf("vm-01.example"));
  const failing = createGuideRegistration(async () => {
    throw new Error("refused");
  });
  expect(() => failing(shellOf("vm-01.example"))).not.toThrow();
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
  state.provideShell(shellOf("vm-01.example"));
  expect(asked).toEqual(["vm-01.example"]);
});

test("the guide page names the Environment, its Organization and the tailnet, escaped", () => {
  const page = renderOfflineGuide({
    locale: "cs",
    environment: "Team <Sales>",
    organization: "Acme & Co",
    tailnet: "headscale.example.lazurio.io",
    docs: "https://documentation.lazurio.ai/cs/guide/tailscale/",
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
  expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
});
