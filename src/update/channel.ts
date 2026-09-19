import { createHash } from "node:crypto";
import { parseUniqueJson } from "../providers/unique-json";
import { UpdateFailure } from "./errors";
import { isProductVersion, updateTargets } from "./identity";

/** Channels are `stable` and `preview` (docs/update.md "Publishing"). */
export const updateChannels = ["stable", "preview"] as const;
export type UpdateChannel = (typeof updateChannels)[number];

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return (updateChannels as readonly unknown[]).includes(value);
}

/** Signed TUF target path of a channel document. */
export function channelTargetPath(channel: UpdateChannel): string {
  return `channels/${channel}.json`;
}

/** A channel document is one small signed file, so a check stays cheap. */
export const maxChannelDocumentBytes = 64 * 1024;

export type ChannelFloor = Readonly<{
  sequence: number;
  documentSha256: string;
}>;

export type ChannelDocument = Readonly<{
  channel: UpdateChannel;
  sequence: number;
  documentSha256: string;
  version: string;
  minimumVersion: string;
  /** Execution target → `artifacts/<sha256>/lazurio`. */
  targets: Readonly<Record<string, string>>;
}>;

const fields = [
  "channel",
  "minimumVersion",
  "schemaVersion",
  "sequence",
  "targets",
  "version",
];

export function isChannelFloor(value: unknown): value is ChannelFloor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "documentSha256,sequence" &&
    typeof record.sequence === "number" &&
    Number.isSafeInteger(record.sequence) &&
    record.sequence >= 1 &&
    typeof record.documentSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.documentSha256)
  );
}

/** Parse ONLY bytes that TUF already verified against signed targets; this
 * function authenticates nothing. It keeps the invariants of the pilot parser
 * (`src/distribution/channel.ts`): unique members, an exact field set, a
 * digest-addressed artifact path per known target, and a channel that must
 * equal the one asked for so a document can never be replayed across channels.
 * It adds what a check needs without touching the artifact: the product
 * version and the signed minimum version.
 */
export function parseChannelDocument(
  authenticatedBytes: Uint8Array,
  channel: UpdateChannel,
): ChannelDocument {
  const invalid = (reason: string) =>
    new UpdateFailure("channel-invalid", { channel, reason });
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(authenticatedBytes);
    value = parseUniqueJson(text);
  } catch {
    throw invalid("malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("malformed");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== fields.join(","))
    throw invalid("unknown-fields");
  // A newer document format is a publisher/binary mismatch, not an attack; it
  // is still refused rather than guessed.
  if (record.schemaVersion !== 1) throw invalid("unsupported-schema");
  if (record.channel !== channel) throw invalid("wrong-channel");
  if (
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1
  )
    throw invalid("sequence");
  if (
    !isProductVersion(record.version) ||
    !isProductVersion(record.minimumVersion)
  )
    throw invalid("version");
  if (
    !record.targets ||
    typeof record.targets !== "object" ||
    Array.isArray(record.targets)
  )
    throw invalid("targets");
  const targets: Record<string, string> = {};
  for (const [target, path] of Object.entries(record.targets)) {
    // A name here is the publisher's claim, not native qualification; the
    // download step still verifies the signed identity of the bytes.
    if (
      !(updateTargets as readonly string[]).includes(target) ||
      typeof path !== "string" ||
      !/^artifacts\/[a-f0-9]{64}\/lazurio$/.test(path)
    )
      throw invalid("targets");
    targets[target] = path;
  }
  return Object.freeze({
    channel,
    sequence: record.sequence,
    documentSha256: createHash("sha256")
      .update(authenticatedBytes)
      .digest("hex"),
    version: record.version,
    minimumVersion: record.minimumVersion,
    targets: Object.freeze(targets),
  });
}

/** Monotonic floor: a lower sequence, or the same sequence with different
 * bytes, is refused. Identical authenticated bytes are a normal repeat.
 */
export function assertNotRolledBack(
  document: ChannelDocument,
  floor: ChannelFloor | undefined,
): void {
  if (!floor) return;
  if (
    document.sequence < floor.sequence ||
    (document.sequence === floor.sequence &&
      document.documentSha256 !== floor.documentSha256)
  )
    throw new UpdateFailure("channel-rollback", {
      channel: document.channel,
      floorSequence: floor.sequence,
      offeredSequence: document.sequence,
    });
}
