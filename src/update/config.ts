import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseServiceSpec, type ServiceSpec } from "./activation-record";
import { isUpdateChannel, type UpdateChannel } from "./channel";
import { defaultChannel } from "./defaults";
import type { DurableWriter } from "./durable-file";
import { layout } from "./layout";

/** `update/config.json`: the ONE owned file of local update choices, so that
 * `lazurio update` needs no flag for them —
 *
 *   channel   which channel a check reads (`lazurio update channel <name>`);
 *   service   which supervisor owns the Launchpad (`lazurio install`);
 *   folder    which Folder a candidate must prove it can read (`install`).
 *
 * It selects nothing that runs and carries no trust. It is tolerant state,
 * field by field: a missing or damaged file, another schema version, or one
 * unusable member means the default for what cannot be read — `stable`, no
 * managed service, no Folder check — never an error, and a flag always
 * overrides it. There is one reader and one writer; the writer changes only
 * the members it is given, so choosing a channel never forgets the service
 * and an installation never forgets the channel.
 */
export type UpdateConfig = Readonly<{
  channel: UpdateChannel;
  service: ServiceSpec;
  folder: string | null;
}>;

const configName = "config.json";
export const defaultUpdateConfig: UpdateConfig = Object.freeze({
  channel: defaultChannel,
  service: Object.freeze({ kind: "none" }),
  folder: null,
});

export async function readUpdateConfig(base: string): Promise<UpdateConfig> {
  try {
    const value = JSON.parse(
      await readFile(join(layout(base).update, configName), "utf8"),
    ) as Record<string, unknown> | null;
    if (value?.schemaVersion !== 1) return defaultUpdateConfig;
    const service = parseServiceSpec(value.service);
    return Object.freeze({
      channel: isUpdateChannel(value.channel)
        ? value.channel
        : defaultUpdateConfig.channel,
      // Service and Folder were decided together; one without the other
      // would check a Folder for a supervisor that is not recorded.
      service: service ?? defaultUpdateConfig.service,
      folder:
        service && typeof value.folder === "string" && isAbsolute(value.folder)
          ? value.folder
          : null,
    });
  } catch {
    return defaultUpdateConfig;
  }
}

/** Change the given members and keep the others as they can be read now.
 * Returns the bytes that were replaced (undefined: there was no file), so a
 * caller that undoes its work can put back exactly what was there.
 */
export async function changeUpdateConfig(
  base: string,
  change: Partial<UpdateConfig>,
  write: DurableWriter,
): Promise<Buffer | undefined> {
  const path = join(layout(base).update, configName);
  const previous = await readFile(path).catch(() => undefined);
  const config = { ...(await readUpdateConfig(base)), ...change };
  await write(
    layout(base).update,
    configName,
    Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, ...config }, null, 2)}\n`,
    ),
  );
  return previous;
}
