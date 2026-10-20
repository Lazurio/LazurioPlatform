import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import {
  type PresetName,
  presetNames,
  presetProfile,
  selectablePresets,
  tryPreset,
} from "../src/folder/presets";
import { refreshFolder } from "../src/folder/update-profile";
import { bootElementId, parseBoot } from "../src/launchpad/boot";
import { vaultInAppsOf } from "../src/launchpad/boot-document";
import { pageGuide, vaultAgentsGuide } from "../src/launchpad/guides";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import {
  publicRoute,
  withheldInPublic,
} from "../src/launchpad/public-environment";
import { pageRoute } from "../src/launchpad/routes";
import { startLaunchpad } from "../src/launchpad/server";
import { presetKinds } from "../src/launchpad/shell-document";
import {
  bitwardenTarget,
  parseVaultMembership,
  parseVaultPage,
  type VaultPageModel,
  type VaultPagePerson,
  vaultInApps,
  vaultListed,
  vaultPageView,
} from "../src/launchpad/vault-page-view";
import { machineContextPath } from "../src/machine/context";
import type { HostedOperatorSources } from "../src/machine/operator";
import type { ToolRunner } from "../src/tools/status";
import type { VaultUnsupportedReason } from "../src/vault/context";
import { processVaultHost } from "../src/vault/host";
import { ownContext } from "./fixtures/fake-vault";
import { binding } from "./fixtures/machine-bindings";
import services from "./fixtures/machine-context-services.json";
import { freePort } from "./fixtures/ports";
import {
  bobHandover,
  stewardHandover,
  teamHandover,
  tryCases,
  tryHandover,
} from "./fixtures/try-environments";

// Plan DEV-6668 slice 6 (Lazurio/LazurioPlatform#499; root decision 0204's
// addendum of 2026-10-20, EX-0014 D32/D35/D41): on a public Environment the
// vault follows the vault core instead of being always withheld. Trezor (its
// page, its item in the Apps column and its API) is there only where the
// core answers this Environment's own vault, which is the handover's `vault`;
// without it everything stays withheld as before. That vault is a Team
// Environment's whatever preset the Folder recorded: it adds no visitor, and
// its "?" plays `vault-agents`. Checked on try-01 as Machines writes it, its
// Folder recorded as Work and as Team, without and with `vault`, and on four
// controls that are not public. Example names only.

const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? -1;
const signedOut: ToolRunner = async () => ({
  exitCode: 1,
  stdout: "",
  stderr: "You are not logged into any GitHub hosts.",
});

// --- The rules -----------------------------------------------------------

test("the Try overlay still withholds only Integrace and Nástroje: the vault is not in its record", () => {
  expect(tryPreset.withheld).toEqual(["integrations", "tools"]);
});

const unsupportedReasons: readonly VaultUnsupportedReason[] = [
  "workstation",
  "folder-unreadable",
  "handover-missing",
  "handover-unreadable",
  "not-operator",
  "no-vault",
  "no-tailnet",
  "connection-unreadable",
];

test("on a public Environment the Apps column lists Trezor only where the vault core answers its own vault, never on a fault", () => {
  expect(vaultListed(ownContext(), true)).toBe(true);
  for (const reason of unsupportedReasons)
    expect([
      reason,
      vaultListed({ kind: "unsupported", reason }, true),
    ]).toEqual([reason, false]);
  expect(
    vaultListed({ kind: "needs-connection", name: "Osobní example" }, true),
  ).toBe(false);
  // Elsewhere the rule is what it was: a fault keeps the item.
  expect(vaultListed({ kind: "unsupported", reason: "handover-missing" })).toBe(
    true,
  );
  expect(vaultListed({ kind: "unsupported", reason: "no-tailnet" })).toBe(
    false,
  );
});

test("a public page draws what the server decided, and without a decision does not list Trezor", () => {
  for (const preset of [...presetNames, null]) {
    expect([preset, vaultInApps(true, preset, true)]).toEqual([preset, true]);
    expect([preset, vaultInApps(false, preset, true)]).toEqual([preset, false]);
    expect([preset, vaultInApps(null, preset, true)]).toEqual([preset, false]);
  }
  // A page that is not public is what it was.
  expect(vaultInApps(null, "hosted-organization-team")).toBe(true);
  expect(vaultInApps(null, "hosted-organization-team", false)).toBe(true);
  expect(vaultInApps(null, "local")).toBe(false);
});

test("where the vault core cannot be read at all, a public Environment does not list Trezor", async () => {
  const host = processVaultHost({
    folder: async () => undefined,
    env: { HOME: "/home/operator", PATH: "/usr/bin" },
    platform: "linux",
    run: signedOut,
  });
  const failing = {
    ...host,
    context: async () => {
      throw new Error("unreadable");
    },
  };
  expect(await vaultInAppsOf(failing, true)).toBe(false);
  // Elsewhere it stays listed, so that the page can say the fault.
  expect(await vaultInAppsOf(failing)).toBe(true);
});

const trezorPaths = [
  "/vault",
  "/vault/requests/abcdefghijklmnopqrstuvwx",
  "/settings/vault",
  "/settings/vault/requests/abcdefghijklmnopqrstuvwx",
];

test("Trezor's routes are withheld only without the vault; Integrace and Nástroje either way", () => {
  for (const path of trezorPaths) {
    expect([path, withheldInPublic(pageRoute(path), { vault: false })]).toEqual(
      [path, true],
    );
    expect([path, publicRoute(pageRoute(path), { vault: false })]).toEqual([
      path,
      { view: "home" },
    ]);
    // A caller that has not read the core gets no vault.
    expect([path, withheldInPublic(pageRoute(path))]).toEqual([path, true]);
    expect([path, withheldInPublic(pageRoute(path), { vault: true })]).toEqual([
      path,
      false,
    ]);
    expect(publicRoute(pageRoute(path), { vault: true })).toEqual(
      pageRoute(path),
    );
  }
  for (const vault of [false, true]) {
    for (const path of ["/integrations", "/integrations/connected"]) {
      expect([path, withheldInPublic(pageRoute(path), { vault })]).toEqual([
        path,
        true,
      ]);
      expect(publicRoute(pageRoute(path), { vault })).toEqual({ view: "home" });
    }
    expect(withheldInPublic(pageRoute("/settings/tools"), { vault })).toBe(
      true,
    );
    expect(publicRoute(pageRoute("/settings/tools"), { vault })).toEqual({
      view: "settings",
      section: "general",
    });
  }
});

// --- What a visitor reads on Trezor --------------------------------------

/** Words that would claim a nightly wipe, which Machines does not do yet
 * (plan slice 7): no app text may say it. */
const nightly = /night|každou noc|noční|wipe|smaž|maže/i;
/** Words that would speak of a visitor's own Bitwarden or vault. */
const personal =
  /your (own )?(bitwarden|vault|account)|own bitwarden|váš|vašeho|vaše|svůj|svého|svém/i;

/** Every text Trezor's page and its "?" show for this model and person. */
function visitorTexts(
  model: VaultPageModel,
  person: VaultPagePerson | null,
  locale: "cs" | "en",
): string[] {
  const copy = messages(locale, "team");
  const view = vaultPageView(model, person, copy);
  return [
    copy.vaultPageTitle,
    view.note ?? "",
    view.row?.title ?? "",
    view.row?.line ?? "",
    view.hint ?? "",
    ...view.actions.map((action) => action.label),
    // Shown under the row once the vault is connected.
    ...(view.guide ? [copy.vaultPageGuide, copy.vaultPageGuideChat] : []),
    ...vaultAgentsGuide(copy).steps.map((step) => step.text),
  ].filter((text) => text !== "");
}

test("a public Environment's vault, connected, shows the agents' rule and nothing of a visitor's own vault or a nightly wipe", () => {
  const status = {
    kind: "vault-status",
    state: "connected",
    vault: "https://vaultwarden.example.lazurio.io",
    account:
      "vaultwarden-tryaaaaaaaaaaaaaaaaaaaaaaaa@try-01.example.lazurio.io",
    name: "Example try 01",
    team: true,
    origin: "own",
    organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
    collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
    organization: "Example try 01",
    items: 3,
  } as const;
  const model: VaultPageModel = {
    status,
    setup: null,
    environment: "team",
    name: null,
  };
  const person: VaultPagePerson = { kind: "unknown", reason: "not-managed" };
  for (const locale of ["cs", "en"] as const) {
    const copy = messages(locale, "team");
    const view = vaultPageView(model, person, copy);
    // No "Vytvořit účet v trezoru", no "Přidat položku": nobody is added.
    expect(view.actions).toEqual([]);
    expect(view.hint).toBe(copy.vaultPageAgentsOnly);
    expect(view.guide).toBe(true);
    // No steps for the visitor's own Bitwarden in Codex Desktop.
    expect(bitwardenTarget(model, person)).toBeNull();
    for (const text of visitorTexts(model, person, locale)) {
      expect([locale, text, nightly.test(text)]).toEqual([locale, text, false]);
      expect([locale, text, personal.test(text)]).toEqual([
        locale,
        text,
        false,
      ]);
    }
  }
});

test("`vault-agents` says what #499 asks of a shared Environment, in both languages", () => {
  expect(
    vaultAgentsGuide(messages("cs", "team")).steps.map((step) => step.text),
  ).toEqual([
    "Toto Týmové Prostředí má vlastní trezor",
    "Agenti z něj berou hesla bez ptaní",
    "Hesla vidí každý v tomto Týmovém Prostředí",
  ]);
  expect(
    vaultAgentsGuide(messages("en", "team")).steps.map((step) => step.text),
  ).toEqual([
    "This Team Environment has its own vault",
    "Agents take passwords from it without asking",
    "Everyone in this Team Environment sees its passwords",
  ]);
});

// --- try-01, read by the production composition ---------------------------

/** One Remote Environment's Machine: its root-issued handover in its place,
 * the Folder its preset records, the operator's system record, and its
 * vault read as `lazurio vault` reads it (`processVaultHost`); only those
 * places are this test's. */
async function machineOf(
  handover: Record<string, unknown>,
  preset: PresetName,
) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "public-vault-")));
  const root = join(parent, "machine");
  await mkdir(root, { mode: 0o755 });
  const file = join(root, machineContextPath);
  await mkdir(dirname(file), { recursive: true, mode: 0o755 });
  await writeFile(file, JSON.stringify(handover), { mode: 0o644 });
  const folder = join(root, "home", "operator", "Lazurio");
  await mkdir(join(folder, "organizations"), { recursive: true, mode: 0o700 });
  const machine = binding(handover);
  const profile = presetProfile(preset, executionOs(process.platform), {
    locale: "cs",
  });
  if (selectablePresets(machine).includes(preset))
    await initializeHandoverFolder(folder, { preset, machine, profile });
  else {
    // A preset the handover does not offer (Work under try-01's Team
    // assignment) has a history, as in tests/try-overlay-preset.test.ts:
    // adopted from an earlier handover without the assignment, then
    // refreshed when the handover stated it, which keeps it.
    const owner = handover.owner as Readonly<Record<string, unknown>>;
    const { assignment: _, ...earlier } = owner;
    await initializeHandoverFolder(folder, {
      preset,
      machine: binding({ ...handover, owner: earlier }),
      profile,
    });
    expect(await refreshFolder(folder, machine)).toEqual({
      kind: "refreshed",
      revision: 2,
    });
  }
  const sources: HostedOperatorSources = {
    handover: { platform: "linux", root, custodian: uid },
    operator: async () =>
      Object.freeze({
        platform: "linux",
        uid: 1000,
        username: "operator",
        homedir: "/home/operator",
      }),
  };
  const vaultHost = processVaultHost({
    folder: async () => folder,
    env: {
      HOME: "/home/operator",
      XDG_STATE_HOME: join(parent, "state"),
      PATH: "/usr/bin",
    },
    platform: "linux",
    run: signedOut,
    sources,
  });
  return { parent, folder, vaultHost };
}

/** try-01's hosted Launchpad behind a fake gateway that admits the cookie
 * `valid`, its Folder recorded with `preset`, with or without `vault`. */
async function servedTry(preset: PresetName, withVault: boolean) {
  const port = freePort();
  const handover = tryHandover({ withVault, listenPort: port });
  const { parent, folder, vaultHost } = await machineOf(handover, preset);
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(join(home, "Documents"), { mode: 0o700 });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    { path: bin, home, platform: process.platform, run: signedOut },
    {},
    undefined,
    undefined,
    { home, platform: process.platform, folder },
    undefined,
    undefined,
    undefined,
    vaultHost,
  );
  const origin = handover.entry.launchpad.external_origin;
  const headers = {
    host: new URL(origin).host,
    cookie: "__Secure-lazurio-workspace=valid",
  };
  const base = `http://127.0.0.1:${port}`;
  return {
    context: () => vaultHost.context(),
    get: (path: string) => fetch(`${base}${path}`, { headers }),
    post: (path: string, body: unknown = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          ...headers,
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const bootOf = (html: string) =>
  new RegExp(
    `<script type="application/json" id="${bootElementId}">([\\s\\S]*?)</script>`,
  ).exec(html)?.[1];

/** Whether the served page's Apps column lists Trezor (its item without
 * `hidden`) and what its boot document carries for the page's script. */
async function trezorOf(html: string) {
  const item = { hidden: null as boolean | null };
  await new HTMLRewriter()
    .on("#vault-nav", {
      element(element) {
        item.hidden = element.hasAttribute("hidden");
      },
    })
    .transform(new Response(html))
    .text();
  return {
    listed: item.hidden === null ? null : !item.hidden,
    carried: parseBoot(bootOf(html))?.vaultInApps ?? null,
  };
}

const trezorApi: readonly (readonly ["GET" | "POST", string])[] = [
  ["GET", "/api/vault"],
  ["POST", "/api/vault/membership"],
  ["GET", "/api/vault/requests"],
  ["GET", "/api/vault/requests/abcdefghijklmnopqrstuvwx"],
  ["POST", "/api/vault/connect"],
  ["POST", "/api/vault/disconnect"],
];

for (const entry of tryCases)
  test.skipIf(!posix || uid === 0)(
    `hosted, ${entry.name}: Trezor ${entry.withVault ? "is there, its vault a Team one, its guide vault-agents" : "stays withheld: absent from the column, 404 as page and API"}`,
    async () => {
      const app = await servedTry(entry.preset, entry.withVault);
      try {
        const context = await app.context();
        if (entry.withVault)
          // A Team Environment's vault whatever the Folder recorded.
          expect(context).toMatchObject({ kind: "own", environment: "team" });
        else
          expect(context).toEqual({
            kind: "unsupported",
            reason: "no-tailnet",
          });
        // The column, from the first paint.
        const home = await app.get("/");
        expect(home.status).toBe(200);
        expect(await trezorOf(await home.text())).toEqual({
          listed: entry.withVault,
          carried: entry.withVault,
        });
        // Trezor's pages, old addresses and an agent's request among them.
        for (const path of trezorPaths) {
          const page = await app.get(path);
          expect([path, page.status]).toEqual([
            path,
            entry.withVault ? 200 : 404,
          ]);
          expect(page.headers.get("content-type")).toStartWith("text/html");
          await page.body?.cancel();
        }
        // Integrace and Nástroje stay absent either way.
        for (const path of ["/integrations", "/settings/tools"]) {
          const page = await app.get(path);
          expect([path, page.status]).toEqual([path, 404]);
          await page.body?.cancel();
        }
        for (const [method, path] of [
          ["GET", "/api/integrations"],
          ["POST", "/api/tools/status"],
          ["POST", "/api/tools/bitwarden/setup"],
        ] as const) {
          const answer =
            method === "GET" ? await app.get(path) : await app.post(path);
          expect([path, answer.status, await answer.json()]).toEqual([
            path,
            404,
            { error: "not-found" },
          ]);
        }
        if (!entry.withVault) {
          for (const [method, path] of trezorApi) {
            const answer =
              method === "GET" ? await app.get(path) : await app.post(path);
            expect([method, path, answer.status, await answer.json()]).toEqual([
              method,
              path,
              404,
              { error: "not-found" },
            ]);
          }
          return;
        }
        // With its vault: the page's model says a Team Environment's vault.
        const page = await app.get("/api/vault");
        expect(page.status).toBe(200);
        const model = parseVaultPage(await page.json());
        expect(model).not.toBeNull();
        expect(model?.environment).toBe("team");
        expect(model?.status.state).toBe("not-set-up");
        // Nobody who enters is added: the vault's membership is not
        // managed here, and no account is created for the visitor.
        const asked = await app.post("/api/vault/membership");
        expect(asked.status).toBe(200);
        const membership = await asked.json();
        expect(membership).toEqual({
          kind: "vault-member-unknown",
          reason: "not-managed",
        });
        const person = parseVaultMembership(membership);
        // The agents' requests answer; there is no person's own Bitwarden
        // to disconnect.
        const requests = await app.get("/api/vault/requests");
        expect(requests.status).toBe(200);
        await requests.body?.cancel();
        const disconnect = await app.post("/api/vault/disconnect");
        expect([disconnect.status, await disconnect.json()]).toEqual([
          409,
          { kind: "blocked", reason: "not-connected" },
        ]);
        // The "?" plays `vault-agents`, chosen from the facts the page
        // reads: the shell's kind, `GET /api/vault` and the membership.
        const shell = await (await app.get("/.lazurio/shell.json")).json();
        const kind = shell.environments[0].kind;
        expect(kind).toBe("team");
        if (model === null) throw new Error("The page's model reads");
        for (const locale of ["cs", "en"] as const) {
          const copy = messages(locale, kind);
          const guide = pageGuide(
            { view: "vault" },
            {
              kind,
              locale,
              composio: null,
              vault: {
                vault: { status: model.status, environment: model.environment },
                person,
              },
              start: "demo",
              tools: null,
            },
            copy,
          );
          expect(guide).toEqual({
            help: "vault-agents",
            video: null,
            guides: [vaultAgentsGuide(copy)],
          });
          // Nothing on the page or in its "?" claims a nightly wipe or
          // speaks of a visitor's own vault.
          for (const text of visitorTexts(model, person, locale)) {
            expect([locale, text, nightly.test(text)]).toEqual([
              locale,
              text,
              false,
            ]);
            expect([locale, text, personal.test(text)]).toEqual([
              locale,
              text,
              false,
            ]);
          }
        }
      } finally {
        await app.close();
      }
    },
    30_000,
  );

// --- The controls --------------------------------------------------------

/** The controls, which are not public, and the vault core's answer for each
 * as it was before: the kind is the recorded preset's. */
const controlVaults = [
  {
    name: "lazurio-bob's Work Environment",
    handover: bobHandover,
    preset: "hosted-organization-personal",
    answer: { kind: "unsupported", reason: "no-tailnet" },
    listed: false,
  },
  {
    name: "team-01, a Team Environment with the broker",
    handover: teamHandover,
    preset: "hosted-organization-team",
    answer: { kind: "own", environment: "team" },
    listed: true,
  },
  {
    name: "services-01, the services Environment of a server",
    handover: services,
    preset: "hosted-organization-team",
    answer: { kind: "own", environment: "team" },
    listed: true,
  },
  {
    name: "henry-01, a Steward Environment",
    handover: stewardHandover,
    preset: "hosted-organization-steward",
    answer: { kind: "unsupported", reason: "no-vault" },
    listed: false,
  },
] as const;

for (const control of controlVaults)
  test.skipIf(!posix || uid === 0)(
    `control, ${control.name}: its vault is its preset's kind and listed as before`,
    async () => {
      const { parent, vaultHost } = await machineOf(
        control.handover as unknown as Record<string, unknown>,
        control.preset,
      );
      try {
        const context = await vaultHost.context();
        expect(context).toMatchObject(control.answer);
        if (context.kind === "own")
          expect(context.environment).toBe(
            presetKinds[control.preset] as typeof context.environment,
          );
        expect(await vaultInAppsOf(vaultHost)).toBe(control.listed);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
    30_000,
  );
