import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import {
  type PresetName,
  presetNames,
  presetProfile,
} from "../src/folder/presets";
import { bootElementId, parseBoot } from "../src/launchpad/boot";
import { vaultInAppsOf } from "../src/launchpad/boot-document";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import {
  type PageFrame,
  pageRoute,
  routeFrame,
  vaultPath,
} from "../src/launchpad/routes";
import { startLaunchpad } from "../src/launchpad/server";
import { vaultInApps, vaultListed } from "../src/launchpad/vault-page-view";
import { machineContextPath } from "../src/machine/context";
import type { HostedOperatorSources } from "../src/machine/operator";
import type { ToolRunner } from "../src/tools/status";
import type { VaultUnsupportedReason } from "../src/vault/context";
import { processVaultHost } from "../src/vault/host";
import { folderFixture } from "./fixtures/catalog-folder";
import { ownContext, vaultMember, workAccount } from "./fixtures/fake-vault";
import {
  assignments,
  binding,
  handoverEntry,
  withAudience,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";
import { freePort } from "./fixtures/ports";

// Trezor is a page of the Apps column (Matěj 2026-10-17 in the wireframe,
// prototypes-lazurio affc81e; F53's addendum of 2026-10-18): the column is
// Všechny moduly, Soubory, Integrace and Trezor, Settings no longer list it,
// and its page has the header of Files, its title alone. The column lists it
// only where the Environment has a vault (Matěj 2026-10-18, root decision
// 0185's addendum, HumanAndMachines/Lazurio#577): as the vault core answers
// for it, the answer `lazurio vault status` starts from, decided by the
// server for the first paint; never on this computer. A public
// Environment's stylesheet hides it as before (decision F55). The page's
// markup as the browser gets it, read with the same HTMLRewriter as the
// page's corners; how it looks is checked in a browser, not here (root
// decision 0178).

type Element = Readonly<{
  tag: string;
  attributes: ReadonlyMap<string, string>;
  parent: Element | null;
}>;

const page = await readFile(
  join(import.meta.dir, "..", "src", "launchpad", "index.html"),
  "utf8",
);

/** Every element of the page in document order, each with its parent. */
async function parse(source: string): Promise<Element[]> {
  const elements: Element[] = [];
  const open: Element[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const node: Element = {
          tag: element.tagName,
          attributes: new Map(element.attributes),
          parent: open.at(-1) ?? null,
        };
        elements.push(node);
        if (element.canHaveContent && !element.selfClosing) {
          open.push(node);
          element.onEndTag(() => {
            open.pop();
          });
        }
      },
    })
    .transform(new Response(source))
    .text();
  return elements;
}

const elements = await parse(page);

function byId(id: string): Element {
  const found = elements.filter((node) => node.attributes.get("id") === id);
  expect([id, found.length]).toEqual([id, 1]);
  return found[0] as Element;
}
const classes = (node: Element) =>
  (node.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
function inside(node: Element, container: Element): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent)
    if (parent === container) return true;
  return false;
}
const within = (container: Element) =>
  elements.filter((node) => inside(node, container));
const views = (node: Element) =>
  (node.attributes.get("data-view") ?? "").split(/\s+/).filter(Boolean);
/** The `data-message` of the element's text, where it has one. */
const message = (node: Element) =>
  within(node)
    .find((child) => child.attributes.has("data-message"))
    ?.attributes.get("data-message");
const icon = (node: Element) =>
  within(node)
    .find((child) => child.tag === "use")
    ?.attributes.get("href");

/** The page's own stylesheet (not the fonts'), its rules as written. */
const stylesheet = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)]
  .map((match) => match[1])
  .join("\n");
/** The selectors of the one rule whose selectors include `selector`. */
function ruleWith(selector: string): readonly string[] {
  const rules = [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({
      selectors: (match[1] ?? "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      body: (match[2] ?? "").trim(),
    }))
    .filter((rule) => rule.selectors.includes(selector));
  expect([selector, rules.length]).toEqual([selector, 1]);
  return rules[0]?.selectors ?? [];
}

test("the Apps column is Všechny moduly, Soubory, Integrace and Trezor, in this order, each a link of the page", () => {
  const top = elements.find(
    (node) =>
      node.tag === "ul" &&
      classes(node).includes("column-top") &&
      inside(node, byId("catalog-nav")),
  ) as Element;
  expect(top).toBeDefined();
  const links = within(top).filter((node) => node.tag === "a");
  expect(
    links.map((link) => [
      link.attributes.get("id"),
      link.attributes.get("href"),
      message(link),
    ]),
  ).toEqual([
    ["catalog-home", "/", "appsAll"],
    ["files-open", "/files", "filesTitle"],
    ["integrations-open", "/integrations", "integrationsTitle"],
    ["vault-open", "/vault", "vaultPageTitle"],
  ]);
  // Each moves within the page, and Trezor's opens its page in Apps.
  for (const link of links)
    expect(link.attributes.has("data-route")).toBe(true);
  const vault = byId("vault-open");
  expect(icon(vault)).toBe("#i-lock");
  expect(pageRoute(vault.attributes.get("href") ?? "")).toEqual({
    view: "vault",
  });
  expect(vaultPath).toBe("/vault");
  // Its own item, which the server hides where the Environment has no
  // vault and ui.ts on this computer (`vaultInApps`), and the public rule by
  // the link it holds; listed in the page as written.
  const item = byId("vault-nav");
  expect(item.tag).toBe("li");
  expect(vault.parent).toBe(item);
  expect(item.attributes.has("hidden")).toBe(false);
});

test("beside Trezor the column stays the Apps column, the Marketplace at its foot", () => {
  const apps = elements.find((node) =>
    classes(node).includes("column-apps"),
  ) as Element;
  expect(views(apps)).toContain("vault");
  expect(views(apps)).toContain("integrations");
  const settings = elements.find((node) =>
    classes(node).includes("column-settings"),
  ) as Element;
  expect(views(settings)).toEqual(["settings"]);
  const market = byId("marketplace-open").parent?.parent as Element;
  expect(market.tag).toBe("ul");
  expect(views(market)).toEqual(views(apps));
});

test("Settings no longer list Trezor, and nothing on the page leads to its old address", () => {
  const nav = byId("settings-nav");
  const links = within(nav).filter((node) => node.tag === "a");
  expect(links.map((link) => link.attributes.get("data-section"))).toEqual([
    "start",
    "general",
    "communication",
    "machine",
    "tools",
    "ssh",
    "recovery",
  ]);
  for (const link of links)
    expect(link.attributes.get("href") ?? "").not.toContain("vault");
  // No link anywhere in the page goes to `/settings/vault` (its routes still
  // answer: F54 as amended, tests/launchpad-routes.test.ts).
  for (const node of elements)
    expect(node.attributes.get("href") ?? "").not.toStartWith(
      "/settings/vault",
    );
  // Začínáme's vault row opens Trezor in Apps.
  const open = within(byId("start-vault-group")).find(
    (node) => node.tag === "a",
  ) as Element;
  expect(open.attributes.get("href")).toBe("/vault");
  expect(open.attributes.has("data-route")).toBe(true);
});

test("Trezor's page is a view of its own with Files' header: its title alone, no Settings crumb, its refresh as the header's action", () => {
  const view = byId("view-vault");
  expect(view.tag).toBe("main");
  expect(views(view)).toEqual(["vault"]);
  const section = byId("section-vault");
  expect(section.parent).toBe(view);
  // Not a Settings section: none of Settings' rules shows or hides it.
  expect(section.attributes.has("data-section")).toBe(false);
  expect(inside(section, byId("view-settings"))).toBe(false);
  expect(section.attributes.get("aria-labelledby")).toBe("page-heading");
  // What the panels draw into stays in it: the agents' requests, one
  // request's page, the vault and how it works without one.
  for (const id of [
    "vault-requests",
    "vault-request",
    "vault-page-group",
    "vault-explainer",
    "vault-connect",
    "vault-bitwarden",
  ])
    expect([id, inside(byId(id), section)]).toEqual([id, true]);
  // The header of Settings and Files stands over Trezor too, with the
  // page's heading and without the crumb that leads to Settings.
  const header = elements.find(
    (node) => node.tag === "header" && classes(node).includes("topbar"),
  ) as Element;
  expect(views(header)).toEqual(["settings", "files", "vault"]);
  expect(views(byId("crumb-parent"))).toEqual(["settings"]);
  expect(inside(byId("page-heading"), header)).toBe(true);
  const refresh = byId("vault-page-refresh");
  expect(inside(refresh, header)).toBe(true);
  expect(refresh.attributes.get("data-section-action")).toBe("vault");
});

test("the first paint shows exactly the frame of the route, Trezor's too, and its refresh only there", () => {
  const frames: readonly PageFrame[] = [
    "catalog",
    "files",
    "integrations",
    "vault",
    "marketplace",
    "settings",
  ];
  const hiding = ruleWith(
    'html[data-frame="vault"] [data-view]:not([data-view~="vault"])',
  );
  for (const frame of frames)
    expect(hiding).toContain(
      `html[data-frame="${frame}"] [data-view]:not([data-view~="${frame}"])`,
    );
  // Every frame a view names is one the routes give.
  for (const node of elements)
    for (const name of views(node))
      expect([name, frames.includes(name as PageFrame)]).toEqual([name, true]);
  expect(routeFrame(pageRoute("/vault"))).toBe("vault");
  // Its refresh belongs to its frame, as Files' does.
  expect(hiding).toContain(
    'html:not([data-frame="vault"]) [data-section-action="vault"]',
  );
  expect(hiding).not.toContain(
    'html:not([data-section="vault"]) [data-section-action="vault"]',
  );
});

test("a public Environment's stylesheet hides Trezor in the Apps column as it hid it in Settings (decision F55)", () => {
  const selectors = ruleWith(
    'html[data-audience="public"] li:has(> #integrations-open)',
  );
  expect(selectors).toEqual([
    'html[data-audience="public"] li:has(> #integrations-open)',
    'html[data-audience="public"] li:has(> #vault-open)',
    'html[data-audience="public"] #settings-nav li:has(> a[data-section="tools"])',
    'html[data-audience="public"] #start-refresh',
  ]);
  // The rule's item holds the link it names, right under it.
  expect(byId("vault-open").parent?.tag).toBe("li");
});

// Whether the Apps column lists Trezor, for each answer of the vault core
// (root decision 0185's addendum of 2026-10-18, HumanAndMachines/Lazurio#577;
// F53's addendum of 2026-10-18 (3)): where the Environment has a
// vault, also one that waits for its person, and where the core could not
// read why it has none, so that the page can say so; not where it has none,
// by design or not yet, nor on this computer. A new reason fails to compile
// here.
const listedFor = {
  workstation: false,
  "no-vault": false,
  "no-tailnet": false,
  "folder-unreadable": true,
  "handover-missing": true,
  "handover-unreadable": true,
  "not-operator": true,
  "connection-unreadable": true,
} as const satisfies Record<VaultUnsupportedReason, boolean>;

test("the Apps column lists Trezor where the vault core says the Environment has a vault, and where it could not read why not", () => {
  expect(vaultListed(ownContext())).toBe(true);
  expect(
    vaultListed({ kind: "needs-connection", name: "Osobní example" }),
  ).toBe(true);
  for (const [reason, listed] of Object.entries(listedFor))
    expect([
      reason,
      vaultListed({
        kind: "unsupported",
        reason: reason as VaultUnsupportedReason,
      }),
    ]).toEqual([reason, listed]);
});

test("the page draws what the server decided; a page that carries no decision follows its preset, never on this computer", () => {
  for (const preset of [...presetNames, null]) {
    expect([preset, vaultInApps(true, preset)]).toEqual([preset, true]);
    expect([preset, vaultInApps(false, preset)]).toEqual([preset, false]);
  }
  // A workstation's page carries no boot document: not on this computer.
  expect(vaultInApps(null, "local")).toBe(false);
  // A hosted page whose boot document was late: listed, as where the
  // server could not read the vault, so a Remote Environment never shows
  // it late.
  for (const preset of presetNames.filter((name) => name !== "local"))
    expect([preset, vaultInApps(null, preset)]).toEqual([preset, true]);
  expect(vaultInApps(null, null)).toBe(true);
});

const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? -1;
const workHost = "workspace.example.lazurio.io";
const personalHost = "example.lazurio.io";
// A network whose control server is `https://headscale.<zone>`, as the
// networks' are: the zone's Lazurio Vaultwarden is `vaultwarden.<zone>`.
const network = {
  headscale_server_url: "https://headscale.example.lazurio.io",
  headscale_hostname: "example-workspace",
};
const { team: _, ...withoutTeam } = organization.owner;
const { network: __, ...withoutNetwork } = organization;
const pilotAccount = {
  email: "vaultwarden@workspace.example.lazurio.io",
  server: "https://vaultwarden.example.lazurio.io",
  deviceIdentifier: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
  masterPassword: "a".repeat(43),
  createdAt: "2026-10-01T00:00:00.000Z",
  clientId: "user.6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
  clientSecret: "a1b2c3d4e5f6a1b2",
};
const pilotVault = {
  organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
  collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
  fingerprint: "invented-fingerprint-phrase",
};

/** One Remote Environment as its Machine has it: the root-issued handover
 * (its entry on `port`), the Folder its preset records and the custody of
 * its vault. */
type Environment = Readonly<{
  name: string;
  preset: PresetName;
  host: string;
  handover: (port: number) => Record<string, unknown>;
  /** Whether the handover is on the Machine (default yes). */
  written?: boolean;
  /** Files of the vault's custody, by their path under the state root
   * (`${XDG_STATE_HOME}/lazurio/vault`). */
  custody?: Readonly<Record<string, unknown>>;
  /** Where the vault core is read (default Linux). */
  platform?: string;
  /** The vault core's answer for it, as `lazurio vault status` starts. */
  answer: Readonly<Record<string, unknown>>;
  listed: boolean;
}>;

const personalHandover =
  (vault: object | null = null) =>
  (port: number) => ({
    ...personal,
    network: { ...network, headscale_hostname: "example" },
    entry: handoverEntry(personalHost, port),
    ...(vault === null ? {} : { vault }),
  });
const workHandover =
  (
    input: Readonly<{
      vault?: object;
      team?: boolean;
      network?: object | null;
      audience?: boolean;
    }> = {},
  ) =>
  (port: number) => {
    const entry = handoverEntry(workHost, port);
    return {
      ...withoutNetwork,
      ...(input.network === null ? {} : { network: input.network ?? network }),
      owner: input.team
        ? { ...organization.owner, assignment: assignments.team }
        : withoutTeam,
      entry: input.audience ? withAudience(entry) : entry,
      ...(input.vault === undefined ? {} : { vault: input.vault }),
    };
  };

const environments: readonly Environment[] = [
  {
    name: "a personal Environment whose person has not connected their own Bitwarden yet",
    preset: "hosted-personal",
    host: personalHost,
    handover: personalHandover(),
    answer: { kind: "needs-connection", name: "Osobní example" },
    listed: true,
  },
  {
    name: "a personal Environment whose person connected their own Bitwarden",
    preset: "hosted-personal",
    host: personalHost,
    handover: personalHandover(),
    custody: {
      "personal/connection.json": {
        region: "eu",
        account: "agents.example+lazurio@example.com",
        invitee: null,
      },
    },
    answer: {
      kind: "own",
      environment: "personal",
      host: "vault.bitwarden.eu",
    },
    listed: true,
  },
  {
    name: "a personal Environment whose record of its own Bitwarden does not read",
    preset: "hosted-personal",
    host: personalHost,
    handover: personalHandover(),
    custody: { "personal/connection.json": { region: "eu" } },
    answer: { kind: "unsupported", reason: "connection-unreadable" },
    listed: true,
  },
  {
    name: "an Organization's work Environment whose handover names a vault",
    preset: "hosted-organization-personal",
    host: workHost,
    handover: workHandover({
      vault: vaultMember(workAccount, "Example Pracovní workspace"),
    }),
    answer: { kind: "own", environment: "work", account: workAccount },
    listed: true,
  },
  {
    name: "an Organization's Team Environment whose handover names a vault",
    preset: "hosted-organization-team",
    host: workHost,
    handover: workHandover({
      vault: vaultMember(workAccount, "Example Týmový workspace"),
      team: true,
    }),
    answer: { kind: "own", environment: "team", account: workAccount },
    listed: true,
  },
  {
    name: "an Organization's work Environment whose handover names no vault",
    preset: "hosted-organization-personal",
    host: workHost,
    handover: workHandover(),
    // The context derives where a 0197 pilot's account would be; none was
    // ever connected here, so its status is `no-vault` (`pilotStatus`).
    answer: {
      kind: "pilot",
      account: "vaultwarden@workspace.example.lazurio.io",
    },
    listed: false,
  },
  {
    name: "an Organization's work Environment connected the 0197 way, its handover naming no vault yet",
    preset: "hosted-organization-personal",
    host: workHost,
    handover: workHandover(),
    custody: {
      "vaultwarden.example.lazurio.io/workspace.example.lazurio.io/bw/lazurio-account.json":
        pilotAccount,
      "vaultwarden.example.lazurio.io/workspace.example.lazurio.io/bw/lazurio-vault.json":
        pilotVault,
    },
    answer: {
      kind: "pilot",
      account: "vaultwarden@workspace.example.lazurio.io",
    },
    listed: true,
  },
  {
    name: "an Organization's work Environment whose handover names no vault, on a network no pilot derives from",
    preset: "hosted-organization-personal",
    host: workHost,
    handover: workHandover({
      network: {
        headscale_server_url: "https://network.example.invalid",
        headscale_hostname: "example-workspace",
      },
    }),
    answer: { kind: "unsupported", reason: "no-vault" },
    listed: false,
  },
  {
    name: "a public Organization's work Environment, which has no network",
    preset: "hosted-organization-personal",
    host: workHost,
    handover: workHandover({ network: null, audience: true }),
    answer: { kind: "unsupported", reason: "no-tailnet" },
    listed: false,
  },
  {
    name: "a hosted Folder read on a computer that is not Linux",
    preset: "hosted-organization-personal",
    host: workHost,
    handover: workHandover({
      vault: vaultMember(workAccount, "Example Pracovní workspace"),
    }),
    platform: "darwin",
    answer: { kind: "unsupported", reason: "workstation" },
    listed: false,
  },
  {
    name: "a Remote Environment whose handover is not on its Machine",
    preset: "hosted-organization-personal",
    host: workHost,
    handover: workHandover({
      vault: vaultMember(workAccount, "Example Pracovní workspace"),
    }),
    written: false,
    answer: { kind: "unsupported", reason: "handover-missing" },
    listed: true,
  },
];

const signedOut: ToolRunner = async () => ({
  exitCode: 1,
  stdout: "",
  stderr: "You are not logged into any GitHub hosts.",
});

/** The hosted Launchpad of one Environment behind a fake gateway that
 * admits the cookie `__Secure-lazurio-workspace=valid`, its vault read by
 * the production composition (`processVaultHost`, as `lazurio vault`
 * reads it): only the handover's place, the operator's system record and
 * the state root are this test's. */
async function served(environment: Environment) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-apps-vault-")),
  );
  const root = join(parent, "machine");
  await mkdir(root, { mode: 0o755 });
  const port = freePort();
  const document = environment.handover(port);
  if (environment.written !== false) {
    const file = join(root, machineContextPath);
    await mkdir(dirname(file), { recursive: true, mode: 0o755 });
    await writeFile(file, JSON.stringify(document), { mode: 0o644 });
  }
  const folder = join(root, "home", "operator", "Lazurio");
  await mkdir(join(folder, "organizations"), { recursive: true, mode: 0o700 });
  if (environment.preset === "hosted-personal")
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset: environment.preset,
    machine: binding(document),
    profile: presetProfile(environment.preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const state = join(parent, "state");
  for (const [path, value] of Object.entries(environment.custody ?? {})) {
    const file = join(state, "lazurio", "vault", path);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
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
    env: { HOME: "/home/operator", XDG_STATE_HOME: state, PATH: "/usr/bin" },
    platform: environment.platform ?? "linux",
    run: signedOut,
    sources,
  });
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
  const headers = {
    host: `launchpad.${environment.host}`,
    cookie: "__Secure-lazurio-workspace=valid",
  };
  return {
    context: () => vaultHost.context(),
    async page(path: string) {
      const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers,
      });
      return { status: answer.status, html: await answer.text() };
    },
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

/** What a served page says of Trezor in its first paint: whether its Apps
 * column lists it (the item without `hidden`), and what its boot document
 * carries for the page's script. */
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

// Trezor's addresses, old and new, an agent's request among them.
const vaultPaths = [
  "/vault",
  "/vault/requests/abcdefghijklmnopqrstuvwx",
  "/settings/vault",
  "/settings/vault/requests/abcdefghijklmnopqrstuvwx",
];

for (const environment of environments)
  test.skipIf(!posix || uid === 0)(
    `hosted: ${environment.name} ${environment.listed ? "lists" : "does not list"} Trezor from its first paint, as its vault core answers`,
    async () => {
      const app = await served(environment);
      try {
        expect(await app.context()).toMatchObject(environment.answer);
        const home = await app.page("/");
        expect(home.status).toBe(200);
        // Decided by the server: the item as the page is served, and the
        // same answer for the page's script.
        expect(await trezorOf(home.html)).toEqual({
          listed: environment.listed,
          carried: environment.listed,
        });
        // Its addresses still answer where it is not listed, old links
        // among them, with the same page; a public Environment answers
        // them as absent, as before (decision F55).
        const audience = environment.name.startsWith("a public");
        for (const path of vaultPaths) {
          const page = await app.page(path);
          expect([path, page.status]).toEqual([path, audience ? 404 : 200]);
          if (!audience) expect([path, page.html]).toEqual([path, home.html]);
        }
      } finally {
        await app.close();
      }
    },
    30_000,
  );

test.skipIf(!posix)(
  "a workstation's page carries no decision and lists Trezor as written, which its preset hides; its addresses still answer",
  async () => {
    await folderFixture(async (folder) => {
      const app = await startLaunchpad(folder);
      try {
        const session = new URL(app.url);
        for (const path of ["/", ...vaultPaths]) {
          const answer = await fetch(new URL(path, session));
          const html = await answer.text();
          expect([path, answer.status]).toEqual([path, 200]);
          expect(html).not.toContain(bootElementId);
          expect(await trezorOf(html)).toEqual({ listed: true, carried: null });
        }
      } finally {
        await app.close();
      }
    });
    // The page's script, with nothing carried, hides it there.
    expect(vaultInApps(null, "local")).toBe(false);
  },
  30_000,
);

test("where the vault core cannot be read at all, the Apps column lists Trezor", async () => {
  const host = processVaultHost({
    folder: async () => undefined,
    env: { HOME: "/home/operator", PATH: "/usr/bin" },
    platform: "linux",
    run: signedOut,
  });
  expect(
    await vaultInAppsOf({
      ...host,
      context: async () => {
        throw new Error("unreadable");
      },
    }),
  ).toBe(true);
  // Read as it is: this one's Folder is none, which is a workstation.
  expect(await vaultInAppsOf(host)).toBe(false);
});
