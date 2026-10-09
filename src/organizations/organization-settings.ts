// Organization settings: the optional, closed `settings` section of
// `lazurio.organization.json` (upstream decision 0194, contract C1 of DEV-6653).
// This consumes the Lazurio Core contract (`lazurio/core/organization-settings-lib.mjs`
// and `$defs.organizationSettings` of `lazurio.organization.v1.schema.json`); it
// is not a Platform schema. Same closed tree, same issue codes, same JSON
// Pointers, same "nothing applies from an invalid section" rule.
//
// An absent value is not governed by the Organization: each Environment decides.
// A present value governs every work Environment of the Organization; personal
// Environments ignore Organization settings. `parseCanonicalOrganization`
// accepts the section without judging it, so a malformed optional section never
// turns the Organization into a conflict; this module is its only reader.

type Data = Readonly<Record<string, unknown>>;
type ContractNode =
  | Readonly<{ kind: "boolean" }>
  | Readonly<{
      kind: "object";
      fields: ReadonlyMap<string, ContractNode>;
      required: readonly string[];
    }>;

function objectNode(
  fields: Record<string, ContractNode>,
  required: string[] = [],
): ContractNode {
  return Object.freeze({
    kind: "object" as const,
    fields: new Map(Object.entries(fields)),
    required: Object.freeze([...required]),
  });
}
const booleanLeaf: ContractNode = Object.freeze({ kind: "boolean" as const });

// Adding a setting adds one leaf here, upstream first (decision 0194 point 6).
const contract = objectNode({
  integrations: objectNode({
    composio: objectNode({ allowed: booleanLeaf }, ["allowed"]),
  }),
});

/** Dot-separated keys of every known setting, as reported per item. */
export const organizationSettingsKeys = Object.freeze([
  "integrations.composio.allowed",
] as const);
export type OrganizationSettingsKey = (typeof organizationSettingsKeys)[number];

export const organizationSettingsIssueCodes = Object.freeze([
  "settings_field_missing",
  "settings_field_unknown",
  "settings_type_invalid",
] as const);
export type OrganizationSettingsIssue = Readonly<{
  code: (typeof organizationSettingsIssueCodes)[number];
  /** JSON Pointer into `lazurio.organization.json`. */
  path: string;
}>;

export type OrganizationSettingsValues = Readonly<{
  integrations?: Readonly<{ composio?: Readonly<{ allowed: boolean }> }>;
}>;
export type OrganizationSettingsEntry = Readonly<{
  key: OrganizationSettingsKey;
  /** `false`: the Organization does not govern it and the Environment decides. */
  governed: boolean;
  value: boolean | null;
}>;

export type OrganizationSettings =
  | Readonly<{
      status: "absent" | "valid";
      /** Exactly the declared keys; `{}` when absent. */
      values: OrganizationSettingsValues;
      effective: readonly OrganizationSettingsEntry[];
      issues: readonly [];
    }>
  | Readonly<{
      /** Apply nothing from this version; keep the last applied one. */
      status: "invalid";
      values: null;
      effective: null;
      issues: readonly OrganizationSettingsIssue[];
    }>;

/** The settings verdict of one parsed canonical Organization manifest. */
export function organizationSettings(manifest: Data): OrganizationSettings {
  if (!Object.hasOwn(manifest, "settings"))
    return deepFreeze({
      status: "absent" as const,
      values: {},
      effective: effective({}),
      issues: [] as const,
    });
  const issues: OrganizationSettingsIssue[] = [];
  validate(manifest.settings, contract, "/settings", issues);
  if (issues.length > 0)
    return deepFreeze({
      status: "invalid" as const,
      values: null,
      effective: null,
      issues: issues.sort(compareIssues),
    });
  const values = structuredClone(
    manifest.settings,
  ) as OrganizationSettingsValues;
  return deepFreeze({
    status: "valid" as const,
    values,
    effective: effective(values),
    issues: [] as const,
  });
}

function effective(values: unknown): OrganizationSettingsEntry[] {
  return organizationSettingsKeys.map((key) => {
    let node = values;
    for (const segment of key.split(".")) {
      if (!isRecord(node) || !Object.hasOwn(node, segment))
        return { key, governed: false, value: null };
      node = node[segment];
    }
    return { key, governed: true, value: node as boolean };
  });
}

function validate(
  value: unknown,
  node: ContractNode,
  path: string,
  issues: OrganizationSettingsIssue[],
): void {
  if (node.kind === "boolean") {
    if (typeof value !== "boolean")
      issues.push({ code: "settings_type_invalid", path });
    return;
  }
  if (!isRecord(value)) {
    issues.push({ code: "settings_type_invalid", path });
    return;
  }
  for (const key of Object.keys(value))
    if (!node.fields.has(key))
      issues.push({ code: "settings_field_unknown", path: pointer(path, key) });
  for (const key of node.required)
    if (!Object.hasOwn(value, key))
      issues.push({ code: "settings_field_missing", path: pointer(path, key) });
  for (const [key, child] of node.fields)
    if (Object.hasOwn(value, key))
      validate(value[key], child, pointer(path, key), issues);
}

// RFC 6901 JSON Pointer segment.
function pointer(path: string, key: string): string {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function compareIssues(
  left: OrganizationSettingsIssue,
  right: OrganizationSettingsIssue,
): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

function isRecord(value: unknown): value is Data {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
