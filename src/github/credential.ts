import type { GithubHttp } from "./oauth";
import { credentialRecoveryAdvice, type PilotPaths, readPilot } from "./pilot";
import { applicationToken, type SignInToken } from "./store";

// HTTPS Git and gh use the same App chain. The repository path never picks
// credentials or narrows authority: GitHub checks the user's/App's rights.
// A missing sign-in answers quit=1 so Git cannot silently use another helper.

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
  const signIn = "lazurio github sign-in";
  if (answer.kind === "signed-out")
    switch (answer.reason) {
      case "not-signed-in":
        return `This Environment is not signed in to GitHub for ${organization}. The user signs in with ${signIn} and approves the code in their own browser.`;
      case "refresh-rejected":
        return `The GitHub sign-in for ${organization} has ended: GitHub refused to renew it. Sign in again: ${signIn}`;
      case "sign-in-expired":
        return `The GitHub sign-in for ${organization} ran out after six months without use. Sign in again: ${signIn}`;
      case "app-changed":
        return credentialRecoveryAdvice;
    }
  switch (answer.reason) {
    case "unreachable":
      return `GitHub could not be reached to renew the sign-in for ${organization}. Try again in a moment.`;
    case "busy":
      return `Another process is renewing the GitHub sign-in for ${organization}. Try again in a moment.`;
    case "unreadable":
      return credentialRecoveryAdvice;
  }
};

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
  const organization = pilot.config.application;
  const answer = await applicationToken({
    paths: host.paths,
    organization,
    http: host.http,
    now: host.now,
  });
  if (answer.kind !== "token")
    return quit(tokenAdvice(organization.login, answer));
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
