import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/** The canary record of a release candidate (docs/release-cycle.md
 * "Qualification and the canary"; root decision 0166 point 6): the candidate
 * ran for 8 hours on every hosted Machine of the pilot Organization, its work
 * VMs and its operators' personal VMs. The pilot Organization's release
 * reviewer adds `qualification/canary/<candidate>.json` by a pull request;
 * the release job of the final tag runs this check on it:
 *
 *   bun run scripts/qualify/check-canary.ts [--provenance] qualification/canary/<candidate>.json
 *
 * Without `--provenance` the check is offline: the record alone. With it (the
 * release job) the record must also be the one its pull request merged into
 * the default branch, and that merge must be in the final tag's history.
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
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
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
/** A real UTC time in the one accepted form: `Date` normalizes 2026-02-30
 * to March 2, so the parsed time must print back as exactly the text. */
function instant(value: unknown): number {
  if (!matches(value, timePattern)) return Number.NaN;
  const time = Date.parse(value as string);
  return !Number.isNaN(time) &&
    new Date(time).toISOString() === (value as string).replace(/Z$/, ".000Z")
    ? time
    : Number.NaN;
}

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

/** What the release job learns about where the record came from: the pull
 * request it names, and the record as that pull request merged it. */
export type Provenance = Readonly<{
  /** `null`: the pull request could not be read. */
  pull: Readonly<{
    merged: boolean;
    baseRef: string;
    mergeCommit: string | null;
  }> | null;
  defaultBranch: string;
  /** The files the pull request added or changed. */
  files: readonly string[];
  /** `git merge-base --is-ancestor <merge commit> <final tag's commit>`. */
  mergeIsAncestor: boolean;
  /** The record at the final tag and at the merge commit (`null`: absent). */
  recordAtTag: Uint8Array;
  recordAtMerge: Uint8Array | null;
}>;

/** The record at the final tag is the one its pull request merged into the
 * default branch, and that merge is in the tag's history. Findings name the
 * rule only, never a value of the record. */
export function provenanceFindings(
  path: string,
  provenance: Provenance,
): string[] {
  const { pull } = provenance;
  if (pull === null)
    return ["the pull request of the record could not be read"];
  const findings: string[] = [];
  if (!pull.merged)
    findings.push("the pull request of the record is not merged");
  if (pull.baseRef !== provenance.defaultBranch)
    findings.push("the pull request was not merged into the default branch");
  if (!provenance.files.includes(path))
    findings.push("the pull request did not add or change the record");
  if (pull.mergeCommit === null || !/^[0-9a-f]{40}$/.test(pull.mergeCommit))
    return [...findings, "the pull request has no merge commit"];
  if (!provenance.mergeIsAncestor)
    findings.push("its merge commit is not an ancestor of the final tag");
  if (provenance.recordAtMerge === null)
    findings.push("the record is absent at its merge commit");
  else if (
    Buffer.compare(provenance.recordAtTag, provenance.recordAtMerge) !== 0
  )
    findings.push(
      "the record at the final tag differs from the record its pull request merged",
    );
  return findings;
}

const repository = "Lazurio/LazurioPlatform";

async function output(command: string[]) {
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  return {
    code: await child.exited,
    bytes,
    text: new TextDecoder().decode(bytes).trim(),
  };
}

/** The thin adapter: GitHub's answer about the pull request (gh, with the
 * job's GH_TOKEN) and Git's about the checked-out final tag (HEAD). */
async function readProvenance(
  path: string,
  pullRequest: string,
): Promise<Provenance> {
  const number = pullRequest.slice(pullRequest.lastIndexOf("/") + 1);
  const api = async (route: string, jq: string) => {
    const answer = await output(["gh", "api", "--paginate", route, "--jq", jq]);
    if (answer.code !== 0) throw new Error("GitHub API");
    return answer.text;
  };
  const defaultBranch = await api(`repos/${repository}`, ".default_branch");
  let pull: Provenance["pull"] = null;
  let files: string[] = [];
  try {
    const answer = JSON.parse(
      await api(
        `repos/${repository}/pulls/${number}`,
        "{merged, baseRef: .base.ref, mergeCommit: .merge_commit_sha}",
      ),
    );
    pull = {
      merged: answer.merged === true,
      baseRef: String(answer.baseRef),
      mergeCommit:
        typeof answer.mergeCommit === "string" ? answer.mergeCommit : null,
    };
    files = (
      await api(`repos/${repository}/pulls/${number}/files`, ".[].filename")
    ).split("\n");
  } catch {}
  const mergeCommit = pull?.mergeCommit ?? null;
  let mergeIsAncestor = false;
  let recordAtMerge: Uint8Array | null = null;
  if (mergeCommit !== null && /^[0-9a-f]{40}$/.test(mergeCommit)) {
    // The merge commit is on the default branch; a tag checkout may not have it.
    if (
      (await output(["git", "cat-file", "-e", `${mergeCommit}^{commit}`]))
        .code !== 0
    )
      await output([
        "git",
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        defaultBranch,
      ]);
    mergeIsAncestor =
      (
        await output([
          "git",
          "merge-base",
          "--is-ancestor",
          mergeCommit,
          "HEAD",
        ])
      ).code === 0;
    const atMerge = await output(["git", "show", `${mergeCommit}:${path}`]);
    recordAtMerge = atMerge.code === 0 ? atMerge.bytes : null;
  }
  const atTag = await output(["git", "show", `HEAD:${path}`]);
  if (atTag.code !== 0) throw new Error("The record is not in the final tag");
  return {
    pull,
    defaultBranch,
    files,
    mergeIsAncestor,
    recordAtTag: atTag.bytes,
    recordAtMerge,
  };
}

if (import.meta.main) {
  // `--provenance` (the release job, with GH_TOKEN and the final tag checked
  // out): after the record passes, it must be the one its pull request
  // merged into the default branch, in the tag's history.
  const args = process.argv.slice(2);
  const provenance = args[0] === "--provenance";
  const path = provenance ? args[1] : args[0];
  const candidate = basename(path ?? "").replace(/\.json$/, "");
  if (
    args.length !== (provenance ? 2 : 1) ||
    path === undefined ||
    (provenance && path !== `qualification/canary/${candidate}.json`)
  ) {
    console.error(
      "Usage: check-canary.ts [--provenance] qualification/canary/<vX.Y.Z-rc.N>.json",
    );
    process.exit(2);
  }
  let findings: string[];
  let record: CanaryRecord | undefined;
  try {
    record = JSON.parse(await readFile(path, "utf8"));
    findings = canaryFindings(record, candidate, new Date());
  } catch {
    findings = [`no readable canary record for ${candidate}`];
  }
  if (provenance && findings.length === 0 && record !== undefined)
    try {
      findings = provenanceFindings(
        path,
        await readProvenance(path, record.pullRequest),
      );
    } catch {
      findings = ["the provenance of the record could not be read"];
    }
  if (findings.length) {
    console.error(`Refused: the canary of ${candidate} does not pass.`);
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log(
    `The canary of ${candidate} passed: ${canaryHours} hours on every listed Machine${provenance ? ", recorded by a pull request merged into the default branch before this tag" : ""}.`,
  );
}
