import { join } from "node:path";
import { readOrganizationApplications } from "../organizations/read-applications";
import { readModuleApplication } from "./read-application";

// The one slot form that names a sibling Module (root decision 0176): an
// Organization-relative `workspace/<slug>`. Its data mount
// `workspace/<slug>/db`, any longer path and any other root are data or
// nothing, never an address.
const siblingSlot = /^workspace\/([a-z0-9][a-z0-9-]*)$/;

/** The loopback origins of the sibling Modules an application declares
 * (root decision 0176, addendum of 2026-10-10; decision F26, addendum of
 * 2026-10-10), by sibling module id: for each `workspace/<slug>` in its
 * `required_module_slots`, the entrypoint of that sibling's default app as
 * `<protocol>://<host>:<port>`, read from the sibling's own declaration at
 * this call, never remembered. Only a module of the application's own
 * Organization, observed under the same admission as a start; a sibling
 * that is not declared there, not checked out, unreadable, app-less or
 * without an HTTP(S) entrypoint has no origin (its readiness finding is
 * issue #128's), and neither has the application's own module. Whether the
 * sibling runs is not asked: its address is its lease, and it answers only
 * while it runs. */
export async function siblingOrigins(input: {
  organizationDirectory: string;
  company: string;
  module: string;
  slots: readonly string[];
}): Promise<Readonly<Record<string, string>>> {
  const wanted = new Set(
    input.slots.flatMap((slot) => {
      const id = siblingSlot.exec(slot)?.[1];
      return id === undefined || id === input.module ? [] : [id];
    }),
  );
  const origins: Record<string, string> = Object.create(null);
  if (wanted.size === 0) return Object.freeze(origins);
  const observed = await readOrganizationApplications(
    input.organizationDirectory,
    { admission: "executable" },
  );
  if (
    observed.kind !== "applications-observed" ||
    observed.company !== input.company
  )
    return Object.freeze(origins);
  for (const entry of observed.entries) {
    if (
      entry.kind !== "module-observed" ||
      entry.module === null ||
      !wanted.has(entry.module) ||
      entry.path !== `workspace/${entry.module}` ||
      entry.defaultApp === null
    )
      continue;
    const app = entry.defaultApp;
    if (
      !entry.apps.some(
        (item) => item.package === app && item.kind === "runtime-declared",
      )
    )
      continue;
    try {
      const plan = await readModuleApplication(
        join(input.organizationDirectory, entry.path),
        app,
      );
      if (
        plan.kind !== "declared-runtime-plan" ||
        plan.runtime.company !== input.company ||
        plan.runtime.module !== entry.module
      )
        continue;
      const listener = plan.listeners.find(
        (item) => item.role === "entrypoint",
      );
      if (!listener || !["http", "https"].includes(listener.protocol)) continue;
      const host = listener.host.includes(":")
        ? `[${listener.host}]`
        : listener.host;
      origins[entry.module] = `${listener.protocol}://${host}:${listener.port}`;
    } catch {
      // Unreadable now: no origin, as for a sibling that is not there.
    }
  }
  return Object.freeze(origins);
}
