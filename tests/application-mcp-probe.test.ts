import { expect, test } from "bun:test";
import {
  cachedMcpProbe,
  isApplicationOrigin,
  probeApplicationMcp,
} from "../src/launchpad/application-mcp-probe";

// Apps offers "Připojit k agentům" only where the account states the
// Application serves MCP and this probe finds the Application's host admitting
// MCP sign-in for that origin (plan LZD-0037, AccountApplication.mcp). The
// probe sees the gateway, never the App behind it. Example names only.

const origin = "https://deals.example.lazurio.app";
const metadata = `${origin}/.well-known/oauth-protected-resource`;

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>) {
  const asked: string[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    asked.push(`${init?.method ?? "GET"} ${url}`);
    const route = routes[url];
    if (route === undefined) throw new TypeError("network");
    return route(init);
  }) as typeof fetch;
  return { fetcher, asked };
}
const challenge = (value: string) =>
  new Response(null, { status: 401, headers: { "www-authenticate": value } });
const gateway: Route = () =>
  challenge(
    `Bearer resource_metadata="${metadata}", scope="example--apps-01-applications-mcp"`,
  );
const metadataOf =
  (value: unknown): Route =>
  () =>
    Response.json(value);
const good = {
  resource: `${origin}/mcp`,
  authorization_servers: ["https://auth.example/realms/workspace"],
};

test("a host that admits MCP sign-in: 401 with a Bearer challenge and its own metadata", async () => {
  const { fetcher, asked } = fakeFetch({
    [`${origin}/mcp`]: gateway,
    [metadata]: metadataOf(good),
  });
  expect(await probeApplicationMcp(origin, fetcher)).toEqual({ admits: true });
  expect(asked).toEqual([`POST ${origin}/mcp`, `GET ${metadata}`]);
});

test("the probe sends no credential and follows no redirect", async () => {
  let seen: RequestInit | undefined;
  const { fetcher } = fakeFetch({
    [`${origin}/mcp`]: (init) => {
      seen = init;
      return gateway(init);
    },
    [metadata]: metadataOf(good),
  });
  await probeApplicationMcp(origin, fetcher);
  expect(seen?.redirect).toBe("manual");
  expect(new Headers(seen?.headers).has("authorization")).toBe(false);
  expect(new Headers(seen?.headers).has("cookie")).toBe(false);
});

test("a host that does not admit MCP sign-in for the origin is refused", async () => {
  const cases: Record<string, Record<string, Route>> = {
    "a page instead of 401": {
      [`${origin}/mcp`]: () => new Response("<html>", { status: 200 }),
    },
    "a 404": { [`${origin}/mcp`]: () => new Response(null, { status: 404 }) },
    "a redirect to sign in": {
      [`${origin}/mcp`]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://auth.example/" },
        }),
    },
    "401 without a Bearer challenge": {
      [`${origin}/mcp`]: () => new Response(null, { status: 401 }),
    },
    "a challenge without metadata": {
      [`${origin}/mcp`]: () => challenge('Bearer realm="x"'),
    },
    "metadata of another host": {
      [`${origin}/mcp`]: () =>
        challenge(
          'Bearer resource_metadata="https://evil.example/.well-known/oauth-protected-resource"',
        ),
    },
    "metadata for another resource": {
      [`${origin}/mcp`]: gateway,
      [metadata]: metadataOf({
        ...good,
        resource: "https://other.example.lazurio.app/mcp",
      }),
    },
    "metadata without an authorization server": {
      [`${origin}/mcp`]: gateway,
      [metadata]: metadataOf({
        resource: `${origin}/mcp`,
        authorization_servers: [],
      }),
    },
    "metadata that are not there": {
      [`${origin}/mcp`]: gateway,
      [metadata]: () => new Response(null, { status: 404 }),
    },
  };
  for (const [name, routes] of Object.entries(cases))
    expect([
      name,
      await probeApplicationMcp(origin, fakeFetch(routes).fetcher),
    ]).toEqual([name, { admits: false, reason: "no-mcp-sign-in" }]);
});

test("an Application that does not answer is unreachable", async () => {
  expect(await probeApplicationMcp(origin, fakeFetch({}).fetcher)).toEqual({
    admits: false,
    reason: "unreachable",
  });
  const slow = fakeFetch({
    [`${origin}/mcp`]: (init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  });
  expect(await probeApplicationMcp(origin, slow.fetcher, 20)).toEqual({
    admits: false,
    reason: "unreachable",
  });
});

test("only an Application's own https origin on the Organizations' zone is ever asked", async () => {
  const { fetcher, asked } = fakeFetch({});
  for (const value of [
    "http://deals.example.lazurio.app",
    "https://deals.example.lazurio.app/",
    "https://deals.example.lazurio.app/mcp",
    "https://127.0.0.1",
    "https://intranet.example",
    "https://lazurio.app.evil.example",
    "",
    42,
  ])
    expect(await probeApplicationMcp(value, fetcher)).toEqual({
      admits: false,
      reason: "not-an-application",
    });
  expect(asked).toEqual([]);
  expect(isApplicationOrigin(origin)).toBe(true);
});

test("answers are kept per origin for a while; an unreachable one is asked again", async () => {
  let clock = 0;
  const answers = [
    { admits: false as const, reason: "unreachable" as const },
    { admits: true as const },
  ];
  let calls = 0;
  const probe = cachedMcpProbe(
    async () => answers[Math.min(calls++, 1)] as never,
    1000,
    () => clock,
  );
  expect(await probe(origin)).toEqual({ admits: false, reason: "unreachable" });
  expect(await probe(origin)).toEqual({ admits: true });
  expect(await probe(origin)).toEqual({ admits: true });
  expect(calls).toBe(2);
  clock = 2000;
  await probe(origin);
  expect(calls).toBe(3);
});

test("a known limit: the gateway in front of an App without MCP answers the same, and the probe admits it", async () => {
  // Before sign-in only the gateway answers /mcp; whether the App behind it
  // serves MCP is the account's statement (AccountApplication.mcp). Until the
  // gateway answers /mcp only for a declaring Application
  // (HumanAndMachine-ai/Machines#1382), a wrong statement shows after sign-in
  // as a connection without tools. This test fixes the limit, so a change of
  // the gateway shows here.
  const appWithoutMcp = fakeFetch({
    [`${origin}/mcp`]: gateway,
    [metadata]: metadataOf(good),
  });
  expect(await probeApplicationMcp(origin, appWithoutMcp.fetcher)).toEqual({
    admits: true,
  });
});
