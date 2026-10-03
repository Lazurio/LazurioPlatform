import { expect, test } from "bun:test";
import { cp, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogSelection,
  organizationRoute,
  parseCatalog,
  routeOrganization,
} from "../src/launchpad/catalog-view";
import { startLaunchpad } from "../src/launchpad/server";
import {
  type CatalogOrganization,
  catalogModules,
  findCatalogOrganization,
  readFolderCatalog,
  repositoryPage,
} from "../src/organizations/catalog";
import { runCatalogCommand } from "../src/organizations/cli";
import { isExecutableOrganizationState } from "../src/organizations/root-resolution";
import { type CliContext, installBase } from "../src/update/cli";
import { renderLaunchpadUnit } from "../src/update/install";
import {
  folderFixture,
  writeModule,
  writeOrganization,
} from "./fixtures/catalog-folder";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

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
            forgeLogin: "alpha",
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
                teamsSource: "teams",
                apps: [
                  { package: "app/package.json", kind: "runtime-declared" },
                ],
                defaultApp: "app/package.json",
                display: { id: "web", title: "web", tags: [] },
                state: "transition",
                executable: true,
              },
              {
                organization: "alpha",
                module: "docs",
                path: "workspace/docs",
                teams: ["core"],
                teamsSource: "teams",
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
                teams: ["workspace"],
                teamsSource: "default",
                apps: [
                  { package: "app/package.json", kind: "invalid-runtime" },
                ],
                defaultApp: "app/package.json",
                state: "transition",
                executable: false,
                reason: "default-app-invalid",
                issues: ["teams-invalid"],
              },
              // A root-level application: a module like any other, at its
              // slot path, in the same one list in catalog order.
              // design-system (no module manifest), infra and
              // mission-control/db (repository slots) are not modules.
              {
                organization: "alpha",
                module: "mission-control",
                path: "mission-control",
                teams: ["core"],
                teamsSource: "teams",
                apps: [
                  { package: "app/package.json", kind: "runtime-declared" },
                ],
                defaultApp: "app/package.json",
                display: {
                  id: "mission-control",
                  title: "mission-control",
                  tags: [],
                },
                state: "transition",
                executable: true,
              },
            ],
            // Read-only production repositories, never modules, each with
            // whether it is checked out and its GitHub page. alpha's infra,
            // though declared, checked out and on GitHub, is neither a module
            // nor a production repository: it is not listed.
            repositories: [
              {
                slug: "firmware",
                path: "productionspace/firmware",
                checkedOut: true,
                url: "https://github.com/alpha/firmware",
              },
              {
                slug: "connect",
                path: "productionspace/connect",
                checkedOut: false,
                url: null,
              },
            ],
          },
          {
            directory: "beta",
            organization: "beta",
            displayName: "Beta Company",
            forgeLogin: "beta",
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
                teams: ["workspace"],
                teamsSource: "default",
                apps: [
                  { package: "app/package.json", kind: "runtime-declared" },
                ],
                defaultApp: "app/package.json",
                display: { id: "api", title: "api", tags: [] },
                state: "current",
                executable: current,
                ...(current ? {} : { reason: "organization-not-executable" }),
              },
            ],
            repositories: [],
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
            repositories: [],
          },
          {
            directory: "delta",
            organization: "delta",
            displayName: "Delta Company",
            forgeLogin: "delta",
            state: "transition",
            issues: [],
            executable: true,
            teams: [
              { slug: "core", displayName: "Core" },
              { slug: "sales", displayName: "Sales" },
            ],
            modules: (
              [
                ["crm", ["sales", "core"], "legacy-alias"],
                ["wiki", ["core"], "legacy-alias"],
                ["misc", ["workspace"], "default"],
                ["pos", ["core"], "teams"],
              ] as const
            ).map(([module, teams, teamsSource]) => ({
              organization: "delta",
              module,
              path: `workspace/${module}`,
              teams,
              teamsSource,
              apps: [],
              defaultApp: null,
              state: "transition",
              executable: false,
              reason: "no-app",
            })),
            repositories: [],
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
            repositories: [],
          },
        ],
      });
      expect(
        catalogModules(catalog).map((m) => `${m.organization}/${m.module}`),
      ).toEqual([
        "alpha/web",
        "alpha/docs",
        "alpha/shop",
        "alpha/mission-control",
        "beta/api",
        "delta/crm",
        "delta/wiki",
        "delta/misc",
        "delta/pos",
      ]);
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
      // A linked candidate is not a real directory of the checkout, named
      // by the checkout rule (decision F23), the candidate itself as `.`.
      expect(byDirectory.z).toMatchObject({
        organization: null,
        executable: false,
        reason: "directory-not-regular",
        file: ".",
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
      // The page follows the same rule: the slug shows the isolation, and only
      // the copy whose directory is not a slug has a link of its own.
      expect(
        catalogSelection(catalog, {
          view: "organization",
          organization: "BETA",
        }),
      ).toMatchObject({
        kind: "ambiguous",
        candidates: [byDirectory.beta, byDirectory["beta-copy"]],
      });
      const [beta, copy] = ["beta", "beta-copy"].map((directory) => {
        const entry = byDirectory[directory];
        if (entry === undefined) throw new Error(`No candidate ${directory}`);
        return entry;
      }) as [CatalogOrganization, CatalogOrganization];
      expect(organizationRoute(catalog, beta)).toBeNull();
      expect(organizationRoute(catalog, copy)).toBe("/o/beta-copy");
      expect(routeOrganization(catalog, "beta-copy")).toBe(
        findCatalogOrganization(catalog, "beta-copy"),
      );
      expect(byDirectory.alpha_GEN3).toMatchObject({ executable: true });
    });
  },
  30_000,
);

posixTest(
  "a root-level application is a module when declared with a module manifest, under the rules of a workspace module; repository slots and productionspace never are, and an id it shares with a workspace module is a declaration conflict",
  async () => {
    await folderFixture(async (folder) => {
      // gamma: both root-level applications beside a workspace module, in
      // declaration order, with the Teams their slots declare (none: the
      // default Team); a productionspace repository with a manifest is not
      // a module.
      const gamma = await writeOrganization(folder, "gamma", {
        slug: "gamma",
        state: "transition",
        modules: [
          { id: "design-system", path: "design-system", apps: false },
          { id: "web" },
          { id: "mission-control", path: "mission-control" },
        ],
        slots: [{ path: "productionspace/firmware", slug: "firmware" }],
      });
      await mkdir(join(gamma, "productionspace"));
      await writeModule(join(gamma, "productionspace/firmware"), "gamma", {
        id: "firmware",
      });
      // epsilon: design-system is not declared, though its directory holds a
      // valid manifest; mission-control's manifest is a link, refused by the
      // checkout rule (decision F23) with its module-relative file.
      const epsilon = await writeOrganization(folder, "epsilon", {
        slug: "epsilon",
        state: "transition",
        modules: [
          { id: "web" },
          { id: "mission-control", path: "mission-control" },
        ],
      });
      await writeModule(join(epsilon, "design-system"), "epsilon", {
        id: "design-system",
      });
      const linked = join(epsilon, "mission-control", "lazurio.module.json");
      await rename(linked, join(epsilon, "mission-control", "module.json"));
      await symlink("module.json", linked);
      // zeta: a workspace module and a root-level application declare one id;
      // neither is picked. design-system's directory is a link.
      const zeta = await writeOrganization(folder, "zeta", {
        slug: "zeta",
        state: "transition",
        modules: [
          { id: "mission-control" },
          { id: "mission-control", path: "mission-control" },
          { id: "design-system", path: "design-system" },
        ],
      });
      await rename(join(zeta, "design-system"), join(zeta, "styles"));
      await symlink("styles", join(zeta, "design-system"));
      // eta: mission-control's manifest declares another id; design-system is
      // declared and not checked out.
      const eta = await writeOrganization(folder, "eta", {
        slug: "eta",
        state: "transition",
        modules: [{ id: "mission-control", path: "mission-control" }],
        slots: [{ path: "design-system", slug: "design-system" }],
      });
      const manifest = join(eta, "mission-control", "lazurio.module.json");
      await writeFile(
        manifest,
        JSON.stringify({
          ...JSON.parse(await Bun.file(manifest).text()),
          id: "planner",
        }),
      );

      const catalog = await readFolderCatalog(folder);
      const rows = (name: string) =>
        findCatalogOrganization(catalog, name)?.modules.map((module) => [
          module.module,
          module.path,
          module.teams.join(","),
          module.executable ? "executable" : module.reason,
          ...(module.file === undefined ? [] : [module.file]),
        ]);
      expect(rows("gamma")).toEqual([
        ["design-system", "design-system", "workspace", "no-app"],
        ["web", "workspace/web", "workspace", "executable"],
        ["mission-control", "mission-control", "workspace", "executable"],
      ]);
      expect(findCatalogOrganization(catalog, "gamma")).toMatchObject({
        executable: true,
        issues: [],
      });
      expect(rows("epsilon")).toEqual([
        ["web", "workspace/web", "workspace", "executable"],
        [
          "mission-control",
          "mission-control",
          "workspace",
          "declaration-not-regular",
          "lazurio.module.json",
        ],
      ]);
      expect(rows("zeta")).toEqual([
        [
          "mission-control",
          "workspace/mission-control",
          "workspace",
          "declaration-conflict",
        ],
        [
          "mission-control",
          "mission-control",
          "workspace",
          "declaration-conflict",
        ],
        [
          "design-system",
          "design-system",
          "workspace",
          "directory-not-regular",
          ".",
        ],
      ]);
      expect(findCatalogOrganization(catalog, "zeta")?.issues).toEqual([
        "repository-id-collision",
      ]);
      // A workspace slot and a root-level slot of the same id are both
      // modules of the one list, at their own slot paths, in catalog order.
      expect(
        findCatalogOrganization(catalog, "zeta")?.modules.map(
          (module) => module.path,
        ),
      ).toEqual([
        "workspace/mission-control",
        "mission-control",
        "design-system",
      ]);
      // gamma's productionspace repository carries a module manifest and is
      // still only a read-only repository; a directory without `.git` is
      // not checked out.
      expect(findCatalogOrganization(catalog, "gamma")?.repositories).toEqual([
        {
          slug: "firmware",
          path: "productionspace/firmware",
          checkedOut: false,
          url: null,
        },
      ]);
      expect(rows("eta")).toEqual([
        [
          "mission-control",
          "mission-control",
          "workspace",
          "module-unavailable",
        ],
      ]);
      // `module list` shows the same rows, by the manifest id at the slot
      // path; infra, mission-control/db and productionspace are never there.
      const home = join(folder, "..", "home");
      await mkdir(home);
      const listed = await runCatalogCommand(
        ["module", "list", "--folder", folder, "--json"],
        cliContext(home),
      );
      const names = (
        JSON.parse(listed.text) as {
          modules: { organization: string; module: string; path: string }[];
        }
      ).modules.map((module) => `${module.organization}:${module.path}`);
      expect(names).toContain("alpha:mission-control");
      expect(names).toContain("gamma:design-system");
      for (const path of [
        "infra",
        "mission-control/db",
        "productionspace/firmware",
      ])
        expect(names.some((name) => name.endsWith(`:${path}`))).toBe(false);
      expect(names).not.toContain("alpha:design-system");
      expect(names).not.toContain("epsilon:design-system");
      expect(names).not.toContain("eta:design-system");
    });
  },
  30_000,
);

test("a repository's GitHub page is read from its declared remote, only for github.com", () => {
  for (const [remote, page] of [
    ["git@github.com:Owner/repo.git", "https://github.com/Owner/repo"],
    ["ssh://git@github.com/owner/repo", "https://github.com/owner/repo"],
    ["https://github.com/owner/re.po.git", "https://github.com/owner/re.po"],
    ["https://github.com/owner/repo/", "https://github.com/owner/repo"],
    ["https://gitlab.com/owner/repo.git", null],
    ["https://github.com/owner/repo/tree/main", null],
    ["https://github.com/owner/..", null],
    ["javascript:alert(1)", null],
    ["", null],
    [42, null],
    [undefined, null],
  ] as const)
    expect(repositoryPage(remote)).toBe(page);
});

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
      const legacyNote =
        "delta: Teams read from the legacy alias workspaces/workspace; the canonical form is module_slots[].teams.";
      expect(
        (await run(["organization", "list", "--folder", folder])).text,
      ).toBe(
        [
          "alpha    transition  4 modules  executable",
          `beta     current     1 module   ${beta}`,
          "broken   conflict    0 modules  organization-conflict",
          "delta    transition  4 modules  executable",
          "starter  current     0 modules  template-not-runtime",
          legacyNote,
        ].join("\n"),
      );
      expect((await run(["module", "list", "--folder", folder])).text).toBe(
        [
          "alpha/web              core,sales  app/package.json  executable",
          "alpha/docs             core        -                 no-app",
          "alpha/shop             workspace   app/package.json  default-app-invalid",
          "alpha/mission-control  core        app/package.json  executable",
          `beta/api               workspace   app/package.json  ${beta}`,
          "delta/crm              sales,core  -                 no-app",
          "delta/wiki             core        -                 no-app",
          "delta/misc             workspace   -                 no-app",
          "delta/pos              core        -                 no-app",
          legacyNote,
        ].join("\n"),
      );
      // The legacy alias is named once per Organization, and only for it.
      expect(
        (await run(["module", "list", "alpha", "--folder", folder])).text,
      ).not.toContain("legacy alias");
      expect(
        (await run(["module", "list", "delta", "--folder", folder])).text,
      ).toEndWith(`delta/pos   core        -  no-app\n${legacyNote}`);
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
      const supervised = cliContext(home, {
        platform: "linux",
        env: { HOME: home, XDG_CONFIG_HOME: config },
      });
      // The unit of this installation's default base, as the installer
      // writes it.
      await writeFile(
        join(config, "systemd/user/lazurio-launchpad.service"),
        renderLaunchpadUnit(installBase(supervised, undefined), folder),
      );
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
      // Seven candidates and the legacy alias note of delta.
      expect(rows).toHaveLength(8);
      expect(rows.find((row) => row.startsWith("evil"))).toStartWith(
        "evil\\u{1b}[8m  ",
      );
      const forgedRow = rows.find((row) => row.startsWith("zz"));
      expect(forgedRow).toStartWith(
        "zz\\u{a}\\u{1b}[2K\\u{d}forged-org  transition  1 module  executable  ",
      );
      expect(forgedRow).not.toEndWith("executable");

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
        const value = await answer.json();
        expect(value).toEqual(JSON.parse(cli.text));
        // The page draws exactly this answer: its shape check admits it,
        // with the read-only production repositories; infra is not one.
        const parsed = parseCatalog(value);
        expect(parsed).not.toBeNull();
        expect(
          parsed?.organizations[0]?.repositories.map((entry) => entry.slug),
        ).toEqual(["firmware", "connect"]);
        expect(JSON.stringify(value)).not.toContain('"layout"');
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
          "delta",
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
