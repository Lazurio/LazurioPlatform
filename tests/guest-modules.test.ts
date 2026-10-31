import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredChildren, installContent } from "../src/content/install";
import { dataMountOf } from "../src/content/provide";
import { type SyncEntry, syncContent } from "../src/content/sync";
import { catalogChecks } from "../src/doctor/doctor";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { inspectCanonicalInventory } from "../src/organizations/canonical-inventory";
import { readFolderCatalog } from "../src/organizations/catalog";
import { runCatalogCommand } from "../src/organizations/cli";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import { resolveOrganizationApplication } from "../src/organizations/read-applications";
import {
  classifyRepositorySlotPath,
  inspectRepositorySlots,
} from "../src/organizations/repository-slots";
import { resolveOrganizationRoot } from "../src/organizations/root-resolution";
import type { CliContext } from "../src/update/cli";
import {
  type Slot,
  writeModule,
  writeOrganization,
} from "./fixtures/catalog-folder";
import {
  contentHost,
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
  writeOrganizationRoot,
} from "./fixtures/content-world";
import {
  guestKnowledgebase,
  guestMissionControl,
  guestMissionControlData,
  guests,
  hostDocuments,
  hostSlots,
} from "./fixtures/guest-modules";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

// Guest Modules (hostující Moduly, root decision 0221, DEV-6694): a host
// Organization's `modules.manifest.json` mounts a Module of another
// Organization, its home Organization, at `workspace/<Home>_GEN3/<repo>`
// (and its repository database child below it), with `home_organization`.
// The shared contract with the Lazurio Root CLI: the same rules, the same
// slot-level quarantine, the same legacy projection bytes. Synthetic
// Organizations only: `HostOrg` hosts, `HomeOrg` is the home.

const codes = (slots: readonly unknown[], host = "HostOrg") =>
  inspectRepositorySlots(slots, host).issues.map((issue) => issue.code);

test("a guest path is workspace/<home>_GEN3/<mount> or its /db child, and only with its home Organization", () => {
  expect(
    classifyRepositorySlotPath(
      "workspace/HomeOrg_GEN3/knowledgebase",
      "HomeOrg",
    ),
  ).toEqual({
    path: "workspace/HomeOrg_GEN3/knowledgebase",
    scope: "workspace",
    nestedDatabase: false,
    home: "HomeOrg",
  });
  expect(
    classifyRepositorySlotPath(
      "workspace/HomeOrg_GEN3/mission-control/db",
      "HomeOrg",
    ),
  ).toEqual({
    path: "workspace/HomeOrg_GEN3/mission-control/db",
    scope: "workspace",
    nestedDatabase: true,
    home: "HomeOrg",
  });
  // Without its home Organization a guest path stays unsupported: the host's
  // own workspace stays flat (0041).
  for (const path of [
    "workspace/HomeOrg_GEN3/knowledgebase",
    "workspace/HomeOrg_GEN3/mission-control/db",
  ])
    expect(classifyRepositorySlotPath(path)).toBe(null);
  // With it, nothing but the guest grammar of exactly that home.
  for (const path of [
    "workspace/knowledgebase",
    "workspace/knowledgebase/db",
    "workspace/OtherOrg_GEN3/knowledgebase",
    "workspace/homeorg_GEN3/knowledgebase",
    "workspace/HomeOrg/knowledgebase",
    "workspace/HomeOrg_gen3/knowledgebase",
    "workspace/HomeOrg_GEN3",
    "workspace/HomeOrg_GEN3/a/b",
    "workspace/HomeOrg_GEN3/.hidden",
    "workspace/HomeOrg_GEN3/a/db/db",
    "modules/HomeOrg_GEN3/knowledgebase",
    "productionspace/HomeOrg_GEN3/knowledgebase",
    "productionspace/knowledgebase",
    "mission-control",
    "infra",
  ])
    expect(classifyRepositorySlotPath(path, "HomeOrg")).toBe(null);
  expect(
    classifyRepositorySlotPath("workspace/HomeOrg_GEN3/knowledgebase", ""),
  ).toBe(null);
});

test("a valid guest pair beside the host's own Knowledgebase and Mission Control has no issue and no collision", () => {
  const slots = [...hostSlots, ...guests];
  const before = JSON.stringify(slots);
  const result = inspectRepositorySlots(slots, "HostOrg");
  expect(result.issues).toEqual([]);
  expect(
    result.slots.map((slot) => [slot?.path, slot?.id, slot?.home ?? null]),
  ).toEqual([
    ["mission-control", "mission-control", null],
    ["mission-control/db", "mission-control-data", null],
    ["workspace/knowledgebase", "knowledgebase", null],
    ["workspace/HomeOrg_GEN3/knowledgebase", "knowledgebase", "HomeOrg"],
    ["workspace/HomeOrg_GEN3/mission-control", "mission-control", "HomeOrg"],
    [
      "workspace/HomeOrg_GEN3/mission-control/db",
      "mission-control-data",
      "HomeOrg",
    ],
  ]);
  expect(result.slots[5]?.nestedDatabase).toBe(true);
  expect(JSON.stringify(slots)).toBe(before);
  // Two home Organizations may share a slug; neither collides with the host.
  expect(
    codes([
      ...slots,
      {
        ...guestKnowledgebase,
        path: "workspace/ThirdOrg_GEN3/knowledgebase",
        home_organization: "ThirdOrg",
        git: { url: "git@github.com:ThirdOrg/knowledgebase.git" },
      },
    ]),
  ).toEqual([]);
});

test("every invalid guest declaration quarantines only its own slot", () => {
  const cases: [Slot[], string][] = [
    // home_organization is not the remote's owner, by any declared alias.
    [
      [
        {
          ...guestKnowledgebase,
          git: { url: "git@github.com:OtherOrg/knowledgebase.git" },
        },
      ],
      "guest-remote-owner-mismatch",
    ],
    [
      [{ ...guestKnowledgebase, repo: "https://github.com/OtherOrg/kb.git" }],
      "guest-remote-owner-mismatch",
    ],
    [
      [
        guestMissionControl,
        {
          ...guestMissionControlData,
          repository_db: {
            ...(guestMissionControlData.repository_db as object),
            repo: "OtherOrg/mission-control-data",
          },
        },
      ],
      "guest-remote-owner-mismatch",
    ],
    [
      [{ ...guestKnowledgebase, git: { url: "file:///elsewhere/kb.git" } }],
      "guest-remote-owner-mismatch",
    ],
    // The home Organization is the host itself, in any letter case.
    [
      [
        {
          ...guestKnowledgebase,
          path: "workspace/hostorg_GEN3/knowledgebase",
          home_organization: "hostorg",
          git: { url: "git@github.com:hostorg/knowledgebase.git" },
        },
      ],
      "guest-home-is-host",
    ],
    // A wrong middle segment, a path outside the guest grammar, or a host
    // slot that carries home_organization.
    [
      [
        {
          ...guestKnowledgebase,
          path: "workspace/OtherOrg_GEN3/knowledgebase",
        },
      ],
      "guest-path-invalid",
    ],
    [
      [{ ...guestKnowledgebase, path: "workspace/HomeOrg/knowledgebase" }],
      "guest-path-invalid",
    ],
    [
      [{ ...guestKnowledgebase, path: "workspace/knowledgebase" }],
      "guest-path-invalid",
    ],
    [
      [
        {
          ...guestKnowledgebase,
          path: "productionspace/HomeOrg_GEN3/knowledgebase",
        },
      ],
      "guest-path-invalid",
    ],
    [
      [{ ...guestKnowledgebase, path: "mission-control" }],
      "guest-path-invalid",
    ],
    // home_organization that names no GitHub login.
    [
      [{ ...guestKnowledgebase, home_organization: "" }],
      "guest-home-organization-invalid",
    ],
    [
      [{ ...guestKnowledgebase, home_organization: " HomeOrg" }],
      "guest-home-organization-invalid",
    ],
    [
      [{ ...guestKnowledgebase, home_organization: null }],
      "guest-home-organization-invalid",
    ],
    [
      [{ ...guestKnowledgebase, home_organization: "Home_Org" }],
      "guest-home-organization-invalid",
    ],
    // A guest's database child without its parent, or below another home's.
    [[guestMissionControlData], "repository-db-parent-missing"],
    [
      [
        guestMissionControl,
        {
          ...guestMissionControlData,
          path: "workspace/OtherOrg_GEN3/mission-control/db",
          home_organization: "OtherOrg",
          repository_db: { repo: "OtherOrg/mission-control-data" },
          git: { url: "git@github.com:OtherOrg/mission-control-data.git" },
        },
      ],
      "repository-db-parent-missing",
    ],
    [
      [
        guestMissionControl,
        { ...guestMissionControlData, home_organization: "OtherOrg" },
      ],
      "guest-path-invalid",
    ],
    // Two guests of one home with one slug, whatever the letter case of the
    // home; and the same path declared twice.
    [
      [
        guestKnowledgebase,
        {
          ...guestKnowledgebase,
          path: "workspace/HomeOrg_GEN3/kb",
        },
      ],
      "repository-id-collision",
    ],
    [
      [
        guestKnowledgebase,
        {
          ...guestKnowledgebase,
          path: "workspace/homeorg_GEN3/knowledgebase",
          home_organization: "homeorg",
          git: { url: "git@github.com:homeorg/knowledgebase.git" },
        },
      ],
      "repository-id-collision",
    ],
    [[guestKnowledgebase, guestKnowledgebase], "duplicate-path"],
  ];
  for (const [bad, code] of cases) {
    const healthy = bad.length;
    const observed = inspectRepositorySlots([...bad, ...hostSlots], "HostOrg");
    expect(
      observed.issues.some((issue) => issue.code === code),
      code,
    ).toBe(true);
    // The host's own slots stay healthy beside it.
    for (let index = healthy; index < healthy + hostSlots.length; index++)
      expect(
        observed.issues.every((issue) => !issue.indices.includes(index)),
        code,
      ).toBe(true);
    expect(observed.slots.at(-1)?.id).toBe("knowledgebase");
  }
});

test("without home_organization a foreign remote and a guest path keep today's behaviour", () => {
  // A host workspace slot whose remote another owner holds: the Platform has
  // never checked a host slot's owner (Core reports
  // slot_remote_owner_mismatch).
  expect(
    codes([
      {
        path: "workspace/shared",
        slug: "shared",
        git: { url: "git@github.com:HomeOrg/shared.git" },
      },
    ]),
  ).toEqual([]);
  // A guest path without its home Organization is unsupported, as an older
  // Platform quarantines every guest slot.
  const { home_organization: _, ...declared } = guestKnowledgebase;
  expect(codes([declared])).toEqual(["unsupported-path"]);
  // And an inventory read without its host never asks home == host.
  expect(
    inspectRepositorySlots([
      {
        ...guestKnowledgebase,
        path: "workspace/HostOrg_GEN3/knowledgebase",
        home_organization: "HostOrg",
        git: { url: "git@github.com:HostOrg/knowledgebase.git" },
      },
    ]).issues,
  ).toEqual([]);
});

// The legacy projection of this manifest, by Lazurio Core's
// `organizationLegacyProjectionHash` (lazurio/core/organization-activation-lib.mjs)
// and by this Platform: the two implementations write the same bytes, so a
// hash `lazurio migrate organization-manifest --write` records verifies here.
const projectionHash =
  "sha256:fd0f10166aea752b8d5c34c08e46ff7b05d553b46569c125b82881a223bddd25";

test("the legacy projection copies a guest slot whole, home_organization included, and keeps Core's bytes", () => {
  const { canonical, modules } = hostDocuments();
  const projected = expectedLegacyProjection(canonical, modules);
  const entries = projected.projection.modules as Record<string, unknown>[];
  expect(entries.map((entry) => entry.path)).toEqual([
    "workspace/HomeOrg_GEN3/knowledgebase",
    "workspace/HomeOrg_GEN3/mission-control",
    "workspace/HomeOrg_GEN3/mission-control/db",
    "workspace/knowledgebase",
  ]);
  expect(entries[0]).toEqual({
    path: "workspace/HomeOrg_GEN3/knowledgebase",
    slug: "knowledgebase",
    home_organization: "HomeOrg",
    category: "knowledge",
    source_of_truth: "git-native",
    teams: ["workspace"],
    status: "active",
    repo: "git@github.com:HomeOrg/knowledgebase.git",
    branch: "main",
    access: { default: "expected", roles: ["*"] },
  });
  expect(entries[2]).toMatchObject({
    slug: "mission-control-data",
    home_organization: "HomeOrg",
    materialization: "repository_db_mount",
    repo: "git@github.com:HomeOrg/mission-control-data.git",
    branch: "v3",
  });
  expect(projected.hash).toBe(projectionHash);
  // Deterministic, and independent of the slots' order.
  expect(
    expectedLegacyProjection(canonical, {
      ...modules,
      module_slots: [...modules.module_slots].reverse(),
    }).hash,
  ).toBe(projectionHash);
  // The recorded hash makes the root `current`, the guests do not conflict.
  canonical.compatibility.legacy_projection.sha256 = projected.hash;
  expect(
    inspectCanonicalInventory(canonical, modules).inventory.issues,
  ).toEqual([]);
});

test("content installation clones a guest as a workspace module and its database child below it, on its declared branch", () => {
  const { canonical, modules } = hostDocuments();
  const children = declaredChildren(
    inspectCanonicalInventory(canonical, modules),
    "exclude",
  );
  expect(
    children.map((child) => ({
      path: child.path,
      repository: child.repository,
      kind: child.kind,
      ...(child.excluded === undefined ? {} : { excluded: child.excluded }),
      ...(child.data === undefined ? {} : { data: child.data }),
    })),
  ).toEqual([
    {
      path: "mission-control",
      repository: "HostOrg/mission-control",
      kind: "module",
    },
    {
      path: "mission-control/db",
      repository: "HostOrg/mission-control-data",
      kind: "module",
      data: { parent: "mission-control", branch: "v3" },
    },
    {
      path: "workspace/knowledgebase",
      repository: "HostOrg/knowledgebase",
      kind: "module",
    },
    {
      path: "workspace/HomeOrg_GEN3/knowledgebase",
      repository: "HomeOrg/knowledgebase",
      kind: "module",
    },
    {
      path: "workspace/HomeOrg_GEN3/mission-control",
      repository: "HomeOrg/mission-control",
      kind: "module",
    },
    {
      path: "workspace/HomeOrg_GEN3/mission-control/db",
      repository: "HomeOrg/mission-control-data",
      kind: "module",
      data: { parent: "workspace/HomeOrg_GEN3/mission-control", branch: "v3" },
    },
  ]);
  // A guest module named `db` is a module, not a database of its folder.
  expect(
    dataMountOf({
      ...guestKnowledgebase,
      path: "workspace/HomeOrg_GEN3/db",
      slug: "db",
      materialization: "repository_db_mount",
    }),
  ).toBe(null);
  // An invalid guest is never a child: quarantined, its siblings remain.
  const quarantined = declaredChildren(
    inspectCanonicalInventory(canonical, {
      ...modules,
      module_slots: [
        ...hostSlots,
        {
          ...guestKnowledgebase,
          git: { url: "git@github.com:OtherOrg/knowledgebase.git" },
        },
      ],
    }),
    "exclude",
  );
  expect(quarantined.map((child) => child.path)).toEqual([
    "mission-control",
    "mission-control/db",
    "workspace/knowledgebase",
  ]);
});

// A Folder with the synthetic host: its own Knowledgebase and app module,
// and the guest pair of HomeOrg checked out, whose module manifests name
// HomeOrg as their company, as the home Organization writes them; a third
// guest is declared but not here (its repository is not readable here).
async function hostFolder(
  run: (folder: string, root: string) => Promise<void>,
) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "guests-")));
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
    const root = await writeOrganization(folder, "HostOrg_GEN3", {
      slug: "hostorg",
      forge: "HostOrg",
      state: "current",
      modules: [{ id: "knowledgebase", apps: false }, { id: "web" }],
      slots: [
        {
          ...guestKnowledgebase,
          path: "workspace/HomeOrg_GEN3/knowledgebase",
        },
        {
          ...guestMissionControl,
          slug: "notes",
          path: "workspace/HomeOrg_GEN3/notes",
          git: { url: "git@github.com:HomeOrg/notes.git", branch: "main" },
        },
        {
          ...guestKnowledgebase,
          slug: "absent",
          path: "workspace/HomeOrg_GEN3/absent",
          git: { url: "git@github.com:HomeOrg/absent.git", branch: "main" },
        },
      ],
    });
    for (const id of ["knowledgebase", "notes"]) {
      const path = join(root, "workspace/HomeOrg_GEN3", id);
      await writeModule(path, "homeorg", { id, apps: id === "notes" });
      await mkdir(join(path, ".git"));
    }
    await run(folder, root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const posix = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!posix);

test.skipIf(!posix)(
  "the catalog lists guests read-only with their home Organization, never as modules, and never starts one",
  async () => {
    await hostFolder(async (folder, root) => {
      const catalog = await readFolderCatalog(folder);
      const host = catalog.organizations.find(
        (entry) => entry.organization === "hostorg",
      );
      expect(host?.executable).toBe(true);
      expect(host?.issues).toEqual([]);
      // Only the host's own modules: no identity error for a guest's
      // manifest that names its home.
      expect(
        host?.modules.map((module) => [module.module, module.path]),
      ).toEqual([
        ["knowledgebase", "workspace/knowledgebase"],
        ["web", "workspace/web"],
      ]);
      expect(host?.modules.map((module) => module.reason ?? null)).toEqual([
        "no-app",
        null,
      ]);
      expect(host?.guests).toEqual([
        {
          organization: "hostorg",
          module: "knowledgebase",
          path: "workspace/HomeOrg_GEN3/knowledgebase",
          homeOrganization: "HomeOrg",
          guest: true,
          checkedOut: true,
          url: "https://github.com/HomeOrg/knowledgebase",
        },
        {
          organization: "hostorg",
          module: "notes",
          path: "workspace/HomeOrg_GEN3/notes",
          homeOrganization: "HomeOrg",
          guest: true,
          checkedOut: true,
          url: "https://github.com/HomeOrg/notes",
        },
        {
          organization: "hostorg",
          module: "absent",
          path: "workspace/HomeOrg_GEN3/absent",
          homeOrganization: "HomeOrg",
          guest: true,
          checkedOut: false,
          url: "https://github.com/HomeOrg/absent",
        },
      ]);
      // A guest's app is never an application of the host.
      await expect(
        resolveOrganizationApplication(root, {
          company: "hostorg",
          module: "notes",
          package: "app/package.json",
        }),
      ).rejects.toThrow("Selected application unavailable");
      expect(
        (
          await resolveOrganizationApplication(root, {
            company: "hostorg",
            module: "web",
            package: "app/package.json",
          })
        ).moduleDirectory,
      ).toBe(join(root, "workspace/web"));
      expect((await resolveOrganizationRoot(root)).kind).toBe("root-resolved");
      // The doctor: a guest here is ok, one not here only a note.
      const checks = catalogChecks(catalog).filter(
        (check) => check.id === "guest-module",
      );
      expect(checks).toEqual([
        {
          id: "guest-module",
          outcome: "ok",
          context: {
            organization: "hostorg",
            module: "knowledgebase",
            homeOrganization: "HomeOrg",
          },
        },
        {
          id: "guest-module",
          outcome: "ok",
          context: {
            organization: "hostorg",
            module: "notes",
            homeOrganization: "HomeOrg",
          },
        },
        {
          id: "guest-module",
          outcome: "skipped",
          reason: "guest-module-absent",
          context: {
            organization: "hostorg",
            module: "absent",
            homeOrganization: "HomeOrg",
          },
        },
      ]);
      // The only attention is the host's own module without an app.
      expect(
        catalogChecks(catalog)
          .filter((check) => check.outcome === "warn")
          .map((check) => [check.id, check.reason]),
      ).toEqual([["module", "no-app"]]);
    });
  },
);

const cli: CliContext = {
  identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
  platform: process.platform,
  env: {},
  executable: "/nonexistent/lazurio",
};

test.skipIf(!posix)(
  "module list and organization list carry the guests with homeOrganization and guest true",
  async () => {
    await hostFolder(async (folder) => {
      const read = (at: string) => readFolderCatalog(at);
      const json = await runCatalogCommand(
        ["module", "list", "hostorg", "--folder", folder, "--json"],
        cli,
        read,
      );
      expect(json.code).toBe(0);
      const listed = json.result as {
        modules: { module: string }[];
        guests: { module: string; homeOrganization: string; guest: true }[];
      };
      expect(listed.modules.map((module) => module.module)).toEqual([
        "knowledgebase",
        "web",
      ]);
      expect(
        listed.guests.map((guest) => [
          guest.module,
          guest.homeOrganization,
          guest.guest,
        ]),
      ).toEqual([
        ["knowledgebase", "HomeOrg", true],
        ["notes", "HomeOrg", true],
        ["absent", "HomeOrg", true],
      ]);
      const text = await runCatalogCommand(
        ["module", "list", "hostorg", "--folder", folder],
        cli,
        read,
      );
      expect(text.text).toMatch(
        /^HomeOrg\/knowledgebase +- +- +guest in hostorg at workspace\/HomeOrg_GEN3\/knowledgebase, read-only$/m,
      );
      expect(text.text).toContain(
        "guest in hostorg at workspace/HomeOrg_GEN3/absent, read-only, not checked out",
      );
      const organizations = await runCatalogCommand(
        ["organization", "list", "--folder", folder],
        cli,
        read,
      );
      expect(organizations.text).toContain("2 modules, 3 guest modules");
    });
  },
);

test.skipIf(!posix)(
  "an invalid guest declaration is a doctor finding of its own and the host keeps running",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "guests-")));
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
      await writeOrganization(folder, "HostOrg_GEN3", {
        slug: "hostorg",
        forge: "HostOrg",
        state: "current",
        modules: [{ id: "web" }],
        slots: [
          {
            ...guestKnowledgebase,
            git: { url: "git@github.com:OtherOrg/knowledgebase.git" },
          },
        ],
      });
      const catalog = await readFolderCatalog(folder);
      const host = catalog.organizations[0];
      expect(host?.executable).toBe(true);
      expect(host?.modules.map((module) => module.executable)).toEqual([true]);
      expect(host?.guests).toBeUndefined();
      expect(host?.issues).toEqual(["guest-remote-owner-mismatch"]);
      expect(
        catalogChecks(catalog).filter((check) => check.id === "guest-module"),
      ).toEqual([
        {
          id: "guest-module",
          outcome: "warn",
          reason: "guest-remote-owner-mismatch",
          context: { organization: "hostorg" },
        },
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posix)(
  "an orphan guest database and a guest slug collision are doctor findings too, never a silent omission",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "guests-")));
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
      await writeOrganization(folder, "HostOrg_GEN3", {
        slug: "hostorg",
        forge: "HostOrg",
        state: "current",
        modules: [{ id: "web" }],
        slots: [
          // A guest database whose guest parent is not declared.
          guestMissionControlData,
          // Two guests of one home Organization with one slug.
          guestKnowledgebase,
          { ...guestKnowledgebase, path: "workspace/HomeOrg_GEN3/kb" },
        ],
      });
      const catalog = await readFolderCatalog(folder);
      const host = catalog.organizations[0];
      expect(host?.executable).toBe(true);
      expect(host?.modules.map((module) => module.executable)).toEqual([true]);
      expect(host?.guests).toBeUndefined();
      expect(host?.guestIssues).toEqual([
        "repository-id-collision",
        "repository-db-parent-missing",
      ]);
      expect(
        catalogChecks(catalog).filter((check) => check.id === "guest-module"),
      ).toEqual([
        {
          id: "guest-module",
          outcome: "warn",
          reason: "repository-id-collision",
          context: { organization: "hostorg" },
        },
        {
          id: "guest-module",
          outcome: "warn",
          reason: "repository-db-parent-missing",
          context: { organization: "hostorg" },
        },
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** A new commit on `branch` of the bare remote `fullName`, through a scratch
 * clone; its commit. */
async function advance(current: World, fullName: string, branch = "main") {
  const run = async (cwd: string, ...args: string[]) => {
    const result = await runChild(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd,
        env: {
          PATH: Bun.env.PATH ?? "/usr/bin:/bin",
          HOME: cwd,
          ...current.gitEnv,
        },
      },
    );
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const work = await mkdtemp(join(current.root, "advance-"));
  await run(
    current.root,
    "clone",
    "--quiet",
    "--branch",
    branch,
    `git@github.com:${fullName}.git`,
    work,
  );
  await writeFile(join(work, "later.txt"), "later\n");
  await run(work, "add", "--all");
  await run(work, "commit", "--quiet", "-m", "advance");
  await run(work, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  const commit = await run(work, "rev-parse", "HEAD");
  await rm(work, { recursive: true, force: true });
  return commit;
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

posixTest(
  "installation clones the guests beside the host's own, a missing grant stays slot-local, and synchronization keeps them current",
  async () => {
    world = await createWorld();
    const current = world;
    const privateGuest: Slot = {
      ...guestKnowledgebase,
      slug: "private-notes",
      path: "workspace/HomeOrg_GEN3/private-notes",
      git: { url: "git@github.com:HomeOrg/private-notes.git", branch: "main" },
    };
    // The host root tracks the folder of its home Organization with its
    // README.md and AGENTS.md and ignores the checkouts inside it.
    await remoteRepository(
      current,
      "HostOrg/HostOrg_GEN3",
      async (directory) => {
        await writeOrganizationRoot(directory, {
          slug: "hostorg",
          forge: "HostOrg",
          slots: [...hostSlots, ...guests, privateGuest],
          root: "HostOrg/HostOrg_GEN3",
        });
        await writeFile(
          join(directory, ".gitignore"),
          [
            "workspace/*",
            "!workspace/HomeOrg_GEN3/",
            "workspace/HomeOrg_GEN3/*",
            "!workspace/HomeOrg_GEN3/README.md",
            "!workspace/HomeOrg_GEN3/AGENTS.md",
            "mission-control/",
            "",
          ].join("\n"),
        );
        await mkdir(join(directory, "workspace/HomeOrg_GEN3"), {
          recursive: true,
        });
        for (const name of ["README.md", "AGENTS.md"])
          await writeFile(
            join(directory, "workspace/HomeOrg_GEN3", name),
            "Modules of HomeOrg.\n",
          );
      },
    );
    for (const [fullName, company, id] of [
      ["HostOrg/knowledgebase", "hostorg", "knowledgebase"],
      ["HostOrg/mission-control", "hostorg", "mission-control"],
      ["HomeOrg/knowledgebase", "homeorg", "knowledgebase"],
      ["HomeOrg/mission-control", "homeorg", "mission-control"],
    ] as const)
      await remoteRepository(current, fullName, async (directory) => {
        // With an app wherever it is a Mission Control: one the host would
        // prepare if it took a guest for its module.
        await writeModule(directory, company, {
          id,
          apps: id === "mission-control",
        });
        await writeFile(join(directory, ".gitignore"), "db/\n");
      });
    for (const fullName of [
      "HostOrg/mission-control-data",
      "HomeOrg/mission-control-data",
    ])
      await remoteRepository(
        current,
        fullName,
        (directory) => writeFile(join(directory, "data.json"), "{}\n"),
        "v3",
      );
    const folder = await presetFolder(current, "local");
    const readable = Object.fromEntries(
      [
        "HostOrg/HostOrg_GEN3",
        "HostOrg/knowledgebase",
        "HostOrg/mission-control",
        "HostOrg/mission-control-data",
        "HomeOrg/knowledgebase",
        "HomeOrg/mission-control",
        "HomeOrg/mission-control-data",
      ].map((name) => [name, {}]),
    );
    const { github } = stubGitHub(current, { repositories: readable });
    const host = contentHost(current, github);
    const result = await installContent(
      folder,
      {
        items: [{ kind: "organization", login: "HostOrg" }],
        roots: { HostOrg: "HostOrg/HostOrg_GEN3" },
      },
      () => {},
      host,
    );
    if (result.kind !== "content-install") throw new Error(result.kind);
    expect(result.state).toBe("succeeded");
    const outcome = result.items[0];
    expect(
      Object.fromEntries(
        (outcome?.repositories ?? []).map((entry) => [
          entry.path,
          entry.result,
        ]),
      ),
    ).toEqual({
      "mission-control": "materialized",
      "mission-control/db": "materialized",
      "workspace/knowledgebase": "materialized",
      "workspace/HomeOrg_GEN3/knowledgebase": "materialized",
      "workspace/HomeOrg_GEN3/mission-control": "materialized",
      "workspace/HomeOrg_GEN3/mission-control/db": "materialized",
      // No grant for this one: only it is missing, nothing else stops.
      "workspace/HomeOrg_GEN3/private-notes": "denied",
    });
    const root = join(folder, "organizations", "HostOrg_GEN3");
    // The guest's database is cloned below its guest parent, on its branch.
    expect(
      await readFile(
        join(root, "workspace/HomeOrg_GEN3/mission-control/db/.git/HEAD"),
        "utf8",
      ),
    ).toBe("ref: refs/heads/v3\n");
    expect(
      await readFile(join(root, "workspace/HomeOrg_GEN3/README.md"), "utf8"),
    ).toBe("Modules of HomeOrg.\n");
    expect(
      await exists(join(root, "workspace/HomeOrg_GEN3/private-notes")),
    ).toBe(false);
    // A guest is never prepared by the host: only its own app module was.
    expect(host.prepared).toEqual(["hostorg/mission-control"]);
    const catalog = await readFolderCatalog(folder);
    const organization = catalog.organizations[0];
    expect(organization?.executable).toBe(true);
    expect(organization?.modules.map((module) => module.path)).toEqual([
      "mission-control",
      "workspace/knowledgebase",
    ]);
    expect(
      organization?.guests?.map((guest) => [guest.path, guest.checkedOut]),
    ).toEqual([
      ["workspace/HomeOrg_GEN3/knowledgebase", true],
      ["workspace/HomeOrg_GEN3/mission-control", true],
      ["workspace/HomeOrg_GEN3/private-notes", false],
    ]);

    // Synchronization fast-forwards a guest and its database like any
    // module, and the root stays clean around their checkouts.
    const knowledgebase = await advance(current, "HomeOrg/knowledgebase");
    const data = await advance(current, "HomeOrg/mission-control-data", "v3");
    const run = await syncContent(folder, host, {});
    if (run.kind !== "content-sync") throw new Error(run.kind);
    const byPath = (entries: readonly SyncEntry[]) =>
      Object.fromEntries(
        entries.map((entry) => [
          entry.path,
          entry.reason === undefined
            ? entry.result
            : `${entry.result}:${entry.reason}`,
        ]),
      );
    expect(byPath(run.entries)).toEqual({
      ".": "current",
      "mission-control": "current",
      "mission-control/db": "current",
      "workspace/knowledgebase": "current",
      "workspace/HomeOrg_GEN3/knowledgebase": "fast-forwarded",
      "workspace/HomeOrg_GEN3/mission-control": "current",
      "workspace/HomeOrg_GEN3/mission-control/db": "fast-forwarded",
      "workspace/HomeOrg_GEN3/private-notes": "absent",
    });
    expect(
      run.entries.find(
        (entry) => entry.path === "workspace/HomeOrg_GEN3/knowledgebase",
      )?.to,
    ).toBe(knowledgebase);
    expect(
      run.entries.find(
        (entry) => entry.path === "workspace/HomeOrg_GEN3/mission-control/db",
      ),
    ).toMatchObject({ kind: "data", branch: "v3", to: data });
  },
);
