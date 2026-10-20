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
  | Readonly<{ kind: "string"; pattern: RegExp }>
  | Readonly<{ kind: "enum"; values: readonly string[] }>
  /** One setting: its items are validated, never reported as keys; they are
   * unique strings. */
  | Readonly<{
      kind: "array";
      items: ContractNode;
      minItems: number;
      maxItems: number;
    }>
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
const stringLeaf = (pattern: RegExp): ContractNode =>
  Object.freeze({ kind: "string" as const, pattern });
const enumItem = (values: readonly string[]): ContractNode =>
  Object.freeze({ kind: "enum" as const, values });
const arrayLeaf = (
  items: ContractNode,
  { minItems = 0, maxItems = Number.POSITIVE_INFINITY } = {},
): ContractNode =>
  Object.freeze({ kind: "array" as const, items, minItems, maxItems });

/** The catalog apps an Organization may turn on through its Microsoft 365
 * company app (root decision 0162, addendum of 2026-10-14). Teams joins in
 * phase 2. */
export const microsoft365AppIds = Object.freeze([
  "outlook",
  "one_drive",
  "share_point",
] as const);

/** A Microsoft identifier (tenant, application): a lowercase GUID, the form
 * the Azure CLI prints, never a secret. */
export const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A work Environment's hosted Launchpad callback exactly as registered at
 * Microsoft: https on `launchpad.<machine>.<github-org-login>.lazurio.io` (the
 * Organization URL contract), no port, query or fragment. Any other host
 * would receive the authorization response, so it is refused. */
export const launchpadCallbackPattern =
  /^https:\/\/launchpad\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\.lazurio\.io\/api\/integrations\/oauth\/callback$/;
/** Entra registers at most 256 redirect addresses for one app; Executor's
 * localhost callback always takes one of them. */
export const microsoft365CallbacksMax = 255;

/** A Workspace tab's name as an Organization's Admin writes it: 1 to 40
 * characters, no control character, no space at either end; the same
 * pattern as Lazurio Core's and the manifest schema's (root decision 0206). */
export const workspaceTabNamePattern =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it refuses.
  /^(?=[^\u0000-\u001f\u007f]{1,40}$)[^\s\u0000-\u001f\u007f](?:.*[^\s\u0000-\u001f\u007f])?$/;
/** A module of a tab, by its `lazurio.module.v1` id. */
export const workspaceModulePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** At most this many tabs: a row a person reads at a glance. */
export const workspaceTabsMax = 12;

// Adding a setting adds one leaf here, upstream first (decision 0194 point 6):
// the same closed tree as Lazurio Core's `organization-settings-lib.mjs`.
// `microsoft365` (root decision 0162, addendum of 2026-10-14; F42 addendum
// (c) of 2026-10-14) carries only identifiers that are not secrets: the
// Organization's single-tenant Entra app is a public client, so the closed
// tree refuses any other key (a `client_secret` among them).
// `access_requests` ("Žádosti o přístup", root decision 0204, addendum of
// 2026-10-17 afternoon, point b) is the Dashboard's own setting: it is
// checked so an Organization that writes it keeps every other setting, then
// dropped (`dashboardOnly`). It has no key, is never applied or reported, and
// the Dashboard never delivers it; only a root read from Git holds it.
const contract = objectNode({
  // The Organization's own tabs inside Apps' Workspace (decision F32's
  // addendum of 2026-10-16): in order, each a name and the modules in it; a
  // module the Organization put in no tab is in the first one.
  workspace: objectNode(
    {
      tabs: arrayLeaf(
        objectNode(
          {
            name: stringLeaf(workspaceTabNamePattern),
            modules: arrayLeaf(stringLeaf(workspaceModulePattern), {
              maxItems: 500,
            }),
          },
          ["name", "modules"],
        ),
        { minItems: 1, maxItems: workspaceTabsMax },
      ),
    },
    ["tabs"],
  ),
  integrations: objectNode({
    composio: objectNode({ allowed: booleanLeaf }, ["allowed"]),
    microsoft365: objectNode(
      {
        tenant_id: stringLeaf(guidPattern),
        client_id: stringLeaf(guidPattern),
        apps: arrayLeaf(enumItem(microsoft365AppIds), { minItems: 1 }),
        callbacks: arrayLeaf(stringLeaf(launchpadCallbackPattern), {
          maxItems: microsoft365CallbacksMax,
        }),
      },
      ["tenant_id", "client_id", "apps", "callbacks"],
    ),
  }),
  access_requests: objectNode({ enabled: booleanLeaf }, ["enabled"]),
});
/** Top-level settings of the Dashboard alone: checked, never kept. */
const dashboardOnly = Object.freeze(["access_requests"]);

/** Dot-separated keys of every known setting, as reported per item: every
 * leaf, an array being one. */
export const organizationSettingsKeys = Object.freeze([
  "integrations.composio.allowed",
  "integrations.microsoft365.tenant_id",
  "integrations.microsoft365.client_id",
  "integrations.microsoft365.apps",
  "integrations.microsoft365.callbacks",
  "workspace.tabs",
] as const);
export type OrganizationSettingsKey = (typeof organizationSettingsKeys)[number];

/** The keys of the Microsoft 365 company app, applied together. */
export const microsoft365SettingKeys = organizationSettingsKeys.filter((key) =>
  key.startsWith("integrations.microsoft365."),
);

/** The Organization's Microsoft 365 company app (`settings.integrations.
 * microsoft365`): its tenant, the app registered there, the catalog apps it
 * turns on and the Launchpad callbacks registered at Microsoft. */
export type Microsoft365Setting = Readonly<{
  tenant_id: string;
  client_id: string;
  apps: readonly string[];
  callbacks: readonly string[];
}>;

/** A key name that looks like it carries a secret. The Microsoft 365 company
 * app is a public client: its setting never holds a secret (root decision
 * 0194 point 1: secrets live only in a vault), so a delivered answer whose
 * `integrations.microsoft365` names one (a `client_secret`) is refused
 * whole, never kept as `unsupported`. Elsewhere a key such as `secret_ref`
 * names a vault item and stays an unsupported key like any other. */
export const secretLikeKey =
  /secret|password|passwd|token|credential|certificate|private|api_?key/i;
const secretFree = "integrations.microsoft365";

/** Whether an unknown member under the company app names a secret. */
function namesSecret(key: string, value: unknown, depth: number): boolean {
  if (secretLikeKey.test(key)) return true;
  return (
    isRecord(value) &&
    depth <= depthMax &&
    Object.keys(value).some((inner) =>
      namesSecret(inner, value[inner], depth + 1),
    )
  );
}

export const organizationSettingsIssueCodes = Object.freeze([
  "settings_field_missing",
  "settings_field_unknown",
  "settings_type_invalid",
  "settings_value_invalid",
] as const);
export type OrganizationSettingsIssue = Readonly<{
  code: (typeof organizationSettingsIssueCodes)[number];
  /** JSON Pointer into `lazurio.organization.json`. */
  path: string;
}>;

/** One tab of an Organization's Workspace: its name and, by id, the modules
 * the Organization put in it. */
export type WorkspaceTab = Readonly<{
  name: string;
  modules: readonly string[];
}>;

export type OrganizationSettingsValues = Readonly<{
  workspace?: Readonly<{ tabs: readonly WorkspaceTab[] }>;
  integrations?: Readonly<{
    composio?: Readonly<{ allowed: boolean }>;
    microsoft365?: Microsoft365Setting;
  }>;
}>;
export type OrganizationSettingValue =
  | boolean
  | string
  | readonly string[]
  | readonly WorkspaceTab[];
export type OrganizationSettingsEntry = Readonly<{
  key: OrganizationSettingsKey;
  /** `false`: the Organization does not govern it and the Environment decides. */
  governed: boolean;
  value: OrganizationSettingValue | null;
}>;

export type OrganizationSettings =
  | Readonly<{
      status: "absent" | "valid";
      /** Exactly the declared keys this Environment applies (the Dashboard's
       * own are dropped); `{}` when absent. */
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
  if (issues.length === 0) workspaceIssues(manifest.settings, issues);
  if (issues.length > 0)
    return deepFreeze({
      status: "invalid" as const,
      values: null,
      effective: null,
      issues: issues.sort(compareIssues),
    });
  const values = Object.fromEntries(
    Object.entries(structuredClone(manifest.settings) as Data).filter(
      ([key]) => !dashboardOnly.includes(key),
    ),
  ) as OrganizationSettingsValues;
  return deepFreeze({
    status: "valid" as const,
    values,
    effective: effective(values),
    issues: [] as const,
  });
}

/** The keys of the settings a section governs, as reported per item: its
 * leaves, a group applied as one by its own key. None for a section this
 * release cannot read. */
export function governedSettingKeys(
  values: OrganizationSettingsValues,
): readonly OrganizationSettingsKey[] {
  const verdict = organizationSettings({ settings: values });
  return verdict.status === "invalid"
    ? []
    : verdict.effective.filter((entry) => entry.governed).map((e) => e.key);
}

/** At most this many keys of settings this release does not know are kept. */
export const unsupportedSettingsMax = 64;
const depthMax = 16;

/**
 * The settings the Dashboard delivered to this Environment (contract C2 of
 * DEV-6653, root decision 0194 point 3), read by this release's contract. The
 * Dashboard checked them against its own, possibly newer, contract, so a key
 * this release does not know is a setting it cannot apply: its dotted path
 * (the key of a C2 report item) is kept apart, sorted, to be reported
 * `unsupported`, and its value is never kept. Every known key is checked
 * exactly as `organizationSettings` checks it, and a known key that breaks the
 * contract makes the whole answer unusable (null): nothing of it applies.
 */
export function deliveredSettings(input: unknown): Readonly<{
  values: OrganizationSettingsValues;
  unsupported: readonly string[];
}> | null {
  if (!isRecord(input) || contract.kind !== "object") return null;
  const unsupported: string[] = [];
  const known = knownPart(input, contract, "", unsupported, 0);
  if (known === null) return null;
  const verdict = organizationSettings({ settings: known });
  if (verdict.status !== "valid") return null;
  return deepFreeze({
    values: verdict.values,
    unsupported: [...new Set(unsupported)]
      .sort()
      .slice(0, unsupportedSettingsMax),
  });
}

function knownPart(
  value: Data,
  node: Extract<ContractNode, { kind: "object" }>,
  path: string,
  unsupported: string[],
  depth: number,
): Record<string, unknown> | null {
  if (depth > depthMax) return null;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const child = node.fields.get(key);
    const at = path === "" ? key : `${path}.${key}`;
    const member = value[key];
    // A secret has no place in the company app's setting: the answer is
    // refused whole.
    if (
      child === undefined &&
      path === secretFree &&
      namesSecret(key, member, depth + 1)
    )
      return null;
    if (child === undefined) leafPaths(member, at, unsupported, depth + 1);
    else if (child.kind === "object" && isRecord(member)) {
      const inner = knownPart(member, child, at, unsupported, depth + 1);
      if (inner === null) return null;
      result[key] = inner;
    }
    // A known leaf, or a known group that is not an object: the strict
    // reader judges it.
    else result[key] = member;
  }
  return result;
}

function leafPaths(
  value: unknown,
  path: string,
  out: string[],
  depth: number,
): void {
  if (isRecord(value) && depth <= depthMax) {
    for (const key of Object.keys(value))
      leafPaths(value[key], `${path}.${key}`, out, depth + 1);
    return;
  }
  out.push(path);
}

function effective(values: unknown): OrganizationSettingsEntry[] {
  return organizationSettingsKeys.map((key) => {
    let node = values;
    for (const segment of key.split(".")) {
      if (!isRecord(node) || !Object.hasOwn(node, segment))
        return { key, governed: false, value: null };
      node = node[segment];
    }
    return { key, governed: true, value: node as OrganizationSettingValue };
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
  if (node.kind === "string") {
    if (typeof value !== "string")
      issues.push({ code: "settings_type_invalid", path });
    else if (!node.pattern.test(value))
      issues.push({ code: "settings_value_invalid", path });
    return;
  }
  if (node.kind === "enum") {
    if (typeof value !== "string")
      issues.push({ code: "settings_type_invalid", path });
    else if (!node.values.includes(value))
      issues.push({ code: "settings_value_invalid", path });
    return;
  }
  if (node.kind === "array") {
    if (!Array.isArray(value)) {
      issues.push({ code: "settings_type_invalid", path });
      return;
    }
    if (value.length < node.minItems || value.length > node.maxItems)
      issues.push({ code: "settings_value_invalid", path });
    const seen = new Set<unknown>();
    value.forEach((item, index) => {
      const at = pointer(path, String(index));
      const before = issues.length;
      validate(item, node.items, at, issues);
      if (issues.length === before && seen.has(item))
        issues.push({ code: "settings_value_invalid", path: at });
      seen.add(item);
    });
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

// What the closed tree cannot say about the tabs: two tabs never share a
// name (letter case ignored), and a module is in one tab at most.
function workspaceIssues(
  settings: unknown,
  issues: OrganizationSettingsIssue[],
): void {
  const tabs = (settings as OrganizationSettingsValues).workspace?.tabs;
  if (tabs === undefined) return;
  const names = new Set<string>();
  const modules = new Set<string>();
  tabs.forEach((tab, index) => {
    const at = `/settings/workspace/tabs/${index}`;
    const name = tab.name.normalize("NFC").toLocaleLowerCase();
    if (names.has(name))
      issues.push({ code: "settings_value_invalid", path: `${at}/name` });
    names.add(name);
    tab.modules.forEach((module, position) => {
      if (modules.has(module))
        issues.push({
          code: "settings_value_invalid",
          path: `${at}/modules/${position}`,
        });
      modules.add(module);
    });
  });
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
