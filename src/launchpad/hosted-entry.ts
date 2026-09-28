// The rules of the handover's `entry` (lazurio.machine.v1, Machines 0.12.93):
// exactly the patterns of the vendored schema, so the recorded binding accepts
// what a valid handover projects and nothing else. Values are finished and
// kept as written; the only composition anywhere is `moduleOrigin`, which
// fills the one `{module}` slot Machines declares with the label the gateway
// serves for the module (docs/hosted-entry.md).

const dnsLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const hostname = `${dnsLabel}(?:\\.${dnsLabel})+`;
const origin = new RegExp(`^https://${hostname}$`);
const authCheck = new RegExp(`^https://${hostname}(?:/[A-Za-z0-9._~-]+)+$`);
const cookieName = /^[A-Za-z0-9_-]{1,128}$/;
const modulePlaceholder = "{module}";
const originTemplate = new RegExp(`^https://\\{module\\}(?:\\.${dnsLabel})+$`);
// The gateway's own constants (Machines workloads/workspace-vm/gateway-catalog.py:
// APPLICATION_MAX and RESERVED).
const applicationMax = 63;
const reserved = new Set(["oauth2", "api", "well-known"]);

/** `https://<hostname>`: no port, path, query or trailing slash. */
export function isHttpsOrigin(value: unknown): value is string {
  return typeof value === "string" && value.length <= 261 && origin.test(value);
}

/** The gateway's auth endpoint: an https hostname with a non-empty path. */
export function isAuthCheckUrl(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 512 && authCheck.test(value)
  );
}

export function isEntryCookieName(value: unknown): value is string {
  return typeof value === "string" && cookieName.test(value);
}

/** The loopback port the gateway proxies the Launchpad to; never privileged. */
export function isEntryPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1024 &&
    value <= 65535
  );
}

/** A module origin rule: `{module}` exactly once, as the whole first label. */
export function isModuleOriginTemplate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 270 &&
    value.split(modulePlaceholder).length === 2 &&
    originTemplate.test(value)
  );
}

export class ModuleOriginError extends Error {
  constructor(
    public readonly code:
      | "module-origin-template-invalid"
      | "module-label-empty"
      | "module-label-reserved"
      | "module-origin-too-long",
  ) {
    super(code);
  }
}

/** The one DNS label the gateway serves a module id at: exactly the gateway
 * catalog's `label()` (Machines gateway-catalog.py, decision 0146). Lowercase;
 * every character outside [a-z0-9] becomes `-`; runs of `-` collapse to one;
 * leading and trailing `-` are stripped; the result is cut to the gateway's
 * maximum label length and a trailing `-` stripped again. An empty result or
 * a name the gateway reserves for itself is refused. */
export function moduleLabel(moduleId: string): string {
  // Not a string is no label at all, as `label()` answers None for it.
  if (typeof moduleId !== "string")
    throw new ModuleOriginError("module-label-empty");
  const label = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, applicationMax)
    .replace(/-+$/, "");
  if (label === "") throw new ModuleOriginError("module-label-empty");
  if (reserved.has(label)) throw new ModuleOriginError("module-label-reserved");
  return label;
}

/** The origin of one module: the declared template with the gateway's label
 * of the module id in its one `{module}` slot. The template states the rule;
 * the gateway's catalog decides whether that hostname is actually served. */
export function moduleOrigin(template: string, moduleId: string): string {
  if (!isModuleOriginTemplate(template))
    throw new ModuleOriginError("module-origin-template-invalid");
  const result = template.replace(modulePlaceholder, moduleLabel(moduleId));
  // A hostname longer than DNS allows is no origin of anything.
  if (result.length - "https://".length > 253)
    throw new ModuleOriginError("module-origin-too-long");
  return result;
}
