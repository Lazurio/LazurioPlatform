import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTrustCheckpoint,
  readTrustCheckpoint,
  writeNewTrustCheckpoint,
} from "../src/distribution/trust-checkpoint";

test("checkpoint rejects executable and inherited fields without invoking getters", () => {
  let invoked = false;
  const input = {
    schemaVersion: 1,
    get metadata() {
      invoked = true;
      return {};
    },
  };
  expect(() => parseTrustCheckpoint(input)).toThrow("Executable");
  expect(invoked).toBe(false);
  expect(() =>
    parseTrustCheckpoint(Object.create({ schemaVersion: 1, metadata: {} })),
  ).toThrow();
  const metadata = Object.defineProperty(
    { timestamp: "", snapshot: "", targets: "" },
    "root",
    {
      enumerable: true,
      get() {
        invoked = true;
        return "";
      },
    },
  );
  expect(() => parseTrustCheckpoint({ schemaVersion: 1, metadata })).toThrow(
    "Executable",
  );
  expect(invoked).toBe(false);
});

test("immutable checkpoint preserves bytes, refuses replacement and damaged state", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "trust-checkpoint-")),
  );
  const directory = join(parent, "generation");
  const metadata = Object.fromEntries(
    ["root", "timestamp", "snapshot", "targets"].map((role) => [
      role,
      JSON.stringify({ signed: { _type: role, version: 1 }, signatures: [] }),
    ]),
  );
  const fixture = parseTrustCheckpoint({ schemaVersion: 1, metadata });
  try {
    await writeNewTrustCheckpoint(directory, fixture);
    expect(await readTrustCheckpoint(directory)).toEqual(fixture);
    const before = await readFile(join(directory, "trust.json"));
    await expect(writeNewTrustCheckpoint(directory, fixture)).rejects.toThrow();
    expect(await readFile(join(directory, "trust.json"))).toEqual(before);
    await writeFile(join(directory, "trust.json"), "\u0000");
    await expect(readTrustCheckpoint(directory)).rejects.toThrow();
    expect(await readFile(join(directory, "trust.json"), "utf8")).toBe(
      "\u0000",
    );
    expect(() =>
      parseTrustCheckpoint({
        schemaVersion: 1,
        metadata: { root: metadata.root },
      }),
    ).toThrow();
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("competing checkpoint creation has one winner and linked output is never adopted", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "trust-contention-")),
  );
  const directory = join(parent, "generation");
  const metadata = Object.fromEntries(
    ["root", "timestamp", "snapshot", "targets"].map((role) => [
      role,
      JSON.stringify({ signed: { _type: role, version: 1 }, signatures: [] }),
    ]),
  );
  const fixture = parseTrustCheckpoint({ schemaVersion: 1, metadata });
  try {
    const results = await Promise.allSettled([
      writeNewTrustCheckpoint(directory, fixture),
      writeNewTrustCheckpoint(directory, fixture),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await readTrustCheckpoint(directory)).toEqual(fixture);
    const before = await readFile(join(directory, "trust.json"));
    const alias = join(parent, "alias");
    await symlink(directory, alias);
    await expect(writeNewTrustCheckpoint(alias, fixture)).rejects.toThrow();
    await expect(readTrustCheckpoint(alias)).rejects.toThrow();
    expect(await readFile(join(directory, "trust.json"))).toEqual(before);
  } finally {
    await rm(parent, { recursive: true });
  }
});
