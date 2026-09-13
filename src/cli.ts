import { parseArgs } from "node:util";
import { inspectProfileChange } from "./folder/inspect-profile-change";
import { inspectInstructions } from "./folder/inventory";
import { inspectOwnedDirectory } from "./folder/owned-directory";
import { executionOs } from "./folder/platform";
import { previewFolder } from "./folder/preview";
import { parseFolderProfile } from "./folder/profile";
import { updateProfile } from "./folder/update-profile";

// Development CLI entrypoint. No installer or implicit folder discovery.
export async function runCli(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    console.log(`Lazurio development CLI — Folder profiles

folder-preview --folder <absolute canonical fixture directory>
  --access <local|remote> --purpose <human|buddy|ai_colleague>
  --locale <cs|en> --detail <concise|technical>
  --coordination <direct|coordinator>

All five choices are required. OS is detected on the execution Machine.
Alternatively supply --profile <JSON> instead of the five profile choices.
Optional --previous-digest <sha256> is development inventory input, not proof of ownership.
The directory must already exist and be caller-owned, non-shared and stable.
No files are written by folder-preview. No command installs or migrates Lazurio.
profile-preview uses the same profile choices and --folder, plus required
--expected-revision <positive integer>. It reads existing .lazurio state and
creates/removes only its operation lock. It does not apply the proposed change.
profile-update takes the same inputs as profile-preview and APPLIES the change:
it replaces owned instructions/preferences/manifest and archives the transaction.
Use only an explicitly prepared development fixture, not your daily Lazurio.
It refuses missing/unrecognized state, edits and pending recovery; it does not initialize a Folder.
--previous-digest is not accepted by either profile command.
Exit status: 0 completed/unchanged/preview available, 2 blocked plan, 1 operation failure.
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
      "expected-revision": { type: "string" },
      access: { type: "string" },
      purpose: { type: "string" },
      locale: { type: "string" },
      detail: { type: "string" },
      coordination: { type: "string" },
    },
  });
  if (
    positionals.length !== 1 ||
    !["folder-preview", "profile-preview", "profile-update"].includes(
      positionals[0] ?? "",
    )
  )
    throw new Error("Expected Folder command");
  const configured = positionals[0] !== "folder-preview";
  if (
    configured
      ? values["previous-digest"] !== undefined
      : values["expected-revision"] !== undefined
  )
    throw new Error("Option does not belong to this command");
  if (
    configured &&
    (!/^[1-9][0-9]*$/.test(values["expected-revision"] ?? "") ||
      !Number.isSafeInteger(Number(values["expected-revision"])))
  )
    throw new Error("Explicit expected revision required");
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
  if (configured) {
    const operation =
      positionals[0] === "profile-update"
        ? updateProfile
        : inspectProfileChange;
    const result = await operation(
      folder,
      Number(values["expected-revision"]),
      profile,
    );
    console.log(JSON.stringify(result));
    return result.kind === "blocked" ? 2 : 0;
  }
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
      "Folder operation failed. State may require recovery; no automatic retry or cleanup was performed. Use a caller-owned stable canonical development fixture, valid command/profile and required access. Symlink paths and hostile concurrent changes are unsupported.",
    );
    process.exitCode = 1;
  }
}
