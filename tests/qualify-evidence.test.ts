import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEvidence,
  parseLine,
  type QualificationLine,
  qualificationFindings,
} from "../scripts/qualify/evidence";
import {
  parseManifest,
  renderManifest,
  sha256Hex,
} from "../src/update/manifest";
import { runChild } from "./fixtures/run-child";

// Acceptance matrix from docs/release-cycle.md. Keep this independent of the
// gate implementation: dropping a required journey or target must break a test.
const requiredJourneys = ["J1", "J2", "J3", "J4", "J5", "J6"] as const;
const requiredTargets = ["linux-x64", "darwin-arm64"] as const;

const commit = "0123456789abcdef0123456789abcdef01234567";
const bytes = {
  "linux-x64": new TextEncoder().encode("linux executable"),
  "darwin-arm64": new TextEncoder().encode("darwin executable"),
} as const;
const manifestBytes = renderManifest({
  version: "1.2.0-rc.1",
  sourceCommit: commit,
  minimumUpdaterVersion: "1.0.0",
  repository: "Lazurio/LazurioPlatform",
  targets: Object.fromEntries(
    Object.entries(bytes).map(([target, content]) => [
      target,
      { sha256: sha256Hex(content), size: content.byteLength },
    ]),
  ),
});
const manifest = parseManifest(manifestBytes);
const line = (
  target: keyof typeof bytes,
  journey: (typeof requiredJourneys)[number],
  change: Partial<Record<keyof QualificationLine, unknown>> = {},
) => ({
  schema: "lazurio.qualification.v1",
  tag: "v1.2.0-rc.1",
  commit,
  target,
  runner: target === "linux-x64" ? "ubuntu-24.04" : "macos-14",
  journey,
  proof: journey === "J6" ? "source" : "executable",
  outcome: "ok",
  durationMs: 1234,
  sha256: sha256Hex(bytes[target]),
  ...change,
});
const everyLine = () =>
  requiredTargets.flatMap((target) =>
    requiredJourneys.map((journey) => line(target, journey)),
  );
const jsonl = (lines: readonly object[]) =>
  `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

test("every journey ok once on every target, for the manifest's bytes and commit: qualified", () => {
  expect(
    qualificationFindings(manifest, parseEvidence(jsonl(everyLine()))),
  ).toEqual([]);
  // Lines from several per-job files read as one evidence.
  const [first, ...rest] = everyLine();
  expect(
    qualificationFindings(
      manifest,
      parseEvidence(jsonl([first as object]), jsonl(rest)),
    ),
  ).toEqual([]);
});

for (const target of requiredTargets) {
  for (const journey of requiredJourneys) {
    test(`${target} ${journey} is individually required, successful and unique`, () => {
      const others = everyLine().filter(
        (entry) => entry.target !== target || entry.journey !== journey,
      );
      expect(
        qualificationFindings(manifest, parseEvidence(jsonl(others))),
      ).toEqual([`${target} ${journey}: missing`]);
      expect(
        qualificationFindings(
          manifest,
          parseEvidence(
            jsonl([...others, line(target, journey, { outcome: "failed" })]),
          ),
        ),
      ).toEqual([`${target} ${journey}: failed`]);
      expect(
        qualificationFindings(
          manifest,
          parseEvidence(jsonl([...everyLine(), line(target, journey)])),
        ),
      ).toEqual([`${target} ${journey}: recorded twice`]);
    });
  }
}

test("evidence of another candidate, commit or executable refuses", () => {
  const lines = everyLine();
  lines[0] = line("linux-x64", "J1", { tag: "v1.2.0-rc.2" });
  lines[1] = line("linux-x64", "J2", { commit: "f".repeat(40) });
  lines[7] = line("darwin-arm64", "J2", { sha256: "0".repeat(64) });
  expect(qualificationFindings(manifest, parseEvidence(jsonl(lines)))).toEqual([
    "linux-x64 J1: evidence of v1.2.0-rc.2",
    "linux-x64 J2: ran at another commit",
    "darwin-arm64 J2: another executable than the release's",
  ]);
});

test("a line is exactly the schema", () => {
  const valid = line("linux-x64", "J1");
  expect(parseLine(JSON.stringify(valid))).toEqual(valid as QualificationLine);
  for (const invalid of [
    { ...valid, schema: "lazurio.qualification.v2" },
    { ...valid, extra: true },
    { ...valid, journey: "J7" },
    { ...valid, outcome: "skipped" },
    { ...valid, durationMs: -1 },
    { ...valid, durationMs: 1.5 },
    { ...valid, tag: "v1.2.0" },
    { ...valid, runner: "Runner With Spaces" },
    // A detail belongs to a failed line and is one of the enumerated ids.
    { ...valid, detail: "exit" },
    { ...valid, outcome: "failed", detail: "the unit said something" },
  ])
    expect(() => parseLine(JSON.stringify(invalid))).toThrow(
      "Not a lazurio.qualification.v1 line",
    );
  const failed = { ...valid, outcome: "failed", detail: "not-healthy" };
  expect(parseLine(JSON.stringify(failed))).toEqual(
    failed as QualificationLine,
  );
  // Lines written before the detail existed stay readable.
  expect(
    parseLine(JSON.stringify({ ...valid, outcome: "failed" })).detail,
  ).toBe(undefined);
  const { proof: _, ...missing } = valid;
  expect(() => parseLine(JSON.stringify(missing))).toThrow();
});

const script = new URL("../scripts/qualify/evidence.ts", import.meta.url)
  .pathname;
let directory: string | undefined;
afterAll(async () => directory && rm(directory, { recursive: true }));

test("the CLI: run records the command's outcome and exits with it; check reads the files", async () => {
  directory = await mkdtemp(join(tmpdir(), "qualification-"));
  await writeFile(join(directory, "manifest.json"), manifestBytes);
  await writeFile(join(directory, "lazurio-linux-x64"), bytes["linux-x64"]);
  const out = join(directory, "evidence.jsonl");
  const run = async (journey: string, command: string[]) =>
    (
      await runChild([
        process.execPath,
        "run",
        script,
        "run",
        "--candidate",
        directory as string,
        "--target",
        "linux-x64",
        "--runner",
        "ubuntu-24.04",
        "--journey",
        journey,
        "--proof",
        "executable",
        "--out",
        out,
        "--",
        ...command,
      ])
    ).exitCode;
  expect(await run("J1", ["true"])).toBe(0);
  expect(await run("J2", ["false"])).toBe(1);
  // A journey names why it failed through the file the wrapper gives it.
  expect(
    await run("J3", [
      "sh",
      "-c",
      'echo launchpad-not-up > "$LAZURIO_QUALIFY_DETAIL"; exit 1',
    ]),
  ).toBe(1);
  // Anything outside the enumeration is recorded as a plain exit.
  expect(
    await run("J4", [
      "sh",
      "-c",
      'echo "a free text" > "$LAZURIO_QUALIFY_DETAIL"; exit 1',
    ]),
  ).toBe(1);
  const lines = parseEvidence(await readFile(out, "utf8"));
  expect(
    lines.map(({ journey, outcome, sha256, detail }) => [
      journey,
      outcome,
      sha256,
      detail,
    ]),
  ).toEqual([
    ["J1", "ok", sha256Hex(bytes["linux-x64"]), undefined],
    ["J2", "failed", sha256Hex(bytes["linux-x64"]), "exit"],
    ["J3", "failed", sha256Hex(bytes["linux-x64"]), "launchpad-not-up"],
    ["J4", "failed", sha256Hex(bytes["linux-x64"]), "exit"],
  ]);
  const check = await runChild([
    process.execPath,
    "run",
    script,
    "check",
    "--manifest",
    join(directory, "manifest.json"),
    out,
  ]);
  expect(check.exitCode).toBe(1);
  expect(check.stderr).toContain("linux-x64 J2: failed (exit)");
  expect(check.stderr).toContain("linux-x64 J3: failed (launchpad-not-up)");
  const full = join(directory, "full.jsonl");
  await writeFile(full, jsonl(everyLine()));
  const passed = await runChild([
    process.execPath,
    "run",
    script,
    "check",
    "--manifest",
    join(directory, "manifest.json"),
    full,
  ]);
  expect([passed.exitCode, passed.stdout.trim()]).toEqual([
    0,
    "v1.2.0-rc.1 is qualified: J1 J2 J3 J4 J5 J6 ok on linux-x64 and darwin-arm64.",
  ]);
});
