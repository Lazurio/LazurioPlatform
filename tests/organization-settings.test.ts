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
import {
  acceptedSettings,
  accessRequestsRefusals,
  callback,
  chatgptAppsRefusals,
  clientId,
  malformedSettings,
  unverifiedManifest as manifest,
  microsoft365,
  microsoft365Refusals,
  fixtureInventory as modules,
  tenantId,
  workspaceTabs,
  workspaceTabsRefusals,
} from "./fixtures/organization-manifests";

// The upstream contract C1 (Lazurio Core `organization-settings-lib.mjs`,
// decision 0194): the same fixtures and the same issue codes and pointers as
// Core's own tests, so both readers judge one section identically.

const ungoverned: OrganizationSettingsEntry[] = [
  { key: "integrations.composio.allowed", governed: false, value: null },
  { key: "integrations.chatgpt_apps.allowed", governed: false, value: null },
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
    "integrations.chatgpt_apps.allowed",
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
  for (const [name, settings, issues] of malformedSettings) {
    // A malformed optional section must not take the Organization (and with it
    // the Launchpad catalog and content synchronization) down.
    const parsed = parseCanonicalOrganization(manifest(settings));
    expect(parsed.settings).toEqual(settings);
    expect(organizationSettings(parsed), name).toEqual({
      status: "invalid",
      values: null,
      effective: null,
      issues,
    });
  }
});

test("every accepted example is a valid section, applied as written but the Dashboard's own", () => {
  for (const [name, settings] of acceptedSettings) {
    const verdict = organizationSettings(
      parseCanonicalOrganization(manifest(settings)),
    );
    expect(verdict.status, name).toBe("valid");
    const { access_requests: _dashboardOnly, ...applied } = settings as Record<
      string,
      unknown
    >;
    expect(verdict.values, name).toEqual(applied);
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
        key: "integrations.chatgpt_apps.allowed",
        governed: false,
        value: null,
      },
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
  for (const [name, settings, issues] of microsoft365Refusals)
    expect(
      organizationSettings(parseCanonicalOrganization(manifest(settings))),
      name,
    ).toEqual({ status: "invalid", values: null, effective: null, issues });
});

// Decision F32's addendum of 2026-10-16: the Organization's own tabs in
// Apps' Workspace are one setting, `workspace.tabs`.
test("the Workspace tabs are one setting: ordered names, each module in one tab at most", () => {
  const verdict = organizationSettings(
    parseCanonicalOrganization(
      manifest({ workspace: { tabs: workspaceTabs } }),
    ),
  );
  expect(verdict.status).toBe("valid");
  expect(verdict.effective?.at(-1)).toEqual({
    key: "workspace.tabs",
    governed: true,
    value: workspaceTabs,
  });
  for (const [name, settings, issues] of workspaceTabsRefusals)
    expect(
      organizationSettings(parseCanonicalOrganization(manifest(settings))),
      name,
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
        key: "integrations.chatgpt_apps.allowed",
        governed: false,
        value: null,
      },
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
  for (const [name, settings, issues] of accessRequestsRefusals)
    expect(
      organizationSettings(parseCanonicalOrganization(manifest(settings))),
      name,
    ).toEqual({ status: "invalid", values: null, effective: null, issues });
});

test("ChatGPT apps are one boolean leaf beside Composio, and absent is not governed", () => {
  for (const allowed of [false, true]) {
    const settings = { integrations: { chatgpt_apps: { allowed } } };
    const verdict = organizationSettings(
      parseCanonicalOrganization(manifest(settings)),
    );
    expect(verdict.status).toBe("valid");
    expect(verdict.values).toEqual(settings);
    expect(
      verdict.effective?.find(
        (entry) => entry.key === "integrations.chatgpt_apps.allowed",
      ),
    ).toEqual({
      key: "integrations.chatgpt_apps.allowed",
      governed: true,
      value: allowed,
    });
  }
  // `allowed` is required once the group is there, and only a boolean.
  for (const [name, settings, issues] of chatgptAppsRefusals)
    expect(
      organizationSettings(parseCanonicalOrganization(manifest(settings))),
      name,
    ).toEqual({ status: "invalid", values: null, effective: null, issues });
});
