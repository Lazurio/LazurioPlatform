import { afterAll, expect, test } from "bun:test";
import { renderAnswer, requestSession } from "../scripts/qualify-update-http";

// The bundle's HTTP helper speaks to a Launchpad session the way the page
// does, so what the native harness clicks is what a browser would send.
type Seen = Readonly<{
  method: string;
  path: string;
  authorization: string | null;
  origin: string | null;
  contentType: string | null;
  body: string;
}>;
const seen: Seen[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    seen.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
      origin: request.headers.get("origin"),
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    });
    return Response.json({ echo: url.pathname }, { status: 409 });
  },
});
afterAll(() => server.stop(true));
const origin = `http://127.0.0.1:${server.port}`;

test("GET carries the bearer token and no Origin; POST carries Origin, JSON and the body", async () => {
  const get = await requestSession({
    method: "GET",
    url: `${origin}/api/update/status`,
    token: "t0k3n",
  });
  expect(get).toEqual({ status: 409, body: '{"echo":"/api/update/status"}' });
  const post = await requestSession({
    method: "POST",
    url: `${origin}/api/update/apply`,
    token: "t0k3n",
    body: '{"version":"1.3.0"}',
  });
  expect(post.status).toBe(409);
  expect(seen).toEqual([
    {
      method: "GET",
      path: "/api/update/status",
      authorization: "Bearer t0k3n",
      origin: null,
      contentType: null,
      body: "",
    },
    {
      method: "POST",
      path: "/api/update/apply",
      authorization: "Bearer t0k3n",
      origin,
      contentType: "application/json",
      body: '{"version":"1.3.0"}',
    },
  ]);
  expect(renderAnswer(post)).toBe('status=409\n{"echo":"/api/update/apply"}\n');
});

test("never leaves loopback", async () => {
  for (const url of [
    "http://localhost:1/",
    "https://127.0.0.1/",
    "http://example.com/",
  ])
    await expect(
      requestSession({ method: "GET", url, token: "t" }),
    ).rejects.toThrow("Loopback sessions only");
  expect(seen).toHaveLength(2);
});

test("as a command: status line and body on stdout; status=0 and exit 1 without an answer", async () => {
  const script = new URL("../scripts/qualify-update-http.ts", import.meta.url)
    .pathname;
  const run = async (args: string[], token?: string) => {
    const child = Bun.spawn([process.execPath, "run", script, ...args], {
      env: token === undefined ? {} : { LAZURIO_QUALIFY_TOKEN: token },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  };
  const answered = await run(["GET", `${origin}/api/update/status`], "t0k3n");
  expect(answered).toEqual({
    code: 0,
    stdout: 'status=409\n{"echo":"/api/update/status"}\n',
    stderr: "",
  });
  expect(seen.at(-1)).toMatchObject({ authorization: "Bearer t0k3n" });
  // A closed port: no answer, and the caller can tell.
  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = closed.port;
  await closed.stop(true);
  const refused = await run(["GET", `http://127.0.0.1:${port}/x`], "t0k3n");
  expect([refused.code, refused.stdout]).toEqual([1, "status=0\n\n"]);
  // Usage: no token, an unknown method, a GET with a body.
  expect((await run(["GET", `${origin}/`])).code).toBe(2);
  expect((await run(["PUT", `${origin}/`], "t")).code).toBe(2);
  expect((await run(["GET", `${origin}/`, "{}"], "t")).code).toBe(2);
});
