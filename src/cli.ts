import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectInstructions } from "./folder/inventory";
import { executionOs } from "./folder/platform";
import { previewFolder } from "./folder/preview";
import { parseFolderProfile } from "./folder/profile";

// Development CLI entrypoint. No installer, implicit folder discovery or writer.
export async function runCli(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      folder: { type: "string" },
      profile: { type: "string" },
      "previous-digest": { type: "string" },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== "folder-preview")
    throw new Error("Expected folder-preview command");
  const folder = values.folder;
  if (!folder || !values.profile)
    throw new Error("Explicit --folder and --profile JSON required");
  const profile = parseFolderProfile(JSON.parse(values.profile));
  if (profile.os !== executionOs(process.platform))
    throw new Error("Profile OS does not match execution Machine");
  // This development boundary requires caller-controlled, stable fixtures. No
  // hostile concurrent parent mutations are supported; this is not a sandbox.
  if (!isAbsolute(folder) || (await realpath(folder)) !== resolve(folder))
    throw new Error("Canonical fixture directory required");
  const directory = await lstat(folder);
  if (
    !directory.isDirectory() ||
    !process.getuid ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o022) !== 0
  )
    throw new Error("Caller-owned non-shared fixture required");
  const result = await previewFolder(
    profile,
    values["previous-digest"] ?? null,
    () => inspectInstructions(folder),
  );
  console.log(JSON.stringify(result));
  return result.plan.kind === "blocked" ? 2 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch {
    // Do not echo profile input, private paths or raw filesystem errors.
    console.error(
      "Folder preview failed: use a caller-owned stable canonical fixture, valid command/profile and read access. Symlink paths and hostile concurrent changes are unsupported.",
    );
    process.exitCode = 1;
  }
}
