import { expect, test } from "bun:test";
import { readAccount } from "../src/launchpad/account";
import {
  accountCacheKey,
  accountReadHeaders,
  cachedAccountFor,
  readAccountJson,
  rememberAccount,
} from "../src/shell/account";
import {
  parseShell,
  parseShellAccount,
  parseShellSignedOut,
  type Shell,
  type ShellAccount,
} from "../src/shell/contract";
import { shellMessages } from "../src/shell/messages";
import { createShellState } from "../src/shell/state";
import { environmentName } from "../src/shell/view";
import { accountDocument } from "./fixtures/account-document";

// F37's addendum of 2026-11-03: the page asks for the person's account in
// the Environment's language. The Dashboard words `name` and `who` by
// `Accept-Language`; the browser's own header is the language of its
// interface, so a browser in English on a Czech Environment got English
// words, the merge dropped them as another language's (merge.ts) and the
// switcher named the Organization's server services only by their kind.
// Example names only.

const cs = shellMessages("cs");
const quiet = () => {};
const noReentry = { refused: () => false };

// Ada's own work Environment of the example Organization, in Czech.
const czechWork = (extra: Record<string, unknown> = {}): Shell => {
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: "vm-03.example",
    operator: { initials: "A", login: "ada", avatar: null },
    environments: [
      {
        id: "vm-03.example",
        label: null,
        kind: "work",
        organizations: ["example"],
        assignee: "ada",
        apps: {
          apps: "https://launchpad.vm-03.example.lazurio.io/",
          chat: null,
          automate: null,
        },
      },
    ],
    organizations: [
      {
        slug: "example",
        name: "Example Works",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/example",
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/",
    account: "https://dashboard.lazurio.ai/settings",
    addOrganization: "https://dashboard.lazurio.ai/add-organization",
    ...extra,
  });
  if (shell === null) throw new Error("Expected a valid shell document");
  return shell;
};

// The Organization's server services: a work Environment that belongs to no
// person, named by the Dashboard in the language it is asked in.
const services = "services.example";
const servicesEntry = (language: "cs" | "en") => ({
  id: services,
  kind: "work",
  label: null,
  name: language === "cs" ? "Služby serveru" : "Server services",
  who: language === "cs" ? "pro celou Organizaci" : "for the Organization",
  offline: false,
  organizations: ["example"],
  assignee: null,
  apps: {
    apps: "https://launchpad.services.example.lazurio.io/",
    chat: null,
    automate: null,
  },
});

/** The account as the Dashboard answers it: in Czech for `cs`, else in
 * English (its fallback), as `Accept-Language` asks. */
const answerIn = (language: string | null) => {
  const czech = language === "cs";
  const document = accountDocument({ locale: czech ? "cs" : "en" });
  return {
    ...document,
    environments: [
      ...document.environments,
      servicesEntry(czech ? "cs" : "en"),
    ],
  };
};
const parsedIn = (language: "cs" | "en"): ShellAccount => {
  const read = parseShellAccount(answerIn(language));
  if (read === null) throw new Error("Expected a valid account document");
  return read;
};

/** A Dashboard behind the relay that words the account by the request's
 * `Accept-Language`, recording what each request asked; the browser's own
 * header, which the page cannot read, stands for English. */
const dashboard = () => {
  const asked: (string | null)[] = [];
  const fetcher = async (_path: string, init: RequestInit) => {
    const language = new Headers(init.headers).get("accept-language");
    asked.push(language);
    return new Response(JSON.stringify(answerIn(language ?? "en")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { asked, fetcher };
};

const memoryStore = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

const stateOver = (
  fetcher: (path: string, init: RequestInit) => Promise<Response>,
  store: ReturnType<typeof memoryStore> | null = null,
) =>
  createShellState({
    source: () => "origin",
    read: (language) =>
      readAccountJson(fetcher, 1_000, quiet, store, [], noReentry, language),
    report: quiet,
    store,
    log: quiet,
  });

const settled = () => new Promise((done) => setTimeout(done, 10));
const nameOf = (shell: Shell | null, id: string) => {
  const entry = shell?.environments.find(
    (environment) => environment.id === id,
  );
  return entry === undefined ? undefined : environmentName(entry, cs);
};

test("the account read asks in the language it is given, and only then overrides the browser's", () => {
  expect(accountReadHeaders("cs")).toEqual({
    Accept: "application/json",
    "Accept-Language": "cs",
  });
  expect(accountReadHeaders("en")).toEqual({
    Accept: "application/json",
    "Accept-Language": "en",
  });
  // Without a language the browser's own header goes, as before.
  expect(accountReadHeaders(null)).toEqual({ Accept: "application/json" });
});

test("on a Czech Environment the switcher names the Organization's server services in Czech, whatever the browser's language", async () => {
  const { asked, fetcher } = dashboard();
  const state = stateOver(fetcher);
  // The elements connect before the page's document is there (a fork reads
  // it on its own): the read waits for its language.
  state.requestAccount();
  await settled();
  expect(asked).toEqual([]);
  state.provideShell(czechWork());
  await settled();
  expect(asked).toEqual(["cs"]);
  expect(nameOf(state.drawn(), services)).toBe("Služby serveru");
  // Asked once per page, whatever comes later.
  state.provideShell(czechWork({ locale: "en" }));
  state.requestAccount();
  await settled();
  expect(asked).toEqual(["cs"]);
});

test("a page that hands its document over first reads at once, in its language", async () => {
  const { asked, fetcher } = dashboard();
  const state = stateOver(fetcher);
  state.provideShell(czechWork({ locale: "en" }));
  state.requestAccount();
  await settled();
  expect(asked).toEqual(["en"]);
  expect(nameOf(state.drawn(), services)).toBe("Server services");
});

test("the signed-out document names the language too", async () => {
  const { asked, fetcher } = dashboard();
  const state = stateOver(fetcher);
  const signedOut = parseShellSignedOut({
    schema: "lazurio.shell-signed-out.v1",
    locale: "cs",
    signIn: "/sign-in",
  });
  if (signedOut === null) throw new Error("Expected a signed-out document");
  state.requestAccount();
  state.provideShell(signedOut);
  await settled();
  expect(asked).toEqual(["cs"]);
});

test("a host that provides the account still reads nothing", async () => {
  const { asked, fetcher } = dashboard();
  const state = createShellState({
    source: () => "host",
    read: (language) =>
      readAccountJson(fetcher, 1_000, quiet, null, [], noReentry, language),
    report: quiet,
    store: null,
    log: quiet,
  });
  state.requestAccount();
  state.provideShell(czechWork());
  await settled();
  expect(asked).toEqual([]);
});

test("an account remembered in another language draws its structure at once, unnamed, until the fresh answer in the Environment's language names it", async () => {
  const store = memoryStore();
  // What the page kept before this change: the English answer.
  rememberAccount(parsedIn("en"), "ada", store);
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const { asked, fetcher } = dashboard();
  const state = stateOver(async (path, init) => {
    await gate;
    return fetcher(path, init);
  }, store);
  state.provideShell(czechWork());
  state.requestAccount();
  // At once: the remembered account's Environments, named by their kind in
  // Czech, never with its English words, never dropped.
  expect(nameOf(state.drawn(), services)).toBe("Pracovní");
  expect(nameOf(state.drawn(), "vm-01.example")).toBe("Sales");
  release();
  await settled();
  expect(asked).toEqual(["cs"]);
  expect(nameOf(state.drawn(), services)).toBe("Služby serveru");
  // The fresh Czech answer replaces what this origin remembered.
  expect(cachedAccountFor("ada", store)?.locale).toBe("cs");
  expect(store.values.get(accountCacheKey)).toContain("Služby serveru");
});

test("Apps shares the page's one read, asked in the same language", async () => {
  const { asked, fetcher } = dashboard();
  const shared = readAccountJson(
    fetcher,
    1_000,
    quiet,
    null,
    [],
    noReentry,
    "cs",
  );
  const state = createShellState({
    source: () => "origin",
    read: () => shared,
    report: quiet,
    store: null,
    log: quiet,
  });
  state.provideShell(czechWork());
  state.requestAccount();
  expect(await readAccount(() => shared)).not.toBeNull();
  await settled();
  expect(asked).toEqual(["cs"]);
  expect(nameOf(state.drawn(), services)).toBe("Služby serveru");
});

test("a page whose document never comes still reads the account, without a language, so a refused session re-enters the Environment", async () => {
  // A fork's page whose gateway session expired between the page load and
  // `/.lazurio/shell.json`: the document read is refused, and the account's
  // own `401` is what reloads the page to sign in again.
  const asked: (string | null)[] = [];
  let reentered = 0;
  const state = createShellState({
    source: () => "origin",
    read: (language) =>
      readAccountJson(
        async (_path, init) => {
          const headers = (init.headers ?? {}) as Record<string, string>;
          asked.push(headers["Accept-Language"] ?? null);
          return new Response(null, { status: 401 });
        },
        1_000,
        quiet,
        null,
        [],
        {
          refused: () => {
            reentered += 1;
            return true;
          },
        },
        language,
      ),
    report: quiet,
    log: quiet,
  });
  state.requestAccount();
  await settled();
  expect(asked).toEqual([]);
  state.documentUnavailable();
  await settled();
  expect(asked).toEqual([null]);
  expect(reentered).toBe(1);
  // One read per page, whatever comes later.
  state.documentUnavailable();
  state.provideShell(czechWork());
  await settled();
  expect(asked).toEqual([null]);
});

test("a document read that fails after the page has its document reads nothing more", async () => {
  const { asked, fetcher } = dashboard();
  const state = stateOver(fetcher);
  state.provideShell(czechWork());
  state.documentUnavailable();
  state.requestAccount();
  await settled();
  expect(asked).toEqual(["cs"]);
});
