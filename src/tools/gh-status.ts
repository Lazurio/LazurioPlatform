import { findTool } from "./catalog";
import { ghTokenScopes } from "./ssh-key";
import {
  type GithubLimit,
  readSignIn,
  signInLabel,
  type ToolProcessResult,
  type ToolSignIn,
} from "./status";
import { ghIdentity, ghIdentityOf } from "./team-github";

/** gh's sign-in, read the way every gh answers it (decision F19, addendum
 * 2026-09-28): first `gh auth status --json hosts`, which gh has since
 * 2.81.0 (cli/cli#11544) and which is the ONLY `gh auth` command the
 * Organization's brokered gh of a Team Environment answers; then, for a gh
 * that does not know `--json` there, the text form of the catalog probe
 * (`gh auth status --hostname github.com`). The JSON form is requested with
 * exactly one field, `hosts`, and never with `--show-token`: gh leaves the
 * token out of it then (`token` is `omitempty` and blanked). Only the state,
 * the login, the kind of identity and the token scopes leave this module;
 * the output itself never does. */
export type GhStatus = Readonly<{
  signIn: ToolSignIn;
  /** The token scopes of the active github.com account, when gh names them. */
  scopes: readonly string[] | undefined;
}>;

export const ghJsonStatusArgs = Object.freeze([
  "auth",
  "status",
  "--json",
  "hosts",
]);

type GhRunner = (
  command: readonly string[],
  timeoutMs: number,
) => Promise<ToolProcessResult>;

const login = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const own = (value: unknown, key: string): unknown =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** What `gh auth status --json hosts` printed, or undefined when it is not
 * that document (a gh without the flag, a refusal, anything else). With
 * `--json` gh always exits 0 and says in `state` whether an entry works. */
export function readGhJsonStatus(stdout: string): GhStatus | undefined {
  let document: unknown;
  try {
    document = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const hosts = own(document, "hosts");
  if (hosts === null || typeof hosts !== "object" || Array.isArray(hosts))
    return undefined;
  const entries = own(hosts, "github.com");
  if (!Array.isArray(entries) || entries.length === 0)
    return { signIn: { state: "signed-out" }, scopes: undefined };
  // The active account; gh lists it first.
  const active =
    entries.find((entry) => own(entry, "active") === true) ?? entries[0];
  const state = own(active, "state");
  if (state === "timeout")
    return { signIn: { state: "unknown" }, scopes: undefined };
  const label = signInLabel(own(active, "login"));
  const account = label !== undefined && login.test(label) ? label : undefined;
  const source = own(active, "tokenSource");
  // GitHub refused gh's check of the token because the account's rate limit
  // is used up (HTTP 403 or 429, "API rate limit exceeded"): gh calls that
  // an invalid token, but the sign-in is there (#1223).
  const error = own(active, "error");
  const failure =
    state === "error" && typeof error === "string"
      ? checkFailure(error)
      : undefined;
  // gh could not reach GitHub to check the token (a network error, a 5xx):
  // nothing is known about the sign-in, so nothing offers to sign in again
  // (Pablo's review of #1224).
  if (failure === "unreachable")
    return { signIn: { state: "unknown" }, scopes: undefined };
  if (failure === "limited")
    return {
      signIn: {
        state: "signed-in",
        ...(account === undefined ? {} : { account }),
        identity:
          account === undefined
            ? "unknown"
            : ghIdentityOf(account, typeof source === "string" ? source : ""),
        limit: limitOfMessage(error as string),
      },
      scopes: undefined,
    };
  if (state !== "success")
    return { signIn: { state: "signed-out" }, scopes: undefined };
  const scopes = own(active, "scopes");
  return {
    signIn: {
      state: "signed-in",
      ...(account === undefined ? {} : { account }),
      identity:
        account === undefined
          ? "unknown"
          : ghIdentityOf(account, typeof source === "string" ? source : ""),
    },
    scopes:
      typeof scopes === "string"
        ? scopes
            .split(",")
            .map((scope) => scope.trim())
            .filter((scope) => scope.length > 0)
        : undefined,
  };
}

/** Whether a GitHub API error is its rate limit, primary or secondary:
 * HTTP 403 or 429 with GitHub's "rate limit" message, as gh prints it
 * ("HTTP 403: API rate limit exceeded for user ID …"). A 401 (a revoked or
 * invalid token) is not. */
export function rateLimited(error: string): boolean {
  return /\b(?:403|429)\b/.test(error) && /rate limit/i.test(error);
}

/** Why GitHub did not accept gh's check of its token: `limited` (its rate
 * limit, `rateLimited`), `rejected` (GitHub answered with another 4xx, such
 * as 401 for a revoked or invalid token: signed out), or `unreachable`
 * (no HTTP answer at all, a timeout or a 5xx: GitHub out of reach, which
 * says nothing about the sign-in). */
export function checkFailure(
  error: string,
): "limited" | "rejected" | "unreachable" {
  if (rateLimited(error)) return "limited";
  return /\bHTTP 4\d\d\b/.test(error) ? "rejected" : "unreachable";
}

/** GitHub's used-up rate limit, kept by the process that reads gh's sign-in
 * (the Launchpad, in its `createSshProofs`): while it lasts, a reading
 * answers it without asking GitHub again (#1223). */
export type GithubLimitMemo = Readonly<{
  /** The kept reading, while its limit has not reset. */
  githubLimit(): GhStatus | undefined;
  /** Which forget the memory is at: a reading keeps its limit only when no
   * sign-in or sign-out started meanwhile (Pablo's review of #1224). */
  limitGeneration(): number;
  /** Keep `status` until `untilMs` (this process's clock), unless a forget
   * came after `generation`. */
  keepGithubLimit(status: GhStatus, untilMs: number, generation: number): void;
}>;

// A limit whose end GitHub does not say is asked again after a minute, and
// none is kept past an hour, GitHub's own window.
const unknownResetMs = 60_000;
const longestLimitMs = 60 * 60_000;

/** When the account's core rate limit resets, by `gh api rate_limit`, which
 * GitHub answers without counting it: an ISO time while `core` is used up,
 * undefined otherwise (a secondary limit, an unreadable answer). */
/** Which limit `gh api rate_limit` says, from its `core` resource: used up
 * (`hourly`, with its reset) or requests remaining (`secondary`, GitHub's
 * limit on too many at once, which it does not list); undefined when the
 * answer is not that document. */
export function parseRateLimit(stdout: string): GithubLimit | undefined {
  try {
    const core = own(own(JSON.parse(stdout), "resources"), "core");
    const remaining = own(core, "remaining");
    const reset = own(core, "reset");
    if (typeof remaining !== "number") return undefined;
    if (remaining > 0) return { kind: "secondary" };
    return typeof reset === "number" && reset > 0
      ? { kind: "hourly", reset: new Date(reset * 1000).toISOString() }
      : { kind: "hourly" };
  } catch {
    return undefined;
  }
}

async function readRateLimit(
  run: GhRunner,
  gh: string,
  timeoutMs: number,
): Promise<GithubLimit | undefined> {
  try {
    const answer = await run([gh, "api", "rate_limit"], timeoutMs);
    return answer === "timeout" ? undefined : parseRateLimit(answer.stdout);
  } catch {
    return undefined;
  }
}

/** The kind GitHub's own message names, for when `rate_limit` does not
 * answer. */
const limitOfMessage = (error: string): GithubLimit =>
  /secondary rate limit/i.test(error) ? { kind: "secondary" } : {};

/** gh's sign-in as described above. Each command is bounded by `timeoutMs`;
 * a timeout or a failure to run is `unknown`. A sign-in GitHub refuses for
 * its rate limit is signed in with `limit`, its reset when GitHub says it;
 * with `limits` it is kept until then and answered without running gh
 * (#1223). */
export async function ghStatus(
  run: GhRunner,
  gh: string,
  timeoutMs: number,
  limits?: GithubLimitMemo,
  now: () => number = Date.now,
): Promise<GhStatus> {
  const kept = limits?.githubLimit();
  if (kept !== undefined) return kept;
  const started = limits?.limitGeneration() ?? 0;
  const status = await readGhStatus(run, gh, timeoutMs);
  if (status.signIn.limit === undefined) return status;
  const read = await readRateLimit(run, gh, timeoutMs);
  const limit = read ?? status.signIn.limit;
  const reset = limit.reset;
  const limited: GhStatus = {
    ...status,
    signIn: { ...status.signIn, limit },
  };
  const until =
    reset === undefined
      ? now() + unknownResetMs
      : Math.min(Date.parse(reset), now() + longestLimitMs);
  if (until > now()) limits?.keepGithubLimit(limited, until, started);
  return limited;
}

async function readGhStatus(
  run: GhRunner,
  gh: string,
  timeoutMs: number,
): Promise<GhStatus> {
  const unknown: GhStatus = { signIn: { state: "unknown" }, scopes: undefined };
  const probe = findTool("gh")?.signInProbe;
  if (probe === undefined) return unknown;
  try {
    const json = await run([gh, ...ghJsonStatusArgs], timeoutMs);
    if (json === "timeout") return unknown;
    const read = readGhJsonStatus(json.stdout);
    if (read !== undefined) return read;
    const text = await run([gh, ...probe.argv], timeoutMs);
    if (text === "timeout") return unknown;
    // An older gh's text form: "Failed to log in to github.com account
    // octocat (…)" and, last, GitHub's rate-limit error.
    const printed = `${text.stdout}\n${text.stderr}`;
    // A check of the token that failed: unreachable says nothing about the
    // sign-in, a 4xx other than the limit is signed out (`readSignIn`).
    const failed = /Failed to log in to|Timeout trying to log in/.test(printed)
      ? checkFailure(printed)
      : undefined;
    if (failed === "unreachable") return unknown;
    if (failed === "limited") {
      const named = /account (\S+) \(/.exec(printed)?.[1];
      const account =
        named !== undefined && login.test(named) ? named : undefined;
      return {
        signIn: {
          state: "signed-in",
          ...(account === undefined ? {} : { account }),
          identity: account === undefined ? "unknown" : ghIdentity(printed),
          limit: limitOfMessage(printed),
        },
        scopes: undefined,
      };
    }
    const signIn = readSignIn(probe, text);
    if (signIn.state !== "signed-in") return { signIn, scopes: undefined };
    const output = `${text.stdout}\n${text.stderr}`;
    return {
      signIn: { ...signIn, identity: ghIdentity(output) },
      scopes: ghTokenScopes(output),
    };
  } catch {
    return unknown;
  }
}
