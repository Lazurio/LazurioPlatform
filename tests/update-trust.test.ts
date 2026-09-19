import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateFixture } from "../scripts/update-fixture";
import { writeDurableFile } from "../src/update/durable-file";
import { promoteVerified, type Seed } from "../src/update/trust";

// Promotion is exercised directly with scratch contents the pinned client
// would never produce: it must be safe by itself, not by the client's habits.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function directories() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "update-trust-")));
  cleanups.push(() => rm(root, { recursive: true }));
  const trustDirectory = join(root, "trust");
  const scratch = join(root, "scratch");
  await mkdir(trustDirectory);
  await mkdir(scratch);
  return { trustDirectory, scratch };
}

function repository() {
  const fixture = createUpdateFixture({ executionTarget: "linux-x64" });
  cleanups.push(() => fixture.stop());
  fixture.release("stable", { sequence: 1, version: "1.0.0" });
  const text = (path: string) => fixture.served(path)?.toString() ?? "";
  return { fixture, text };
}

test("after a failed refresh the role delivered last becomes a floor only when it re-verifies, by itself, as an authentic newer version", async () => {
  const { fixture, text } = repository();
  const forged = createUpdateFixture({ executionTarget: "linux-x64" });
  cleanups.push(() => forged.stop());
  forged.release("stable", { sequence: 1, version: "1.0.0" });
  const first = {
    timestamp: text("/metadata/timestamp.json"),
    snapshot: text("/metadata/1.snapshot.json"),
  };
  fixture.publish();
  const second = {
    timestamp: text("/metadata/timestamp.json"),
    snapshot: text("/metadata/2.snapshot.json"),
    targets: text("/metadata/2.targets.json"),
  };
  const seed = (roles: Record<string, string>): Seed => ({
    established: true,
    root: fixture.bootstrapRoot.toString(),
    anchor: fixture.bootstrapRoot.toString(),
    repairRoot: false,
    roles: new Map(Object.entries(roles)),
  });
  const promote = async (input: {
    seed: Seed;
    scratch: Record<string, string>;
    delivered: [string, string];
  }) => {
    const { trustDirectory, scratch } = await directories();
    await writeFile(join(scratch, "root.json"), input.seed.root);
    for (const [name, content] of Object.entries(input.scratch))
      await writeFile(join(scratch, name), content);
    // The retained chain (`1.root.json`) is written into the empty directory
    // every time; this test is about the roles.
    return (
      await promoteVerified({
        trustDirectory,
        scratch,
        seed: input.seed,
        fetchedRoots: new Map(),
        lastDelivered: {
          file: input.delivered[0],
          bytes: Buffer.from(input.delivered[1]),
        },
        write: writeDurableFile,
      })
    ).filter((name) => !name.endsWith("root.json"));
  };
  const trusted = { "timestamp.json": first.timestamp };
  // The client never wrote the newer timestamp (it threw); the raw bytes
  // verify under the root and are newer: kept.
  expect(
    await promote({
      seed: seed(trusted),
      scratch: trusted,
      delivered: ["timestamp.json", second.timestamp],
    }),
  ).toEqual(["timestamp.json"]);
  for (const [name, delivered] of [
    // Signed by another repository's timestamp key.
    [
      "foreign signature",
      forged.served("/metadata/timestamp.json")?.toString(),
    ],
    ["damaged signature", second.timestamp.replace(/"sig":"../, '"sig":"00')],
    ["not metadata", "{}"],
    ["not JSON", "\u0000"],
  ] as const)
    expect([
      name,
      await promote({
        seed: seed(trusted),
        scratch: trusted,
        delivered: ["timestamp.json", delivered ?? ""],
      }),
    ]).toEqual([name, []]);
  // Authentic but LOWER or EQUAL: a replay is no floor.
  const newer = { "timestamp.json": second.timestamp };
  for (const delivered of [first.timestamp, second.timestamp])
    expect(
      await promote({
        seed: seed(newer),
        scratch: newer,
        delivered: ["timestamp.json", delivered],
      }),
    ).toEqual([]);

  // Snapshot: held against the newest authenticated timestamp, which the
  // client persisted before it asked for the snapshot.
  const before = {
    "timestamp.json": first.timestamp,
    "snapshot.json": first.snapshot,
  };
  const moved = { ...before, "timestamp.json": second.timestamp };
  expect(
    await promote({
      seed: seed(before),
      scratch: moved,
      delivered: ["snapshot.json", second.snapshot],
    }),
  ).toEqual(["timestamp.json", "snapshot.json"]);
  for (const [name, scratch, delivered] of [
    // Not the snapshot the timestamp names: wrong version and hash.
    ["other version", moved, first.snapshot],
    ["foreign", moved, forged.served("/metadata/1.snapshot.json")?.toString()],
    ["damaged", moved, second.snapshot.replace(/"sig":"../, '"sig":"00')],
    // Without an authenticated timestamp nothing vouches for a snapshot.
    ["no timestamp", {}, second.snapshot],
  ] as const)
    expect([
      name,
      (
        await promote({
          seed: seed(before),
          scratch,
          delivered: ["snapshot.json", delivered ?? ""],
        })
      ).includes("snapshot.json"),
    ]).toEqual([name, false]);
  // Targets carry no floor in the pinned client and are never captured, even
  // when they are perfectly authentic.
  const complete = { ...moved, "snapshot.json": second.snapshot };
  expect(
    await promote({
      seed: seed(before),
      scratch: complete,
      delivered: ["targets.json", second.targets],
    }),
  ).toEqual(["timestamp.json", "snapshot.json"]);
});

test("a root in scratch reaches trust/ only through a verified chain from the seed", async () => {
  const { fixture, text } = repository();
  fixture.rotateRoot();
  const seed: Seed = {
    established: true,
    root: fixture.bootstrapRoot.toString(),
    anchor: fixture.bootstrapRoot.toString(),
    repairRoot: false,
    roles: new Map(),
  };
  const genuine = text("/metadata/2.root.json");
  const forged = createUpdateFixture({ executionTarget: "linux-x64" });
  cleanups.push(() => forged.stop());
  forged.rotateRoot();
  const cases: [string, Map<number, string>][] = [
    // Version 2 of ANOTHER repository: not signed by the seed's root key.
    [forged.served("/metadata/2.root.json")?.toString() ?? "", new Map()],
    // The genuine successor, but its bytes were never received.
    [genuine, new Map()],
  ];
  for (const [final, fetchedRoots] of cases) {
    const { trustDirectory, scratch } = await directories();
    await writeFile(join(scratch, "root.json"), final);
    if (fetchedRoots.size === 0 && final !== genuine)
      fetchedRoots.set(2, final);
    await expect(
      promoteVerified({
        trustDirectory,
        scratch,
        seed,
        fetchedRoots,
        lastDelivered: undefined,
        write: writeDurableFile,
      }),
    ).rejects.toThrow();
    expect(await readdir(trustDirectory)).toEqual([]);
  }
  const { trustDirectory, scratch } = await directories();
  await writeFile(join(scratch, "root.json"), genuine);
  expect(
    await promoteVerified({
      trustDirectory,
      scratch,
      seed,
      fetchedRoots: new Map([[2, genuine]]),
      // A root delivered last needs no special case: the chain is verified
      // link by link whatever the client did with it.
      lastDelivered: { file: "2.root.json", bytes: Buffer.from(genuine) },
      write: writeDurableFile,
    }),
  ).toEqual(["1.root.json", "2.root.json", "root.json"]);
});
