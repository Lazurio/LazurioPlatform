import { expect, test } from "bun:test";
import { selectPilotTarget } from "../src/distribution/channel";

const document = (sequence = 2) => ({
  schemaVersion: 1,
  channel: "pilot",
  sequence,
  targets: { "linux-arm64": `artifacts/${"a".repeat(64)}/lazurio` },
});

test("channel selects exact execution target and preserves immutable sequence identity", () => {
  const json = JSON.stringify(document());
  const selected = selectPilotTarget(json, "linux-arm64");
  expect(selected.targetPath).toBe(document().targets["linux-arm64"]);
  expect(selectPilotTarget(json, "linux-arm64", selected)).toEqual(selected);
  expect(() =>
    selectPilotTarget(JSON.stringify(document(1)), "linux-arm64", selected),
  ).toThrow("rollback");
  expect(() => selectPilotTarget(`${json}\n`, "linux-arm64", selected)).toThrow(
    "sequence reuse",
  );
  expect(
    selectPilotTarget(JSON.stringify(document(3)), "linux-arm64", selected)
      .sequence,
  ).toBe(3);
  expect(() => selectPilotTarget(json, "windows-arm64")).toThrow("unavailable");
});

test("channel refuses alternate channels, ambiguous JSON, malformed targets and unknown fields", () => {
  for (const change of [
    { channel: "stable" },
    { schemaVersion: 2 },
    { extra: true },
    { sequence: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { targets: { "linux-arm64": "../lazurio" } },
    { targets: { "linux-arm64": `artifacts/${"a".repeat(64)}/lazurio.exe` } },
    { targets: { "unsupported-os": `artifacts/${"a".repeat(64)}/lazurio` } },
  ])
    expect(() =>
      selectPilotTarget(
        JSON.stringify({ ...document(), ...change }),
        "linux-arm64",
      ),
    ).toThrow();
  expect(() =>
    selectPilotTarget('{"sequence":1,"sequence":2}', "linux-arm64"),
  ).toThrow("Duplicate");
});
