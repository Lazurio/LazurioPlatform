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
// The gateway's rule for the first label of a module hostname, textually the
// one of Machines `workloads/workspace-vm/machine-entry.ts` (gateway-catalog.py
// `MODULE_ID`, `label`, `RESERVED`, decision 0146): a lazurio.module.v1 id is
// lowercase letters, digits and dashes, at most 128 characters; the label
// collapses runs of dashes, strips dashes at both ends and is at most 63
// characters; the reserved names are never served.
export const MODULE_ID_MAX = 128;
export const MODULE_LABEL_MAX = 63;
export const RESERVED_LABELS: ReadonlySet<string> = new Set([
  "oauth2",
  "api",
  "well-known",
]);
const MODULE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** A lazurio.module.v1 id by the gateway's rule: the only key the gateway
 * names a module by (its `ensure`, launchpad-parity B5). */
export function isModuleId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MODULE_ID_MAX &&
    MODULE_ID.test(value)
  );
}

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
      | "module-label-invalid"
      | "module-label-empty"
      | "module-label-reserved"
      | "module-origin-too-long",
  ) {
    super(code);
  }
}

/** The one DNS label the gateway serves a module id at. An id that is not a
 * valid lazurio.module.v1 id is refused (the gateway serves nothing for it);
 * otherwise the gateway's `label()`. An empty label or a name the gateway
 * reserves for itself is refused. Never the id itself: the gateway serves
 * `my--notes` at `my-notes.<vm>.<domain>`. */
export function moduleLabel(id: unknown): string {
  if (!isModuleId(id)) throw new ModuleOriginError("module-label-invalid");
  const label = id
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MODULE_LABEL_MAX)
    .replace(/-+$/, "");
  if (label === "") throw new ModuleOriginError("module-label-empty");
  if (RESERVED_LABELS.has(label))
    throw new ModuleOriginError("module-label-reserved");
  return label;
}

/** The origin of one module: the declared template with the gateway's label
 * of the module id in its one `{module}` slot. The template states the rule;
 * the gateway's catalog decides whether that hostname is actually served. */
export function moduleOrigin(template: string, moduleId: unknown): string {
  if (!isModuleOriginTemplate(template))
    throw new ModuleOriginError("module-origin-template-invalid");
  const result = template.replace(modulePlaceholder, moduleLabel(moduleId));
  // A hostname longer than DNS allows is no origin of anything.
  if (result.length - "https://".length > 253)
    throw new ModuleOriginError("module-origin-too-long");
  return result;
}
