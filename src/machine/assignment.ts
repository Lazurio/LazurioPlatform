import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ownedIdentity,
  type PersonalspacePolicy,
} from "../folder/handover-layout";
import { adoptedHandoverFolder } from "../folder/initialize-folder";
import {
  isAccountSubject,
  type MachineBinding,
} from "../folder/machine-binding";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import type {
  MachineContext,
  MachineEntry,
  OrganizationAssignment,
  OrganizationWorkspaceContext,
  PersonalMachineContext,
} from "./context";

// A free Environment (root decision 0216; Machines docs/free-environments.md
// §5.3 and §5.4) is built ahead, nobody's, and assigned to one person later
// in Lazurio Auth. Its apply never learns who that person is, so its
// handover is *auth-sourced*: it names the neutral Machine, an owner that
// follows the assignment (personal) or the assignment's source (work), and
// points to the receipt the Environment's assignment finisher writes,
// /etc/lazurio/assignment.json. Its entry carries the name-bound origins as
// templates over the receipt's `dns_slug`. Platform reads that receipt only
// for such a handover, and acts for a person only once the receipt names
// one: then the handover resolves into the context every reader already
// knows (`resolveAssignedContext`), and before that nothing is created or
// refreshed for anybody (`machine-assignment-pending`).

export const assignmentReceiptPath = "/etc/lazurio/assignment.json";
export const assignmentReceiptSchema = "lazurio.assignment.v1";
/** The placeholder of the frozen username in a templated origin. */
export const dnsSlugPlaceholder = "{dns_slug}";

export type AssignmentReceiptPointer = Readonly<{
  path: typeof assignmentReceiptPath;
  schema_version: typeof assignmentReceiptSchema;
}>;

/** The owner of a free personal Environment: the provider until the first
 * binding, the receipt's first assignee from then on, for good. */
export type AssignmentOwner = Readonly<{ kind: "assignment"; source: "auth" }>;
/** The assignment of a free work Environment: only its kind is declared. */
export type AuthOperatorAssignment = Readonly<{
  kind: "operator";
  source: "auth";
}>;

export type AuthSourcedPersonalHandover = Readonly<
  Omit<PersonalMachineContext, "owner" | "vault"> & {
    owner: AssignmentOwner;
    assignment_receipt: AssignmentReceiptPointer;
  }
>;
export type AuthSourcedWorkHandover = Readonly<
  Omit<OrganizationWorkspaceContext, "owner" | "vault" | "services"> & {
    owner: Readonly<
      Omit<OrganizationWorkspaceContext["owner"], "assignment"> & {
        assignment: AuthOperatorAssignment;
      }
    >;
    assignment_receipt: AssignmentReceiptPointer;
  }
>;
export type AuthSourcedHandover =
  | AuthSourcedPersonalHandover
  | AuthSourcedWorkHandover;

/** Whether a handover the schema accepted is auth-sourced. */
export function isAuthSourced(
  handover: MachineContext | AuthSourcedHandover,
): handover is AuthSourcedHandover {
  return "assignment_receipt" in handover;
}

type Assignee = Readonly<{
  subject: string;
  github_id: number | null;
  github_login: string | null;
}>;
/** The receipt as the finisher writes it (Machines
 * workloads/shared/free-environments.ts `AssignmentReceipt`), closed. */
export type AssignmentReceipt = Readonly<{
  schema_version: typeof assignmentReceiptSchema;
  environment: string;
  state: "free" | "assigned" | "suspended" | "released";
  generation: number;
  first: Readonly<{
    generation: number;
    subject: string;
    github_id: number | null;
  }> | null;
  current: Readonly<{ generation: number; assignee: Assignee }> | null;
  dns_slug: string | null;
  organization: string | null;
  account: string | null;
  hostname: string | null;
}>;

export class AssignmentReceiptError extends Error {
  constructor(
    public readonly code: // the receipt names nobody yet (or there is none yet)
      | "machine-assignment-pending"
      // the assignment was released: the Environment waits for its end
      | "machine-assignment-released"
      // anything the finisher would not have written, or another Machine's
      | "machine-context-invalid",
  ) {
    super(code);
  }
}

const receiptKeys = [
  "account",
  "current",
  "dns_slug",
  "environment",
  "first",
  "generation",
  "hostname",
  "organization",
  "schema_version",
  "state",
];
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const linuxAccount = /^[a-z][a-z0-9-]{0,31}$/;
const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const states = ["free", "assigned", "suspended", "released"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const isCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isGithubId = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

function assignee(value: unknown): Assignee {
  if (
    !isObject(value) ||
    !keysAre(value, ["github_id", "github_login", "subject"]) ||
    !isAccountSubject(value.subject)
  )
    throw new AssignmentReceiptError("machine-context-invalid");
  const linked =
    isGithubId(value.github_id) &&
    typeof value.github_login === "string" &&
    githubLogin.test(value.github_login);
  if (!linked && (value.github_id !== null || value.github_login !== null))
    throw new AssignmentReceiptError("machine-context-invalid");
  return value as Assignee;
}

/** The closed receipt, refused whole on anything else. Never echoes it. */
export function parseAssignmentReceipt(input: unknown): AssignmentReceipt {
  const invalid = () => new AssignmentReceiptError("machine-context-invalid");
  if (
    !isObject(input) ||
    !keysAre(input, receiptKeys) ||
    input.schema_version !== assignmentReceiptSchema ||
    typeof input.environment !== "string" ||
    !slug.test(input.environment) ||
    !states.includes(input.state as string) ||
    !isCount(input.generation) ||
    (input.organization !== null &&
      (typeof input.organization !== "string" ||
        input.organization.length > 63 ||
        !slug.test(input.organization)))
  )
    throw invalid();
  const { first, current } = input;
  if (first === null) {
    if (
      current !== null ||
      input.dns_slug !== null ||
      input.account !== null ||
      input.hostname !== null ||
      (input.state !== "free" && input.state !== "released")
    )
      throw invalid();
    return input as AssignmentReceipt;
  }
  if (
    !isObject(first) ||
    !keysAre(first, ["generation", "github_id", "subject"]) ||
    !isCount(first.generation) ||
    !isAccountSubject(first.subject) ||
    (first.github_id !== null && !isGithubId(first.github_id)) ||
    typeof input.dns_slug !== "string" ||
    input.dns_slug.length > 32 ||
    !slug.test(input.dns_slug) ||
    typeof input.account !== "string" ||
    !linuxAccount.test(input.account) ||
    typeof input.hostname !== "string" ||
    input.hostname.length > 63 ||
    !slug.test(input.hostname)
  )
    throw invalid();
  if (current !== null) {
    if (
      !isObject(current) ||
      !keysAre(current, ["assignee", "generation"]) ||
      !isCount(current.generation) ||
      assignee(current.assignee).subject !== first.subject
    )
      throw invalid();
  }
  return input as AssignmentReceipt;
}

/** A name-bound origin with the frozen username: `{dns_slug}` exactly once,
 * as one whole label, as the wire schema holds it. */
function filled(template: string, dnsSlug: string): string {
  if (template.split(dnsSlugPlaceholder).length !== 2)
    throw new AssignmentReceiptError("machine-context-invalid");
  return template.replace(dnsSlugPlaceholder, dnsSlug);
}

function filledEntry(entry: MachineEntry, dnsSlug: string): MachineEntry {
  const origin = <T extends { external_origin: string }>(member: T): T => ({
    ...member,
    external_origin: filled(member.external_origin, dnsSlug),
  });
  return {
    ...entry,
    launchpad: {
      ...origin(entry.launchpad),
      auth_check_url: filled(entry.launchpad.auth_check_url, dnsSlug),
    },
    t3code: origin(entry.t3code),
    modules: {
      origin_template: filled(entry.modules.origin_template, dnsSlug),
    },
    ...(entry.mausbot === undefined ? {} : { mausbot: origin(entry.mausbot) }),
    ...(entry.browser === undefined ? {} : { browser: origin(entry.browser) }),
    ...(entry.buddy === undefined ? {} : { buddy: origin(entry.buddy) }),
  };
}

/**
 * The context of an auth-sourced handover once its receipt names a person,
 * in the shape every reader of the handover knows:
 *
 * - the person's account (`account`), whose home holds the Folder, is the
 *   operator: the handover's `operator` is the neutral operational account,
 *   which never holds the Folder or anything of the person;
 * - a personal Environment's owner is the first assignee's Lazurio account
 *   (`kind: account`): the frozen username (`dns_slug`), which is also its
 *   name, and the Lazurio subject. The username is no GitHub login: it can
 *   be chosen, or survive a rename or relink (Machines
 *   docs/free-environments.md §3, §5.5). Its GitHub account is recorded only
 *   as the receipt verifies it: when the current generation links the
 *   GitHub id the first binding linked, with that generation's login, and
 *   otherwise none (a relink to another account, or an unlink);
 * - a work Environment's assignee is the operator by the same Lazurio
 *   account (`{kind: operator, account}`): the username, the subject and the
 *   GitHub account the current generation links, or none, which a work
 *   Environment does not need (root decision 0192); a later link or unlink
 *   is a new fact of the same assignee;
 * - the entry's templates are filled with the frozen username.
 *
 * The receipt must be this Machine's: its Machine id and, on a work
 * Environment, its Organization. Before the first binding there is nobody
 * to act for (`machine-assignment-pending`), and after the release nothing
 * more is done for anybody (`machine-assignment-released`): the Environment
 * is destroyed after its export window, never handed on.
 */
export function resolveAssignedContext(
  handover: AuthSourcedHandover,
  receipt: AssignmentReceipt,
): MachineContext {
  const work = handover.machine.kind === "workspace-vm";
  const organization = work
    ? (handover as AuthSourcedWorkHandover).owner.organization
    : null;
  if (
    receipt.environment !== handover.machine.id ||
    receipt.organization !== organization
  )
    throw new AssignmentReceiptError("machine-context-invalid");
  if (receipt.state === "released")
    throw new AssignmentReceiptError("machine-assignment-released");
  const { first, account, dns_slug: dnsSlug } = receipt;
  if (first === null || account === null || dnsSlug === null)
    throw new AssignmentReceiptError("machine-assignment-pending");
  const home = `/home/${account}`;
  const operator = Object.freeze({
    os_user: account,
    home,
    lazurio_root: `${home}/Lazurio`,
  });
  const { assignment_receipt: _pointer, entry, ...rest } = handover;
  const filledIn =
    entry === undefined ? {} : { entry: filledEntry(entry, dnsSlug) };
  if (!work) {
    // A personal assignment needs a linked GitHub account (Auth refuses it
    // otherwise): a first binding without one is not the finisher's.
    if (first.github_id === null)
      throw new AssignmentReceiptError("machine-context-invalid");
    const linked = receipt.current?.assignee;
    const personal = rest as Omit<AuthSourcedPersonalHandover, "entry">;
    return {
      ...personal,
      machine: { ...personal.machine, name: dnsSlug },
      owner: {
        kind: "account",
        username: dnsSlug,
        subject: first.subject,
        github:
          linked !== undefined &&
          linked.github_id === first.github_id &&
          linked.github_login !== null
            ? { login: linked.github_login.toLowerCase(), id: linked.github_id }
            : null,
      },
      operator,
      ...filledIn,
    } as PersonalMachineContext;
  }
  const person = receipt.current?.assignee;
  const workspace = rest as Omit<AuthSourcedWorkHandover, "entry">;
  const assignment: OrganizationAssignment = {
    kind: "operator",
    account: {
      username: dnsSlug,
      subject: first.subject,
      github:
        person === undefined ||
        person.github_id === null ||
        person.github_login === null
          ? null
          : { login: person.github_login.toLowerCase(), id: person.github_id },
    },
  };
  return {
    ...workspace,
    owner: { ...workspace.owner, assignment },
    operator,
    ...filledIn,
  } as OrganizationWorkspaceContext;
}

/** Whether a layout entry exists, held to the adoption's own rule when it
 * does (`ownedIdentity`: a real directory of this account, not shared, on
 * a canonical path, so never a link, dangling or not). */
async function presentEntry(path: string, entry: string): Promise<boolean> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await ownedIdentity(path, entry);
  return true;
}

/** The mode of a directory this call has just created, set on the directory
 * itself: opened without following a link, so a path replaced meanwhile is
 * refused rather than changed elsewhere. */
async function setOwnMode(path: string, mode: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/**
 * The Folder layout of a free Environment, created in the person's home at
 * the assignment (nothing ahead): on every other Environment the Machines
 * deliver it before the handover (their workspace_baseline role), with the
 * same modes: the Folder 0750, `organizations` 0755 and, where the preset
 * has one, `personalspace` 0700. `folder-init` calls it only once the
 * preset is allowed (`initializeMachineFolder`), and it writes nothing
 * before everything it would build on has passed: the home, every entry
 * that exists already by the rule adoption applies to it (a link, dangling
 * or not, a file, another account's or a shared directory is refused), and
 * a Folder adopted from another Machine (`binding-changed`). Only then does
 * it create what is missing, with `mkdir`, which never follows a link at
 * the path it creates and fails when anything appeared there meanwhile.
 * Nothing existing is touched; `folder-init` then adopts the layout exactly
 * as it adopts a delivered one. Not a sandbox against the same account
 * replacing the Folder while this runs, as `inspectOwnedDirectory` says.
 */
export async function createAssignedFolderLayout(
  folder: string,
  machine: MachineBinding,
  personalspace: PersonalspacePolicy,
): Promise<void> {
  await inspectOwnedDirectory(dirname(folder));
  const entries: readonly (readonly [string, string, number])[] = [
    [folder, ".", 0o750],
    [join(folder, "organizations"), "organizations", 0o755],
    ...(personalspace === "present"
      ? [[join(folder, "personalspace"), "personalspace", 0o700] as const]
      : []),
  ];
  const missing: (readonly [string, number])[] = [];
  for (const [path, entry, mode] of entries)
    if (!(await presentEntry(path, entry))) missing.push([path, mode]);
  await adoptedHandoverFolder(folder, machine);
  for (const [path, mode] of missing) {
    await mkdir(path, { mode });
    // Independent of the caller's umask, as the Machines' role sets them.
    await setOwnMode(path, mode);
  }
}
