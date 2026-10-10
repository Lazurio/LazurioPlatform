import {
  type AppInstallation,
  type GithubHttp,
  GithubOAuthError,
  GithubRequestError,
  GithubTokenNotExpiring,
  pollDeviceToken,
  readAccount,
  readInstallations,
  requestDeviceCode,
  revokeTokens,
  type TokenPair,
} from "./oauth";
import {
  type GithubSubject,
  type PilotOrganization,
  type PilotPaths,
  sameLogin,
} from "./pilot";
import {
  lockOrganization,
  readStoredSignIn,
  removeStoredSignIn,
  signInSchema,
  writeStoredSignIn,
} from "./store";

// The sign-in of one person to one Organization's sign-in app (decision
// F46): GitHub's device flow, exactly as the person knows it from gh today —
// a code they enter at https://github.com/login/device in their own browser —
// then two checks before anything is kept: the token acts for the person the
// Organization assigned this Environment to (`GET /user`), and it reaches
// exactly that Organization's installation of the app (`GET
// /user/installations`). A sign-in that fails a check keeps nothing; its
// tokens are dropped, not revoked: whether revoking one token ends the
// account's other sign-ins of the app is what the pilot measures. The code
// is shown only to the caller of the running command, never logged.

export type SignInFailure =
  /** The app's "Enable Device Flow" is off: its Owner ticks it. */
  | "device-flow-disabled"
  /** GitHub does not know the client id as a GitHub App's. */
  | "client-id-rejected"
  /** The person cancelled on GitHub's page. */
  | "access-denied"
  | "unreachable"
  | "unexpected-response"
  /** The app handed out a token that never expires (decision F46 asks for
   * expiring ones). */
  | "token-not-expiring"
  /** Another GitHub account approved the code. */
  | "wrong-account"
  /** The Organization has not installed its sign-in app (or not for this
   * person). */
  | "app-not-installed"
  /** The Organization suspended its sign-in app. */
  | "app-suspended"
  /** The token reaches another or a further installation: the app is not
   * this Organization's private sign-in app. */
  | "installation-unexpected"
  /** Another sign-in or sign-out of this Organization held its lock. */
  | "busy";

export type SignInState =
  | Readonly<{
      kind: "pending";
      organization: string;
      challenge: Readonly<{ url: string; code: string }>;
      expiresAt: string;
    }>
  | Readonly<{
      kind: "signed-in";
      organization: string;
      account: string;
      installationId: number;
      /** Signed in before this command; nothing changed. */
      already?: true;
    }>
  | Readonly<{
      kind: "failed";
      organization: string;
      reason: SignInFailure;
      /** `wrong-account`: who approved, and who was expected. */
      account?: string;
      expected?: string;
    }>
  | Readonly<{ kind: "expired"; organization: string }>
  | Readonly<{ kind: "cancelled"; organization: string }>;

export type SignInInput = Readonly<{
  paths: PilotPaths;
  organization: PilotOrganization;
  subject: GithubSubject;
  http: GithubHttp;
  now: () => number;
  /** Waits between polls; resolves early when `signal` aborts. */
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  emit: (state: SignInState) => void;
  signal?: AbortSignal | undefined;
}>;

export const abortableSleep = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const requestFailure = (error: unknown): SignInFailure => {
  if (error instanceof GithubRequestError)
    return error.reason === "unreachable"
      ? "unreachable"
      : "unexpected-response";
  if (error instanceof GithubTokenNotExpiring) return "token-not-expiring";
  throw error;
};

/** Which installation the token reaches, checked against the Organization:
 * exactly one, of that Organization, of this app, not suspended. */
export function installationProblem(
  installations: readonly AppInstallation[],
  organization: PilotOrganization,
): Extract<
  SignInFailure,
  "app-not-installed" | "app-suspended" | "installation-unexpected"
> | null {
  if (installations.length === 0) return "app-not-installed";
  const [only] = installations;
  if (
    installations.length !== 1 ||
    only === undefined ||
    !sameLogin(only.account.login, organization.login) ||
    only.targetType !== "Organization" ||
    (only.clientId !== null && only.clientId !== organization.clientId)
  )
    return "installation-unexpected";
  return only.suspended ? "app-suspended" : null;
}

export async function signIn(input: SignInInput): Promise<SignInState> {
  const { paths, organization, http, now } = input;
  const login = organization.login;
  const failed = (
    reason: SignInFailure,
    extra: Readonly<{ account?: string; expected?: string }> = {},
  ): SignInState =>
    Object.freeze({ kind: "failed", organization: login, reason, ...extra });

  const existing = await readStoredSignIn(paths, login);
  if (
    existing !== null &&
    existing !== "unreadable" &&
    existing.clientId === organization.clientId
  )
    return Object.freeze({
      kind: "signed-in",
      organization: existing.organization.login,
      account: existing.account.login,
      installationId: existing.installationId,
      already: true,
    });

  let device: Awaited<ReturnType<typeof requestDeviceCode>>;
  try {
    device = await requestDeviceCode(http, organization.clientId, now());
  } catch (error) {
    if (error instanceof GithubOAuthError)
      return failed(
        error.code === "device_flow_disabled"
          ? "device-flow-disabled"
          : "client-id-rejected",
      );
    if (error instanceof GithubRequestError && error.status === 404)
      return failed("client-id-rejected");
    return failed(requestFailure(error));
  }
  input.emit(
    Object.freeze({
      kind: "pending",
      organization: login,
      challenge: Object.freeze({
        url: device.verificationUri,
        code: device.userCode,
      }),
      expiresAt: new Date(device.expiresAt).toISOString(),
    }),
  );

  let interval = device.intervalSeconds;
  let tokens: TokenPair | undefined;
  while (tokens === undefined) {
    await input.sleep(interval * 1000, input.signal);
    if (input.signal?.aborted)
      return Object.freeze({ kind: "cancelled", organization: login });
    if (now() >= device.expiresAt)
      return Object.freeze({ kind: "expired", organization: login });
    let poll: Awaited<ReturnType<typeof pollDeviceToken>>;
    try {
      poll = await pollDeviceToken(
        http,
        organization.clientId,
        device.deviceCode,
        now,
      );
    } catch (error) {
      if (error instanceof GithubOAuthError)
        switch (error.code) {
          case "expired_token":
          case "token_expired":
            return Object.freeze({ kind: "expired", organization: login });
          case "access_denied":
            return failed("access-denied");
          case "device_flow_disabled":
            return failed("device-flow-disabled");
          default:
            return failed("client-id-rejected");
        }
      // A short network failure while the person types the code: poll on.
      if (error instanceof GithubRequestError && error.reason === "unreachable")
        continue;
      return failed(requestFailure(error));
    }
    if (poll.kind === "pending") continue;
    if (poll.kind === "slow-down") {
      interval = poll.intervalSeconds ?? interval + 5;
      continue;
    }
    tokens = poll.tokens;
  }

  let account: Awaited<ReturnType<typeof readAccount>>;
  let installations: readonly AppInstallation[];
  try {
    account = await readAccount(http, tokens.accessToken);
    if (account.id !== input.subject.id)
      return failed("wrong-account", {
        account: account.login,
        expected: input.subject.login,
      });
    installations = await readInstallations(http, tokens.accessToken);
  } catch (error) {
    return failed(requestFailure(error));
  }
  const problem = installationProblem(installations, organization);
  if (problem !== null) return failed(problem);
  const installation = installations[0] as AppInstallation;

  let lock: Awaited<ReturnType<typeof lockOrganization>>;
  try {
    lock = await lockOrganization(paths, login);
  } catch {
    return failed("busy");
  }
  try {
    // A sign-in that finished meanwhile wins; this one keeps nothing.
    const meanwhile = await readStoredSignIn(paths, login);
    if (
      meanwhile !== null &&
      meanwhile !== "unreadable" &&
      meanwhile.clientId === organization.clientId
    )
      return Object.freeze({
        kind: "signed-in",
        organization: meanwhile.organization.login,
        account: meanwhile.account.login,
        installationId: meanwhile.installationId,
        already: true,
      });
    const at = new Date(now()).toISOString();
    await writeStoredSignIn(paths, {
      schema: signInSchema,
      organization: Object.freeze({
        login: installation.account.login,
        id: installation.account.id,
      }),
      clientId: organization.clientId,
      installationId: installation.id,
      account,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: new Date(tokens.accessTokenExpiresAt).toISOString(),
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: new Date(
        tokens.refreshTokenExpiresAt,
      ).toISOString(),
      signedInAt: at,
      refreshedAt: null,
    });
  } finally {
    await lock.release();
  }
  return Object.freeze({
    kind: "signed-in",
    organization: installation.account.login,
    account: account.login,
    installationId: installation.id,
  });
}

export type SignOutResult =
  | Readonly<{
      kind: "signed-out";
      organization: string;
      /** GitHub accepted the revocation of both tokens. */
      revoked: boolean;
    }>
  | Readonly<{ kind: "not-signed-in"; organization: string }>
  | Readonly<{ kind: "failed"; organization: string; reason: "busy" }>;

/** Ends one Organization's sign-in here: both tokens are revoked at GitHub
 * (`POST /credentials/revoke`, which notifies the person) and the file is
 * removed, also when GitHub cannot be reached; then the result says so. */
export async function signOut(
  input: Readonly<{
    paths: PilotPaths;
    organization: PilotOrganization;
    http: GithubHttp;
  }>,
): Promise<SignOutResult> {
  const login = input.organization.login;
  let lock: Awaited<ReturnType<typeof lockOrganization>>;
  try {
    lock = await lockOrganization(input.paths, login);
  } catch {
    return Object.freeze({
      kind: "failed",
      organization: login,
      reason: "busy",
    });
  }
  try {
    const current = await readStoredSignIn(input.paths, login);
    if (current === null)
      return Object.freeze({ kind: "not-signed-in", organization: login });
    const revoked =
      current !== "unreadable" &&
      (await revokeTokens(input.http, [
        current.accessToken,
        current.refreshToken,
      ]));
    await removeStoredSignIn(input.paths, login);
    return Object.freeze({ kind: "signed-out", organization: login, revoked });
  } finally {
    await lock.release();
  }
}
