import type { OrganizationSettingsIssue } from "../../src/organizations/organization-settings";

// Synthetic Organization manifests (`lazurio.organization.json`) and their
// cases, shared by the readers' tests and the schema test: each reader's test
// checks its own verdict on them, tests/organization-schema.test.ts checks
// that the schema of lazurio.organization.v1 gives the same one. Fictional
// names and identifiers only.

// biome-ignore lint/suspicious/noExplicitAny: adversarial wire fixtures intentionally replace typed fields with invalid types.
export type Manifest = Record<string, any>;
/** A named change of a manifest. */
export type ManifestCase = readonly [
  name: string,
  change: (manifest: Manifest) => void,
];
/** A named settings section and the issues the settings reader reports. */
export type SettingsCase = readonly [
  name: string,
  settings: unknown,
  issues: readonly OrganizationSettingsIssue[],
];

/** A verified manifest with every optional section the canonical reader
 * knows except `settings`. */
export function verifiedManifest(): Manifest {
  return {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "fixture",
      display_name: "Fixture Organization",
      forge_binding: {
        forge: "github",
        locator: "Fixture",
        binding_state: "verified",
        organization_id: "123",
      },
      metadata: { custom: { values: [1, "česky"] } },
    },
    root_repository: {
      forge: "github",
      locator: "Fixture/Fixture_GEN3",
      default_branch: "main",
      binding_state: "verified",
      repository_id: "456",
    },
    manifests: { modules: "modules.manifest.json" },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
    extensions: { legacy: { custom: { preserved: true } } },
    governance: {
      default_branch: "main",
      access_authority: "github",
      custom: "retained",
    },
    module_port_pool: { start: 5000, end: 5099 },
    teams: [
      {
        slug: "makers",
        display_name: "Makers",
        default: true,
        description: "Fixture",
        custom: "retained",
        forge_binding: {
          schema_version: "lazurio.team-forge-binding.github.v0",
          provider: "github",
          team: { id: "789", asserted_slug: "makers" },
        },
      },
    ],
    layers: [],
    task_sources: [],
    doctor: { custom: true },
  };
}

/** The smallest manifest: unverified, no root and, unless given, no
 * settings. */
export function unverifiedManifest(settings?: unknown): Manifest {
  const document: Manifest = {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "fixture",
      display_name: "Fixture",
      metadata: {},
      forge_binding: {
        forge: "github",
        locator: "Fixture",
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
  };
  if (settings !== undefined) document.settings = settings;
  return document;
}

/** The inventory (`modules.manifest.json`) beside both manifests. */
export const fixtureInventory = Object.freeze({
  company: "fixture",
  github_org: "Fixture",
  module_slots: Object.freeze([
    Object.freeze({ path: "workspace/app", slug: "app" }),
  ]),
});

const unverify = (v: Manifest) => {
  v.organization.forge_binding.binding_state = "unverified";
  delete v.organization.forge_binding.organization_id;
};

// The Microsoft 365 company app (DEV-6626 task 685, F42 addendum (c) of
// 2026-10-14): identifiers only, the same closed tree as Lazurio Core's
// (HumanAndMachines/Lazurio#549). Fictional tenant and address.
export const tenantId = "0000000a-0000-4000-8000-00000000000b";
export const clientId = "00000000-0000-4000-8000-000000000002";
export const callback =
  "https://launchpad.vm-01.contoso.lazurio.io/api/integrations/oauth/callback";
export const microsoft365 = {
  tenant_id: tenantId,
  client_id: clientId,
  apps: ["outlook", "one_drive", "share_point"],
  callbacks: [callback],
};

// Decision F32's addendum of 2026-10-16: the Organization's own tabs in
// Apps' Workspace are one setting, `workspace.tabs`.
export const workspaceTabs = [
  { name: "Každodenní práce", modules: ["deals", "knowledgebase"] },
  { name: "Finance", modules: ["invoices"] },
  { name: "Sklad", modules: [] },
];

/** A section with every setting this release knows. */
export const everySetting = {
  integrations: {
    composio: { allowed: true },
    chatgpt_apps: { allowed: false },
    microsoft365,
  },
  workspace: { tabs: workspaceTabs },
  access_requests: { enabled: true },
};

/** Settings sections the settings reader accepts. */
export const acceptedSettings: readonly (readonly [
  name: string,
  settings: unknown,
])[] = [
  ["empty section", {}],
  ["empty integrations", { integrations: {} }],
  ["Composio off", { integrations: { composio: { allowed: false } } }],
  ["Composio on", { integrations: { composio: { allowed: true } } }],
  ["ChatGPT apps off", { integrations: { chatgpt_apps: { allowed: false } } }],
  ["ChatGPT apps on", { integrations: { chatgpt_apps: { allowed: true } } }],
  [
    "Microsoft 365 company app beside Composio",
    { integrations: { composio: { allowed: false }, microsoft365 } },
  ],
  [
    "Microsoft 365 without a callback",
    { integrations: { microsoft365: { ...microsoft365, callbacks: [] } } },
  ],
  [
    "255 callbacks",
    {
      integrations: {
        microsoft365: {
          ...microsoft365,
          callbacks: Array.from(
            { length: 255 },
            (_, index) =>
              `https://launchpad.vm-${index}.contoso.lazurio.io/api/integrations/oauth/callback`,
          ),
        },
      },
    },
  ],
  ["Workspace tabs", { workspace: { tabs: workspaceTabs } }],
  [
    "12 tabs with names of 40 characters",
    {
      workspace: {
        tabs: Array.from({ length: 12 }, (_, index) => ({
          name: `${"x".repeat(38)}${String(index).padStart(2, "0")}`,
          modules: [`module-${index}`],
        })),
      },
    },
  ],
  [
    "a tab of 500 modules",
    {
      workspace: {
        tabs: [
          {
            name: "Vše",
            modules: Array.from({ length: 500 }, (_, index) => `m-${index}`),
          },
        ],
      },
    },
  ],
  ["access requests on", { access_requests: { enabled: true } }],
  ["access requests off", { access_requests: { enabled: false } }],
  ["every setting", everySetting],
];

/** Changes of the verified manifest the canonical reader accepts. */
export const manifestVariants: readonly ManifestCase[] = [
  [
    "template",
    (v) => {
      v.kind = "template";
    },
  ],
  [
    "unverified without root",
    (v) => {
      unverify(v);
      delete v.root_repository;
    },
  ],
  [
    "unverified with null root",
    (v) => {
      unverify(v);
      v.root_repository = null;
    },
  ],
  [
    "unverified root",
    (v) => {
      unverify(v);
      v.root_repository = {
        forge: "github",
        locator: "Fixture/another",
        default_branch: "main",
        binding_state: "unverified",
      };
    },
  ],
  [
    "root of any name, owner in other letter case",
    (v) => {
      v.root_repository.locator = "fixture/company-workspace";
    },
  ],
  [
    "IDs of 20 digits",
    (v) => {
      v.organization.forge_binding.organization_id = "9".repeat(20);
      v.root_repository.repository_id = `1${"0".repeat(19)}`;
    },
  ],
  [
    "one port at the lowest bound",
    (v) => {
      v.module_port_pool = { start: 1024, end: 1024 };
    },
  ],
  [
    "one port at the highest bound",
    (v) => {
      v.module_port_pool = { start: 65535, end: 65535 };
    },
  ],
  [
    "no optional section",
    (v) => {
      for (const key of [
        "governance",
        "teams",
        "layers",
        "task_sources",
        "doctor",
        "module_port_pool",
      ])
        delete v[key];
    },
  ],
  [
    "open sections with other content",
    (v) => {
      v.governance = {};
      v.teams = [{ slug: "Makers & Co.", display_name: " x" }];
      v.layers = [1, null, { any: "thing" }];
      v.task_sources = ["anything"];
      v.doctor = { nested: { deeper: [true] } };
      v.organization.metadata = { list: [], "any key": { deeper: null } };
      v.extensions.legacy = { organization_gen: "kept" };
    },
  ],
  [
    "names with inner spaces and any script",
    (v) => {
      v.organization.slug = "fixture\tcompany";
      v.organization.display_name = "Fixture  Organizace s.r.o. \u{1f680}";
    },
  ],
  [
    "every setting",
    (v) => {
      v.settings = everySetting;
    },
  ],
];

/** Changes of the verified manifest the canonical reader refuses. */
export const manifestRefusals: readonly ManifestCase[] = [
  [
    "schema",
    (v) => {
      v.schema_version = "next";
    },
  ],
  [
    "missing schema version",
    (v) => {
      delete v.schema_version;
    },
  ],
  ...["kind", "manifests", "extensions", "compatibility"].map(
    (key): ManifestCase => [
      `missing ${key}`,
      (v) => {
        delete v[key];
      },
    ],
  ),
  [
    "kind",
    (v) => {
      v.kind = "machine";
    },
  ],
  [
    "kind type",
    (v) => {
      v.kind = ["organization"];
    },
  ],
  [
    "unknown root field",
    (v) => {
      v.extra = true;
    },
  ],
  [
    "missing identity",
    (v) => {
      delete v.organization;
    },
  ],
  [
    "trimmed identity",
    (v) => {
      v.organization.slug = " fixture";
    },
  ],
  [
    "trailing white space",
    (v) => {
      v.organization.display_name = "Fixture ";
    },
  ],
  [
    "line break inside a name",
    (v) => {
      v.organization.display_name = "Fixture\nOrganization";
    },
  ],
  [
    "NUL inside a slug",
    (v) => {
      v.organization.slug = "fix\u0000ture";
    },
  ],
  [
    "blank name",
    (v) => {
      v.organization.display_name = "";
    },
  ],
  [
    "slug type",
    (v) => {
      v.organization.slug = 1;
    },
  ],
  [
    "identity field",
    (v) => {
      v.organization.extra = true;
    },
  ],
  // The projection's company object writes these itself.
  ...[
    "slug",
    "display_name",
    "github_org",
    "repository",
    "git_url",
    "root_repository",
    "default_branch",
  ].map(
    (key): ManifestCase => [
      `metadata collision on ${key}`,
      (v) => {
        v.organization.metadata[key] = "Other";
      },
    ],
  ),
  [
    "metadata type",
    (v) => {
      v.organization.metadata = [];
    },
  ],
  [
    "missing metadata",
    (v) => {
      delete v.organization.metadata;
    },
  ],
  [
    "forge",
    (v) => {
      v.organization.forge_binding.forge = "local";
    },
  ],
  [
    "owner locator",
    (v) => {
      v.organization.forge_binding.locator = "bad-";
    },
  ],
  [
    "owner locator of 40 characters",
    (v) => {
      v.organization.forge_binding.locator = "F".repeat(40);
    },
  ],
  [
    "owner ID",
    (v) => {
      v.organization.forge_binding.organization_id = 123;
    },
  ],
  [
    "owner ID with a leading zero",
    (v) => {
      v.organization.forge_binding.organization_id = "0123";
    },
  ],
  [
    "owner ID of 21 digits",
    (v) => {
      v.organization.forge_binding.organization_id = "1".repeat(21);
    },
  ],
  [
    "missing verified ID",
    (v) => {
      delete v.organization.forge_binding.organization_id;
    },
  ],
  [
    "unverified ID",
    (v) => {
      v.organization.forge_binding.binding_state = "unverified";
    },
  ],
  [
    "unverified Organization with an ID",
    (v) => {
      v.organization.forge_binding.binding_state = "unverified";
      delete v.root_repository;
    },
  ],
  [
    "unknown binding state",
    (v) => {
      v.organization.forge_binding.binding_state = "active";
    },
  ],
  [
    "unknown binding state without an ID or root",
    (v) => {
      unverify(v);
      v.organization.forge_binding.binding_state = "pending";
      delete v.root_repository;
    },
  ],
  [
    "missing owner binding",
    (v) => {
      delete v.organization.forge_binding;
      delete v.root_repository;
    },
  ],
  [
    "missing owner locator",
    (v) => {
      delete v.organization.forge_binding.locator;
    },
  ],
  [
    "binding extra",
    (v) => {
      v.organization.forge_binding.extra = true;
    },
  ],
  [
    "missing verified root",
    (v) => {
      delete v.root_repository;
    },
  ],
  [
    "null verified root",
    (v) => {
      v.root_repository = null;
    },
  ],
  [
    "different owner",
    (v) => {
      v.root_repository.locator = "Other/Other_GEN3";
    },
  ],
  [
    "Git URL instead of locator",
    (v) => {
      v.root_repository.locator = "git@github.com:Fixture/Fixture_GEN3.git";
    },
  ],
  [
    "locator ending in .git",
    (v) => {
      v.root_repository.locator = "Fixture/Fixture_GEN3.git";
    },
  ],
  [
    "root type",
    (v) => {
      v.root_repository = "Fixture/Fixture_GEN3";
    },
  ],
  [
    "root forge",
    (v) => {
      v.root_repository.forge = "gitlab";
    },
  ],
  [
    "root extra",
    (v) => {
      v.root_repository.extra = true;
    },
  ],
  [
    "branch",
    (v) => {
      v.root_repository.default_branch = "dev";
    },
  ],
  [
    "missing branch",
    (v) => {
      delete v.root_repository.default_branch;
    },
  ],
  [
    "root ID",
    (v) => {
      v.root_repository.repository_id = "0";
    },
  ],
  [
    "missing verified root ID",
    (v) => {
      delete v.root_repository.repository_id;
    },
  ],
  [
    "unknown root binding state",
    (v) => {
      unverify(v);
      v.root_repository.binding_state = "pending";
      delete v.root_repository.repository_id;
    },
  ],
  [
    "mixed binding states",
    (v) => {
      v.root_repository.binding_state = "unverified";
      delete v.root_repository.repository_id;
    },
  ],
  [
    "verified root of an unverified Organization",
    (v) => {
      unverify(v);
    },
  ],
  [
    "unverified root with an ID",
    (v) => {
      unverify(v);
      v.root_repository.binding_state = "unverified";
    },
  ],
  [
    "modules pointer",
    (v) => {
      v.manifests.modules = "../modules.json";
    },
  ],
  [
    "missing modules pointer",
    (v) => {
      v.manifests = {};
    },
  ],
  [
    "manifests extra",
    (v) => {
      v.manifests.layers = "layers.json";
    },
  ],
  [
    "projection pointer",
    (v) => {
      v.compatibility.legacy_projection.path = "elsewhere.json";
    },
  ],
  [
    "projection algorithm",
    (v) => {
      v.compatibility.legacy_projection.algorithm = "sha256";
    },
  ],
  [
    "projection digest",
    (v) => {
      v.compatibility.legacy_projection.sha256 = "bad";
    },
  ],
  [
    "projection digest in capitals",
    (v) => {
      v.compatibility.legacy_projection.sha256 = `sha256:${"A".repeat(64)}`;
    },
  ],
  [
    "projection extra",
    (v) => {
      v.compatibility.legacy_projection.signed = true;
    },
  ],
  [
    "missing projection",
    (v) => {
      v.compatibility = {};
    },
  ],
  [
    "compatibility extra",
    (v) => {
      v.compatibility.other = {};
    },
  ],
  // The legacy projection writes these itself.
  ...[
    "organization_generation",
    "organization_kind",
    "company",
    "forge_binding",
    "governance",
    "teams",
    "layers",
    "task_sources",
    "doctor",
    "module_port_pool",
    "modules",
    "default_branch",
  ].map(
    (key): ManifestCase => [
      `extension collision on ${key}`,
      (v) => {
        v.extensions.legacy[key] = {};
      },
    ],
  ),
  [
    "missing legacy extension",
    (v) => {
      v.extensions = {};
    },
  ],
  [
    "legacy extension type",
    (v) => {
      v.extensions.legacy = null;
    },
  ],
  [
    "extensions extra",
    (v) => {
      v.extensions.other = {};
    },
  ],
  [
    "port range",
    (v) => {
      v.module_port_pool.end = 1023;
    },
  ],
  [
    "port above the range",
    (v) => {
      v.module_port_pool.end = 65536;
    },
  ],
  [
    "port order",
    (v) => {
      v.module_port_pool.start = 5100;
    },
  ],
  [
    "port fractional",
    (v) => {
      v.module_port_pool.start = 5000.5;
    },
  ],
  [
    "port as text",
    (v) => {
      v.module_port_pool.start = "5000";
    },
  ],
  [
    "port extra",
    (v) => {
      v.module_port_pool.extra = 1;
    },
  ],
  [
    "missing port end",
    (v) => {
      delete v.module_port_pool.end;
    },
  ],
  [
    "port pool null",
    (v) => {
      v.module_port_pool = null;
    },
  ],
  [
    "governance authority",
    (v) => {
      v.governance.access_authority = "dashboard";
    },
  ],
  [
    "governance branch",
    (v) => {
      v.governance.default_branch = "dev";
    },
  ],
  [
    "governance type",
    (v) => {
      v.governance = null;
    },
  ],
  [
    "doctor type",
    (v) => {
      v.doctor = [];
    },
  ],
  [
    "layers type",
    (v) => {
      v.layers = {};
    },
  ],
  [
    "task sources type",
    (v) => {
      v.task_sources = {};
    },
  ],
  [
    "teams type",
    (v) => {
      v.teams = {};
    },
  ],
  [
    "team type",
    (v) => {
      v.teams = ["makers"];
    },
  ],
  [
    "team identity",
    (v) => {
      delete v.teams[0].slug;
    },
  ],
  [
    "team without a name",
    (v) => {
      delete v.teams[0].display_name;
    },
  ],
  [
    "empty team slug",
    (v) => {
      v.teams[0].slug = "";
    },
  ],
  [
    "empty team name",
    (v) => {
      v.teams[0].display_name = "";
    },
  ],
  [
    "team name type",
    (v) => {
      v.teams[0].display_name = 1;
    },
  ],
  [
    "team default",
    (v) => {
      v.teams[0].default = "yes";
    },
  ],
  [
    "team description",
    (v) => {
      v.teams[0].description = null;
    },
  ],
  [
    "team binding schema",
    (v) => {
      v.teams[0].forge_binding.schema_version =
        "lazurio.forge-binding.github.v0";
    },
  ],
  [
    "team provider",
    (v) => {
      v.teams[0].forge_binding.provider = "local";
    },
  ],
  [
    "team binding extra",
    (v) => {
      v.teams[0].forge_binding.extra = true;
    },
  ],
  [
    "team ID",
    (v) => {
      v.teams[0].forge_binding.team.id = "01";
    },
  ],
  [
    "team locator",
    (v) => {
      v.teams[0].forge_binding.team.asserted_slug = "Bad";
    },
  ],
  [
    "team binding without its team",
    (v) => {
      delete v.teams[0].forge_binding.team;
    },
  ],
  [
    "team identity extra",
    (v) => {
      v.teams[0].forge_binding.team.login = "makers";
    },
  ],
];

const issue = (
  code: OrganizationSettingsIssue["code"],
  path: string,
): OrganizationSettingsIssue => ({ code, path });

/** Malformed sections, each with its exact issues. */
export const malformedSettings: readonly SettingsCase[] = [
  ["null section", null, [issue("settings_type_invalid", "/settings")]],
  ["array section", [], [issue("settings_type_invalid", "/settings")]],
  ["text section", "off", [issue("settings_type_invalid", "/settings")]],
  [
    "unknown setting",
    { policies: {} },
    [issue("settings_field_unknown", "/settings/policies")],
  ],
  [
    "null integrations",
    { integrations: null },
    [issue("settings_type_invalid", "/settings/integrations")],
  ],
  [
    "unknown integration",
    { integrations: { slack: {} } },
    [issue("settings_field_unknown", "/settings/integrations/slack")],
  ],
  [
    "Composio as a boolean",
    { integrations: { composio: true } },
    [issue("settings_type_invalid", "/settings/integrations/composio")],
  ],
  [
    "Composio without allowed",
    { integrations: { composio: {} } },
    [
      issue(
        "settings_field_missing",
        "/settings/integrations/composio/allowed",
      ),
    ],
  ],
  [
    "allowed as text",
    { integrations: { composio: { allowed: "false" } } },
    [issue("settings_type_invalid", "/settings/integrations/composio/allowed")],
  ],
  [
    "unknown Composio field",
    { integrations: { composio: { allowed: false, mode: "organization" } } },
    [issue("settings_field_unknown", "/settings/integrations/composio/mode")],
  ],
  [
    "key that needs escaping",
    { "a/b~c": 1 },
    [issue("settings_field_unknown", "/settings/a~1b~0c")],
  ],
];

const at365 = "/settings/integrations/microsoft365";
const company = (value: Record<string, unknown>) => ({
  integrations: { microsoft365: value },
});

/** Microsoft 365 company apps that break the closed tree: a secret, or
 * anything that could carry one, never passes. */
export const microsoft365Refusals: readonly SettingsCase[] = [
  // A public client has no secret: the field does not exist.
  [
    "client secret",
    company({ ...microsoft365, client_secret: "abc8Q~not-a-real-secret" }),
    [issue("settings_field_unknown", `${at365}/client_secret`)],
  ],
  // Identifiers are lowercase GUIDs; a secret pasted in their place is not.
  [
    "secret as the client ID",
    company({ ...microsoft365, client_id: "abc8Q~not-a-real-secret" }),
    [issue("settings_value_invalid", `${at365}/client_id`)],
  ],
  [
    "tenant ID in capitals",
    company({ ...microsoft365, tenant_id: tenantId.toUpperCase() }),
    [issue("settings_value_invalid", `${at365}/tenant_id`)],
  ],
  [
    "tenant ID as a number",
    company({ ...microsoft365, tenant_id: 42 }),
    [issue("settings_type_invalid", `${at365}/tenant_id`)],
  ],
  // A callback is the Launchpad's, https, without port, query or fragment.
  [
    "callbacks of other hosts, a query, a port or twice",
    company({
      ...microsoft365,
      callbacks: [
        `${callback}?code=abc`,
        "http://launchpad.example.com/api/integrations/oauth/callback",
        "https://launchpad.example.com:8443/api/integrations/oauth/callback",
        "https://Launchpad.example.com/api/integrations/oauth/callback",
        "https://launchpad.example.com/elsewhere",
        callback,
        callback,
        // Any host but a Launchpad's would receive the authorization
        // response (Pablo's review of HumanAndMachines/Lazurio#549).
        "https://attacker.example/api/integrations/oauth/callback",
        "https://launchpad.m.org.lazurio.io.attacker.example/api/integrations/oauth/callback",
        "https://launchpad.example.com/api/integrations/oauth/callback",
        "https://evil.vm-01.contoso.lazurio.io/api/integrations/oauth/callback",
      ],
    }),
    // Issues sort by their pointer, as text.
    [0, 1, 10, 2, 3, 4, 6, 7, 8, 9].map((index) =>
      issue("settings_value_invalid", `${at365}/callbacks/${index}`),
    ),
  ],
  // Each alone: only a Launchpad's exact callback address passes.
  ...(
    [
      ["callback with a query", `${callback}?code=abc`],
      ["callback with a fragment", `${callback}#state`],
      ["callback with a trailing slash", `${callback}/`],
      [
        "callback over http",
        "http://launchpad.vm-01.contoso.lazurio.io/api/integrations/oauth/callback",
      ],
      [
        "callback with a port",
        "https://launchpad.vm-01.contoso.lazurio.io:8443/api/integrations/oauth/callback",
      ],
      [
        "callback host in capitals",
        "https://launchpad.vm-01.Contoso.lazurio.io/api/integrations/oauth/callback",
      ],
      [
        "callback of another path",
        "https://launchpad.vm-01.contoso.lazurio.io/api/integrations/oauth/other",
      ],
      [
        "callback of another service",
        "https://evil.vm-01.contoso.lazurio.io/api/integrations/oauth/callback",
      ],
      [
        "callback under another domain",
        "https://launchpad.vm-01.contoso.lazurio.io.attacker.example/api/integrations/oauth/callback",
      ],
      [
        "callback of a login with a trailing hyphen",
        "https://launchpad.vm-01.contoso-.lazurio.io/api/integrations/oauth/callback",
      ],
    ] as const
  ).map(
    ([name, value]): SettingsCase => [
      name,
      company({ ...microsoft365, callbacks: [value] }),
      [issue("settings_value_invalid", `${at365}/callbacks/0`)],
    ],
  ),
  [
    "callback twice",
    company({ ...microsoft365, callbacks: [callback, callback] }),
    [issue("settings_value_invalid", `${at365}/callbacks/1`)],
  ],
  [
    "callbacks as text",
    company({ ...microsoft365, callbacks: callback }),
    [issue("settings_type_invalid", `${at365}/callbacks`)],
  ],
  [
    "Teams app",
    company({ ...microsoft365, apps: ["microsoft_teams"] }),
    [issue("settings_value_invalid", `${at365}/apps/0`)],
  ],
  [
    "app twice",
    company({ ...microsoft365, apps: ["outlook", "outlook"] }),
    [issue("settings_value_invalid", `${at365}/apps/1`)],
  ],
  [
    "apps as text",
    company({ ...microsoft365, apps: "outlook" }),
    [issue("settings_type_invalid", `${at365}/apps`)],
  ],
  [
    "missing client ID",
    company({ tenant_id: tenantId, apps: ["outlook"], callbacks: [] }),
    [issue("settings_field_missing", `${at365}/client_id`)],
  ],
  [
    "company app as a boolean",
    { integrations: { microsoft365: true } },
    [issue("settings_type_invalid", at365)],
  ],
  // Apps of the catalog only, Teams not yet, at least one, each once.
  [
    "apps outside the catalog or twice",
    company({
      ...microsoft365,
      apps: ["outlook", "microsoft_teams", "outlook", 3],
    }),
    [
      issue("settings_value_invalid", `${at365}/apps/1`),
      issue("settings_value_invalid", `${at365}/apps/2`),
      issue("settings_type_invalid", `${at365}/apps/3`),
    ],
  ],
  [
    "no app",
    company({ ...microsoft365, apps: [] }),
    [issue("settings_value_invalid", `${at365}/apps`)],
  ],
  // At most 255 callbacks: Entra registers 256, the localhost one included.
  [
    "256 callbacks",
    company({
      ...microsoft365,
      callbacks: Array.from(
        { length: 256 },
        (_, index) =>
          `https://launchpad.vm-${index}.contoso.lazurio.io/api/integrations/oauth/callback`,
      ),
    }),
    [issue("settings_value_invalid", `${at365}/callbacks`)],
  ],
  [
    "missing callbacks",
    company({ tenant_id: tenantId, client_id: clientId, apps: ["outlook"] }),
    [issue("settings_field_missing", `${at365}/callbacks`)],
  ],
];

const tab = (name: string, modules: unknown[] = []) => ({ name, modules });

/** Workspace tabs the settings reader refuses. */
export const workspaceTabsRefusals: readonly SettingsCase[] = [
  [
    "workspace without tabs",
    { workspace: {} },
    [issue("settings_field_missing", "/settings/workspace/tabs")],
  ],
  [
    "workspace as a list",
    { workspace: [] },
    [issue("settings_type_invalid", "/settings/workspace")],
  ],
  [
    "tabs as an object",
    { workspace: { tabs: {} } },
    [issue("settings_type_invalid", "/settings/workspace/tabs")],
  ],
  [
    "tab as text",
    { workspace: { tabs: ["Finance"] } },
    [issue("settings_type_invalid", "/settings/workspace/tabs/0")],
  ],
  [
    "tab name as a number",
    { workspace: { tabs: [{ name: 1, modules: [] }] } },
    [issue("settings_type_invalid", "/settings/workspace/tabs/0/name")],
  ],
  [
    "modules as text",
    { workspace: { tabs: [{ name: "Finance", modules: "deals" }] } },
    [issue("settings_type_invalid", "/settings/workspace/tabs/0/modules")],
  ],
  [
    "module id as a number",
    { workspace: { tabs: [tab("Finance", [1])] } },
    [issue("settings_type_invalid", "/settings/workspace/tabs/0/modules/0")],
  ],
  [
    "no tab",
    { workspace: { tabs: [] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs")],
  ],
  [
    "13 tabs",
    {
      workspace: {
        tabs: Array.from({ length: 13 }, (_, i) => tab(`T${i}`)),
      },
    },
    [issue("settings_value_invalid", "/settings/workspace/tabs")],
  ],
  [
    "tab name with a leading space",
    { workspace: { tabs: [tab(" Finance")] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs/0/name")],
  ],
  [
    "tab name of 41 characters",
    { workspace: { tabs: [tab("x".repeat(41))] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs/0/name")],
  ],
  [
    "tab name with a line break",
    { workspace: { tabs: [tab("Fi\nnance")] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs/0/name")],
  ],
  [
    "tab name with a line separator",
    { workspace: { tabs: [tab("Fi nance")] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs/0/name")],
  ],
  [
    "module outside the module id grammar",
    { workspace: { tabs: [tab("Finance", ["../deals"])] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs/0/modules/0")],
  ],
  [
    "module id of 64 characters",
    { workspace: { tabs: [tab("Finance", ["m".repeat(64)])] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs/0/modules/0")],
  ],
  [
    "module twice in one tab",
    { workspace: { tabs: [tab("Finance", ["deals", "deals"])] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs/0/modules/1")],
  ],
  [
    "a tab of 501 modules",
    {
      workspace: {
        tabs: [
          tab(
            "Vše",
            Array.from({ length: 501 }, (_, index) => `m-${index}`),
          ),
        ],
      },
    },
    [issue("settings_value_invalid", "/settings/workspace/tabs/0/modules")],
  ],
  [
    "tab without modules",
    { workspace: { tabs: [{ name: "Finance" }] } },
    [issue("settings_field_missing", "/settings/workspace/tabs/0/modules")],
  ],
  [
    "unknown tab field",
    { workspace: { tabs: [{ ...tab("Finance"), icon: "x" }] } },
    [issue("settings_field_unknown", "/settings/workspace/tabs/0/icon")],
  ],
  [
    "tab names equal ignoring case",
    { workspace: { tabs: [tab("Finance", ["deals"]), tab("FINANCE")] } },
    [issue("settings_value_invalid", "/settings/workspace/tabs/1/name")],
  ],
  [
    "module in two tabs",
    {
      workspace: {
        tabs: [tab("Finance", ["deals"]), tab("Sklad", ["deals"])],
      },
    },
    [issue("settings_value_invalid", "/settings/workspace/tabs/1/modules/0")],
  ],
];

const atRequests = "/settings/access_requests";

/** Access requests that break their closed object with a required boolean. */
export const accessRequestsRefusals: readonly SettingsCase[] = [
  [
    "access requests without enabled",
    { access_requests: {} },
    [issue("settings_field_missing", `${atRequests}/enabled`)],
  ],
  [
    "enabled as text",
    { access_requests: { enabled: "yes" } },
    [issue("settings_type_invalid", `${atRequests}/enabled`)],
  ],
  [
    "enabled as a number",
    { access_requests: { enabled: 1 } },
    [issue("settings_type_invalid", `${atRequests}/enabled`)],
  ],
  [
    "enabled null",
    { access_requests: { enabled: null } },
    [issue("settings_type_invalid", `${atRequests}/enabled`)],
  ],
  [
    "unknown access request field",
    { access_requests: { enabled: true, team: "guests" } },
    [issue("settings_field_unknown", `${atRequests}/team`)],
  ],
  [
    "access requests as a boolean",
    { access_requests: true },
    [issue("settings_type_invalid", atRequests)],
  ],
  // A broken one withholds the whole section, Composio included.
  [
    "broken access requests beside Composio",
    {
      integrations: { composio: { allowed: true } },
      access_requests: { enabled: "yes" },
    },
    [issue("settings_type_invalid", `${atRequests}/enabled`)],
  ],
];

const atChatgpt = "/settings/integrations/chatgpt_apps";

/** ChatGPT apps: `allowed` is required once the group is there, and only a
 * boolean. */
export const chatgptAppsRefusals: readonly SettingsCase[] = [
  [
    "ChatGPT apps as a boolean",
    { integrations: { chatgpt_apps: true } },
    [issue("settings_type_invalid", atChatgpt)],
  ],
  [
    "ChatGPT apps without allowed",
    { integrations: { chatgpt_apps: {} } },
    [issue("settings_field_missing", `${atChatgpt}/allowed`)],
  ],
  [
    "ChatGPT apps allowed as text, with a plugin field",
    { integrations: { chatgpt_apps: { allowed: "no", plugins: true } } },
    [
      issue("settings_type_invalid", `${atChatgpt}/allowed`),
      issue("settings_field_unknown", `${atChatgpt}/plugins`),
    ],
  ],
];
