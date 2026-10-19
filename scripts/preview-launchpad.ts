// A preview of the Launchpad (decision F36) against a temporary fixture
// Folder, never a live one: `bun scripts/preview-launchpad.ts
// local|hosted|personal cs|en [port] [owner|steward|member] [fresh]`.
// `personal` is a personal Remote Environment (`hosted-personal`); `fresh`
// leaves the Folder without any Organization, as a new Environment is before
// its content is prepared (root decision 0188). The role is what the preview's GitHub
// identity answers for the example Organization: an Owner (the default), a
// Steward (`maintain` on its module repositories) or a member. One
// Organization with root-level and workspace modules in
// Workspace, production repositories in Productionspace and an `infra` the
// Launchpad does not list (and a second Organization locally, for the rail),
// a synthetic home for Files and Tools. Prints one JSON line: `url` to open
// (local: with the fragment token) and, hosted, `proxy`: a loopback listener
// that adds the gateway's Host and cookie, which a browser automation routes
// the entry's origin through, and `browser`: the origin of the Environment
// browser's view the entry routes (decision F38). Agent-browser is not run:
// the Launchpad answers the view there with a synthetic token, and a browser
// automation stands in for that origin. In a Remote Environment, Executor
// (decision F44) is the tests' fake world: Settings → Tools → executor shows
// "not installed", and its setup runs a fake npm, program and user manager,
// never the network or this computer's services. Apps → Integrace (decision
// F42) reads a fake Executor API on a loopback port of its own (never 4789)
// with a synthetic token, and a fake `composio` signed in with two accounts,
// one of them named, in a Composio organization whose name has a space and
// diacritics (each account's menu links to Composio's dashboard): a direct
// sign-in finishes by itself after a few seconds and a Composio link at once
// (the window they open shows nothing real). Vlastní lists one server that
// Executor cannot reach, as 1.6.10 reads it (`degraded`, #322), so it says
// it could not start. Locally that fake
// stands in for a Remote Environment's Executor, so the page shows the
// direct paths (decision F44 installs none on a computer); in a Remote
// Environment the page follows Settings → Tools → executor, as in
// production. A hosted preview's Composio has the person's own
// organization of the example Organization's name ("Example Company", in
// Composio "ExampleCompany"), which the first reading makes current; with
// `composio-org-missing` anywhere after the mode it lacks it, and Apps →
// Integrace says to create it (decision F42, addendum of 2026-10-13). With
// `composio-signed-out` anywhere after the mode its Composio is signed out:
// "Připojit" starts the CLI's own two-step sign-in, whose link opens
// nothing real, and the person's approval in Composio is the sign-in's key
// (the link's `cliKey`) written into the file the JSON line names
// `composioApprove` (its poll notices it on the CLI's schedule, up to a
// minute later; decision F42, note of 2026-10-19). With
// `composio-off` anywhere
// after the mode, a hosted
// preview's example Organization does not allow Composio (root decision
// 0194, decision F45): its root becomes a Git checkout whose `main` says so,
// which the Launchpad reads as on an Organization's Environment without the
// relay, so Settings → Tools shows Composio's switch locked. With
// `microsoft365` anywhere after the mode, a hosted preview's example
// Organization sets up a fictional Microsoft 365 company app (F42 addendum (c)
// of 2026-10-14) whose callbacks list this preview's Launchpad: one card
// "Microsoft 365" offers "Připojit", and its sign-in goes to Microsoft's
// address, which a browser automation answers with a stand-in authorization
// page that returns to the Launchpad; the fake Executor holds the company
// app's integration already and finishes a sign-in only when it returns. A
// hosted preview's work Environment has its own vault (decision F53) in the
// tests' fake Vaultwarden at the example Organization's address, set up
// before the start, so Začínáme and Apps → Trezor show it with the
// steps for Bitwarden in Codex Desktop (F53's addendum of 2026-10-16); the
// fake bw keeps everything under the synthetic home, and the gateway names a
// fictional person, jana, whose own address the steps offer. A personal
// preview's vault is its person's own Bitwarden (root decision 0203 point 7)
// in the tests' fake Bitwarden cloud, waiting for its person: the JSON line's
// `bitwarden` has a fictional agents' account's `client_id`, `client_secret`
// and master password to connect with on Apps → Trezor (the account is
// in the cloud's EU region, or in the US with `bitwarden-us` anywhere after
// the mode), and `accept`, a file whose creation makes the person accept the
// invitation the page asked for, as Bitwarden's e-mail would. With `public`
// anywhere after the mode, a hosted preview's work Environment is a public
// Environment (root decision 0204, decision F55): its entry carries
// `audience: "public"`, so the Launchpad runs the demo onboarding, the
// column head says the Environment is public and shared, and Integrace,
// Apps → Trezor and Nastavení → Nástroje answer as absent. With
// `no-vault` or `no-tailnet` anywhere after the mode, a hosted preview's work
// Environment has no vault, for that reason (F53's addendum of 2026-10-17):
// nothing is set up, the Apps column does not list Trezor (F53's addendum of
// 2026-10-18 (3)), and `/vault` says why and explains the vault with its
// guide video. With `team` or `automated` anywhere after the mode, a
// hosted preview's work Environment is the example Organization's Team
// Environment or a persona's Automated Environment instead (its handover's
// assignment `team` or `automation`), to see how a page names each kind
// (decision F28's addendum of 2026-10-18). Synthetic names only; stop it
// with Ctrl-C.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { updateTools } from "../src/folder/update-profile";
import {
  microsoft365AuthTemplate,
  microsoft365PartsOf,
  microsoft365Scopes,
  microsoft365SpecId,
} from "../src/integrations/microsoft365";
import { microsoft365Description } from "../src/integrations/microsoft365-executor";
import { startLaunchpad } from "../src/launchpad/server";
import { toolsEnvironmentOf } from "../src/tools/overview";
import { runTool } from "../src/tools/status";
import { readConnection } from "../src/vault/connection";
import { vaultSetup } from "../src/vault/flow";
import {
  writeModule,
  writeOrganization,
} from "../tests/fixtures/catalog-folder";
import {
  cloudHost,
  startFakeBitwardenCloud,
} from "../tests/fixtures/fake-bitwarden-cloud";
import { executorWorld } from "../tests/fixtures/fake-executor";
import { startFakeExecutor } from "../tests/fixtures/fake-executor-api";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownContext,
  startFakeVault,
  vaultMember,
  workAccount,
  workHandover,
  zipOf,
} from "../tests/fixtures/fake-vault";
import {
  organizationWithEntry,
  personalWithEntry,
} from "../tests/fixtures/machine-bindings";

const mode =
  process.argv[2] === "hosted" || process.argv[2] === "personal"
    ? process.argv[2]
    : "local";
const fresh = process.argv[6] === "fresh";
const composioOff = process.argv.slice(3).includes("composio-off");
const publicEnvironment =
  process.argv[2] === "hosted" && process.argv.slice(3).includes("public");
const microsoft365 = process.argv.slice(3).includes("microsoft365");
const team =
  process.argv[2] === "hosted" && process.argv.slice(3).includes("team");
const composioOrgMissing = process.argv
  .slice(3)
  .includes("composio-org-missing");
const composioSignedOut = process.argv.slice(3).includes("composio-signed-out");
const bitwardenUs = process.argv.slice(3).includes("bitwarden-us");
const noVault =
  process.argv
    .slice(3)
    .find(
      (value): value is "no-vault" | "no-tailnet" =>
        value === "no-vault" || value === "no-tailnet",
    ) ?? null;
const assignment =
  mode !== "hosted"
    ? null
    : process.argv.slice(3).includes("team")
      ? "team"
      : process.argv.slice(3).includes("automated")
        ? "automation"
        : null;
const locale = process.argv[3] === "en" ? "en" : "cs";
const listenPort = Number(process.argv[4] ?? 24611);
const role =
  process.argv[5] === "steward" || process.argv[5] === "member"
    ? process.argv[5]
    : "owner";
const host =
  mode === "personal" ? "example.lazurio.io" : "vm-01.example.lazurio.io";
const browserOrigin = `https://browser.${host}`;
const parent = await realpath(
  await mkdtemp(join(tmpdir(), "launchpad-preview-")),
);
const folder = join(parent, "Lazurio");
const os = executionOs(process.platform);
if (mode === "local")
  await initializeFolder(folder, {
    os,
    access: "local",
    purpose: "human",
    locale,
    detail: "concise",
    coordination: "direct",
  });
else {
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset =
    mode === "personal"
      ? "hosted-personal"
      : assignment === "team"
        ? "hosted-organization-team"
        : assignment === "automation"
          ? "hosted-organization-steward"
          : "hosted-organization-personal";
  await initializeHandoverFolder(folder, {
    preset,
    // A Remote Environment as the gateway serves it: the Environment
    // browser's view and the person's sign-out (Machines#358), and with
    // `public` a public Environment's audience (decision F55).
    machine:
      mode === "personal"
        ? personalWithEntry(listenPort, true, true)
        : organizationWithEntry(
            listenPort,
            host,
            true,
            true,
            publicEnvironment,
            assignment,
          ),
    profile: presetProfile(preset, os, { locale }),
  });
}
if (!fresh && mode !== "personal") await writeExample();
async function writeExample() {
  const root = await writeOrganization(folder, "example_GEN3", {
    slug: "example",
    state: "current",
    modules: [
      { id: "mission-control", path: "mission-control" },
      { id: "design-system", path: "design-system" },
      // Workspace modules declare their repository, for a Steward's answer.
      {
        id: "knowledgebase",
        slot: { git: { url: "https://github.com/example/knowledgebase.git" } },
      },
      {
        id: "deals",
        slot: { git: { url: "https://github.com/example/deals.git" } },
      },
      { id: "website", broken: true },
      { id: "brainstorm", apps: false },
    ],
    slots: [
      {
        path: "infra",
        slug: "infra",
        git: { url: "https://github.com/example/infra.git", branch: "main" },
      },
      {
        path: "productionspace/firmware",
        slug: "firmware",
        git: { url: "https://github.com/example/firmware.git", branch: "main" },
      },
      {
        path: "productionspace/connect",
        slug: "connect",
        git: { url: "https://github.com/example/connect.git", branch: "main" },
      },
    ],
  });
  // What each example app declares of itself (decision F36): a title, and for
  // some a description and a semantic icon; the others show the org-agnostic
  // sentence of their stone. The website stays broken: it cannot start.
  const declared: Record<
    string,
    { title: string; description?: string; icon?: string; tags?: string[] }
  > = {
    "mission-control": {
      title: "Mission Control v3",
      description: "Plány, úkoly a koordinace práce",
    },
    "design-system": { title: "Design system v1" },
    knowledgebase: {
      title: "Knowledgebase",
      description: "Znalosti, rozhodnutí a dokumentace",
    },
    deals: { title: "Deals v2", tags: ["sales"] },
  };
  for (const [id, display] of Object.entries(declared)) {
    const file = join(
      root,
      ["mission-control", "design-system"].includes(id)
        ? id
        : `workspace/${id}`,
      "app/package.json",
    );
    const pkg = JSON.parse(await readFile(file, "utf8"));
    Object.assign(pkg.lazurio.runtime, {
      title: display.title,
      ...(display.description ? { description: display.description } : {}),
      ...(display.icon ? { icon: display.icon } : {}),
      tags: display.tags ?? [],
    });
    await writeFile(file, JSON.stringify(pkg));
  }
  for (const path of ["infra/.git", "productionspace/firmware/.git"])
    await mkdir(join(root, path), { recursive: true });
  await writeModule(join(root, "infra"), "example", {
    id: "infra",
    apps: false,
  });
  if (mode === "local")
    await writeOrganization(folder, "northwind", {
      slug: "northwind",
      state: "current",
      modules: [{ id: "orders" }, { id: "pricing" }],
    });
}
// A synthetic home: the Files page shows its Documents, never the account's,
// and the Tools page reads no real tool or sign-in.
const home = join(parent, "home");
await mkdir(join(home, "bin"), { recursive: true });
for (const tool of ["gh", "t3"])
  await writeFile(join(home, "bin", tool), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
// Integrace (decision F42): a fake composio signed in, with an active account
// named only by `link --list`, an expired one, and for Gmail an expired
// account beside a sign-in nobody finished, which the page leaves out (F42
// addendum of 2026-10-12); its CLI removes only after a prompt, so the page
// offers no "Odpojit". It stands in the standard path and is not the build
// Lazurio pins, so Apps → Integrace and Settings → Tools offer its update
// (decision F42, addendum (b) of 2026-10-14; the update itself would reach
// the network). And a fake Executor with Executor's token file of a
// synthetic token.
await mkdir(join(home, ".local", "bin"), { recursive: true });
await writeFile(
  join(home, ".local", "bin", "composio"),
  `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${join(import.meta.dir, "..", "tests", "fixtures", "fake-composio.ts")}' "$@"\n`,
  { mode: 0o755 },
);
await mkdir(join(home, ".fake-composio"), { recursive: true, mode: 0o700 });
await writeFile(
  join(home, ".fake-composio", "state.json"),
  JSON.stringify({
    signedIn: !composioSignedOut,
    removeYes: false,
    next: 100,
    activateOnLink: true,
    organization: "Příklad s.r.o.",
    // The person's own organization of the example Organization's name,
    // which the hosted preview's first reading makes current (decision F42,
    // addendum of 2026-10-13); without it, the page says to create it.
    organizations: [
      { id: "org_1", name: "Příklad s.r.o." },
      ...(composioOrgMissing ? [] : [{ id: "org_2", name: "ExampleCompany" }]),
    ],
    accounts: [
      {
        id: "ca_1",
        toolkit: "salesforce",
        status: "ACTIVE",
        alias: "Obchod",
        word_id: "castle",
      },
      {
        id: "ca_2",
        toolkit: "zoom",
        status: "EXPIRED",
        alias: null,
        word_id: "river",
      },
      {
        id: "ca_3",
        toolkit: "gmail",
        status: "EXPIRED",
        alias: "Práce",
        word_id: "meadow",
      },
      {
        id: "ca_4",
        toolkit: "gmail",
        status: "INITIATED",
        alias: null,
        word_id: "harbor",
      },
    ],
  }),
);
await mkdir(join(home, ".composio"), { recursive: true, mode: 0o700 });
await writeFile(
  join(home, ".composio", "toolkits.json"),
  JSON.stringify(
    [
      "salesforce",
      "zoom",
      "trello",
      "gmail",
      "outlook",
      "slack",
      "hubspot",
    ].map((slug) => ({ name: slug, slug })),
  ),
);
const executorToken = "previewExecutorToken000000000000";
await mkdir(join(home, ".executor", "server-control"), {
  recursive: true,
  mode: 0o700,
});
await writeFile(
  join(home, ".executor", "server-control", "auth.json"),
  JSON.stringify({ token: executorToken }),
  { mode: 0o600 },
);
await chmod(join(home, ".executor", "server-control", "auth.json"), 0o600);
const executorApi = await startFakeExecutor(
  executorToken,
  {
    integrations: [
      {
        slug: "notion-com",
        name: "Notion",
        kind: "mcp",
        transport: "remote",
        endpoint: "https://mcp.notion.com/mcp",
        auth: "oauth2",
        tools: 12,
      },
      {
        slug: "invoices",
        name: "invoices",
        kind: "mcp",
        transport: "remote",
        endpoint: "https://mcp.invoices.example.com/mcp",
        auth: "header",
        tools: 6,
        config: {
          transport: "remote",
          endpoint: "https://mcp.invoices.example.com/mcp",
          remoteTransport: "auto",
          authenticationTemplate: [
            {
              slug: "apikey",
              kind: "apikey",
              placements: [
                { carrier: "header", name: "Authorization", prefix: "Bearer " },
                {
                  carrier: "header",
                  name: "X-Api-Key",
                  variable: "header-x-api-key",
                },
              ],
            },
          ],
        },
      },
      {
        slug: "files",
        name: "Files",
        kind: "mcp",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@example/files-mcp"],
        auth: "none",
        tools: 4,
        config: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@example/files-mcp", "--root", "~/Documents"],
          cwd: "/home/preview",
          authenticationTemplate: [
            { slug: "env", kind: "stdio_env", vars: ["FILES_TOKEN"] },
          ],
        },
      },
      {
        slug: "search",
        name: "Search",
        kind: "mcp",
        transport: "stdio",
        command: "search-mcp",
        auth: "none",
        tools: 0,
        broken: true,
      },
    ],
    connections: [
      {
        owner: "org",
        name: "default",
        integration: "notion-com",
        template: "oauth2",
        identityLabel: "jana@example.com",
        health: "healthy",
      },
      {
        owner: "org",
        name: "default",
        integration: "invoices",
        template: "apikey",
        identityLabel: null,
        health: null,
      },
      {
        owner: "org",
        name: "default",
        integration: "files",
        template: "env",
        identityLabel: null,
        health: "healthy",
      },
      {
        owner: "org",
        name: "default",
        integration: "search",
        template: "none",
        identityLabel: null,
        health: "degraded",
        reason: "tool_sync_failed",
      },
    ],
  },
  // With the company app, a sign-in finishes only when it returns.
  microsoft365 ? undefined : 4_000,
);
// With the company app, Executor already holds its one integration as this
// release builds it, so the preview downloads no spec from the network.
if (microsoft365) {
  const parts = microsoft365PartsOf(["outlook", "one_drive", "share_point"]);
  executorApi.integrations.push({
    slug: "m365",
    name: "Microsoft 365",
    kind: "openapi",
    transport: "remote",
    auth: "oauth2",
    tools: 2825,
    description: microsoft365Description(microsoft365SpecId(parts)),
    authenticationTemplate: [
      {
        ...microsoft365AuthTemplate(
          parts,
          "00000000-0000-4000-8000-0000000000aa",
        ),
        scopes: [...microsoft365Scopes(parts)],
      },
    ],
  });
}
for (const endpoint of [
  "https://mcp.linear.app/mcp",
  "https://mcp.clickup.com/mcp",
  "https://mcp.figma.com/mcp",
])
  executorApi.probes.set(endpoint, { requiresOAuth: true });
executorApi.probes.set("https://mcp.deepwiki.com/mcp", {
  requiresOAuth: false,
});
// Vlastní: Codex's example address answers without a sign-in.
for (const endpoint of [
  "https://mcp.example.com/mcp",
  "https://mcp.invoices.example.com/mcp",
])
  executorApi.probes.set(endpoint, { requiresOAuth: false });
await mkdir(join(home, "Documents", "Nabídky"), { recursive: true });
await mkdir(join(home, "Documents", "Smlouvy"), { recursive: true });
await writeFile(
  join(home, "Documents", "Prezentace pro tým.pdf"),
  "x".repeat(182_000),
);
await writeFile(join(home, "Documents", "Ceník 2026.xlsx"), "x".repeat(48_000));
await writeFile(
  join(home, "Documents", "Zápis z porady.docx"),
  "x".repeat(23_000),
);
// Executor's fake world (decision F44) in a Remote Environment; its entry is
// on the tools' PATH, so the row's installation reads what its setup placed.
const executor = mode === "local" ? undefined : await executorWorld({ home });
// The work Environment's own vault, set up and connected before the start;
// the personal preview's person's own Bitwarden in the fake cloud, waiting
// for its person; locally, this process's (none on a computer).
let bitwarden: Readonly<Record<string, string>> | null = null;
const vaultHost =
  mode === "hosted"
    ? await previewVault()
    : mode === "personal"
      ? await previewBitwarden()
      : undefined;
async function previewBitwarden() {
  const cloud = await startFakeBitwardenCloud(home);
  const masterPassword = "Preview agents 2026";
  const key = await cloud.account(
    "jana+agents@example.com",
    masterPassword,
    undefined,
    "v1",
    bitwardenUs ? "us" : "eu",
  );
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const host = cloudHost({
    home,
    cloud,
    pin,
    download: fakeRelease(pin, zip).fetch,
  });
  // The person accepts the invitation the page asked for once this file
  // appears, as Bitwarden's e-mail would let them.
  const accept = join(parent, "accept");
  setInterval(async () => {
    if (!(await Bun.file(accept).exists())) return;
    await Bun.file(accept).delete();
    const connection = await readConnection(host.connection).catch(() => null);
    if (connection?.invitee) await cloud.accept(connection.invitee);
  }, 500);
  bitwarden = {
    clientId: key.clientId,
    clientSecret: key.clientSecret,
    masterPassword,
    accept,
  };
  return { ...host, enableForAgents: async () => undefined };
}
async function previewVault() {
  const vault = await startFakeVault(home);
  vault.allow(workAccount);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  // No vault, for the reason asked for: nothing to set up.
  if (noVault !== null)
    return {
      ...fakeHost({
        home,
        vault,
        pin,
        download: fakeRelease(pin, zip).fetch,
        context: async () => ({ kind: "unsupported", reason: noVault }),
      }),
      enableForAgents: async () => undefined,
    };
  const host = fakeHost({
    home,
    vault,
    pin,
    download: fakeRelease(pin, zip).fetch,
    context: async () =>
      ownContext(
        workHandover(vaultMember(workAccount, "Pracovní example")),
        team ? "team" : "work",
      ),
  });
  const setUp = await vaultSetup(host);
  if (setUp.state !== "connected")
    throw new Error("The preview's vault is not set up");
  return { ...host, enableForAgents: async () => undefined };
}
if (mode === "local") await updateTools(folder, 1, ["composio"]);
if ((composioOff || microsoft365) && mode === "hosted" && !fresh) {
  // The Launchpad reads the root with the operator's git, from its PATH.
  const git = Bun.which("git");
  if (git === null) throw new Error("composio-off needs git");
  await symlink(git, join(home, "bin", "git"));
  await updateTools(folder, 1, ["composio"]);
  const root = join(folder, "organizations", "example_GEN3");
  const manifest = join(root, "lazurio.organization.json");
  const document = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(
    manifest,
    JSON.stringify({
      ...document,
      settings: {
        integrations: {
          ...(composioOff ? { composio: { allowed: false } } : {}),
          ...(microsoft365
            ? {
                microsoft365: {
                  tenant_id: "00000000-0000-4000-8000-0000000000aa",
                  client_id: "00000000-0000-4000-8000-0000000000bb",
                  apps: ["outlook", "one_drive", "share_point"],
                  callbacks: [
                    `https://launchpad.${host}/api/integrations/oauth/callback`,
                  ],
                },
              }
            : {}),
        },
      },
    }),
  );
  for (const args of [
    ["init", "--quiet", "--initial-branch=main"],
    ["add", "lazurio.organization.json"],
    [
      "-c",
      "user.name=Preview",
      "-c",
      "user.email=preview@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Organization settings",
    ],
  ]) {
    const git = Bun.spawn(["git", "-C", root, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
    if ((await git.exited) !== 0) throw new Error(`git ${args[0]} failed`);
  }
}
const app = await startLaunchpad(
  folder,
  undefined,
  undefined,
  undefined,
  mode === "local"
    ? {}
    : {
        // A hosted preview's gateway names a fictional person with a Lazurio
        // username, as Lazurio Auth's answer does, so Apps → Trezor
        // offers her own address (F53's addendum of 2026-10-16).
        fetcher: async () =>
          new Response("ok", {
            headers:
              mode === "hosted"
                ? {
                    "x-auth-request-user":
                      "00000000-0000-4000-8000-00000000a11a",
                    "x-auth-request-preferred-username": "jana",
                  }
                : {},
          }),
      },
  // The preview's GitHub identity answers the Owner question of the Apps
  // home ("+ Nový modul", "Přístup k modulu") and a Steward's `maintain` on
  // the example Organization's repositories by its role, and its T3 Code is a
  // fork release that takes a prompt by link and pairs with a synthetic token;
  // no real account or T3 Code is asked.
  toolsEnvironmentOf(
    {
      PATH: `${join(home, "bin")}:${join(home, ".local", "bin")}`,
      HOME: home,
    },
    process.platform,
    async (command, timeoutMs, env) =>
      command[1] === "api" &&
      command[2]?.startsWith("user/memberships/orgs/example")
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              state: "active",
              role: role === "owner" ? "admin" : "member",
            }),
            stderr: "",
          }
        : command[1] === "api" && command[2]?.startsWith("repos/example/")
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                permissions: {
                  admin: role === "owner",
                  maintain: role !== "member",
                  push: true,
                  pull: true,
                },
              }),
              stderr: "",
            }
          : command[0]?.endsWith("/gh") &&
              command.slice(1).join(" ") === "auth status --json hosts"
            ? {
                exitCode: 0,
                stdout: JSON.stringify({
                  hosts: {
                    "github.com": [
                      {
                        state: "success",
                        active: true,
                        host: "github.com",
                        login: "example-user",
                        tokenSource: "keyring",
                      },
                    ],
                  },
                }),
                stderr: "",
              }
            : // composio answers its own version (the fake's state).
              command[1] === "--version" && !command[0]?.endsWith("/composio")
              ? { exitCode: 0, stdout: "t3 v0.0.45-lazurio.2\n", stderr: "" }
              : command[1] === "auth" && command[2] === "pairing"
                ? {
                    exitCode: 0,
                    stdout: JSON.stringify({
                      credential: "PreviewPairingToken",
                    }),
                    stderr: "",
                  }
                : runTool(command, timeoutMs, env),
  ),
  {},
  undefined,
  undefined,
  { home, platform: process.platform, folder },
  undefined,
  undefined,
  // The Environment browser's people's view (decision F39): a thread's tab
  // answers a synthetic target id; nothing is opened.
  { openWindow: async () => ({ targetId: "0".repeat(32) }) },
  // The Environment vault: a hosted preview's own, otherwise this
  // process's.
  vaultHost,
  // Executor: the fake world in a Remote Environment, this computer's own on
  // a workstation (its second wave).
  executor?.host,
  // Integrace (decision F42): the fake Executor, and on a Remote
  // Environment a synthetic tab of the Environment browser.
  {
    // With the company app, Executor counts as set up here, as it is on a
    // Remote Environment once F44's setup ran.
    ...(mode === "local" || microsoft365 ? { executorPresent: true } : {}),
    executor: {
      dataDir: join(home, ".executor"),
      port: executorApi.port,
      uid: process.getuid?.() ?? 0,
      ownsListener: async () => true,
    },
    environmentBrowser:
      mode === "local"
        ? null
        : async () => ({ view: `${browserOrigin}/t/${"1".repeat(32)}` }),
  },
);
let proxy: string | null = null;
if (mode !== "local") {
  const origin = `https://launchpad.${host}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("host", `launchpad.${host}`);
      headers.set("cookie", "__Secure-lazurio-workspace=preview");
      if (request.method !== "GET" && request.method !== "HEAD") {
        headers.set("origin", origin);
        headers.set("sec-fetch-site", "same-origin");
      }
      const answer = await fetch(
        `http://127.0.0.1:${listenPort}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? null
              : await request.arrayBuffer(),
          redirect: "manual",
        },
      );
      return new Response(answer.body, {
        status: answer.status,
        headers: answer.headers,
      });
    },
  });
  proxy = `http://127.0.0.1:${server.port}`;
}
console.log(
  JSON.stringify({
    url: app.url,
    proxy,
    browser: mode === "local" ? null : browserOrigin,
    folder,
    ...(bitwarden === null ? {} : { bitwarden }),
    ...(composioSignedOut
      ? { composioApprove: join(home, ".fake-composio", "approve") }
      : {}),
  }),
);
