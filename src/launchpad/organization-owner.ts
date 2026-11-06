import type { PresetName } from "../folder/presets";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { ownerAnswerMs } from "./owner-answer";

// This Environment's GitHub identity in an Organization (decision F36
// addendum of 2026-10-04 and addendum of 2026-11-05): GitHub's own, live
// answer, read with the Environment's `gh` (`gh api
// user/memberships/orgs/<login>`): the role of an active membership, `admin`
// (an Owner, the Organization Admin) or `member`. It decides only what the
// Apps home offers as "+ Nový modul": the Organization Admin founds a module, a member asks
// the Organization Admin; it grants nothing, and no local rule stands in for it. A Team
// Environment acts under the Team's brokered identity and never founds
// modules for a person nor asks for them, and an Organization without a bound
// GitHub login has none to ask: both are no role, without a call. Every
// failure is no role (fail closed). An answer is kept a few minutes per login.

export const ownerCheck = Object.freeze({
  timeoutMs: 10_000,
  cacheMs: ownerAnswerMs,
});

export const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** What an active membership makes this identity in an Organization. */
export type OrganizationRole = "admin" | "member";

/** The role of an active membership in a membership answer of the GitHub
 * API; null for anything else (pending, a billing manager, no answer). */
export function membershipRole(stdout: string): OrganizationRole | null {
  try {
    const value = JSON.parse(stdout) as { state?: unknown; role?: unknown };
    if (value?.state !== "active") return null;
    return value?.role === "admin" || value?.role === "member"
      ? value.role
      : null;
  } catch {
    return null;
  }
}

/** Whether a membership answer of the GitHub API is an active Owner's. */
export const isOwnerMembership = (stdout: string): boolean =>
  membershipRole(stdout) === "admin";

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
    Readonly<{ role: OrganizationRole | null; until: number }>
  >();
  const ask = async (
    organization: string,
  ): Promise<OrganizationRole | null> => {
    const stdout = await askGitHub(
      environment,
      `user/memberships/orgs/${organization}`,
    );
    return stdout === null ? null : membershipRole(stdout);
  };
  const role = async (
    organization: string | undefined,
    preset: PresetName,
  ): Promise<OrganizationRole | null> => {
    if (
      organization === undefined ||
      !githubLogin.test(organization) ||
      preset === "hosted-organization-team"
    )
      return null;
    const key = organization.toLowerCase();
    const known = answers.get(key);
    if (known !== undefined && known.until > now()) return known.role;
    const answer = await ask(organization);
    answers.set(key, { role: answer, until: now() + ownerCheck.cacheMs });
    return answer;
  };
  return {
    /** The role for a bound GitHub login on this Folder's preset. */
    role,
    /** Whether that role is the Owner's. */
    async owner(
      organization: string | undefined,
      preset: PresetName,
    ): Promise<boolean> {
      return (await role(organization, preset)) === "admin";
    },
  };
}
