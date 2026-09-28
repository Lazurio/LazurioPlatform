import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type FolderRefresh,
  folderRefreshText,
} from "../folder/refresh-needed";
import { LaunchpadStartRefused } from "../launchpad/start-check";
import { hostedOperatorFolder } from "../machine/operator";
import {
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
  type UpdateError,
} from "./errors";
import {
  embeddedFixture,
  embeddedIdentity,
  isProductVersion,
  type ProductIdentity,
  productOrigin,
  versionOfTag,
} from "./identity";
import { type InstallResult, performInstall } from "./install";
import { updateNotice } from "./last-check";
import { layout } from "./layout";
import { entryLinked } from "./path-entry";
import { type ProcessRunner, selfCheckReport } from "./self-check";
import { detectServiceControl, serviceUnits } from "./service-control";
import {
  checkForUpdate,
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
install [--service systemd-user --folder <absolute Folder>] [--json]
  This executable installs ITSELF as the first version under the per-user
  install base and points bin/lazurio at it. It does not authenticate itself:
  first installation is trusted through HTTPS (see install.sh). Repeating it
  completes what is missing and never changes the active version. It links
  ~/.local/bin/lazurio to bin/lazurio; an entry there that is not Lazurio's is
  reported and left unchanged. Shell profiles are not edited: the result says
  whether ~/.local/bin is on PATH and whether another lazurio resolves first.
  With --service (Linux) it writes, enables and starts
  the systemd user unit lazurio-launchpad.service for that Folder; the unit
  restarts the Launchpad after every exit and never ends failed.
update [--version <vX.Y.Z[-rc.N]>] [--folder <absolute Folder>] [--json]
  Checks the latest release (or exactly the named tag), verifies its Sigstore
  attestation, downloads, runs the new executable's self-check and, on a
  supervised installation, its Launchpad start read-only on a private socket.
  A candidate that fails is removed and nothing changes. Only then is it
  activated; the switch is final and there is no way back to an earlier
  version. Supervised: restarts the Launchpad and requires it to report the
  new version within 30 seconds, otherwise activation-unhealthy: the new
  version stays active and its Launchpad shows Recovery mode or is not
  running; repair goes forward. Never moves below the highest version this
  installation ever accepted.
  It never writes the Folder. When the Folder renders an older template
  revision than the product, the result says "Folder refresh needed" with the
  exact command (folderRefresh in --json). The Folder is --folder, the
  supervised unit's, or on a hosted Machine the declared operator's.
update --check [--version <tag>] [--json]
  Verifies and reports; downloads and activates nothing.
  Exit 0 up to date, 10 update available.
update status [--folder <absolute Folder>] [--json]
  Running, active and latest known version, and a needed Folder refresh as
  above; never touches the network.
self-check --json [--base <install base>] [--folder <absolute Folder> [--launchpad]]
  What this executable is and whether it can read the install base and the
  Folder's state; --launchpad also runs its Launchpad start read-only on a
  private socket. Reads only; the updater runs it on a new version.
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
    verify: createAttestationVerifier(
      productOrigin,
      fixture
        ? fixtureTrustedRoot(fixture.trustedRoot)
        : sigstoreTrustedRoot(layout(base).sigstore),
    ),
    service,
    units: serviceUnits(context),
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
        launchpad: { type: "boolean" },
      },
    });
    if (!values.json || (values.launchpad && values.folder === undefined))
      return usage(
        "self-check --json [--base] [--folder <Folder> [--launchpad]]",
      );
    return Object.freeze({
      code: exitOk,
      stdout: JSON.stringify(
        await selfCheckReport(
          {
            base: values.base,
            folder: values.folder,
            launchpad: values.launchpad,
          },
          context.identity,
        ),
      ),
    });
  } catch (error) {
    // No reason is printed: it could quote Folder content or a private path.
    // A refused Launchpad probe names only its enumerated condition.
    return Object.freeze({
      code: exitFailure,
      ...(error instanceof LaunchpadStartRefused
        ? { stdout: JSON.stringify({ launchpadRefused: error.reason }) }
        : {}),
      stderr: "Self-check failed",
    });
  }
}

/** What a person reads after `lazurio install`: the outcome, then the
 * command's PATH entry and whatever the operator or an agent should do. */
function installText(result: InstallResult): string {
  if (result.kind === "error") return "";
  const { entry } = result;
  return [
    result.kind === "installed"
      ? `Lazurio ${result.active} is installed.`
      : `Updated from ${result.from} to ${result.to}.${
          result.restartRequired
            ? " A running Launchpad finishes the update when it restarts."
            : ""
        }`,
    ...(entry !== null && entryLinked(entry)
      ? [`The command is ${entry.path}.`]
      : entry === null
        ? [`Put ${result.path} on your PATH.`]
        : []),
    ...(entry?.next ?? []),
  ].join("\n");
}

export async function runInstallCommand(
  args: readonly string[],
  context: CliContext = processContext(),
): Promise<CommandOutput> {
  try {
    const { values } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        service: { type: "string" },
        folder: { type: "string" },
        base: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (
      (values.service !== undefined && values.service !== "systemd-user") ||
      (values.service === undefined) !== (values.folder === undefined)
    )
      throw new UsageError(
        "install [--service systemd-user --folder <absolute Folder>] [--json]",
      );
    const result = await performInstall({
      base: installBase(context, values.base),
      executable: context.executable,
      identity: context.identity,
      platform: context.platform,
      env: context.env,
      service:
        values.folder === undefined ? undefined : { folder: values.folder },
      run: context.run,
    });
    return render(result, values.json === true, installText(result));
  } catch (error) {
    if (error instanceof UsageError) return usage(error.message);
    return usage("install [--service systemd-user --folder <Folder>] [--json]");
  }
}

export async function runUpdateCommand(
  args: readonly string[],
  context: CliContext = processContext(),
): Promise<CommandOutput> {
  const synopsis =
    "update [--check] [--version <tag>] [--folder <Folder>] [--json] | update status [--folder <Folder>] [--json]";
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        check: { type: "boolean" },
        version: { type: "string" },
        base: { type: "string" },
        folder: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const [action, ...rest] = positionals;
    const json = values.json === true;
    if (
      rest.length > 0 ||
      !(action === undefined || action === "status") ||
      (action !== undefined &&
        (values.check || values.version !== undefined)) ||
      (values.folder !== undefined &&
        (values.check ||
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
    let environment = await updateEnvironment(context, base, values.folder);
    if (environment.folder === undefined && context.hostedFolder)
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
              `latest known ${status.lastCheck?.latest ?? "never checked"}${
                status.lastCheck
                  ? ` (checked ${status.lastCheck.checkedAt})`
                  : ""
              }`,
              ...(status.legacyRollbackState
                ? [
                    "state of the former rollback is left; the next lazurio update or lazurio install removes it",
                  ]
                : []),
              ...(status.stateInvalid
                ? [`state-invalid: ${status.stateInvalid}`]
                : []),
              ...refresh(status.folderRefresh),
            ].join("\n")
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
