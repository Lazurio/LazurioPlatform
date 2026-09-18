import { createHash } from "node:crypto";
import { parseUniqueJson } from "../providers/unique-json";

/** Execution targets a channel may name. A name is not native qualification. */
export const pilotTargets: ReadonlySet<string> = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-arm64",
  "windows-x64",
]);

export type ChannelSelection = Readonly<{
  sequence: number;
  documentSha256: string;
  targetPath: string;
}>;

/** Parse only AFTER TUF target verification. This function authenticates nothing.
 * The persisted high-water mark must come from the same installation owner.
 */
export function selectPilotTarget(
  authenticatedJson: string,
  executionTarget: string,
  previous?: Readonly<{ sequence: number; documentSha256: string }>,
): ChannelSelection {
  const value = parseUniqueJson(authenticatedJson);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid channel document");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "channel,schemaVersion,sequence,targets" ||
    record.schemaVersion !== 1 ||
    record.channel !== "pilot" ||
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    !record.targets ||
    typeof record.targets !== "object" ||
    Array.isArray(record.targets)
  )
    throw new Error("Unsupported channel document");
  const targets = record.targets as Record<string, unknown>;
  const supported = pilotTargets;
  for (const [target, path] of Object.entries(targets)) {
    // A target name does not establish native qualification. The release owner
    // must publish only qualified entries; the consumer still checks identity.
    if (
      !supported.has(target) ||
      typeof path !== "string" ||
      !/^artifacts\/[a-f0-9]{64}\/lazurio(?:\.exe)?$/.test(path) ||
      path.endsWith(".exe") !== target.startsWith("windows-")
    )
      throw new Error("Invalid channel artifact target");
  }
  if (
    !supported.has(executionTarget) ||
    !Object.hasOwn(targets, executionTarget)
  )
    throw new Error("Execution target unavailable in channel");
  const documentSha256 = createHash("sha256")
    .update(authenticatedJson)
    .digest("hex");
  if (previous) {
    if (
      !Number.isSafeInteger(previous.sequence) ||
      previous.sequence < 1 ||
      !/^[a-f0-9]{64}$/.test(previous.documentSha256)
    )
      throw new Error("Invalid channel high-water mark");
    if (
      record.sequence < previous.sequence ||
      (record.sequence === previous.sequence &&
        documentSha256 !== previous.documentSha256)
    )
      throw new Error("Channel rollback or sequence reuse refused");
  }
  return Object.freeze({
    sequence: record.sequence,
    documentSha256,
    targetPath: targets[executionTarget] as string,
  });
}
