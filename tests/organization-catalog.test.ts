import { expect, test } from "bun:test";
import { cp, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import {
  catalogModules,
  findCatalogOrganization,
  readFolderCatalog,
} from "../src/organizations/catalog";
import { runCatalogCommand } from "../src/organizations/cli";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import { isExecutableOrganizationState } from "../src/organizations/root-resolution";
import type { CliContext } from "../src/update/cli";
import { unitMarker } from "../src/update/service-control";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

type Slot = { path: string; slug?: string; teams?: unknown };
type ModuleFixture = {
  id: string;
  teams?: unknown;
  // An app-less module declares no app and no port.
  apps?: boolean;
  // The runtime declaration is missing, so the default app is invalid.
  broken?: boolean;
};

function canonicalDocument(
  slug: string,
  kind: "organization" | "template",
  teams: { slug: string; display_name: string }[],
  locator = slug,
) {
  return {
    schema_version: "lazurio.organization.v1",
    kind,
    organization: {
      slug,
      display_name: `${slug[0]?.toUpperCase()}${slug.slice(1)} Company`,
      metadata: {},
      forge_binding: {
        forge: "github",
        locator,
        binding_state: "unverified",
      },
    },
    manifests: { modules: "modules.manifest.json" },
    extensions: { legacy: {} },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
    ...(teams.length === 0 ? {} : { teams }),
  };
}

let port = 4400;
// One Organization root in <Folder>/organizations/<directory>: canonical
// documents, the exact projection for `transition`, none for `current`.
async function writeOrganization(
  folder: string,
  directory: string,
  options: {
    slug: string;
    state: "transition" | "current";
    kind?: "organization" | "template";
    teams?: { slug: string; display_name: string }[];
    modules: ModuleFixture[];
    // The GitHub login, when the slug is not one.
    forge?: string;
  },
) {
  const root = join(folder, "organizations", directory);
  await mkdir(root, { recursive: true });
  const inventory = {
    company: options.slug,
    github_org: options.forge ?? options.slug,
    module_slots: options.modules.map((module) => {
      const slot: Slot = { path: `workspace/${module.id}`, slug: module.id };
      if (module.teams !== undefined) slot.teams = module.teams;
      return slot;
    }),
  };
  const document = canonicalDocument(
    options.slug,
    options.kind ?? "organization",
    options.teams ?? [],
    options.forge,
  );
  const expected = expectedLegacyProjection(document, inventory);
  document.compatibility.legacy_projection.sha256 = expected.hash;
  await writeFile(
    join(root, "lazurio.organization.json"),
    JSON.stringify(document),
  );
  await writeFile(
    join(root, "modules.manifest.json"),
    JSON.stringify(inventory),
  );
  if (options.state === "transition")
    await writeFile(
      join(root, "company.gen3.json"),
      JSON.stringify(expected.projection),
    );
  for (const module of options.modules) {
    const path = join(root, "workspace", module.id);
    await mkdir(join(path, "app"), { recursive: true });
    const apps = module.apps !== false;
    await writeFile(
      join(path, "lazurio.module.json"),
      JSON.stringify({
        schema_version: "lazurio.module.v1",
        id: module.id,
        company: options.slug,
        tcp_port_policy: { mode: apps ? "single" : "none" },
        port_leases: apps
          ? [{ id: "main", host: "127.0.0.1", port: port++ }]
          : [],
        apps: apps ? ["app/package.json"] : [],
        ...(apps ? { default_app: "app/package.json" } : {}),
      }),
    );
    if (!apps) continue;
    await writeFile(
      join(path, "app/package.json"),
      JSON.stringify({
        name: `fixture-${module.id}`,
        scripts: { dev: "must never execute" },
        ...(module.broken
          ? {}
          : {
              lazurio: {
                runtime: {
                  schema_version: "lazurio.runtime.v1",
                  id: module.id,
                  title: module.id,
                  company: options.slug,
                  module: module.id,
                  surface: "internal",
                  dev_script: "dev",
                  tags: [],
                  listeners: [
                    {
                      id: "web",
                      role: "entrypoint",
                      lease: "main",
                      protocol: "http",
                      health: { kind: "http", path: "/" },
                    },
                  ],
                },
              },
            }),
      }),
    );
  }
  return root;
}

// The fixture Folder of the slice: two Organizations (one `transition` with a
// module in two Teams, one canonical-only `current`), one invalid, one
// template, a file and a hidden directory that are not candidates.
async function folderFixture(run: (folder: string) => Promise<void>) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "catalog-")));
  const folder = join(parent, "Lazurio");
  try {
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    // folder-init creates organizations/ (and nothing in it).
    await writeOrganization(folder, "alpha_GEN3", {
      slug: "alpha",
      state: "transition",
      teams: [
        { slug: "core", display_name: "Core" },
        { slug: "sales", display_name: "Sales" },
      ],
      modules: [
        { id: "web", teams: ["core", "sales"] },
        { id: "docs", teams: ["core"], apps: false },
        { id: "shop", teams: "sales", broken: true },
      ],
    });
    await writeOrganization(folder, "beta", {
      slug: "beta",
      state: "current",
      modules: [{ id: "api" }],
    });
    const broken = await writeOrganization(folder, "broken", {
      slug: "broken",
      state: "transition",
      modules: [{ id: "web" }],
    });
    await writeFile(join(broken, "modules.manifest.json"), "{ not json");
    await writeOrganization(folder, "starter", {
      slug: "starter",
      state: "current",
      kind: "template",
      modules: [{ id: "web" }],
    });
    await writeFile(join(folder, "organizations/README.md"), "not a root");
    await mkdir(join(folder, "organizations/.cache"));
    await run(folder);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const current = isExecutableOrganizationState("current");

posixTest(
  "the catalog lists every candidate, isolates failures with typed reasons and groups modules in Teams N:M",
  async () => {
    await folderFixture(async (folder) => {
      const catalog = await readFolderCatalog(folder);
      expect(catalog).toEqual({
        kind: "catalog",
        organizations: [
          {
            directory: "alpha_GEN3",
            organization: "alpha",
            displayName: "Alpha Company",
            state: "transition",
            issues: [],
            executable: true,
            teams: [
              { slug: "core", displayName: "Core" },
              { slug: "sales", displayName: "Sales" },
            ],
            modules: [
              {
                organization: "alpha",
                module: "web",
                path: "workspace/web",
                teams: ["core", "sales"],
                apps: [
                  { package: "app/package.json", kind: "runtime-declared" },
                ],
                defaultApp: "app/package.json",
                state: "transition",
                executable: true,
              },
              {
                organization: "alpha",
                module: "docs",
                path: "workspace/docs",
                teams: ["core"],
                apps: [],
                defaultApp: null,
                state: "transition",
                executable: false,
                reason: "no-app",
              },
              {
                organization: "alpha",
                module: "shop",
                path: "workspace/shop",
                teams: [],
                apps: [
                  { package: "app/package.json", kind: "invalid-runtime" },
                ],
                defaultApp: "app/package.json",
                state: "transition",
                executable: false,
                reason: "default-app-invalid",
                issues: ["teams-invalid"],
              },
            ],
          },
          {
            directory: "beta",
            organization: "beta",
            displayName: "Beta Company",
            state: "current",
            issues: [],
            executable: current,
            ...(current ? {} : { reason: "organization-not-executable" }),
            teams: [],
            modules: [
              {
                organization: "beta",
                module: "api",
                path: "workspace/api",
                teams: [],
                apps: [
                  { package: "app/package.json", kind: "runtime-declared" },
                ],
                defaultApp: "app/package.json",
                state: "current",
                executable: current,
                ...(current ? {} : { reason: "organization-not-executable" }),
              },
            ],
          },
          {
            directory: "broken",
            organization: null,
            displayName: null,
            state: "conflict",
            issues: ["modules_document_unreadable"],
            executable: false,
            reason: "organization-conflict",
            teams: [],
            modules: [],
          },
          {
            directory: "starter",
            organization: null,
            displayName: null,
            state: "current",
            issues: [],
            executable: false,
            reason: "template-not-runtime",
            teams: [],
            modules: [],
          },
        ],
      });
      expect(
        catalogModules(catalog).map((m) => `${m.organization}/${m.module}`),
      ).toEqual(["alpha/web", "alpha/docs", "alpha/shop", "beta/api"]);
      // By slug (case-insensitive, as GitHub) or by directory name.
      expect(findCatalogOrganization(catalog, "ALPHA")?.directory).toBe(
        "alpha_GEN3",
      );
      expect(findCatalogOrganization(catalog, "broken")?.reason).toBe(
        "organization-conflict",
      );
      expect(findCatalogOrganization(catalog, "nobody")).toBeUndefined();
    });
  },
  30_000,
);

posixTest(
  "a linked or foreign candidate and a duplicated slug are isolated; the rest stays listed",
  async () => {
    await folderFixture(async (folder) => {
      const organizations = join(folder, "organizations");
      await cp(join(organizations, "beta"), join(organizations, "beta-copy"), {
        recursive: true,
      });
      await symlink(
        join(organizations, "alpha_GEN3"),
        join(organizations, "z"),
      );
      const catalog = await readFolderCatalog(folder);
      const byDirectory = Object.fromEntries(
        catalog.organizations.map((entry) => [entry.directory, entry]),
      );
      expect(byDirectory.z).toMatchObject({
        organization: null,
        executable: false,
        reason: "organization-unavailable",
        modules: [],
      });
      for (const directory of ["beta", "beta-copy"])
        expect(byDirectory[directory]).toMatchObject({
          organization: "beta",
          executable: false,
          reason: "organization-duplicate",
          modules: [
            {
              module: "api",
              executable: false,
              reason: "organization-duplicate",
            },
          ],
        });
      expect(findCatalogOrganization(catalog, "beta")).toBeUndefined();
      expect(byDirectory.alpha_GEN3).toMatchObject({ executable: true });
    });
  },
  30_000,
);

posixTest(
  "a Folder without organizations/ has an empty catalog; an unowned Folder is refused",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "catalog-")));
    try {
      expect(await readFolderCatalog(parent)).toEqual({
        kind: "catalog",
        organizations: [],
      });
      await expect(readFolderCatalog("relative")).rejects.toThrow();
      await expect(
        readFolderCatalog(join(parent, "missing")),
      ).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

function cliContext(
  home: string,
  input: Partial<Pick<CliContext, "platform" | "env" | "hostedFolder">> = {},
): CliContext {
  return {
    identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
    platform: input.platform ?? process.platform,
    env: input.env ?? { HOME: home },
    executable: join(home, "lazurio"),
    hostedFolder: input.hostedFolder ?? (async () => undefined),
  };
}

posixTest(
  "organization list and module list: JSON, aligned columns, exit codes and the Folder lookup of lazurio update",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const context = cliContext(home);
      const run = (args: string[], ctx = context) =>
        runCatalogCommand(args, ctx);
      const catalog = await readFolderCatalog(folder);

      const organizations = await run([
        "organization",
        "list",
        "--folder",
        folder,
        "--json",
      ]);
      expect(organizations.code).toBe(0);
      expect(JSON.parse(organizations.text)).toEqual(
        JSON.parse(JSON.stringify(catalog)),
      );
      const beta = current ? "executable" : "organization-not-executable";
      expect(
        (await run(["organization", "list", "--folder", folder])).text,
      ).toBe(
        [
          "alpha    transition  3 modules  executable",
          `beta     current     1 module   ${beta}`,
          "broken   conflict    0 modules  organization-conflict",
          "starter  current     0 modules  template-not-runtime",
        ].join("\n"),
      );
      expect((await run(["module", "list", "--folder", folder])).text).toBe(
        [
          "alpha/web   core,sales  app/package.json  executable",
          "alpha/docs  core        -                 no-app",
          "alpha/shop  -           app/package.json  default-app-invalid",
          `beta/api    -           app/package.json  ${beta}`,
        ].join("\n"),
      );
      const alpha = await run([
        "module",
        "list",
        "alpha",
        "--folder",
        folder,
        "--json",
      ]);
      expect(JSON.parse(alpha.text)).toEqual({
        kind: "module-list",
        organization: "alpha",
        modules: JSON.parse(JSON.stringify(catalog.organizations[0]?.modules)),
      });
      expect(
        (await run(["module", "list", "broken", "--folder", folder])).text,
      ).toBe("broken: organization-conflict");
      expect(
        await run(["module", "list", "nobody", "--folder", folder, "--json"]),
      ).toMatchObject({
        code: 2,
        result: { kind: "blocked", reason: "organization-unknown" },
      });

      // No --folder: the supervised unit's `[X-Lazurio] Folder=` line.
      const config = join(home, "config");
      await mkdir(join(config, "systemd/user"), { recursive: true });
      await writeFile(
        join(config, "systemd/user/lazurio-launchpad.service"),
        `${unitMarker}\n[Service]\nExecStart=/bin/true\n\n[X-Lazurio]\nFolder=${folder}\n`,
      );
      const supervised = cliContext(home, {
        platform: "linux",
        env: { HOME: home, XDG_CONFIG_HOME: config },
      });
      expect(
        JSON.parse(
          (await run(["organization", "list", "--json"], supervised)).text,
        ),
      ).toEqual(JSON.parse(organizations.text));
      // Otherwise, on a hosted Machine, the declared operator's Folder.
      const hosted = cliContext(home, { hostedFolder: async () => folder });
      expect((await run(["organization", "list", "--json"], hosted)).text).toBe(
        organizations.text,
      );
      // Neither: nothing is guessed.
      expect(await run(["organization", "list", "--json"])).toMatchObject({
        code: 2,
        result: { kind: "blocked", reason: "folder-unknown" },
      });
      expect(
        await run([
          "organization",
          "list",
          "--folder",
          join(folder, "missing"),
        ]),
      ).toMatchObject({ code: 1, result: { reason: "folder-unreadable" } });
      // The product entry point prints the same and exits with the code.
      const cli = async (args: string[]) => {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
          {
            env: { HOME: home, PATH: join(home, "bin") },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      };
      expect(
        await cli(["organization", "list", "--folder", folder, "--json"]),
      ).toEqual({ code: 0, stdout: `${organizations.text}\n`, stderr: "" });
      expect(
        await cli(["module", "list", "nobody", "--folder", folder]),
      ).toMatchObject({
        code: 2,
      });
      const usage = await cli(["organization", "show"]);
      expect(usage.code).toBe(2);
      expect(usage.stderr).toContain("organization list [--folder");
      for (const args of [
        ["organization"],
        ["organization", "list", "alpha"],
        ["module", "list", "a", "b"],
        ["module", "show"],
        ["organization", "list", "--folder", "relative"],
        ["organization", "list", "--json", "--json"],
        ["organization", "list", "--other"],
      ])
        await expect(run(args)).rejects.toThrow("Usage");
    });
  },
  30_000,
);

posixTest(
  "the terminal columns show a slug or directory name with control characters as visible escapes",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      // A slug written by an Organization repository's members and a
      // directory name under organizations/: neither may drive the terminal.
      await writeOrganization(folder, "evil", {
        slug: "evil\u001b[8m",
        forge: "evil",
        state: "transition",
        modules: [{ id: "web" }],
      });
      const forged =
        "zz\n\u001b[2K\rforged-org  transition  1 module  executable";
      await mkdir(join(folder, "organizations", forged));
      const run = (args: string[]) =>
        runCatalogCommand([...args, "--folder", folder], cliContext(home));
      const control = /(?!\n)\p{Cc}/u;

      const organizations = (await run(["organization", "list"])).text;
      expect(organizations).not.toMatch(control);
      const rows = organizations.split("\n");
      expect(rows).toHaveLength(6);
      expect(rows.find((row) => row.startsWith("evil"))).toStartWith(
        "evil\\u{1b}[8m  ",
      );
      expect(rows.at(-1)).toStartWith(
        "zz\\u{a}\\u{1b}[2K\\u{d}forged-org  transition  1 module  executable  ",
      );
      expect(rows.at(-1)).not.toEndWith("executable");

      const modules = (await run(["module", "list"])).text;
      expect(modules).not.toMatch(control);
      expect(modules).toContain("evil\\u{1b}[8m/web  ");
      const named = (await run(["module", "list", forged])).text;
      expect(named).not.toMatch(control);
      expect(named).toStartWith("zz\\u{a}\\u{1b}[2K\\u{d}forged-org");
      // JSON keeps the exact text; JSON.stringify escapes it by itself.
      expect(
        JSON.parse((await run(["organization", "list", "--json"])).text)
          .organizations,
      ).toContainEqual(
        expect.objectContaining({ organization: "evil\u001b[8m" }),
      );
    });
  },
  30_000,
);

posixTest(
  "the Launchpad's catalog route answers the same list as the CLI, behind the same admission",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const app = await startLaunchpad(folder);
      const session = new URL(app.url);
      const call = (body: unknown, override = {}) =>
        fetch(new URL("/api/catalog", session), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: session.origin,
            Authorization: `Bearer ${session.hash.slice(1)}`,
            ...override,
          },
          body: JSON.stringify(body),
        });
      try {
        const cli = await runCatalogCommand(
          ["organization", "list", "--folder", folder, "--json"],
          cliContext(home),
        );
        const answer = await call({});
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual(JSON.parse(cli.text));
        // The same admission as every other route; no path from the browser.
        expect((await call({}, { Authorization: "" })).status).toBe(403);
        expect(
          (await call({}, { Origin: "https://foreign.invalid" })).status,
        ).toBe(403);
        expect((await call({ folder: "/elsewhere" })).status).toBe(400);
        expect(
          (
            await fetch(new URL("/api/catalog", session), {
              headers: {
                Authorization: `Bearer ${session.hash.slice(1)}`,
              },
            })
          ).status,
        ).toBe(405);
        // Recomputed on every read: a new Organization appears without state.
        await writeOrganization(folder, "gamma", {
          slug: "gamma",
          state: "transition",
          modules: [{ id: "site" }],
        });
        const again = (await (await call({})).json()) as {
          organizations: { directory: string }[];
        };
        expect(again.organizations.map((entry) => entry.directory)).toEqual([
          "alpha_GEN3",
          "beta",
          "broken",
          "gamma",
          "starter",
        ]);
      } finally {
        expect((await app.close()).kind).toBe("closed");
      }
    });
  },
  30_000,
);
