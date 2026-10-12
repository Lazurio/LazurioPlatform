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
  type TokenPair,
} from "./oauth";
import {
  type GithubSubject,
  type PilotApplication,
  type PilotPaths,
  readPilot,
  sameLogin,
} from "./pilot";
import {
  lockSignIn,
  readSettledSignIn,
  removeStoredSignIn,
  signInSchema,
  writeStoredSignIn,
} from "./store";

// Device flow for the existing shared App (F48). Before retaining a pair,
// verify the assigned account id and active owning installation. Other App
// installations are expected and are not a reason to reject authorization.
// Failed checks keep no new tokens; the pilot measures revocation scope.

export type SignInFailure =
  /** The app's "Enable Device Flow" is off: its Owner ticks it. */
  | "device-flow-disabled"
  /** GitHub does not know the client id as a GitHub App's. */
  | "client-id-rejected"
  /** The person cancelled on GitHub's page. */
  | "access-denied"
  | "unreachable"
  | "unexpected-response"
  /** The app handed out a token that never expires (decision F48 asks for
   * expiring ones). */
  | "token-not-expiring"
  /** Another GitHub account approved the code. */
  | "wrong-account"
  /** The Organization has not installed its sign-in app (or not for this
   * person). */
  | "app-not-installed"
  /** The Organization suspended its sign-in app. */
  | "app-suspended"
  /** Inconsistent App identity or malformed/duplicate owning installation. */
  | "installation-unexpected"
  /** Existing credentials cannot be used safely and must be handled explicitly. */
  | "state-unreadable"
  /** Pilot was disabled or replaced while this command was starting. */
  | "pilot-changed"
  /** Another sign-in or sign-out held the shared chain lock. */
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
  organization: PilotApplication;
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

/** The owning installation must be active; other installations of the same
 * App are expected. This check is not an Organization allowlist. */
export function installationProblem(
  installations: readonly AppInstallation[],
  organization: PilotApplication,
): Extract<
  SignInFailure,
  "app-not-installed" | "app-suspended" | "installation-unexpected"
> | null {
  if (
    installations.some(
      (entry) =>
        entry.clientId !== null && entry.clientId !== organization.clientId,
    )
  )
    return "installation-unexpected";
  const owning = installations.filter((entry) =>
    sameLogin(entry.account.login, organization.login),
  );
  if (owning.length === 0) return "app-not-installed";
  if (owning.length !== 1 || owning[0]?.targetType !== "Organization")
    return "installation-unexpected";
  return owning[0].suspended ? "app-suspended" : null;
}

export async function signIn(input: SignInInput): Promise<SignInState> {
  let lock: Awaited<ReturnType<typeof lockSignIn>>;
  try {
    lock = await lockSignIn(input.paths);
  } catch {
    return Object.freeze({
      kind: "failed",
      organization: input.organization.login,
      reason: "busy",
    });
  }
  try {
    return await signInLocked(input);
  } finally {
    await lock.release();
  }
}

// The entire interactive flow is one lifecycle operation. Sign-out/disable
// can wait or report busy, never complete before a late credential write.
async function signInLocked(input: SignInInput): Promise<SignInState> {
  const { paths, organization, http, now } = input;
  const login = organization.login;
  const failed = (
    reason: SignInFailure,
    extra: Readonly<{ account?: string; expected?: string }> = {},
  ): SignInState =>
    Object.freeze({ kind: "failed", organization: login, reason, ...extra });

  const pilot = await readPilot(paths);
  if (
    pilot.kind !== "on" ||
    !sameLogin(pilot.config.application.login, login) ||
    pilot.config.application.clientId !== organization.clientId
  )
    return failed("pilot-changed");
  if (input.signal?.aborted)
    return Object.freeze({ kind: "cancelled", organization: login });
  const existing = await readSettledSignIn(paths, organization);
  if (
    existing === "unreadable" ||
    (existing !== null && existing.clientId !== organization.clientId)
  )
    return failed("state-unreadable");
  if (existing !== null) {
    if (existing.account.id !== input.subject.id)
      return failed("wrong-account", {
        account: existing.account.login,
        expected: input.subject.login,
      });
    return Object.freeze({
      kind: "signed-in",
      organization: existing.organization.login,
      account: existing.account.login,
      installationId: existing.installationId,
      already: true,
    });
  }

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
  const installation = installations.find((entry) =>
    sameLogin(entry.account.login, organization.login),
  ) as AppInstallation;

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
    refreshTokenExpiresAt: new Date(tokens.refreshTokenExpiresAt).toISOString(),
    signedInAt: at,
    refreshedAt: null,
  });
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
      /** Only this Environment’s stored credentials were removed. */
      scope: "environment";
    }>
  | Readonly<{ kind: "not-signed-in"; organization: string }>
  | Readonly<{
      kind: "failed";
      organization: string;
      reason: "busy" | "state-unreadable";
    }>;

/** Removes this Environment’s custody only. Provider revocation may end the
 * person’s other App sign-ins, so routine local sign-out never requests it. */
export async function signOut(
  input: Readonly<{
    paths: PilotPaths;
    organization: PilotApplication;
  }>,
): Promise<SignOutResult> {
  const login = input.organization.login;
  let lock: Awaited<ReturnType<typeof lockSignIn>>;
  try {
    lock = await lockSignIn(input.paths);
  } catch {
    return Object.freeze({
      kind: "failed",
      organization: login,
      reason: "busy",
    });
  }
  try {
    // A pair a killed write left aside is the sign-in too: settled first, so
    // it is removed with the rest.
    const current = await readSettledSignIn(input.paths, input.organization);
    if (current === null)
      return Object.freeze({ kind: "not-signed-in", organization: login });
    if (
      current === "unreadable" ||
      current.clientId !== input.organization.clientId
    )
      return Object.freeze({
        kind: "failed",
        organization: login,
        reason: "state-unreadable",
      });
    await removeStoredSignIn(input.paths);
    return Object.freeze({
      kind: "signed-out",
      organization: login,
      scope: "environment",
    });
  } finally {
    await lock.release();
  }
}
