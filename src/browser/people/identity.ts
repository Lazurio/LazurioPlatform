// Which Environment a view of the Environment browser belongs to, read from
// the view's own address (root decision 0191, addendum of 2026-10-09). The
// view names it in its bar and title, so a person knows whose browser it is in
// any app's panel or in a bare tab; T3 Code labels another Environment's view
// by the same rule. An Organization's Environment is
// `browser.<environment>.<organization>.lazurio.io`, a personal one
// `browser.<login>.lazurio.io`; any other address names no Environment.

export type ViewIdentity = Readonly<
  | { kind: "organization"; organization: string; environment: string }
  | { kind: "personal"; login: string }
>;

/** One DNS label as the gateway's names use them. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function viewIdentity(hostname: string): ViewIdentity | null {
  const labels = hostname.toLowerCase().split(".");
  if (labels[0] !== "browser" || labels.length < 4) return null;
  if (labels.at(-2) !== "lazurio" || labels.at(-1) !== "io") return null;
  const middle = labels.slice(1, -2);
  if (!middle.every((label) => LABEL.test(label))) return null;
  const [first, second] = middle;
  if (middle.length === 1 && first !== undefined)
    return { kind: "personal", login: first };
  if (middle.length === 2 && first !== undefined && second !== undefined)
    return { kind: "organization", environment: first, organization: second };
  return null;
}

/** What a person reads: `Acme · jana`, or `Osobní · jana` / `Personal · jana`. */
export function identityLabel(identity: ViewIdentity, czech: boolean): string {
  if (identity.kind === "personal")
    return `${czech ? "Osobní" : "Personal"} · ${identity.login}`;
  const { organization, environment } = identity;
  return `${organization.charAt(0).toUpperCase()}${organization.slice(1)} · ${environment}`;
}

/** The GitHub avatar of the Organization, or of the person on a personal
 * Environment. */
export function identityIcon(identity: ViewIdentity): string {
  const owner =
    identity.kind === "personal" ? identity.login : identity.organization;
  return `https://github.com/${owner}.png?size=40`;
}
