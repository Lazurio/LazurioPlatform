import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canaryFindings } from "../scripts/qualify/check-canary";

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
  const check = (file: string) => {
    const child = Bun.spawnSync([process.execPath, "run", script, file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return [
      child.exitCode,
      `${child.stdout.toString()}${child.stderr.toString()}`.trim(),
    ];
  };
  expect(check(path)).toEqual([
    1,
    `Refused: the canary of ${candidate} does not pass.\n  no readable canary record for ${candidate}`,
  ]);
  await writeFile(path, JSON.stringify(record()));
  expect(check(path)).toEqual([
    0,
    `The canary of ${candidate} passed: 8 hours on every listed Machine.`,
  ]);
  const renamed = join(directory, "v1.2.0-rc.2.json");
  await writeFile(renamed, JSON.stringify(record()));
  expect(check(renamed)[0]).toBe(1);
});
