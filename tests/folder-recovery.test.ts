import { expect, test } from "bun:test";
import { instructionRecovery } from "../src/folder/recovery";

const before = "a".repeat(64);
const after = "b".repeat(64);
test("recovery observes bytes rather than trusting a journal phase", () => {
  expect(instructionRecovery(null, after, { kind: "absent" })).toBe(
    "matches-before",
  );
  expect(
    instructionRecovery(before, after, { kind: "regular", digest: before }),
  ).toBe("matches-before");
  for (const previous of [null, before])
    expect(
      instructionRecovery(previous, after, { kind: "regular", digest: after }),
    ).toBe("matches-after");
});
test("matching fresh-create content cannot distinguish our write from another actor", () => {
  // A different actor can create identical bytes after transaction preparation.
  // The classifier must not report activation or adopt that file's ownership.
  expect(
    instructionRecovery(null, after, { kind: "regular", digest: after }),
  ).toBe("matches-after");
});
test("missing old output, unsafe paths and post-interruption edits block recovery", () => {
  expect(instructionRecovery(before, after, { kind: "absent" })).toBe(
    "conflict",
  );
  expect(instructionRecovery(before, after, { kind: "unsafe" })).toBe(
    "conflict",
  );
  expect(
    instructionRecovery(before, after, {
      kind: "regular",
      digest: "c".repeat(64),
    }),
  ).toBe("conflict");
  expect(
    instructionRecovery(null, after, { kind: "regular", digest: before }),
  ).toBe("conflict");
});
test("invalid or indistinguishable transitions cannot be recovered as success", () => {
  expect(
    instructionRecovery(before, before, { kind: "regular", digest: before }),
  ).toBe("invalid-transaction");
  expect(instructionRecovery("invalid", after, { kind: "absent" })).toBe(
    "invalid-transaction",
  );
  expect(instructionRecovery(null, "invalid", { kind: "absent" })).toBe(
    "invalid-transaction",
  );
});
