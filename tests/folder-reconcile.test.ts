import { expect, test } from "bun:test";
import { planInstructions } from "../src/folder/reconcile";

const oldDigest = "a".repeat(64);
const newDigest = "b".repeat(64);
test("fresh instructions, unchanged generation, replacement and retirement", () => {
  expect(planInstructions(null, oldDigest, { kind: "absent" })).toEqual({
    kind: "create",
    path: "AGENTS.md",
  });
  expect(
    planInstructions(oldDigest, oldDigest, {
      kind: "regular",
      digest: oldDigest,
    }),
  ).toEqual({ kind: "unchanged" });
  expect(
    planInstructions(oldDigest, newDigest, {
      kind: "regular",
      digest: oldDigest,
    }),
  ).toEqual({ kind: "replace", path: "AGENTS.md" });
  expect(
    planInstructions(oldDigest, null, { kind: "regular", digest: oldDigest }),
  ).toEqual({ kind: "remove", path: "AGENTS.md" });
});
test("unknown files are never adopted even if desired bytes match", () => {
  expect(
    planInstructions(null, newDigest, { kind: "regular", digest: newDigest }),
  ).toEqual({ kind: "blocked", reason: "unowned-file" });
});
test("edited or missing owned instructions block replacement and removal", () => {
  for (const desired of [null, newDigest]) {
    expect(
      planInstructions(oldDigest, desired, {
        kind: "regular",
        digest: newDigest,
      }),
    ).toEqual({ kind: "blocked", reason: "drift" });
    expect(planInstructions(oldDigest, desired, { kind: "absent" })).toEqual({
      kind: "blocked",
      reason: "drift",
    });
  }
});
test("unsafe inventory and invalid digests fail closed", () => {
  expect(planInstructions(null, newDigest, { kind: "unsafe" })).toEqual({
    kind: "blocked",
    reason: "unsafe-path",
  });
  expect(planInstructions("invalid", newDigest, { kind: "absent" })).toEqual({
    kind: "blocked",
    reason: "invalid-digest",
  });
  expect(planInstructions(null, null, { kind: "absent" })).toEqual({
    kind: "unchanged",
  });
});
