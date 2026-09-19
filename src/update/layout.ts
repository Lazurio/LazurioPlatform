import { randomBytes } from "node:crypto";
import { chmod, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { removeAbandonedTemporaries, syncDirectory } from "./durable-file";
import { isProductVersion } from "./identity";

/** Owned names inside the install base (docs/update.md "State on disk").
 * Everything else in the base is someone else's and is never inspected.
 */
export const executableName = "lazurio";

export const layout = (base: string) =>
  Object.freeze({
    bin: join(base, "bin"),
    selector: join(base, "bin", executableName),
    versions: join(base, "versions"),
    update: join(base, "update"),
    stepLock: join(base, "update", "lock"),
    /** Held by an activation worker for its whole life; the kernel releases
     * it when the worker dies, so "held" means "a worker is alive". */
    activationLock: join(base, "update", "activation.lock"),
  });

const namePattern = /^([0-9A-Za-z.-]+)\+([0-9a-f]{16})$/;

export function versionName(version: string, artifactSha256: string): string {
  if (!isProductVersion(version) || !/^[a-f0-9]{64}$/.test(artifactSha256))
    throw new Error("Invalid version name input");
  return `${version}+${artifactSha256.slice(0, 16)}`;
}

export function parseVersionName(
  name: unknown,
): Readonly<{ version: string; sha16: string }> | undefined {
  const match = typeof name === "string" ? namePattern.exec(name) : null;
  if (!match || !isProductVersion(match[1])) return undefined;
  return Object.freeze({ version: match[1], sha16: match[2] as string });
}

export const versionDirectory = (base: string, name: string) =>
  join(layout(base).versions, name);
export const versionExecutable = (base: string, name: string) =>
  join(layout(base).versions, name, executableName);

const selectorTarget = (name: string) =>
  `../versions/${name}/${executableName}`;

/** The selector is the only record of the active version. Only its literal
 * target is read; a link of any other shape selects nothing this product owns.
 */
export async function readSelector(base: string): Promise<string | null> {
  let link: string;
  try {
    link = await readlink(layout(base).selector);
  } catch {
    return null;
  }
  const match = /^\.\.\/versions\/([^/]+)\/lazurio$/.exec(link);
  return match && parseVersionName(match[1]) ? (match[1] as string) : null;
}

/** Point the selector at `versions/<name>` by one atomic rename, so a reader —
 * or a Machine that loses power — sees the old or the new target, never none.
 * A running executable is never touched.
 */
export async function swapSelector(base: string, name: string): Promise<void> {
  if (!parseVersionName(name)) throw new Error("Invalid version name");
  const { bin, selector } = layout(base);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await chmod(bin, 0o700);
  // Callers hold the step lock: a temporary link here is a killed swap's.
  await removeAbandonedTemporaries(bin);
  const temporary = join(
    bin,
    `.${executableName}.tmp-${randomBytes(8).toString("hex")}`,
  );
  await symlink(selectorTarget(name), temporary);
  try {
    await rename(temporary, selector);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(bin);
}
