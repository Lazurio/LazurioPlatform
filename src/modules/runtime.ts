import { createHash } from "node:crypto";
import {
  array,
  object,
  parseModuleManifest,
  selectModuleApplication,
  text,
} from "./manifest";

// Existing lazurio.runtime.v1 declaration, not an executable command or rights grant.
export function parseAppRuntime(input: unknown) {
  const value = object(
    input,
    [
      "schema_version",
      "id",
      "title",
      "company",
      "module",
      "surface",
      "dev_script",
      "tags",
      "listeners",
    ],
    [
      "preview_script",
      "build_script",
      "required_module_slots",
      "plugin",
      "icon",
      "description",
      "group",
      "production_url",
      "secrets",
      "optional_secrets",
      "build_output",
      "static_fallback",
      "start_script",
    ],
  );
  if (value.schema_version !== "lazurio.runtime.v1")
    throw new Error("Unsupported app runtime");
  const id = text(value.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  const title = text(value.title, /\S/);
  const company = text(value.company, /^[A-Za-z0-9][A-Za-z0-9-]*$/);
  const module = text(value.module, /^[a-z0-9][a-z0-9-]*$/);
  const surface = text(
    value.surface,
    /^(internal|manual|admin|public-preview)$/,
  );
  const devScript = text(value.dev_script, /\S/);
  const tags = Object.freeze(
    array(value.tags).map((tag) => text(tag, /^[a-z0-9][a-z0-9-]*$/)),
  );
  const optional: Record<string, string | readonly string[]> =
    Object.create(null);
  for (const key of [
    "preview_script",
    "build_script",
    "plugin",
    "icon",
    "description",
    "group",
    "production_url",
  ]) {
    if (!Object.hasOwn(value, key)) continue;
    const item = text(
      value[key],
      key === "plugin"
        ? /\.json$/
        : key === "production_url"
          ? /^https?:\/\//
          : /\S/,
    );
    if (
      (key === "description" && item.length > 240) ||
      (key === "group" && item.length > 80)
    )
      throw new Error("App metadata too long");
    optional[key] = item;
  }
  if (Object.hasOwn(value, "required_module_slots")) {
    const slots = array(value.required_module_slots).map((slot) =>
      text(slot, /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/),
    );
    if (!slots.length || new Set(slots).size !== slots.length)
      throw new Error("Invalid required module slots");
    optional.required_module_slots = Object.freeze(slots);
  }
  const secrets = secretNames(value, "secrets");
  const optionalSecrets = secretNames(value, "optional_secrets");
  if (optionalSecrets.some((name) => secrets.includes(name)))
    throw new Error("Runtime secret declared required and optional");
  const listenerIds = new Set<string>();
  const leaseIds = new Set<string>();
  const listeners = array(value.listeners).map((input) => {
    const listener = object(input, [
      "id",
      "role",
      "lease",
      "protocol",
      "health",
    ]);
    const id = text(listener.id, /^[a-z][a-z0-9-]*$/);
    const lease = text(listener.lease, /^[a-z][a-z0-9-]*$/);
    const role = text(listener.role, /^(entrypoint|auxiliary)$/);
    const protocol = text(listener.protocol, /^(http|https|tcp)$/);
    if (listenerIds.has(id) || leaseIds.has(lease))
      throw new Error("Duplicate runtime listener or lease reference");
    listenerIds.add(id);
    leaseIds.add(lease);
    const health = object(listener.health, ["kind"], ["path"]);
    let parsedHealth: Readonly<
      { kind: "http"; path: string } | { kind: "tcp" }
    >;
    if (health.kind === "http") {
      const path = text(health.path, /^\//);
      // A health path must never replace the bound loopback origin when resolved.
      if (
        protocol === "tcp" ||
        path.startsWith("//") ||
        path.includes("\\") ||
        new URL(path, "https://runtime.invalid").origin !==
          "https://runtime.invalid"
      )
        throw new Error("Unsafe HTTP health path or protocol");
      parsedHealth = Object.freeze({ kind: "http", path });
    } else if (health.kind === "tcp" && !Object.hasOwn(health, "path"))
      parsedHealth = Object.freeze({ kind: "tcp" });
    else throw new Error("Unsupported runtime health check");
    if (role === "entrypoint" && protocol === "tcp")
      throw new Error("Entrypoint must be HTTP(S)");
    return Object.freeze({ id, lease, role, protocol, health: parsedHealth });
  });
  if (listeners.filter((item) => item.role === "entrypoint").length !== 1)
    throw new Error("Exactly one entrypoint required");
  const start = Object.hasOwn(value, "start_script")
    ? text(value.start_script, /\S/)
    : null;
  const built =
    start === null
      ? staticOutput(value, listeners, secrets, optionalSecrets)
      : null;
  return Object.freeze({
    schema_version: "lazurio.runtime.v1" as const,
    id,
    title,
    company,
    module,
    surface,
    dev_script: devScript,
    tags,
    listeners: Object.freeze(listeners),
    /** The names of the secrets the app needs at start (root decision 0177,
     * decision F46): read from the Environment vault before every start and
     * passed as `LAZURIO_RUNTIME_SECRET_<NAME>`; without one it does not
     * start. Names only, never values; empty when none are declared. */
    secrets,
    /** The names of the secrets the app can use when the Environment holds
     * them (root decision 0196, decision F46): passed like `secrets` when
     * their item is there, otherwise the app starts without the variable. */
    optional_secrets: optionalSecrets,
    /** The app's static output (root decision 0195 point 19, decision F58):
     * its `build_script` writes `output`, a directory of its package, which
     * the Platform keeps per commit outside the checkout and serves itself.
     * Null for an app that runs its development script only, or its own
     * server (`server`). */
    static: built,
    /** The app's own server (decision F58, addendum of 2026-10-21; root
     * decision 0195 point 24): from `main` it runs `start_script`, one
     * process in production mode, and its client, when it declares
     * `build_output`, is built as a static app's is and handed to it.
     * Null for an app without `start_script`. */
    server: start === null ? null : serverRun(value, start),
    optional: Object.freeze(optional),
  });
}

/** The grammar of `build_output`: a directory of the app's package, named by
 * plain relative segments, never `.`/`..`, absolute or with a backslash. */
const outputSegment = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// `build_output` and `static_fallback` (decision F58). A static app is served
// by the Platform's own static server, one HTTP listener with an HTTP health
// path and nothing of the app running on the server: so it declares exactly
// one listener and no runtime secrets, which would otherwise reach a process
// that never reads them or be baked into public files.
function staticOutput(
  value: Record<string, unknown>,
  listeners: readonly Readonly<{
    protocol: string;
    health: Readonly<{ kind: string }>;
  }>[],
  secrets: readonly string[],
  optionalSecrets: readonly string[],
) {
  const declared = Object.hasOwn(value, "build_output");
  if (!declared) {
    if (Object.hasOwn(value, "static_fallback"))
      throw new Error("Static fallback without build output");
    return null;
  }
  const output = buildOutput(value);
  const fallback = Object.hasOwn(value, "static_fallback")
    ? text(value.static_fallback, /^(404|spa)$/)
    : "404";
  const [listener] = listeners;
  if (
    listeners.length !== 1 ||
    listener?.protocol !== "http" ||
    listener.health.kind !== "http"
  )
    throw new Error("Static app requires one HTTP listener");
  if (secrets.length > 0 || optionalSecrets.length > 0)
    throw new Error("Static app declares runtime secrets");
  return Object.freeze({
    build_script: text(value.build_script, /\S/),
    output,
    fallback: fallback as "404" | "spa",
  });
}

// `build_output`: a directory of the app's package its `build_script`
// writes (decision F58).
function buildOutput(value: Record<string, unknown>) {
  const output = text(value.build_output, /\S/);
  const segments = output.split("/");
  if (
    output.length > 200 ||
    !segments.every((segment) => outputSegment.test(segment))
  )
    throw new Error("Invalid build output");
  if (!Object.hasOwn(value, "build_script"))
    throw new Error("Build output without build script");
  return output;
}

// `start_script` (decision F58, addendum of 2026-10-21): the app's own
// process, which gets its listeners, secrets and siblings as its development
// run does, so a client it declares (`build_output`) is bound by neither the
// one-listener nor the no-secrets rule of a static app; only its build runs
// without them. It routes its own requests: `static_fallback` would mean
// nothing.
function serverRun(value: Record<string, unknown>, start: string) {
  if (Object.hasOwn(value, "static_fallback"))
    throw new Error("Static fallback of an app with its own server");
  return Object.freeze({
    start_script: start,
    /** Its client: built from `main` as a static app's output is; null for
     * a server without one. */
    build: Object.hasOwn(value, "build_output")
      ? Object.freeze({
          output: buildOutput(value),
          build_script: text(value.build_script, /\S/),
        })
      : null,
  });
}

/** The grammar of a runtime secret's name (root decision 0177): it is the
 * vault item's name and the suffix of `LAZURIO_RUNTIME_SECRET_<NAME>`. */
export const runtimeSecretName = /^[A-Z][A-Z0-9_]*$/;

// `secrets` or `optional_secrets`: absent, or a non-empty array of unique
// names of the grammar above; anything else refuses the declaration.
function secretNames(
  value: Record<string, unknown>,
  key: "secrets" | "optional_secrets",
): readonly string[] {
  if (!Object.hasOwn(value, key)) return Object.freeze([]);
  const names = array(value[key]).map((name) => text(name, runtimeSecretName));
  if (!names.length || new Set(names).size !== names.length)
    throw new Error("Invalid runtime secrets");
  return Object.freeze(names);
}

export function planModuleRuntime(
  moduleInput: unknown,
  runtimeInput: unknown,
  packagePath: string,
  scripts: unknown,
) {
  const module = parseModuleManifest(moduleInput);
  const selection = selectModuleApplication(moduleInput, packagePath);
  if (selection.kind !== "selected")
    throw new Error("Explicit declared application required");
  const runtime = parseAppRuntime(runtimeInput);
  if (runtime.company !== module.company || runtime.module !== module.id)
    throw new Error("Runtime module identity mismatch");
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts))
    throw new Error("Package scripts required");
  // The command of one of the package's scripts, or null.
  const command = (name: string) => {
    const script = Object.getOwnPropertyDescriptor(scripts, name);
    return script &&
      "value" in script &&
      typeof script.value === "string" &&
      script.value.trim()
      ? script.value
      : null;
  };
  const script = command(runtime.dev_script);
  if (script === null) throw new Error("Declared development script missing");
  // A built app's build and start scripts are its package's scripts too.
  const build =
    runtime.static?.build_script ?? runtime.server?.build?.build_script;
  if (build !== undefined && command(build) === null)
    throw new Error("Declared build script missing");
  if (runtime.server !== null && command(runtime.server.start_script) === null)
    throw new Error("Declared start script missing");
  const listeners = runtime.listeners.map((listener) => {
    const lease = module.port_leases.find((item) => item.id === listener.lease);
    if (!lease) throw new Error("Runtime references unknown module lease");
    return Object.freeze({ ...listener, host: lease.host, port: lease.port });
  });
  return Object.freeze({
    kind: "declared-runtime-plan" as const,
    package: packagePath,
    scriptDigest: createHash("sha256").update(script).digest("hex"),
    runtime,
    listeners: Object.freeze(listeners),
  });
}
