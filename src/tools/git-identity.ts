import {
  type CommitIdentity,
  githubCommitIdentity,
} from "../content/commit-identity";
import { parseViewer } from "../content/github";
import type { SshRunner } from "./ssh-key";

// The person's Git identity, set by the gh sign-in (decision F19, addendum
// 2026-10-14; Matěj: "Git Identity by měl řešit Launchpad při nastavování
// GH"). Every commit in the Environment needs `user.name` and `user.email`:
// a data publish of a repository-db app, an agent's commit, Lazurio's own.
// A workstation usually has them; a Remote Environment had none, so the
// first such commit failed with "Author identity unknown". After gh signs in
// as the person, each field that git's global and system configuration do
// not name is written into the operator's global configuration (`git config
// --global`, which is `~/.gitconfig` on every platform) from the person's
// GitHub identity, exactly as `githubCommitIdentity` builds it: the
// profile's name, else the login, and `<id>+<login>@users.noreply.github.com`.
// An existing value is never changed. A Team Environment never gets here:
// its gh sign-in is refused (`team-github.ts`), and the session asks the
// Team rule again right before the write.

export type GitIdentityField = "user.name" | "user.email";

export type GitIdentityFailure =
  /** git is not on the operator's PATH. */
  | "git-missing"
  /** git could not say whether the field is set (no home, an unreadable or
   * malformed configuration, a timeout): nothing is written. */
  | "config-unreadable"
  /** GitHub did not return the signed-in account (`gh api user`), or it
   * returned another one: nothing is written. */
  | "viewer-unavailable"
  /** `git config --global` refused the write. */
  | "write-failed";

export type GitIdentity =
  /** git already names both fields; nothing was written. */
  | Readonly<{ state: "present" }>
  /** The missing fields were written from the person's GitHub identity. */
  | Readonly<{
      state: "set";
      fields: readonly GitIdentityField[];
      identity: CommitIdentity;
    }>
  | Readonly<{
      state: "not-set";
      reason: GitIdentityFailure;
      /** The fields git still lacks, when that is known. */
      missing?: readonly GitIdentityField[];
    }>;

export const gitIdentityFailures: readonly GitIdentityFailure[] = [
  "git-missing",
  "config-unreadable",
  "viewer-unavailable",
  "write-failed",
];

export type GitIdentityContext = Readonly<{
  /** `git` as found on the operator's PATH, when it is. */
  git: string | undefined;
  gh: string;
  /** The account gh confirmed; GitHub's answer must name the same one. */
  account: string;
  run: SshRunner;
  /** Asked right before the first write: false ends the step as `gone`
   * (the Environment became a Team one meanwhile). */
  proceed?: () => Promise<boolean>;
}>;

const stepTimeoutMs = 30_000;
const fields: readonly [GitIdentityField, keyof CommitIdentity][] = [
  ["user.name", "name"],
  ["user.email", "email"],
];

// Whether git's global or system configuration names the field: true, false,
// or null when git could not say. `git config --get` exits 1 for a missing
// key and 0 with its value; anything else is an error. Includes are followed
// as git follows them when it commits.
async function configured(
  context: GitIdentityContext,
  git: string,
  key: GitIdentityField,
): Promise<boolean | null> {
  for (const scope of ["--global", "--system"]) {
    let result: Awaited<ReturnType<SshRunner>>;
    try {
      result = await context.run(
        [git, "config", scope, "--includes", "--get", key],
        stepTimeoutMs,
      );
    } catch {
      return null;
    }
    if (result === "timeout") return null;
    if (result.exitCode === 0 && result.stdout.trim() !== "") return true;
    if (result.exitCode !== 0 && result.exitCode !== 1) return null;
  }
  return false;
}

/** Sets the fields of the person's Git identity that git lacks, from the
 * signed-in GitHub account; `gone` when `proceed` refused the write. A run
 * that fails (its owner ended it meanwhile included) is reported as not
 * set; the caller checks whether its session is still current. */
export async function ensureGitIdentity(
  context: GitIdentityContext,
): Promise<GitIdentity | "gone"> {
  const git = context.git;
  if (git === undefined) return { state: "not-set", reason: "git-missing" };
  const missing: GitIdentityField[] = [];
  for (const [key] of fields) {
    const known = await configured(context, git, key);
    if (known === null)
      return { state: "not-set", reason: "config-unreadable" };
    if (!known) missing.push(key);
  }
  if (missing.length === 0) return { state: "present" };
  let viewer: ReturnType<typeof parseViewer> = null;
  try {
    const answer = await context.run(
      [context.gh, "api", "user"],
      stepTimeoutMs,
    );
    if (answer !== "timeout" && answer.exitCode === 0)
      viewer = parseViewer(answer.stdout);
  } catch {}
  // GitHub logins are case-insensitive.
  if (
    viewer === null ||
    viewer.login.toLowerCase() !== context.account.toLowerCase()
  )
    return { state: "not-set", reason: "viewer-unavailable", missing };
  if (context.proceed !== undefined && !(await context.proceed()))
    return "gone";
  const identity = githubCommitIdentity(viewer);
  const written: GitIdentityField[] = [];
  for (const [key, field] of fields) {
    if (!missing.includes(key)) continue;
    let result: Awaited<ReturnType<SshRunner>> | undefined;
    try {
      result = await context.run(
        // `--`: a profile name may begin with "-".
        [git, "config", "--global", "--", key, identity[field]],
        stepTimeoutMs,
      );
    } catch {}
    if (result === undefined || result === "timeout" || result.exitCode !== 0)
      return {
        state: "not-set",
        reason: "write-failed",
        missing: missing.filter((entry) => !written.includes(entry)),
      };
    written.push(key);
  }
  return { state: "set", fields: written, identity };
}
