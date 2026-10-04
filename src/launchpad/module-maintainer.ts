import type { PresetName } from "../folder/presets";
import type { ToolsEnvironment } from "../tools/overview";
import { askGitHub, githubLogin, ownerCheck } from "./organization-owner";

// Whether this Environment's GitHub identity may maintain a module's
// repository (decision 0185 S15, issue #151): GitHub's own, live answer, read
// with the Environment's `gh` the same way as the Owner check
// (`gh api repos/<owner>/<repo>`: `permissions.maintain`; an admin of the
// repository has it too). It decides only whether a tile's menu offers
// "Přístup k modulu" to a Steward, which leads to the Organization's
// Dashboard; it grants nothing, and the Dashboard decides again with its own
// live read. A Team Environment acts under the Team's brokered identity, never
// a person's role, and gets no answer without a call, as with the Owner
// check. A repository outside the module's own Organization is no: its Teams
// are not the Organization's to switch. Every failure is no (fail closed). An
// answer is kept a few minutes per repository, and one question per
// repository is asked at a time.

const repositoryName = /^[A-Za-z0-9_.-]{1,100}$/;

/** The owner and name of a github.com repository page
 * (`https://github.com/<owner>/<name>`, as the catalog records it), or null. */
export function githubRepositoryOf(
  page: string | undefined,
): Readonly<{ owner: string; name: string }> | null {
  if (page === undefined) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(page);
  const owner = match?.[1];
  const name = match?.[2];
  if (
    owner === undefined ||
    name === undefined ||
    !githubLogin.test(owner) ||
    !repositoryName.test(name) ||
    /^\.+$/.test(name)
  )
    return null;
  return { owner, name };
}

/** Whether a repository answer of the GitHub API grants `maintain`. */
export function isMaintainer(stdout: string): boolean {
  try {
    const value = JSON.parse(stdout) as {
      permissions?: { maintain?: unknown };
    };
    return value?.permissions?.maintain === true;
  } catch {
    return false;
  }
}

export function createMaintainerCheck(
  environment: ToolsEnvironment,
  now: () => number = Date.now,
) {
  const answers = new Map<
    string,
    Readonly<{ maintain: boolean; until: number }>
  >();
  const asking = new Map<string, Promise<boolean>>();
  return {
    /** The answer for a module's repository page in an Organization bound
     * to a GitHub login, on this Folder's preset. */
    async maintain(
      organization: string | undefined,
      page: string | undefined,
      preset: PresetName,
    ): Promise<boolean> {
      const repository = githubRepositoryOf(page);
      if (
        organization === undefined ||
        !githubLogin.test(organization) ||
        repository === null ||
        repository.owner.toLowerCase() !== organization.toLowerCase() ||
        preset === "hosted-organization-team"
      )
        return false;
      const key = `${repository.owner}/${repository.name}`.toLowerCase();
      const known = answers.get(key);
      if (known !== undefined && known.until > now()) return known.maintain;
      const pending = asking.get(key);
      if (pending !== undefined) return pending;
      const question = askGitHub(
        environment,
        `repos/${repository.owner}/${repository.name}`,
      )
        .then((stdout) => stdout !== null && isMaintainer(stdout))
        .then((maintain) => {
          answers.set(key, { maintain, until: now() + ownerCheck.cacheMs });
          return maintain;
        })
        .finally(() => asking.delete(key));
      asking.set(key, question);
      return question;
    },
  };
}
