import { createHash } from "node:crypto";
import { posix } from "node:path";
import { personalspaceName } from "../organizations/personalspace";

// The single generator of a new Lazurio Module (decision F52; root decision
// 0171, addendum of 2026-10-13, point 3): a pure plan of the module's files,
// its slot in `modules.manifest.json` and its port lease. `lazurio module
// create` writes it; nothing here reads or writes anything. The caller reads
// the templates, the manifest and the leases it can see, and decides where
// the plan goes.
//
// Ported from HumanAndMachines/Lazurio `lazurio/module-scaffold-lib.mjs` at
// a5615be0: the same stacks, slug rules, placeholder engine, tree hash, port
// choice and slot insert, with the same refusal codes. What differs: the
// personal form (`owner.kind: "personal"`: `company` is the person's login,
// the slot is private to its owner, the `_personal` layer replaces the
// module's AGENTS.md), the gateway's labels among the reserved slugs, English
// messages, and the taken ports given as numbers. Provenance of the templates
// and every change to them: `src/modules/templates/README.md`.

export const scaffoldLeaseId = "main";
export const scaffoldListenerId = "app";
export const scaffoldAppPackage = "app/v1/package.json";

/** The Bun version a new module pins: this repository's own `packageManager`
 * (tests keep the two equal), as the root pinned its Core's. */
export const scaffoldBunVersion = "1.4.2";

/** The versions a new module pins besides Bun. */
export const defaultScaffoldVersions = Object.freeze({
  moduleKit: "0.2.0",
  uv: "0.11.6",
});

export type PortPool = Readonly<{ start: number; end: number }>;

/** The reserved range of personal leases (root decision 0171, addendum of
 * 2026-10-13, point 2; decision F52): the `module_port_pool` a
 * Personalspace's `modules.manifest.json` declares, and no Organization's
 * pool ever uses. 100 ports, the size of an Organization's pool; below every
 * Organization pool on record (they start at 24000 and grow upward), clear of
 * the Environment's own ports (`environmentPorts`) and below every operating
 * system's ephemeral range (Linux from 32768, macOS and Windows from 49152),
 * so an outgoing connection never holds one. */
export const personalModulePortPool: PortPool = Object.freeze({
  start: 23_000,
  end: 23_099,
});

/** The Environment's own ports, never a module's lease: the gateway's TLS and
 * sign-in proxy (443, 4180), the Launchpad (20000), T3 Code (3773), Lazurio
 * MausBot and its webhook receiver (4102, 4103), the Environment browser's
 * view and its DevTools port (4848, 9222), Executor (4789) and a
 * workstation's resident Launchpad (4174). */
export const environmentPorts: readonly number[] = Object.freeze([
  443, 3773, 4102, 4103, 4174, 4180, 4789, 4848, 9222, 20_000,
]);

type StackSpec = Readonly<{
  layers: readonly string[];
  toolchain: "bun" | "uv" | null;
  category: string;
}>;

const stacks = {
  "vite-react": {
    layers: ["_common", "_bun", "vite-react"],
    toolchain: "bun",
    category: "application",
  },
  astro: {
    layers: ["_common", "_bun", "astro"],
    toolchain: "bun",
    category: "publishing",
  },
  "astro-starlight": {
    layers: ["_common", "_bun", "astro-starlight"],
    toolchain: "bun",
    category: "knowledge",
  },
  "bun-service": {
    layers: ["_common", "_bun", "bun-service"],
    toolchain: "bun",
    category: "engineering",
  },
  "python-uv": {
    layers: ["_common", "python-uv"],
    toolchain: "uv",
    category: "engineering",
  },
  none: { layers: ["_common", "none"], toolchain: null, category: "workspace" },
} as const satisfies Record<string, StackSpec>;

export type ModuleStack = keyof typeof stacks;

export const moduleScaffoldStacks = Object.freeze(
  Object.keys(stacks),
) as readonly ModuleStack[];

/** The layer a personal module gets last, over its stack's layers. */
export const personalLayer = "_personal";

/** Every template layer directory under `src/modules/templates/`. */
export const moduleScaffoldLayers: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.values(stacks).flatMap(
      (stack): readonly string[] => stack.layers,
    ),
    personalLayer,
  ]),
]);

/** Slugs a workspace module never takes: the boundaries of an Organization
 * and of the Folder (the root's list), and the labels the gateway of a
 * Remote Environment keeps for itself (`M:workloads/workspace-vm/gateway.ts`
 * and `gateway-catalog.py`: its roster applications and `RESERVED`), since a
 * module's hostname is its slug. */
export const reservedModuleSlugs: readonly string[] = Object.freeze([
  "productionspace",
  "personalspace",
  "mission-control",
  "mission-control-data",
  "launchpad",
  "design-system",
  "infra",
  "workspace",
  "modules",
  "organizations",
  "t3code",
  "mausbot",
  "mausbot-webhook",
  "browser",
  "oauth2",
  "api",
  "well-known",
]);

const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const slugMaxLength = 50;
const teamPattern = /^(?!productionspace$)[a-z0-9][a-z0-9-]*$/;
const organizationPattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
// GitHub's own rule: 1–39 characters, letters, digits and hyphens, never a
// hyphen first or last (the Personalspace template's `isValidGitHubLogin`).
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const runtimeIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a display name refuses control characters.
const displayNameForbidden = /["\\<>{}`\u0000-\u001f\u007f]/;
const displayNameMaxLength = 80;
const placeholder = /\{\{([A-Za-z0-9_]*)\}\}/g;

export type ModuleScaffoldCode =
  | "unknown_stack"
  | "invalid_slug"
  | "reserved_slug"
  | "invalid_display_name"
  | "invalid_team"
  | "unknown_team"
  | "teams_not_allowed"
  | "invalid_organization"
  | "invalid_owner"
  | "invalid_versions"
  | "slot_exists"
  | "pool_missing"
  | "pool_invalid"
  | "port_not_allowed"
  | "port_outside_pool"
  | "port_taken"
  | "pool_exhausted"
  | "template_invalid"
  | "manifest_invalid"
  | "manifest_insert_failed";

/** A refusal of the generator with a stable `code`. */
export class ModuleScaffoldError extends Error {
  readonly code: ModuleScaffoldCode;
  readonly action: string | undefined;
  constructor(code: ModuleScaffoldCode, message: string, action?: string) {
    super(message);
    this.name = "ModuleScaffoldError";
    this.code = code;
    this.action = action;
  }
}

/** Whose module it is: an Organization's (its slug, GitHub login and, when
 * known, its Teams), or a person's in their Personalspace (their login). */
export type ScaffoldOwner =
  | Readonly<{
      kind: "organization";
      slug: string;
      githubOrg: string;
      teams?: readonly string[] | null | undefined;
    }>
  | Readonly<{ kind: "personal"; login: string }>;

export type TemplateFile = Readonly<{
  path: string;
  content: string;
  mode?: string | undefined;
}>;

export type ScaffoldTemplates = Readonly<{
  layers: Readonly<Record<string, readonly TemplateFile[]>>;
}>;

export type ScaffoldVersions = Readonly<{
  bun: string;
  moduleKit: string;
  uv: string;
}>;

export type ScaffoldLease = Readonly<{
  id: string;
  host: "127.0.0.1";
  port: number;
}>;

/** The slot of a new module in `modules.manifest.json`, in the order its
 * members are written. */
export type ModuleSlot = Readonly<{
  path: string;
  slug: string;
  space: "workspace";
  teams?: readonly string[];
  category: string;
  default_access: "expected" | "private";
  required_roles: readonly string[];
  source_of_truth: "git-native";
  status: "active";
  notes: string;
  git: Readonly<{ url: string; branch: "main" }>;
}>;

export type ModuleScaffoldInput = Readonly<{
  owner: ScaffoldOwner;
  /** Lowercase kebab slug of the module and of its repository. */
  slug: unknown;
  stack: unknown;
  /** Defaults to the slug in sentence case. */
  displayName?: string | null | undefined;
  /** Team slugs for `module_slots[].teams`, an Organization's only. */
  teams?: readonly unknown[] | undefined;
  /** An explicit port of the pool; default `moduleScaffoldDefaultPort`. */
  port?: number | null | undefined;
  pool: PortPool | null;
  /** The slots already declared, by the manifests the caller reads. */
  existingSlots: readonly unknown[];
  /** Every port the caller sees held: every lease it can read, and the
   * Environment's own ports. */
  takenPorts: Iterable<number>;
  templates: ScaffoldTemplates;
  versions: ScaffoldVersions;
}>;

export type ScaffoldFile = Readonly<{
  path: string;
  content: string;
  mode?: string;
}>;

export type ModuleScaffoldPlan = Readonly<{
  scope: "organization" | "personal";
  /** The Organization's slug, or the person's login. */
  owner: string;
  module: string;
  stack: ModuleStack;
  displayName: string;
  modulePath: string;
  files: readonly ScaffoldFile[];
  /** The lockfile the install writes (`bun install`, `uv lock`), which a
   * pure plan cannot. */
  generatedByInstall: readonly string[];
  toolchain: "bun" | "uv" | null;
  slot: ModuleSlot;
  lease: ScaffoldLease | null;
  treeHash: string;
  warnings: readonly string[];
}>;

/**
 * Plans a new module. Deterministic: the same input gives the same plan and
 * the same `treeHash`. Throws `ModuleScaffoldError` (see its codes);
 * `directory_exists` and the Git and branch refusals belong to the caller
 * that writes.
 */
export function planModuleScaffold(
  input: ModuleScaffoldInput,
): ModuleScaffoldPlan {
  const stack = assertStack(input.stack);
  const spec: StackSpec = stacks[stack];
  const slug = assertSlug(input.slug);
  const displayName = normalizeDisplayName(input.displayName, slug);
  const owner = normalizeOwner(input.owner);
  const teams = normalizeTeams(input.teams ?? [], owner);
  const pinned = normalizeVersions(input.versions);
  assertSlotFree(slug, input.existingSlots);
  const pool = normalizePool(input.pool);
  // A person's module leases only from the reserved personal range, whatever
  // pool its caller read (decision F52, root 0171's addendum of 2026-10-13).
  if (
    owner.kind === "personal" &&
    pool !== null &&
    (pool.start < personalModulePortPool.start ||
      pool.end > personalModulePortPool.end)
  )
    throw new ModuleScaffoldError(
      "pool_invalid",
      `A personal module's module_port_pool lies within ${personalModulePortPool.start}-${personalModulePortPool.end}, the range no Organization uses.`,
    );
  const lease: ScaffoldLease | null =
    spec.toolchain === null
      ? assertNoPort(input.port)
      : {
          id: scaffoldLeaseId,
          host: "127.0.0.1",
          port: choosePort(
            input.port,
            pool,
            new Set(input.takenPorts),
            slug,
            owner,
          ),
        };

  const personal = owner.kind === "personal";
  const values: Record<string, string> = {
    slug,
    display_name: displayName,
    organization: owner.name,
    github_org: owner.githubLogin,
    stack,
    listener_id: scaffoldListenerId,
    listener_env_prefix: `LAZURIO_RUNTIME_LISTENER_${scaffoldListenerId.toUpperCase().replaceAll("-", "_")}`,
    // A personal app's runtime id names no person: the catalog shows it
    // (`display.id`), and no output names a personal module's owner.
    runtime_id: runtimeId(personal ? personalspaceName : owner.name, slug),
    python_package: slug.replaceAll("-", "_"),
    port: lease ? String(lease.port) : "",
    bun_version: pinned.bun,
    module_kit_version: pinned.moduleKit,
    uv_version: pinned.uv,
    // Wording of a module's own files that names whose it is (decision F52).
    owner_label: personal ? "osobního prostoru" : "Organizace",
    pool_label: personal ? "osobního poolu" : "poolu Organizace",
    module_name: personal
      ? `${personalspaceName}/${slug}`
      : `${owner.name}/${slug}`,
    verify_command: personal
      ? `lazurio module list ${personalspaceName} --json`
      : "lazurio module setup <cesta k Modulu> --root <Lazurio root> --json",
  };

  const files = new Map<string, ScaffoldFile>();
  const layers = personal ? [...spec.layers, personalLayer] : spec.layers;
  for (const layer of layers) {
    const entries = input.templates.layers[layer];
    if (!Array.isArray(entries))
      throw new ModuleScaffoldError(
        "template_invalid",
        `The templates have no layer ${layer}.`,
      );
    for (const entry of entries as readonly TemplateFile[]) {
      const source = String(entry?.path ?? "");
      const path = templateTargetPath(
        substitute(source, values, `${layer}: path ${source}`),
      );
      assertRelativePath(path, `${layer}/${source}`);
      const content = substitute(
        String(entry?.content ?? ""),
        values,
        `${layer}/${source}`,
      );
      files.set(path, {
        path,
        content,
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      });
    }
  }
  files.set("lazurio.module.json", {
    path: "lazurio.module.json",
    content: `${JSON.stringify(moduleManifest(owner.name, slug, lease), null, 2)}\n`,
  });
  const sorted = [...files.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const file of sorted) {
    if (!file.path.endsWith(".json")) continue;
    try {
      JSON.parse(file.content);
    } catch (error) {
      throw new ModuleScaffoldError(
        "template_invalid",
        `${file.path} is not valid JSON after substitution: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (lease !== null && !files.has(scaffoldAppPackage))
    throw new ModuleScaffoldError(
      "template_invalid",
      `The stack ${stack} has no ${scaffoldAppPackage}.`,
    );

  const warnings: string[] = [];
  if (spec.toolchain === "uv")
    warnings.push(
      `Python app: this Platform does not read the uv preparation yet (DEV-6634 W0-5), so the module is listed with default-app-invalid and does not start from the Launchpad; until then check it by hand with uv run --no-sync ${slug}.`,
    );

  return Object.freeze({
    scope: owner.kind,
    owner: owner.name,
    module: slug,
    stack,
    displayName,
    modulePath: `workspace/${slug}`,
    files: Object.freeze(sorted),
    generatedByInstall: Object.freeze(
      spec.toolchain === "bun"
        ? ["app/v1/bun.lock"]
        : spec.toolchain === "uv"
          ? ["app/v1/uv.lock"]
          : [],
    ),
    toolchain: spec.toolchain,
    slot: moduleSlot({
      slug,
      displayName,
      stack,
      category: spec.category,
      teams,
      owner,
    }),
    lease,
    treeHash: moduleScaffoldTreeHash(sorted),
    warnings: Object.freeze(warnings),
  });
}

/**
 * The default port lease of a new module: the first port not in `taken`,
 * walking forward with wrap-around from `pool.start + (h mod poolSize)`,
 * where `h` is the first 4 bytes (big-endian uint32) of sha256 over the
 * UTF-8 slug; null when the whole pool is taken.
 *
 * Why not the lowest free port: a work branch cannot see a module created in
 * a sibling branch before it is merged, so "lowest free" gave two concurrent
 * creations the same port every time. Starting at a slug-derived offset
 * keeps the choice pure and deterministic while making such collisions
 * coincidental. There is deliberately no registry or cross-branch scan (the
 * exact port is the module's own).
 */
export function moduleScaffoldDefaultPort(
  slug: string,
  pool: PortPool,
  taken: ReadonlySet<number> = new Set(),
): number | null {
  const size = pool.end - pool.start + 1;
  const offset =
    createHash("sha256").update(slug, "utf8").digest().readUInt32BE(0) % size;
  for (let step = 0; step < size; step += 1) {
    const candidate = pool.start + ((offset + step) % size);
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** sha256 over the files sorted by path (path, mode and content of each). */
export function moduleScaffoldTreeHash(
  files: readonly Readonly<{ path: string; content: string; mode?: string }>[],
): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const file of sorted) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.mode ?? "");
    hash.update("\u0000");
    hash.update(file.content);
    hash.update("\u0000");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Template file name → module file name: `dot-x` segments become `.x`, a
 * trailing `.tmpl` is dropped. */
export function templateTargetPath(path: string): string {
  const segments = String(path)
    .split("/")
    .map((segment) =>
      segment.startsWith("dot-") ? `.${segment.slice(4)}` : segment,
    );
  const last = segments.length - 1;
  const name = segments[last] ?? "";
  if (name.endsWith(".tmpl")) segments[last] = name.slice(0, -".tmpl".length);
  return segments.join("/");
}

/**
 * Inserts `slot` into the text of a `modules.manifest.json` without touching
 * any other byte: the new entry goes after the last `workspace/` slot (or at
 * the end), indented like its neighbours. The result is parsed back and must
 * equal the original document with exactly this slot added.
 */
export function insertModuleSlotText(
  manifestText: string,
  slot: ModuleSlot,
): string {
  let document: unknown;
  try {
    document = JSON.parse(manifestText);
  } catch (error) {
    throw new ModuleScaffoldError(
      "manifest_invalid",
      `modules.manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const slots = (document as { module_slots?: unknown } | null)?.module_slots;
  if (!Array.isArray(slots))
    throw new ModuleScaffoldError(
      "manifest_invalid",
      "modules.manifest.json has no module_slots array.",
    );
  const scanner = jsonScanner(manifestText);
  const root = scanner.object(scanner.skipWhitespace(0));
  const entry = root.entries.find((item) => item.key === "module_slots");
  if (entry === undefined)
    throw new ModuleScaffoldError(
      "manifest_invalid",
      "modules.manifest.json has no module_slots array.",
    );
  const elements = scanner.array(entry.valueStart);
  let lastWorkspace = -1;
  slots.forEach((item: unknown, position: number) => {
    const path = (item as { path?: unknown } | null)?.path;
    if (typeof path === "string" && path.startsWith("workspace/"))
      lastWorkspace = position;
  });
  const index = lastWorkspace >= 0 ? lastWorkspace : slots.length - 1;
  let next: string;
  const first = elements[0];
  const anchor = elements[index];
  if (first === undefined || anchor === undefined) {
    const keyIndent = lineIndent(manifestText, entry.keyStart);
    const indent = `${keyIndent}  `;
    next = `${manifestText.slice(0, entry.valueStart)}[\n${indent}${indentJson(slot, indent)}\n${keyIndent}]${manifestText.slice(entry.valueEnd)}`;
  } else {
    const indent = lineIndent(manifestText, first.start);
    next = `${manifestText.slice(0, anchor.end)},\n${indent}${indentJson(slot, indent)}${manifestText.slice(anchor.end)}`;
  }
  const expected = structuredClone(document) as { module_slots: unknown[] };
  expected.module_slots.splice(elements.length === 0 ? 0 : index + 1, 0, slot);
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(expected))
    throw new ModuleScaffoldError(
      "manifest_insert_failed",
      "The slot could not be inserted into modules.manifest.json verifiably; the file was left unchanged.",
    );
  return next;
}

/**
 * Declares `pool` as the `module_port_pool` of a `modules.manifest.json`
 * that has none, without touching any other byte: the member goes right
 * before `module_slots`, indented like it. The result is parsed back and must
 * equal the original document with exactly this member added (the personal
 * pool a Personalspace declares with its first module, decision F52).
 */
export function insertModulePortPoolText(
  manifestText: string,
  pool: PortPool,
): string {
  let document: unknown;
  try {
    document = JSON.parse(manifestText);
  } catch (error) {
    throw new ModuleScaffoldError(
      "manifest_invalid",
      `modules.manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.hasOwn(document, "module_port_pool")
  )
    throw new ModuleScaffoldError(
      "manifest_invalid",
      "modules.manifest.json is no object without a module_port_pool.",
    );
  const scanner = jsonScanner(manifestText);
  const root = scanner.object(scanner.skipWhitespace(0));
  const slots = root.entries.find((item) => item.key === "module_slots");
  if (slots === undefined)
    throw new ModuleScaffoldError(
      "manifest_invalid",
      "modules.manifest.json has no module_slots array.",
    );
  const indent = lineIndent(manifestText, slots.keyStart);
  const member = { start: pool.start, end: pool.end };
  const next = `${manifestText.slice(0, slots.keyStart)}"module_port_pool": ${indentJson(member, indent)},\n${indent}${manifestText.slice(slots.keyStart)}`;
  if (
    canonicalJson(JSON.parse(next)) !==
    canonicalJson({ ...(document as object), module_port_pool: member })
  )
    throw new ModuleScaffoldError(
      "manifest_insert_failed",
      "The module_port_pool could not be declared in modules.manifest.json verifiably; the file was left unchanged.",
    );
  return next;
}

/** JSON with every object's keys sorted: equal documents give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

// ---- inputs ----------------------------------------------------------------

/** The stack of a new module, or `unknown_stack`. */
export function assertStack(value: unknown): ModuleStack {
  if (typeof value === "string" && Object.hasOwn(stacks, value))
    return value as ModuleStack;
  throw new ModuleScaffoldError(
    "unknown_stack",
    `The stack ${JSON.stringify(value)} does not exist; the stacks are ${moduleScaffoldStacks.join(", ")}.`,
    "Choose a stack of the Lazurio Module Standard (chapter 6); another stack is the Operator's decision.",
  );
}

/** The slug of a new module, or `invalid_slug` / `reserved_slug`. */
export function assertSlug(value: unknown): string {
  if (
    typeof value !== "string" ||
    !slugPattern.test(value) ||
    value.length > slugMaxLength
  )
    throw new ModuleScaffoldError(
      "invalid_slug",
      `The slug ${JSON.stringify(value)} is not lowercase kebab-case (${slugPattern.source}, at most ${slugMaxLength} characters).`,
      "Use lowercase letters, digits and hyphens, starting with a letter, for example customer-portal.",
    );
  if (reservedModuleSlugs.includes(value))
    throw new ModuleScaffoldError(
      "reserved_slug",
      `The slug ${value} is reserved for a boundary of an Organization, of the Folder or of the Environment's gateway.`,
      "Choose another slug for the module.",
    );
  return value;
}

function normalizeDisplayName(value: unknown, slug: string): string {
  const name =
    value === undefined || value === null
      ? `${slug.charAt(0).toUpperCase()}${slug.slice(1).replaceAll("-", " ")}`
      : String(value).trim();
  if (
    name === "" ||
    name.length > displayNameMaxLength ||
    displayNameForbidden.test(name) ||
    name.includes("{{")
  )
    throw new ModuleScaffoldError(
      "invalid_display_name",
      `The name ${JSON.stringify(value)} cannot be used (1–${displayNameMaxLength} characters, without " \\ < > { } \` or control characters).`,
      "Give a plain name, for example Customer portal.",
    );
  return name;
}

type Owner = Readonly<{
  kind: "organization" | "personal";
  /** The Organization's slug or the person's login: `company`. */
  name: string;
  /** Where its repositories live on GitHub. */
  githubLogin: string;
  roster: readonly string[] | null;
}>;

function normalizeOwner(owner: ScaffoldOwner): Owner {
  if (owner?.kind === "personal") {
    if (
      typeof owner.login !== "string" ||
      !githubLoginPattern.test(owner.login)
    )
      throw new ModuleScaffoldError(
        "invalid_owner",
        `The person's GitHub login ${JSON.stringify(owner.login)} is not valid.`,
      );
    return {
      kind: "personal",
      name: owner.login,
      githubLogin: owner.login,
      roster: null,
    };
  }
  const slug = owner?.slug;
  const githubOrg = owner?.githubOrg;
  if (typeof slug !== "string" || !organizationPattern.test(slug))
    throw new ModuleScaffoldError(
      "invalid_organization",
      `The Organization has no valid slug (${JSON.stringify(slug)}).`,
    );
  if (typeof githubOrg !== "string" || !githubLoginPattern.test(githubOrg))
    throw new ModuleScaffoldError(
      "invalid_organization",
      `The Organization ${slug} has no valid GitHub login (${JSON.stringify(githubOrg)}).`,
    );
  return {
    kind: "organization",
    name: slug,
    githubLogin: githubOrg,
    roster: Array.isArray(owner.teams) ? owner.teams : null,
  };
}

function normalizeTeams(teams: readonly unknown[], owner: Owner): string[] {
  if (!Array.isArray(teams))
    throw new ModuleScaffoldError(
      "invalid_team",
      "teams must be an array of Team slugs.",
    );
  if (owner.kind === "personal") {
    if (teams.length > 0)
      throw new ModuleScaffoldError(
        "teams_not_allowed",
        "A personal module has no Teams: it is the person's own.",
        "Leave out the Teams.",
      );
    return [];
  }
  const seen = new Set<string>();
  for (const team of teams) {
    if (typeof team !== "string" || !teamPattern.test(team) || seen.has(team))
      throw new ModuleScaffoldError(
        "invalid_team",
        `The Team ${JSON.stringify(team)} is not valid or is named twice.`,
      );
    seen.add(team);
  }
  if (owner.roster !== null) {
    const roster = owner.roster;
    const unknown = [...seen].filter((team) => !roster.includes(team));
    if (unknown.length > 0)
      throw new ModuleScaffoldError(
        "unknown_team",
        `The Organization declares no Team ${unknown.join(", ")}.`,
        `Use a Team of lazurio.organization.json#teams (${roster.join(", ") || "none"}); a new Team is the Organization Admin's.`,
      );
  }
  return [...seen];
}

function normalizeVersions(versions: ScaffoldVersions): ScaffoldVersions {
  const pinned = {
    bun: versions?.bun,
    moduleKit: versions?.moduleKit ?? defaultScaffoldVersions.moduleKit,
    uv: versions?.uv ?? defaultScaffoldVersions.uv,
  };
  for (const [name, value] of Object.entries(pinned))
    if (typeof value !== "string" || !versionPattern.test(value))
      throw new ModuleScaffoldError(
        "invalid_versions",
        `The ${name} version ${JSON.stringify(value)} is not an exact semver version.`,
      );
  return pinned as ScaffoldVersions;
}

function normalizePool(pool: PortPool | null): PortPool | null {
  if (pool === null || pool === undefined) return null;
  if (
    !(
      Number.isInteger(pool.start) &&
      Number.isInteger(pool.end) &&
      pool.start >= 1024 &&
      pool.end <= 65_535 &&
      pool.start <= pool.end
    )
  )
    throw new ModuleScaffoldError(
      "pool_invalid",
      "The module_port_pool is not a valid range of ports.",
    );
  return { start: pool.start, end: pool.end };
}

function assertSlotFree(slug: string, slots: readonly unknown[]) {
  const wanted = slug.toLowerCase();
  for (const item of Array.isArray(slots) ? slots : []) {
    const slot = item as { path?: unknown; slug?: unknown } | null;
    const path = typeof slot?.path === "string" ? slot.path : "";
    const names = [slot?.slug, posix.basename(path), path === "" ? null : path]
      .filter((name): name is string => typeof name === "string" && name !== "")
      .map((name) => name.toLowerCase());
    if (names.includes(wanted) || names.includes(`workspace/${wanted}`))
      throw new ModuleScaffoldError(
        "slot_exists",
        `A slot ${path || String(slot?.slug)} already matches the slug ${slug} (letter case ignored).`,
        "Choose another slug, or work in the existing module.",
      );
  }
}

function assertNoPort(port: number | null | undefined): null {
  if (port !== null && port !== undefined)
    throw new ModuleScaffoldError(
      "port_not_allowed",
      "The stack none has no app and no port lease; --port does not belong to it.",
    );
  return null;
}

function choosePort(
  port: number | null | undefined,
  pool: PortPool | null,
  taken: ReadonlySet<number>,
  slug: string,
  owner: Owner,
): number {
  if (pool === null)
    throw new ModuleScaffoldError(
      "pool_missing",
      owner.kind === "organization"
        ? `The Organization ${owner.name} has no module_port_pool; a module with an app has nowhere to take its lease from.`
        : "There is no module_port_pool; a module with an app has nowhere to take its lease from.",
      owner.kind === "organization"
        ? "The Organization Admin adds a module_port_pool (100 ports disjoint from every other Organization's)."
        : undefined,
    );
  if (port !== null && port !== undefined) {
    if (!Number.isInteger(port) || port < pool.start || port > pool.end)
      throw new ModuleScaffoldError(
        "port_outside_pool",
        `Port ${port} is not in the module_port_pool ${pool.start}-${pool.end}.`,
        "Leave out --port (the scaffold picks a free port of the pool derived from the slug) or choose a port of the pool.",
      );
    if (taken.has(port))
      throw new ModuleScaffoldError(
        "port_taken",
        `Port ${port} is already held by another module or by the Environment itself.`,
        "Leave out --port or choose a free port of the pool.",
      );
    return port;
  }
  const chosen = moduleScaffoldDefaultPort(slug, pool, taken);
  if (chosen !== null) return chosen;
  throw new ModuleScaffoldError(
    "pool_exhausted",
    `The module_port_pool ${pool.start}-${pool.end} has no free port.`,
    owner.kind === "organization"
      ? "The Organization Admin decides on a wider pool or on removing unused leases."
      : "Remove a personal module that is no longer used; its lease frees its port.",
  );
}

function runtimeId(owner: string, slug: string): string {
  const id = `${owner
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")}-${slug}-v1`;
  if (!runtimeIdPattern.test(id))
    throw new ModuleScaffoldError(
      "invalid_owner",
      `No runtime id can be derived from ${owner} (${id}).`,
    );
  return id;
}

function moduleManifest(
  owner: string,
  slug: string,
  lease: ScaffoldLease | null,
) {
  return lease
    ? {
        schema_version: "lazurio.module.v1",
        id: slug,
        company: owner,
        tcp_port_policy: { mode: "single" },
        port_leases: [lease],
        apps: [scaffoldAppPackage],
        default_app: scaffoldAppPackage,
      }
    : {
        schema_version: "lazurio.module.v1",
        id: slug,
        company: owner,
        tcp_port_policy: { mode: "none" },
        port_leases: [],
        apps: [],
      };
}

function moduleSlot(input: {
  slug: string;
  displayName: string;
  stack: ModuleStack;
  category: string;
  teams: readonly string[];
  owner: Owner;
}): ModuleSlot {
  const personal = input.owner.kind === "personal";
  return Object.freeze({
    path: `workspace/${input.slug}`,
    slug: input.slug,
    space: "workspace" as const,
    ...(input.teams.length > 0
      ? { teams: Object.freeze([...input.teams]) }
      : {}),
    category: input.category,
    // A personal module is its owner's alone (template slots, root 0091).
    default_access: personal ? ("private" as const) : ("expected" as const),
    required_roles: Object.freeze(personal ? ["owner"] : ["*"]),
    source_of_truth: "git-native" as const,
    status: "active" as const,
    notes: personal
      ? `${input.displayName}: osobní Modul založený příkazem lazurio module create (stack ${input.stack}).`
      : `${input.displayName}: Modul založený příkazem lazurio module create (stack ${input.stack}).`,
    git: Object.freeze({
      url: `git@github.com:${input.owner.githubLogin}/${input.slug}.git`,
      branch: "main" as const,
    }),
  });
}

function substitute(
  text: string,
  values: Readonly<Record<string, string>>,
  label: string,
): string {
  return text.replace(placeholder, (match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined)
      throw new ModuleScaffoldError(
        "template_invalid",
        `${label}: unknown placeholder ${match}.`,
      );
    return value;
  });
}

function assertRelativePath(path: string, label: string) {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new ModuleScaffoldError(
      "template_invalid",
      `${label}: the path ${JSON.stringify(path)} is not a safe relative path.`,
    );
}

// ---- JSON text -------------------------------------------------------------

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
}

function indentJson(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split("\n").join(`\n${indent}`);
}

type ObjectEntry = {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
};

// A minimal JSON scanner: the offsets of object entries and array elements,
// so a member can be inserted without re-serializing (and reformatting) the
// file. Only ever given text that `JSON.parse` accepted.
function jsonScanner(text: string) {
  const at = (index: number) => text.charAt(index);
  const skipWhitespace = (index: number) => {
    let cursor = index;
    while (cursor < text.length && /\s/.test(at(cursor))) cursor += 1;
    return cursor;
  };
  const stringEnd = (index: number) => {
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      if (at(cursor) === "\\") cursor += 1;
      else if (at(cursor) === '"') return cursor + 1;
    }
    throw new ModuleScaffoldError(
      "manifest_invalid",
      "modules.manifest.json has an unterminated string.",
    );
  };
  const valueEnd = (index: number): number => {
    const character = at(index);
    if (character === '"') return stringEnd(index);
    if (character === "{") return object(index).end;
    if (character === "[") return array(index).end;
    let cursor = index;
    while (cursor < text.length && !/[\s,\]}]/.test(at(cursor))) cursor += 1;
    return cursor;
  };
  function object(start: number): { entries: ObjectEntry[]; end: number } {
    const entries: ObjectEntry[] = [];
    let cursor = skipWhitespace(start + 1);
    if (at(cursor) === "}") return { entries, end: cursor + 1 };
    while (cursor < text.length) {
      const keyStart = cursor;
      const keyEnd = stringEnd(cursor);
      cursor = skipWhitespace(keyEnd);
      cursor = skipWhitespace(cursor + 1);
      const valueStart = cursor;
      const end = valueEnd(cursor);
      entries.push({
        key: JSON.parse(text.slice(keyStart, keyEnd)) as string,
        keyStart,
        valueStart,
        valueEnd: end,
      });
      cursor = skipWhitespace(end);
      if (at(cursor) === "}") return { entries, end: cursor + 1 };
      cursor = skipWhitespace(cursor + 1);
    }
    throw new ModuleScaffoldError(
      "manifest_invalid",
      "modules.manifest.json has an unterminated object.",
    );
  }
  function array(start: number): { start: number; end: number }[] & {
    end: number;
  } {
    const elements: { start: number; end: number }[] = [];
    let cursor = skipWhitespace(start + 1);
    if (at(cursor) === "]") return Object.assign(elements, { end: cursor + 1 });
    while (cursor < text.length) {
      const end = valueEnd(cursor);
      elements.push({ start: cursor, end });
      cursor = skipWhitespace(end);
      if (at(cursor) === "]")
        return Object.assign(elements, { end: cursor + 1 });
      cursor = skipWhitespace(cursor + 1);
    }
    throw new ModuleScaffoldError(
      "manifest_invalid",
      "modules.manifest.json has an unterminated array.",
    );
  }
  return { skipWhitespace, object, array };
}
