import type { PresetName } from "../folder/presets";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { ownerAnswerMs } from "./owner-answer";

// Whether this Environment's GitHub identity is an Owner of an Organization
// (decision F36 addendum of 2026-10-04): GitHub's own, live answer, read
// with the Environment's `gh` (`gh api user/memberships/orgs/<login>`: an
// active membership with the role `admin`). It decides only whether the
// Apps home offers "+ Nový modul"; it grants nothing, and no local rule
// stands in for it. A Team Environment acts under the Team's brokered
// identity and never founds modules for a person, and an Organization
// without a bound GitHub login has none to ask: both are no, without a
// call. Every failure is no (fail closed). An answer is kept a few
// minutes per login.

export const ownerCheck = Object.freeze({
  timeoutMs: 10_000,
  cacheMs: ownerAnswerMs,
});

export const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Whether a membership answer of the GitHub API is an active Owner's. */
export function isOwnerMembership(stdout: string): boolean {
  try {
    const value = JSON.parse(stdout) as { state?: unknown; role?: unknown };
    return value?.state === "active" && value?.role === "admin";
  } catch {
    return false;
  }
}

/** One read of the GitHub API with this Environment's `gh` (`gh api
 * <path>`), bounded by the check's timeout: its output, or null on any
 * failure (no `gh`, no home, a refusal, a timeout). Shared by the Owner
 * check and the Steward's `maintain` read (module-maintainer.ts), so both
 * ask GitHub the same way. */
export async function askGitHub(
  environment: ToolsEnvironment,
  path: string,
): Promise<string | null> {
  const gh = await resolveOnPath("gh", environment.path, environment.platform);
  if (gh === undefined || !environment.home) return null;
  const env: Record<string, string> = { HOME: environment.home };
  if (environment.path) env.PATH = environment.path;
  for (const [name, value] of Object.entries(environment.xdg ?? {}))
    env[name] = value;
  try {
    const result = await environment.run(
      [gh, "api", path],
      ownerCheck.timeoutMs,
      env,
    );
    return result !== "timeout" && result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

export function createOwnerCheck(
  environment: ToolsEnvironment,
  now: () => number = Date.now,
) {
  const answers = new Map<
    string,
    Readonly<{ owner: boolean; until: number }>
  >();
  const ask = async (organization: string): Promise<boolean> => {
    const stdout = await askGitHub(
      environment,
      `user/memberships/orgs/${organization}`,
    );
    return stdout !== null && isOwnerMembership(stdout);
  };
  return {
    /** The answer for a bound GitHub login on this Folder's preset. */
    async owner(
      organization: string | undefined,
      preset: PresetName,
    ): Promise<boolean> {
      if (
        organization === undefined ||
        !githubLogin.test(organization) ||
        preset === "hosted-organization-team"
      )
        return false;
      const key = organization.toLowerCase();
      const known = answers.get(key);
      if (known !== undefined && known.until > now()) return known.owner;
      const owner = await ask(organization);
      answers.set(key, { owner, until: now() + ownerCheck.cacheMs });
      return owner;
    },
  };
}
