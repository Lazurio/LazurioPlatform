import { expect, test } from "bun:test";
import {
  executorFinding,
  reportOf,
  setUpAtStart,
} from "../src/executor/converge";
import type { ExecutorStatus } from "../src/executor/flow";

// Who moves Executor on, and when (decision F44, addendum of 2026-10-11,
// #298): `lazurio install` and `lazurio update` report its state, and the
// Launchpad sets it up after it starts wherever Lazurio's setup moves it on.
// The report never promises a setup the Launchpad does not start.

const running: ExecutorStatus = {
  kind: "executor-status",
  state: "running",
  version: "1.6.10",
  installed: "1.6.10",
  address: "127.0.0.1:4789",
  entry: "lazurio",
  service: "running",
  settings: "current",
  answering: true,
  linger: "yes",
  agents: { codex: "registered", claude: "absent" },
};

const startStates = [
  "not-installed",
  "outdated",
  "not-running",
  "incomplete",
] as const;

test("the Launchpad's start sets up each state Lazurio's setup moves on, and nothing that runs, conflicts, is not Lazurio's here or is a newer pin's", () => {
  for (const state of startStates)
    expect([state, setUpAtStart({ ...running, state })]).toEqual([state, true]);
  expect(setUpAtStart(running)).toBe(false);
  expect(setUpAtStart({ ...running, state: "conflict" })).toBe(false);
  for (const reason of [
    "workstation",
    "handover-unreadable",
    "not-operator",
  ] as const)
    expect(
      setUpAtStart({ kind: "executor-status", state: "unsupported", reason }),
    ).toBe(false);
  // A newer pin's wrapper is a newer release's to look after, whatever its
  // state.
  for (const state of ["not-running", "incomplete"] as const)
    expect(
      setUpAtStart({ ...running, state, installed: "1.7.0", answering: false }),
    ).toBe(false);
});

test("install and update report the state they read and what happens next, without a promise the start does not keep", () => {
  expect(reportOf(running)).toEqual({ state: "running" });
  expect(executorFinding(reportOf(running))).toEqual([]);
  for (const state of startStates) {
    const report = reportOf({ ...running, state });
    expect(report).toEqual({ state, next: expect.any(String) });
    const next = "next" in report ? report.next : "";
    expect(next).toContain(
      "The Launchpad sets it up in the background after it starts",
    );
    expect(next).toContain("Settings → Tools → executor shows how it goes");
    expect(next).toContain("lazurio executor setup");
    expect(executorFinding(report)).toEqual([next]);
  }
  // A conflict is resolved with the Operator, never by the Launchpad.
  const conflict = reportOf({ ...running, state: "conflict" });
  expect(conflict).toMatchObject({ state: "conflict" });
  expect("next" in conflict ? conflict.next : "").toContain("is not Lazurio's");
  expect("next" in conflict ? conflict.next : "").not.toContain("Launchpad");
  // Where Lazurio does not set it up, nothing says it will.
  for (const status of [
    {
      kind: "executor-status",
      state: "unsupported",
      reason: "not-operator",
    } as const,
    { ...running, state: "not-running", installed: "1.7.0" } as const,
  ]) {
    const report = reportOf(status);
    expect("next" in report ? report.next : "").not.toContain("Launchpad");
    expect("next" in report ? report.next : "").toContain(
      "lazurio executor status",
    );
  }
  expect(
    reportOf({
      kind: "executor-status",
      state: "unsupported",
      reason: "not-operator",
    }),
  ).toMatchObject({ state: "unsupported", reason: "not-operator" });
});
