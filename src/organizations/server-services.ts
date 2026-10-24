import type { MachineService } from "../machine/context";

// The services of Služby serveru in the catalog (root decision 0209 point 6,
// its addenda of 2026-10-19 (a), (b) and (g); Machines
// docs/server-services.md §2.1; decision F32's addendum of 2026-10-24): the
// services Environment of a server lists, in its Organization's
// Productionspace, every service of its own handover that names a
// repository, one entry per repository, and a service that has a page opens
// it on this Environment's loopback in its Environment browser. No service
// gets an address of its own. The rules both the catalog (catalog.ts, which
// reads the handover) and the page's parser share; pure, nothing here reads
// a file.

/** The kinds of a service, exactly as the vendored handover schema lists
 * them (`$defs.organization_workspace_vm.properties.services`). */
export const serviceKinds = Object.freeze([
  "ai-pool",
  "ai-gateway",
  "http",
  "diagnostics",
  "public-entry",
  "dns01",
] as const satisfies readonly MachineService["kind"][]);
export type ServiceKind = MachineService["kind"];

/** A service's id, as the schema bounds it: a DNS label of at most 32
 * characters, unique in its services Environment (Machines refuses another,
 * `server-services-id-invalid`). */
export const serviceIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const isServiceId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 32 &&
  serviceIdPattern.test(value);

/** The path of a service's page by its kind. The handover carries only the
 * page's loopback port (`page_port`); Machines renders the page of one kind
 * alone, the AI pool's Management Center of CLIProxyAPI at
 * `/management.html` (Machines `workloads/workspace-vm/service-unit.ts`, the
 * renderer of `ai-pool`). A kind without a path here has no page in the
 * Launchpad, whatever port the handover names: a link to the wrong page is
 * worse than none. Once Machines hands the path over itself (a `page_path`
 * the Platform reads first and Machines writes after,
 * HumanAndMachine-ai/Machines#902), this table goes. */
export const servicePagePaths: Readonly<Partial<Record<ServiceKind, string>>> =
  Object.freeze({ "ai-pool": "/management.html" });

/** One service of this Environment as the catalog lists it under its
 * repository: its id and kind as the handover writes them, and its page on
 * this Environment's loopback (`http://127.0.0.1:<page_port><path>`), which
 * the Environment browser opens; null where it has none. The page opens
 * signed out: nothing here holds, fills in or stores a key (root decision
 * 0209 addendum (a)). */
export type CatalogService = Readonly<{
  id: string;
  kind: ServiceKind;
  page: string | null;
}>;

/** A loopback page as `servicePage` writes it: `http`, 127.0.0.1, a port
 * the schema allows and a path of the characters Machines renders. */
const pageAddress = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})\/[A-Za-z0-9._~/-]*$/;
export function isServicePage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = pageAddress.exec(value);
  const port = Number(match?.[1]);
  return match !== null && port >= 1025 && port <= 65535;
}

/** A service's page on this Environment's loopback, or null. */
export function servicePage(
  service: Pick<MachineService, "kind" | "page_port">,
): string | null {
  const path = servicePagePaths[service.kind];
  if (path === undefined || service.page_port === undefined) return null;
  const page = `http://127.0.0.1:${service.page_port}${path}`;
  return isServicePage(page) ? page : null;
}

/** One service as the page's parser admits it. */
export function isCatalogService(value: unknown): value is CatalogService {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    isServiceId(entry.id) &&
    (serviceKinds as readonly unknown[]).includes(entry.kind) &&
    (entry.page === null || isServicePage(entry.page))
  );
}
