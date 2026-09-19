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

test("the role delivered last in a failed refresh is withheld together with everything after it", async () => {
  const { trustDirectory, scratch } = await directories();
  const { fixture, text } = repository();
  const seed: Seed = {
    established: false,
    root: fixture.bootstrapRoot.toString(),
    anchor: fixture.bootstrapRoot.toString(),
    repairRoot: false,
    roles: new Map(),
  };
  await writeFile(join(scratch, "root.json"), seed.root);
  await writeFile(
    join(scratch, "timestamp.json"),
    text("/metadata/timestamp.json"),
  );
  await writeFile(
    join(scratch, "snapshot.json"),
    text("/metadata/1.snapshot.json"),
  );
  await writeFile(
    join(scratch, "targets.json"),
    text("/metadata/1.targets.json"),
  );
  expect(
    await promoteVerified({
      trustDirectory,
      scratch,
      seed,
      fetchedRoots: new Map(),
      unsettledFile: "snapshot.json",
      write: writeDurableFile,
    }),
  ).toEqual(["1.root.json", "root.json", "timestamp.json"]);
  expect((await readdir(trustDirectory)).sort()).toEqual([
    "1.root.json",
    "root.json",
    "timestamp.json",
  ]);
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
  const cases: [string, Map<number, string>, string | undefined][] = [
    // Version 2 of ANOTHER repository: not signed by the seed's root key.
    [
      forged.served("/metadata/2.root.json")?.toString() ?? "",
      new Map(),
      undefined,
    ],
    // The genuine successor, but its bytes were never received.
    [genuine, new Map(), undefined],
    // Received, but delivered last in a refresh that then failed.
    [genuine, new Map([[2, genuine]]), "2.root.json"],
  ];
  for (const [final, fetchedRoots, unsettledFile] of cases) {
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
        unsettledFile,
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
      unsettledFile: undefined,
      write: writeDurableFile,
    }),
  ).toEqual(["1.root.json", "2.root.json", "root.json"]);
});
