import type { GitHubViewer } from "./github";

// Whose name a commit Lazurio makes on the person's behalf carries (the
// Personalspace's first commit after its bootstrap, the gbrain `.gitignore`,
// a personal module's first commit). The operator's own Git identity when
// git has one; otherwise the person's GitHub identity, which gh already
// knows: the profile's name (else the login) and GitHub's noreply address.
//
// The same identity is what the curated gh sign-in writes into the
// operator's global Git configuration where a field is missing (decision
// F19, addendum 2026-10-14, `src/tools/git-identity.ts`), so commits that
// Lazurio does not make (a repository-db data publish, an agent's commit)
// work too. This per-commit fallback (`git -c`, written nowhere) stays for
// an Environment whose gh was signed in another way or before that change,
// or where the write could not be made; it never overrides what git has.

export type CommitIdentity = Readonly<{ name: string; email: string }>;

/** The person's GitHub identity: the profile's name (else the login) and
 * `<id>+<login>@users.noreply.github.com`. */
export const githubCommitIdentity = (viewer: GitHubViewer): CommitIdentity =>
  Object.freeze({
    name: viewer.name ?? viewer.login,
    email: `${viewer.databaseId}+${viewer.login}@users.noreply.github.com`,
  });

/** The `-c` settings a commit needs: none where git's own configuration has
 * the field, the fallback's value where it has not. Null when a field is
 * missing and there is no fallback (git would refuse or guess). */
export async function identitySettings(
  configured: (key: "user.name" | "user.email") => Promise<string | null>,
  fallback: CommitIdentity | undefined,
): Promise<string[] | null> {
  const settings: string[] = [];
  for (const [key, field] of [
    ["user.name", "name"],
    ["user.email", "email"],
  ] as const) {
    const value = (await configured(key))?.trim();
    if (value) continue;
    if (fallback === undefined) return null;
    settings.push("-c", `${key}=${fallback[field]}`);
  }
  return settings;
}
