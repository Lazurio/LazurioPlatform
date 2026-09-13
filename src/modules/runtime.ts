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
    optional: Object.freeze(optional),
  });
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
  const script = Object.getOwnPropertyDescriptor(scripts, runtime.dev_script);
  if (
    !script ||
    !("value" in script) ||
    typeof script.value !== "string" ||
    !script.value.trim()
  )
    throw new Error("Declared development script missing");
  const listeners = runtime.listeners.map((listener) => {
    const lease = module.port_leases.find((item) => item.id === listener.lease);
    if (!lease) throw new Error("Runtime references unknown module lease");
    return Object.freeze({ ...listener, host: lease.host, port: lease.port });
  });
  return Object.freeze({
    kind: "declared-runtime-plan" as const,
    package: packagePath,
    scriptDigest: createHash("sha256").update(script.value).digest("hex"),
    runtime,
    listeners: Object.freeze(listeners),
  });
}
