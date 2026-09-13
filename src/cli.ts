import { parseArgs } from "node:util";
import { inspectInstructions } from "./folder/inventory";
import { inspectOwnedDirectory } from "./folder/owned-directory";
import { executionOs } from "./folder/platform";
import { previewFolder } from "./folder/preview";
import { parseFolderProfile } from "./folder/profile";

// Development CLI entrypoint. No installer, implicit folder discovery or writer.
export async function runCli(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    console.log(`Lazurio development CLI — read-only Folder preview

folder-preview --folder <absolute canonical fixture directory>
  --access <local|remote> --purpose <human|buddy|ai_colleague>
  --locale <cs|en> --detail <concise|technical>
  --coordination <direct|coordinator>

All five choices are required. OS is detected on the execution Machine.
Alternatively supply --profile <JSON> instead of the five profile choices.
Optional --previous-digest <sha256> is development inventory input, not proof of ownership.
The directory must already exist and be caller-owned, non-shared and stable.
No files are written. This command does not install or migrate Lazurio.
Exit status: 0 preview available, 2 blocked plan, 1 invalid input or inspection failure.
Native Windows filesystem inspection is not yet qualified.`);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      folder: { type: "string" },
      profile: { type: "string" },
      "previous-digest": { type: "string" },
      access: { type: "string" },
      purpose: { type: "string" },
      locale: { type: "string" },
      detail: { type: "string" },
      coordination: { type: "string" },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== "folder-preview")
    throw new Error("Expected folder-preview command");
  const folder = values.folder;
  if (!folder) throw new Error("Explicit --folder required");
  const axes = {
    access: values.access,
    purpose: values.purpose,
    locale: values.locale,
    detail: values.detail,
    coordination: values.coordination,
  };
  if (
    values.profile !== undefined &&
    Object.values(axes).some((value) => value !== undefined)
  )
    throw new Error("Profile JSON and profile choices cannot be mixed");
  const profile = parseFolderProfile(
    values.profile !== undefined
      ? JSON.parse(values.profile)
      : { os: executionOs(process.platform), ...axes },
  );
  if (profile.os !== executionOs(process.platform))
    throw new Error("Profile OS does not match execution Machine");
  // This development boundary requires caller-controlled, stable fixtures. No
  // hostile concurrent parent mutations are supported; this is not a sandbox.
  await inspectOwnedDirectory(folder);
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
