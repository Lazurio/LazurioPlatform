import { join } from "node:path";
import type { readModuleApplication } from "./read-application";

type Plan = Extract<
  Awaited<ReturnType<typeof readModuleApplication>>,
  { kind: "declared-runtime-plan" }
>;

/** The name part of a listener's variables: the id upper-cased, anything but
 * a letter or digit as `_` (the listener grammar allows only `-`). */
export function listenerVariableKey(id: string) {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** The environment of every process the Platform starts for a module (its
 * install, its check and preparation scripts, the application): the closed
 * one its owner passes, with Bun's runtime auto-install off (decision F25,
 * addendum of 2026-10-07; issue #254). A Bun process that finds no
 * node_modules in its directory or above otherwise fetches a package the
 * module imports without declaring it from the registry while it runs,
 * unpinned. Bun hands `BUN_OPTIONS` to every bun a script starts, and
 * `--no-install` there outranks the module's own bunfig.toml and its own
 * command line; it changes nothing where node_modules exists, and `bun
 * install` installs as before. It follows whatever options the environment
 * already passes, which stay as they are. */
export function moduleProcessEnvironment(
  base: Readonly<Record<string, string>>,
): Record<string, string> {
  const options = base.BUN_OPTIONS?.trim() ?? "";
  return {
    ...base,
    BUN_OPTIONS: options.split(/\s+/).includes("--no-install")
      ? options
      : `${options} --no-install`.trim(),
  };
}

// The environment of a started application (decision F26): the names and
// values the replaced Launchpad gave a declared runtime, so that a module
// written for it runs unchanged (`R:lazurio/runtime/runtime-lib.mjs:703-722`
// the start, `:2080-2135` `runtimeProcessEnv` and `listenerRuntimeEnv`,
// `:130-143` `runtimeListenerState`; `R:lazurio/core/runtime-contract-lib.mjs:60-78`
// `runtimeListenerEnvironmentNames`). It is built on the closed
// `base` the owner passes (HOME, PATH, optional TMPDIR, and BUN_OPTIONS from
// `moduleProcessEnvironment`) and nothing else: no
// ambient HOST, PORT, NODE_PATH or LAZURIO_RUNTIME_* can reach it, because
// nothing ambient is read. Every value is derived from the declaration, the
// application's directory, its Organization root and its external origin.
export function applicationEnvironment(input: {
  base: Readonly<Record<string, string>>;
  plan: Pick<Plan, "runtime" | "listeners">;
  /** The application's own directory (its package), the working directory. */
  cwd: string;
  /** The Organization root; none for a Personalspace module. */
  organizationRoot?: string | undefined;
  /** The browser origin of the entrypoint on a hosted Machine: exactly
   * `runtime.url` without its slash. None on a workstation. */
  externalOrigin?: string | null | undefined;
}): Record<string, string> {
  const { runtime, listeners } = input.plan;
  const entrypoint = listeners.find(
    (listener) => listener.role === "entrypoint",
  );
  if (!entrypoint) throw new Error("Exactly one entrypoint required");
  const origin = input.externalOrigin ?? null;
  const environment: Record<string, string> = {
    ...input.base,
    // The declared development task, whatever mode the parent runs in.
    NODE_ENV: "development",
    // Astro 7 backgrounds its dev and preview servers when it detects an
    // agent; the owner supervises the process, so it must stay attached.
    ASTRO_DEV_BACKGROUND: "1",
    ASTRO_PREVIEW_BACKGROUND: "1",
    // The application's declared dependencies as the one fallback for module
    // and sibling config sources outside its package, never a Machine path.
    NODE_PATH: join(input.cwd, "node_modules"),
    ...(input.organizationRoot === undefined
      ? {}
      : { COMPANYASCODE_ORGANIZATION_ROOT: input.organizationRoot }),
    // The module's own checkout is the only source (no worktree yet, P9).
    COMPANYASCODE_APP_ID: runtime.id,
    COMPANYASCODE_RUNTIME_KEY: runtime.id,
    COMPANYASCODE_RUNTIME_SOURCE: "main",
    LAZURIO_RUNTIME_SCHEMA_VERSION: runtime.schema_version,
    LAZURIO_RUNTIME_APP_ID: runtime.id,
    LAZURIO_RUNTIME_ENTRYPOINT_ID: entrypoint.id,
    LAZURIO_RUNTIME_HOST: entrypoint.host,
    LAZURIO_RUNTIME_PORT: String(entrypoint.port),
  };
  const state = listeners.map((listener) => ({
    id: listener.id,
    role: listener.role,
    allocation: "static",
    host: listener.host,
    port: listener.port,
    protocol: listener.protocol,
    health: listener.health,
    claim: { mode: "exclusive" },
    // Only the entrypoint is served at the origin; other listeners stay
    // loopback-only, and without an origin the field is absent.
    ...(origin !== null && listener === entrypoint
      ? { external_origin: origin }
      : {}),
  }));
  for (const listener of listeners) {
    const key = listenerVariableKey(listener.id);
    environment[`LAZURIO_RUNTIME_LISTENER_${key}_HOST`] = listener.host;
    environment[`LAZURIO_RUNTIME_LISTENER_${key}_PORT`] = String(listener.port);
  }
  if (origin !== null) {
    environment[
      `LAZURIO_RUNTIME_LISTENER_${listenerVariableKey(entrypoint.id)}_EXTERNAL_ORIGIN`
    ] = origin;
    environment.LAZURIO_RUNTIME_EXTERNAL_ORIGIN = origin;
  }
  environment.LAZURIO_RUNTIME_LISTENERS_JSON = JSON.stringify(state);
  return environment;
}
