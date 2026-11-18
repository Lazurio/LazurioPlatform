import { expect, test } from "bun:test";
import {
  cachedMcpProbe,
  isApplicationOrigin,
  probeApplicationMcp,
} from "../src/launchpad/application-mcp-probe";

// Apps offers "Připojit k agentům" only where this probe says the Application
// really offers an MCP server (plan LZD-0037, AccountApplication.mcp). Example
// names only.

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

test("a verified MCP server: 401 with a Bearer challenge and its own metadata", async () => {
  const { fetcher, asked } = fakeFetch({
    [`${origin}/mcp`]: gateway,
    [metadata]: metadataOf(good),
  });
  expect(await probeApplicationMcp(origin, fetcher)).toEqual({ mcp: true });
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

test("an Application that is not an MCP server is refused", async () => {
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
    ]).toEqual([name, { mcp: false, reason: "not-mcp" }]);
});

test("an Application that does not answer is unreachable", async () => {
  expect(await probeApplicationMcp(origin, fakeFetch({}).fetcher)).toEqual({
    mcp: false,
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
    mcp: false,
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
      mcp: false,
      reason: "not-an-application",
    });
  expect(asked).toEqual([]);
  expect(isApplicationOrigin(origin)).toBe(true);
});

test("answers are kept per origin for a while; an unreachable one is asked again", async () => {
  let clock = 0;
  const answers = [
    { mcp: false as const, reason: "unreachable" as const },
    { mcp: true as const },
  ];
  let calls = 0;
  const probe = cachedMcpProbe(
    async () => answers[Math.min(calls++, 1)] as never,
    1000,
    () => clock,
  );
  expect(await probe(origin)).toEqual({ mcp: false, reason: "unreachable" });
  expect(await probe(origin)).toEqual({ mcp: true });
  expect(await probe(origin)).toEqual({ mcp: true });
  expect(calls).toBe(2);
  clock = 2000;
  await probe(origin);
  expect(calls).toBe(3);
});
