import { mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedJson } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";

const roles = ["root", "timestamp", "snapshot", "targets"] as const;
type Role = (typeof roles)[number];
/** Exact own data fields only: no prototype, extra, missing or accessor members. */
export function exactFields(
  input: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("Invalid trust checkpoint object");
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  )
    throw new Error("Unknown or missing trust checkpoint field");
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error("Executable trust checkpoint field");
    result[key] = descriptor.value;
  }
  return result;
}
export type TrustCheckpoint = Readonly<{
  schemaVersion: 1;
  metadata: Readonly<Record<Role, string>>;
}>;

// This validates storage shape, NOT signatures, freshness, or a trust bootstrap.
// Only the installation owner may promote a cryptographically verified checkpoint.
export function parseTrustCheckpoint(input: unknown): TrustCheckpoint {
  const value = exactFields(input, ["metadata", "schemaVersion"]);
  if (value.schemaVersion !== 1)
    throw new Error("Unsupported trust checkpoint");
  const metadata = exactFields(value.metadata, roles);
  const result = {} as Record<Role, string>;
  for (const role of roles) {
    const bytes = metadata[role];
    if (typeof bytes !== "string") throw new Error("Invalid metadata bytes");
    const parsed = parseUniqueJson(bytes);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid metadata envelope");
    const envelope = parsed as Record<string, unknown>;
    const signed = envelope.signed as Record<string, unknown> | undefined;
    if (
      !Array.isArray(envelope.signatures) ||
      !signed ||
      typeof signed !== "object" ||
      signed._type !== role ||
      !Number.isSafeInteger(signed.version) ||
      (signed.version as number) < 1
    )
      throw new Error("Wrong metadata role or version");
    result[role] = bytes;
  }
  return Object.freeze({ schemaVersion: 1, metadata: Object.freeze(result) });
}

/** New immutable checkpoint only. Existing output, even empty, is never adopted.
 * A failure retains the partial directory; no automatic repair or trust reset.
 */
export async function writeNewTrustCheckpoint(
  directory: string,
  input: TrustCheckpoint,
) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Unqualified trust storage platform");
  const value = parseTrustCheckpoint(input);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1024 * 1024)
    throw new Error("Trust checkpoint exceeds storage envelope");
  await inspectOwnedDirectory(dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  const file = await open(join(directory, "trust.json"), "wx", 0o600);
  try {
    await file.writeFile(encoded);
    await file.sync();
  } finally {
    await file.close();
  }
  for (const path of [directory, dirname(directory)]) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function readTrustCheckpoint(
  directory: string,
): Promise<TrustCheckpoint> {
  await inspectOwnedDirectory(directory);
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] !== "trust.json")
    throw new Error("Incomplete or unrecognized trust checkpoint directory");
  return parseTrustCheckpoint(
    await readOwnedJson(join(directory, "trust.json")),
  );
}
