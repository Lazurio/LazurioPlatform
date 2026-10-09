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
];
const issue = (
  code: OrganizationSettingsIssue["code"],
  path: string,
): OrganizationSettingsIssue => ({ code, path });

test("the settings vocabulary is the upstream one", () => {
  expect(organizationSettingsKeys).toEqual(["integrations.composio.allowed"]);
  expect(organizationSettingsIssueCodes).toEqual([
    "settings_field_missing",
    "settings_field_unknown",
    "settings_type_invalid",
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
