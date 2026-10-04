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
// the entry's origin through. Synthetic names only; stop it with Ctrl-C.
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
import { startLaunchpad } from "../src/launchpad/server";
import { toolsEnvironmentOf } from "../src/tools/overview";
import { runTool } from "../src/tools/status";
import {
  writeModule,
  writeOrganization,
} from "../tests/fixtures/catalog-folder";
import {
  organizationWithEntry,
  personalWithEntry,
} from "../tests/fixtures/machine-bindings";

const mode =
  process.argv[2] === "hosted" || process.argv[2] === "personal"
    ? process.argv[2]
    : "local";
const fresh = process.argv[6] === "fresh";
const locale = process.argv[3] === "en" ? "en" : "cs";
const listenPort = Number(process.argv[4] ?? 24611);
const role =
  process.argv[5] === "steward" || process.argv[5] === "member"
    ? process.argv[5]
    : "owner";
const host =
  mode === "personal" ? "example.lazurio.io" : "vm-01.example.lazurio.io";
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
        ? personalWithEntry(listenPort)
        : organizationWithEntry(listenPort, host),
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
    { PATH: join(home, "bin"), HOME: home },
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
          : command[1] === "--version"
            ? { exitCode: 0, stdout: "t3 v0.0.45-lazurio.2\n", stderr: "" }
            : command[1] === "auth" && command[2] === "pairing"
              ? {
                  exitCode: 0,
                  stdout: JSON.stringify({ credential: "PreviewPairingToken" }),
                  stderr: "",
                }
              : runTool(command, timeoutMs, env),
  ),
  {},
  undefined,
  undefined,
  { home, platform: process.platform, folder },
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
console.log(JSON.stringify({ url: app.url, proxy, folder }));
