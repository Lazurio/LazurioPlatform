import { afterEach, expect, test } from "bun:test";
import {
  type AuthFetcher,
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
    // The rules of the handover schema: no port, query or uppercase in an
    // origin or the auth endpoint, a path on the endpoint, the gateway's
    // cookie alphabet and an unprivileged loopback port.
    { ...entry, externalOrigin: "https://launchpad.example.lazurio.io:8443" },
    { ...entry, externalOrigin: "https://Launchpad.example.lazurio.io" },
    { ...entry, externalOrigin: "https://localhost" },
    { ...entry, authCheckUrl: "https://example.lazurio.io" },
    { ...entry, authCheckUrl: "https://example.lazurio.io/oauth2/auth?x=1" },
    { ...entry, authCheckUrl: "https://example.lazurio.io:8443/oauth2/auth" },
    { ...entry, authCookieName: "lazurio.workspace" },
    { ...entry, authCookieName: "a".repeat(129) },
    { ...entry, listenPort: 1023 },
    { ...entry, listenPort: 20000.5 },
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
  const fetcher: AuthFetcher = (input, init) => {
    expect(input).toBe(entry.authCheckUrl);
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
  // The internal namespace (the gateway's `ensure`) is state-changing even on
  // GET: the same-origin rule applies; any other GET keeps the read rule.
  const internal = (headers: Record<string, string>) =>
    new Request(
      "http://127.0.0.1:20000/api/internal/hosted/modules/web/ensure",
      { headers: { host, ...headers } },
    );
  expect(await trust.admit(internal(good))).toEqual({
    ok: false,
    reason: "origin-mismatch",
  });
  expect(
    await trust.admit(
      internal({
        ...good,
        origin: entry.externalOrigin,
        "sec-fetch-site": "same-site",
      }),
    ),
  ).toEqual({ ok: false, reason: "origin-mismatch" });
  expect(
    await trust.admit(
      internal({
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
    fetcher: () => Promise.reject(new Error("ECONNREFUSED")),
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

// oauth2-proxy splits a session larger than one cookie into `<name>_0…_n`
// and reassembles it itself (`loadCookie`, pkg/sessions/cookie/
// session_store.go): the whole cookie wins when present, otherwise the
// chunks in index order, concatenated. Personal VMs carry such sessions.
const chunked = (...values: string[]) =>
  values.map((value, index) => `__Secure-lazurio-workspace_${index}=${value}`);

test("a chunked session is one cookie: the ordered chunks _0…_n, no gap, no repeat", () => {
  const name = entry.authCookieName;
  // Two and four chunks, in any header order, other cookies ignored.
  expect(
    selectCookie(`a=1; ${chunked("va", "lid").reverse().join("; ")}`, name),
  ).toEqual({ value: "valid", chunks: ["va", "lid"] });
  expect(selectCookie(chunked("v", "a", "l", "id").join("; "), name)).toEqual({
    value: "valid",
    chunks: ["v", "a", "l", "id"],
  });
  expect(selectCookie(chunked("valid").join("; "), name)).toEqual({
    value: "valid",
    chunks: ["valid"],
  });
  // Presence is the cookie or its `_0` chunk; a lone later chunk is not a
  // session, as for oauth2-proxy.
  expect(selectCookie(`${name}_1=lid; ${name}_2=x`, name)).toEqual({
    reason: "cookie-missing",
  });
  // A gap, a repeated index or an empty chunk is refused, not cut short.
  for (const header of [
    `${name}_0=va; ${name}_2=lid`,
    `${name}_0=va; ${name}_1=l; ${name}_3=id`,
    `${name}_0=va; ${name}_0=vb; ${name}_1=lid`,
    `${name}_0=va; ${name}_1=l; ${name}_1=lid`,
    `${name}_0=va; ${name}_1=`,
    `${name}_0=`,
  ])
    expect(selectCookie(header, name), header).toEqual({
      reason: "cookie-invalid",
    });
  // Only the names oauth2-proxy reads are chunks: `_01` or `_csrf` are other
  // cookies.
  expect(
    selectCookie(`${name}_0=valid; ${name}_01=x; ${name}_csrf=y`, name),
  ).toEqual({ value: "valid", chunks: ["valid"] });
  // The whole cookie wins over chunks beside it, exactly as before; its own
  // rules still hold.
  expect(
    selectCookie(`${name}_0=va; ${name}=whole; ${name}_1=lid`, name),
  ).toEqual({ value: "whole" });
  expect(
    selectCookie(`${name}=a; ${name}=b; ${name}_0=va; ${name}_1=lid`, name),
  ).toEqual({ reason: "cookie-invalid" });
  expect(selectCookie(`${name}=; ${name}_0=valid`, name)).toEqual({
    reason: "cookie-invalid",
  });
  // The 16 KiB bound covers the chunks too.
  expect(
    selectCookie(
      chunked(..."abcde".split("").map((c) => c.repeat(3500))).join("; "),
      name,
    ),
  ).toEqual({ reason: "cookie-invalid" });
});

test("a chunked session is admitted with its chunks forwarded unchanged; the Host and same-origin rules are not relaxed", async () => {
  // Realistic chunk sizes: oauth2-proxy cuts at about 4 KiB.
  const four = ["w", "x", "y", "z"].map((c) => c.repeat(3500));
  const accepted = new Set([
    chunked("va", "lid").join("; "),
    chunked(...four).join("; "),
  ]);
  const { calls, fetcher } = fakeAuth((cookie) =>
    cookie !== null && accepted.has(cookie)
      ? new Response("ok")
      : new Response("no", { status: 401 }),
  );
  const trust = createHostedTrust(entry, { fetcher });
  // Two chunks, sent out of order next to another cookie: the subrequest
  // carries exactly the chunks in index order, never re-joined.
  expect(
    await trust.admit(
      request("GET", {
        cookie: `other=1; ${chunked("va", "lid").reverse().join("; ")}`,
      }),
    ),
  ).toEqual({ ok: true });
  expect(calls).toEqual([chunked("va", "lid").join("; ")]);
  // Four chunks near the header bound.
  expect(
    await trust.admit(request("GET", { cookie: chunked(...four).join("; ") })),
  ).toEqual({ ok: true });
  expect(calls[1]).toBe(chunked(...four).join("; "));
  // The auth endpoint still decides: other chunks are denied.
  expect(
    await trust.admit(
      request("GET", { cookie: chunked("forg", "ed").join("; ") }),
    ),
  ).toEqual({ ok: false, reason: "auth-denied" });
  // A gap or a repeat is refused without asking the endpoint.
  const asked = calls.length;
  for (const cookie of [
    `__Secure-lazurio-workspace_0=va; __Secure-lazurio-workspace_2=lid`,
    `${chunked("va", "lid").join("; ")}; __Secure-lazurio-workspace_1=lid`,
  ])
    expect(await trust.admit(request("GET", { cookie }))).toEqual({
      ok: false,
      reason: "cookie-invalid",
    });
  expect(calls.length).toBe(asked);
  // Nothing else changes: the Host rule and the same-origin rule hold.
  const session = { cookie: chunked("va", "lid").join("; ") };
  expect(
    await trust.admit(request("GET", { ...session, host: "other.lazurio.io" })),
  ).toEqual({ ok: false, reason: "host-mismatch" });
  expect(await trust.admit(request("POST", session))).toEqual({
    ok: false,
    reason: "origin-mismatch",
  });
  expect(
    await trust.admit(
      request("POST", {
        ...session,
        origin: entry.externalOrigin,
        "sec-fetch-site": "same-origin",
      }),
    ),
  ).toEqual({ ok: true });
});
