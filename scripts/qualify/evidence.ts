import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  artifactFile,
  manifestFile,
  parseManifest,
  type ReleaseManifest,
  sha256Hex,
} from "../../src/update/manifest";

/** The qualification evidence of a release candidate (docs/release-cycle.md
 * "Qualification and the canary"). Every journey of `qualify.yml` on every
 * runner writes ONE line, a JSON object of schema `lazurio.qualification.v1`;
 * the lines of one candidate are one JSON Lines file, the artifact
 * `qualification-<tag>` that the release job of the final tag requires.
 *
 *   evidence.ts run --candidate <dir> --target <target> --runner <label> --journey <J1…J6> --proof <executable|source> --out <file> -- <command…>
 *   evidence.ts check --manifest <manifest.json> <evidence file…>
 *
 * `run` runs the command, appends its line and exits with the command's
 * status. `check` refuses unless every journey is `ok` exactly once on every
 * required target, for exactly the bytes and the source commit the
 * candidate's manifest names.
 */
export const qualificationSchema = "lazurio.qualification.v1";

/** J1 first installation by install.sh, J2 update from the previous final
 * release, J3 the pre-switch probe refusing, J4 Recovery mode and `lazurio
 * recover`, J5 the migration from a layout with rollback, J6 a kill at every
 * activation step. */
export const journeys = ["J1", "J2", "J3", "J4", "J5", "J6"] as const;
export type Journey = (typeof journeys)[number];

/** The targets qualified on runners of their own: `ubuntu-24.04`, `macos-14`. */
export const qualifiedTargets = ["linux-x64", "darwin-arm64"] as const;

/** `executable`: the journey ran the candidate's release executable.
 * `source`: it ran the candidate's source at its commit (a behavioural suite
 * that needs a hook no release executable has). */
export const proofs = ["executable", "source"] as const;

export type QualificationLine = Readonly<{
  schema: typeof qualificationSchema;
  tag: string;
  commit: string;
  target: string;
  runner: string;
  journey: Journey;
  proof: (typeof proofs)[number];
  outcome: "ok" | "failed";
  durationMs: number;
  sha256: string;
}>;

const keys = [
  "schema",
  "tag",
  "commit",
  "target",
  "runner",
  "journey",
  "proof",
  "outcome",
  "durationMs",
  "sha256",
] as const;

const isText = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

/** One line, exactly the schema: an unknown or missing member is refused. */
export function parseLine(text: string): QualificationLine {
  const value = JSON.parse(text) as Record<string, unknown> | null;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => key in value) ||
    value.schema !== qualificationSchema ||
    !isText(value.tag, /^v\d+\.\d+\.\d+-rc\.\d+$/) ||
    !isText(value.commit, /^[0-9a-f]{40}$/) ||
    !isText(value.target, /^[a-z0-9]+-[a-z0-9]+$/) ||
    !isText(value.runner, /^[a-z0-9][a-z0-9.-]{0,63}$/) ||
    !journeys.includes(value.journey as Journey) ||
    !proofs.includes(value.proof as (typeof proofs)[number]) ||
    (value.outcome !== "ok" && value.outcome !== "failed") ||
    !Number.isSafeInteger(value.durationMs) ||
    (value.durationMs as number) < 0 ||
    !isText(value.sha256, /^[0-9a-f]{64}$/)
  )
    throw new Error(`Not a ${qualificationSchema} line`);
  return Object.freeze(value as QualificationLine);
}

/** Every non-empty line of the given texts. */
export const parseEvidence = (...texts: readonly string[]) =>
  texts
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.trim() !== "")
    .map(parseLine);

/** What stands between this evidence and a qualified candidate; empty when
 * qualified. */
export function qualificationFindings(
  manifest: ReleaseManifest,
  lines: readonly QualificationLine[],
  targets: readonly string[] = qualifiedTargets,
): string[] {
  const tag = `v${manifest.version}`;
  const findings: string[] = [];
  const seen = new Map<string, QualificationLine>();
  for (const line of lines) {
    const cell = `${line.target} ${line.journey}`;
    if (line.tag !== tag) findings.push(`${cell}: evidence of ${line.tag}`);
    if (line.commit !== manifest.sourceCommit)
      findings.push(`${cell}: ran at another commit`);
    const expected = manifest.targets[line.target]?.sha256;
    if (expected === undefined)
      findings.push(`${cell}: no such target in the manifest`);
    else if (line.sha256 !== expected)
      findings.push(`${cell}: another executable than the release's`);
    if (seen.has(cell)) findings.push(`${cell}: recorded twice`);
    seen.set(cell, line);
  }
  for (const target of targets)
    for (const journey of journeys) {
      const line = seen.get(`${target} ${journey}`);
      if (line === undefined) findings.push(`${target} ${journey}: missing`);
      else if (line.outcome !== "ok")
        findings.push(`${target} ${journey}: ${line.outcome}`);
    }
  return findings;
}

async function runJourney(args: string[]): Promise<number> {
  const split = args.indexOf("--");
  const command = split === -1 ? [] : args.slice(split + 1);
  const { values } = parseArgs({
    args: split === -1 ? args : args.slice(0, split),
    strict: true,
    options: {
      candidate: { type: "string" },
      target: { type: "string" },
      runner: { type: "string" },
      journey: { type: "string" },
      proof: { type: "string" },
      out: { type: "string" },
    },
  });
  const { candidate, target, runner, journey, proof, out } = values;
  if (
    !candidate ||
    !target ||
    !runner ||
    !journey ||
    !proof ||
    !out ||
    !command.length
  )
    throw new Error(
      "Usage: run --candidate <dir> --target <target> --runner <label> --journey <J> --proof <executable|source> --out <file> -- <command…>",
    );
  const manifest = parseManifest(await readFile(join(candidate, manifestFile)));
  const executable = await readFile(join(candidate, artifactFile(target)));
  const started = performance.now();
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  // Validated by the same parser a reader uses: nothing unreadable is written.
  const line = parseLine(
    JSON.stringify({
      schema: qualificationSchema,
      tag: `v${manifest.version}`,
      commit: manifest.sourceCommit,
      target,
      runner,
      journey,
      proof,
      outcome: code === 0 ? "ok" : "failed",
      durationMs: Math.round(performance.now() - started),
      sha256: sha256Hex(executable),
    }),
  );
  await appendFile(out, `${JSON.stringify(line)}\n`);
  console.log(`${line.target} ${line.journey}: ${line.outcome}`);
  return code === 0 ? 0 : 1;
}

async function check(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { manifest: { type: "string" } },
  });
  if (!values.manifest || !positionals.length)
    throw new Error("Usage: check --manifest <manifest.json> <evidence file…>");
  const manifest = parseManifest(await readFile(values.manifest));
  const lines = parseEvidence(
    ...(await Promise.all(positionals.map((path) => readFile(path, "utf8")))),
  );
  const findings = qualificationFindings(manifest, lines);
  if (findings.length) {
    console.error(`Refused: v${manifest.version} is not qualified.`);
    for (const finding of findings) console.error(`  ${finding}`);
    return 1;
  }
  console.log(
    `v${manifest.version} is qualified: ${journeys.join(" ")} ok on ${qualifiedTargets.join(" and ")}.`,
  );
  return 0;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const code =
    command === "run"
      ? await runJourney(args)
      : command === "check"
        ? await check(args)
        : (() => {
            throw new Error("Usage: evidence.ts run|check …");
          })();
  process.exit(code);
}
