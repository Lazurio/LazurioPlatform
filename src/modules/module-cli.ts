import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { processPersonalspaceHolder } from "../content/holder";
import { shown } from "../organizations/cli";
import type { PersonalspaceHolderRead } from "../organizations/personalspace";
import { type CliContext, operatorFolder } from "../update/cli";
import { buildMemoryMax, buildTimeoutMs } from "./built/build-process";
import { moduleCreateHelp } from "./module-create-cli";
import {
  createModuleOperations,
  type ModuleBlocked,
  type ModuleBuild,
  type ModuleHost,
  type ModuleResult,
  type ModuleVerb,
  moduleLogLinesDefault,
  moduleVerbs,
  processModuleHost,
  standardBun,
} from "./module-operations";

/** `lazurio module start|prepare|stop|status|logs`: the terminal surface of the
 * module lifecycle (launchpad-parity B3). The Launchpad's
 * `/api/modules/<org>/<module>/…` answers with the same objects from the same
 * core; command names are the resident's (root decision 0167). */
export const moduleHelp = `module start <Organization>/<module> [--app <package>] [--dev] [--folder <absolute Folder>] [--json]
  Starts the module's default app (or the declared app --app names) from the
  module's own declaration, unless it already runs. An app that declares a
  static output (lazurio.runtime build_output beside its build_script)
  starts as its build of the checkout's commit: the Platform keeps each
  build in the account's cache (~/.cache/lazurio/builds) and serves it with
  its own small static server on the app's listener, so nothing of the app
  runs and it is ready at once. Without a build yet, start builds first
  (build-pending while it builds); when the checkout moved past the newest
  build, start serves that one and builds the new commit in the background,
  then swaps. A build that fails keeps the build there was and is answered
  with its reason and log (build-script-failed, build-timed-out,
  build-output-missing, build-output-unservable); --dev starts the app's
  development script instead, explicitly, until it is stopped. The Organization is named
  as in module list: its slug, or its directory name; a slug that two
  directories declare is refused (organization-ambiguous), and a module that
  cannot run is refused with its catalog reason. On a Folder with a
  Personalspace (a workstation, a personal Remote Environment) its modules are named
  personalspace/<module>; they run only from the Personalspace of the GitHub
  account gh is signed in with here (on a personal Remote Environment, its
  Owner's): another account's, a public one, or one GitHub cannot confirm
  (signed out, no answer) is refused with the reason (personalspace-foreign,
  personalspace-not-owned, personalspace-public, github-signed-out,
  github-unavailable, github-identity-mismatch). On Linux with a user service
  manager the app is a transient systemd user service: it keeps running when
  the Launchpad restarts, ends with a reboot, and its output goes to the
  journal. Elsewhere apps are children of the Launchpad session and are
  started from the Launchpad (launchpad-required). The toolchain is the
  operator's Bun at ${standardBun} (toolchain-missing otherwise; see lazurio
  tools status). Every slot the app requires (lazurio.runtime
  required_module_slots) must be declared by the Organization, active and
  checked out beside it, or nothing is installed or started
  (required-slot-undeclared, required-slot-planned, required-slot-missing,
  with the slot). A module provides its own data first: each repository
  database the Organization declares directly below it (a repository_db_mount
  slot such as workspace/<module>/db) that is not there, or is an empty
  directory, is cloned on its declared branch with this Environment's GitHub
  identity (gh's sign-in; on a Team Environment the Team's Lazurio for GitHub
  through its brokered gh and git's configured credential helper); a
  checkout already there is used as it is, never fetched or
  changed. When the clone cannot be done, nothing is installed or started
  (data-mount-denied, data-mount-occupied, data-mount-unavailable,
  data-mount-clone-failed, with the slot). A required sibling module workspace/<slug> with an HTTP
  default app is passed as LAZURIO_RUNTIME_SIBLING_<SLUG>_ORIGIN, its
  loopback address. Every secret the app declares (lazurio.runtime secrets
  and optional_secrets, names only) is read from this Environment's own
  vault before every start: the login password of the one item of exactly
  that name anywhere in the vault, passed to the app's own process only as
  LAZURIO_RUNTIME_SECRET_<NAME>. On a work Environment only an app of the
  Organization that owns it reads them, on a personal Environment only a
  Personalspace app. A required secret without a value refuses the start
  (runtime-secret-unavailable, with each name and why: missing, ambiguous,
  empty, not-connected, unreachable, other-organization, personalspace,
  personal-environment, workstation, …); an optional one whose item is not
  there, or that an unusable vault does not give, is only reported, and the
  app starts without it. Values are never printed. An app whose package
  declares no lazurio.preparation is prepared by default first: bun install --frozen-lockfile from the bun.lock
  beside its package.json, which leaves registry dependencies as they are
  when node_modules already matches it (local file: dependencies are copied
  again and the package's own lifecycle scripts such as postinstall run on
  every install; preparation-install-failed when it fails). A package that
  declares nothing to install (no dependencies or settings for them, no
  workspaces, no install scripts) needs no lockfile and nothing is installed
  for it; a lockfile beside it is left over (preparation-lockfile-unused).
  An app that declares lazurio.preparation gets the same install first, then
  its declared check: when the check passes the app starts; when it fails,
  start runs its prepare_script and the check again and starts the app only
  when the check then passes (preparation-script-failed, or
  prerequisites-not-ready when the check still fails). A preparation that
  cannot run answers its reason (preparation-lockfile-missing,
  preparation-toolchain-mismatch, …) with the file it concerns; status, stop
  and logs still operate a module refused only by its preparation.
module prepare <Organization>/<module> [--app <package>] [--folder <F>] [--json]
  Prepares the app without starting it, whatever its declared check says
  now: bun install --frozen-lockfile from the bun.lock beside its
  package.json, then its declared prepare_script and check (only the install
  for an app without lazurio.preparation, and no install for a package that
  declares nothing to install). Use it to rerun a module's
  preparation whose check passes, for example after its data changed. It never
  installs beneath a running app: stop the app first (application-running);
  while another app of the same Organization runs it is refused
  (other-app-managed). Outcomes as for start, and prepared when done.
module build <Organization>/<module> [--app <package>] [--folder <F>] [--json]
  Builds a static app's checkout now, one build at a time in this
  Environment and at a low priority (on Linux in its own transient unit
  with at most ${buildMemoryMax} of memory and ${buildTimeoutMs / 60_000} minutes): the app's
  start-time step (the frozen install, its check, its prepare_script when
  the check fails), then its build_script with NODE_ENV=production. The
  build is keyed by the module's commit (and the commits of the data
  repositories and required slots it reads); a commit already built is
  current, unless the checkout has uncommitted changes, and a commit whose
  build failed is built again. A running built app is then swapped onto the
  new build. The Launchpad does the same by itself after a pull. not-static
  for an app without build_output.
module stop <Organization>/<module> [--app <package>] [--folder <F>] [--json]
  Stops the app and confirms its whole process group ended; stopping an app
  that does not run answers not-managed.
module status <Organization>/<module> [--app <package>] [--folder <F>] [--json]
  What the service manager reports: state (running, starting, stopping,
  ended, stopped), whether the declared health passed, the service invocation
  and, while healthy, the link runtime.url; for a static app also what it
  serves (built and its commit, or dev) and its builds: the current one,
  one under way, the last failure and its log. In a Remote Environment the link
  is the module's hostname from its recorded entry, never a localhost
  address; locally it is the loopback address the app listens on.
module logs <Organization>/<module> [--app <package>] [--lines N] [--folder <F>] [--json]
  The newest N (default ${moduleLogLinesDefault}, at most 1000) lines the app's
  service wrote to the journal, also after it stopped (Linux).
Nothing is recorded in the Folder: the running state is the OS service
manager's. The Folder is found as for module list.
Exit status: 0 done, 2 refused (the reason is printed; --json prints the
answer object), 1 the Folder could not be read.
${moduleCreateHelp}`;

export class ModuleUsageError extends Error {}

const usage =
  "Usage: module start|prepare|build|stop|status <Organization>/<module> [--app <package>] [--dev] [--folder <Folder>] [--json] | module logs <Organization>/<module> [--lines N] …";

const explanations: Readonly<Record<string, string>> = {
  "module-name-invalid": "Name the module as <Organization>/<module>.",
  "organization-unknown":
    "No such Organization in this Folder; see lazurio organization list.",
  "organization-ambiguous":
    "More than one Organization directory declares this slug; none of them runs. Name one by its directory.",
  "module-unknown": "No such module; see lazurio module list <Organization>.",
  "personalspace-unavailable":
    "The Personalspace cannot be read: personalspace/ must hold exactly one directory, a real directory owned by you.",
  "personalspace-ambiguous":
    "personalspace/ holds more than one directory; none of them is read until only this Environment's own Personalspace is there.",
  "personalspace-foreign":
    "personalspace/ holds a checkout that is not the Personalspace (<login>/<login>_GEN3) of the GitHub account gh is signed in with here; it is not read and was left untouched.",
  "personalspace-not-owned":
    "GitHub does not know this Personalspace as a repository of the account gh is signed in with here; see gh auth status.",
  "personalspace-public":
    "This Personalspace's repository is public on GitHub; a Personalspace must be private.",
  "github-signed-out":
    "gh is not signed in here, so whose Personalspace this is cannot be verified; sign in (gh auth login) and try again.",
  "github-unavailable":
    "GitHub did not answer, so whose Personalspace this is cannot be verified now; try again.",
  "github-identity-mismatch":
    "gh is signed in here with another account than this Environment's Owner, whose Personalspace this is.",
  "personalspace-unverified":
    "Whose Personalspace this is has not been verified with GitHub yet; try again.",
  "app-unknown": "Not a declared app of this module; see lazurio module list.",
  "app-not-runnable": "This app's runtime declaration is missing or invalid.",
  "launchpad-required":
    "Apps in this Environment are children of the Launchpad session: start, stop and see them in the Launchpad.",
  "logs-unavailable":
    "Apps in this Environment are children of the Launchpad session; their output is not kept.",
  "journal-unavailable": "The user journal could not be read.",
  "toolchain-missing": `Bun is not at ${standardBun}; see lazurio tools status.`,
  "home-unknown": "The account's home directory is not known (HOME).",
  "prerequisites-not-ready":
    "The module's declared check still fails after its dependencies were installed and its prepare_script ran: fix the module's preparation or its check, then start (or lazurio module prepare) again.",
  "required-slot-undeclared":
    "The app requires this slot (lazurio.runtime.required_module_slots), but the Organization manifest does not declare it; nothing was started. Fix the app's declaration or the Organization manifest.",
  "required-slot-planned":
    "The app requires this slot, which the Organization manifest declares as planned (planned_slot); it cannot start in this Environment until the slot is active.",
  "required-slot-missing":
    "The app requires this slot, which is not checked out in this Environment beside it; nothing was started. Synchronize the Organization (lazurio update) or ask for access to that repository, then start again.",
  "data-mount-denied":
    "The app's data repository (this slot, declared by the Organization as a repository_db_mount) is one this Environment's GitHub identity cannot read: the account gh is signed in with here, or on a Team Environment the Team through Lazurio for GitHub. Nothing was started. Ask the Organization's Admin for access (on a Team Environment: for the Team, on GitHub), then start again.",
  "data-mount-occupied":
    "The place of the app's data repository (this slot) holds something that is not a checkout: a directory with files in it, a file or a link. It was left untouched and nothing was started; look at it and move it aside yourself.",
  "data-mount-unavailable":
    "The app's data repository (this slot) is not checked out, and GitHub did not answer or another content operation (an install, a module being created) holds this Folder's content lock; nothing was started. Start again; the clone is tried at every start.",
  "data-mount-clone-failed":
    "The app's data repository (this slot) could not be cloned on its declared branch: the repository may be empty or lack that branch, it may declare no GitHub remote, or git could not reach it. Lazurio never creates or initializes it, and nothing was started. Ask the Organization's Admin to check the data repository.",
  "runtime-secret-unavailable":
    "The app needs these secrets and the Environment's vault did not give them, so nothing was started. Each is the login password of the one item named exactly like it in this Environment's vault (lazurio vault status); add or fix the item and start again. Values are never shown.",
  "preparation-script-failed":
    "The prepare_script this package declares failed after the dependencies were installed; nothing was started. Fix the module's preparation and start (or lazurio module prepare) again.",
  "application-running":
    "The app is running; its dependencies are never changed beneath it. Stop it (lazurio module stop) and prepare again.",
  "other-app-managed":
    "Another app of this Organization is running or has a failed record; an explicit preparation waits until it is stopped (lazurio module stop). A start installs and prepares its own app without this restriction.",
  "preparation-preflight-failed":
    "The preparation could not be set up before anything was changed; see lazurio doctor.",
  "preparation-cleanup-required":
    "The processes of an earlier preparation could not be confirmed gone, so nothing was changed; retry when they have ended, or see lazurio doctor.",
  "port-occupied":
    "Another process listens on the module's declared port; stop it first.",
  "port-managed": "Another app of this Organization holds the declared port.",
  "coordination-busy":
    "Another Lazurio process is operating this Organization's apps; retry when it finishes.",
  "service-unrecognized":
    "A service of this app's name exists that Lazurio did not create in its current form (for example one started by an older release); stop it once with systemctl --user stop.",
  "operation-failed":
    "The lifecycle failed before it could confirm a change, for a reason it cannot name; see lazurio doctor.",
  "preparation-owner-invalid":
    "This package cannot prepare the app: it is missing, is not a package, or the app is not a declared member of its workspace.",
  "preparation-script-missing":
    "The app's lazurio.preparation names a script this package does not have.",
  "preparation-lockfile-missing":
    "No Bun lockfile (bun.lock) beside this package: its dependencies cannot be installed exactly. Commit the lockfile with the app.",
  "preparation-lockfile-ambiguous":
    "Both bun.lock and bun.lockb beside this package; keep only the one Bun installs from.",
  "preparation-lockfile-unused":
    "This lockfile lies beside a package that declares nothing to install: such a package needs no lockfile and Bun keeps none for it, so this one is left over. Remove it from the module, or declare the dependencies it locks.",
  "preparation-package-manager-unsupported":
    "This package's packageManager is not an exact Bun version (bun@x.y.z); modules are installed and run with Bun.",
  "preparation-applications-overlap":
    "This app's directory contains, or lies inside, another app of this module, whose running app its install could change, so start does not install it. Keep the module's apps in sibling directories (app/v1, app/v2); an app that declares lazurio.preparation can be prepared with lazurio module prepare while the module's other apps are stopped.",
  "preparation-workspace-unqualified":
    "This package is a workspace owner or member; installing a workspace is not supported yet.",
  "preparation-dependency-outside-owner":
    "This package depends on a local package (file:…) outside its Organization's checkout (or, with a declared preparation, outside its owner); a local dependency must lie in the same Organization.",
  "preparation-dependency-missing":
    "This package depends on a local package (file:…) that is not in the checkout; check out the repository that holds it.",
  "preparation-toolchain-mismatch": `This package pins a Bun version (packageManager) that the Bun at ${standardBun} is not.`,
  "preparation-install-failed":
    "bun install --frozen-lockfile from this lockfile failed: the lockfile may not match the package, or a dependency could not be fetched (a private Git dependency needs your GitHub access in this Environment).",
  "preparation-recovery-required":
    "An earlier dependency preparation of this module did not finish; starting stays blocked until it is recovered.",
  "declaration-not-regular":
    "This file of the module is not a regular file (a symlink, for example); Lazurio reads the module's files only as files of your own checkout.",
  "declaration-owner":
    "This file of the module belongs to another account, so it is not a file of your own checkout; make it yours again (chown) or check it out again.",
  "declaration-too-large":
    "This file of the module is larger than a file of the checkout may be (1 MiB; 16 MiB for a lockfile).",
  "directory-not-regular":
    "This directory of the checkout is not a real directory (a symlink, for example); Lazurio reads the checkout only through its own directories.",
  "build-script-failed":
    "The app's build_script failed; nothing changed for what is served. Read its log, fix the module, and build again (lazurio module build), or start its development version (lazurio module start --dev).",
  "build-timed-out":
    "The app's build did not finish in time and was ended; nothing changed for what is served.",
  "build-output-missing":
    "The build_script succeeded but did not write the directory build_output names; fix the declaration or the build.",
  "build-output-unservable":
    "The build's output has no file for the entrypoint's declared health path, so it could never report healthy; it was not kept.",
  "build-busy":
    "Another Lazurio process has been building for long; try again when it finishes.",
  "checkout-changing":
    "The checkout changed during every build attempt (pulls in a row); build again when it is still.",
  "checkout-unreadable":
    "git could not read the module's checkout (its commit), which a build is keyed by.",
  "organization-manifest-unreadable":
    "The Organization manifest could not be read, so the data repositories a build reads are not known.",
  "not-static":
    "This app declares no static output (lazurio.runtime build_output); it runs its development script.",
  "builds-unavailable":
    "This Environment keeps no builds (its home is not known).",
  "directory-owner":
    "This directory of the checkout belongs to another account, so it is not your own checkout; make it yours again (chown) or check it out again.",
};

function describe(name: string, result: ModuleResult): string {
  if (result.kind === "blocked") {
    const candidates =
      result.candidates === undefined
        ? ""
        : ` (${result.candidates.map(shown).join(", ")})`;
    const explanation = explanations[result.reason];
    const file = result.file === undefined ? "" : ` (${shown(result.file)})`;
    const secrets =
      result.secrets === undefined ? "" : ` (${secretList(result.secrets)})`;
    return `${shown(name)}: ${result.reason}${file}${secrets}${candidates}${explanation === undefined ? "" : `\n${explanation}`}`;
  }
  if (result.kind === "module-logs") return result.lines.join("\n");
  const title = `${result.organization}/${result.module}`;
  const state =
    result.state === "running" && result.healthy
      ? "running, healthy"
      : result.state;
  return [
    `${shown(title)}: ${result.outcome === "status" ? state : `${result.outcome}; ${state}`}`,
    `  app     ${shown(result.app)}`,
    `  runner  ${result.runner}${result.survivesLaunchpadRestart ? " (keeps running when the Launchpad restarts)" : " (ends with the Launchpad session)"}`,
    ...(result.runtime !== null
      ? [`  link    ${result.runtime.url}`]
      : result.runtimeReason !== undefined
        ? [`  link    none (${result.runtimeReason})`]
        : []),
    ...(result.secretsNotProvided?.length
      ? [`  without optional secrets ${secretList(result.secretsNotProvided)}`]
      : []),
    ...(result.build === undefined ? [] : buildLines(result.build)),
  ].join("\n");
}

// A static app's builds (decision F58), by short commits.
function buildLines(build: ModuleBuild): string[] {
  const short = (commit: string) => commit.slice(0, 12);
  return [
    ...(build.mode === null
      ? []
      : [
          `  serves  ${build.mode === "built" && build.served !== null ? `build of ${short(build.served.commit)}` : "development script"}`,
        ]),
    ...(build.head === undefined
      ? []
      : [
          `  checkout ${short(build.head.commit)}${build.head.branch === null ? " (detached)" : ` on ${shown(build.head.branch)}`}${build.head.dirty ? ", with uncommitted changes" : ""}`,
        ]),
    `  build   ${build.current === null ? "none yet" : `${short(build.current.commit)} at ${build.current.at}${build.current.dirty ? " (uncommitted changes)" : ""}`}`,
    ...(build.building === null
      ? []
      : [
          `  building ${short(build.building.commit)} since ${build.building.at}`,
        ]),
    ...(build.failure === null
      ? []
      : [
          `  failed  ${short(build.failure.commit)}: ${build.failure.reason} (log ${shown(build.failure.log)})`,
        ]),
  ];
}

// Runtime secrets by name and reason (decision F46), never a value.
const secretList = (
  secrets: readonly Readonly<{ name: string; reason: string }>[],
) => secrets.map((entry) => `${shown(entry.name)}: ${entry.reason}`).join(", ");

export async function runModuleCommand(
  args: string[],
  context: CliContext,
  // Test seam: where the operations run; the product uses this process.
  host: ModuleHost = processModuleHost(
    context.env,
    context.platform,
    context.executable,
  ),
  // Test seam: whose Personalspace this is (#186); the product asks this
  // process's gh.
  personalspace: PersonalspaceHolderRead = processPersonalspaceHolder(
    context.env,
    context.platform,
  ),
): Promise<Readonly<{ code: number; result: ModuleResult; text: string }>> {
  let values: {
    folder?: string | undefined;
    json?: boolean | undefined;
    app?: string | undefined;
    lines?: string | undefined;
    dev?: boolean | undefined;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        folder: { type: "string" },
        json: { type: "boolean" },
        app: { type: "string" },
        lines: { type: "string" },
        dev: { type: "boolean" },
      },
    });
    ({ values, positionals } = parsed);
    const supplied = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (supplied.has(token.name)) throw new Error("Duplicate command option");
      supplied.add(token.name);
    }
  } catch (error) {
    throw new ModuleUsageError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
  }
  const [noun, verb, name, ...rest] = positionals;
  if (
    noun !== "module" ||
    !moduleVerbs.includes(verb as ModuleVerb) ||
    name === undefined ||
    rest.length !== 0 ||
    (values.lines !== undefined &&
      (verb !== "logs" || !/^[1-9][0-9]{0,3}$/.test(values.lines))) ||
    (values.dev !== undefined && verb !== "start") ||
    (values.folder !== undefined &&
      (!isAbsolute(values.folder) || resolve(values.folder) !== values.folder))
  )
    throw new ModuleUsageError(usage);
  const operation = verb as ModuleVerb;
  const json = values.json === true;
  const done = (code: number, result: ModuleResult) =>
    Object.freeze({
      code,
      result,
      text: json ? JSON.stringify(result) : describe(name, result),
    });
  const folder = values.folder ?? (await operatorFolder(context));
  if (folder === undefined) {
    const refusal: ModuleBlocked = Object.freeze({
      kind: "blocked",
      operation,
      reason: "folder-unknown",
    });
    return Object.freeze({
      code: 2,
      result: refusal,
      text: json
        ? JSON.stringify(refusal)
        : "No Folder known: name it with --folder <absolute Folder>.",
    });
  }
  const operations = createModuleOperations({
    folder,
    owner: "cli",
    host,
    personalspace,
  });
  const options = {
    ...(values.app === undefined ? {} : { app: values.app }),
    ...(values.lines === undefined ? {} : { lines: Number(values.lines) }),
    ...(values.dev === true ? { dev: true } : {}),
  };
  const result = await operations[operation](name, options);
  if (result.kind === "blocked" && result.reason === "folder-unreadable")
    return Object.freeze({
      code: 1,
      result,
      text: json
        ? JSON.stringify(result)
        : "The Folder could not be read: it must be an absolute, caller-owned, non-shared directory.",
    });
  return done(result.kind === "blocked" ? 2 : 0, result);
}
