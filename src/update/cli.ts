import { lstat, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type FolderRefresh,
  folderRefreshText,
  shellWord,
} from "../folder/refresh-needed";
import { hostedOperatorFolder } from "../machine/operator";
import {
  type AttestationVerifier,
  createAttestationVerifier,
  fixtureTrustedRoot,
  sigstoreTrustedRoot,
} from "./attestation";
import { resolveInstallBase } from "./base";
import {
  exitFailure,
  exitOk,
  exitUpdateAvailable,
  exitUsage,
  storageFailure,
  type UpdateError,
} from "./errors";
import {
  embeddedFixture,
  embeddedIdentity,
  isProductVersion,
  type ProductIdentity,
  productOrigin,
  tagOf,
  versionOfTag,
} from "./identity";
import { type InstallResult, performInstall } from "./install";
import { installPrompt, readInstallFacts } from "./install-prompt";
import { updateNotice } from "./last-check";
import { layout } from "./layout";
import { entryLinked, type PathEntry } from "./path-entry";
import { type ProcessRunner, selfCheckReport } from "./self-check";
import { detectServiceControl } from "./service-control";
import {
  checkForUpdate,
  performAutomaticRollback,
  performRollback,
  performUpdate,
  readStatus,
  type UpdateEnvironment,
} from "./update";

/** `lazurio update …`, `lazurio install` and `lazurio --version`: the terminal
 * surface of the one update core (docs/update.md "Surfaces"). The origin and
 * its trust are compiled in; there is no option, file or variable that points
 * an installed product anywhere else.
 */
export const updateHelp = `--version [--json]
  Prints the version, source commit and target this executable was built with.
install [--verify-release <directory>] [--service systemd-user --folder <absolute Folder>] [--json]
  This executable installs ITSELF as the first version under the per-user
  install base and points bin/lazurio at it. Two ways in. Downloaded
  (install.sh): --verify-release names the directory holding manifest.json and
  lazurio.sigstore.json of the release it came from; before anything is
  written it verifies, as lazurio update does, that the release workflow at
  that tag attested the manifest and exactly these bytes, and otherwise
  refuses and leaves nothing behind. It needs Sigstore's trust root from the
  network. Staged (the Machines role, --base): no release files and no
  network; the custody that pinned the file is the authority. Repeating it
  completes what is missing and never changes the active version. It links
  ~/.local/bin/lazurio to bin/lazurio; an entry there that is not Lazurio's is
  reported and left unchanged. Shell profiles are not edited: the result says
  whether ~/.local/bin is on PATH and whether another lazurio resolves first.
  With --service (Linux) it writes, enables and starts
  the systemd user unit lazurio-launchpad.service for that Folder, and the
  static lazurio-rollback.service its OnFailure= starts.
install prompt [--locale cs|en] [--json]
  The prepared prompt for an agent who straightens a non-standard
  installation: the standard layout on this platform, what was found instead,
  what the agent may do and what only on the operator's explicit instruction,
  and how success is proven. Reads only; --json says "standard": true when
  nothing deviates.
update [--version <vX.Y.Z[-rc.N]>] [--folder <absolute Folder>] [--json]
  Checks the latest release (or exactly the named tag), verifies its Sigstore
  attestation, downloads, runs the new executable's self-check and activates
  it. Supervised: restarts the Launchpad and requires it to report the new
  version within 30 seconds, otherwise the previous version is selected again.
  Never moves below the highest version this installation ever accepted.
  It never writes the Folder. When the Folder renders an older template
  revision than the product, the result says "Folder refresh needed" with the
  exact command (folderRefresh in --json). The Folder is --folder, the
  supervised unit's, or on a hosted Machine the declared operator's.
update --check [--version <tag>] [--json]
  Verifies and reports; downloads and activates nothing.
  Exit 0 up to date, 10 update available.
update status [--folder <absolute Folder>] [--json]
  Running, active, previous and latest known version, and a needed Folder
  refresh as above; never touches the network.
update rollback [--auto] [--json]
  Activates the previous version after its own self-check, by the same restart
  and health rule. --auto is what lazurio-rollback.service runs: it acts only
  on an interrupted activation and otherwise does nothing.
self-check --json [--base <install base>] [--folder <absolute Folder>]
  What this executable is and whether it can read the install base and the
  Folder's state. Reads only; the updater runs it on a new version.
Exit status: 0 success or up to date, 10 update available, 2 usage, 1 failure
or busy. --json carries one stable error code. --base <absolute directory>
names another install base (the service units use it).`;

export type CommandOutput = Readonly<{
  code: number;
  stdout?: string;
  stderr?: string;
}>;

/** Everything a command takes from the process; tests supply their own. */
export type CliContext = Readonly<{
  identity: ProductIdentity;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  executable: string;
  run?: ProcessRunner | undefined;
  /** Tests only: the compiled default is the product origin and Sigstore. */
  environment?: Partial<UpdateEnvironment> | undefined;
  /** The declared operator's Folder on a hosted Machine; absent, none. */
  hostedFolder?: (() => Promise<string | undefined>) | undefined;
}>;

export const processContext = (): CliContext =>
  Object.freeze({
    identity: embeddedIdentity(),
    platform: process.platform,
    env: process.env,
    executable: process.execPath,
    hostedFolder: hostedOperatorFolder,
  });

const usage = (message: string): CommandOutput =>
  Object.freeze({ code: exitUsage, stderr: `Usage: ${message}` });

class UsageError extends Error {}

export function installBase(
  context: Pick<CliContext, "platform" | "env">,
  explicit: string | undefined,
): string {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit) || resolve(explicit) !== explicit)
      throw new UsageError("--base <absolute canonical directory>");
    return explicit;
  }
  const base = resolveInstallBase({
    platform: context.platform,
    env: context.env,
    homedir: context.env.HOME,
  });
  if (!base) throw new UsageError("no per-user install base on this platform");
  return base;
}

/** The product's update core for one install base: compiled-in origin and
 * trust, the real network, and the service this Machine has. The CLI and the
 * installed Launchpad build the same one.
 */
/** The compiled-in verifier: Sigstore's public trust root cached in
 * `cachePath`, or a fixture build's root from its file. */
function releaseVerifier(cachePath: string): AttestationVerifier {
  const fixture = embeddedFixture();
  return createAttestationVerifier(
    productOrigin,
    fixture
      ? fixtureTrustedRoot(fixture.trustedRoot)
      : sigstoreTrustedRoot(cachePath),
  );
}

/** The downloaded way in verifies with a trust-root cache of its own, fresh
 * inside the caller's private release directory and removed afterwards: a
 * refused installation leaves nothing behind, and no cache found lying
 * around is ever taken as the starting root. */
const firstInstallVerifier =
  (directory: string): AttestationVerifier =>
  async (request) => {
    let cache: string;
    try {
      cache = await mkdtemp(join(directory, ".sigstore-"));
    } catch (error) {
      throw storageFailure(error, "trust-cache");
    }
    try {
      await releaseVerifier(cache)(request);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  };

export async function updateEnvironment(
  context: CliContext,
  base: string,
  /** The Folder a needed refresh is reported against; the supervised unit's
   * when not named. */
  folder?: string,
): Promise<UpdateEnvironment> {
  const fixture = embeddedFixture();
  const service = await detectServiceControl({
    base,
    platform: context.platform,
    env: context.env,
    run: context.run,
  });
  return Object.freeze({
    base,
    identity: context.identity,
    origin: fixture
      ? { ...productOrigin, baseUrl: fixture.baseUrl }
      : productOrigin,
    fetcher: (url, init) => fetch(url, init),
    verify: releaseVerifier(layout(base).sigstore),
    service,
    folder: folder ?? service?.folder,
    run: context.run,
    ...context.environment,
  });
}

type Result =
  | Readonly<{ kind: string }>
  | (Readonly<{ kind: "error" }> & UpdateError);

function render(result: Result, json: boolean, human: string): CommandOutput {
  const error = result.kind === "error" ? (result as UpdateError) : undefined;
  const code = error
    ? exitFailure
    : result.kind === "available"
      ? exitUpdateAvailable
      : exitOk;
  if (json) return Object.freeze({ code, stdout: JSON.stringify(result) });
  if (!error) return Object.freeze({ code, stdout: human });
  // The one context value a person needs: which state a person must look at.
  const path = error.context.path;
  return Object.freeze({
    code,
    stderr: `Update failed: ${error.code}${path === undefined ? "" : ` (${path})`}`,
  });
}

export function versionCommand(
  args: readonly string[],
  identity: ProductIdentity = embeddedIdentity(),
): CommandOutput {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
    return usage("--version [--json]");
  const fixture = embeddedFixture() !== undefined;
  if (args[0] === "--json")
    return Object.freeze({
      code: exitOk,
      stdout: JSON.stringify(fixture ? { ...identity, fixture } : identity),
    });
  return Object.freeze({
    code: exitOk,
    stdout: `lazurio ${identity.version} (commit ${identity.commit}, target ${identity.target})${
      fixture ? " FIXTURE BUILD: not a release" : ""
    }`,
  });
}

export async function selfCheckCommand(
  args: readonly string[],
  context: CliContext = processContext(),
): Promise<CommandOutput> {
  try {
    const { values } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        json: { type: "boolean" },
        base: { type: "string" },
        folder: { type: "string" },
      },
    });
    if (!values.json) return usage("self-check --json [--base] [--folder]");
    return Object.freeze({
      code: exitOk,
      stdout: JSON.stringify(
        await selfCheckReport(
          { base: values.base, folder: values.folder },
          context.identity,
        ),
      ),
    });
  } catch {
    // No reason is printed: it could quote Folder content or a private path.
    return Object.freeze({ code: exitFailure, stderr: "Self-check failed" });
  }
}

/** The command that runs this installation, as a person types it: `lazurio`
 * when the standard entry is what PATH finds, otherwise its full path. */
function installedCommand(entry: PathEntry | null, base: string): string {
  if (entry === null || !entryLinked(entry))
    return shellWord(layout(base).selector);
  return entry.directoryOnPath && entry.shadowedBy === null
    ? "lazurio"
    : shellWord(entry.path);
}

/** The first step on a workstation after a first installation: the Lazurio
 * Folder `~/Lazurio` (created by `folder-init` only where nothing exists yet)
 * and the Launchpad on it. Read only. */
async function firstStep(home: string, command: string): Promise<string[]> {
  const folder = join(home, "Lazurio");
  const init = (path: string) =>
    `  ${command} folder-init --folder ${path} --access local --purpose human --locale en --detail concise --coordination direct`;
  const choices =
    "The Folder's language and style are your choice: --locale cs, --detail technical and --coordination coordinator are the alternatives.";
  const launchpad = `  ${command} launchpad --folder ${shellWord(folder)}`;
  let exists = true;
  try {
    await lstat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
    exists = false;
  }
  if (!exists)
    return [
      "Next, create your Lazurio Folder and start the Launchpad:",
      init(shellWord(folder)),
      launchpad,
      choices,
    ];
  const initialized = await lstat(join(folder, ".lazurio")).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (initialized)
    return ["Next, start the Launchpad on your Lazurio Folder:", launchpad];
  return [
    `${folder} exists and is not a Lazurio Folder, so it is left alone. \`folder-init\` creates a Folder only at a path that does not exist yet:`,
    init("<absolute path that does not exist yet>"),
    choices,
  ];
}

/** What a person reads after `lazurio install`: the verification, the
 * outcome, the command's PATH entry with whatever the operator or an agent
 * should do, and on a first installation the first step. */
async function installText(
  result: InstallResult,
  input: Readonly<{
    base: string;
    identity: ProductIdentity;
    verified: boolean;
    home: string | undefined;
    service: boolean;
  }>,
): Promise<string> {
  if (result.kind === "error") return "";
  const { entry } = result;
  const command = installedCommand(entry, input.base);
  const standard =
    entry === null ||
    (entryLinked(entry) && entry.directoryOnPath && entry.shadowedBy === null);
  return [
    ...(input.verified
      ? [
          `Verified: this executable is lazurio ${input.identity.version} for ${input.identity.target}, built and attested by the release workflow of ${productOrigin.repository} at ${tagOf(input.identity.version)}.`,
        ]
      : []),
    result.kind === "installed"
      ? `Lazurio ${result.active} is installed.`
      : `Updated from ${result.from} to ${result.to}.${
          result.restartRequired
            ? " A running Launchpad finishes the update when it restarts."
            : ""
        }`,
    ...(entry !== null && entryLinked(entry)
      ? [
          `The command is ${entry.path}.`,
          ...(entry.directoryOnPath
            ? [`${dirname(entry.path)} is on your PATH.`]
            : []),
        ]
      : entry === null
        ? [`Put ${result.path} on your PATH.`]
        : []),
    ...(entry?.next ?? []),
    ...(standard
      ? []
      : [
          `This installation is not yet the standard one. To have an agent straighten it, give it the prompt that \`${command} install prompt\` prints (add --locale cs for Czech).`,
        ]),
    ...(result.kind === "installed" && !input.service && input.home
      ? await firstStep(input.home, command)
      : []),
  ].join("\n");
}

/** A refused installation in words; the code stays first, as in --json. A
 * refusal of the downloaded way in happens before the first write. */
function installFailureText(error: UpdateError): string {
  const { code, context } = error;
  const nothing = "Nothing was installed.";
  const verification =
    code === "attestation-invalid"
      ? `The release attestation does not vouch for this executable: it is not what the release workflow of ${productOrigin.repository} built for this version. ${nothing}`
      : code === "trust-unavailable"
        ? `Sigstore's trust root could not be reached, so the release attestation could not be checked. ${nothing} Try again when this computer can reach tuf-repo-cdn.sigstore.dev.`
        : code === "release-invalid" &&
            ["manifest", "bundle", "artifact"].includes(
              String(context.resource),
            )
          ? `The release files do not describe this executable (${context.resource}: ${context.reason}). ${nothing}`
          : code === "target-unsupported" && context.target !== undefined
            ? `The release has no executable for ${context.target}. ${nothing}`
            : undefined;
  const path = context.path;
  return [
    `Installation failed: ${code}${path === undefined ? "" : ` (${path})`}`,
    ...(verification ? [verification] : []),
  ].join("\n");
}

async function installPromptCommand(
  values: Readonly<{ locale?: string; json?: boolean; base?: string }>,
  context: CliContext,
): Promise<CommandOutput> {
  const locale = values.locale ?? "en";
  if (locale !== "cs" && locale !== "en")
    throw new UsageError("install prompt [--locale cs|en] [--json]");
  const home = context.env.HOME;
  const facts =
    home === undefined
      ? null
      : await readInstallFacts({
          base: installBase(context, values.base),
          home,
          pathVariable: context.env.PATH,
          platform: context.platform,
        });
  if (facts === null)
    throw new UsageError("install prompt: no per-user install base here");
  const prompt = installPrompt(facts, locale);
  const result = {
    kind: "install-prompt",
    locale,
    standard: facts.deviations.length === 0,
    deviations: facts.deviations,
    facts: {
      platform: facts.platform,
      base: facts.base,
      selector: facts.selector,
      active: facts.active,
      entry: facts.entry,
    },
    prompt,
  };
  return Object.freeze({
    code: exitOk,
    stdout: values.json ? JSON.stringify(result) : prompt,
  });
}

export async function runInstallCommand(
  args: readonly string[],
  context: CliContext = processContext(),
): Promise<CommandOutput> {
  const synopsis =
    "install [--verify-release <directory>] [--service systemd-user --folder <absolute Folder>] [--json] | install prompt [--locale cs|en] [--json]";
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        service: { type: "string" },
        folder: { type: "string" },
        base: { type: "string" },
        "verify-release": { type: "string" },
        locale: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (positionals[0] === "prompt") {
      if (
        positionals.length > 1 ||
        values.service !== undefined ||
        values.folder !== undefined ||
        values["verify-release"] !== undefined
      )
        throw new UsageError(synopsis);
      return await installPromptCommand(values, context);
    }
    const directory = values["verify-release"];
    if (
      positionals.length > 0 ||
      values.locale !== undefined ||
      (values.service !== undefined && values.service !== "systemd-user") ||
      (values.service === undefined) !== (values.folder === undefined) ||
      (directory !== undefined &&
        (!isAbsolute(directory) || resolve(directory) !== directory))
    )
      throw new UsageError(synopsis);
    const base = installBase(context, values.base);
    const result = await performInstall({
      base,
      executable: context.executable,
      identity: context.identity,
      platform: context.platform,
      env: context.env,
      service:
        values.folder === undefined ? undefined : { folder: values.folder },
      release:
        directory === undefined
          ? undefined
          : {
              directory,
              verify:
                context.environment?.verify ?? firstInstallVerifier(directory),
            },
      run: context.run,
    });
    if (values.json === true || result.kind !== "error")
      return render(
        result,
        values.json === true,
        await installText(result, {
          base,
          identity: context.identity,
          verified: directory !== undefined,
          home: context.env.HOME,
          service: values.service !== undefined,
        }),
      );
    return Object.freeze({
      code: exitFailure,
      stderr: installFailureText(result),
    });
  } catch (error) {
    if (error instanceof UsageError) return usage(error.message);
    return usage(synopsis);
  }
}

export async function runUpdateCommand(
  args: readonly string[],
  context: CliContext = processContext(),
): Promise<CommandOutput> {
  const synopsis =
    "update [--check] [--version <tag>] [--folder <Folder>] [--json] | update status [--folder <Folder>] [--json] | update rollback [--auto] [--json]";
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        check: { type: "boolean" },
        version: { type: "string" },
        auto: { type: "boolean" },
        base: { type: "string" },
        folder: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const [action, ...rest] = positionals;
    const json = values.json === true;
    if (
      rest.length > 0 ||
      !(action === undefined || action === "status" || action === "rollback") ||
      (action !== undefined &&
        (values.check || values.version !== undefined)) ||
      (action !== "rollback" && values.auto) ||
      (values.folder !== undefined &&
        (action === "rollback" ||
          values.check ||
          !isAbsolute(values.folder) ||
          resolve(values.folder) !== values.folder))
    )
      throw new UsageError(synopsis);
    // A tag is normalized to a version; the bare version names the same tag.
    const exact =
      values.version === undefined
        ? undefined
        : (versionOfTag(values.version) ??
          (isProductVersion(values.version) ? values.version : undefined));
    if (values.version !== undefined && exact === undefined)
      throw new UsageError("--version <vX.Y.Z[-rc.N]>");
    const base = installBase(context, values.base);
    // The Folder a needed refresh is reported against: the named one, the
    // supervised unit's, or on a hosted Machine the declared operator's.
    // Only the two commands that report it look for one.
    const reports = action === undefined || action === "status";
    let environment = await updateEnvironment(context, base, values.folder);
    if (reports && environment.folder === undefined && context.hostedFolder)
      environment = Object.freeze({
        ...environment,
        folder: await context.hostedFolder(),
      });
    const refresh = (value: FolderRefresh | null) =>
      value === null ? [] : [folderRefreshText(value)];
    if (action === "status") {
      const status = await readStatus(environment);
      return render(
        status,
        json,
        status.kind === "status"
          ? [
              `running ${status.running}`,
              `active ${status.active ?? "none"}`,
              `previous ${status.previous ?? "none"}`,
              `latest known ${status.lastCheck?.latest ?? "never checked"}${
                status.lastCheck
                  ? ` (checked ${status.lastCheck.checkedAt})`
                  : ""
              }`,
              ...(status.pending
                ? [`activation of ${status.pending.to} is not committed`]
                : []),
              ...(status.stateInvalid
                ? [`state-invalid: ${status.stateInvalid}`]
                : []),
              ...refresh(status.folderRefresh),
            ].join("\n")
          : "",
      );
    }
    if (action === "rollback") {
      const result = await (values.auto
        ? performAutomaticRollback(environment)
        : performRollback(environment));
      return render(
        result,
        json,
        result.kind === "rolled-back"
          ? `Rolled back from ${result.from} to ${result.to}.`
          : result.kind === "reconciled"
            ? `Interrupted activation: ${result.outcome}.`
            : "",
      );
    }
    if (values.check) {
      const result = await checkForUpdate(environment, exact);
      return render(
        result,
        json,
        result.kind === "available"
          ? `Lazurio ${result.latest} is available (running ${result.running}). ${result.notesUrl}`
          : result.kind === "up-to-date"
            ? `Lazurio ${result.running} is up to date.`
            : "",
      );
    }
    const result = await performUpdate(environment, exact);
    return render(
      result,
      json,
      result.kind === "updated"
        ? [
            `Updated from ${result.from} to ${result.to}.${
              result.restartRequired
                ? " A running Launchpad finishes the update when it restarts."
                : ""
            }`,
            ...refresh(result.folderRefresh),
          ].join("\n")
        : result.kind === "up-to-date"
          ? [
              `Lazurio ${result.running} is up to date.`,
              ...refresh(result.folderRefresh),
            ].join("\n")
          : "",
    );
  } catch (error) {
    return usage(error instanceof UsageError ? error.message : synopsis);
  }
}

/** The one-line notice after other commands; reads `last-check.json` only. */
export async function noticeAfterCommand(
  context: CliContext = processContext(),
): Promise<string | null> {
  try {
    return await updateNotice(
      installBase(context, undefined),
      context.identity.version,
    );
  } catch {
    return null;
  }
}
