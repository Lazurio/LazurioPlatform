import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../../src/folder/initialize-folder";
import { executionOs } from "../../src/folder/platform";
import { expectedLegacyProjection } from "../../src/organizations/legacy-projection";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./owned-files";

// The fixture Folder of the catalog (launchpad-parity B1) and the module
// lifecycle (B3): canonical Organization roots under
// <Folder>/organizations/<directory>, written from nothing but these
// helpers. Synthetic names only.

export type Slot = { path: string; slug?: string; teams?: unknown } & Record<
  string,
  unknown
>;
export type ModuleFixture = {
  id: string;
  teams?: unknown;
  // More slot fields, such as the legacy Team alias.
  slot?: Record<string, unknown>;
  // An app-less module declares no app and no port.
  apps?: boolean;
  // The runtime declaration is missing, so the default app is invalid.
  broken?: boolean;
};

export function canonicalDocument(
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
export async function writeOrganization(
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
      const slot: Slot = {
        path: `workspace/${module.id}`,
        slug: module.id,
        ...module.slot,
      };
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
// module in two Teams, one canonical-only `current`), one whose manifest
// still uses the legacy Team alias, one invalid, one template, a file and a
// hidden directory that are not candidates.
export async function folderFixture(run: (folder: string) => Promise<void>) {
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
    // Team membership as the resident reads it: `teams`, else the legacy
    // `workspaces`, else the singular `workspace`, else the default Team.
    await writeOrganization(folder, "delta", {
      slug: "delta",
      state: "transition",
      teams: [
        { slug: "core", display_name: "Core" },
        { slug: "sales", display_name: "Sales" },
      ],
      modules: [
        { id: "crm", apps: false, slot: { workspaces: ["sales", "core"] } },
        { id: "wiki", apps: false, slot: { workspace: "core" } },
        { id: "misc", apps: false },
        {
          id: "pos",
          apps: false,
          teams: ["core"],
          slot: { workspace: "sales" },
        },
      ],
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
