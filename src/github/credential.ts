import type { GithubHttp } from "./oauth";
import { ownerOfCredentialPath } from "./owner";
import {
  configuredOrganization,
  owningOrganization,
  type PilotConfig,
  type PilotPaths,
  readPilot,
} from "./pilot";
import { organizationToken, type SignInToken } from "./store";

// Git's credential helper of the pilot (decision F46), configured for
// `https://github.com` with `useHttpPath` by `pilot wire`, so each request
// names its repository. `get` answers with the user access token of the
// repository owner's Organization sign-in (`username=x-access-token`), or of
// the owning Organization for another owner, whose private repositories
// GitHub then refuses: the boundary is GitHub's, not this helper's. When no
// sign-in can answer, it answers `quit=1`, so Git neither asks another helper
// (one that may hold an account-wide credential) nor prompts on a terminal an
// agent cannot answer. `store` and `erase` do nothing: the sign-in is kept in
// its own file. https://git-scm.com/docs/git-credential

export type CredentialHost = Readonly<{
  paths: PilotPaths;
  http: GithubHttp;
  now: () => number;
  writeStderr: (text: string) => void;
}>;

/** The attributes of one request: `key=value` lines up to an empty line. */
export function parseCredentialRequest(
  input: string,
): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const text = line.replace(/\r$/, "");
    if (text === "") break;
    const separator = text.indexOf("=");
    if (separator <= 0) continue;
    const key = text.slice(0, separator);
    // Only single-valued attributes are read; `capability[]`, `wwwauth[]`
    // and their kin are not.
    if (/^[a-z_]+$/.test(key) && !Object.hasOwn(attributes, key))
      attributes[key] = text.slice(separator + 1);
  }
  return Object.freeze(attributes);
}

export const tokenAdvice = (
  organization: string,
  answer: Exclude<SignInToken, { kind: "token" }>,
): string => {
  const signIn = `lazurio github sign-in --organization ${organization}`;
  if (answer.kind === "signed-out")
    switch (answer.reason) {
      case "not-signed-in":
        return `This Environment is not signed in to GitHub for ${organization}. The Operator signs in with ${signIn} and approves the code in their own browser.`;
      case "refresh-rejected":
        return `The GitHub sign-in for ${organization} has ended: GitHub refused to renew it. Sign in again: ${signIn}`;
      case "sign-in-expired":
        return `The GitHub sign-in for ${organization} ran out after six months without use. Sign in again: ${signIn}`;
      case "app-changed":
        return `The GitHub sign-in for ${organization} belongs to another sign-in app than the one configured now. Sign out and in again: lazurio github sign-out --organization ${organization}, then ${signIn}`;
    }
  switch (answer.reason) {
    case "unreachable":
      return `GitHub could not be reached to renew the sign-in for ${organization}. Try again in a moment.`;
    case "busy":
      return `Another process is renewing the GitHub sign-in for ${organization}. Try again in a moment.`;
    case "unreadable":
      return `The GitHub sign-in for ${organization} cannot be read. Sign out and in again: lazurio github sign-out --organization ${organization}, then ${signIn}`;
  }
};

/** Which Organization's sign-in answers for a repository owner: its own when
 * it is configured, else the owning Organization's (`foreign` names the
 * owner, so the caller can say why GitHub may refuse). */
export function chooseOrganization(
  config: PilotConfig,
  owner: string | null,
): Readonly<{
  organization: ReturnType<typeof owningOrganization>;
  foreign: string | null;
}> {
  if (owner !== null) {
    const configured = configuredOrganization(config, owner);
    if (configured !== undefined)
      return { organization: configured, foreign: null };
  }
  return { organization: owningOrganization(config), foreign: owner };
}

export const foreignNotice = (
  config: PilotConfig,
  owner: string,
  tool: "gh" | "git",
): string =>
  `${tool} (Lazurio): ${owner} is not an Organization this Environment is signed in to (${config.organizations
    .map((entry) => entry.login)
    .join(
      ", ",
    )}), so GitHub answers with the sign-in of ${owningOrganization(config).login}, which reaches only its own Organization. If GitHub refused, that is why: another Organization's private repositories are reached from its own Environment, or the Operator adds its sign-in here (lazurio github pilot add).`;

export async function credentialHelper(
  action: string,
  input: string,
  host: CredentialHost,
): Promise<Readonly<{ stdout: string; code: number }>> {
  if (action !== "get") return { stdout: "", code: 0 };
  const request = parseCredentialRequest(input);
  // Only GitHub over HTTPS is this helper's; Git asks it for nothing else.
  if (
    request.protocol !== "https" ||
    (request.host ?? "").toLowerCase() !== "github.com"
  )
    return { stdout: "", code: 0 };
  const quit = (message: string) => {
    host.writeStderr(`git (Lazurio): ${message}\n`);
    return { stdout: "quit=1\n", code: 0 };
  };
  const pilot = await readPilot(host.paths);
  if (pilot.kind === "off")
    return quit(
      "the GitHub sign-in pilot is off, but Git still asks its helper. Restore Git and gh: lazurio github pilot unwire",
    );
  if (pilot.kind === "unreadable")
    return quit(
      `the GitHub sign-in pilot's configuration cannot be read (${host.paths.config}).`,
    );
  const owner = ownerOfCredentialPath(request.path);
  const { organization, foreign } = chooseOrganization(pilot.config, owner);
  const answer = await organizationToken({
    paths: host.paths,
    organization,
    http: host.http,
    now: host.now,
  });
  if (answer.kind !== "token")
    return quit(tokenAdvice(organization.login, answer));
  if (foreign !== null)
    host.writeStderr(`${foreignNotice(pilot.config, foreign, "git")}\n`);
  return {
    stdout: [
      "username=x-access-token",
      `password=${answer.token}`,
      `password_expiry_utc=${Math.floor(answer.expiresAt / 1000)}`,
      "",
    ].join("\n"),
    code: 0,
  };
}
