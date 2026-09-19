import { parseArgs } from "node:util";
import { productHelp, runProductCommand } from "./distribution/product-cli";
import { initializeFolder } from "./folder/initialize-folder";
import { inspectLegacyPaths } from "./folder/inspect-legacy-paths";
import { inspectProfileChange } from "./folder/inspect-profile-change";
import { inspectInstructions } from "./folder/inventory";
import { inspectOwnedDirectory } from "./folder/owned-directory";
import { executionOs } from "./folder/platform";
import { previewFolder } from "./folder/preview";
import { parseFolderProfile } from "./folder/profile";
import { resumeInitialization } from "./folder/resume-initialization";
import { stateFields } from "./folder/state";
import { resumeProfileUpdate, updateProfile } from "./folder/update-profile";
import {
  readApplicationRequest,
  requestApplication,
} from "./launchpad/application-client";
import { startLaunchpad } from "./launchpad/server";
import { machineHelp, runMachineCommand } from "./machine/cli";
import { createApplicationCoordination } from "./modules/application-coordination";
import {
  type ApplicationRunner,
  selectApplicationRunnerKind,
} from "./modules/application-runner";
import { createApplicationLifecycle } from "./modules/lifecycle";
import {
  localApplicationAdapters,
  serviceApplicationAdapters,
} from "./modules/local-application-adapters";
import { processGuardCommand, runProcessGuard } from "./modules/process-guard";
import {
  createServiceManagerProcess,
  userManagerState,
} from "./modules/service-manager-process";
import { createSessionRunner } from "./modules/session-runner";
import {
  applicationCoordinationLockFile,
  createSystemdUserRunner,
} from "./modules/systemd-user-runner";
import { inspectOrganizationConversion } from "./organizations/inspect-conversion";
import { readOrganizationApplications } from "./organizations/read-applications";

// Status and Stop without a Launchpad, for applications owned by the service
// manager only: their truth is the manager's, so a short-lived owner over the
// same core and runner reads or stops exactly what a Launchpad would. A session
// application exists only inside its Launchpad and is never reachable this way.
async function operateServiceApplication(input: unknown) {
  const value = stateFields(input, [
    "organizationDirectory",
    "operation",
    "selection",
  ]);
  if (
    typeof value.organizationDirectory !== "string" ||
    !["status", "stop"].includes(value.operation as string)
  )
    throw new Error("Direct application request supports status and stop");
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  const kind = await selectApplicationRunnerKind({
    platform: process.platform,
    environment: { XDG_RUNTIME_DIR: runtimeDirectory },
    userManagerState: () =>
      userManagerState(createServiceManagerProcess(runtimeDirectory ?? "")),
  });
  if (kind !== "systemd-user")
    return {
      httpOk: false,
      result: { kind: "launchpad-required" } as Record<string, unknown>,
    };
  const lifecycle = createApplicationLifecycle(
    serviceApplicationAdapters({
      organizationDirectory: value.organizationDirectory,
      runner: createSystemdUserRunner({
        organizationDirectory: value.organizationDirectory,
        runtimeDirectory: runtimeDirectory as string,
        run: createServiceManagerProcess(runtimeDirectory as string),
      }),
      coordination: createApplicationCoordination({
        lockFile: applicationCoordinationLockFile(
          runtimeDirectory as string,
          value.organizationDirectory,
        ),
      }),
    }),
  );
  try {
    const result =
      value.operation === "stop"
        ? await lifecycle.stop(value.selection)
        : await lifecycle.status(value.selection);
    return { httpOk: true, result: result as Record<string, unknown> };
  } finally {
    await lifecycle.close();
  }
}

// Development CLI entrypoint. No implicit folder discovery; the only
// installer surface is the explicit `product` command group.
export async function runCli(args: string[]): Promise<number> {
  if (args[0] === "machine") {
    const { code, result } = await runMachineCommand(args.slice(1));
    console.log(JSON.stringify(result));
    return code;
  }
  if (args[0] === "product") {
    const { code, result } = await runProductCommand(args.slice(1));
    console.log(JSON.stringify(result));
    return code;
  }
  if (args[0] === "legacy-paths-inspect") {
    const { values, tokens } = parseArgs({
      args: args.slice(1),
      strict: true,
      tokens: true,
      options: { home: { type: "string" } },
    });
    if (!values.home || tokens.length !== 1)
      throw new Error("One explicit home fixture required");
    const result = await inspectLegacyPaths(values.home);
    console.log(JSON.stringify(result));
    return result.kind === "observed" ? 0 : 2;
  }
  if (
    ["organization-inspect", "organization-conversion-preview"].includes(
      args[0] ?? "",
    )
  ) {
    const { values, positionals, tokens } = parseArgs({
      args: args.slice(1),
      strict: true,
      tokens: true,
      options: { directory: { type: "string" } },
    });
    if (!values.directory || positionals.length !== 0 || tokens.length !== 1)
      throw new Error("One explicit Organization directory required");
    const result =
      args[0] === "organization-conversion-preview"
        ? await inspectOrganizationConversion(values.directory)
        : await readOrganizationApplications(values.directory);
    console.log(JSON.stringify(result));
    return ["applications-observed", "conversion-draft"].includes(result.kind)
      ? 0
      : 2;
  }
  if (args.length === 1 && args[0] === "app-request") {
    const request = await readApplicationRequest(Bun.stdin.stream());
    const response =
      request &&
      typeof request === "object" &&
      Object.hasOwn(request, "organizationDirectory")
        ? await operateServiceApplication(request)
        : await requestApplication(request);
    console.log(JSON.stringify(response.result));
    return response.httpOk &&
      [
        "started",
        "prepared",
        "already-managed",
        "status",
        "local-entrypoint",
        "group-stopped",
        "not-managed",
      ].includes(String(response.result.kind))
      ? 0
      : 2;
  }
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
launchpad --folder <initialized fixture> starts the local development profile panel.
Optional --organization-directory <permitted canonical Organization fixture> enables
read-only application discovery in the panel; it does not configure launch authority.
Additionally --bun-executable <absolute trusted Bun> enables local module operations
for that explicitly selected Organization. Module check/prepare scripts execute as
your local account, not in a sandbox. No provider rights or hosted service are granted.
Only declared self-owned Bun packages are currently supported. No Bun is downloaded.
Optional --application-runner <auto|session|systemd-user> (default auto) selects who
owns started applications. auto: Linux with a reachable user service manager
(XDG_RUNTIME_DIR set and \`systemctl --user is-system-running\` answering) uses
systemd-user; everything else uses session. systemd-user applications are transient
user services: they keep running when this Launchpad exits or restarts and are
rediscovered from the service manager; they do not survive a reboot, and without
user lingering they end with the account's last login session. session applications
are children of this Launchpad and stop with it. An explicit systemd-user request
fails instead of falling back. Status reports the owning runner.
Open its private session URL from this terminal; do not share the URL/token.
The panel uses the same preview/update core, not a separate writer or full app launcher.
app-request reads one JSON object from stdin: sessionUrl, operation and selection.
Operations: prepare/start/status/open/stop; selection: company/module/package.
It contacts an already running, explicitly configured development Launchpad session;
it does not discover or start a server or configure app bindings. Explicit prepare
requires a configured module preparation adapter and may change its dependencies.
The session URL is private. Supply it through protected stdin, not shell history.
Without a Launchpad: {organizationDirectory, operation, selection} with operation
status or stop addresses an application owned by the systemd user manager directly,
through the same core, runner and coordination lock. Where applications are
session-scoped it answers launchpad-required; it never starts or prepares anything.
open returns the execution Machine's local URL; it does not launch a browser or tunnel.
Native Windows filesystem inspection is not yet qualified.`);
    console.log(`legacy-paths-inspect --home <absolute canonical owned home fixture>
Read-only macOS inventory of Lazurio, Conglomerate and Conglomerate_GEN3 paths.
No implicit home discovery, content inspection, locks, moves or migration approval.
Exit 0 means observations available, NOT that migration is safe; 2 means blocked.
organization-inspect --directory <permitted canonical Organization fixture>
Read declared workspace applications without executing scripts or querying GitHub.
Requires canonical Organization and module inventory documents; no GEN3 fallback.
Output is local declaration evidence, not access, readiness or permission to launch.
Per-module conflicts remain explicit even when other modules are observed.
organization-conversion-preview --directory <permitted legacy Organization fixture>
Experimental: canonical Organization adoption still requires its owning decision.
Reads legacy declarations and inventory; outputs a lossless canonical JSON draft only.
Refuses an occupied canonical target, conflicting declarations or observed drift.
No files, locks, provider requests or applications are created. Output may contain
private Organization metadata: keep it in the owning scope, not public logs.
This is not a migration writer or authority to apply the draft. Exit 0 draft, 2 blocked.`);
    console.log(productHelp);
    console.log(machineHelp);
    return 0;
  }
  const { values, positionals, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {
      folder: { type: "string" },
      "organization-directory": { type: "string" },
      "bun-executable": { type: "string" },
      "application-runner": { type: "string" },
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
      "launchpad",
      "profile-preview",
      "profile-update",
      "profile-resume",
    ].includes(positionals[0] ?? "")
  )
    throw new Error("Expected Folder command");
  if (positionals[0] === "launchpad") {
    if (
      !values.folder ||
      Object.keys(values).some(
        (name) =>
          ![
            "folder",
            "organization-directory",
            "bun-executable",
            "application-runner",
          ].includes(name),
      ) ||
      (values["application-runner"] !== undefined &&
        values["bun-executable"] === undefined)
    )
      throw new Error("Explicit Launchpad fixture required");
    let applicationAdapters:
      | ReturnType<typeof localApplicationAdapters>
      | undefined;
    let applicationRunner: string | undefined;
    if (values["bun-executable"] !== undefined) {
      if (!values["organization-directory"] || !process.env.HOME)
        throw new Error("Local Organization and account home required");
      const environment: Record<string, string> = {
        HOME: process.env.HOME,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      };
      if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
      // Explicit and narrow: no detection beyond the user manager answering.
      const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
      const kind = await selectApplicationRunnerKind({
        platform: process.platform,
        environment: { XDG_RUNTIME_DIR: runtimeDirectory },
        ...(values["application-runner"] === undefined
          ? {}
          : { requested: values["application-runner"] }),
        userManagerState: () =>
          userManagerState(createServiceManagerProcess(runtimeDirectory ?? "")),
      });
      const runner: ApplicationRunner =
        kind === "systemd-user"
          ? createSystemdUserRunner({
              organizationDirectory: values["organization-directory"],
              runtimeDirectory: runtimeDirectory as string,
              run: createServiceManagerProcess(runtimeDirectory as string),
            })
          : createSessionRunner(process.execPath);
      applicationAdapters = localApplicationAdapters({
        organizationDirectory: values["organization-directory"],
        bunExecutable: values["bun-executable"],
        platformExecutable: process.execPath,
        environment,
        runner,
        ...(kind === "systemd-user"
          ? {
              coordination: createApplicationCoordination({
                lockFile: applicationCoordinationLockFile(
                  runtimeDirectory as string,
                  values["organization-directory"],
                ),
              }),
            }
          : {}),
      });
      applicationRunner = kind;
    }
    const { close, url } = await startLaunchpad(
      values.folder,
      applicationAdapters,
      values["organization-directory"] === undefined
        ? undefined
        : {
            organizationDirectory: values["organization-directory"],
          },
    );
    console.log(
      JSON.stringify({
        url,
        scope: "local-development-profile-panel",
        ...(applicationRunner === undefined ? {} : { applicationRunner }),
      }),
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, async () => {
        try {
          const result = await close();
          process.exit(result.kind === "closed" ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    return 0;
  }
  if (
    values["organization-directory"] !== undefined ||
    values["bun-executable"] !== undefined ||
    values["application-runner"] !== undefined
  )
    throw new Error("Discovery option belongs only to Launchpad");
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
    if (process.argv.length === 3 && process.argv[2] === processGuardCommand)
      await runProcessGuard();
    else process.exitCode = await runCli(process.argv.slice(2));
  } catch {
    // Do not echo profile input, private paths or raw filesystem errors.
    if (process.argv[2] === "product") {
      console.error(
        "Product operation failed. Installation state may be incomplete; this message does not prove whether activation changed the active record or entrypoint. Run `product status` and follow the documented repair procedure. Preserve pending attempts and accepted trust; do not reset metadata or bootstrap an established installation again. No automatic retry or repair was performed.",
      );
    } else if (process.argv[2] === "app-request") {
      console.error(
        "Application request could not be completed or its result confirmed. A submitted operation may still be running; this is not confirmation of cancellation. Check the existing Launchpad lifecycle owner before retrying a mutation. Verify the request and local session without sharing its private token.",
      );
    } else
      console.error(
        "Folder operation failed. State may require recovery; no automatic retry or cleanup was performed. Use a caller-owned stable canonical development fixture, valid command/profile and required access. Symlink paths and hostile concurrent changes are unsupported.",
      );
    process.exitCode = 1;
  }
}
