import { parseArgs } from "node:util";
import { initializeFolder } from "./folder/initialize-folder";
import { inspectProfileChange } from "./folder/inspect-profile-change";
import { inspectInstructions } from "./folder/inventory";
import { inspectOwnedDirectory } from "./folder/owned-directory";
import { executionOs } from "./folder/platform";
import { previewFolder } from "./folder/preview";
import { parseFolderProfile } from "./folder/profile";
import { resumeInitialization } from "./folder/resume-initialization";
import { resumeProfileUpdate, updateProfile } from "./folder/update-profile";

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
profile-resume --folder <fixture> --target-revision <integer >= 2>
resumes and finalizes an existing prepared update, or verifies its completed archive.
Target revision is the NEW revision, not the old expected revision of profile-update.
It accepts no profile choices and never reclaims a stale lock or damaged journal.
Exit status: 0 completed/unchanged/preview available, 2 blocked plan, 1 operation failure.
folder-init uses the same profile choices with an ABSENT canonical --folder path.
It creates a new development Folder at revision 1; no revision/digest options are accepted.
EXPERIMENTAL: failed initialization is retained, never automatically retried.
folder-resume --folder <fixture> explicitly completes a recognized initialization.
It accepts no other options, never overwrites edits and cannot reclaim stale locks.
Missing/damaged journals and partial file writes require separate repair.
Never use a daily working path. It does not install software or migrate existing data.
Native Windows filesystem inspection is not yet qualified.`);
    return 0;
  }
  const { values, positionals, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {
      folder: { type: "string" },
      profile: { type: "string" },
      "previous-digest": { type: "string" },
      "expected-revision": { type: "string" },
      "target-revision": { type: "string" },
      access: { type: "string" },
      purpose: { type: "string" },
      locale: { type: "string" },
      detail: { type: "string" },
      coordination: { type: "string" },
    },
  });
  const supplied = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (supplied.has(token.name)) throw new Error("Duplicate command option");
    supplied.add(token.name);
  }
  if (
    positionals.length !== 1 ||
    ![
      "folder-preview",
      "folder-init",
      "folder-resume",
      "profile-preview",
      "profile-update",
      "profile-resume",
    ].includes(positionals[0] ?? "")
  )
    throw new Error("Expected Folder command");
  if (positionals[0] === "folder-resume") {
    if (!values.folder || Object.keys(values).some((name) => name !== "folder"))
      throw new Error("Explicit initialization recovery folder required");
    console.log(JSON.stringify(await resumeInitialization(values.folder)));
    return 0;
  }
  if (positionals[0] === "profile-resume") {
    if (
      !values.folder ||
      Object.keys(values).some(
        (name) => !["folder", "target-revision"].includes(name),
      ) ||
      !/^[1-9][0-9]*$/.test(values["target-revision"] ?? "")
    )
      throw new Error("Explicit recovery folder and target revision required");
    console.log(
      JSON.stringify(
        await resumeProfileUpdate(
          values.folder,
          Number(values["target-revision"]),
        ),
      ),
    );
    return 0;
  }
  if (values["target-revision"] !== undefined)
    throw new Error("Recovery option on another command");
  const initializing = positionals[0] === "folder-init";
  if (initializing && values["previous-digest"] !== undefined)
    throw new Error("Digest is not an initialization input");
  const configured =
    positionals[0] === "profile-preview" || positionals[0] === "profile-update";
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
  if (initializing) {
    console.log(JSON.stringify(await initializeFolder(folder, profile)));
    return 0;
  }
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
