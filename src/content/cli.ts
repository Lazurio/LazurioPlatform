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
  preparationAnswer,
  processContentHost,
} from "./host";
import { type InstallRequest, installContent } from "./install";
import {
  type ContentItemRef,
  type ContentStep,
  githubLoginPattern,
  itemLabel,
  repositoryPattern,
} from "./model";

/** `lazurio organization install` and `lazurio personalspace install`: the
 * terminal surface of content installation. The Launchpad's
 * `POST /api/content/install` runs the same core. */
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
  others continue; infra, repository databases and restricted slots are left
  out. An existing repository is never fetched, switched or reset, and an
  occupied destination is never touched. The root of an Organization the
  Folder already holds is that checkout. Otherwise a name is only a
  candidate: --root <owner>/<repository> when named, else
  <login>/<login>_GEN3, else the one repository of the Organization this
  account can read, each accepted only when its own lazurio.organization.json
  declares it the root of that login (root-declaration-mismatch for a named
  one that does not; root-not-found or root-ambiguous after the scan). The scope follows the person's role in the Organization, as
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
  (hosted-organization-personal, its own Organization only). One JSON line
  per step with --json, then the result.
personalspace install [--folder <absolute Folder>] [--json]
  Installs the person's Personalspace into personalspace/<login>_GEN3: when
  <login>/<login>_GEN3 exists on GitHub (private, the person's own), it is
  cloned; otherwise it is created from Lazurio/PersonalspaceTemplate_GEN3 as
  a private repository of the person's account and then cloned. When a
  repository of the person was already created from that template under
  another name, nothing is created (personalspace-elsewhere). Only on a
  workstation (local) and a personal Remote Environment (hosted-personal,
  only for its owner's GitHub account). An existing Personalspace is left as
  it is.
Neither runs on a Team or Automated Environment, whose content the hosting
prepares (prepared-by-hosting). One content operation runs at a time per
Folder (content-busy). The Folder is found as for organization list.
Exit status: 0 installed, 1 failed (the step and its code are printed), 2
usage or not allowed on this Environment.`;

export class ContentUsageError extends Error {}

/** The roles `--role` names; the Admin installation is the bare form. */
const scopedRoles = ["builder", "steward", "reader"] as const;
const isScopedRole = (value: string): value is (typeof scopedRoles)[number] =>
  (scopedRoles as readonly string[]).includes(value);

const usage =
  "Usage: organization install <github-login> [--role builder|steward|reader] [--root <owner>/<repository>] [--folder <Folder>] [--json] | personalspace install [--folder <Folder>] [--json]";

/** Whether `args` is a content command (the dispatcher's question). */
export const isContentCommand = (args: readonly string[]) =>
  (args[0] === "organization" || args[0] === "personalspace") &&
  args[1] === "install";

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
        ? `${shown(itemLabel(item))}: installed.`
        : `${shown(itemLabel(item))}: failed at ${result.failure?.key ?? "?"} (${result.failure?.code ?? "operation-failed"}).`,
    );
    return result.state === "succeeded" ? 0 : 1;
  } finally {
    await close();
  }
}
