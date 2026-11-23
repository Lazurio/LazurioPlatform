import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { readCheckoutJson } from "../providers/owned-json";
import { parseModuleManifest } from "./manifest";
import { readModuleApplication } from "./read-application";

/** Whether a Module is ready as an Application (decision 0249, issue #423):
 * the static half of the check, read from the checkout without running
 * anything or using the network. The runtime half is the Module's own
 * contract tests in its CI over `@lazurio/module-kit` testing helpers, which
 * this check asks for; the live probe of a deployed Application's gateway and
 * the release evidence of the Organization's release mode belong to the
 * rollout. It measures and reports and changes nothing (decision 0173): an
 * agent fixes the findings in the Module. */

export type Generation = "V0" | "V1" | "V2" | "V3" | "V4";
export type Verdict =
  | "no-application"
  | "not-ready"
  | "ready-for-trial"
  | "ready-for-live";

/** `blocker`: the Application cannot run from this Module. `live`: it may run
 * as a trial, not for people's real work, or the evidence for live use could
 * not be read. */
export type FindingLevel = "blocker" | "live";

export type Finding = Readonly<{
  id: string;
  level: FindingLevel;
  message: string;
}>;

/** What the application host must support before this Module can run there.
 * Not a defect of the Module: it does not lower the Module's own verdict, and
 * a rollout checks it against the host it deploys to. */
export type HostCondition = Readonly<{
  id: "static-app" | "data-sibling" | "api-sibling";
  detail: string;
}>;

export type Readiness = Readonly<{
  schema_version: "lazurio.module-readiness.v1";
  module: string | null;
  app: string | null;
  generation: Generation | null;
  verdict: Verdict;
  findings: readonly Finding[];
  hostConditions: readonly HostCondition[];
}>;

/** Everything the assessment needs, read once from the checkout. */
export type ReadinessInput = Readonly<{
  manifest: unknown;
  /** Null when the Module declares no app or its manifest does not parse. */
  app: Readonly<{
    package: string;
    /** Why the selected app could not be read as the start path reads it;
     * nothing else of the app is read then. */
    declarationError: string | null;
    pkg: Readonly<Record<string, unknown>> | null;
    /** Concatenated source text of the app (bounded), for markers only. */
    source: string;
    /** The same, without tests, fixtures, scripts, skills and docs: only what
     * runs, for markers whose presence in a test would be no evidence. */
    runtimeSource: string;
    /** Committed source files that were not read (over a limit, or Git
     * failed); a marker missing from `source` is then unknown, not absent. */
    sourceSkipped: readonly string[];
    server: boolean;
    staticBuild: boolean;
    healthPaths: readonly string[];
    slots: readonly string[];
  }> | null;
  /** Regular files committed at HEAD in the Module (never the index or the
   * working directory), relative to its root; null when Git
   * could not say (no repository, Git missing). */
  tracked: readonly string[] | null;
  workflows: readonly string[];
}>;

const MODULE_KIT_FLOOR = [0, 3, 0] as const;

function dependencies(pkg: Readonly<Record<string, unknown>> | null) {
  const all: Record<string, string> = {};
  for (const key of ["dependencies", "devDependencies"]) {
    const value = pkg?.[key];
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [name, spec] of Object.entries(value))
        if (typeof spec === "string") all[name] = spec;
  }
  return all;
}

/** The version a dependency spec names: `github:…#v0.3.0`, `^0.3.0`, `0.3.0`. */
export function specVersion(spec: string): [number, number, number] | null {
  const match = /(?:#v?|^[~^]?v?)(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(spec);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(
  version: readonly number[],
  floor: readonly number[],
): boolean {
  for (let index = 0; index < floor.length; index++) {
    const a = version[index] ?? 0;
    const b = floor[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Where the data are (decision 0249). The data layer wins over the
 * directory, because a Module created before the generation rule may keep an
 * app with data in `app/v1` or `app/v2` (Module Standard, App generations);
 * otherwise the directory `app/v<N>/` names it. A data layer reached through
 * a wrapper is still caught by its directory. */
export function generationOf(input: ReadinessInput): Generation {
  if (input.app === null) return "V0";
  const deps = dependencies(input.app.pkg);
  const directory = /^app\/v([1-4])\//.exec(input.app.package)?.[1];
  if ("mysql2" in deps || directory === "4") return "V4";
  if ("@lazurio/repository-db" in deps || directory === "3") return "V3";
  const tracked = input.tracked ?? [];
  if (directory === "2" || tracked.some((file) => file.startsWith("data/v2/")))
    return "V2";
  return "V1";
}

export function assessReadiness(input: ReadinessInput): Readiness {
  const findings: Finding[] = [];
  const hostConditions: HostCondition[] = [];
  const add = (id: string, level: FindingLevel, message: string) =>
    findings.push(Object.freeze({ id, level, message }));
  let moduleId: string | null = null;
  let apps: readonly string[] | null = null;
  let application = true;
  try {
    const manifest = parseModuleManifest(input.manifest);
    moduleId = manifest.id;
    apps = manifest.apps;
    application = manifest.application;
  } catch (error) {
    add(
      "manifest-invalid",
      "blocker",
      `lazurio.module.json does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (apps === null && findings.length === 0)
    add(
      "apps-undeclared",
      "blocker",
      "lazurio.module.json must declare apps explicitly (an empty list for a Module without an app).",
    );
  if (apps !== null && apps.length === 0)
    return finish(moduleId, null, "V0", [], [], "no-application");
  const app = input.app;
  // A tool of the Environment says so itself and never becomes an
  // Application: its tile keeps opening STAGING (decision 0249, addendum of
  // 2026-11-22).
  if (findings.length === 0 && !application)
    return finish(
      moduleId,
      app?.package ?? null,
      app === null ? null : generationOf(input),
      [],
      [],
      "no-application",
    );
  if (findings.length > 0 || app === null)
    return finish(moduleId, null, null, findings, hostConditions);
  // Nothing else of an app the start path refuses is read or judged.
  if (app.declarationError !== null) {
    add(
      "declaration-invalid",
      "blocker",
      `The app's declaration is refused by the start path: ${app.declarationError}`,
    );
    return finish(moduleId, app.package, null, findings, hostConditions);
  }
  const generation = generationOf(input);
  const appDir = dirname(app.package);
  const inApp = (name: string) => (appDir === "." ? name : `${appDir}/${name}`);
  // The built version (decision F58): an own server, or a static build.
  if (!app.server && !app.staticBuild)
    add(
      "built-version-missing",
      "blocker",
      "The app runs only its development script: declare start_script (own server) or build_output (static build) in lazurio.runtime.",
    );
  // Data behind a store need a server of the App's own: all access to the
  // data runs there (profile app-data), and so do /mcp and the page tools.
  if ((generation === "V3" || generation === "V4") && !app.server)
    add(
      "data-without-server",
      "blocker",
      "The app keeps records (V3 or V4) but has no server of its own: declare start_script with a Bun.serve server that holds the data port, /mcp and the page tools, and serves the built interface.",
    );
  if (app.staticBuild && !app.server)
    hostConditions.push(
      Object.freeze({
        id: "static-app",
        detail:
          "A static build: the application host must serve static Applications.",
      }),
    );
  // Deep health: a server's health answers whether it can serve, not just
  // that the process listens.
  if (app.server && app.healthPaths.some((path) => path === "/"))
    add(
      "health-shallow",
      "blocker",
      "The server's health path is /: give it its own path that returns 503 until the app's data are open.",
    );
  const pin = app.pkg?.packageManager;
  if (typeof pin !== "string" || !/^bun@\d+\.\d+\.\d+$/.test(pin))
    add(
      "bun-pin",
      "blocker",
      'package.json must pin Bun exactly in packageManager ("bun@x.y.z").',
    );
  // A marker found in the source counts; a missing one counts as absent only
  // when the whole committed source was read. Otherwise it is unknown.
  const sourceKnown = input.tracked !== null && app.sourceSkipped.length === 0;
  const unknownMarkers: { name: string; level: FindingLevel }[] = [];
  const lacks = (marker: RegExp, name: string, level: FindingLevel) => {
    if (marker.test(app.source)) return false;
    if (!sourceKnown) unknownMarkers.push({ name, level });
    return sourceKnown;
  };
  if (app.server) {
    const kit = dependencies(app.pkg)["@lazurio/module-kit"];
    const version = kit === undefined ? null : specVersion(kit);
    if (version === null || !atLeast(version, MODULE_KIT_FLOOR))
      add(
        "module-kit",
        "blocker",
        `The server needs @lazurio/module-kit ${MODULE_KIT_FLOOR.join(".")} or newer (found ${kit ?? "none"}).`,
      );
    if (lacks(/\bapp_?[Aa]ccess\s*\(/, "appAccess", "blocker"))
      add(
        "app-access",
        "blocker",
        "The server never calls appAccess of @lazurio/module-kit: it must check the application role on every request.",
      );
  }
  if (
    (generation === "V3" || generation === "V4") &&
    lacks(
      /LAZURIO_RUNTIME_DATA_WRITER|\bdataWriter\b/,
      "the writer rule",
      "blocker",
    )
  )
    add(
      "writer-guard",
      "blocker",
      "The app never reads LAZURIO_RUNTIME_DATA_WRITER: on the application host it writes only with true, and in a development version only for the entries local and environment.",
    );
  // What Git tracks: committed files, never the working directory.
  if (input.tracked === null)
    add(
      "git-unavailable",
      "live",
      "Git could not list the Module's committed files, so the lockfile, environment files and the markers in the source (appAccess, the writer rule, contract tests) were not checked.",
    );
  else {
    const tracked = input.tracked;
    if (
      !tracked.includes(inApp("bun.lock")) &&
      !tracked.includes(inApp("bun.lockb"))
    )
      add("lockfile", "blocker", "The app has no committed bun.lock.");
    const envFiles = tracked.filter(
      (file) =>
        /(^|\/)\.env[^/]*$/.test(file) && !/(^|\/)\.env\.example$/.test(file),
    );
    if (envFiles.length > 0)
      add(
        "env-file",
        "blocker",
        `Committed environment files (${envFiles.join(", ")}): secrets come from the vault, never from .env files.`,
      );
  }
  for (const slot of app.slots) {
    if (slot.endsWith("/db"))
      hostConditions.push(
        Object.freeze({
          id: "data-sibling",
          detail: `Reads the data of ${slot}: the application host must provide sibling data replicas.`,
        }),
      );
    else
      hostConditions.push(
        Object.freeze({
          id: "api-sibling",
          detail: `Calls the API of ${slot}: the application host must run API siblings.`,
        }),
      );
  }
  // What live use asks for beyond a trial. A release tag is not among them:
  // by default every checked merge to `main` is deployed (decision 0249), and
  // the rollout asks for an approved release where the Organization's mode
  // requires one.
  if (input.tracked !== null && input.workflows.length === 0)
    add(
      "ci-missing",
      "live",
      "The Module has no committed CI workflow in .github/workflows.",
    );
  if (
    app.server &&
    (generation === "V3" || generation === "V4") &&
    lacks(/@lazurio\/module-kit\/(?:tools\/)?testing/, "contract tests", "live")
  )
    add(
      "contract-tests",
      "live",
      "No contract tests over @lazurio/module-kit testing helpers (role list, refusal without a role or without the writer, deep health).",
    );
  // An app that stands on a person's Environment cannot run as an
  // Application until it is changed (decision 0249, addendum of 2026-11-22).
  // Found markers count; none found counts as none only when all of the
  // code that runs was read.
  const environment = environmentDependencies(app.runtimeSource);
  const runtimeKnown =
    input.tracked !== null &&
    !app.sourceSkipped.some(
      (path) => !NOT_RUNTIME.test(path.slice(appPrefix(app.package).length)),
    );
  if (environment.length === 0 && !runtimeKnown)
    unknownMarkers.push({
      name: "a dependency on a person's Environment",
      level: "blocker",
    });
  if (environment.length > 0)
    add(
      "environment-dependency",
      "blocker",
      `The app's code relies on a person's Environment (${environment.join(", ")}), which the application host does not have. Until it is changed it has no PROD and its tile opens STAGING: the Organization's access goes to the Application's server as a secret from the Organization's vault, a person's own access stays with their agent, which writes the result through the Application's MCP server, another Module is a sibling on the host, and the Organization's files reach the server as a read-only copy. A Module that is only a tool of the Environment declares "application": false in lazurio.module.json.`,
    );
  // Unknown evidence keeps the level of the requirement it stands for: an
  // unknown blocker-level marker blocks, an unknown live-only one does not.
  if (unknownMarkers.length > 0 && input.tracked !== null) {
    const level: FindingLevel = unknownMarkers.some(
      (item) => item.level === "blocker",
    )
      ? "blocker"
      : "live";
    const names = unknownMarkers.map((item) => item.name).join(", ");
    const files = app.sourceSkipped.slice(0, 5).join(", ");
    add(
      "source-incomplete",
      level,
      `Not all committed source of the app was read (${files}${app.sourceSkipped.length > 5 ? ", …" : ""}: over ${MAX_BLOB_BYTES / 1024 / 1024} MiB per file or ${MAX_SOURCE_BYTES / 1024 / 1024} MiB in total, or Git could not read it), so whether it has ${names} is unknown. Split oversized source files.`,
    );
  }
  return finish(moduleId, app.package, generation, findings, hostConditions);
}

function finish(
  module: string | null,
  app: string | null,
  generation: Generation | null,
  findings: Finding[],
  hostConditions: HostCondition[],
  verdict?: Verdict,
): Readiness {
  const judged: Verdict =
    verdict ??
    (findings.some((item) => item.level === "blocker")
      ? "not-ready"
      : findings.length > 0
        ? "ready-for-trial"
        : "ready-for-live");
  return Object.freeze({
    schema_version: "lazurio.module-readiness.v1",
    module,
    app,
    generation,
    verdict: judged,
    findings: Object.freeze(findings),
    hostConditions: Object.freeze(hostConditions),
  });
}

// --- Reading the checkout -------------------------------------------------

const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
/** Files that do not run in the App: tests, fixtures, scripts, skills, docs. */
const NOT_RUNTIME =
  /(^|\/)(tests?|__tests__|__mocks__|e2e|fixtures?|test-support|testing|scripts|skills|docs?|seed|migrations)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;

/** What only a person's Environment has, by kind, as markers in code that
 * runs: the person's GitHub sign-in, the Environment's Integrations, the
 * person's files and Folder, and the Organization's network. */
const ENVIRONMENT_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "GitHub sign-in",
    /["'`]gh["'`]\s*[,\]]|\bgh\s+(?:api|pr|issue|repo|auth|release|run|search|workflow)\b|gh auth git-credential|\bhosts\.yml\b/,
  ],
  [
    "Integrations",
    /["'`](?:executor|composio|wacli|gogcli|neonctl)["'`]\s*[,\]]|\b(?:executor|composio|wacli|gogcli)\s+(?:call|execute|tools|send|auth|run|list|search)\b|\blazurio\s+integrations\b/,
  ],
  [
    "files",
    /\bos\.homedir\(|\bhomedir\(\)|process\.env\.HOME\b|Bun\.env\.HOME\b|["'`]~\/|\/organizations\/[A-Za-z]/,
  ],
  [
    "network",
    /\.tailnet\.|\b100\.64\.\d|\b[a-z0-9-]+\.[a-z0-9-]+\.lazurio\.io\b/,
  ],
];

/** The app's directory as a path prefix ("" for an app at the root). */
function appPrefix(appPackage: string): string {
  const appDir = dirname(appPackage);
  return appDir === "." ? "" : `${appDir}/`;
}

/** The kinds of a person's Environment an app's running code relies on. */
export function environmentDependencies(source: string): string[] {
  return ENVIRONMENT_MARKERS.filter(([, pattern]) => pattern.test(source)).map(
    ([kind]) => kind,
  );
}
const SKIPPED =
  /(^|\/)(node_modules|dist|build|\.astro|\.next|\.turbo|coverage|\.venv|__pycache__)\//;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

const MAX_BLOB_BYTES = 1024 * 1024;

type TreeEntry = Readonly<{ mode: string; size: number; path: string }>;

function git(moduleDirectory: string, args: string[], input?: string) {
  return spawnSync("git", args, {
    cwd: moduleDirectory,
    input,
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

/** The committed tree at HEAD (never the index or the working directory),
 * relative to the Module's root; null when Git could not say. */
function committedTree(moduleDirectory: string): TreeEntry[] | null {
  const result = git(moduleDirectory, [
    "ls-tree",
    "-r",
    "-z",
    "--long",
    "HEAD",
  ]);
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  const entries: TreeEntry[] = [];
  for (const record of result.stdout.toString("utf8").split("\0")) {
    const match = /^(\d{6}) (\w+) [0-9a-f]+ +(-|\d+)\t(.+)$/s.exec(record);
    if (!match) continue;
    entries.push({
      mode: match[1] as string,
      size: match[3] === "-" ? -1 : Number(match[3]),
      path: match[4] as string,
    });
  }
  return entries;
}

/** The committed content of regular files at HEAD, read from Git's objects,
 * so a symlink anywhere in the working directory cannot redirect it; bounded
 * per file and in total. */
function committedSource(
  moduleDirectory: string,
  entries: readonly TreeEntry[],
): { files: Map<string, string>; skipped: string[] } {
  const picked: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (
      entry.size < 0 ||
      entry.size > MAX_BLOB_BYTES ||
      total + entry.size > MAX_SOURCE_BYTES
    ) {
      skipped.push(entry.path);
      continue;
    }
    picked.push(entry.path);
    total += entry.size;
  }
  if (picked.length === 0) return { files: new Map(), skipped };
  const result = git(
    moduleDirectory,
    ["cat-file", "--batch"],
    picked.map((path) => `HEAD:./${path}\n`).join(""),
  );
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout))
    return { files: new Map(), skipped: [...skipped, ...picked] };
  const out = result.stdout;
  const files = new Map<string, string>();
  let offset = 0;
  for (const path of picked) {
    const newline = out.indexOf(10, offset);
    if (newline < 0) {
      skipped.push(path);
      continue;
    }
    const header = out.subarray(offset, newline).toString("utf8").split(" ");
    offset = newline + 1;
    if (header[1] !== "blob") {
      skipped.push(path);
      continue;
    }
    const size = Number(header[2]);
    files.set(path, out.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return { files, skipped };
}

export async function readReadinessInput(
  moduleDirectory: string,
  requestedPackage?: string,
): Promise<ReadinessInput> {
  let manifest: unknown = null;
  try {
    manifest = await readCheckoutJson(
      join(moduleDirectory, "lazurio.module.json"),
    );
  } catch {
    // An unreadable manifest is reported as one that does not parse.
    manifest = null;
  }
  const tree = committedTree(moduleDirectory);
  // Regular files only: a symlink or a submodule is no committed file.
  const files =
    tree?.filter((entry) => /^100(644|755)$/.test(entry.mode)) ?? null;
  const tracked = files?.map((entry) => entry.path) ?? null;
  const workflows = (tracked ?? []).filter((file) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file),
  );
  let declared: readonly string[] = [];
  let selected: string | null = null;
  try {
    const parsed = parseModuleManifest(manifest);
    declared = parsed.apps ?? [];
    if (declared.length > 0) selected = requestedPackage ?? parsed.default_app;
  } catch {
    selected = null;
  }
  if (selected === null)
    return Object.freeze({ manifest, app: null, tracked, workflows });
  const refused = (reason: string) =>
    Object.freeze({
      manifest,
      app: Object.freeze({
        package: selected,
        declarationError: reason,
        pkg: null,
        source: "",
        runtimeSource: "",
        sourceSkipped: [],
        server: false,
        staticBuild: false,
        healthPaths: [],
        slots: [],
      }),
      tracked,
      workflows,
    });
  // Only an app the manifest declares is read, and only through the start
  // path's reader, which refuses paths outside the Module and symlinks.
  if (!declared.includes(selected)) return refused("app-not-declared");
  let plan: Awaited<ReturnType<typeof readModuleApplication>>;
  try {
    plan = await readModuleApplication(moduleDirectory, selected);
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
  if (plan.kind !== "declared-runtime-plan")
    return refused(`app selection ${plan.kind}`);
  const declaredSlots = plan.runtime.optional.required_module_slots;
  let pkg: Record<string, unknown> | null = null;
  try {
    const value = await readCheckoutJson(join(moduleDirectory, selected));
    if (value && typeof value === "object" && !Array.isArray(value))
      pkg = value as Record<string, unknown>;
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
  // Source markers come only from committed regular files of the app's own
  // directory, read from Git's objects at HEAD.
  const prefix = appPrefix(selected);
  const appFiles = (files ?? []).filter(
    (entry) =>
      entry.path.startsWith(prefix) &&
      SOURCE.test(entry.path) &&
      !SKIPPED.test(entry.path),
  );
  // One read of the source; the code that runs is the part of it outside
  // tests, fixtures, scripts, skills and docs.
  const { files: sourceFiles, skipped: sourceSkipped } = committedSource(
    moduleDirectory,
    appFiles,
  );
  const source = [...sourceFiles.values()].join("\n");
  const runtimeSource = [...sourceFiles]
    .filter(([path]) => !NOT_RUNTIME.test(path.slice(prefix.length)))
    .map(([, text]) => text)
    .join("\n");
  return Object.freeze({
    manifest,
    app: Object.freeze({
      package: selected,
      declarationError: null,
      pkg,
      source,
      runtimeSource,
      sourceSkipped,
      server: plan.runtime.server !== null,
      staticBuild: plan.runtime.static !== null,
      healthPaths: plan.listeners.flatMap((listener) =>
        listener.health.kind === "http" && "path" in listener.health
          ? [String(listener.health.path)]
          : [],
      ),
      slots: Array.isArray(declaredSlots) ? declaredSlots : [],
    }),
    tracked,
    workflows,
  });
}
