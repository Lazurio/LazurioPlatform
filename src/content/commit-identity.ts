import type { GitHubViewer } from "./github";

// Whose name a commit Lazurio makes on the person's behalf carries (the
// Personalspace's first commit after its bootstrap, the gbrain `.gitignore`,
// a personal module's first commit). The operator's own Git identity when
// git has one; otherwise the person's GitHub identity, which gh already
// knows: the profile's name (else the login) and GitHub's noreply address.
// A Remote Environment sets no `user.name` or `user.email`, so without the
// second the first run would stop. It is passed per commit (`git -c`) and
// never written into any Git configuration.

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
