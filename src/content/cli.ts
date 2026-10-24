import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createModuleOperations,
  processModuleHost,
} from "../modules/module-operations";
import { shown } from "../organizations/cli";
import { type CliContext, installBase, operatorFolder } from "../update/cli";
import {
  type ContentHost,
  contentLockDirectory,
  preparationAnswer,
  processContentHost,
  processGitHubHost,
} from "./host";
import { type InstallRequest, installContent } from "./install";
import {
  type ContentItemRef,
  type ContentStep,
  githubLoginPattern,
  itemLabel,
  repositoryPattern,
} from "./model";
import { type SyncEntry, type SyncHost, syncContent } from "./sync";

/** `lazurio organization install`, `lazurio organization sync` and
 * `lazurio personalspace install`: the terminal surface of content
 * installation and synchronization. The Launchpad's
 * `POST /api/content/install` and its sweep run the same cores. */
export const contentHelp = `organization install <github-login> [--role builder|steward|reader] [--root <owner>/<repository>] [--folder <absolute Folder>] [--json]
  Installs the Organization bound to that GitHub login into the Folder: its
  root repository first (cloned into a temporary sibling, verified — remote,
  branch main, and its own lazurio.organization.json binding the login — and
  only then moved into the absent organizations/<repository> with a rename
  that never replaces anything), then, from the declaration of that root, its
  workspace modules, root-level applications and productionspace/*
  repositories that this Environment's GitHub sign-in (gh's) can read, then
  the declared preparation of each module it cloned, then the doctor's check
  of the Organization. A child repository it cannot read is reported and the
  others continue; infra and restricted slots are left out. A module's
  declared data mount (a repository_db_mount slot such as
  workspace/<module>/db or mission-control/db) follows its module: cloned on
  its declared branch when the module is there after this install, excluded
  while it is not; any other database slot is left out. An existing
  repository is never fetched, switched or reset, and an
  occupied destination is never touched. The root of an Organization the
  Folder already holds is that checkout. Otherwise a name is only a
  candidate: --root <owner>/<repository> when named, else
  <login>/<login>_GEN3, else the one repository of the Organization this
  account can read, each accepted only when its own lazurio.organization.json
  declares it the root of that login (root-declaration-mismatch for a named
  one that does not; root-not-found or root-ambiguous after the scan). The scope follows the user's role in the Organization, as
  the resident CLI's: without --role it is the Admin installation, the full
  one, and runs only when GitHub confirms through gh an active Owner
  membership; --role builder, --role steward or --role reader installs
  everything except the restricted (Admin-only) slots and the slots below
  them, reported excluded_by_role_scope and never asked of GitHub, and runs
  only when GitHub confirms write (Builder) or maintain (Steward) on the
  root repository, or read or triage on it together with an active
  membership in the Organization (Reader, whose clones GitHub keeps
  read-only). Anyone may choose a narrower role GitHub confirms. A role
  GitHub does not confirm fails closed before anything is cloned
  (role-unverified). Only
  on a workstation (local) and a work Environment
  (hosted-organization-personal or hosted-organization-steward, its own
  Organization only). The Automated preset grants no GitHub role. A public
  Environment (its handover's entry.audience public, whatever its preset) has
  no GitHub identity: it installs its own Organization only, as a reader
  (--role reader; any other role fails role-unverified), reads nothing of
  GitHub's API and clones the root and every child over anonymous HTTPS with
  an isolated git (none of the user's Git configuration, credential, askpass
  or SSH helpers, HTTPS only, exactly https://github.com/<owner>/<repository>.git);
  its root is the one the Folder holds, --root or
  <login>/<login>_GEN3, verified in the clone, and a child anonymous Git
  cannot read is reported (clone-failed). One JSON line per step with --json,
  then the result.
personalspace install [--folder <absolute Folder>] [--json]
  Installs the user's Personalspace into personalspace/<login>_GEN3: when
  <login>/<login>_GEN3 exists on GitHub (private, the user's own), it is
  cloned; otherwise it is created from Lazurio/PersonalspaceTemplate_GEN3 as
  a private repository of the user's account, cloned, set up by the
  template's own bootstrap (bun run bootstrap -- --login <login>
  --display-name <GitHub profile name, else login> --apply: it names the
  owner and creates and clones the private <login>/<login>-gbrain; the gbrain
  CLI is not installed), and what the bootstrap wrote is committed and pushed
  to main of both new repositories, by the user's Git identity, else by
  their GitHub identity (profile name or login, GitHub's noreply
  address) given per commit and never configured. Bun and an identity are
  checked before anything is created (personalspace-toolchain-missing,
  git-identity-missing). A failed bootstrap leaves the created repository
  cloned and unpushed, with the next step in the failure. When a repository
  of the user was already created from that template under another name,
  nothing is created (personalspace-elsewhere). Only on a workstation (local)
  and a personal Remote Environment (hosted-personal, only for its owner's
  GitHub account). An existing Personalspace is left as it is and never
  bootstrapped: one that still holds the template's placeholders is reported
  (warning personalspace-placeholders) with the next step, the bootstrap in a
  task worktree and a pull request.
Neither runs on a Team Environment, whose content the hosting
prepares (prepared-by-hosting), unless it is public. One content operation runs at a time per
Folder (content-busy). The Folder is found as for organization list.
Exit status: 0 installed, 1 failed (the step and its code are printed), 2
usage or not allowed on this Environment.
organization sync [<github-login>] [--folder <absolute Folder>] [--json]
  Keeps the primary checkouts of that Organization (without a login, of every
  Organization this Environment holds) on their published branch, as the
  Launchpad does by itself at its start and then hourly, and as lazurio update
  does first (before the builds and Lazurio itself): the root first, then, from the
  root's declaration as it is after that, its workspace modules, root-level
  applications and their declared data mounts (on the mount's declared
  branch) that are in the Folder. Per repository one ls-remote of its branch,
  and only when it differs a fetch, then a fast-forward to exactly the
  fetched commit, never a merge, stash, switch, reset or hook, and never
  interactive (no prompt, SSH in batch mode, about a minute per repository).
  A checkout changes only when its tracked and untracked files are clean, it
  is on its branch and no merge, rebase, cherry-pick, revert, bisect or am is
  under way; otherwise it is blocked with its reason (dirty, wrong-branch,
  detached, ahead, diverged, operation-in-progress, unexpected-checkout) and
  left exactly as it is. A blocked or unreadable root stops its Organization.
  Each repository answers fast-forwarded (from and to), current, blocked,
  absent (declared, not in the Folder: never cloned here, that is
  organization install), denied, unavailable or failed. Production Space
  repositories, infra, worktrees and the Personalspace are never touched. The
  identity is this Environment's: gh's sign-in (gh as the HTTPS helper), a
  Team Environment's configured helper, or on a public Environment anonymous
  HTTPS. The answers are recorded for the doctor and the Launchpad. With
  --json one line {kind: "content-sync", at, organizations, entries}.
  Exit status: 0 every repository current, fast-forwarded or absent; 1 any
  other answer, another content operation (content-busy) or no such
  Organization here; 2 usage or not on this Environment.`;

export class ContentUsageError extends Error {}

/** The roles `--role` names; the Admin installation is the bare form. */
const scopedRoles = ["builder", "steward", "reader"] as const;
const isScopedRole = (value: string): value is (typeof scopedRoles)[number] =>
  (scopedRoles as readonly string[]).includes(value);

const usage =
  "Usage: organization install <github-login> [--role builder|steward|reader] [--root <owner>/<repository>] [--folder <Folder>] [--json] | organization sync [<github-login>] [--folder <Folder>] [--json] | personalspace install [--folder <Folder>] [--json]";

/** Whether `args` is a content command (the dispatcher's question). */
export const isContentCommand = (args: readonly string[]) =>
  ((args[0] === "organization" || args[0] === "personalspace") &&
    args[1] === "install") ||
  (args[0] === "organization" && args[1] === "sync");

function humanSync(entry: SyncEntry): string {
  const where = entry.path === "." ? entry.root : `${entry.root}/${entry.path}`;
  const reason = entry.reason === undefined ? "" : ` ${entry.reason}`;
  const moved =
    entry.from === undefined || entry.to === undefined
      ? ""
      : ` ${entry.from.slice(0, 12)}..${entry.to.slice(0, 12)}`;
  return `${shown(where)} (${entry.branch})  ${entry.result}${reason}${moved}`;
}

/** `lazurio organization sync`: the explicit form of the Launchpad's
 * synchronization, the same core (`syncContent`). */
async function runSyncCommand(
  login: string | undefined,
  folder: string,
  json: boolean,
  context: CliContext,
  write: (line: string) => void,
  hostFor?: (folder: string) => ContentHost,
): Promise<number> {
  const print = (result: Record<string, unknown>, text: string) =>
    write(json ? JSON.stringify(result) : text);
  let host: SyncHost;
  if (hostFor !== undefined) host = hostFor(folder);
  else {
    let base: string;
    try {
      base = installBase(context, undefined);
    } catch {
      print(
        { kind: "blocked", reason: "base-unknown" },
        "No per-user install base on this platform.",
      );
      return 1;
    }
    host = {
      ...processGitHubHost({ env: context.env, platform: context.platform }),
      lockDirectory: contentLockDirectory(base),
    };
  }
  const run = await syncContent(folder, host, {
    ...(login === undefined ? {} : { organization: login }),
  });
  if (run.kind === "not-allowed") {
    print(
      { kind: "blocked", reason: run.reason },
      run.reason === "folder-unreadable"
        ? "The Folder's state could not be read (folder-unreadable)."
        : `This Environment does not keep ${login === undefined ? "any Organization" : `organization ${shown(login)}`} (not-for-this-environment).`,
    );
    return run.reason === "folder-unreadable" ? 1 : 2;
  }
  if (run.kind === "busy") {
    print(
      { kind: "blocked", reason: "content-busy" },
      "Another content operation runs on this Folder (content-busy).",
    );
    return 1;
  }
  if (login !== undefined && run.organizations.length === 0) {
    print(
      { kind: "blocked", reason: "organization-missing" },
      `This Folder holds no Organization bound to ${shown(login)} (organization-missing).`,
    );
    return 1;
  }
  if (!json) for (const entry of run.entries) write(humanSync(entry));
  const settled = run.entries.every((entry) =>
    ["current", "fast-forwarded", "absent"].includes(entry.result),
  );
  print(
    run,
    settled
      ? `${run.entries.length} repositories: published branch.`
      : `${run.entries.length} repositories: some are left as they are (see above).`,
  );
  return settled ? 0 : 1;
}

function humanStep(step: ContentStep): string {
  const label = shown(itemLabel(step.item));
  const code = step.code === undefined ? "" : ` ${step.code}`;
  const detail = step.detail === undefined ? "" : `: ${shown(step.detail)}`;
  return `${label}  ${step.key} ${step.state}${code}${detail}`;
}

export async function runContentCommand(
  args: string[],
  context: CliContext,
  write: (line: string) => void,
  // Test seam: the host; the product composes gh, git, the install base's
  // lock and the module core of this process.
  hostFor?: (folder: string) => ContentHost,
): Promise<number> {
  let values: {
    folder?: string | undefined;
    json?: boolean | undefined;
    root?: string | undefined;
    role?: string | undefined;
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
        root: { type: "string" },
        role: { type: "string" },
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
    throw new ContentUsageError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
  }
  const [noun, verb, ...rest] = positionals;
  const organization = noun === "organization";
  const login = rest[0];
  if (organization && verb === "sync") {
    if (
      rest.length > 1 ||
      (login !== undefined && !githubLoginPattern.test(login)) ||
      values.root !== undefined ||
      values.role !== undefined ||
      (values.folder !== undefined &&
        (!isAbsolute(values.folder) ||
          resolve(values.folder) !== values.folder))
    )
      throw new ContentUsageError(usage);
    const json = values.json === true;
    const folder = values.folder ?? (await operatorFolder(context));
    if (folder === undefined) {
      write(
        json
          ? JSON.stringify({ kind: "blocked", reason: "folder-unknown" })
          : "No Folder known: name it with --folder <absolute Folder>.",
      );
      return 2;
    }
    return runSyncCommand(login, folder, json, context, write, hostFor);
  }
  if (
    verb !== "install" ||
    (organization &&
      (rest.length !== 1 ||
        login === undefined ||
        !githubLoginPattern.test(login))) ||
    (!organization && (noun !== "personalspace" || rest.length !== 0)) ||
    (!organization &&
      (values.root !== undefined || values.role !== undefined)) ||
    // As the resident CLI: an Admin installs without --role. The resident
    // knows no Reader; this CLI accepts it (decision F9, addendum
    // 2026-10-05).
    (values.role !== undefined && !isScopedRole(values.role)) ||
    (values.root !== undefined && !repositoryPattern.test(values.root)) ||
    (values.folder !== undefined &&
      (!isAbsolute(values.folder) || resolve(values.folder) !== values.folder))
  )
    throw new ContentUsageError(usage);
  const json = values.json === true;
  const print = (result: Record<string, unknown>, text: string) =>
    write(json ? JSON.stringify(result) : text);
  const folder = values.folder ?? (await operatorFolder(context));
  if (folder === undefined) {
    print(
      { kind: "blocked", reason: "folder-unknown" },
      "No Folder known: name it with --folder <absolute Folder>.",
    );
    return 2;
  }
  const item: ContentItemRef = organization
    ? { kind: "organization", login: login as string }
    : { kind: "personalspace" };
  const key = (login ?? "").toLowerCase();
  const request: InstallRequest = {
    items: [item],
    ...(organization && values.root !== undefined
      ? { roots: { [key]: values.root } }
      : {}),
    // The bare form is the Admin installation; it never falls back to a
    // narrower role (the Launchpad resolves the role live instead).
    ...(organization
      ? {
          roles: {
            [key]:
              values.role !== undefined && isScopedRole(values.role)
                ? values.role
                : ("admin" as const),
          },
        }
      : {}),
  };
  let host: ContentHost;
  let close = async () => {};
  if (hostFor !== undefined) host = hostFor(folder);
  else {
    let base: string;
    try {
      base = installBase(context, undefined);
    } catch {
      print(
        { kind: "blocked", reason: "base-unknown" },
        "No per-user install base on this platform.",
      );
      return 1;
    }
    const modules = createModuleOperations({
      folder,
      owner: "cli",
      host: processModuleHost(),
    });
    close = async () => {
      await modules.close();
    };
    host = processContentHost({
      env: context.env,
      platform: context.platform,
      base,
      prepare: async (name) => preparationAnswer(await modules.prepare(name)),
    });
  }
  try {
    const result = await installContent(
      folder,
      request,
      (step) => print({ kind: "content-step", ...step }, humanStep(step)),
      host,
    );
    if (result.kind === "not-allowed") {
      print(
        { kind: "blocked", reason: result.reason },
        result.reason === "prepared-by-hosting"
          ? "This Environment's content is prepared by its hosting; nothing to install here (prepared-by-hosting)."
          : result.reason === "folder-unreadable"
            ? "The Folder's state could not be read (folder-unreadable)."
            : `This Environment never holds ${itemLabel(item)} (not-for-this-environment).`,
      );
      return result.reason === "folder-unreadable" ? 1 : 2;
    }
    if (result.kind === "busy") {
      print(
        { kind: "blocked", reason: "content-busy" },
        "Another content operation runs on this Folder (content-busy).",
      );
      return 1;
    }
    print(
      result,
      result.state === "succeeded"
        ? (result.items[0]?.warnings ?? []).length === 0
          ? `${shown(itemLabel(item))}: installed.`
          : `${shown(itemLabel(item))}: installed, with ${(result.items[0]?.warnings ?? []).join(", ")}; see the bootstrap step above for the next step.`
        : `${shown(itemLabel(item))}: failed at ${result.failure?.key ?? "?"} (${result.failure?.code ?? "operation-failed"}).`,
    );
    return result.state === "succeeded" ? 0 : 1;
  } finally {
    await close();
  }
}
