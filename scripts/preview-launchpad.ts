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
// with a synthetic token, and a fake `composio` signed in with two accounts:
// a direct sign-in finishes by itself after a few seconds and a Composio link
// at once (the window they open shows nothing real). Locally that fake
// stands in for a Remote Environment's Executor, so the page shows the
// direct paths (decision F44 installs none on a computer); in a Remote
// Environment the page follows Settings → Tools → executor, as in
// production. With `composio-off` anywhere after the mode, a hosted
// preview's example Organization does not allow Composio (root decision
// 0194, decision F45): its root becomes a Git checkout whose `main` says so,
// which the Launchpad reads as on an Organization's Environment without the
// relay, so Settings → Tools shows Composio's switch locked. Synthetic names
// only; stop it with Ctrl-C.
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
import { startLaunchpad } from "../src/launchpad/server";
import { toolsEnvironmentOf } from "../src/tools/overview";
import { runTool } from "../src/tools/status";
import {
  writeModule,
  writeOrganization,
} from "../tests/fixtures/catalog-folder";
import { executorWorld } from "../tests/fixtures/fake-executor";
import { startFakeExecutor } from "../tests/fixtures/fake-executor-api";
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
    mode === "personal" ? "hosted-personal" : "hosted-organization-personal";
  await initializeHandoverFolder(folder, {
    preset,
    machine:
      mode === "personal"
        ? personalWithEntry(listenPort, true)
        : organizationWithEntry(listenPort, host, true),
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
// Integrace (decision F42): a fake composio signed in, two accounts, and
// a fake Executor with Executor's token file of a synthetic token.
await writeFile(
  join(home, "bin", "composio"),
  `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${join(import.meta.dir, "..", "tests", "fixtures", "fake-composio.ts")}' "$@"\n`,
  { mode: 0o755 },
);
await mkdir(join(home, ".fake-composio"), { recursive: true, mode: 0o700 });
await writeFile(
  join(home, ".fake-composio", "state.json"),
  JSON.stringify({
    signedIn: true,
    removeYes: false,
    next: 100,
    activateOnLink: true,
    accounts: [
      {
        id: "ca_1",
        toolkit: "salesforce",
        status: "ACTIVE",
        alias: null,
        word_id: "castle",
      },
      {
        id: "ca_2",
        toolkit: "zoom",
        status: "EXPIRED",
        alias: null,
        word_id: "river",
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
        template: "header",
        identityLabel: null,
        health: null,
      },
    ],
  },
  4_000,
);
for (const endpoint of [
  "https://mcp.linear.app/mcp",
  "https://mcp.clickup.com/mcp",
  "https://mcp.figma.com/mcp",
])
  executorApi.probes.set(endpoint, { requiresOAuth: true });
executorApi.probes.set("https://mcp.deepwiki.com/mcp", {
  requiresOAuth: false,
});
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
if (mode === "local") await updateTools(folder, 1, ["composio"]);
if (composioOff && mode === "hosted" && !fresh) {
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
      settings: { integrations: { composio: { allowed: false } } },
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
  mode === "local" ? {} : { fetcher: async () => new Response("ok") },
  // The preview's GitHub identity answers the Owner question of the Apps
  // home ("+ Nový modul", "Přístup k modulu") and a Steward's `maintain` on
  // the example Organization's repositories by its role, and its T3 Code is a
  // fork release that takes a prompt by link and pairs with a synthetic token;
  // no real account or T3 Code is asked.
  toolsEnvironmentOf(
    {
      PATH:
        executor === undefined
          ? join(home, "bin")
          : `${join(home, "bin")}:${join(home, ".local", "bin")}`,
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
            : command[1] === "--version"
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
  // The Environment vault: this process's.
  undefined,
  // Executor: the fake world in a Remote Environment, this computer's own on
  // a workstation (its second wave).
  executor?.host,
  // Integrace (decision F42): the fake Executor, and on a Remote
  // Environment a synthetic tab of the Environment browser.
  {
    ...(mode === "local" ? { executorPresent: true } : {}),
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
  }),
);
