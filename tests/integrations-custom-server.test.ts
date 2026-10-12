import { expect, test } from "bun:test";
import {
  type CustomServerInput,
  type CustomStored,
  customProblems,
  cwdProblem,
  envValues,
  keyHeaders,
  keysChange,
  keysMethod,
  remoteAuthOf,
  resolveCwd,
  settingsOf,
  storedOf,
  urlProblem,
} from "../src/integrations/custom-server";

// A custom MCP server's rules (decision F42, addendum of 2026-10-11): what
// the page and the Launchpad's server both refuse, which keys an edit keeps,
// and the shapes Executor 1.6.10 takes and answers (read from its source at
// v1.6.10 and confirmed against its shipped program).

const stdio = (
  extra: Partial<Extract<CustomServerInput, { type: "stdio" }>> = {},
): CustomServerInput => ({
  type: "stdio",
  name: "Files",
  command: "npx",
  args: [],
  env: [],
  cwd: null,
  ...extra,
});
const http = (
  extra: Partial<Extract<CustomServerInput, { type: "http" }>> = {},
): Extract<CustomServerInput, { type: "http" }> => ({
  type: "http",
  name: "Invoices",
  url: "https://mcp.example.com/mcp",
  bearer: null,
  headers: [],
  ...extra,
});

test("an address is https, or plain http to this computer only", () => {
  for (const url of [
    "https://mcp.example.com/mcp",
    "https://mcp.example.com/mcp?key=1",
    "http://localhost:8931/mcp",
    "http://127.0.0.1/mcp",
    "http://127.10.0.2:9000/",
    "http://[::1]:8080/mcp",
  ])
    expect([url, urlProblem(url)]).toEqual([url, null]);
  expect(urlProblem("  ")).toBe("required");
  for (const url of [
    "http://mcp.example.com/mcp",
    "http://192.168.1.10/mcp",
    "http://127.0.0.1.example.com/mcp",
    "http://localhost.example.com/",
  ])
    expect([url, urlProblem(url)]).toEqual([url, "insecure"]);
  for (const url of [
    "mcp.example.com/mcp",
    "ftp://mcp.example.com/",
    "https://mcp.example.com/a b",
    "javascript:alert(1)",
    `https://example.com/${"x".repeat(2048)}`,
  ])
    expect([url, urlProblem(url)]).toEqual([url, "invalid"]);
});

test("a working directory is absolute or below the home; `~` resolves against this account's home", () => {
  expect(cwdProblem(null)).toBeNull();
  expect(cwdProblem("")).toBeNull();
  expect(cwdProblem("~/code")).toBeNull();
  expect(cwdProblem("/srv/mcp")).toBeNull();
  expect(cwdProblem("~")).toBeNull();
  expect(cwdProblem("code")).toBe("invalid");
  expect(cwdProblem("~other/code")).toBe("invalid");
  expect(cwdProblem("/srv/\nmcp")).toBe("invalid");
  expect(resolveCwd("~/code", "/home/ada")).toBe("/home/ada/code");
  expect(resolveCwd("~", "/home/ada/")).toBe("/home/ada/");
  expect(resolveCwd("~/", "/home/ada")).toBe("/home/ada");
  expect(resolveCwd("/srv/mcp", undefined)).toBe("/srv/mcp");
  expect(resolveCwd(" ", "/home/ada")).toBeNull();
  expect(resolveCwd("~/code", undefined)).toBe("unresolved");
});

test("the fields each refuse what Executor or the wire could not take", () => {
  expect(customProblems(stdio(), null)).toEqual([]);
  expect(
    customProblems(
      stdio({
        name: " ",
        command: "",
        args: ["ok", "a\0b"],
        env: [
          { name: "TOKEN", value: "x" },
          { name: "TOKEN", value: "y" },
          { name: "token", value: "z" },
          { name: "9LIVES", value: "x" },
          { name: "", value: "x" },
          { name: "EMPTY", value: "" },
          // A value may span lines in an environment variable.
          { name: "PEM", value: "-----BEGIN-----\nabc\n-----END-----" },
        ],
        cwd: "relative",
      }),
      null,
    ),
  ).toEqual([
    { field: "name", problem: "required" },
    // Variables are case-sensitive: `token` is another one.
    { field: "env", index: 1, part: "name", problem: "duplicate" },
    { field: "env", index: 3, part: "name", problem: "invalid" },
    { field: "env", index: 4, part: "name", problem: "required" },
    { field: "env", index: 5, part: "value", problem: "required" },
    { field: "command", problem: "required" },
    { field: "arg", index: 1, problem: "invalid" },
    { field: "cwd", problem: "invalid" },
  ]);
  expect(
    customProblems(
      http({
        url: "http://mcp.example.com/mcp",
        bearer: { value: "t" },
        headers: [
          { name: "X-Team", value: "a" },
          // Header names are not: this is the same header.
          { name: "x-team", value: "b" },
          { name: "Authorization", value: "Basic x" },
          { name: "Bad Name", value: "v" },
          { name: "X-Split", value: "a\r\nX-Evil: b" },
        ],
      }),
      null,
    ),
  ).toEqual([
    { field: "header", index: 1, part: "name", problem: "duplicate" },
    { field: "header", index: 2, part: "name", problem: "taken" },
    { field: "header", index: 3, part: "name", problem: "invalid" },
    { field: "header", index: 4, part: "value", problem: "invalid" },
    { field: "url", problem: "insecure" },
  ]);
  // A new server stores nothing to keep.
  expect(
    customProblems(
      http({ bearer: { value: null }, headers: [{ name: "X", value: null }] }),
      null,
    ),
  ).toEqual([
    { field: "header", index: 0, part: "value", problem: "required" },
    { field: "bearer", problem: "required" },
  ]);
  expect(customProblems(stdio({ name: "a".repeat(65) }), null)).toEqual([
    { field: "name", problem: "invalid" },
  ]);
  expect(
    customProblems(
      stdio({
        env: Array.from({ length: 33 }, (_, index) => ({
          name: `K${index}`,
          value: "v",
        })),
      }),
      null,
    ),
  ).toEqual([{ field: "env", index: 32, part: "name", problem: "invalid" }]);
});

const storedHttp: CustomStored = {
  type: "http",
  bearer: true,
  names: ["X-Team"],
  url: "https://mcp.example.com/mcp",
};

test("an edit keeps its keys until one changes; then every key comes again", () => {
  const kept = http({
    bearer: { value: null },
    headers: [{ name: "x-team", value: null }],
  });
  expect(keysChange(kept, storedHttp)).toBe(false);
  expect(customProblems(kept, storedHttp)).toEqual([]);
  // Nothing stored is new; a new token, another header or one less, a
  // token added or removed: the keys change.
  expect(keysChange(kept, null)).toBe(true);
  for (const changed of [
    http({ bearer: { value: "new" }, headers: kept.headers }),
    http({ bearer: { value: null }, headers: [] }),
    http({ bearer: null, headers: kept.headers }),
    http({
      bearer: { value: null },
      headers: [...kept.headers, { name: "X-Region", value: "eu" }],
    }),
    http({
      bearer: { value: null },
      headers: [{ name: "X-Team", value: "b" }],
    }),
  ])
    expect(keysChange(changed, storedHttp)).toBe(true);
  expect(
    customProblems(
      http({
        bearer: { value: null },
        headers: [
          { name: "X-Team", value: null },
          { name: "X-Region", value: "eu" },
        ],
      }),
      storedHttp,
    ),
  ).toEqual([
    { field: "header", index: 0, part: "value", problem: "again" },
    { field: "bearer", problem: "again" },
  ]);
  const storedStdio: CustomStored = {
    type: "stdio",
    bearer: false,
    names: ["TOKEN"],
    url: null,
  };
  expect(
    keysChange(stdio({ env: [{ name: "TOKEN", value: null }] }), storedStdio),
  ).toBe(false);
  // Variables are case-sensitive: `token` is another one.
  expect(
    customProblems(
      stdio({ env: [{ name: "token", value: null }] }),
      storedStdio,
    ),
  ).toEqual([{ field: "env", index: 0, part: "value", problem: "required" }]);
  // A new address is a key change for a server with keys (it is probed and
  // reached with them), never for one without.
  const movedKept = http({
    url: "https://mcp.moved.example.com/mcp",
    bearer: { value: null },
    headers: [{ name: "X-Team", value: null }],
  });
  expect(keysChange(movedKept, storedHttp)).toBe(true);
  expect(customProblems(movedKept, storedHttp)).toEqual([
    { field: "header", index: 0, part: "value", problem: "again" },
    { field: "bearer", problem: "again" },
  ]);
  expect(
    keysChange(http({ url: "https://mcp.moved.example.com/mcp" }), {
      ...storedHttp,
      bearer: false,
      names: [],
    }),
  ).toBe(false);
  // The address the page was shown keeps the stored one, whatever it is.
  expect(
    customProblems(
      http({
        url: "https://mcp.example.com/mcp",
        bearer: { value: null },
        headers: kept.headers,
      }),
      { ...storedHttp, url: "https://mcp.example.com/mcp" },
    ),
  ).toEqual([]);
});

test("Executor's shapes: the keys as one method with its values, the variables as the command's env", () => {
  const server = http({
    bearer: { value: "tok" },
    headers: [
      { name: " X-Api-Key ", value: "k" },
      { name: "Token", value: "not the bearer" },
    ],
  });
  expect(keyHeaders(server)).toEqual({
    Authorization: "Bearer tok",
    "X-Api-Key": "k",
    Token: "not the bearer",
  });
  expect(keysMethod(server)).toEqual({
    input: {
      slug: "apikey",
      type: "apiKey",
      headers: {
        Authorization: ["Bearer ", { type: "variable", name: "token" }],
        "X-Api-Key": [{ type: "variable", name: "header-x-api-key" }],
        Token: [{ type: "variable", name: "header-token" }],
      },
    },
    stored: {
      slug: "apikey",
      kind: "apikey",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer " },
        { carrier: "header", name: "X-Api-Key", variable: "header-x-api-key" },
        { carrier: "header", name: "Token", variable: "header-token" },
      ],
    },
    values: {
      token: "tok",
      "header-x-api-key": "k",
      "header-token": "not the bearer",
    },
  });
  expect(keysMethod(http())).toBeNull();
  // A kept key's value is Executor's: none of these can be built.
  const kept = http({ bearer: { value: null } });
  expect(keysMethod(kept)).toBeNull();
  expect(keyHeaders(kept)).toBeNull();
  expect(
    envValues(
      stdio({
        env: [
          { name: "A", value: "1" },
          { name: " B ", value: "2" },
        ],
      }) as Extract<CustomServerInput, { type: "stdio" }>,
    ),
  ).toEqual({ A: "1", B: "2" });
  expect(
    envValues(
      stdio({ env: [{ name: "A", value: null }] }) as Extract<
        CustomServerInput,
        { type: "stdio" }
      >,
    ),
  ).toBeNull();
});

test("the edit form of a stored server: its configuration and the names of its keys, never a value", () => {
  // As Executor 1.6.10 answers a command server added with `env`.
  expect(
    settingsOf(
      "files",
      "Files",
      {
        transport: "stdio",
        command: "npx",
        args: ["-y", "files"],
        cwd: "/srv",
        env: { LEGACY: "plain" },
        authenticationTemplate: [
          { slug: "env", kind: "stdio_env", vars: ["TOKEN"] },
        ],
      },
      "env",
    ),
  ).toEqual({
    kind: "custom-server",
    id: "files",
    type: "stdio",
    name: "Files",
    command: "npx",
    args: ["-y", "files"],
    cwd: "/srv",
    env: ["TOKEN"],
  });
  const remote = {
    transport: "remote",
    endpoint: "https://user:pass@mcp.example.com/mcp/?key=secret",
    remoteTransport: "auto",
    authenticationTemplate: [
      {
        slug: "apikey",
        kind: "apikey",
        placements: [
          { carrier: "header", name: "Authorization", prefix: "Bearer " },
          { carrier: "header", name: "X-Team", variable: "header-x-team" },
          { carrier: "query", name: "token", variable: "q" },
        ],
      },
      { slug: "oauth2", kind: "oauth2" },
    ],
  };
  const settings = settingsOf("inv", "Invoices", remote, "apikey");
  expect(settings).toEqual({
    kind: "custom-server",
    id: "inv",
    type: "http",
    name: "Invoices",
    url: "https://mcp.example.com/mcp",
    bearer: true,
    headers: ["X-Team"],
  });
  expect(JSON.stringify(settings)).not.toContain("secret");
  expect(storedOf(settings as NonNullable<typeof settings>)).toEqual({
    type: "http",
    bearer: true,
    names: ["X-Team"],
    url: "https://mcp.example.com/mcp",
  });
  // The method its account binds decides; a header without the Bearer
  // prefix (as Lazurio added one before) is a header of its own.
  expect(remoteAuthOf(remote, "oauth2")).toEqual({ kind: "oauth2" });
  expect(
    remoteAuthOf(
      {
        authenticationTemplate: [
          {
            slug: "header",
            kind: "apikey",
            placements: [{ carrier: "header", name: "Authorization" }],
          },
        ],
      },
      "header",
    ),
  ).toEqual({ kind: "keys", bearer: false, headers: ["Authorization"] });
  expect(remoteAuthOf({}, null)).toEqual({ kind: "none" });
  expect(settingsOf("x", "X", { transport: "sse" }, null)).toBeNull();
  expect(
    settingsOf("x", "X", { transport: "remote", endpoint: "nota url" }, null),
  ).toBeNull();
});
