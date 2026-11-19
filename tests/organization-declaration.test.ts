import { expect, test } from "bun:test";
import { declareOrganizationSlots } from "../src/modules/organization-declaration";
import type { ModuleSlot } from "../src/modules/scaffold";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import { resolveOrganizationRootDocuments } from "../src/organizations/root-resolution";
import { canonicalDocument } from "./fixtures/catalog-folder";

// `lazurio module create` in an Organization root under LZD-0041 phase A:
// the projection and its digest are still written for older readers (the
// Root's Core, Lazurio up to 0.1.23) until phase C1, but a stale or absent
// digest no longer stops the declaration.

const inventory = {
  company: "alpha",
  github_org: "alpha",
  module_slots: [],
};

const slot: ModuleSlot = {
  path: "workspace/notes",
  slug: "notes",
  space: "workspace",
  category: "tools",
  default_access: "expected",
  required_roles: [],
  source_of_truth: "git-native",
  status: "active",
  notes: "",
  git: { url: "git@github.com:alpha/notes.git", branch: "main" },
};

const present = (value: unknown) =>
  Object.freeze({
    kind: "present" as const,
    value: value as Readonly<Record<string, unknown>>,
  });

function resolved(texts: {
  canonical: string;
  modules: string;
  legacy: string | null;
}) {
  return resolveOrganizationRootDocuments({
    kind: "documents-observed",
    canonical: present(JSON.parse(texts.canonical)),
    modules: present(JSON.parse(texts.modules)),
    legacy:
      texts.legacy === null
        ? Object.freeze({ kind: "missing" as const })
        : present(JSON.parse(texts.legacy)),
  } as never);
}

function pinned() {
  const document = canonicalDocument("alpha", "organization", []);
  document.compatibility.legacy_projection.sha256 = expectedLegacyProjection(
    document,
    inventory,
  ).hash;
  return document;
}

test("a declaration in a transition root keeps writing the projection and its digest (LZD-0041 phase A)", () => {
  const document = pinned();
  const legacy = `${JSON.stringify(expectedLegacyProjection(document, inventory).projection, null, 2)}\n`;
  const after = declareOrganizationSlots(
    {
      canonical: JSON.stringify(document, null, 2),
      modules: JSON.stringify(inventory, null, 2),
      legacy,
    },
    [slot],
  );
  expect(after.legacy).not.toBe(legacy);
  expect(resolved(after)).toEqual({
    state: "transition",
    executable: true,
    issues: [],
  });
});

test("a declaration in a root whose digest is stale rewrites the digest instead of refusing (LZD-0041 phase A)", () => {
  const document = canonicalDocument("alpha", "organization", []);
  const texts = {
    canonical: JSON.stringify(document, null, 2),
    modules: JSON.stringify(inventory, null, 2),
    legacy: null,
  };
  expect(resolved(texts)).toEqual({
    state: "current",
    executable: true,
    issues: ["canonical_projection_hash_invalid"],
  });
  const after = declareOrganizationSlots(texts, [slot]);
  expect(resolved(after)).toEqual({
    state: "current",
    executable: true,
    issues: [],
  });
  expect(
    JSON.parse(after.canonical).compatibility.legacy_projection.sha256,
  ).toBe(
    expectedLegacyProjection(
      JSON.parse(after.canonical),
      JSON.parse(after.modules),
    ).hash,
  );
});

test("a declaration in a root without the compatibility block leaves it without one (LZD-0041 phase A)", () => {
  const { compatibility: _compatibility, ...document } = pinned();
  const canonical = JSON.stringify(document, null, 2);
  const texts = {
    canonical,
    modules: JSON.stringify(inventory, null, 2),
    legacy: null,
  };
  expect(resolved(texts)).toEqual({
    state: "current",
    executable: true,
    issues: [],
  });
  const after = declareOrganizationSlots(texts, [slot]);
  expect(after.canonical).toBe(canonical);
  expect(after.legacy).toBeNull();
  expect(JSON.parse(after.modules).module_slots).toHaveLength(1);
  expect(resolved(after)).toEqual({
    state: "current",
    executable: true,
    issues: [],
  });
});
