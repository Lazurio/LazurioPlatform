import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { shown } from "../organizations/cli";
import { type CliContext, operatorFolder } from "../update/cli";
import {
  createModuleOperations,
  type ModuleBlocked,
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
export const moduleHelp = `module start <Organization>/<module> [--app <package>] [--folder <absolute Folder>] [--json]
  Starts the module's default app (or the declared app --app names) from the
  module's own declaration, unless it already runs. The Organization is named
  as in module list: its slug, or its directory name; a slug that two
  directories declare is refused (organization-ambiguous), and a module that
  cannot run is refused with its catalog reason. On a Folder with a
  Personalspace (a workstation, a personal Remote Environment) its modules are named
  personalspace/<module>. On Linux with a user service
  manager the app is a transient systemd user service: it keeps running when
  the Launchpad restarts, ends with a reboot, and its output goes to the
  journal. Elsewhere apps are children of the Launchpad session and are
  started from the Launchpad (launchpad-required). The toolchain is the
  operator's Bun at ${standardBun} (toolchain-missing otherwise; see lazurio
  tools status). An app whose package declares no lazurio.preparation is
  prepared by default first: bun install --frozen-lockfile from the bun.lock
  beside its package.json, which changes nothing when node_modules already
  matches it (preparation-install-failed otherwise). An app that declares
  one gets the same install first, then its declared check: when the check
  passes the app starts; when it fails, start runs its prepare_script and
  the check again and starts the app only when the check then passes
  (preparation-script-failed, or prerequisites-not-ready when the check
  still fails). A preparation that
  cannot run answers its reason (preparation-lockfile-missing,
  preparation-toolchain-mismatch, …) with the file it concerns; status, stop
  and logs still operate a module refused only by its preparation.
module prepare <Organization>/<module> [--app <package>] [--folder <F>] [--json]
  Prepares the app without starting it, whatever its declared check says
  now: bun install --frozen-lockfile from the bun.lock beside its
  package.json, then its declared prepare_script and check (only the install
  for an app without lazurio.preparation). Use it to rerun a module's
  preparation whose check passes, for example after its data changed. It never
  installs beneath a running app: stop the app first (application-running);
  while another app of the same Organization runs it is refused
  (other-app-managed). Outcomes as for start, and prepared when done.
module stop <Organization>/<module> [--app <package>] [--folder <F>] [--json]
  Stops the app and confirms its whole process group ended; stopping an app
  that does not run answers not-managed.
module status <Organization>/<module> [--app <package>] [--folder <F>] [--json]
  What the service manager reports: state (running, starting, stopping,
  ended, stopped), whether the declared health passed, the service invocation
  and, while healthy, the link runtime.url. In a Remote Environment the link
  is the module's hostname from its recorded entry, never a localhost
  address; locally it is the loopback address the app listens on.
module logs <Organization>/<module> [--app <package>] [--lines N] [--folder <F>] [--json]
  The newest N (default ${moduleLogLinesDefault}, at most 1000) lines the app's
  service wrote to the journal, also after it stopped (Linux).
Nothing is recorded in the Folder: the running state is the OS service
manager's. The Folder is found as for module list.
Exit status: 0 done, 2 refused (the reason is printed; --json prints the
answer object), 1 the Folder could not be read.`;

export class ModuleUsageError extends Error {}

const usage =
  "Usage: module start|prepare|stop|status <Organization>/<module> [--app <package>] [--folder <Folder>] [--json] | module logs <Organization>/<module> [--lines N] …";

const explanations: Readonly<Record<string, string>> = {
  "module-name-invalid": "Name the module as <Organization>/<module>.",
  "organization-unknown":
    "No such Organization in this Folder; see lazurio organization list.",
  "organization-ambiguous":
    "More than one Organization directory declares this slug; none of them runs. Name one by its directory.",
  "module-unknown": "No such module; see lazurio module list <Organization>.",
  "personalspace-unavailable":
    "The Personalspace cannot be read: personalspace/ must hold exactly one directory, a real directory owned by you.",
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
    return `${shown(name)}: ${result.reason}${file}${candidates}${explanation === undefined ? "" : `\n${explanation}`}`;
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
  ].join("\n");
}

export async function runModuleCommand(
  args: string[],
  context: CliContext,
  // Test seam: where the operations run; the product uses this process.
  host: ModuleHost = processModuleHost(
    context.env,
    context.platform,
    context.executable,
  ),
): Promise<Readonly<{ code: number; result: ModuleResult; text: string }>> {
  let values: {
    folder?: string | undefined;
    json?: boolean | undefined;
    app?: string | undefined;
    lines?: string | undefined;
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
  const operations = createModuleOperations({ folder, owner: "cli", host });
  const options = {
    ...(values.app === undefined ? {} : { app: values.app }),
    ...(values.lines === undefined ? {} : { lines: Number(values.lines) }),
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
