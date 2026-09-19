import {
  type ChannelDocument,
  parseChannelDocument,
  type UpdateChannel,
} from "../update/channel";
import { PublishError } from "./errors";

/** Bytes of `channels/<channel>.json`. The format has ONE owner, the client's
 * parser (`src/update/channel.ts`): whatever is built here is parsed by it
 * before it is returned, so the publisher can never sign a document that an
 * installed Lazurio refuses.
 */
export function channelDocumentBytes(input: {
  channel: UpdateChannel;
  sequence: number;
  version: string;
  minimumVersion: string;
  /** Execution target → `artifacts/<sha256>/lazurio`. */
  targets: Readonly<Record<string, string>>;
}): Buffer {
  const targets: Record<string, string> = {};
  for (const target of Object.keys(input.targets).sort())
    targets[target] = input.targets[target] as string;
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      channel: input.channel,
      sequence: input.sequence,
      version: input.version,
      minimumVersion: input.minimumVersion,
      targets,
    }),
  );
  try {
    parseChannelDocument(bytes, input.channel);
  } catch {
    throw new PublishError("invalid-input", "channel-document");
  }
  return bytes;
}

export function sameRelease(
  document: ChannelDocument,
  version: string,
  targets: Readonly<Record<string, string>>,
): boolean {
  const names = Object.keys(targets).sort();
  return (
    document.version === version &&
    Object.keys(document.targets).sort().join() === names.join() &&
    names.every((name) => document.targets[name] === targets[name])
  );
}
