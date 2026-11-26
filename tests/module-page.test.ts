import { expect, test } from "bun:test";
import {
  appCookies,
  appRequestHeaders,
  deliverModulePage,
  modulePageTarget,
} from "../src/launchpad/module-page";

// Plan LZD-0039 `task-2026-11-25-101`, part A: the Launchpad delivers a
// Module app's page in STAGING with Lazurio's element. Failure means: an app
// address or origin taken from the request, the session cookie or a client's
// identity header reaching the app, or a page delivered without the element.

const subject = "0f8fad5b-d9cb-469f-a165-70867728950e";
const person = { subject, username: "ada-lovelace" };
const cookie = "__Secure-lazurio-workspace";

test("the target is the module id as one segment and the page's path with its query; nothing else", () => {
  const target = (path: string) =>
    modulePageTarget(new URL(`https://launchpad.example${path}`));
  expect(
    target("/api/internal/hosted/module-page/notes/reports/1?tab=a"),
  ).toEqual({
    id: "notes",
    path: "/reports/1?tab=a",
  });
  expect(target("/api/internal/hosted/module-page/notes/")).toEqual({
    id: "notes",
    path: "/",
  });
  for (const path of [
    "/api/internal/hosted/module-page/",
    "/api/internal/hosted/module-page/notes",
    "/api/internal/hosted/module-page/Notes/",
    "/api/internal/hosted/module-page/%E0%A4%A/",
    "/api/internal/hosted/module-page/notes//evil.example/",
    "/.lazurio/shell.js",
    "/",
  ])
    expect(target(path)).toBeNull();
});

test("the app gets its own cookies, never the session's or its chunks", () => {
  expect(
    appCookies(
      `${cookie}=s; app=1; ${cookie}_0=a; ${cookie}_1=b; theme=dark`,
      cookie,
    ),
  ).toBe("app=1; theme=dark");
  expect(appCookies(`${cookie}=s`, cookie)).toBeNull();
  expect(appCookies(null, cookie)).toBeNull();
  // A lookalike name is the app's.
  expect(appCookies(`${cookie}_x=1; ${cookie}2=2`, cookie)).toBe(
    `${cookie}_x=1; ${cookie}2=2`,
  );
});

test("the app's headers: its Host, who came as the admission says, nothing the client stated", () => {
  const headers = appRequestHeaders(
    new Headers({
      host: "launchpad.example",
      cookie: `${cookie}=s; app=1`,
      accept: "text/html",
      "accept-language": "cs",
      "accept-encoding": "gzip, br",
      "sec-fetch-dest": "document",
      "x-auth-request-user": "11111111-1111-4111-8111-111111111111",
      "x-auth-request-preferred-username": "mallory",
      "x-lazurio-entry": "app",
      "x-lazurio-app-role": "admin",
      "x-forwarded-host": "evil.example",
      "if-none-match": '"cached"',
      "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT",
      origin: "https://launchpad.example",
      "sec-fetch-site": "same-origin",
      authorization: "Bearer x",
      connection: "keep-alive",
    }),
    "https://notes.gamma.example",
    cookie,
    person,
  );
  expect(headers.get("host")).toBe("notes.gamma.example");
  expect(headers.get("x-forwarded-host")).toBe("notes.gamma.example");
  expect(headers.get("x-forwarded-proto")).toBe("https");
  expect(headers.get("cookie")).toBe("app=1");
  expect(headers.get("x-auth-request-user")).toBe(subject);
  expect(headers.get("x-auth-request-preferred-username")).toBe("ada-lovelace");
  expect(headers.get("x-lazurio-entry")).toBe("environment");
  expect(headers.get("x-lazurio-app-role")).toBeNull();
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("connection")).toBeNull();
  // The app's validators and the gateway's same-origin proof stay behind.
  for (const name of [
    "if-none-match",
    "if-modified-since",
    "origin",
    "sec-fetch-site",
  ])
    expect(headers.get(name)).toBeNull();
  expect(headers.get("accept-encoding")).toBe("identity");
  expect(headers.get("accept")).toBe("text/html");
  expect(headers.get("accept-language")).toBe("cs");
  expect(headers.get("sec-fetch-dest")).toBe("document");
  // Nobody named: no person headers at all.
  const anonymous = appRequestHeaders(
    new Headers(),
    "https://notes.gamma.example",
    cookie,
    {
      subject: null,
      username: null,
    },
  );
  expect(anonymous.get("x-auth-request-user")).toBeNull();
  expect(anonymous.get("x-auth-request-preferred-username")).toBeNull();
});

test("the page comes from the app's loopback address and is delivered with the element; other answers as they came", async () => {
  const asked: { url: string; init: RequestInit }[] = [];
  const answer =
    (body: string, init: ResponseInit) =>
    async (url: string, request: RequestInit) => {
      asked.push({ url, init: request });
      return new Response(body, init);
    };
  const input = {
    request: new Request(
      "https://launchpad.example/api/internal/hosted/module-page/notes/r?x=1",
    ),
    target: { id: "notes", path: "/r?x=1" },
    origin: "https://notes.gamma.example",
    entry: { host: "127.0.0.1", port: 4310 },
    cookieName: cookie,
    person,
  };
  const page = await deliverModulePage({
    ...input,
    fetcher: answer("<html><body>App</body></html>", {
      headers: { "content-type": "text/html" },
    }),
  });
  expect(asked[0]?.url).toBe("http://127.0.0.1:4310/r?x=1");
  expect(asked[0]?.init.redirect).toBe("manual");
  expect(await page.text()).toContain(
    '<lazurio-buddy version="staging"></lazurio-buddy></body>',
  );

  const redirect = await deliverModulePage({
    ...input,
    fetcher: answer("", { status: 302, headers: { location: "/sign-in" } }),
  });
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe("/sign-in");

  const json = await deliverModulePage({
    ...input,
    fetcher: answer('{"a":1}', {
      headers: { "content-type": "application/json" },
    }),
  });
  expect(await json.text()).toBe('{"a":1}');

  const ipv6 = await deliverModulePage({
    ...input,
    entry: { host: "::1", port: 4310 },
    fetcher: answer("", { status: 204 }),
  });
  expect(ipv6.status).toBe(204);
  expect(asked.at(-1)?.url).toBe("http://[::1]:4310/r?x=1");

  const down = await deliverModulePage({
    ...input,
    fetcher: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  expect(down.status).toBe(502);
});
