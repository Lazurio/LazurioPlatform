import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isUpdateChannel, type UpdateChannel } from "./channel";
import { defaultChannel } from "./defaults";
import type { DurableWriter } from "./durable-file";
import { layout } from "./layout";

/** `update/config.json` holds only the channel (docs/update.md "Identity in
 * the binary"). It selects nothing that runs and carries no trust: a missing,
 * damaged or newer-schema file means the default channel and is replaced by
 * the next `lazurio update channel <name>`. It can never wedge an update.
 */
const configName = "config.json";

export async function readChannel(base: string): Promise<UpdateChannel> {
  try {
    const value = JSON.parse(
      await readFile(join(layout(base).update, configName), "utf8"),
    ) as Record<string, unknown> | null;
    return value?.schemaVersion === 1 && isUpdateChannel(value.channel)
      ? value.channel
      : defaultChannel;
  } catch {
    return defaultChannel;
  }
}

export async function writeChannel(
  base: string,
  channel: UpdateChannel,
  write: DurableWriter,
): Promise<void> {
  await write(
    layout(base).update,
    configName,
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, channel })}\n`),
  );
}
