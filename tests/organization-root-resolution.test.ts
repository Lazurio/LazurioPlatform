import { expect, test } from "bun:test";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import type { readOrganizationDocuments } from "../src/organizations/read-documents";
import {
  isExecutableOrganizationState,
  legacyManifestIssues,
  modulesManifestIssues,
  organizationRootStates,
  resolveOrganizationRootDocuments,
} from "../src/organizations/root-resolution";

type Documents = Extract<
  Awaited<ReturnType<typeof readOrganizationDocuments>>,
  { kind: "documents-observed" }
>;
type Document = Documents["canonical"];

const modules = {
  company: "fixture",
  github_org: "Fixture",
  module_slots: [{ path: "workspace/app", slug: "app" }],
};
const unpinned = {
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
const canonical = {
  ...unpinned,
  compatibility: {
    legacy_projection: {
      ...unpinned.compatibility.legacy_projection,
      sha256: expectedLegacyProjection(unpinned, modules).hash,
    },
  },
};
const projection = expectedLegacyProjection(canonical, modules)
  .projection as Record<string, unknown>;

const present = (value: unknown): Document =>
  Object.freeze({
    kind: "present" as const,
    value: value as Readonly<Record<string, unknown>>,
  });
const missing: Document = Object.freeze({ kind: "missing" as const });
const invalid: Document = Object.freeze({ kind: "invalid" as const });
function documents(input: {
  canonical?: Document;
  legacy?: Document;
  modules?: Document;
}): Documents {
  return Object.freeze({
    kind: "documents-observed" as const,
    canonical: input.canonical ?? missing,
    legacy: input.legacy ?? missing,
    modules: input.modules ?? present(modules),
  });
}
const resolve = (input: Parameters<typeof documents>[0]) =>
  resolveOrganizationRootDocuments(documents(input));

test("only parity-valid transition is executable; current stays diagnostic", () => {
  expect(organizationRootStates.filter(isExecutableOrganizationState)).toEqual([
    "transition",
  ]);
  expect(
    resolve({ canonical: present(canonical), legacy: present(projection) }),
  ).toEqual({ state: "transition", executable: true, issues: [] });
  expect(resolve({ canonical: present(canonical) })).toEqual({
    state: "current",
    executable: false,
    issues: [],
  });
  expect(resolve({ legacy: present(projection) })).toEqual({
    state: "legacy",
    executable: false,
    issues: [],
  });
  expect(resolve({})).toEqual({
    state: "missing",
    executable: false,
    issues: [],
  });
});

test("legacy-only roots are normalized before the legacy state is assigned", () => {
  // Parseable but structurally empty documents are a conflict with the
  // upstream issue codes, never a silently accepted `legacy` root.
  expect(resolve({ legacy: present({}), modules: present({}) })).toEqual({
    state: "conflict",
    executable: false,
    issues: [
      "legacy_manifest_schema_unsupported",
      "legacy_organization_identity_invalid",
      "modules_manifest_company_missing",
      "modules_manifest_forge_locator_missing",
      "modules_manifest_slots_invalid",
    ],
  });
  expect(
    resolve({
      legacy: present({ ...projection, organization_kind: "other" }),
    }),
  ).toMatchObject({ state: "conflict", issues: ["organization_kind_invalid"] });
  for (const slot of [{}, { path: "../outside" }])
    expect(
      resolve({
        legacy: present(projection),
        modules: present({ ...modules, module_slots: [slot] }),
      }),
    ).toMatchObject({
      state: "conflict",
      issues: ["modules_manifest_slot_0_path_invalid"],
    });
  expect(
    resolve({
      legacy: present({ ...projection, module_port_pool: "not-a-port-pool" }),
    }),
  ).toMatchObject({
    state: "conflict",
    issues: ["legacy_module_port_pool_invalid"],
  });
  // Unreadable documents stay the reader-level conflict.
  expect(resolve({ legacy: invalid })).toMatchObject({
    state: "conflict",
    issues: ["legacy_document_unreadable"],
  });
});

test("normalization mirrors upstream defaults and codes without widening", () => {
  expect(modulesManifestIssues(modules)).toEqual([]);
  expect(modulesManifestIssues(null)).toEqual(["modules_manifest_missing"]);
  expect(
    modulesManifestIssues({ ...modules, schema_version: "other" }),
  ).toEqual(["modules_manifest_schema_unsupported"]);
  const { organization_kind: _kind, ...withoutKind } = projection;
  expect(legacyManifestIssues(withoutKind)).toEqual([]);
  expect(legacyManifestIssues([])).toEqual(["legacy_manifest_invalid"]);
  for (const pool of [
    null,
    "not-a-port-pool",
    [],
    { start: 4000 },
    { start: 1, end: 4000 },
    { start: 5000, end: 4000 },
    { start: 4000, end: 70_000 },
    { start: 4000, end: 5000, extra: true },
  ])
    expect(
      legacyManifestIssues({ ...projection, module_port_pool: pool }),
    ).toEqual(["legacy_module_port_pool_invalid"]);
  expect(
    legacyManifestIssues({
      ...projection,
      module_port_pool: { start: 4000, end: 5000 },
    }),
  ).toEqual([]);
  // Slot paths must be canonical and in a known scope, as upstream requires.
  for (const path of [
    "../outside",
    "workspace/app/",
    "elsewhere/app",
    "./workspace/app",
  ])
    expect(
      modulesManifestIssues({ ...modules, module_slots: [{ path }] }),
    ).toEqual(["modules_manifest_slot_0_path_invalid"]);
  expect(
    legacyManifestIssues({ ...projection, company: { slug: " " } }),
  ).toEqual(["legacy_organization_identity_invalid"]);
});

test("absent organization_kind next to a canonical manifest is repairable drift", () => {
  const { organization_kind: _kind, ...withoutKind } = projection;
  expect(
    resolve({ canonical: present(canonical), legacy: present(withoutKind) }),
  ).toEqual({
    state: "projection_drift",
    executable: false,
    issues: ["legacy_projection_drift"],
  });
  expect(
    resolve({
      canonical: present(canonical),
      legacy: present({
        ...projection,
        company: { ...(projection.company as object), display_name: "Other" },
      }),
    }),
  ).toMatchObject({
    state: "conflict",
    issues: ["normalized_semantics_conflict"],
  });
});
