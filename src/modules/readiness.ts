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
    server: boolean;
    staticBuild: boolean;
    healthPaths: readonly string[];
    slots: readonly string[];
  }> | null;
  /** Files Git tracks in the Module, relative to its root; null when Git
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
    return finish(moduleId, null, "V0", [], [], "no-application");
  const app = input.app;
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
  if (app.server) {
    const kit = dependencies(app.pkg)["@lazurio/module-kit"];
    const version = kit === undefined ? null : specVersion(kit);
    if (version === null || !atLeast(version, MODULE_KIT_FLOOR))
      add(
        "module-kit",
        "blocker",
        `The server needs @lazurio/module-kit ${MODULE_KIT_FLOOR.join(".")} or newer (found ${kit ?? "none"}).`,
      );
    if (input.tracked !== null && !/\bapp_?[Aa]ccess\s*\(/.test(app.source))
      add(
        "app-access",
        "blocker",
        "The server never calls appAccess of @lazurio/module-kit: it must check the application role on every request.",
      );
  }
  if (
    input.tracked !== null &&
    (generation === "V3" || generation === "V4") &&
    !/LAZURIO_RUNTIME_DATA_WRITER|\bdataWriter\b/.test(app.source)
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
    const envFiles = tracked.filter((file) =>
      /(^|\/)\.env(\.(?!example$)[^/]+)?$/.test(file),
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
  if (input.workflows.length === 0)
    add(
      "ci-missing",
      "live",
      "The Module has no CI workflow in .github/workflows.",
    );
  if (
    input.tracked !== null &&
    app.server &&
    (generation === "V3" || generation === "V4") &&
    !/@lazurio\/module-kit\/(?:tools\/)?testing/.test(app.source)
  )
    add(
      "contract-tests",
      "live",
      "No contract tests over @lazurio/module-kit testing helpers (role list, refusal without a role or without the writer, deep health).",
    );
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
const SKIPPED =
  /(^|\/)(node_modules|dist|build|\.astro|\.next|\.turbo|coverage|\.venv|__pycache__)\//;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

function gitFiles(moduleDirectory: string): string[] | null {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: moduleDirectory,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.split("\0").filter((file) => file !== "");
}

async function workflowFiles(moduleDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(join(moduleDirectory, ".github/workflows"), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => `.github/workflows/${entry.name}`);
  } catch {
    return [];
  }
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
  const tracked = gitFiles(moduleDirectory);
  const workflows = await workflowFiles(moduleDirectory);
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
  // Source markers come only from tracked files of the app's own directory,
  // which Git lists inside the Module and never through a symlink.
  const appDir = dirname(selected);
  const prefix = appDir === "." ? "" : `${appDir}/`;
  let source = "";
  for (const file of tracked ?? []) {
    if (
      !file.startsWith(prefix) ||
      !SOURCE.test(file) ||
      SKIPPED.test(file) ||
      source.length > MAX_SOURCE_BYTES
    )
      continue;
    try {
      const path = join(moduleDirectory, file);
      if (!(await lstat(path)).isFile()) continue;
      source += `\n${await readFile(path, "utf8")}`;
    } catch {
      // An unreadable file is no marker; the start path reports it.
    }
  }
  return Object.freeze({
    manifest,
    app: Object.freeze({
      package: selected,
      declarationError: null,
      pkg,
      source,
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
