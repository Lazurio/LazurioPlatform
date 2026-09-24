import { afterEach, expect, test } from "bun:test";
import {
  createHostedTrust,
  parseHostedEntry,
  selectCookie,
} from "../src/launchpad/hosted-trust";

const entry = parseHostedEntry({
  externalOrigin: "https://launchpad.example-workspace.example.lazurio.io",
  authCheckUrl: "https://example-workspace.example.lazurio.io/oauth2/auth",
  authCookieName: "__Secure-lazurio-workspace",
  listenPort: 20000,
});
const host = "launchpad.example-workspace.example.lazurio.io";

test("a hosted entry is exactly four typed values; anything else is refused", () => {
  expect(entry.authCheckUrl).toBe(
    "https://example-workspace.example.lazurio.io/oauth2/auth",
  );
  for (const bad of [
    null,
    [],
    { ...entry, extra: 1 },
    { ...entry, externalOrigin: "http://launchpad.example.lazurio.io" },
    { ...entry, externalOrigin: "https://launchpad.example.lazurio.io/x" },
    { ...entry, externalOrigin: "https://launchpad.example.lazurio.io/" },
    { ...entry, authCheckUrl: "http://example.lazurio.io/oauth2/auth" },
    { ...entry, authCheckUrl: "not a url" },
    { ...entry, authCookieName: "bad cookie" },
    { ...entry, authCookieName: "" },
    { ...entry, listenPort: 0 },
    { ...entry, listenPort: 70000 },
    { ...entry, listenPort: "20000" },
  ])
    expect(() => parseHostedEntry(bad)).toThrow();
});

test("exactly one cookie of the name is selected from a bounded header", () => {
  expect(
    selectCookie(
      "a=1; __Secure-lazurio-workspace=abc; b=2",
      entry.authCookieName,
    ),
  ).toEqual({ value: "abc" });
  expect(selectCookie(null, entry.authCookieName)).toEqual({
    reason: "cookie-missing",
  });
  expect(selectCookie("a=1", entry.authCookieName)).toEqual({
    reason: "cookie-missing",
  });
  expect(
    selectCookie("__Secure-lazurio-workspace=", entry.authCookieName),
  ).toEqual({ reason: "cookie-invalid" });
  expect(
    selectCookie(
      "__Secure-lazurio-workspace=a; __Secure-lazurio-workspace=b",
      entry.authCookieName,
    ),
  ).toEqual({ reason: "cookie-invalid" });
  expect(
    selectCookie(`x=${"y".repeat(16 * 1024)}`, entry.authCookieName),
  ).toEqual({ reason: "cookie-invalid" });
});

// A fake gateway auth endpoint: answers per cookie value.
let servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});
function fakeAuth(answer: (cookie: string | null) => Response) {
  const calls: (string | null)[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls.push(request.headers.get("cookie"));
      return answer(request.headers.get("cookie"));
    },
  });
  servers.push(server);
  // The trust is configured with an HTTPS URL; the test fetcher rewrites the
  // configured URL to the fake so the contract (exact configured URL) holds.
  const fetcher: typeof fetch = (input, init) => {
    expect(String(input)).toBe(entry.authCheckUrl);
    return fetch(`http://127.0.0.1:${server.port}/oauth2/auth`, init);
  };
  return { calls, fetcher };
}
const request = (method: string, headers: Record<string, string>) =>
  new Request(`http://127.0.0.1:20000/api/profile`, {
    method,
    headers: { host, ...headers },
  });
const good = { cookie: "__Secure-lazurio-workspace=valid" };

test("admission forwards exactly the named cookie to the configured auth endpoint and trusts only 2xx", async () => {
  let clock = 1_000_000;
  const { calls, fetcher } = fakeAuth((cookie) =>
    cookie === "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 }),
  );
  const trust = createHostedTrust(entry, { fetcher, now: () => clock });
  // Host must be the configured origin's host; the request URL is not evidence.
  expect(
    await trust.admit(request("GET", { ...good, host: "other.lazurio.io" })),
  ).toEqual({ ok: false, reason: "host-mismatch" });
  // GET needs the cookie only; other cookies are not forwarded.
  expect(
    await trust.admit(
      request("GET", { cookie: "other=1; __Secure-lazurio-workspace=valid" }),
    ),
  ).toEqual({ ok: true });
  expect(calls).toEqual(["__Secure-lazurio-workspace=valid"]);
  // Forged identity headers change nothing; a wrong cookie is denied.
  expect(
    await trust.admit(
      request("GET", {
        cookie: "__Secure-lazurio-workspace=forged",
        "x-forwarded-user": "admin",
        authorization: "Bearer x",
      }),
    ),
  ).toEqual({ ok: false, reason: "auth-denied" });
  // No cookie: denied without asking the endpoint.
  expect(
    await trust.admit(request("GET", { "x-auth-request-user": "admin" })),
  ).toEqual({ ok: false, reason: "cookie-missing" });
  // A state-changing request must be same-origin from the configured origin.
  expect(await trust.admit(request("POST", good))).toEqual({
    ok: false,
    reason: "origin-mismatch",
  });
  expect(
    await trust.admit(
      request("POST", {
        ...good,
        origin: "https://evil.example",
        "sec-fetch-site": "same-origin",
      }),
    ),
  ).toEqual({ ok: false, reason: "origin-mismatch" });
  expect(
    await trust.admit(
      request("POST", {
        ...good,
        origin: entry.externalOrigin,
        "sec-fetch-site": "cross-site",
      }),
    ),
  ).toEqual({ ok: false, reason: "origin-mismatch" });
  expect(
    await trust.admit(
      request("POST", {
        ...good,
        origin: entry.externalOrigin,
        "sec-fetch-site": "same-origin",
      }),
    ),
  ).toEqual({ ok: true });
  // A positive answer is cached for two minutes, keyed by the cookie value.
  expect(calls.length).toBe(2);
  clock += 119_000;
  expect(await trust.admit(request("GET", good))).toEqual({ ok: true });
  expect(calls.length).toBe(2);
  clock += 2_000;
  expect(await trust.admit(request("GET", good))).toEqual({ ok: true });
  expect(calls.length).toBe(3);
});

test("a redirecting, failing or slow auth endpoint denies and never caches a negative", async () => {
  const redirect = fakeAuth(() =>
    Response.redirect("https://elsewhere.example/", 302),
  );
  expect(
    await createHostedTrust(entry, { fetcher: redirect.fetcher }).admit(
      request("GET", good),
    ),
  ).toEqual({ ok: false, reason: "auth-redirect" });
  const slow = fakeAuth(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response("late")), 500),
      ) as never,
  );
  const trust = createHostedTrust(entry, {
    fetcher: slow.fetcher,
    timeoutMs: 100,
  });
  expect(await trust.admit(request("GET", good))).toEqual({
    ok: false,
    reason: "auth-unavailable",
  });
  const down = createHostedTrust(entry, {
    fetcher: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
  });
  expect(await down.admit(request("GET", good))).toEqual({
    ok: false,
    reason: "auth-unavailable",
  });
  expect(await down.admit(request("GET", good))).toEqual({
    ok: false,
    reason: "auth-unavailable",
  });
});
