import { join } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { observeOrganizationApplications } from "../organizations/read-applications";
import { readModuleApplication } from "./read-application";

// Why a start is refused for a slot the app requires (root decision 0176
// point 4): the slot of `required_module_slots` is not declared in the
// Organization manifest, is declared `planned_slot`, or is not on this
// Environment beside the app (not checked out, or not a directory of the
// checkout). The start's part of issue #128; the catalog, Diagnostics and
// doctor follow there.
export const requiredSlotReasons = [
  "required-slot-undeclared",
  "required-slot-planned",
  "required-slot-missing",
] as const;
export type RequiredSlotReason = (typeof requiredSlotReasons)[number];

/** A start refused for a required slot; `slot` is the declared slot,
 * relative to the Organization root. The message is never shown. */
export class RequiredSlotRefused extends Error {
  readonly reason: RequiredSlotReason;
  readonly slot: string;
  constructor(reason: RequiredSlotReason, slot: string) {
    super(`Required slot ${reason}`);
    this.name = "RequiredSlotRefused";
    this.reason = reason;
    this.slot = slot;
  }
}

// The one slot form that names a sibling Module (root decision 0176): an
// Organization-relative `workspace/<slug>`. Its data mount
// `workspace/<slug>/db` and every other slot are required to be there, but
// they are data, never an address.
const siblingSlot = /^workspace\/([a-z0-9][a-z0-9-]*)$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The slots a starting application requires, checked against its own
 * Organization, and the loopback origins of the sibling modules among them.
 *
 * Every slot of `required_module_slots` must be declared in the Organization
 * manifest, not `planned_slot`, and checked out beside the application
 * (root decision 0176 point 4); otherwise this throws `RequiredSlotRefused`
 * and the application is not started.
 *
 * Then, by sibling module id (root decision 0176, addendum of 2026-10-10;
 * decision F26, addendum of 2026-10-10): for each `workspace/<slug>`, the
 * entrypoint of that sibling's default app as `<protocol>://<host>:<port>`,
 * read from the sibling's own declaration at this call, never remembered. A
 * sibling that is there but app-less, unreadable or without an HTTP(S)
 * entrypoint has no origin, and neither has the application's own module.
 * Whether the sibling runs is not asked: its address is its lease, and it
 * answers only while it runs. */
export async function requiredSlotOrigins(input: {
  organizationDirectory: string;
  company: string;
  module: string;
  slots: readonly string[];
}): Promise<Readonly<Record<string, string>>> {
  const origins: Record<string, string> = Object.create(null);
  if (input.slots.length === 0) return Object.freeze(origins);
  const { result, documents } = await observeOrganizationApplications(
    input.organizationDirectory,
    { admission: "executable" },
  );
  if (
    result.kind !== "applications-observed" ||
    result.company !== input.company ||
    documents === null
  )
    throw new Error("Organization of the required slots unavailable");
  const declarations = Array.isArray(record(documents.modules)?.module_slots)
    ? (record(documents.modules)?.module_slots as unknown[])
    : [];
  for (const slot of input.slots) {
    const declared = declarations
      .map(record)
      .filter((item) => item?.path === slot);
    if (declared.length !== 1)
      throw new RequiredSlotRefused("required-slot-undeclared", slot);
    if (declared[0]?.status === "planned_slot")
      throw new RequiredSlotRefused("required-slot-planned", slot);
    try {
      // Each directory of the slot, as for a module: no symlink, the
      // operator's own checkout.
      let path = input.organizationDirectory;
      for (const segment of slot.split("/")) {
        path = join(path, segment);
        await inspectCheckoutDirectory(path);
      }
    } catch {
      throw new RequiredSlotRefused("required-slot-missing", slot);
    }
  }
  const wanted = new Set(
    input.slots.flatMap((slot) => {
      const id = siblingSlot.exec(slot)?.[1];
      return id === undefined || id === input.module ? [] : [id];
    }),
  );
  for (const entry of result.entries) {
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
      // Unreadable now: no origin; the sibling is there, so the start goes on.
    }
  }
  return Object.freeze(origins);
}
