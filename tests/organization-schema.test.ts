import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { parseCanonicalOrganization } from "../src/organizations/canonical-manifest";
import schema from "../src/organizations/lazurio.organization.v1.schema.json";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import { organizationSettings } from "../src/organizations/organization-settings";
import type { readOrganizationDocuments } from "../src/organizations/read-documents";
import { resolveOrganizationRootDocuments } from "../src/organizations/root-resolution";
import { parseUniqueJson } from "../src/providers/unique-json";
import { canonicalDocument } from "./fixtures/catalog-folder";
import {
  acceptedSettings,
  accessRequestsRefusals,
  chatgptAppsRefusals,
  type Manifest,
  type ManifestCase,
  malformedSettings,
  manifestRefusals,
  manifestVariants,
  microsoft365Refusals,
  unverifiedManifest,
  verifiedManifest,
  workspaceTabsRefusals,
} from "./fixtures/organization-manifests";

// The schema of lazurio.organization.v1 (decision 0225, #799) and the readers
// it is written from judge the same synthetic manifests alike. A case is one
// JSON text and the inventory beside it, read as an Organization root is
// read: the JSON reader, `parseCanonicalOrganization`, `organizationSettings`
// and the root resolution. Its declared projection digest is pinned, so the
// readers judge only the case's own change.

const ajv = new Ajv2020({ strict: true });
const validate = ajv.compile(schema);
const validateSettings = ajv.compile({
  $ref: `${schema.$id}#/$defs/organizationSettings`,
});

type Documents = Extract<
  Awaited<ReturnType<typeof readOrganizationDocuments>>,
  { kind: "documents-observed" }
>;
type Case = Readonly<{
  name: string;
  /** The readers' verdict, as the shared fixtures label it. */
  accepted: boolean;
  text: string;
  inventory: unknown;
  /** `company.gen3.json`, while the root still has it. */
  legacy?: unknown;
}>;

const present = (value: unknown) =>
  Object.freeze({
    kind: "present" as const,
    value: value as Readonly<Record<string, unknown>>,
  });

function readersAccept({ text, inventory, legacy }: Case): boolean {
  let document: unknown;
  try {
    document = parseUniqueJson(text);
    const canonical = parseCanonicalOrganization(document);
    if (organizationSettings(canonical).status === "invalid") return false;
  } catch {
    return false;
  }
  const documents: Documents = Object.freeze({
    kind: "documents-observed" as const,
    canonical: present(document),
    legacy:
      legacy === undefined
        ? Object.freeze({ kind: "missing" as const })
        : present(legacy),
    modules: present(inventory),
  });
  const { state } = resolveOrganizationRootDocuments(documents);
  return state === "current" || state === "transition";
}

const named = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

// The inventory naming the case's Organization.
function inventoryOf(document: Manifest) {
  return {
    company: named(document.organization?.slug) ?? "fixture",
    github_org:
      named(document.organization?.forge_binding?.locator) ?? "Fixture",
    module_slots: [],
  };
}

// The manifest with the digest of its own projection, unless the canonical
// reader refuses it before any digest.
function pinned(document: Manifest, inventory: unknown): Manifest {
  try {
    const { hash } = expectedLegacyProjection(document, inventory);
    return {
      ...document,
      compatibility: {
        legacy_projection: {
          ...document.compatibility.legacy_projection,
          sha256: hash,
        },
      },
    };
  } catch {
    return document;
  }
}

function manifestCase(
  name: string,
  accepted: boolean,
  document: Manifest,
): Case {
  const inventory = inventoryOf(document);
  const text = JSON.stringify(pinned(document, inventory));
  return { name, accepted, text, inventory };
}
const changed = (document: Manifest, change: ManifestCase[1]) => {
  change(document);
  return document;
};

const settingsRefusals = [
  ...malformedSettings,
  ...microsoft365Refusals,
  ...workspaceTabsRefusals,
  ...accessRequestsRefusals,
  ...chatgptAppsRefusals,
];

// Refused cases of this test alone: what JSON Schema cannot see.
const emoji = "\u{1f600}";
const plain = manifestCase("plain", true, unverifiedManifest());
const projection = expectedLegacyProjection(
  JSON.parse(plain.text),
  plain.inventory,
).projection;
const readerOnlyCases: readonly Case[] = [
  manifestCase(
    "settings: tab name of 21 emoji",
    false,
    unverifiedManifest({
      workspace: { tabs: [{ name: emoji.repeat(21), modules: [] }] },
    }),
  ),
  {
    ...plain,
    name: "stale projection digest",
    accepted: false,
    text: JSON.stringify(unverifiedManifest()),
  },
  {
    ...plain,
    name: "inventory of another Organization",
    accepted: false,
    inventory: { company: "other", github_org: "Other", module_slots: [] },
  },
  {
    ...plain,
    name: "legacy projection that differs",
    accepted: false,
    legacy: {
      ...projection,
      company: { ...(projection.company as object), display_name: "Other" },
    },
  },
  {
    ...plain,
    name: "duplicate member name",
    accepted: false,
    text: plain.text.replace(
      '"kind":"organization"',
      '"kind":"template","kind":"organization"',
    ),
  },
  {
    ...plain,
    name: "number beyond a double",
    accepted: false,
    text: plain.text.replace('"metadata":{}', '"metadata":{"size":1e400}'),
  },
];

const cases: readonly Case[] = [
  manifestCase("verified, every section", true, verifiedManifest()),
  plain,
  {
    ...plain,
    name: "plain, beside its exact legacy projection",
    legacy: projection,
  },
  ...manifestVariants.map(([name, change]) =>
    manifestCase(name, true, changed(verifiedManifest(), change)),
  ),
  ...acceptedSettings.map(([name, settings]) =>
    manifestCase(`settings: ${name}`, true, unverifiedManifest(settings)),
  ),
  // The documents the Folder catalog fixtures write.
  manifestCase(
    "catalog Organization with Teams",
    true,
    canonicalDocument("alpha", "organization", [
      { slug: "makers", display_name: "Makers" },
    ]),
  ),
  manifestCase(
    "catalog template",
    true,
    canonicalDocument("gamma", "template", []),
  ),
  ...manifestRefusals.map(([name, change]) =>
    manifestCase(name, false, changed(verifiedManifest(), change)),
  ),
  ...settingsRefusals.map(([name, settings]) =>
    manifestCase(`settings: ${name}`, false, unverifiedManifest(settings)),
  ),
  ...readerOnlyCases,
];

// What only the readers check, by case: each passes the schema and the
// readers refuse it.
const readerOnly = new Map<string, string>([
  [
    "different owner",
    "The owner in root_repository.locator must be the Organization's login, ignoring letter case: two values compared.",
  ],
  [
    "port order",
    "module_port_pool.start must not exceed end: two values compared.",
  ],
  [
    "settings: tab names equal ignoring case",
    "Two tabs never share a name in NFC ignoring letter case: items compared.",
  ],
  [
    "settings: module in two tabs",
    "A module is in one tab at most: items compared.",
  ],
  [
    "settings: tab name of 21 emoji",
    "The reader counts a name's 40 characters in UTF-16 code units, JSON Schema in code points, so 21 to 40 characters outside the Basic Multilingual Plane pass only the schema.",
  ],
  [
    "stale projection digest",
    "The declared digest must be the digest of the projection of this manifest and its inventory: a projection fingerprint.",
  ],
  [
    "inventory of another Organization",
    "modules.manifest.json must exist, be well formed and name the same Organization: another document.",
  ],
  [
    "legacy projection that differs",
    "While company.gen3.json exists, it must be this manifest's projection: another document.",
  ],
  [
    "duplicate member name",
    "The JSON reader refuses a member name given twice, which the parsed value the schema validates no longer shows.",
  ],
  [
    "number beyond a double",
    "1e400 is JSON but parses to Infinity, which the reader refuses as not JSON data; JSON Schema has no such bound.",
  ],
]);

test("the schema compiles in Ajv's strict mode, its settings definition on its own too", () => {
  expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow();
  expect(validateSettings({})).toBe(true);
});

test("every manifest the readers accept passes the schema and every one they refuse fails it, except what only the readers check", () => {
  const names = new Set<string>();
  for (const entry of cases) {
    expect(names.has(entry.name), entry.name).toBe(false);
    names.add(entry.name);
    expect(readersAccept(entry), entry.name).toBe(entry.accepted);
    expect(validate(JSON.parse(entry.text)), entry.name).toBe(
      entry.accepted || readerOnly.has(entry.name),
    );
  }
  // Every rule only the readers check is shown by a refused case.
  for (const name of readerOnly.keys())
    expect(cases.find((entry) => entry.name === name)?.accepted, name).toBe(
      false,
    );
});

// The Platform still reads an Organization whose settings section is
// malformed and applies none of it; a consumer that does the same validates
// the section on its own against the schema's settings definition.
test("the settings definition judges a section on its own as organizationSettings does", () => {
  for (const [name, settings] of acceptedSettings)
    expect(validateSettings(settings), name).toBe(true);
  for (const [name, settings] of settingsRefusals)
    expect(validateSettings(settings), name).toBe(
      readerOnly.has(`settings: ${name}`),
    );
});
