import { expect, test } from "bun:test";
import { outputPaths } from "../src/folder/outputs";
import { planInstructions, planOutputs } from "../src/folder/reconcile";

const oldDigest = "a".repeat(64);
const newDigest = "b".repeat(64);
test("fresh instructions, unchanged generation, replacement and retirement", () => {
  expect(
    planInstructions("AGENTS.md", null, oldDigest, { kind: "absent" }),
  ).toEqual({
    kind: "create",
    path: "AGENTS.md",
  });
  expect(
    planInstructions("AGENTS.md", oldDigest, oldDigest, {
      kind: "regular",
      digest: oldDigest,
    }),
  ).toEqual({ kind: "unchanged" });
  expect(
    planInstructions("AGENTS.md", oldDigest, newDigest, {
      kind: "regular",
      digest: oldDigest,
    }),
  ).toEqual({ kind: "replace", path: "AGENTS.md" });
  expect(
    planInstructions("AGENTS.md", oldDigest, null, {
      kind: "regular",
      digest: oldDigest,
    }),
  ).toEqual({ kind: "remove", path: "AGENTS.md" });
});
test("unknown files are never adopted even if desired bytes match", () => {
  expect(
    planInstructions("manual/roles.md", null, newDigest, {
      kind: "regular",
      digest: newDigest,
    }),
  ).toEqual({
    kind: "blocked",
    reason: "unowned-file",
    path: "manual/roles.md",
  });
});
test("edited or missing owned instructions block replacement and removal", () => {
  for (const desired of [null, newDigest]) {
    expect(
      planInstructions("manual/roles.md", oldDigest, desired, {
        kind: "regular",
        digest: newDigest,
      }),
    ).toEqual({ kind: "blocked", reason: "drift", path: "manual/roles.md" });
    expect(
      planInstructions("AGENTS.md", oldDigest, desired, { kind: "absent" }),
    ).toEqual({ kind: "blocked", reason: "drift", path: "AGENTS.md" });
  }
});
test("unsafe inventory and invalid digests fail closed", () => {
  expect(
    planInstructions("AGENTS.md", null, newDigest, { kind: "unsafe" }),
  ).toEqual({ kind: "blocked", reason: "unsafe-path", path: "AGENTS.md" });
  expect(
    planInstructions("AGENTS.md", "invalid", newDigest, { kind: "absent" }),
  ).toEqual({ kind: "blocked", reason: "invalid-digest", path: "AGENTS.md" });
  expect(planInstructions("AGENTS.md", null, null, { kind: "absent" })).toEqual(
    { kind: "unchanged" },
  );
});

function all<T>(value: T): Record<(typeof outputPaths)[number], T> {
  return Object.fromEntries(outputPaths.map((path) => [path, value])) as Record<
    (typeof outputPaths)[number],
    T
  >;
}
test("the folder plan names the first refused file and lists every file to write", () => {
  expect(
    planOutputs({}, all(newDigest), all({ kind: "absent" as const })),
  ).toEqual({
    kind: "write",
    files: outputPaths.map((path) => ({ kind: "create", path })),
  });
  expect(
    planOutputs(
      all(oldDigest),
      all(oldDigest),
      all({ kind: "regular", digest: oldDigest }),
    ),
  ).toEqual({ kind: "unchanged" });
  // Only the Machine document changes; the other files are unchanged.
  const desired = { ...all(oldDigest), "manual/this-machine.md": newDigest };
  expect(
    planOutputs(
      all(oldDigest),
      desired,
      all({ kind: "regular", digest: oldDigest }),
    ),
  ).toEqual({
    kind: "write",
    files: [{ kind: "replace", path: "manual/this-machine.md" }],
  });
  const observed = {
    ...all<{ kind: "regular"; digest: string }>({
      kind: "regular",
      digest: oldDigest,
    }),
    "manual/glossary.md": { kind: "regular" as const, digest: newDigest },
  };
  expect(planOutputs(all(oldDigest), all(newDigest), observed)).toEqual({
    kind: "blocked",
    reason: "drift",
    path: "manual/glossary.md",
  });
});
