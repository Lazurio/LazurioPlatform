// GitHub's side of the Organization-scoped sign-in (decision F46): the OAuth
// device flow of a GitHub App, the refresh of its expiring user access tokens,
// the two reads that check a sign-in (`GET /user`, `GET /user/installations`)
// and the revocation of its tokens. Every request needs only the app's public
// client id; no client secret and no private key exist on the Environment
// (a device-flow token refreshes without the secret). Five fixed requests,
// written here instead of a client library: each answer is checked field by
// field, bounded in size and time, and nothing GitHub returns is ever echoed
// into an error. A token leaves this module only as the value of a checked
// field.

export type GithubOrigins = Readonly<{
  /** `https://github.com`: the device flow and the token endpoint. */
  web: string;
  /** `https://api.github.com`: the REST API. */
  api: string;
}>;

export const githubOrigins: GithubOrigins = Object.freeze({
  web: "https://github.com",
  api: "https://api.github.com",
});

/** The only page a person is sent to. */
export const deviceVerificationUri = "https://github.com/login/device";

export type GithubHttp = Readonly<{
  origins: GithubOrigins;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs: number;
}>;

export const githubHttp = (overrides: Partial<GithubHttp> = {}): GithubHttp => {
  const http: GithubHttp = Object.freeze({
    origins: overrides.origins ?? githubOrigins,
    fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
    timeoutMs: overrides.timeoutMs ?? 15_000,
  });
  for (const origin of [http.origins.web, http.origins.api]) {
    const url = new URL(origin);
    // Only GitHub over HTTPS in production; a test's loopback fake over HTTP.
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.origin !== origin
    )
      throw new Error("GitHub origin must be an HTTPS origin");
  }
  return http;
};

/** Why a request to GitHub did not give an answer to use:
 * - `unreachable`: no answer in time, a network failure, a 5xx or a 429,
 *   which a later attempt may get past;
 * - `rejected`: GitHub refused the token (401, 403, 404);
 * - `unexpected-response`: any other status, or an answer that is not the
 *   documented one. */
export type GithubFailure = "unreachable" | "rejected" | "unexpected-response";

export class GithubRequestError extends Error {
  constructor(
    readonly reason: GithubFailure,
    readonly status?: number,
  ) {
    super(`github-${reason}${status === undefined ? "" : `-${status}`}`);
    this.name = "GithubRequestError";
  }
}

/** An OAuth error GitHub answered (`{"error": "<code>"}`), the code only,
 * reduced to its documented alphabet, and the new polling interval a
 * `slow_down` names. */
export class GithubOAuthError extends Error {
  readonly code: string;
  readonly intervalSeconds: number | undefined;
  constructor(code: unknown, interval?: unknown) {
    const plain =
      typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
        ? code
        : "unknown";
    super(`github-oauth-${plain}`);
    this.name = "GithubOAuthError";
    this.code = plain;
    this.intervalSeconds =
      typeof interval === "number" &&
      Number.isSafeInteger(interval) &&
      interval > 0 &&
      interval <= 120
        ? interval
        : undefined;
  }
}

/** A token answer without a refresh token: the app hands out tokens that
 * never expire, which this pilot refuses (decision F46). */
export class GithubTokenNotExpiring extends Error {
  constructor() {
    super("github-token-not-expiring");
    this.name = "GithubTokenNotExpiring";
  }
}

const maxAnswerCharacters = 1_000_000;

async function request(
  http: GithubHttp,
  url: string,
  init: RequestInit,
): Promise<Readonly<{ status: number; body: unknown }>> {
  let response: Response;
  try {
    response = await http.fetch(url, {
      ...init,
      // An answer elsewhere is never followed: a token must not travel on.
      redirect: "error",
      signal: AbortSignal.timeout(http.timeoutMs),
    });
  } catch {
    throw new GithubRequestError("unreachable");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new GithubRequestError("unreachable", response.status);
  }
  if (response.status >= 500 || response.status === 429)
    throw new GithubRequestError("unreachable", response.status);
  if (text.length > maxAnswerCharacters)
    throw new GithubRequestError("unexpected-response", response.status);
  let body: unknown = null;
  if (text.trim().length > 0)
    try {
      body = JSON.parse(text);
    } catch {
      throw new GithubRequestError("unexpected-response", response.status);
    }
  return { status: response.status, body };
}

const own = (value: unknown, key: string): unknown =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const positiveInteger = (value: unknown, max: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= max;

// The token endpoint answers 200 with `{"error": …}` for every OAuth error.
async function oauthPost(
  http: GithubHttp,
  path: string,
  fields: Readonly<Record<string, string>>,
): Promise<unknown> {
  const { status, body } = await request(http, `${http.origins.web}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "lazurio-platform",
    },
    body: new URLSearchParams(fields).toString(),
  });
  const error = own(body, "error");
  if (error !== undefined)
    throw new GithubOAuthError(error, own(body, "interval"));
  if (status !== 200)
    throw new GithubRequestError("unexpected-response", status);
  return body;
}

export type DeviceAuthorization = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: typeof deviceVerificationUri;
  /** Epoch milliseconds after which the code no longer works. */
  expiresAt: number;
  intervalSeconds: number;
}>;

/** Step 1 of the device flow. `offline_access` makes GitHub hand out an
 * expiring token and a refresh token even when the app's owner switched
 * expiring tokens off. */
export async function requestDeviceCode(
  http: GithubHttp,
  clientId: string,
  now: number,
): Promise<DeviceAuthorization> {
  const body = await oauthPost(http, "/login/device/code", {
    client_id: clientId,
    scope: "offline_access",
  });
  const deviceCode = own(body, "device_code");
  const userCode = own(body, "user_code");
  const verificationUri = own(body, "verification_uri");
  const expiresIn = own(body, "expires_in");
  const interval = own(body, "interval");
  if (
    typeof deviceCode !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(deviceCode) ||
    typeof userCode !== "string" ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode) ||
    verificationUri !== deviceVerificationUri ||
    !positiveInteger(expiresIn, 3600) ||
    !positiveInteger(interval, 120)
  )
    throw new GithubRequestError("unexpected-response");
  return Object.freeze({
    deviceCode,
    userCode,
    verificationUri: deviceVerificationUri,
    expiresAt: now + expiresIn * 1000,
    intervalSeconds: interval,
  });
}

export type TokenPair = Readonly<{
  accessToken: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}>;

export const isAccessToken = (value: unknown): value is string =>
  typeof value === "string" && /^ghu_[A-Za-z0-9_-]{8,250}$/.test(value);
export const isRefreshToken = (value: unknown): value is string =>
  typeof value === "string" && /^ghr_[A-Za-z0-9_-]{8,250}$/.test(value);

function tokenPair(body: unknown, now: number): TokenPair {
  const accessToken = own(body, "access_token");
  const tokenType = own(body, "token_type");
  if (
    !isAccessToken(accessToken) ||
    typeof tokenType !== "string" ||
    tokenType.toLowerCase() !== "bearer"
  )
    throw new GithubRequestError("unexpected-response");
  const refreshToken = own(body, "refresh_token");
  const expiresIn = own(body, "expires_in");
  const refreshExpiresIn = own(body, "refresh_token_expires_in");
  if (refreshToken === undefined && expiresIn === undefined)
    throw new GithubTokenNotExpiring();
  if (
    !isRefreshToken(refreshToken) ||
    !positiveInteger(expiresIn, 7 * 24 * 3600) ||
    !positiveInteger(refreshExpiresIn, 400 * 24 * 3600)
  )
    throw new GithubRequestError("unexpected-response");
  return Object.freeze({
    accessToken,
    accessTokenExpiresAt: now + expiresIn * 1000,
    refreshToken,
    refreshTokenExpiresAt: now + refreshExpiresIn * 1000,
  });
}

export type DevicePoll =
  | Readonly<{ kind: "pending" }>
  /** Poll less often: GitHub's new interval when it names one, else the
   * documented five seconds more. */
  | Readonly<{ kind: "slow-down"; intervalSeconds: number | undefined }>
  | Readonly<{ kind: "tokens"; tokens: TokenPair }>;

/** One poll of the device flow. Pending and slow-down are answers; every
 * other OAuth error (`expired_token`, `access_denied`,
 * `device_flow_disabled`, `incorrect_client_credentials`, …) ends the flow
 * as a `GithubOAuthError`. */
export async function pollDeviceToken(
  http: GithubHttp,
  clientId: string,
  deviceCode: string,
  now: () => number,
): Promise<DevicePoll> {
  let body: unknown;
  try {
    body = await oauthPost(http, "/login/oauth/access_token", {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  } catch (error) {
    if (!(error instanceof GithubOAuthError)) throw error;
    if (error.code === "authorization_pending")
      return Object.freeze({ kind: "pending" });
    if (error.code === "slow_down")
      return Object.freeze({
        kind: "slow-down",
        intervalSeconds: error.intervalSeconds,
      });
    throw error;
  }
  return Object.freeze({ kind: "tokens", tokens: tokenPair(body, now()) });
}

/** A new token pair for a refresh token. Once GitHub answers, the refresh
 * token given and the access token it belonged to no longer work: the
 * caller writes the new pair before anything else may use it. */
export async function refreshTokenPair(
  http: GithubHttp,
  clientId: string,
  refreshToken: string,
  now: () => number,
): Promise<TokenPair> {
  const body = await oauthPost(http, "/login/oauth/access_token", {
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return tokenPair(body, now());
}

async function apiGet(
  http: GithubHttp,
  path: string,
  accessToken: string,
): Promise<unknown> {
  const { status, body } = await request(http, `${http.origins.api}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "lazurio-platform",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (status === 401 || status === 403 || status === 404)
    throw new GithubRequestError("rejected", status);
  if (status !== 200)
    throw new GithubRequestError("unexpected-response", status);
  return body;
}

export type GithubAccount = Readonly<{ login: string; id: number }>;

const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const accountOf = (value: unknown): GithubAccount | undefined => {
  const login = own(value, "login");
  const id = own(value, "id");
  return typeof login === "string" &&
    loginPattern.test(login) &&
    positiveInteger(id, Number.MAX_SAFE_INTEGER)
    ? Object.freeze({ login, id })
    : undefined;
};

/** `GET /user`: the person the token acts for. */
export async function readAccount(
  http: GithubHttp,
  accessToken: string,
): Promise<GithubAccount> {
  const account = accountOf(await apiGet(http, "/user", accessToken));
  if (account === undefined)
    throw new GithubRequestError("unexpected-response");
  return account;
}

export type AppInstallation = Readonly<{
  id: number;
  account: GithubAccount;
  /** `Organization` or `User`, as GitHub names the installation target. */
  targetType: string;
  /** The app's client id, when GitHub names it. */
  clientId: string | null;
  suspended: boolean;
}>;

/** `GET /user/installations`: the installations of this app the token can
 * reach. For a private app of an Organization it is that one installation. */
export async function readInstallations(
  http: GithubHttp,
  accessToken: string,
): Promise<readonly AppInstallation[]> {
  const body = await apiGet(
    http,
    "/user/installations?per_page=100",
    accessToken,
  );
  const list = own(body, "installations");
  if (!Array.isArray(list) || list.length > 100)
    throw new GithubRequestError("unexpected-response");
  return Object.freeze(
    list.map((entry) => {
      const id = own(entry, "id");
      const account = accountOf(own(entry, "account"));
      const targetType = own(entry, "target_type");
      const clientId = own(entry, "client_id");
      const suspendedAt = own(entry, "suspended_at");
      if (
        !positiveInteger(id, Number.MAX_SAFE_INTEGER) ||
        account === undefined ||
        typeof targetType !== "string" ||
        !/^[A-Za-z]{1,32}$/.test(targetType)
      )
        throw new GithubRequestError("unexpected-response");
      return Object.freeze({
        id,
        account,
        targetType,
        clientId:
          typeof clientId === "string" && clientId.length <= 64
            ? clientId
            : null,
        suspended: suspendedAt !== undefined && suspendedAt !== null,
      });
    }),
  );
}

/** `POST /credentials/revoke` for the given tokens. The endpoint takes no
 * authentication (an authenticated request is refused) and notifies the
 * tokens' owner. True when GitHub accepted the request. */
export async function revokeTokens(
  http: GithubHttp,
  tokens: readonly string[],
): Promise<boolean> {
  if (tokens.length === 0) return true;
  try {
    const { status } = await request(
      http,
      `${http.origins.api}/credentials/revoke`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "lazurio-platform",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ credentials: tokens }),
      },
    );
    return status === 202;
  } catch {
    return false;
  }
}
