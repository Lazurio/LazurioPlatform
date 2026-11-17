import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readCheckoutJson } from "../providers/owned-json";
import { parseModuleManifest } from "./manifest";
import { readModuleApplication } from "./read-application";

/** Whether a Module is ready as an Application (decision 0249, issue #423):
 * the static half of the check, read from the checkout without running
 * anything or using the network. The runtime half is the Module's own
 * contract tests in its CI over `@lazurio/module-kit` testing helpers, which
 * this check asks for; the live probe of a deployed Application's gateway
 * belongs to the rollout. It measures and reports and changes nothing
 * (decision 0173): an agent fixes the findings in the Module. */

export type Generation = "V0" | "V1" | "V2" | "V3" | "V4";
export type Verdict =
  | "no-application"
  | "not-ready"
  | "ready-for-trial"
  | "ready-for-live";

/** `blocker`: the Application cannot run from this Module. `live`: it may run
 * as a trial, not for people's real work. */
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
  /** Null when the Module has no app, or the selected app could not be read. */
  app: Readonly<{
    package: string;
    /** The error the start path's reader raised, or null. */
    declarationError: string | null;
    pkg: Readonly<Record<string, unknown>> | null;
    /** Repository-relative files of the app's package directory, build
     * outputs and dependencies excluded. */
    files: readonly string[];
    /** Concatenated source text of the app (bounded), for markers only. */
    source: string;
    /** Whether the plan the start path makes has an own server or a static
     * build, and the health paths of its HTTP listeners. */
    server: boolean;
    staticBuild: boolean;
    healthPaths: readonly string[];
    slots: readonly string[];
  }> | null;
  /** Repository-relative files at the Module's root level that matter. */
  rootFiles: readonly string[];
  workflows: readonly string[];
  /** Tags that point at the checkout's HEAD; null when Git could not say. */
  tagsAtHead: readonly string[] | null;
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

/** Where the data are (decision 0249): the generation of the selected app. */
export function generationOf(input: ReadinessInput): Generation {
  if (input.app === null) return "V0";
  const deps = dependencies(input.app.pkg);
  if (input.app.package.startsWith("app/v4/") || "mysql2" in deps) return "V4";
  if ("@lazurio/repository-db" in deps) return "V3";
  if (
    input.app.package.startsWith("app/v2/") ||
    input.rootFiles.some(
      (file) => file === "data/v2" || file.startsWith("data/v2/"),
    )
  )
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
  try {
    const manifest = parseModuleManifest(input.manifest);
    moduleId = manifest.id;
    apps = manifest.apps;
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
    return Object.freeze({
      schema_version: "lazurio.module-readiness.v1",
      module: moduleId,
      app: null,
      generation: "V0",
      verdict: "no-application",
      findings: Object.freeze([]),
      hostConditions: Object.freeze([]),
    });
  const app = input.app;
  if (findings.length > 0 || app === null)
    return finish(moduleId, null, null, findings, hostConditions);
  const generation = generationOf(input);
  if (app.declarationError !== null)
    add(
      "declaration-invalid",
      "blocker",
      `The app's declaration is refused by the start path: ${app.declarationError}`,
    );
  // The built version (decision F58): an own server, or a static build.
  if (!app.server && !app.staticBuild)
    add(
      "built-version-missing",
      "blocker",
      "The app runs only its development script: declare start_script (own server) or build_output (static build) in lazurio.runtime.",
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
  const appDir = dirname(app.package);
  const lockfile = (name: string) =>
    app.files.includes(appDir === "." ? name : `${appDir}/${name}`);
  if (!lockfile("bun.lock") && !lockfile("bun.lockb"))
    add("lockfile", "blocker", "The app has no committed bun.lock.");
  if (app.server) {
    const kit = dependencies(app.pkg)["@lazurio/module-kit"];
    const version = kit === undefined ? null : specVersion(kit);
    if (version === null || !atLeast(version, MODULE_KIT_FLOOR))
      add(
        "module-kit",
        "blocker",
        `The server needs @lazurio/module-kit ${MODULE_KIT_FLOOR.join(".")} or newer (found ${kit ?? "none"}).`,
      );
    if (!/\bapp_?[Aa]ccess\s*\(/.test(app.source))
      add(
        "app-access",
        "blocker",
        "The server never calls appAccess of @lazurio/module-kit: it must check the application role on every request.",
      );
  }
  if (
    (generation === "V3" || generation === "V4") &&
    !/LAZURIO_RUNTIME_DATA_WRITER|\bdataWriter\b/.test(app.source)
  )
    add(
      "writer-guard",
      "blocker",
      "The app never reads LAZURIO_RUNTIME_DATA_WRITER: on the application host it writes only with true, and in a development version only for the entries local and environment.",
    );
  const envFiles = [...input.rootFiles, ...app.files].filter((file) =>
    /(^|\/)\.env(\.(?!example$)[^/]+)?$/.test(file),
  );
  if (envFiles.length > 0)
    add(
      "env-file",
      "blocker",
      `Committed environment files (${envFiles.join(", ")}): secrets come from the vault, never from .env files.`,
    );
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
  // What live use asks for beyond a trial.
  if (input.workflows.length === 0)
    add(
      "ci-missing",
      "live",
      "The Module has no CI workflow in .github/workflows.",
    );
  if (
    app.server &&
    (generation === "V3" || generation === "V4") &&
    !/@lazurio\/module-kit\/(?:tools\/)?testing/.test(app.source)
  )
    add(
      "contract-tests",
      "live",
      "No contract tests over @lazurio/module-kit testing helpers (role list, refusal without a role or without the writer, deep health).",
    );
  if (input.tagsAtHead !== null && input.tagsAtHead.length === 0)
    add(
      "release-tag",
      "live",
      "The checked-out commit carries no release tag.",
    );
  return finish(moduleId, app.package, generation, findings, hostConditions);
}

function finish(
  module: string | null,
  app: string | null,
  generation: Generation | null,
  findings: Finding[],
  hostConditions: HostCondition[],
): Readiness {
  const verdict: Verdict = findings.some((item) => item.level === "blocker")
    ? "not-ready"
    : findings.length > 0
      ? "ready-for-trial"
      : "ready-for-live";
  return Object.freeze({
    schema_version: "lazurio.module-readiness.v1",
    module,
    app,
    generation,
    verdict,
    findings: Object.freeze(findings),
    hostConditions: Object.freeze(hostConditions),
  });
}

// --- Reading the checkout -------------------------------------------------

const SKIPPED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".astro",
  ".next",
  ".turbo",
  "coverage",
  ".venv",
  "__pycache__",
  "db",
]);
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/;
const MAX_FILES = 4000;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

async function listFiles(root: string, relative: string, out: string[]) {
  if (out.length >= MAX_FILES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) await listFiles(root, path, out);
    } else if (entry.isFile()) out.push(path);
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function tagsAt(moduleDirectory: string): string[] | null {
  const result = spawnSync("git", ["tag", "--points-at", "HEAD"], {
    cwd: moduleDirectory,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter((line) => line.trim() !== "");
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
  const rootFiles: string[] = [];
  for (const name of [".env", ".env.local", ".env.production", ".env.example"])
    if (await exists(join(moduleDirectory, name))) rootFiles.push(name);
  if (await exists(join(moduleDirectory, "data/v2"))) rootFiles.push("data/v2");
  const workflowFiles: string[] = [];
  await listFiles(moduleDirectory, ".github/workflows", workflowFiles);
  const workflows = workflowFiles.filter((file) => /\.ya?ml$/.test(file));
  let app: ReadinessInput["app"] = null;
  let selected: string | null = null;
  try {
    const parsed = parseModuleManifest(manifest);
    if (parsed.apps !== null && parsed.apps.length > 0)
      selected = requestedPackage ?? parsed.default_app;
  } catch {
    selected = null;
  }
  if (selected !== null) {
    let declarationError: string | null = null;
    let server = false;
    let staticBuild = false;
    let healthPaths: string[] = [];
    let slots: readonly string[] = [];
    try {
      const plan = await readModuleApplication(moduleDirectory, selected);
      if (plan.kind !== "declared-runtime-plan")
        declarationError = `app selection ${plan.kind}`;
      else {
        server = plan.runtime.server !== null;
        staticBuild = plan.runtime.static !== null;
        healthPaths = plan.listeners.flatMap((listener) =>
          listener.health.kind === "http" && "path" in listener.health
            ? [String(listener.health.path)]
            : [],
        );
        const declared = plan.runtime.optional.required_module_slots;
        slots = Array.isArray(declared) ? declared : [];
      }
    } catch (error) {
      declarationError = error instanceof Error ? error.message : String(error);
    }
    let pkg: Record<string, unknown> | null = null;
    try {
      const value = await readCheckoutJson(join(moduleDirectory, selected));
      if (value && typeof value === "object" && !Array.isArray(value))
        pkg = value as Record<string, unknown>;
    } catch {
      pkg = null;
    }
    const appDir = dirname(selected);
    const files: string[] = [];
    await listFiles(moduleDirectory, appDir === "." ? "" : appDir, files);
    let source = "";
    for (const file of files) {
      if (!SOURCE.test(file) || source.length > MAX_SOURCE_BYTES) continue;
      try {
        source += `\n${await readFile(join(moduleDirectory, file), "utf8")}`;
      } catch {
        // An unreadable file is no marker; the start path reports it.
      }
    }
    app = Object.freeze({
      package: selected,
      declarationError,
      pkg,
      files,
      source,
      server,
      staticBuild,
      healthPaths,
      slots,
    });
  }
  return Object.freeze({
    manifest,
    app,
    rootFiles,
    workflows,
    tagsAtHead: tagsAt(moduleDirectory),
  });
}
