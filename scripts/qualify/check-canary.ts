import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/** The canary record of a release candidate (docs/release-cycle.md
 * "Qualification and the canary"; root decision 0166 point 6): the candidate
 * ran for 8 hours on every hosted Machine of the pilot Organization, its work
 * VMs and its operators' personal VMs. The pilot Organization's release
 * reviewer adds `qualification/canary/<candidate>.json` by a pull request;
 * the release job of the final tag runs this check on it:
 *
 *   bun run scripts/qualify/check-canary.ts qualification/canary/<candidate>.json
 *
 * The record is public. Every value has a narrow shape, so there is no place
 * for free text: a Machine is an opaque id, never a hostname, a client or an
 * Organization name, and a refusal never repeats the refused value.
 * The 8 hours are not a variable of the record: a shorter canary exists only
 * as the Principal's recorded decision and a reviewed change of this check.
 */
export const canarySchema = "lazurio.canary.v1";
export const canaryHours = 8;

export const machineKinds = ["work", "personal"] as const;
export const machineHealth = ["healthy", "recovery-mode", "unhealthy"] as const;

export type CanaryMachine = Readonly<{
  /** Opaque and stable across canaries: 16–64 lowercase hex characters. */
  machine: string;
  /** An Organization work VM or an operator's personal VM. */
  kind: (typeof machineKinds)[number];
  /** `lazurio update status --json` → `active` at the end of the stage. */
  active: string;
  /** `lazurio recover --json` at the start and at the end, and no Recovery
   * mode in between: `healthy`, or what was seen instead. */
  health: (typeof machineHealth)[number];
}>;

export type CanaryRecord = Readonly<{
  schema: typeof canarySchema;
  candidate: string;
  /** When the LAST in-scope Machine ran the candidate (UTC). */
  start: string;
  end: string;
  machines: readonly CanaryMachine[];
  /** GitHub login of the pilot Organization's release reviewer. */
  reviewer: string;
  /** The pull request that added the record. */
  pullRequest: string;
}>;

const candidatePattern = /^v(\d+\.\d+\.\d+)-rc\.(\d+)$/;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const machinePattern = /^[0-9a-f]{16,64}$/;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const pullRequestPattern =
  /^https:\/\/github\.com\/Lazurio\/LazurioPlatform\/pull\/[1-9]\d*$/;
const recordKeys = [
  "schema",
  "candidate",
  "start",
  "end",
  "machines",
  "reviewer",
  "pullRequest",
];
const machineKeys = ["machine", "kind", "active", "health"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const matches = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value);
const instant = (value: unknown) =>
  matches(value, timePattern) ? Date.parse(value as string) : Number.NaN;

/** What refuses this record for `candidate` at `now`; empty when it passes.
 * A finding names a position and a rule, never a value from the record. */
export function canaryFindings(
  value: unknown,
  candidate: string,
  now: Date,
): string[] {
  const findings: string[] = [];
  if (!isObject(value) || !exactKeys(value, recordKeys))
    return [`not a ${canarySchema} record: exactly ${recordKeys.join(", ")}`];
  if (value.schema !== canarySchema)
    findings.push(`schema is not ${canarySchema}`);
  const version = candidatePattern.exec(candidate)?.[0].slice(1);
  if (version === undefined || value.candidate !== candidate)
    findings.push(`the record is not the canary of ${candidate}`);
  const start = instant(value.start);
  const end = instant(value.end);
  if (Number.isNaN(start) || Number.isNaN(end))
    findings.push("start and end must be UTC times (YYYY-MM-DDThh:mm:ssZ)");
  else if (end > now.getTime()) findings.push("the canary ends in the future");
  else if (end - start < canaryHours * 3600_000) {
    const minutes = Math.max(0, Math.floor((end - start) / 60_000));
    findings.push(
      `the canary lasted ${Math.floor(minutes / 60)} h ${minutes % 60} min; ${canaryHours} hours are required`,
    );
  }
  if (!matches(value.reviewer, loginPattern))
    findings.push("reviewer is not a GitHub login");
  if (!matches(value.pullRequest, pullRequestPattern))
    findings.push(
      "pullRequest is not a pull request of Lazurio/LazurioPlatform",
    );
  const machines = Array.isArray(value.machines) ? value.machines : [];
  if (!Array.isArray(value.machines) || machines.length === 0)
    findings.push("no Machine is listed");
  const ids = new Set<string>();
  const kinds = new Set<string>();
  machines.forEach((machine: unknown, index) => {
    const at = `machines[${index}]`;
    if (!isObject(machine) || !exactKeys(machine, machineKeys)) {
      findings.push(`${at}: exactly ${machineKeys.join(", ")}`);
      return;
    }
    if (!matches(machine.machine, machinePattern))
      findings.push(
        `${at}: not an opaque Machine id (16–64 lowercase hex); a hostname or a client never belongs in the record`,
      );
    else if (ids.has(machine.machine as string))
      findings.push(`${at}: listed twice`);
    else ids.add(machine.machine as string);
    if (!machineKinds.includes(machine.kind as CanaryMachine["kind"]))
      findings.push(`${at}: kind is ${machineKinds.join(" or ")}`);
    else kinds.add(machine.kind as string);
    if (machine.active !== version)
      findings.push(`${at}: is not on the candidate`);
    if (!machineHealth.includes(machine.health as CanaryMachine["health"]))
      findings.push(`${at}: health is one of ${machineHealth.join(", ")}`);
    else if (machine.health !== "healthy")
      findings.push(`${at}: was not healthy (${machine.health})`);
  });
  // Root decision 0166 point 6: both groups, or the stage has not happened.
  for (const kind of machineKinds)
    if (machines.length > 0 && !kinds.has(kind))
      findings.push(`no ${kind} VM is listed; the stage needs every one`);
  return findings;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (process.argv.length !== 3 || path === undefined) {
    console.error(
      "Usage: check-canary.ts qualification/canary/<vX.Y.Z-rc.N>.json",
    );
    process.exit(2);
  }
  const candidate = basename(path).replace(/\.json$/, "");
  let findings: string[];
  try {
    findings = canaryFindings(
      JSON.parse(await readFile(path, "utf8")),
      candidate,
      new Date(),
    );
  } catch {
    findings = [`no readable canary record for ${candidate}`];
  }
  if (findings.length) {
    console.error(`Refused: the canary of ${candidate} does not pass.`);
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(
    `The canary of ${candidate} passed: ${canaryHours} hours on every listed Machine.`,
  );
}
