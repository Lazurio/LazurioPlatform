import { expect, test } from "bun:test";
import { declaresRoot } from "../src/content/organization-root";
import { parseCanonicalOrganization } from "../src/organizations/canonical-manifest";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import {
  type OrganizationSettingsEntry,
  type OrganizationSettingsIssue,
  organizationSettings,
  organizationSettingsIssueCodes,
  organizationSettingsKeys,
} from "../src/organizations/organization-settings";
import type { readOrganizationDocuments } from "../src/organizations/read-documents";
import { resolveOrganizationRootDocuments } from "../src/organizations/root-resolution";

// The upstream contract C1 (Lazurio Core `organization-settings-lib.mjs`,
// decision 0194): the same fixtures and the same issue codes and pointers as
// Core's own tests, so both readers judge one section identically.

const modules = {
  company: "fixture",
  github_org: "Fixture",
  module_slots: [{ path: "workspace/app", slug: "app" }],
};

function manifest(settings?: unknown): Record<string, unknown> {
  const document: Record<string, unknown> = {
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

const ungoverned: OrganizationSettingsEntry[] = [
  { key: "integrations.composio.allowed", governed: false, value: null },
  { key: "integrations.microsoft365.tenant_id", governed: false, value: null },
  { key: "integrations.microsoft365.client_id", governed: false, value: null },
  { key: "integrations.microsoft365.apps", governed: false, value: null },
  { key: "integrations.microsoft365.callbacks", governed: false, value: null },
  { key: "workspace.tabs", governed: false, value: null },
];
const issue = (
  code: OrganizationSettingsIssue["code"],
  path: string,
): OrganizationSettingsIssue => ({ code, path });

test("the settings vocabulary is the upstream one", () => {
  expect(organizationSettingsKeys).toEqual([
    "integrations.composio.allowed",
    "integrations.microsoft365.tenant_id",
    "integrations.microsoft365.client_id",
    "integrations.microsoft365.apps",
    "integrations.microsoft365.callbacks",
    "workspace.tabs",
  ]);
  expect(organizationSettingsIssueCodes).toEqual([
    "settings_field_missing",
    "settings_field_unknown",
    "settings_type_invalid",
    "settings_value_invalid",
  ]);
});

test("an absent section governs nothing and every level is optional", () => {
  expect(organizationSettings(parseCanonicalOrganization(manifest()))).toEqual({
    status: "absent",
    values: {},
    effective: ungoverned,
    issues: [],
  });
  for (const settings of [{}, { integrations: {} }])
    expect(
      organizationSettings(parseCanonicalOrganization(manifest(settings))),
    ).toEqual({
      status: "valid",
      values: settings,
      effective: ungoverned,
      issues: [],
    });
  for (const allowed of [false, true]) {
    const settings = { integrations: { composio: { allowed } } };
    expect(
      organizationSettings(parseCanonicalOrganization(manifest(settings))),
    ).toEqual({
      status: "valid",
      values: settings,
      effective: [
        {
          key: "integrations.composio.allowed",
          governed: true,
          value: allowed,
        },
        ...ungoverned.slice(1),
      ],
      issues: [],
    });
  }
});

test("an invalid section never breaks the manifest and is reported with exact pointers", () => {
  const cases: [unknown, OrganizationSettingsIssue[]][] = [
    [null, [issue("settings_type_invalid", "/settings")]],
    [[], [issue("settings_type_invalid", "/settings")]],
    ["off", [issue("settings_type_invalid", "/settings")]],
    [{ policies: {} }, [issue("settings_field_unknown", "/settings/policies")]],
    [
      { integrations: null },
      [issue("settings_type_invalid", "/settings/integrations")],
    ],
    [
      { integrations: { slack: {} } },
      [issue("settings_field_unknown", "/settings/integrations/slack")],
    ],
    [
      { integrations: { composio: true } },
      [issue("settings_type_invalid", "/settings/integrations/composio")],
    ],
    [
      { integrations: { composio: {} } },
      [
        issue(
          "settings_field_missing",
          "/settings/integrations/composio/allowed",
        ),
      ],
    ],
    [
      { integrations: { composio: { allowed: "false" } } },
      [
        issue(
          "settings_type_invalid",
          "/settings/integrations/composio/allowed",
        ),
      ],
    ],
    [
      { integrations: { composio: { allowed: false, mode: "organization" } } },
      [issue("settings_field_unknown", "/settings/integrations/composio/mode")],
    ],
    [{ "a/b~c": 1 }, [issue("settings_field_unknown", "/settings/a~1b~0c")]],
  ];
  for (const [settings, issues] of cases) {
    // A malformed optional section must not take the Organization (and with it
    // the Launchpad catalog and content synchronization) down.
    const parsed = parseCanonicalOrganization(manifest(settings));
    expect(parsed.settings).toEqual(settings);
    expect(organizationSettings(parsed), JSON.stringify(settings)).toEqual({
      status: "invalid",
      values: null,
      effective: null,
      issues,
    });
  }
});

test("an invalid section is never partially applied and its issues have a stable order", () => {
  const settings = {
    zeta: true,
    integrations: { composio: { mode: "x" }, alpha: 1 },
    beta: false,
  };
  expect(
    organizationSettings(parseCanonicalOrganization(manifest(settings))),
  ).toEqual({
    status: "invalid",
    values: null,
    effective: null,
    issues: [
      issue("settings_field_unknown", "/settings/beta"),
      issue("settings_field_unknown", "/settings/integrations/alpha"),
      issue(
        "settings_field_missing",
        "/settings/integrations/composio/allowed",
      ),
      issue("settings_field_unknown", "/settings/integrations/composio/mode"),
      issue("settings_field_unknown", "/settings/zeta"),
    ],
  });
});

test("the verdict is a frozen copy and the parser still refuses other unknown fields", () => {
  const input = manifest({ integrations: { composio: { allowed: false } } });
  const result = organizationSettings(parseCanonicalOrganization(input));
  (
    input.settings as { integrations: { composio: { allowed: boolean } } }
  ).integrations.composio.allowed = true;
  expect(result.values).toEqual({
    integrations: { composio: { allowed: false } },
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.effective?.[0])).toBe(true);

  const shadow = manifest({ integrations: { composio: { allowed: false } } });
  shadow.policies = { composio: false };
  expect(() => parseCanonicalOrganization(shadow)).toThrow(
    "Unknown module field",
  );
});

test("settings never change the projection, the root state or the root declaration", () => {
  const unpinned = manifest();
  const plain = {
    ...unpinned,
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: expectedLegacyProjection(unpinned, modules).hash,
      },
    },
  };
  const projection = expectedLegacyProjection(plain, modules).projection;
  expect(projection).not.toHaveProperty("settings");
  for (const settings of [
    { integrations: { composio: { allowed: false } } },
    { integrations: { composio: { allowed: "no" } } },
  ]) {
    // Editing settings never regenerates company.gen3.json: same projection
    // and declared hash, so a transition root stays transition and runs.
    const governed = { ...plain, settings };
    expect(expectedLegacyProjection(governed, modules)).toMatchObject({
      projection,
      declaredHashMatches: true,
    });
    expect(
      resolveOrganizationRootDocuments(
        observed({ canonical: governed, legacy: projection }),
      ),
    ).toEqual({ state: "transition", executable: true, issues: [] });
    const root = {
      ...governed,
      root_repository: {
        forge: "github",
        locator: "Fixture/Fixture_GEN3",
        default_branch: "main",
        binding_state: "unverified",
      },
    };
    expect(declaresRoot(root, "Fixture", "Fixture/Fixture_GEN3")).toBe(true);
  }
});

type Documents = Extract<
  Awaited<ReturnType<typeof readOrganizationDocuments>>,
  { kind: "documents-observed" }
>;

function observed(input: { canonical: unknown; legacy: unknown }): Documents {
  const present = (value: unknown) =>
    Object.freeze({
      kind: "present" as const,
      value: value as Readonly<Record<string, unknown>>,
    });
  return Object.freeze({
    kind: "documents-observed" as const,
    canonical: present(input.canonical),
    legacy: present(input.legacy),
    modules: present(modules),
  });
}

// The Microsoft 365 company app (DEV-6626 task 685, F42 addendum (c) of
// 2026-10-14): identifiers only, the same closed tree as Lazurio Core's
// (HumanAndMachines/Lazurio#549). Fictional tenant and address.
const tenantId = "0000000a-0000-4000-8000-00000000000b";
const clientId = "00000000-0000-4000-8000-000000000002";
const callback =
  "https://launchpad.vm-01.contoso.lazurio.io/api/integrations/oauth/callback";
const microsoft365 = {
  tenant_id: tenantId,
  client_id: clientId,
  apps: ["outlook", "one_drive", "share_point"],
  callbacks: [callback],
};

test("the Microsoft 365 company app is identifiers beside Composio, and never rejects the section", () => {
  // An Organization adding the company app keeps its Composio switch applying.
  const settings = {
    integrations: { composio: { allowed: false }, microsoft365 },
  };
  expect(
    organizationSettings(parseCanonicalOrganization(manifest(settings))),
  ).toEqual({
    status: "valid",
    values: settings,
    effective: [
      { key: "integrations.composio.allowed", governed: true, value: false },
      {
        key: "integrations.microsoft365.tenant_id",
        governed: true,
        value: tenantId,
      },
      {
        key: "integrations.microsoft365.client_id",
        governed: true,
        value: clientId,
      },
      {
        key: "integrations.microsoft365.apps",
        governed: true,
        value: microsoft365.apps,
      },
      {
        key: "integrations.microsoft365.callbacks",
        governed: true,
        value: [callback],
      },
      { key: "workspace.tabs", governed: false, value: null },
    ],
    issues: [],
  });
  // No callback registered yet: every Environment signs in through its
  // Environment browser.
  const without = {
    integrations: { microsoft365: { ...microsoft365, callbacks: [] } },
  };
  expect(
    organizationSettings(parseCanonicalOrganization(manifest(without))).status,
  ).toBe("valid");
});

test("a secret, or anything that could carry one, never passes as the Microsoft 365 setting", () => {
  const at = "/settings/integrations/microsoft365";
  const cases: [Record<string, unknown>, OrganizationSettingsIssue[]][] = [
    // A public client has no secret: the field does not exist.
    [
      { ...microsoft365, client_secret: "abc8Q~not-a-real-secret" },
      [issue("settings_field_unknown", `${at}/client_secret`)],
    ],
    // Identifiers are lowercase GUIDs; a secret pasted in their place is not.
    [
      { ...microsoft365, client_id: "abc8Q~not-a-real-secret" },
      [issue("settings_value_invalid", `${at}/client_id`)],
    ],
    [
      { ...microsoft365, tenant_id: tenantId.toUpperCase() },
      [issue("settings_value_invalid", `${at}/tenant_id`)],
    ],
    [
      { ...microsoft365, tenant_id: 42 },
      [issue("settings_type_invalid", `${at}/tenant_id`)],
    ],
    // A callback is the Launchpad's, https, without port, query or fragment.
    [
      {
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
      },
      // Issues sort by their pointer, as text.
      [0, 1, 10, 2, 3, 4, 6, 7, 8, 9].map((index) =>
        issue("settings_value_invalid", `${at}/callbacks/${index}`),
      ),
    ],
    // Apps of the catalog only, Teams not yet, at least one, each once.
    [
      { ...microsoft365, apps: ["outlook", "microsoft_teams", "outlook", 3] },
      [
        issue("settings_value_invalid", `${at}/apps/1`),
        issue("settings_value_invalid", `${at}/apps/2`),
        issue("settings_type_invalid", `${at}/apps/3`),
      ],
    ],
    [
      { ...microsoft365, apps: [] },
      [issue("settings_value_invalid", `${at}/apps`)],
    ],
    // At most 255 callbacks: Entra registers 256, the localhost one included.
    [
      {
        ...microsoft365,
        callbacks: Array.from(
          { length: 256 },
          (_, index) =>
            `https://launchpad.vm-${index}.contoso.lazurio.io/api/integrations/oauth/callback`,
        ),
      },
      [issue("settings_value_invalid", `${at}/callbacks`)],
    ],
    [
      { tenant_id: tenantId, client_id: clientId, apps: ["outlook"] },
      [issue("settings_field_missing", `${at}/callbacks`)],
    ],
  ];
  for (const [value, issues] of cases)
    expect(
      organizationSettings(
        parseCanonicalOrganization(
          manifest({ integrations: { microsoft365: value } }),
        ),
      ),
      JSON.stringify(value),
    ).toEqual({ status: "invalid", values: null, effective: null, issues });
});

// Decision F32's addendum of 2026-10-16: the Organization's own tabs in
// Apps' Workspace are one setting, `workspace.tabs`.
test("the Workspace tabs are one setting: ordered names, each module in one tab at most", () => {
  const tabs = [
    { name: "Každodenní práce", modules: ["deals", "knowledgebase"] },
    { name: "Finance", modules: ["invoices"] },
    { name: "Sklad", modules: [] },
  ];
  const verdict = organizationSettings(
    parseCanonicalOrganization(manifest({ workspace: { tabs } })),
  );
  expect(verdict.status).toBe("valid");
  expect(verdict.effective?.at(-1)).toEqual({
    key: "workspace.tabs",
    governed: true,
    value: tabs,
  });
  const cases: [unknown, OrganizationSettingsIssue[]][] = [
    [
      { workspace: {} },
      [issue("settings_field_missing", "/settings/workspace/tabs")],
    ],
    [
      { workspace: { tabs: [] } },
      [issue("settings_value_invalid", "/settings/workspace/tabs")],
    ],
    [
      {
        workspace: {
          tabs: Array.from({ length: 13 }, (_, i) => ({
            name: `T${i}`,
            modules: [],
          })),
        },
      },
      [issue("settings_value_invalid", "/settings/workspace/tabs")],
    ],
    [
      { workspace: { tabs: [{ name: " Finance", modules: [] }] } },
      [issue("settings_value_invalid", "/settings/workspace/tabs/0/name")],
    ],
    [
      { workspace: { tabs: [{ name: "x".repeat(41), modules: [] }] } },
      [issue("settings_value_invalid", "/settings/workspace/tabs/0/name")],
    ],
    [
      { workspace: { tabs: [{ name: "Fi\nnance", modules: [] }] } },
      [issue("settings_value_invalid", "/settings/workspace/tabs/0/name")],
    ],
    [
      { workspace: { tabs: [{ name: "Finance", modules: ["../deals"] }] } },
      [issue("settings_value_invalid", "/settings/workspace/tabs/0/modules/0")],
    ],
    [
      { workspace: { tabs: [{ name: "Finance" }] } },
      [issue("settings_field_missing", "/settings/workspace/tabs/0/modules")],
    ],
    [
      { workspace: { tabs: [{ name: "Finance", modules: [], icon: "x" }] } },
      [issue("settings_field_unknown", "/settings/workspace/tabs/0/icon")],
    ],
    [
      {
        workspace: {
          tabs: [
            { name: "Finance", modules: ["deals"] },
            { name: "FINANCE", modules: [] },
          ],
        },
      },
      [issue("settings_value_invalid", "/settings/workspace/tabs/1/name")],
    ],
    [
      {
        workspace: {
          tabs: [
            { name: "Finance", modules: ["deals"] },
            { name: "Sklad", modules: ["deals"] },
          ],
        },
      },
      [issue("settings_value_invalid", "/settings/workspace/tabs/1/modules/0")],
    ],
  ];
  for (const [settings, issues] of cases)
    expect(
      organizationSettings(parseCanonicalOrganization(manifest(settings))),
    ).toEqual({ status: "invalid", values: null, effective: null, issues });
});

// "Žádosti o přístup" (root decision 0204, addendum of 2026-10-17 afternoon,
// point b; DEV-6668 M8): the Dashboard's own setting. The reader accepts it,
// so an Organization that writes it keeps every other setting, and ignores
// it: no key, never applied, never reported (Lazurio#574, Platform#496).
test("access requests are accepted and ignored: the other settings beside them still apply", () => {
  const tabs = [{ name: "Finance", modules: ["invoices"] }];
  for (const enabled of [true, false]) {
    expect(
      organizationSettings(
        parseCanonicalOrganization(manifest({ access_requests: { enabled } })),
      ),
    ).toEqual({
      status: "valid",
      values: {},
      effective: ungoverned,
      issues: [],
    });
  }
  const applied = {
    integrations: { composio: { allowed: true }, microsoft365 },
    workspace: { tabs },
  };
  const verdict = organizationSettings(
    parseCanonicalOrganization(
      manifest({ ...applied, access_requests: { enabled: true } }),
    ),
  );
  expect(verdict).toEqual({
    status: "valid",
    values: applied,
    effective: [
      { key: "integrations.composio.allowed", governed: true, value: true },
      {
        key: "integrations.microsoft365.tenant_id",
        governed: true,
        value: tenantId,
      },
      {
        key: "integrations.microsoft365.client_id",
        governed: true,
        value: clientId,
      },
      {
        key: "integrations.microsoft365.apps",
        governed: true,
        value: microsoft365.apps,
      },
      {
        key: "integrations.microsoft365.callbacks",
        governed: true,
        value: [callback],
      },
      { key: "workspace.tabs", governed: true, value: tabs },
    ],
    issues: [],
  });
  expect(
    (organizationSettingsKeys as readonly string[]).some((key) =>
      key.startsWith("access_requests"),
    ),
  ).toBe(false);
});

test("access requests are a closed object with a required boolean, as in Core", () => {
  const at = "/settings/access_requests";
  const cases: [unknown, OrganizationSettingsIssue[]][] = [
    [
      { access_requests: {} },
      [issue("settings_field_missing", `${at}/enabled`)],
    ],
    [
      { access_requests: { enabled: "yes" } },
      [issue("settings_type_invalid", `${at}/enabled`)],
    ],
    [
      { access_requests: { enabled: 1 } },
      [issue("settings_type_invalid", `${at}/enabled`)],
    ],
    [
      { access_requests: { enabled: null } },
      [issue("settings_type_invalid", `${at}/enabled`)],
    ],
    [
      { access_requests: { enabled: true, team: "guests" } },
      [issue("settings_field_unknown", `${at}/team`)],
    ],
    [{ access_requests: true }, [issue("settings_type_invalid", at)]],
    // A broken one withholds the whole section, Composio included.
    [
      {
        integrations: { composio: { allowed: true } },
        access_requests: { enabled: "yes" },
      },
      [issue("settings_type_invalid", `${at}/enabled`)],
    ],
  ];
  for (const [settings, issues] of cases)
    expect(
      organizationSettings(parseCanonicalOrganization(manifest(settings))),
    ).toEqual({ status: "invalid", values: null, effective: null, issues });
});
