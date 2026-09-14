import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { type Fetcher, Updater } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import {
  readOwnedDeclarationBytes,
  readOwnedJson,
} from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import { selectPilotTarget } from "./channel";
import {
  parseTrustCheckpoint,
  writeNewTrustCheckpoint,
} from "./trust-checkpoint";

/** Bounded offline reverification after metadata/channel delivery. Not a general
 * crash-recovery owner: expired/incomplete evidence fails closed, and the caller
 * must serialize access and publish the returned trust before a new attempt.
 * The owner must bind source to its recorded attempt and trusted original input;
 * filesystem ownership alone does not authenticate an arbitrary bootstrap root.
 * No network fetch or artifact execution is reachable from this operation.
 */
export async function replayPilotTrust(
  source: string,
  output: string,
  executionTarget: string,
) {
  await inspectOwnedDirectory(source);
  const input = (await readOwnedJson(
    join(source, "input-trust.json"),
  )) as Record<string, unknown>;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "channel,kind,metadata,schemaVersion" ||
    input.schemaVersion !== 1
  )
    throw new Error("Invalid retained pilot input");
  let metadata: Readonly<Record<string, string>>;
  let previous: { sequence: number; documentSha256: string } | undefined;
  if (input.kind === "established") {
    metadata = parseTrustCheckpoint({
      schemaVersion: 1,
      metadata: input.metadata,
    }).metadata;
    const channel = input.channel as Record<string, unknown>;
    if (
      !channel ||
      typeof channel !== "object" ||
      Array.isArray(channel) ||
      Object.keys(channel).sort().join(",") !== "documentSha256,sequence" ||
      !Number.isSafeInteger(channel.sequence) ||
      (channel.sequence as number) < 1 ||
      typeof channel.documentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(channel.documentSha256)
    )
      throw new Error("Invalid retained channel high-water");
    previous = {
      sequence: channel.sequence as number,
      documentSha256: channel.documentSha256,
    };
  } else if (input.kind === "bootstrap") {
    const candidate = input.metadata as Record<string, unknown>;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).join(",") !== "root" ||
      typeof candidate.root !== "string" ||
      input.channel !== null
    )
      throw new Error("Invalid retained bootstrap");
    metadata = { root: candidate.root };
    parseUniqueJson(candidate.root);
  } else throw new Error("Unknown retained trust kind");

  const journal = join(source, "received-metadata");
  await inspectOwnedDirectory(journal);
  const names = (await readdir(journal)).sort();
  if (names.length > 260) throw new Error("Replay record limit");
  const records: { name: string; bytes: Buffer }[] = [];
  let length = 0;
  for (const [index, name] of names.entries()) {
    const prefix = `${String(index + 1).padStart(3, "0")}-`;
    const leaf = name.slice(prefix.length);
    if (
      !name.startsWith(prefix) ||
      !/^(?:[1-9][0-9]*\.)?(?:root|timestamp|snapshot|targets)\.json$/.test(
        leaf,
      )
    )
      throw new Error("Incomplete or unknown replay record");
    const bytes = await readOwnedDeclarationBytes(join(journal, name));
    length += bytes.length;
    if (length > 32 * 1024 * 1024) throw new Error("Replay byte limit");
    records.push({ name: leaf, bytes });
  }
  await inspectOwnedDirectory(dirname(output));
  await mkdir(output, { mode: 0o700 });
  const cache = join(output, "metadata");
  await mkdir(cache, { mode: 0o700 });
  for (const [role, bytes] of Object.entries(metadata))
    await writeFile(join(cache, `${role}.json`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  let cursor = 0;
  const base = "https://replay.invalid/metadata/";
  const fetcher: Fetcher = {
    async downloadBytes(url, maxLength) {
      if (!url.startsWith(base)) throw new Error("Unexpected replay origin");
      const name = url.slice(base.length);
      const record = records[cursor];
      if (record?.name === name) {
        if (record.bytes.length > maxLength)
          throw new Error("Replay metadata length refused");
        cursor++;
        return record.bytes;
      }
      if (
        /^[1-9][0-9]*\.root\.json$/.test(name) &&
        !records
          .slice(cursor)
          .some((entry) => entry.name.endsWith(".root.json"))
      )
        throw new DownloadHTTPError("No further received root", 404);
      throw new Error("Missing or out-of-order replay response");
    },
    async downloadFile() {
      throw new Error("Replay cannot download artifacts");
    },
  };
  const updater = new Updater({
    metadataDir: cache,
    metadataBaseUrl: base,
    fetcher,
    config: { fetchRetries: 0, fetchRetry: false, maxDelegations: 0 },
  });
  await updater.refresh();
  if (cursor !== records.length) throw new Error("Unconsumed replay evidence");
  const target = await updater.getTargetInfo("channels/pilot.json");
  if (!target || target.length > 64 * 1024)
    throw new Error("Replay channel unavailable or oversized");
  const channelBytes = await readOwnedDeclarationBytes(
    join(source, "channel.json"),
  );
  await target.verify(Readable.from([channelBytes]));
  const selection = selectPilotTarget(
    new TextDecoder("utf-8", { fatal: true }).decode(channelBytes),
    executionTarget,
    previous,
  );
  const verifiedMetadata: Record<string, string> = {};
  for (const role of ["root", "timestamp", "snapshot", "targets"])
    verifiedMetadata[role] = await readFile(
      join(cache, `${role}.json`),
      "utf8",
    );
  const checkpoint = parseTrustCheckpoint({
    schemaVersion: 1,
    metadata: verifiedMetadata,
  });
  const channel = await open(join(output, "channel.json"), "wx", 0o600);
  try {
    await channel.writeFile(channelBytes);
    await channel.sync();
  } finally {
    await channel.close();
  }
  await writeNewTrustCheckpoint(join(output, "checkpoint"), checkpoint);
  // Sync the new output's name too, not only its contents.
  const parent = await open(dirname(output), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return Object.freeze({ checkpoint, selection });
}
