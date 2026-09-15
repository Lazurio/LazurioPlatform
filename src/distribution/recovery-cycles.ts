import { lstat, mkdir, mkdtemp, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedJson } from "../providers/owned-json";
import {
  continueHistoricalRoles,
  type HistoricalFloors,
  historicalFloorFingerprint,
} from "./historical-roles";
import { readMetadataJournal } from "./metadata-journal";
import { exactFields } from "./trust-checkpoint";

function target(value: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value))
    throw new Error("Invalid recovery execution target");
}

/** Reconstruct metadata floors from original owner-bound trust and every cycle.
 * No serialized floor values or mutable client caches are authority. The caller
 * holds the installation owner lock for the entire read/use operation. This
 * metadata-only ledger does not yet carry channel evidence or publish trust.
 */
export async function reconstructRecoveryCycles(
  attempt: string,
  original: HistoricalFloors,
  executionTarget: string,
) {
  target(executionTarget);
  let floors = continueHistoricalRoles(original, []);
  await inspectOwnedDirectory(attempt);
  const parent = join(attempt, "recovery-cycles");
  try {
    await lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return Object.freeze({ floors, count: 0, records: 0, bytes: 0 });
    throw error;
  }
  await inspectOwnedDirectory(parent);
  const names = (await readdir(parent)).sort();
  if (names.length > 32) throw new Error("Recovery cycle limit");
  let records = 0;
  let bytes = 0;
  for (const [index, name] of names.entries()) {
    if (name !== String(index + 1).padStart(6, "0"))
      throw new Error("Gapped or unknown recovery cycle");
    const directory = join(parent, name);
    await inspectOwnedDirectory(directory);
    if (
      (await readdir(directory)).sort().join(",") !==
      "input.json,received-metadata"
    )
      throw new Error("Incomplete or unknown recovery cycle state");
    const input = exactFields(
      await readOwnedJson(join(directory, "input.json")),
      ["schemaVersion", "root", "executionTarget", "priorSha256"],
    );
    if (
      input.schemaVersion !== 1 ||
      input.root !== floors.root ||
      input.priorSha256 !== historicalFloorFingerprint(floors) ||
      input.executionTarget !== executionTarget
    )
      throw new Error(
        "Recovery cycle input does not match reconstructed trust",
      );
    const journal = await readMetadataJournal(
      join(directory, "received-metadata"),
    );
    records += journal.records.length;
    bytes += journal.bytes;
    if (records > 260 || bytes > 32 * 1024 * 1024)
      throw new Error("Recovery cycle aggregate evidence limit");
    floors = continueHistoricalRoles(
      floors,
      journal.records.map((record) => ({
        name: record.name,
        bytes: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(record.bytes),
      })),
    );
  }
  return Object.freeze({ floors, count: names.length, records, bytes });
}

/** Publish an empty cycle before any request is made. The owner must supply its
 * held-lock assertion and original bound floors, not a root chosen by the server.
 * Unpublished initialization directories cannot have received network evidence;
 * they are retained outside the ledger and never adopted or automatically erased.
 * There is no new lock, selected trust pointer, networking or artifact operation.
 */
export async function beginRecoveryCycle(
  attempt: string,
  original: HistoricalFloors,
  executionTarget: string,
  assertHeld: () => Promise<void>,
) {
  await assertHeld();
  const prior = await reconstructRecoveryCycles(
    attempt,
    original,
    executionTarget,
  );
  if (
    prior.count >= 32 ||
    prior.records >= 260 ||
    prior.bytes >= 32 * 1024 * 1024
  )
    throw new Error("Recovery cycle evidence limit reached");
  const encoded = JSON.stringify({
    schemaVersion: 1,
    root: prior.floors.root,
    priorSha256: historicalFloorFingerprint(prior.floors),
    executionTarget,
  });
  if (Buffer.byteLength(encoded) > 1024 * 1024)
    throw new Error("Recovery input exceeds declaration limit");
  await assertHeld();
  const parent = join(attempt, "recovery-cycles");
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await inspectOwnedDirectory(parent);
  const temporary = await mkdtemp(join(attempt, ".recovery-init-"));
  const input = await open(join(temporary, "input.json"), "wx", 0o400);
  try {
    await input.writeFile(encoded);
    await input.sync();
  } finally {
    await input.close();
  }
  await mkdir(join(temporary, "received-metadata"), { mode: 0o700 });
  await sync(join(temporary, "received-metadata"));
  await sync(temporary);
  const directory = join(parent, String(prior.count + 1).padStart(6, "0"));
  await assertHeld();
  try {
    await lstat(directory);
    throw new Error("Recovery cycle destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(temporary, directory);
  await sync(parent);
  await sync(attempt);
  await assertHeld();
  return Object.freeze({
    directory,
    journal: join(directory, "received-metadata"),
    floors: prior.floors,
    priorRecords: prior.records,
    priorBytes: prior.bytes,
  });
}

async function sync(directory: string) {
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
