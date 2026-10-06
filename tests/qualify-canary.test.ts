import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canaryFindings,
  type Provenance,
  provenanceFindings,
} from "../scripts/qualify/check-canary";
import { runChild } from "./fixtures/run-child";

const candidate = "v1.2.0-rc.1";
const now = new Date("2026-09-02T12:00:00Z");
const machine = (id: string, kind: "work" | "personal", change = {}) => ({
  machine: id,
  kind,
  active: "1.2.0-rc.1",
  health: "healthy",
  ...change,
});
const record = (change: Record<string, unknown> = {}) => ({
  schema: "lazurio.canary.v1",
  candidate,
  start: "2026-09-01T08:00:00Z",
  end: "2026-09-01T16:05:00Z",
  machines: [
    machine("3f9a0c1d2e4b5a69", "work"),
    machine("0b7e44a1c9d2f310", "work"),
    machine("c41d9e0a7b3f5286", "personal"),
  ],
  reviewer: "octocat",
  pullRequest: "https://github.com/Lazurio/LazurioPlatform/pull/80",
  ...change,
});

test("8 hours on every listed Machine, on the candidate and healthy: passes", () => {
  expect(canaryFindings(record(), candidate, now)).toEqual([]);
  // Exactly 8 hours is enough.
  expect(
    canaryFindings(record({ end: "2026-09-01T16:00:00Z" }), candidate, now),
  ).toEqual([]);
});

test("a canary shorter than 8 hours, or not over yet, refuses", () => {
  expect(
    canaryFindings(record({ end: "2026-09-01T15:59:00Z" }), candidate, now),
  ).toEqual(["the canary lasted 7 h 59 min; 8 hours are required"]);
  expect(
    canaryFindings(
      record({ start: "2026-09-02T08:00:00Z", end: "2026-09-02T16:00:00Z" }),
      candidate,
      now,
    ),
  ).toEqual(["the canary ends in the future"]);
  expect(
    canaryFindings(record({ end: "yesterday evening" }), candidate, now),
  ).toEqual(["start and end must be UTC times (YYYY-MM-DDThh:mm:ssZ)"]);
});

test("an impossible calendar time is not a time: no normalizing to another day", () => {
  const invalid = ["start and end must be UTC times (YYYY-MM-DDThh:mm:ssZ)"];
  for (const [start, end] of [
    ["2026-02-30T08:00:00Z", "2026-02-30T16:05:00Z"],
    ["2026-13-01T08:00:00Z", "2026-13-01T16:05:00Z"],
    ["2026-09-01T08:00:00Z", "2026-09-01T24:00:00Z"],
    ["2026-09-01T08:00:60Z", "2026-09-01T16:05:00Z"],
    ["2026-09-01T08:00:00.000Z", "2026-09-01T16:05:00Z"],
    ["2026-09-01T08:00:00+00:00", "2026-09-01T16:05:00Z"],
  ])
    expect(canaryFindings(record({ start, end }), candidate, now)).toEqual(
      invalid,
    );
  // A real leap day is a time.
  expect(
    canaryFindings(
      record({ start: "2024-02-29T08:00:00Z", end: "2024-02-29T16:00:00Z" }),
      candidate,
      now,
    ),
  ).toEqual([]);
  expect(
    canaryFindings(
      record({ start: "2026-02-29T08:00:00Z", end: "2026-02-29T16:00:00Z" }),
      candidate,
      now,
    ),
  ).toEqual(invalid);
});

test("a Machine that is not on the candidate or not healthy refuses", () => {
  const machines = record().machines;
  machines[1] = machine("0b7e44a1c9d2f310", "work", { active: "1.1.0" });
  machines[2] = machine("c41d9e0a7b3f5286", "personal", {
    health: "recovery-mode",
  });
  expect(canaryFindings(record({ machines }), candidate, now)).toEqual([
    "machines[1]: is not on the candidate",
    "machines[2]: was not healthy (recovery-mode)",
  ]);
  // The record of another candidate is not this candidate's canary.
  expect(canaryFindings(record(), "v1.2.0-rc.2", now)).toEqual([
    "the record is not the canary of v1.2.0-rc.2",
    "machines[0]: is not on the candidate",
    "machines[1]: is not on the candidate",
    "machines[2]: is not on the candidate",
  ]);
});

test("a missing Machine refuses: no Machine, no personal VM, an entry without its version", () => {
  expect(canaryFindings(record({ machines: [] }), candidate, now)).toEqual([
    "no Machine is listed",
  ]);
  const workOnly = record().machines.slice(0, 2);
  expect(
    canaryFindings(record({ machines: workOnly }), candidate, now),
  ).toEqual(["no personal VM is listed; the stage needs every one"]);
  const { active: _, ...unobserved } = machine("c41d9e0a7b3f5286", "personal");
  expect(
    canaryFindings(
      record({ machines: [...workOnly, unobserved] }),
      candidate,
      now,
    ),
  ).toEqual([
    "machines[2]: exactly machine, kind, active, health",
    "no personal VM is listed; the stage needs every one",
  ]);
  const twice = [...record().machines, machine("3f9a0c1d2e4b5a69", "work")];
  expect(canaryFindings(record({ machines: twice }), candidate, now)).toEqual([
    "machines[3]: listed twice",
  ]);
});

test("a hostname or a client name is refused, and never repeated in the finding", () => {
  const leaks = [
    "vm-01.acme.lazurio.io",
    "acme-workspace-01",
    "100.64.0.12",
    "3F9A0C1D2E4B5A69",
  ];
  for (const leak of leaks) {
    const machines = record().machines;
    machines[0] = machine(leak, "work");
    const findings = canaryFindings(record({ machines }), candidate, now);
    expect(findings).toEqual([
      "machines[0]: not an opaque Machine id (16–64 lowercase hex); a hostname or a client never belongs in the record",
    ]);
    expect(findings.join("\n")).not.toContain(leak);
  }
  // No member outside the schema, where a name could travel.
  const named = { ...machine("3f9a0c1d2e4b5a69", "work"), hostname: "vm-01" };
  expect(
    canaryFindings(
      record({ machines: [named, ...record().machines.slice(1)] }),
      candidate,
      now,
    ),
  ).toEqual(["machines[0]: exactly machine, kind, active, health"]);
  expect(
    canaryFindings({ ...record(), client: "acme" }, candidate, now),
  ).toEqual([
    "not a lazurio.canary.v1 record: exactly schema, candidate, start, end, machines, reviewer, pullRequest",
  ]);
});

test("reviewer and pull request have their shapes", () => {
  expect(
    canaryFindings(
      record({
        reviewer: "not a login",
        pullRequest: "https://github.com/acme/other/pull/1",
      }),
      candidate,
      now,
    ),
  ).toEqual([
    "reviewer is not a GitHub login",
    "pullRequest is not a pull request of Lazurio/LazurioPlatform",
  ]);
});

const script = new URL("../scripts/qualify/check-canary.ts", import.meta.url)
  .pathname;
let directory: string | undefined;
afterAll(async () => directory && rm(directory, { recursive: true }));

test("the CLI: the candidate is the file name; a missing record refuses", async () => {
  directory = await mkdtemp(join(tmpdir(), "canary-"));
  const path = join(directory, `${candidate}.json`);
  const check = async (file: string) => {
    const child = await runChild([process.execPath, "run", script, file]);
    return [child.exitCode, `${child.stdout}${child.stderr}`.trim()];
  };
  expect(await check(path)).toEqual([
    1,
    `Refused: the canary of ${candidate} does not pass.\n  no readable canary record for ${candidate}`,
  ]);
  await writeFile(path, JSON.stringify(record()));
  expect(await check(path)).toEqual([
    0,
    `The canary of ${candidate} passed: 8 hours on every listed Machine.`,
  ]);
  const renamed = join(directory, "v1.2.0-rc.2.json");
  await writeFile(renamed, JSON.stringify(record()));
  expect((await check(renamed))[0]).toBe(1);
});

const path = `qualification/canary/${candidate}.json`;
const bytes = (text: string) => new TextEncoder().encode(text);
const merged = (change: Partial<Provenance> = {}): Provenance => ({
  pull: {
    merged: true,
    baseRef: "main",
    mergeCommit: "a".repeat(40),
  },
  defaultBranch: "main",
  files: ["docs/release-cycle.md", path],
  mergeIsAncestor: true,
  recordAtTag: bytes('{"schema":"lazurio.canary.v1"}\n'),
  recordAtMerge: bytes('{"schema":"lazurio.canary.v1"}\n'),
  ...change,
});

test("provenance: the record its pull request merged into the default branch, in the final tag's history, passes", () => {
  expect(provenanceFindings(path, merged())).toEqual([]);
});

test("provenance: an open pull request, another base, or a merge outside the tag's history refuses", () => {
  // What an unmerged tag would carry: an open pull request's record.
  expect(
    provenanceFindings(
      path,
      merged({
        pull: { merged: false, baseRef: "main", mergeCommit: "b".repeat(40) },
        mergeIsAncestor: false,
        recordAtMerge: null,
      }),
    ),
  ).toEqual([
    "the pull request of the record is not merged",
    "its merge commit is not an ancestor of the final tag",
    "the record is absent at its merge commit",
  ]);
  expect(
    provenanceFindings(
      path,
      merged({
        pull: {
          merged: true,
          baseRef: "release-x",
          mergeCommit: "a".repeat(40),
        },
      }),
    ),
  ).toEqual(["the pull request was not merged into the default branch"]);
  expect(provenanceFindings(path, merged({ mergeIsAncestor: false }))).toEqual([
    "its merge commit is not an ancestor of the final tag",
  ]);
  expect(
    provenanceFindings(
      path,
      merged({ pull: { merged: true, baseRef: "main", mergeCommit: null } }),
    ),
  ).toEqual(["the pull request has no merge commit"]);
  expect(provenanceFindings(path, merged({ pull: null }))).toEqual([
    "the pull request of the record could not be read",
  ]);
});

test("provenance: a pull request that did not carry the record, or a record changed after it, refuses", () => {
  expect(
    provenanceFindings(path, merged({ files: ["docs/release-cycle.md"] })),
  ).toEqual(["the pull request did not add or change the record"]);
  // One byte differs: the tag carries a record nobody merged.
  expect(
    provenanceFindings(
      path,
      merged({ recordAtTag: bytes('{"schema":"lazurio.canary.v1"} \n') }),
    ),
  ).toEqual([
    "the record at the final tag differs from the record its pull request merged",
  ]);
});
