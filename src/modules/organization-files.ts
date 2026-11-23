import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ORGANIZATION_FILES } from "./runtime";

// The Organization root's files an App declares (`organization_files` of
// lazurio.runtime.v1; decision 0249, addendum of 2026-11-22, point 14; H20),
// in DEV and STAGING as the application host hands them in PROD: a directory
// with a copy of exactly the declared canonical manifests, never the
// Organization's checkout, so the App reads in an Environment no more than on
// the host. The copy is made again before every start. A declared file the
// root does not have, or that is no regular file there (a link included), is
// left out, and the App starts without it, as on the host; a file no longer
// declared or no longer in the root leaves the copy. The App's process gets
// the directory as LAZURIO_ORGANIZATION_FILES_DIR.

/** Where an App's copy lives: outside every checkout, per Organization and
 * App id, below the account's Lazurio state. */
export function organizationFilesDirectory(
  home: string,
  company: string,
  appId: string,
): string {
  if (!home.startsWith("/")) throw new Error("Explicit account home required");
  return join(home, ".local/state/lazurio/organization-files", company, appId);
}

export async function provideOrganizationFiles(input: {
  organizationRoot: string;
  directory: string;
  files: readonly string[];
}): Promise<string> {
  for (const file of input.files)
    if (!(ORGANIZATION_FILES as readonly string[]).includes(file))
      throw new Error("Undeclarable organization file");
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const copied = new Set<string>();
  for (const file of input.files) {
    const source = join(input.organizationRoot, file);
    const stat = await lstat(source).catch(() => null);
    if (stat === null || !stat.isFile()) continue;
    const content = await readFile(source);
    const target = join(input.directory, file);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o400 });
    await rename(temporary, target);
    copied.add(file);
  }
  for (const entry of await readdir(input.directory))
    if (!copied.has(entry))
      await rm(join(input.directory, entry), { force: true, recursive: true });
  return input.directory;
}
