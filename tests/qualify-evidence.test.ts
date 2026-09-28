import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  journeys,
  parseEvidence,
  parseLine,
  type QualificationLine,
  qualificationFindings,
  qualifiedTargets,
} from "../scripts/qualify/evidence";
import {
  parseManifest,
  renderManifest,
  sha256Hex,
} from "../src/update/manifest";

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
  journey: (typeof journeys)[number],
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
  qualifiedTargets.flatMap((target) =>
    journeys.map((journey) => line(target, journey)),
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

test("a failed, missing or duplicated journey refuses", () => {
  const lines = everyLine();
  lines[2] = line("linux-x64", "J3", { outcome: "failed" });
  lines.pop();
  lines.push(line("linux-x64", "J1"));
  expect(qualificationFindings(manifest, parseEvidence(jsonl(lines)))).toEqual([
    "linux-x64 J1: recorded twice",
    "linux-x64 J3: failed",
    "darwin-arm64 J6: missing",
  ]);
});

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
  ])
    expect(() => parseLine(JSON.stringify(invalid))).toThrow(
      "Not a lazurio.qualification.v1 line",
    );
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
  const run = (journey: string, command: string[]) =>
    Bun.spawnSync(
      [
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
      ],
      { stdout: "pipe", stderr: "pipe" },
    ).exitCode;
  expect(run("J1", ["true"])).toBe(0);
  expect(run("J2", ["false"])).toBe(1);
  const lines = parseEvidence(await readFile(out, "utf8"));
  expect(
    lines.map(({ journey, outcome, sha256 }) => [journey, outcome, sha256]),
  ).toEqual([
    ["J1", "ok", sha256Hex(bytes["linux-x64"])],
    ["J2", "failed", sha256Hex(bytes["linux-x64"])],
  ]);
  const check = Bun.spawnSync(
    [
      process.execPath,
      "run",
      script,
      "check",
      "--manifest",
      join(directory, "manifest.json"),
      out,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(check.exitCode).toBe(1);
  expect(check.stderr.toString()).toContain("linux-x64 J2: failed");
  const full = join(directory, "full.jsonl");
  await writeFile(full, jsonl(everyLine()));
  const passed = Bun.spawnSync(
    [
      process.execPath,
      "run",
      script,
      "check",
      "--manifest",
      join(directory, "manifest.json"),
      full,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect([passed.exitCode, passed.stdout.toString().trim()]).toEqual([
    0,
    "v1.2.0-rc.1 is qualified: J1 J2 J3 J4 J5 J6 ok on linux-x64 and darwin-arm64.",
  ]);
});
