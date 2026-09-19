import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseServiceSpec, type ServiceSpec } from "./activation-record";
import type { DurableWriter } from "./durable-file";
import { layout } from "./layout";

/** `update/config.json`: what `lazurio install` decided about THIS Machine, so
 * that `lazurio update` needs no flag for it — which supervisor owns the
 * Launchpad, and which Folder a candidate must prove it can read. It is
 * tolerant state: missing or damaged means the defaults (no managed service,
 * no Folder check), never an error, and a flag always overrides it.
 */
export type UpdateConfig = Readonly<{
  service: ServiceSpec;
  folder: string | null;
}>;

const configName = "config.json";
export const defaultUpdateConfig: UpdateConfig = Object.freeze({
  service: Object.freeze({ kind: "none" }),
  folder: null,
});

export async function readUpdateConfig(base: string): Promise<UpdateConfig> {
  try {
    const value = JSON.parse(
      await readFile(join(layout(base).update, configName), "utf8"),
    ) as Record<string, unknown> | null;
    const service = parseServiceSpec(value?.service);
    if (value?.schemaVersion !== 1 || !service) return defaultUpdateConfig;
    return Object.freeze({
      service,
      folder:
        typeof value.folder === "string" && isAbsolute(value.folder)
          ? value.folder
          : null,
    });
  } catch {
    return defaultUpdateConfig;
  }
}

export async function writeUpdateConfig(
  base: string,
  config: UpdateConfig,
  write: DurableWriter,
): Promise<void> {
  await write(
    layout(base).update,
    configName,
    Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, ...config }, null, 2)}\n`,
    ),
  );
}
