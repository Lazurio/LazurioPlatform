import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type DurableWriter, syncDirectory } from "./durable-file";
import { layout, parseVersionName } from "./layout";

/** Which supervisor owns the Launchpad of this Machine, as far as an
 * activation is concerned (docs/update.md "Deliberately narrow").
 */
export type ServiceSpec =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "systemd-user"; unit: string }>;

export const systemdUnitPattern =
  /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,200}\.service$/;

export function parseServiceSpec(value: unknown): ServiceSpec | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "none") return Object.freeze({ kind: "none" });
  if (
    record.kind === "systemd-user" &&
    typeof record.unit === "string" &&
    systemdUnitPattern.test(record.unit)
  )
    return Object.freeze({ kind: "systemd-user", unit: record.unit });
  return undefined;
}

/** `update/activation.json` — the ONLY transaction record of the update
 * mechanism (docs/update.md "State on disk"). It exists from the decision to
 * switch until the new version is confirmed or the previous one is restored:
 *
 *   switching ──▶ confirming ──▶ confirmed    (record removed)
 *        └────────────┴────────▶ rolled back  (selector restored, record removed)
 *
 * It carries everything a LATER process needs to finish or undo the
 * activation without the worker that started it, and nothing else. It decides
 * recovery; logs and the observation only explain it.
 */
export type ActivationRecord = Readonly<{
  schemaVersion: 1;
  operation: string;
  kind: "update" | "rollback";
  /** Version names under `versions/`. */
  previous: string;
  candidate: string;
  /** `switching`: the selector may name either version. `confirming`: it
   * names the candidate and the record says since when. */
  phase: "switching" | "confirming";
  /** Wall clock, because it must outlive the worker and a reboot. */
  deadline: string;
  switchedAt: string | null;
  service: ServiceSpec;
  /** Folder shown to the confirming self-check, when one was named. */
  folder: string | null;
}>;

const recordName = "activation.json";
const previousName = "previous.json";

const isTime = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  !Number.isNaN(Date.parse(value));

export function parseActivationRecord(value: unknown): ActivationRecord {
  const record = value as Record<string, unknown> | null;
  const service = parseServiceSpec(record?.service);
  if (
    !record ||
    typeof record !== "object" ||
    record.schemaVersion !== 1 ||
    typeof record.operation !== "string" ||
    !/^[A-Za-z0-9-]{1,64}$/.test(record.operation) ||
    (record.kind !== "update" && record.kind !== "rollback") ||
    !parseVersionName(record.previous) ||
    !parseVersionName(record.candidate) ||
    record.previous === record.candidate ||
    (record.phase !== "switching" && record.phase !== "confirming") ||
    !isTime(record.deadline) ||
    !(record.switchedAt === null || isTime(record.switchedAt)) ||
    (record.phase === "confirming" && record.switchedAt === null) ||
    !(record.folder === null || typeof record.folder === "string") ||
    !service
  )
    throw new Error("Unrecognized activation record");
  return Object.freeze({
    schemaVersion: 1,
    operation: record.operation,
    kind: record.kind,
    previous: record.previous as string,
    candidate: record.candidate as string,
    phase: record.phase,
    deadline: record.deadline,
    switchedAt: record.switchedAt as string | null,
    service,
    folder: record.folder as string | null,
  });
}

export type ActivationRecordState =
  | Readonly<{ kind: "absent" }>
  /** Present but unreadable, of a newer schema or damaged. */
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "record"; record: ActivationRecord }>;

export async function readActivationRecord(
  base: string,
): Promise<ActivationRecordState> {
  let text: string;
  try {
    text = await readFile(join(layout(base).update, recordName), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "invalid" };
  }
  try {
    return { kind: "record", record: parseActivationRecord(JSON.parse(text)) };
  } catch {
    return { kind: "invalid" };
  }
}

export async function writeActivationRecord(
  base: string,
  record: ActivationRecord,
  write: DurableWriter,
): Promise<void> {
  await write(
    layout(base).update,
    recordName,
    Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
  );
}

export async function removeActivationRecord(base: string): Promise<void> {
  const { update } = layout(base);
  await rm(join(update, recordName), { recursive: true, force: true });
  await syncDirectory(update);
}

/** `update/previous.json`: the version the last CONFIRMED activation
 * replaced. It is not a selector and decides nothing about what runs; it
 * tells retention what to keep and `update rollback` where to go. Missing or
 * damaged means "no rollback is offered", never an error for anything else.
 */
export async function readPrevious(base: string): Promise<string | null> {
  try {
    const value = JSON.parse(
      await readFile(join(layout(base).update, previousName), "utf8"),
    ) as Record<string, unknown> | null;
    return value?.schemaVersion === 1 && parseVersionName(value.name)
      ? (value.name as string)
      : null;
  } catch {
    return null;
  }
}

export async function writePrevious(
  base: string,
  name: string,
  write: DurableWriter,
): Promise<void> {
  await write(
    layout(base).update,
    previousName,
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, name })}\n`),
  );
}
