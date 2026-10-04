import { expect, test } from "bun:test";
import {
  type ContentJob,
  type ContentTransport,
  contentDetail,
  createContentClient,
  installAnswer,
  parseContentJob,
  parseContentList,
  parseContentRef,
  refersTo,
} from "../src/launchpad/content-client";

// The content routes are the server's (DEV-6644 content install); the page
// reads them through this client. Every answer is a stub of the fixed API:
// what lives here, the installation and its job.

const list = {
  allowed: true,
  items: [
    {
      kind: "organization",
      login: "example",
      name: "Example",
      state: "absent",
    },
    {
      kind: "personalspace",
      login: "octocat",
      state: "present",
      onGitHub: "exists",
    },
  ],
};

const runningJob = {
  id: "job-1",
  state: "running",
  steps: [
    {
      item: { kind: "organization", login: "example" },
      key: "access",
      state: "done",
    },
    {
      item: { kind: "organization", login: "example" },
      key: "root",
      state: "running",
    },
  ],
};

const failedJob = {
  id: "job-1",
  state: "failed",
  steps: [
    { item: "organization:example", key: "access", state: "done" },
    { item: "organization:example", key: "root", state: "done" },
    { item: "organization:example", key: "modules", state: "done" },
    {
      item: "organization:example",
      key: "preparation",
      state: "failed",
      detail: "bun install failed",
    },
  ],
  failure: {
    item: { kind: "organization", login: "example" },
    key: "preparation",
    code: "preparation-failed",
    detail: "bun install in deals failed:\nregistry did not answer",
  },
};

test("the list: its items in their exact shapes, an unknown kind left out", () => {
  const read = parseContentList({
    ...list,
    items: [...list.items, { kind: "something-new", state: "absent" }],
  });
  expect(read).toEqual({
    allowed: true,
    items: [
      {
        kind: "organization",
        login: "example",
        name: "Example",
        state: "absent",
      },
      {
        kind: "personalspace",
        login: "octocat",
        state: "present",
        onGitHub: "exists",
      },
    ],
  });
  expect(
    parseContentList({
      allowed: false,
      reason: "team-environment",
      items: [],
    }),
  ).toEqual({ allowed: false, reason: "team-environment", items: [] });
  // A personal Environment's Personalspace whose owner is not known yet.
  expect(
    parseContentList({
      allowed: true,
      items: [{ kind: "personalspace", login: null, state: "absent" }],
    })?.items,
  ).toEqual([{ kind: "personalspace", login: null, state: "absent" }]);
});

test("the list refuses another shape as a whole", () => {
  for (const value of [
    null,
    [],
    "content",
    { allowed: "yes", items: [] },
    { allowed: true },
    {
      allowed: true,
      items: [{ kind: "organization", login: "-x", state: "absent" }],
    },
    {
      allowed: true,
      items: [{ kind: "organization", login: "x", state: "gone" }],
    },
    {
      allowed: true,
      items: [{ kind: "personalspace", login: 7, state: "absent" }],
    },
    { allowed: true, items: ["example"] },
  ])
    expect([value, parseContentList(value)]).toEqual([value, null]);
});

test("an item's name and reason are one line of text", () => {
  const read = parseContentList({
    allowed: true,
    items: [
      {
        kind: "organization",
        login: "example",
        name: "Example\u0007 Company\n",
        state: "blocked",
        reason: "no-access",
      },
    ],
  });
  expect(read?.items[0]).toEqual({
    kind: "organization",
    login: "example",
    name: "Example  Company",
    state: "blocked",
    reason: "no-access",
  });
});

test("a step's item in every form a producer may write", () => {
  expect(parseContentRef({ kind: "organization", login: "Example" })).toEqual({
    kind: "organization",
    login: "Example",
  });
  expect(parseContentRef({ kind: "personalspace", login: "octocat" })).toEqual({
    kind: "personalspace",
    login: "octocat",
  });
  expect(parseContentRef({ kind: "personalspace" })).toEqual({
    kind: "personalspace",
    login: null,
  });
  expect(parseContentRef("personalspace")).toEqual({
    kind: "personalspace",
    login: null,
  });
  expect(parseContentRef("personalspace:octocat")).toEqual({
    kind: "personalspace",
    login: "octocat",
  });
  expect(parseContentRef("organization:example")).toEqual({
    kind: "organization",
    login: "example",
  });
  expect(parseContentRef("example")).toEqual({
    kind: "organization",
    login: "example",
  });
  for (const value of [
    null,
    7,
    "",
    "organization:",
    "organization:-x",
    "a:b:c",
    "team:x",
    { kind: "organization" },
    { kind: "team", login: "x" },
  ])
    expect([value, parseContentRef(value)]).toEqual([value, null]);
});

test("a job: its steps and failure, the detail kept with its lines", () => {
  const job = parseContentJob(failedJob) as ContentJob;
  expect(job.state).toBe("failed");
  expect(job.steps.map((step) => [step.key, step.state])).toEqual([
    ["access", "done"],
    ["root", "done"],
    ["modules", "done"],
    ["preparation", "failed"],
  ]);
  expect(job.steps[3]?.item).toEqual({
    kind: "organization",
    login: "example",
  });
  expect(job.failure).toEqual({
    item: { kind: "organization", login: "example" },
    key: "preparation",
    code: "preparation-failed",
    detail: "bun install in deals failed:\nregistry did not answer",
  });
  expect(parseContentJob(runningJob)?.failure).toBeUndefined();
  for (const value of [
    null,
    { ...runningJob, id: "../x" },
    { ...runningJob, state: "queued" },
    { ...runningJob, steps: [{ item: "example", key: "Root", state: "done" }] },
    {
      ...runningJob,
      steps: [{ item: "example", key: "root", state: "waiting" }],
    },
    { ...runningJob, steps: [{ item: 7, key: "root", state: "done" }] },
    { ...failedJob, failure: { item: "example" } },
    { ...failedJob, failure: "broken" },
  ])
    expect(parseContentJob(value)).toBeNull();
});

test("a detail is bounded, its control characters dropped", () => {
  expect(contentDetail("a\r\nb\u0000c\td")).toBe("a\nbc\td");
  expect(contentDetail("   ")).toBeUndefined();
  expect(contentDetail(7)).toBeUndefined();
  const long = contentDetail("x".repeat(5000)) as string;
  expect([...long].length).toBe(4001);
  expect(long.endsWith("…")).toBe(true);
});

test("the install answer by its status: started, running with its id, refused, failed", () => {
  expect(installAnswer(202, { job: "job-2" })).toEqual({
    kind: "started",
    job: "job-2",
  });
  expect(
    installAnswer(202, { job: { id: "job-2", state: "running" } }),
  ).toEqual({ kind: "started", job: "job-2" });
  expect(installAnswer(409, { error: "running", id: "job-1" })).toEqual({
    kind: "running",
    job: "job-1",
  });
  expect(installAnswer(409, { job: "job-1" })).toEqual({
    kind: "running",
    job: "job-1",
  });
  expect(installAnswer(403, { error: "forbidden", reason: "team" })).toEqual({
    kind: "refused",
    reason: "team",
  });
  expect(installAnswer(403, null)).toEqual({ kind: "refused" });
  expect(installAnswer(202, {})).toEqual({ kind: "failed" });
  expect(installAnswer(409, {})).toEqual({ kind: "failed" });
  expect(installAnswer(500, { job: "job-1" })).toEqual({ kind: "failed" });
  expect(installAnswer(202, { job: "../etc" })).toEqual({ kind: "failed" });
});

test("a ref names a list item: an Organization by its login, any case", () => {
  const [organization, personalspace] = parseContentList(list)?.items ?? [];
  if (!organization || !personalspace) throw new Error("fixture");
  expect(
    refersTo({ kind: "organization", login: "EXAMPLE" }, organization),
  ).toBe(true);
  expect(refersTo({ kind: "organization", login: "other" }, organization)).toBe(
    false,
  );
  expect(refersTo({ kind: "personalspace", login: null }, personalspace)).toBe(
    true,
  );
  expect(refersTo({ kind: "personalspace", login: null }, organization)).toBe(
    false,
  );
});

// A transport that answers from a table and records every request.
function stub(
  answers: Record<string, () => { status: number; value: unknown }>,
) {
  const requests: [string, string, unknown][] = [];
  const transport: ContentTransport = async (method, path, body) => {
    requests.push([method, path, body]);
    const answer = answers[`${method} ${path}`];
    if (answer === undefined)
      return { status: 404, value: { error: "not-found" } };
    return answer();
  };
  return { transport, requests };
}

test("the client lists, installs everything with {} and follows the job to its end", async () => {
  let reads = 0;
  const { transport, requests } = stub({
    "GET /api/content": () => ({ status: 200, value: list }),
    "POST /api/content/install": () => ({
      status: 202,
      value: { job: "job-1" },
    }),
    "GET /api/content/jobs/job-1": () => {
      reads += 1;
      return { status: 200, value: reads < 3 ? runningJob : failedJob };
    },
  });
  const client = createContentClient(transport);
  expect((await client.list())?.items.length).toBe(2);
  expect(await client.install()).toEqual({ kind: "started", job: "job-1" });
  const seen: string[] = [];
  const last = await client.follow("job-1", (job) => seen.push(job.state), {
    wait: async () => {},
  });
  expect(seen).toEqual(["running", "running", "failed"]);
  expect(last?.failure?.key).toBe("preparation");
  expect(requests[1]).toEqual(["POST", "/api/content/install", {}]);
  // Named items go as the request's `items`.
  await client.install([{ kind: "organization", login: "example" }]);
  expect(requests.at(-1)).toEqual([
    "POST",
    "/api/content/install",
    { items: [{ kind: "organization", login: "example" }] },
  ]);
});

test("the client: no route, another shape or a failed request is nothing, never an error", async () => {
  const none = createContentClient(stub({}).transport);
  expect(await none.list()).toBeNull();
  expect(await none.install()).toEqual({ kind: "failed" });
  expect(await none.job("job-1")).toBeNull();
  const broken = createContentClient(async () => {
    throw new Error("offline");
  });
  expect(await broken.list()).toBeNull();
  expect(await broken.install()).toEqual({ kind: "failed" });
  // A job answer for another id is not this job.
  const other = createContentClient(
    stub({
      "GET /api/content/jobs/job-1": () => ({
        status: 200,
        value: { ...runningJob, id: "job-2" },
      }),
    }).transport,
  );
  expect(await other.job("job-1")).toBeNull();
  expect(await other.job("../x")).toBeNull();
  // Following gives up after the job cannot be read a few times in a row.
  let waits = 0;
  expect(
    await other.follow("job-1", () => {}, {
      attempts: 3,
      wait: async () => {
        waits += 1;
      },
    }),
  ).toBeNull();
  expect(waits).toBe(2);
});

test("the client follows a job only while it is wanted", async () => {
  const { transport } = stub({
    "GET /api/content/jobs/job-1": () => ({ status: 200, value: runningJob }),
  });
  let rounds = 0;
  const last = await createContentClient(transport).follow("job-1", () => {}, {
    wait: async () => {},
    stopped: () => ++rounds > 3,
  });
  expect(last?.state).toBe("running");
});
