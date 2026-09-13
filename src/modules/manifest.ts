// New TypeScript reader of the existing lazurio.module.v1 wire contract.
// Provenance and compatibility boundaries: docs/module-adoption.md.
function object(input: unknown, required: string[], optional: string[] = []) {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid module object");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || ![...required, ...optional].includes(key))
      throw new Error("Unknown module field");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error("Executable module field");
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key)))
    throw new Error("Missing module field");
  return result;
}

function text(input: unknown, pattern: RegExp) {
  if (
    typeof input !== "string" ||
    /[\r\n\0]/.test(input) ||
    !pattern.test(input)
  )
    throw new Error("Invalid module string");
  return input;
}

function array(input: unknown): unknown[] {
  if (
    !Array.isArray(input) ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error("Invalid module array");
  const values: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor))
      throw new Error("Sparse or executable module array");
    values.push(descriptor.value);
  }
  return values;
}

export function parseModuleManifest(input: unknown) {
  const value = object(
    input,
    ["schema_version", "id", "company", "tcp_port_policy", "port_leases"],
    ["apps", "default_app"],
  );
  if (value.schema_version !== "lazurio.module.v1")
    throw new Error("Unsupported module schema");
  const id = text(value.id, /^[a-z0-9][a-z0-9-]*$/);
  const company = text(value.company, /^[A-Za-z0-9][A-Za-z0-9-]*$/);
  const policy = object(value.tcp_port_policy, ["mode"], ["reason"]);
  if (
    typeof policy.mode !== "string" ||
    !["none", "single", "exception"].includes(policy.mode)
  )
    throw new Error("Invalid port policy");
  if (policy.mode === "exception") {
    if (typeof policy.reason !== "string" || policy.reason.length < 20)
      throw new Error("Port exception reason required");
  } else if (Object.hasOwn(policy, "reason"))
    throw new Error("Unexpected port policy reason");
  const ids = new Set<string>();
  const ports = new Set<number>();
  const leases = array(value.port_leases).map((input: unknown) => {
    const lease = object(input, ["id", "host", "port"]);
    const id = text(lease.id, /^[a-z][a-z0-9-]*$/);
    if (
      lease.host !== "127.0.0.1" &&
      lease.host !== "localhost" &&
      lease.host !== "::1"
    )
      throw new Error("Non-loopback module lease");
    if (
      typeof lease.port !== "number" ||
      !Number.isInteger(lease.port) ||
      lease.port < 1024 ||
      lease.port > 65535
    )
      throw new Error("Invalid lease port");
    if (ids.has(id) || ports.has(lease.port))
      throw new Error("Duplicate module lease");
    ids.add(id);
    ports.add(lease.port);
    return Object.freeze({ id, host: lease.host, port: lease.port });
  });
  if (policy.mode === "none" && leases.length !== 0)
    throw new Error("No-port module has leases");
  if (
    policy.mode === "single" &&
    (leases.length !== 1 || leases[0]?.id !== "main")
  )
    throw new Error("Single main lease required");
  if (policy.mode === "exception" && leases.length < 2)
    throw new Error("Multiple exception leases required");
  let apps: readonly string[] | null = null;
  let defaultApp: string | null = null;
  if (Object.hasOwn(value, "apps")) {
    const parsed = array(value.apps).map((path: unknown) =>
      text(path, /^(?:(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)*package\.json$/),
    );
    if (new Set(parsed).size !== parsed.length)
      throw new Error("Duplicate app declaration");
    apps = Object.freeze(parsed);
    if (apps.length > 0) {
      if (
        typeof value.default_app !== "string" ||
        !apps.includes(value.default_app)
      )
        throw new Error("Declared default app required");
      defaultApp = value.default_app;
    } else if (Object.hasOwn(value, "default_app"))
      throw new Error("Empty module cannot have a default app");
  } else if (Object.hasOwn(value, "default_app"))
    throw new Error("Default app requires explicit apps");
  if ((policy.mode === "none") !== (apps !== null && apps.length === 0))
    throw new Error("No-app and no-port policy mismatch");
  return Object.freeze({
    schema_version: "lazurio.module.v1" as const,
    id,
    company,
    tcp_port_policy: Object.freeze({
      mode: policy.mode as "none" | "single" | "exception",
      ...(policy.mode === "exception"
        ? { reason: policy.reason as string }
        : {}),
    }),
    port_leases: Object.freeze(leases),
    apps,
    default_app: defaultApp,
    app_declaration_state:
      apps === null ? ("legacy-missing" as const) : ("explicit" as const),
  });
}

// Selection is declarative, never permission to execute a package or seize a port.
export function selectModuleApplication(
  input: unknown,
  requestedPackage?: string,
) {
  const module = parseModuleManifest(input);
  if (module.apps === null)
    return { kind: "blocked", reason: "explicit-apps-required" } as const;
  if (module.apps.length === 0) return { kind: "no-app" } as const;
  const selected = requestedPackage ?? module.default_app;
  if (selected === null || !module.apps.includes(selected))
    return { kind: "blocked", reason: "app-not-declared" } as const;
  return {
    kind: "selected",
    company: module.company,
    module: module.id,
    package: selected,
  } as const;
}
