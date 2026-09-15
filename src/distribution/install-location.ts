import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";

/** Per-user product location outside any Lazurio Folder: the installation
 * owner root, immutable versioned product directories and, later, the stable
 * entrypoint. Resolution is pure; nothing here inspects or creates paths.
 */
export type InstallLocation = Readonly<{
  base: string;
  owner: string;
  versions: string;
}>;

export function resolveInstallLocation(input: {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
}): InstallLocation {
  if (!isAbsolute(input.homedir)) throw new Error("Absolute home required");
  let base: string;
  if (input.platform === "darwin")
    base = join(input.homedir, "Library", "Application Support", "Lazurio");
  else if (input.platform === "linux") {
    // XDG: a relative XDG_DATA_HOME is invalid and must be ignored.
    const xdg = input.env.XDG_DATA_HOME;
    base =
      xdg && isAbsolute(xdg)
        ? join(xdg, "lazurio")
        : join(input.homedir, ".local", "share", "lazurio");
  } else throw new Error("Unqualified install platform");
  return Object.freeze({
    base,
    owner: join(base, "distribution"),
    versions: join(base, "versions"),
  });
}

/** Creates the private base and its two owner directories when absent and
 * verifies each is canonical, caller-owned and not shared-writable. Existing
 * content is never adopted, repaired or removed.
 */
export async function prepareInstallLocation(location: InstallLocation) {
  for (const path of [location.base, location.owner, location.versions]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await inspectOwnedDirectory(path);
  }
  return location;
}
