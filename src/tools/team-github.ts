// GitHub on a Team Environment (Principal 2026-09-28, decision F19 addendum
// of the same day): a Team Environment works in GitHub through the GitHub App
// "Lazurio for GitHub" that the Organization sets up, never through a
// person's account. The curated sign-in of gh and the linking of a person's
// SSH key are refused there; signing out stays possible exactly when a
// person's account is signed in (a left-over of the ended exception), because
// removing it from the shared Machine is what the rule wants. Pure and
// dependency-free, so the Launchpad page decides with exactly the rule the
// server and the CLI enforce.

type Text = Readonly<{ cs: string; en: string }>;

/** The one wording of the rule, for the CLI, the server's callers and the
 * Launchpad. */
export const teamGithubText: Text = {
  cs: "Tenhle týmový Environment pracuje v GitHubu přes Lazurio for GitHub, které nastavuje Organizace. Osobní účty GitHubu se tady nepřihlašují.",
  en: "This Team Environment works in GitHub through Lazurio for GitHub, set up by the Organization. Personal GitHub accounts are not signed in here.",
};

/** Why a sign-out of gh is refused there: no person's account to remove. */
export const teamGithubLogoutText: Text = {
  cs: "Odhlašuje se tu jen osobní účet GitHubu, který tu zůstal přihlášený, a gh žádný takový nehlásí; identitu GitHubu Organizace Lazurio neodhlašuje.",
  en: "Only a personal GitHub account left signed in here is signed out, and gh reports none; Lazurio does not sign out the Organization's GitHub identity.",
};

/** In gh's status line, instead of the state of a person's SSH key. */
export const teamGithubPhrase: Text = {
  cs: "používá Lazurio for GitHub",
  en: "uses Lazurio for GitHub",
};

/** In gh's status line when the Organization's App identity works there;
 * `{account}` is its login (`lazurio-for-github[bot]`). */
export const teamGithubWorksAs: Text = {
  cs: "pracuje jako {account}",
  en: "works as {account}",
};

/** What kind of GitHub identity the active github.com account of gh is,
 * read from `gh auth status --hostname github.com`:
 * - `person`: a user account whose token gh stores itself (its keyring or
 *   its hosts file), which is what a sign-in leaves and what `gh auth logout`
 *   removes;
 * - `app`: a GitHub App's own identity (a `…[bot]` login or an installation
 *   token `ghs_…`), such as Lazurio for GitHub through the Organization's
 *   token broker;
 * - `variable`: a token from an environment variable (`GH_TOKEN`,
 *   `GITHUB_TOKEN`, …), which is how a wrapper hands gh a brokered token and
 *   which `gh auth logout` cannot remove;
 * - `unknown`: the output does not say. */
export type GhIdentity = "person" | "app" | "variable" | "unknown";

// "✓ Logged in to github.com account <login> (<source>)" (gh 2.40 and later)
// or "… as <login> (<source>)" (earlier). The first entry is the active
// account; a GitHub login is letters, digits and hyphens, so a `[bot]`
// suffix can only be an App's identity.
const activeEntry =
  /Logged in to github\.com (?:account|as) [A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])? \(([^()\r\n]*)\)/;

/** The kind of identity of one account entry of gh: its login and where gh
 * took its token from (`tokenSource` of `gh auth status --json hosts`, or the
 * parenthesis of the text form). */
export function ghIdentityOf(login: string, tokenSource: string): GhIdentity {
  if (login.endsWith("[bot]")) return "app";
  if (/^[A-Z][A-Z0-9_]*_TOKEN$/.test(tokenSource)) return "variable";
  if (
    tokenSource === "keyring" ||
    tokenSource === "oauth_token" ||
    /(?:^|[\\/])hosts\.yml$/.test(tokenSource)
  )
    return "person";
  return "unknown";
}

/** The same from the text form of `gh auth status --hostname github.com`,
 * for a gh older than the JSON status (gh 2.81.0). */
export function ghIdentity(output: string): GhIdentity {
  const lines = output.split(/\r?\n/);
  const first = lines.findIndex((line) => activeEntry.test(line));
  if (first === -1) return "unknown";
  const [, bot, source = ""] = activeEntry.exec(lines[first] as string) ?? [];
  if (bot !== undefined) return "app";
  // The masked token of the same entry still shows its kind.
  for (const line of lines.slice(first + 1)) {
    if (/Logged in to |Failed to log in /.test(line)) break;
    if (/Token:\s*ghs_/.test(line)) return "app";
  }
  return ghIdentityOf("", source);
}

/** The curated gh actions the rule speaks about. */
export type GithubAction = "login" | "ssh-key" | "logout";

/** THE rule. `brokered`: the Environment's preset has the brokered
 * Organization identity (`hosted-organization-team`, see
 * `workspacePreset(...).providerIdentity`). Sign-in and SSH key linking of
 * gh are refused there; sign-out only when gh's active account is not a
 * person's (a bot, a broker token, not signed in or not known), so that the
 * Organization's identity is never signed out. Every other tool, and every
 * other Environment, is unaffected. */
export function githubActionRefused(
  input: Readonly<{
    brokered: boolean;
    tool: string;
    action: GithubAction;
    /** gh's sign-in as its probe reports it; needed for `logout` only. */
    signIn?:
      | Readonly<{ state: string; identity?: GhIdentity | undefined }>
      | undefined;
  }>,
): boolean {
  if (!input.brokered || input.tool !== "gh") return false;
  if (input.action !== "logout") return true;
  return !(
    input.signIn?.state === "signed-in" && input.signIn.identity === "person"
  );
}
