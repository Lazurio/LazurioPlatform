import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  environmentSettingsReportSchema,
  environmentSettingsSchema,
  reportBody,
  type SettingsReport,
} from "../src/organization-settings/contract";
import {
  createRelayClient,
  type RelayClient,
  unixSocketTransport,
} from "../src/organization-settings/relay";
import {
  commit,
  type FakeRelay,
  fakeRelay,
  settingsAnswer,
} from "./fixtures/fake-relay";
import { runChild } from "./fixtures/run-child";

// Root decision 0194, DEV-6653 contracts C2 and C3: the Launchpad asks the
// Dashboard for its Organization's settings through the Environment's relay
// (HTTP/1.1 on a unix socket, Machines #449) and posts what it applied. It
// takes only C2's exact answer; anything other than 200 or 304 keeps the
// last applied version, and 502, 503 and 504 are tried again with backoff.

const relays: FakeRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
});

async function relayWith(
  answer: Parameters<typeof fakeRelay>[0],
): Promise<FakeRelay> {
  const relay = await fakeRelay(answer);
  relays.push(relay);
  return relay;
}

function client(
  socket: string,
  options: Partial<Parameters<typeof createRelayClient>[0]> = {},
): { client: RelayClient; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    client: createRelayClient({
      transport: unixSocketTransport(socket),
      retryDelaysMs: [1_000, 3_000],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...options,
    }),
    sleeps,
  };
}

const version = commit("a");
const delivered = {
  schema_version: environmentSettingsSchema,
  organization: { github_org_id: 123, login: "Example" },
  version,
  settings: { integrations: { composio: { allowed: false } } },
};

test("200: the Organization, its version and exactly the settings it delivered", async () => {
  const relay = await relayWith(() => settingsAnswer(delivered, version));
  const { client: relayClient } = client(relay.socket);
  expect(await relayClient.readSettings(null)).toEqual({
    kind: "settings",
    settings: {
      organization: { githubOrgId: 123, login: "Example" },
      version,
      values: { integrations: { composio: { allowed: false } } },
      unsupported: [],
    },
  });
  expect(relay.requests).toHaveLength(1);
  const [request] = relay.requests;
  expect(request?.method).toBe("GET");
  expect(request?.path).toBe("/organization/settings");
  expect(request?.query).toBe("");
  expect(request?.body).toBe("");
  expect(request?.headers["if-none-match"]).toBeUndefined();
  // The Launchpad sends nothing that could identify or authorize anything:
  // the relay attaches the Environment's token.
  expect(request?.headers.authorization).toBeUndefined();
  expect(request?.headers.cookie).toBeUndefined();
});

test("an Organization that governs nothing delivers {} and a personal answer says none", async () => {
  const none = await relayWith(() =>
    settingsAnswer(
      {
        schema_version: environmentSettingsSchema,
        organization: null,
        version: "none",
        settings: {},
      },
      "none",
    ),
  );
  expect(await client(none.socket).client.readSettings(null)).toEqual({
    kind: "settings",
    settings: {
      organization: null,
      version: "none",
      values: {},
      unsupported: [],
    },
  });
  const empty = await relayWith(() =>
    settingsAnswer({ ...delivered, settings: {} }, version),
  );
  expect(await client(empty.socket).client.readSettings(null)).toEqual({
    kind: "settings",
    settings: {
      organization: { githubOrgId: 123, login: "Example" },
      version,
      values: {},
      unsupported: [],
    },
  });
});

test("304: the version asked about is current, and nothing is read again", async () => {
  const relay = await relayWith(
    (request) =>
      new Response(null, {
        status: request.headers["if-none-match"] === `"${version}"` ? 304 : 500,
        headers: { etag: `"${version}"` },
      }),
  );
  expect(await client(relay.socket).client.readSettings(version)).toEqual({
    kind: "not-modified",
    version,
  });
  expect(relay.requests[0]?.headers["if-none-match"]).toBe(`"${version}"`);
});

test("a 304 to a question that named no version is not an answer", async () => {
  const relay = await relayWith(() => new Response(null, { status: 304 }));
  expect(await client(relay.socket).client.readSettings(null)).toEqual({
    kind: "failed",
    error: "dashboard_unreachable",
    detail: "answer-invalid",
  });
});

test("409 settings_invalid: the Organization's settings are broken at that version", async () => {
  const broken = commit("b");
  const relay = await relayWith(() =>
    Response.json(
      { error: "settings_invalid", version: broken },
      { status: 409 },
    ),
  );
  expect(await client(relay.socket).client.readSettings(version)).toEqual({
    kind: "invalid",
    version: broken,
  });
  expect(relay.requests).toHaveLength(1);
});

const refusals: readonly [
  string,
  number,
  unknown,
  "dashboard_unreachable" | "identity_unavailable",
  string,
  number,
][] = [
  // [name, status, body, error, detail, attempts]
  [
    "the relay without a token",
    503,
    { error: "environment_identity_unavailable" },
    "identity_unavailable",
    "environment_identity_unavailable",
    3,
  ],
  [
    "a refused bearer",
    401,
    { error: "token_invalid" },
    "identity_unavailable",
    "status-401",
    1,
  ],
  [
    "an Environment the Dashboard does not know",
    403,
    { error: "environment_unknown" },
    "identity_unavailable",
    "status-403",
    1,
  ],
  [
    "the Dashboard refusing the relay",
    502,
    "",
    "dashboard_unreachable",
    "status-502",
    3,
  ],
  [
    "GitHub unavailable",
    503,
    { error: "github_unavailable" },
    "dashboard_unreachable",
    "status-503",
    3,
  ],
  [
    "the Organization root unavailable",
    503,
    { error: "organization_root_unavailable" },
    "dashboard_unreachable",
    "status-503",
    3,
  ],
  ["the Dashboard silent", 504, "", "dashboard_unreachable", "status-504", 3],
  [
    "a path the relay does not know",
    404,
    { error: "not_found" },
    "dashboard_unreachable",
    "status-404",
    1,
  ],
  [
    "a method it does not take",
    405,
    { error: "method_not_allowed" },
    "dashboard_unreachable",
    "status-405",
    1,
  ],
  [
    "a body it refuses",
    413,
    { error: "body_too_large" },
    "dashboard_unreachable",
    "status-413",
    1,
  ],
  [
    "a type it refuses",
    415,
    { error: "json_body_required" },
    "dashboard_unreachable",
    "status-415",
    1,
  ],
  [
    "too many requests",
    429,
    { error: "rate_limited" },
    "dashboard_unreachable",
    "status-429",
    1,
  ],
  ["a server error", 500, "", "dashboard_unreachable", "status-500", 1],
  [
    "a 409 of another kind",
    409,
    { error: "conflict" },
    "dashboard_unreachable",
    "status-409",
    1,
  ],
];
for (const [name, status, body, error, detail, attempts] of refusals)
  test(`${status} (${name}) keeps the last applied version`, async () => {
    const relay = await relayWith(() =>
      typeof body === "string"
        ? new Response(body, { status })
        : Response.json(body, { status }),
    );
    const { client: relayClient, sleeps } = client(relay.socket);
    expect(await relayClient.readSettings(version)).toEqual({
      kind: "failed",
      error,
      detail,
    });
    expect(relay.requests).toHaveLength(attempts);
    // Only 502, 503 and 504 are asked again, after 1 s and 3 s.
    expect(sleeps).toEqual(attempts === 3 ? [1_000, 3_000] : []);
  });

test("a 503 that recovers is taken on the next attempt", async () => {
  let calls = 0;
  const relay = await relayWith(() => {
    calls += 1;
    return calls === 1
      ? Response.json({ error: "github_unavailable" }, { status: 503 })
      : settingsAnswer(delivered, version);
  });
  const { client: relayClient, sleeps } = client(relay.socket);
  const read = await relayClient.readSettings(null);
  expect(read.kind).toBe("settings");
  expect(sleeps).toEqual([1_000]);
});

const malformed: Readonly<Record<string, unknown>> = {
  "another schema": { ...delivered, schema_version: "lazurio.other.v1" },
  "an extra member": { ...delivered, extra: true },
  "a missing member": {
    schema_version: environmentSettingsSchema,
    organization: delivered.organization,
    version,
  },
  "a short version": { ...delivered, version: "abc123" },
  "an upper-case version": { ...delivered, version: "A".repeat(40) },
  "an Organization without its id": {
    ...delivered,
    organization: { login: "Example" },
  },
  "an Organization id that is not a positive integer": {
    ...delivered,
    organization: { github_org_id: 1.5, login: "Example" },
  },
  "an Organization login GitHub never gives": {
    ...delivered,
    organization: { github_org_id: 123, login: "-example-" },
  },
  "no Organization with a commit": { ...delivered, organization: null },
  "an Organization with no version": { ...delivered, version: "none" },
  "no Organization with settings": {
    schema_version: environmentSettingsSchema,
    organization: null,
    version: "none",
    settings: delivered.settings,
  },
  "settings that are not an object": { ...delivered, settings: [] },
  "a known setting of another type": {
    ...delivered,
    settings: { integrations: { composio: { allowed: "no" } } },
  },
  "a known setting without its required value": {
    ...delivered,
    settings: { integrations: { composio: {} } },
  },
  "a known group that is not an object": {
    ...delivered,
    settings: { integrations: true },
  },
  "an array": [delivered],
};
for (const [name, body] of Object.entries(malformed))
  test(`an answer with ${name} is never taken`, async () => {
    const relay = await relayWith(() => settingsAnswer(body, version));
    expect(await client(relay.socket).client.readSettings(null)).toEqual({
      kind: "failed",
      error: "dashboard_unreachable",
      detail: "answer-invalid",
    });
  });

test("text that is not JSON is never taken", async () => {
  const relay = await relayWith(
    () => new Response("<html>gateway</html>", { status: 200 }),
  );
  expect(await client(relay.socket).client.readSettings(null)).toEqual({
    kind: "failed",
    error: "dashboard_unreachable",
    detail: "answer-invalid",
  });
});

test("a setting this release does not know is kept apart by its key, never by its value", async () => {
  const canary = "canary-value-7f3c";
  const relay = await relayWith(() =>
    settingsAnswer(
      {
        ...delivered,
        settings: {
          integrations: {
            composio: { allowed: true },
            company_apps: { google: { enabled: true, secret_ref: canary } },
          },
          future: { limit: 3 },
        },
      },
      version,
    ),
  );
  const read = await client(relay.socket).client.readSettings(null);
  expect(read).toEqual({
    kind: "settings",
    settings: {
      organization: { githubOrgId: 123, login: "Example" },
      version,
      values: { integrations: { composio: { allowed: true } } },
      unsupported: [
        "future.limit",
        "integrations.company_apps.google.enabled",
        "integrations.company_apps.google.secret_ref",
      ],
    },
  });
  expect(JSON.stringify(read)).not.toContain(canary);
});

test("an answer larger than 64 KiB is refused unread, and not asked again", async () => {
  const relay = await relayWith(() =>
    settingsAnswer(
      {
        ...delivered,
        settings: { future: { padding: "x".repeat(80 * 1024) } },
      },
      version,
    ),
  );
  const { client: relayClient, sleeps } = client(relay.socket);
  expect(await relayClient.readSettings(null)).toEqual({
    kind: "failed",
    error: "dashboard_unreachable",
    detail: "too-large",
  });
  expect(relay.requests).toHaveLength(1);
  expect(sleeps).toEqual([]);
});

test("a relay that does not answer in time is given up on, and asked again", async () => {
  const relay = await relayWith(async () => {
    await Bun.sleep(1_000);
    return settingsAnswer(delivered, version);
  });
  const { client: relayClient, sleeps } = client(relay.socket, {
    timeoutMs: 100,
  });
  const started = Date.now();
  expect(await relayClient.readSettings(null)).toEqual({
    kind: "failed",
    error: "dashboard_unreachable",
    detail: "timeout",
  });
  expect(sleeps).toEqual([1_000, 3_000]);
  // Three attempts of 100 ms, never the relay's second.
  expect(Date.now() - started).toBeLessThan(900);
});

test("a Machine whose relay socket is absent asks nothing else", async () => {
  const relay = await relayWith(() => settingsAnswer(delivered, version));
  const absent = join(relay.socket, "..", "absent.sock");
  const { client: relayClient } = client(absent);
  expect(await relayClient.readSettings(null)).toEqual({
    kind: "failed",
    error: "dashboard_unreachable",
    detail: "socket-absent",
  });
  expect(relay.requests).toEqual([]);
});

const report: SettingsReport = {
  version,
  appliedAt: "2026-10-09T20:15:00.000Z",
  lastError: null,
  items: [
    { key: "integrations.composio.allowed", outcome: "applied", detail: null },
  ],
  platformVersion: "0.1.9",
};

test("the report is C2's exact JSON, posted to the relay's report path", async () => {
  const relay = await relayWith(() => Response.json({}, { status: 202 }));
  expect(await client(relay.socket).client.sendReport(report)).toEqual({
    kind: "accepted",
  });
  const [request] = relay.requests;
  expect(request?.method).toBe("POST");
  expect(request?.path).toBe("/organization/settings/report");
  expect(request?.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(request?.body ?? "")).toEqual({
    schema_version: environmentSettingsReportSchema,
    version,
    applied_at: "2026-10-09T20:15:00.000Z",
    last_error: null,
    items: [
      {
        key: "integrations.composio.allowed",
        outcome: "applied",
        detail: null,
      },
    ],
    platform_version: "0.1.9",
  });
  expect(Buffer.byteLength(request?.body ?? "")).toBeLessThanOrEqual(4096);
});

test("a refused report is said with its reason, a 503 is posted again", async () => {
  const invalid = await relayWith(() =>
    Response.json({ error: "invalid_report" }, { status: 400 }),
  );
  expect(await client(invalid.socket).client.sendReport(report)).toEqual({
    kind: "refused",
    status: 400,
    detail: "invalid_report",
  });
  expect(invalid.requests).toHaveLength(1);
  const busy = await relayWith(() =>
    Response.json({ error: "reports_unavailable" }, { status: 503 }),
  );
  const { client: busyClient, sleeps } = client(busy.socket);
  expect(await busyClient.sendReport(report)).toEqual({
    kind: "failed",
    detail: "status-503",
  });
  expect(busy.requests).toHaveLength(3);
  expect(sleeps).toEqual([1_000, 3_000]);
});

test("a report body is C2's shape and never larger than 4 KiB", () => {
  const unsupported = Array.from({ length: 200 }, (_, index) => ({
    key: `future.setting_${String(index).padStart(3, "0")}.value`,
    outcome: "unsupported" as const,
    detail: null,
  }));
  const body = reportBody({
    ...report,
    items: [...report.items, ...unsupported],
  });
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4096);
  const parsed = JSON.parse(body);
  // The applied items are kept; only unsupported ones make room.
  expect(parsed.items[0]).toEqual({
    key: "integrations.composio.allowed",
    outcome: "applied",
    detail: null,
  });
  expect(
    parsed.items.every(
      (item: { outcome: string }, index: number) =>
        index === 0 || item.outcome === "unsupported",
    ),
  ).toBe(true);
  for (const bad of [
    { ...report, version: "abc" },
    { ...report, appliedAt: "yesterday" },
    { ...report, lastError: "other" },
    { ...report, platformVersion: "" },
    {
      ...report,
      items: [{ key: "Bad Key", outcome: "applied", detail: null }],
    },
    {
      ...report,
      items: [
        {
          key: "integrations.composio.allowed",
          outcome: "applied",
          detail: "Not A Code",
        },
      ],
    },
    {
      ...report,
      items: [
        {
          key: "integrations.composio.allowed",
          outcome: "done",
          detail: null,
        },
      ],
    },
  ])
    expect(() => reportBody(bad as SettingsReport)).toThrow();
  // Never applied: no version and no time.
  expect(
    JSON.parse(reportBody({ ...report, version: null, appliedAt: null })),
  ).toMatchObject({ version: null, applied_at: null });
});

test("no proxy of the environment ever sees the relay's traffic", async () => {
  const relay = await relayWith(() => settingsAnswer(delivered, version));
  const seen: string[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.url);
      return new Response("proxied");
    },
  });
  try {
    const address = `http://127.0.0.1:${proxy.port}`;
    // The proxy variables reach only a process of their own.
    const child = await runChild(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures", "relay-call.ts"),
        relay.socket,
      ],
      {
        env: {
          ...process.env,
          HTTP_PROXY: address,
          http_proxy: address,
          HTTPS_PROXY: address,
          https_proxy: address,
          ALL_PROXY: address,
          all_proxy: address,
          NO_PROXY: "",
          no_proxy: "",
          NODE_USE_ENV_PROXY: "1",
        },
        timeout: 20_000,
      },
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout).kind).toBe("settings");
    expect(seen).toEqual([]);
    expect(relay.requests).toHaveLength(1);
  } finally {
    proxy.stop(true);
  }
});
