import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { parseModuleManifest } from "../src/modules/manifest";
import { parsePreparationDeclaration } from "../src/modules/preparation-declaration";
import { readModuleApplication } from "../src/modules/read-application";
import { parseAppRuntime } from "../src/modules/runtime";
import {
  defaultScaffoldVersions,
  environmentPorts,
  insertModulePortPoolText,
  insertModuleSlotText,
  ModuleScaffoldError,
  type ModuleScaffoldInput,
  type ModuleScaffoldPlan,
  type ModuleSlot,
  moduleScaffoldDefaultPort,
  moduleScaffoldLayers,
  moduleScaffoldStacks,
  moduleScaffoldTreeHash,
  personalModulePortPool,
  planModuleScaffold,
  reservedModuleSlugs,
  scaffoldBunVersion,
  templateTargetPath,
} from "../src/modules/scaffold";
import { moduleTemplates } from "../src/modules/scaffold-templates";
import { readFolderCatalog } from "../src/organizations/catalog";
import { heldBy } from "./fixtures/catalog-folder";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import {
  personalspaceTemplateManifest,
  personalspaceTemplateSlots,
} from "./fixtures/personalspace-template";

// The single module generator (decision F52), ported from the root's
// `lazurio/module-scaffold.test.mjs` at HumanAndMachines/Lazurio a5615be0:
// the same plans, ports, refusals and slot insert, the Organization form
// byte for byte equal to the root's, and the personal form. Where the root
// measured a generated module with `lazurio module setup`, which the Platform
// does not have yet (#423), these tests check what the Platform itself reads:
// the module manifest, each app's runtime and preparation, and the catalog.
// Synthetic names only.

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
const versions = { bun: scaffoldBunVersion, ...defaultScaffoldVersions };
const pool = { start: 24_000, end: 24_099 };
const organization = {
  kind: "organization",
  slug: "Acme",
  githubOrg: "AcmeHQ",
  teams: ["core", "web"],
} as const;

function plan(overrides: Partial<ModuleScaffoldInput> = {}) {
  return planModuleScaffold({
    owner: organization,
    slug: "portal",
    stack: "vite-react",
    pool,
    existingSlots: [{ path: "workspace/Billing", slug: "billing" }],
    takenPorts: [24_000],
    templates: moduleTemplates,
    versions,
    ...overrides,
  });
}

// A person's module in their Personalspace, which still declares the
// template's example slot (as `lazurio personalspace install` leaves it, #377).
function personal(overrides: Partial<ModuleScaffoldInput> = {}) {
  return planModuleScaffold({
    owner: { kind: "personal", login: "example" },
    slug: "notes",
    stack: "vite-react",
    pool: personalModulePortPool,
    existingSlots: personalspaceTemplateSlots,
    takenPorts: [],
    templates: moduleTemplates,
    versions,
    ...overrides,
  });
}

function expectCode(run: () => unknown, code: string) {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ModuleScaffoldError);
  expect((error as ModuleScaffoldError).code).toBe(code as never);
  return error as ModuleScaffoldError;
}

function file(result: ModuleScaffoldPlan, path: string): string {
  const entry = result.files.find((item) => item.path === path);
  if (!entry) throw new Error(`${path} is not in the plan`);
  return entry.content;
}

// planModuleScaffold of HumanAndMachines/Lazurio a5615be0 over its own
// templates, for the same input as `plan()` (Acme, AcmeHQ, the pool
// 24000-24099, billing on 24000, the slug portal): the port keeps it. The
// three static stacks have since declared their build output (decision F58:
// `build_output`, for vite-react `static_fallback`, and a line of their
// README), so their hashes are the root's plus that change; the root's
// were 1fcd5e2d… (vite-react), 6050c38e… (astro) and a01509c8…
// (astro-starlight).
const rootTreeHashes: Readonly<Record<string, string>> = {
  "vite-react":
    "sha256:ddb885f15b4ab0c9842105577d9af046c06457a4cf3690c21ad9e203d899e22a",
  astro:
    "sha256:ed2e5210f264c4f3e33c85bba507bf61513f8350637ff12f8a7c85107610b5e0",
  "astro-starlight":
    "sha256:43278ddd5c38c9e05b8e399346aa831c3f22aa9bbd9ffe0e41e3c47ffb94fc2f",
  "bun-service":
    "sha256:ac73b3f7f89ad96ea20ddff7a2dc0c6e3d5b5960db7e62a4c81113e04da91cda",
  "python-uv":
    "sha256:4d7a1b232566a7d6f33be9fd92f342a943b4933c996a24fa4f657e0ba075be6f",
  none: "sha256:3b74e3ee30ce43eba0122a216fa9076c5bd6883cf0617cf8c2acab93458babba",
};

describe("planModuleScaffold, the Organization form", () => {
  test("an Organization's plan equals the root's at a5615be0, file for file", () => {
    for (const stack of moduleScaffoldStacks)
      expect(plan({ stack }).treeHash, stack).toBe(
        rootTreeHashes[stack] as string,
      );
    expect(
      plan({ displayName: "Zákaznický portál", teams: ["web"] }).treeHash,
    ).toBe(
      "sha256:2d8832d73bfbf574a8ef3f25341a93be81725eb36be42c014c8034c81b668fd6",
    );
  });

  test("is deterministic and hashes the sorted tree", () => {
    const first = plan({ displayName: "Zákaznický portál", teams: ["web"] });
    const second = plan({ displayName: "Zákaznický portál", teams: ["web"] });
    expect(second).toEqual(first);
    expect(first.treeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(moduleScaffoldTreeHash([...first.files].reverse())).toBe(
      first.treeHash,
    );
    expect(first.files.map((entry) => entry.path)).toEqual(
      [...first.files.map((entry) => entry.path)].sort(),
    );
    expect(
      plan({ displayName: "Jiný portál", teams: ["web"] }).treeHash,
    ).not.toBe(first.treeHash);
    expect(first.scope).toBe("organization");
    expect(first.owner).toBe("Acme");
    expect(first.generatedByInstall).toEqual(["app/v1/bun.lock"]);
  });

  test("allocates the slug-derived free pool port and writes the exact slot", () => {
    const result = plan({ displayName: "Zákaznický portál", teams: ["web"] });
    expect(result.lease).toEqual({
      id: "main",
      host: "127.0.0.1",
      port: 24_009,
    });
    expect(result.slot).toEqual({
      path: "workspace/portal",
      slug: "portal",
      space: "workspace",
      teams: ["web"],
      category: "application",
      default_access: "expected",
      required_roles: ["*"],
      source_of_truth: "git-native",
      status: "active",
      notes:
        "Zákaznický portál: Modul založený příkazem lazurio module create (stack vite-react).",
      git: { url: "git@github.com:AcmeHQ/portal.git", branch: "main" },
    });
    expect(JSON.parse(file(result, "lazurio.module.json"))).toEqual({
      schema_version: "lazurio.module.v1",
      id: "portal",
      company: "Acme",
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port: 24_009 }],
      apps: ["app/v1/package.json"],
      default_app: "app/v1/package.json",
    });
    expect(plan({ port: 24_050 }).lease?.port).toBe(24_050);
    expect(plan().slot.teams).toBeUndefined();
  });

  test("two different slugs against the same state get different ports", () => {
    // Two work branches cannot see each other's unmerged module; the default
    // starts at pool.start + (sha256(slug)[0..4] mod pool size), so they do
    // not both take the lowest free port. Exact values pin the algorithm.
    expect(plan({ slug: "portal" }).lease?.port).toBe(24_009);
    expect(plan({ slug: "crm" }).lease?.port).toBe(24_003);
    expect(plan({ slug: "helpdesk" }).lease?.port).toBe(24_027);
    // The hashed start is taken: walk forward to the next free port.
    expect(
      plan({ slug: "portal", takenPorts: [24_000, 24_009, 24_010] }).lease
        ?.port,
    ).toBe(24_011);
  });

  test("the default port wraps around from the pool end to the pool start", () => {
    // "wiki" hashes to offset 96; 24096-24099 are taken, 24000 is billing's.
    expect(
      plan({
        slug: "wiki",
        takenPorts: [24_000, 24_096, 24_097, 24_098, 24_099],
      }).lease?.port,
    ).toBe(24_001);
    expect(moduleScaffoldDefaultPort("wiki", pool)).toBe(24_096);
    expect(
      moduleScaffoldDefaultPort(
        "wiki",
        pool,
        new Set([24_096, 24_097, 24_098, 24_099, 24_000]),
      ),
    ).toBe(24_001);
    expect(
      moduleScaffoldDefaultPort(
        "wiki",
        { start: 24_000, end: 24_000 },
        new Set([24_000]),
      ),
    ).toBeNull();
  });

  test("the same input gives the same port and tree hash; the port changes the hash", () => {
    for (const slug of ["portal", "crm", "wiki"]) {
      const first = plan({ slug });
      const second = plan({ slug });
      expect(second.lease).toEqual(first.lease);
      expect(second.treeHash).toBe(first.treeHash);
    }
    expect(plan({ slug: "portal" }).treeHash).not.toBe(
      plan({ slug: "portal", port: 24_050 }).treeHash,
    );
  });

  test("the none stack is the no-app module without a lease even without a pool", () => {
    const result = plan({ stack: "none", pool: null });
    expect(JSON.parse(file(result, "lazurio.module.json"))).toEqual({
      schema_version: "lazurio.module.v1",
      id: "portal",
      company: "Acme",
      tcp_port_policy: { mode: "none" },
      port_leases: [],
      apps: [],
    });
    expect(result.lease).toBeNull();
    expect(result.slot.category).toBe("workspace");
    expect(file(result, "README.md")).toContain(
      "lazurio module setup <cesta k Modulu> --root <Lazurio root> --json",
    );
  });

  test("a guest Module of another Organization never takes a slug of the host's own (DEV-6694)", () => {
    const guest = {
      path: "workspace/HomeOrg_GEN3/knowledgebase",
      slug: "knowledgebase",
      home_organization: "HomeOrg",
    };
    expect(
      plan({ slug: "knowledgebase", existingSlots: [guest] }).modulePath,
    ).toBe("workspace/knowledgebase");
    expectCode(
      () =>
        plan({
          slug: "knowledgebase",
          existingSlots: [
            guest,
            { path: "workspace/knowledgebase", slug: "knowledgebase" },
          ],
        }),
      "slot_exists",
    );
  });
});

describe("planModuleScaffold, every stack", () => {
  test("renders without leftover placeholders, with the runtime and preparation the Platform reads", () => {
    for (const owner of ["organization", "personal"] as const)
      for (const stack of moduleScaffoldStacks) {
        const result =
          owner === "organization"
            ? plan({ stack, slug: `x-${stack}` })
            : personal({ stack, slug: `x-${stack}` });
        const label = `${owner} ${stack}`;
        for (const entry of result.files) {
          expect(entry.content.includes("{{"), `${label}: ${entry.path}`).toBe(
            false,
          );
          expect(
            entry.path.includes("{{") ||
              entry.path.endsWith(".tmpl") ||
              /(^|\/)dot-/.test(entry.path),
            label,
          ).toBe(false);
        }
        const paths = result.files.map((entry) => entry.path);
        expect(paths, label).toEqual(
          expect.arrayContaining([
            "AGENTS.md",
            "README.md",
            ".gitignore",
            "lazurio.module.json",
          ]),
        );
        const manifest = parseModuleManifest(
          JSON.parse(file(result, "lazurio.module.json")),
        );
        expect(manifest.company, label).toBe(
          owner === "organization" ? "Acme" : "example",
        );
        if (stack === "none") {
          expect(paths, label).toEqual([
            ".gitignore",
            "AGENTS.md",
            "README.md",
            "lazurio.module.json",
          ]);
          expect(result.lease).toBeNull();
          expect(result.generatedByInstall).toEqual([]);
          continue;
        }
        expect(paths, label).toEqual(
          expect.arrayContaining([
            ".github/workflows/check.yml",
            "app/v1/package.json",
          ]),
        );
        const packageJson = JSON.parse(file(result, "app/v1/package.json"));
        expect(packageJson.packageManager).toBe(`bun@${scaffoldBunVersion}`);
        const runtime = parseAppRuntime(packageJson.lazurio.runtime);
        expect(runtime.id, label).toBe(
          `${owner === "organization" ? "acme" : "personalspace"}-x-${stack}-v1`,
        );
        expect(runtime.company, label).toBe(manifest.company);
        expect(packageJson.scripts.check).toBeString();
        expect(packageJson.scripts.test).toBeString();
        if (stack === "python-uv") {
          expect(packageJson.lazurio.preparation).toMatchObject({
            runtime: "uv",
            uv_version: defaultScaffoldVersions.uv,
          });
          // What the plan's warning says: this Platform does not read the uv
          // preparation yet (DEV-6634 W0-5).
          expect(() =>
            parsePreparationDeclaration(packageJson.lazurio.preparation),
          ).toThrow();
          expect(result.generatedByInstall).toEqual(["app/v1/uv.lock"]);
          expect(result.warnings[0]).toContain("uv preparation");
        } else {
          parsePreparationDeclaration(packageJson.lazurio.preparation);
          expect(packageJson.lazurio.preparation.runtime).toBeUndefined();
          expect(packageJson.dependencies["@lazurio/module-kit"]).toBe(
            `github:Lazurio/module-kit#v${defaultScaffoldVersions.moduleKit}`,
          );
          expect(paths).toContain("app/v1/tests/start.test.ts");
          expect(file(result, ".github/workflows/check.yml")).toContain(
            "bun install --frozen-lockfile",
          );
          expect(result.warnings).toEqual([]);
        }
      }
  });

  test("the Python declaration in pyproject.toml equals the one in package.json", () => {
    const result = plan({ stack: "python-uv", slug: "data-sync" });
    const pyproject = Bun.TOML.parse(file(result, "app/v1/pyproject.toml")) as {
      tool: { lazurio: unknown };
      project: { scripts: unknown };
    };
    const packageJson = JSON.parse(file(result, "app/v1/package.json"));
    expect(pyproject.tool.lazurio).toEqual(packageJson.lazurio);
    expect(pyproject.project.scripts).toEqual({
      "data-sync": "data_sync.server:main",
    });
    expect(packageJson.scripts.dev).toBe("uv run --no-sync data-sync");
    expect(result.files.map((entry) => entry.path)).toContain(
      "app/v1/src/data_sync/server.py",
    );
  });

  test("refuses invalid input with stable codes", () => {
    expectCode(() => plan({ stack: "next" }), "unknown_stack");
    for (const slug of [
      "Portal",
      "portal-",
      "-portal",
      "por--tal",
      "9portal",
      "portal_x",
      "a".repeat(51),
      "",
    ])
      expectCode(() => plan({ slug }), "invalid_slug");
    for (const slug of [
      "productionspace",
      "personalspace",
      "mission-control",
      "launchpad",
      // The gateway's labels: a module's hostname is its slug.
      "t3code",
      "mausbot",
      "mausbot-webhook",
      "browser",
      "oauth2",
      "api",
      "well-known",
    ])
      expectCode(() => plan({ slug }), "reserved_slug");
    for (const displayName of [
      "",
      "   ",
      'Portál "x"',
      "<b>",
      "a{{slug}}",
      "x".repeat(81),
      "line\nbreak",
    ])
      expectCode(() => plan({ displayName }), "invalid_display_name");
    expectCode(() => plan({ teams: ["Web"] }), "invalid_team");
    expectCode(() => plan({ teams: ["web", "web"] }), "invalid_team");
    expectCode(() => plan({ teams: ["sales"] }), "unknown_team");
    expectCode(
      () =>
        plan({
          owner: { kind: "organization", slug: "Acme", githubOrg: "" },
        }),
      "invalid_organization",
    );
    expectCode(
      () => plan({ versions: { ...versions, bun: "latest" } }),
      "invalid_versions",
    );
    expectCode(() => plan({ slug: "billing" }), "slot_exists");
    expectCode(
      () => plan({ existingSlots: [{ path: "workspace/Portal" }] }),
      "slot_exists",
    );
    expectCode(() => plan({ pool: null }), "pool_missing");
    expectCode(
      () => plan({ pool: { start: 24_099, end: 24_000 } }),
      "pool_invalid",
    );
    expectCode(() => plan({ stack: "none", port: 24_010 }), "port_not_allowed");
    expectCode(() => plan({ port: 23_999 }), "port_outside_pool");
    expectCode(() => plan({ port: 24_000 }), "port_taken");
    expectCode(
      () =>
        plan({
          takenPorts: Array.from({ length: 100 }, (_, index) => 24_000 + index),
        }),
      "pool_exhausted",
    );
    const broken = {
      layers: {
        ...moduleTemplates.layers,
        none: [{ path: "README.md.tmpl", content: "{{unknown}}" }],
      },
    };
    expectCode(
      () => plan({ stack: "none", templates: broken }),
      "template_invalid",
    );
    const escaping = {
      layers: {
        ...moduleTemplates.layers,
        none: [{ path: "../README.md.tmpl", content: "x" }],
      },
    };
    expectCode(
      () => plan({ stack: "none", templates: escaping }),
      "template_invalid",
    );
    for (const slug of reservedModuleSlugs)
      expectCode(() => personal({ slug }), "reserved_slug");
  });

  test("template names map dot- segments and drop .tmpl", () => {
    expect(templateTargetPath("dot-github/workflows/check.yml.tmpl")).toBe(
      ".github/workflows/check.yml",
    );
    expect(templateTargetPath("dot-gitignore.tmpl")).toBe(".gitignore");
    expect(templateTargetPath("app/v1/tests/start.test.ts.tmpl")).toBe(
      "app/v1/tests/start.test.ts",
    );
    expect(templateTargetPath("app/v1/src/dotenv.ts")).toBe(
      "app/v1/src/dotenv.ts",
    );
  });
});

describe("planModuleScaffold, the personal form", () => {
  test("the module is the person's: company, runtime id, repository and a private slot", () => {
    const result = personal({ displayName: "Poznámky" });
    expect(result.scope).toBe("personal");
    expect(result.owner).toBe("example");
    const lease = { id: "main", host: "127.0.0.1" as const, port: 23_052 };
    expect(result.lease).toEqual(lease);
    expect(JSON.parse(file(result, "lazurio.module.json"))).toEqual({
      schema_version: "lazurio.module.v1",
      id: "notes",
      company: "example",
      tcp_port_policy: { mode: "single" },
      port_leases: [lease],
      apps: ["app/v1/package.json"],
      default_app: "app/v1/package.json",
    });
    const runtime = JSON.parse(file(result, "app/v1/package.json")).lazurio
      .runtime;
    expect(runtime).toMatchObject({
      id: "personalspace-notes-v1",
      company: "example",
      module: "notes",
      title: "Poznámky",
    });
    expect(result.slot).toEqual({
      path: "workspace/notes",
      slug: "notes",
      space: "workspace",
      category: "application",
      default_access: "private",
      required_roles: ["owner"],
      source_of_truth: "git-native",
      status: "active",
      notes:
        "Poznámky: osobní Modul založený příkazem lazurio module create (stack vite-react).",
      git: { url: "git@github.com:example/notes.git", branch: "main" },
    });
  });

  test("its own files name the person's space, the personal pool and personalspace/<module>", () => {
    for (const stack of moduleScaffoldStacks) {
      const result = personal({ stack });
      // No file says the module belongs to an Organization; only the rules
      // in AGENTS.md name one, to say it is none.
      for (const entry of result.files)
        if (entry.path !== "AGENTS.md")
          expect(entry.content, `${stack}: ${entry.path}`).not.toContain(
            "Organizace",
          );
      const readme = file(result, "README.md");
      expect(readme).toContain("Modul `notes` osobního prostoru `example`");
      if (stack !== "none" && stack !== "python-uv")
        expect(readme).toContain(
          "`lazurio module start personalspace/notes --json`",
        );
      if (stack === "none")
        expect(readme).toContain("lazurio module list personalspace --json");
      else expect(readme).toContain("lease `main` z osobního poolu");
      const agents = file(result, "AGENTS.md");
      expect(agents).toContain("Modul `notes` osobního prostoru `example`");
      expect(agents).toContain("`lazurio module create personalspace/notes`");
      expect(agents).toContain("soukromý repozitář `example/notes`");
      expect(agents).toContain("nemá Organizaci ani Teamy");
      expect(agents).not.toContain("root repa Organizace");
    }
    expect(file(personal(), "app/v1/src/App.tsx")).toContain(
      "Modul {MODULE} osobního prostoru {ORGANIZATION} běží",
    );
  });

  test("the template's example slot is a declared slot, not a conflict; its own name is", () => {
    // `workspace/personal-notes`, without a repository, stays as it is.
    expect(personal({ slug: "notes" }).slot.path).toBe("workspace/notes");
    expectCode(() => personal({ slug: "personal-notes" }), "slot_exists");
  });

  test("refuses Teams, an invalid login and a port outside the personal pool", () => {
    expectCode(() => personal({ teams: ["core"] }), "teams_not_allowed");
    expectCode(
      () => personal({ owner: { kind: "personal", login: "-x" } }),
      "invalid_owner",
    );
    for (const login of ["ab-", "a".repeat(40), ""])
      expectCode(
        () => personal({ owner: { kind: "personal", login } }),
        "invalid_owner",
      );
    expect(
      personal({ owner: { kind: "personal", login: "a-b" } }).slot.git?.url,
    ).toBe("git@github.com:a-b/notes.git");
    expectCode(() => personal({ port: 24_009 }), "port_outside_pool");
    expect(personal({ port: 23_000 }).lease?.port).toBe(23_000);
    // Whatever pool the caller read, a personal module never leases from an
    // Organization's range, its own port neither.
    for (const pool of [
      { start: 24_000, end: 24_099 },
      { start: 22_950, end: 23_050 },
      { start: 23_050, end: 23_150 },
    ]) {
      expectCode(() => personal({ pool }), "pool_invalid");
      expectCode(() => personal({ pool, port: pool.start }), "pool_invalid");
    }
    expect(
      personal({ pool: { start: 23_010, end: 23_019 } }).lease?.port,
    ).toBeGreaterThanOrEqual(23_010);
  });

  test("the reserved personal pool: 100 ports below every Organization pool, clear of the Environment's own and of every ephemeral range", () => {
    expect(personalModulePortPool).toEqual({ start: 23_000, end: 23_099 });
    expect(personalModulePortPool.end - personalModulePortPool.start + 1).toBe(
      100,
    );
    for (const port of environmentPorts)
      expect(
        port < personalModulePortPool.start ||
          port > personalModulePortPool.end,
        String(port),
      ).toBe(true);
    // Organization pools on record start at 24000; the Machines example's
    // is 20100-20199. Linux's ephemeral range starts at 32768.
    expect(personalModulePortPool.end).toBeLessThan(24_000);
    expect(personalModulePortPool.start).toBeGreaterThan(20_199);
    expect(personalModulePortPool.end).toBeLessThan(32_768);
  });
});

describe("insertModuleSlotText", () => {
  const slot = {
    path: "workspace/portal",
    slug: "portal",
    required_roles: ["*"],
  } as unknown as ModuleSlot;

  test("adds the slot after the last workspace slot and keeps every other byte", () => {
    const text = [
      "{",
      '  "company": "Acme",',
      '  "module_slots": [',
      '    { "path": "infra", "required_roles": ["admin"] },',
      "    {",
      '      "path": "workspace/billing",',
      '      "required_roles": ["*"]',
      "    },",
      '    {"path": "productionspace/firmware", "required_roles": []}',
      "  ],",
      '  "notes": "ž"',
      "}",
      "",
    ].join("\n");
    const next = insertModuleSlotText(text, slot);
    const inserted = [
      ",",
      "    {",
      '      "path": "workspace/portal",',
      '      "slug": "portal",',
      '      "required_roles": [',
      '        "*"',
      "      ]",
      "    }",
    ].join("\n");
    const anchor =
      text.indexOf('    },\n    {"path": "productionspace') + "    }".length;
    expect(next).toBe(
      `${text.slice(0, anchor)}${inserted}${text.slice(anchor)}`,
    );
    expect(
      JSON.parse(next).module_slots.map((item: { path: string }) => item.path),
    ).toEqual([
      "infra",
      "workspace/billing",
      "workspace/portal",
      "productionspace/firmware",
    ]);
  });

  test("appends without a workspace slot and fills an empty array", () => {
    const withoutWorkspace =
      '{\n  "module_slots": [\n    { "path": "infra" }\n  ]\n}\n';
    expect(
      JSON.parse(insertModuleSlotText(withoutWorkspace, slot)).module_slots.at(
        -1,
      ),
    ).toEqual(slot);
    const empty = '{\n  "company": "Acme",\n  "module_slots": []\n}\n';
    expect(insertModuleSlotText(empty, slot)).toBe(
      '{\n  "company": "Acme",\n  "module_slots": [\n    {\n      "path": "workspace/portal",\n      "slug": "portal",\n      "required_roles": [\n        "*"\n      ]\n    }\n  ]\n}\n',
    );
  });

  test("puts a personal module after the template's example slot, byte for byte", () => {
    const result = personal();
    const next = insertModuleSlotText(
      personalspaceTemplateManifest,
      result.slot,
    );
    const close = personalspaceTemplateManifest.lastIndexOf("\n  ]\n}");
    expect(next).toBe(
      `${personalspaceTemplateManifest.slice(0, close)},\n    ${JSON.stringify(result.slot, null, 2).split("\n").join("\n    ")}${personalspaceTemplateManifest.slice(close)}`,
    );
    expect(JSON.parse(next)).toEqual({
      ...JSON.parse(personalspaceTemplateManifest),
      module_slots: [...personalspaceTemplateSlots, result.slot],
    });
  });

  test("refuses a manifest without module_slots", () => {
    expectCode(
      () => insertModuleSlotText('{"company": "Acme"}', slot),
      "manifest_invalid",
    );
    expectCode(
      () => insertModuleSlotText("not json", slot),
      "manifest_invalid",
    );
  });
});

describe("insertModulePortPoolText", () => {
  test("declares the pool right before module_slots and keeps every other byte", () => {
    const next = insertModulePortPoolText(
      personalspaceTemplateManifest,
      personalModulePortPool,
    );
    const at = personalspaceTemplateManifest.indexOf('  "module_slots"');
    expect(next).toBe(
      `${personalspaceTemplateManifest.slice(0, at)}  "module_port_pool": {\n    "start": 23000,\n    "end": 23099\n  },\n${personalspaceTemplateManifest.slice(at)}`,
    );
    expect(JSON.parse(next)).toEqual({
      ...JSON.parse(personalspaceTemplateManifest),
      module_port_pool: { start: 23_000, end: 23_099 },
    });
    // A manifest on one line: the member goes in front of module_slots, its
    // own value indented from the line's start.
    expect(
      insertModulePortPoolText('{"owner": "x", "module_slots": []}', {
        start: 23_000,
        end: 23_000,
      }),
    ).toBe(
      '{"owner": "x", "module_port_pool": {\n  "start": 23000,\n  "end": 23000\n},\n"module_slots": []}',
    );
  });

  test("refuses a manifest that declares one already, has no module_slots or is no JSON", () => {
    expectCode(
      () =>
        insertModulePortPoolText(
          '{"module_port_pool": {"start": 23000, "end": 23099}, "module_slots": []}',
          personalModulePortPool,
        ),
      "manifest_invalid",
    );
    expectCode(
      () => insertModulePortPoolText('{"owner": "x"}', personalModulePortPool),
      "manifest_invalid",
    );
    expectCode(
      () => insertModulePortPoolText("not json", personalModulePortPool),
      "manifest_invalid",
    );
  });
});

describe("the embedded templates", () => {
  test("are the files of src/modules/templates, byte for byte, in the known layers", async () => {
    const root = join(import.meta.dir, "..", "src", "modules", "templates");
    const walk = async (directory: string): Promise<string[]> =>
      (
        await Promise.all(
          (
            await readdir(directory, { withFileTypes: true })
          ).map((entry) =>
            entry.isDirectory()
              ? walk(join(directory, entry.name))
              : [join(directory, entry.name)],
          ),
        )
      ).flat();
    const onDisk = new Map<string, string>();
    for (const path of await walk(root)) {
      const name = relative(root, path);
      if (name === "README.md") continue;
      onDisk.set(name, (await readFile(path, "utf8")).replace(/\r\n/g, "\n"));
    }
    const embedded = new Map<string, string>();
    for (const [layer, files] of Object.entries(moduleTemplates.layers))
      for (const entry of files)
        embedded.set(`${layer}/${entry.path}`, entry.content);
    expect([...embedded.keys()].sort()).toEqual([...onDisk.keys()].sort());
    for (const [name, content] of onDisk)
      expect(embedded.get(name), name).toBe(content);
    expect(Object.keys(moduleTemplates.layers).sort()).toEqual(
      [...moduleScaffoldLayers].sort(),
    );
    for (const name of onDisk.keys())
      expect(name.endsWith(".tmpl"), name).toBe(true);
  });

  test("a new module pins this repository's own Bun", async () => {
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    );
    expect(packageJson.packageManager).toBe(`bun@${scaffoldBunVersion}`);
  });
});

// A generated module as the Platform reads it: written into a workstation
// Folder's Personalspace with a lockfile that mirrors its package.json (no
// install, no network in tests), and read by the catalog and the module
// reader the lifecycle uses.
describe("the Platform reads a generated personal module", () => {
  let parent = "";
  let folder = "";
  beforeAll(async () => {
    if (!["darwin", "linux"].includes(process.platform)) return;
    parent = await realpath(await mkdtemp(join(tmpdir(), "module-scaffold-")));
    folder = join(parent, "Lazurio");
    await initializeFolder(
      folder,
      presetProfile("local", executionOs(process.platform)),
    );
  });
  afterAll(async () => {
    if (parent) await rm(parent, { recursive: true, force: true });
  });

  async function materialize(result: ModuleScaffoldPlan) {
    const moduleRoot = join(
      folder,
      "personalspace",
      "example_GEN3",
      "workspace",
      result.module,
    );
    for (const entry of result.files) {
      const path = join(moduleRoot, ...entry.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.content);
    }
    for (const lockfile of result.generatedByInstall) {
      if (!lockfile.endsWith("bun.lock")) continue;
      const packageJson = JSON.parse(
        await readFile(join(moduleRoot, "app", "v1", "package.json"), "utf8"),
      );
      await writeFile(
        join(moduleRoot, ...lockfile.split("/")),
        `${JSON.stringify(
          {
            lockfileVersion: 1,
            workspaces: {
              "": {
                name: packageJson.name,
                dependencies: packageJson.dependencies,
                devDependencies: packageJson.devDependencies,
              },
            },
            packages: {},
          },
          null,
          2,
        )}\n`,
      );
    }
    return moduleRoot;
  }

  posixTest(
    "every stack is listed as personalspace/<module>; a Bun app is executable and its default app is read",
    async () => {
      const roots = new Map<string, string>();
      for (const stack of moduleScaffoldStacks)
        roots.set(
          stack,
          await materialize(personal({ stack, slug: `notes-${stack}` })),
        );
      const catalog = await readFolderCatalog(folder, heldBy("example"));
      // No output names a personal module's owner: not its login (its
      // runtime id is `personalspace-<slug>-v1`), not its directory.
      expect(JSON.stringify(catalog.personalspace)).not.toContain("example");
      const listed = new Map(
        (catalog.personalspace?.modules ?? []).map((module) => [
          module.module,
          module,
        ]),
      );
      for (const stack of moduleScaffoldStacks) {
        const module = listed.get(`notes-${stack}`);
        expect(module?.organization, stack).toBe("personalspace");
        if (stack === "none") {
          expect(module?.reason).toBe("no-app");
          continue;
        }
        if (stack === "python-uv") {
          // The plan's warning: listed, not startable until the uv adapter.
          expect(module?.reason).toBe("default-app-invalid");
          continue;
        }
        expect({
          stack,
          executable: module?.executable,
          reason: module?.reason,
        }).toEqual({
          stack,
          executable: true,
          reason: undefined,
        });
        const application = await readModuleApplication(
          roots.get(stack) as string,
        );
        expect(application.kind, stack).toBe("declared-runtime-plan");
      }
    },
  );
});

describe("planModuleScaffold with data (--data)", () => {
  test("the app depends on one released repository-db, Git ignores db/, and the data slot is a repository-db mount", () => {
    const without = plan({ teams: ["web"] });
    const result = plan({ teams: ["web"], data: true });
    expect(without.data).toBeNull();
    expect(result.treeHash).not.toBe(without.treeHash);
    const pkg = JSON.parse(file(result, "app/v1/package.json"));
    expect(pkg.dependencies["@lazurio/repository-db"]).toBe(
      `github:Lazurio/repository-db#v${defaultScaffoldVersions.repositoryDb}`,
    );
    // Sorted with the template's own dependencies; nothing else changes.
    expect(Object.keys(pkg.dependencies)).toEqual(
      Object.keys(pkg.dependencies).sort(),
    );
    const before = JSON.parse(file(without, "app/v1/package.json"));
    delete pkg.dependencies["@lazurio/repository-db"];
    expect(pkg).toEqual(before);
    expect(file(result, ".gitignore")).toBe(
      `${file(without, ".gitignore")}/db/\n`,
    );
    expect(file(result, "AGENTS.md")).toStartWith(file(without, "AGENTS.md"));
    expect(file(result, "AGENTS.md")).toContain("`portal-data`");
    // Only those three files differ.
    const changed = result.files
      .filter(
        (entry) =>
          without.files.find((other) => other.path === entry.path)?.content !==
          entry.content,
      )
      .map((entry) => entry.path)
      .sort();
    expect(changed).toEqual([".gitignore", "AGENTS.md", "app/v1/package.json"]);
    expect(result.data).toEqual({
      repository: "portal-data",
      mount: "db",
      branch: "v3",
      schemaName: "portal-data",
      schemaVersion: "0.1.0",
      engine: `github:Lazurio/repository-db#v${defaultScaffoldVersions.repositoryDb}`,
      slot: {
        path: "workspace/portal/db",
        slug: "portal-data",
        teams: ["web"],
        category: "application",
        default_access: "expected",
        required_roles: ["*"],
        source_of_truth: "repository-db:v3",
        status: "active",
        notes: expect.stringContaining("AcmeHQ/portal-data"),
        materialization: "repository_db_mount",
        repository_db: {
          repo: "AcmeHQ/portal-data",
          url: "git@github.com:AcmeHQ/portal-data.git",
          branch: "v3",
          config: "repository-db.yaml",
          data_root: "data",
          profile: "repository-db-v3",
          app_writable_path_policy: "repository_db_publish_only",
        },
        git: { url: "git@github.com:AcmeHQ/portal-data.git", branch: "v3" },
      },
    });
    // The slot's members in the order the Organization's manifests write them.
    expect(Object.keys(result.data?.slot ?? {})).toEqual([
      "path",
      "slug",
      "teams",
      "category",
      "default_access",
      "required_roles",
      "source_of_truth",
      "status",
      "notes",
      "materialization",
      "repository_db",
      "git",
    ]);
  });

  test("a personal module's data is private to its owner, without Teams", () => {
    const result = personal({ data: true });
    expect(result.data?.slot).toMatchObject({
      path: "workspace/notes/db",
      slug: "notes-data",
      default_access: "private",
      required_roles: ["owner"],
      repository_db: { repo: "example/notes-data" },
    });
    expect(result.data?.slot.teams).toBeUndefined();
  });

  test("refused for a stack without a Bun app, and for a taken data slot", () => {
    for (const stack of ["none", "python-uv"])
      expectCode(() => plan({ stack, data: true }), "data_needs_bun_app");
    expectCode(
      () =>
        plan({
          data: true,
          existingSlots: [
            { path: "workspace/portal-data", slug: "portal-data" },
          ],
        }),
      "slot_exists",
    );
  });
});
