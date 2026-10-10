import type { GithubOrigins } from "../../src/github/oauth";

// A loopback stand-in for GitHub's side of the Organization-scoped sign-in
// (decision F46): the device flow, the token endpoint with GitHub's
// documented rotation (a refresh ends the refresh token used and the access
// token it belonged to), `GET /user`, `GET /user/installations` and the
// unauthenticated `POST /credentials/revoke`. Tokens are synthetic
// (`ghu_fake-…`), never shaped like real ones.

export type FakeInstallation = Readonly<{
  id: number;
  account: Readonly<{ login: string; id: number }>;
  target_type?: string;
  client_id?: string;
  suspended_at?: string | null;
}>;

export type FakeGithubOptions = {
  clientId?: string;
  deviceFlow?: "enabled" | "disabled";
  /** The answers to successive device-token polls before the tokens:
   * `authorization_pending`, `slow_down`, `expired_token`, `access_denied`,
   * `unreachable` (a 503), or `tokens`. Default: one pending, then tokens. */
  polls?: string[];
  account?: Readonly<{ login: string; id: number }>;
  installations?: FakeInstallation[];
  /** Hands out tokens without expiry and refresh token. */
  expiring?: boolean;
  /** Delay of a refresh answer, to widen a race. */
  refreshDelayMs?: number;
  /** The next refresh answers: `tokens` (default), `bad_refresh_token` or
   * `unreachable`. */
  refreshAnswer?: "tokens" | "bad_refresh_token" | "unreachable";
  revokeStatus?: number;
};

export type FakeGithub = Readonly<{
  origins: GithubOrigins;
  options: FakeGithubOptions;
  requests: { method: string; path: string; form?: Record<string, string> }[];
  /** Successful refreshes. */
  refreshes: () => number;
  revoked: string[];
  /** Whether GitHub would still accept the token. */
  accessValid: (token: string) => boolean;
  refreshValid: (token: string) => boolean;
  /** Issues a token pair directly, as a finished sign-in would hold it. */
  issue: () => Readonly<{ access: string; refresh: string }>;
  close: () => void;
}>;

export const fakeClientId = "Iv23liFixture0000001";

export function startFakeGithub(options: FakeGithubOptions = {}): FakeGithub {
  const clientId = options.clientId ?? fakeClientId;
  const polls = [...(options.polls ?? ["authorization_pending", "tokens"])];
  const account = options.account ?? { login: "example", id: 12345 };
  const requests: FakeGithub["requests"] = [];
  const revoked: string[] = [];
  const validAccess = new Set<string>();
  const validRefresh = new Map<string, string>();
  let counter = 0;
  let refreshes = 0;
  const issue = () => {
    counter += 1;
    const access = `ghu_fake-access-${counter}`;
    const refresh = `ghr_fake-refresh-${counter}`;
    validAccess.add(access);
    validRefresh.set(refresh, access);
    return { access, refresh };
  };
  const tokens = () => {
    const pair = issue();
    return options.expiring === false
      ? { access_token: pair.access, token_type: "bearer", scope: "" }
      : {
          access_token: pair.access,
          expires_in: 28800,
          refresh_token: pair.refresh,
          refresh_token_expires_in: 15897600,
          token_type: "bearer",
          scope: "",
        };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const bearer = (request: Request) =>
    /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      if (request.method === "POST" && url.pathname.startsWith("/login/")) {
        const form = Object.fromEntries(
          new URLSearchParams(await request.text()),
        );
        requests.push({ method: "POST", path, form });
        if (form.client_id !== clientId)
          return json({ error: "incorrect_client_credentials" });
        if (url.pathname === "/login/device/code") {
          if (options.deviceFlow === "disabled")
            return json({ error: "device_flow_disabled" });
          return json({
            device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5",
            user_code: "WDJB-MJHT",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          });
        }
        if (
          form.grant_type === "urn:ietf:params:oauth:grant-type:device_code"
        ) {
          const next = polls.shift() ?? "tokens";
          if (next === "tokens") return json(tokens());
          if (next === "unreachable") return new Response("", { status: 503 });
          if (next === "slow_down")
            return json({ error: "slow_down", interval: 10 });
          return json({ error: next });
        }
        if (form.grant_type === "refresh_token") {
          if (options.refreshDelayMs !== undefined)
            await Bun.sleep(options.refreshDelayMs);
          const answer = options.refreshAnswer ?? "tokens";
          if (answer === "unreachable")
            return new Response("", { status: 502 });
          const used = form.refresh_token ?? "";
          const belonged = validRefresh.get(used);
          if (answer === "bad_refresh_token" || belonged === undefined)
            return json({ error: "bad_refresh_token" });
          // GitHub's rotation: both the refresh token used and its access
          // token stop working.
          validRefresh.delete(used);
          validAccess.delete(belonged);
          refreshes += 1;
          return json(tokens());
        }
        return json({ error: "unsupported_grant_type" });
      }
      requests.push({ method: request.method, path });
      if (request.method === "POST" && url.pathname === "/credentials/revoke") {
        if (request.headers.get("authorization") !== null)
          return json({ message: "Must not be authenticated" }, 403);
        const body = (await request.json()) as { credentials?: string[] };
        for (const credential of body.credentials ?? []) {
          revoked.push(credential);
          validAccess.delete(credential);
          validRefresh.delete(credential);
        }
        return new Response("", { status: options.revokeStatus ?? 202 });
      }
      const token = bearer(request);
      if (token === undefined || !validAccess.has(token))
        return json({ message: "Bad credentials" }, 401);
      if (url.pathname === "/user")
        return json({ ...account, type: "User", node_id: "U_fixture" });
      if (url.pathname === "/user/installations") {
        const installations = (
          options.installations ?? [
            { id: 777, account: { login: "Example", id: 4242 } },
          ]
        ).map((entry) => ({
          id: entry.id,
          account: { ...entry.account, type: "Organization" },
          app_id: 1,
          app_slug: "lazurio-example",
          client_id: entry.client_id ?? clientId,
          target_type: entry.target_type ?? "Organization",
          suspended_at: entry.suspended_at ?? null,
          repository_selection: "all",
        }));
        return json({ total_count: installations.length, installations });
      }
      return json({ message: "Not Found" }, 404);
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return Object.freeze({
    origins: Object.freeze({ web: origin, api: origin }),
    options,
    requests,
    refreshes: () => refreshes,
    revoked,
    accessValid: (token: string) => validAccess.has(token),
    refreshValid: (token: string) => validRefresh.has(token),
    issue,
    close: () => server.stop(true),
  });
}
