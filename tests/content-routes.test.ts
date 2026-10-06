import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ContentUsageError, runContentCommand } from "../src/content/cli";
import type { ContentHost } from "../src/content/host";
import { installContent } from "../src/content/install";
import { createContentJobs } from "../src/content/jobs";
import { tryContentLock } from "../src/content/lock";
import {
  createContentRoutes,
  parseInstallBody,
} from "../src/launchpad/content-routes";
import { startLaunchpad } from "../src/launchpad/server";
import type { CliContext } from "../src/update/cli";
import {
  alphaRemotes,
  contentHost,
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
} from "./fixtures/content-world";
import { bindings } from "./fixtures/machine-bindings";
import { writeOwnedFixture as writeFile } from "./fixtures/owned-files";

// The Launchpad's content routes and the CLI over the one core: the fixed
// contract the Launchpad page is built against (`GET /api/content`,
// `POST /api/content/install` → 202/409/403, `GET /api/content/jobs/<id>`),
// one job at a time per Folder, and the CLI's JSON lines and exit codes.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);

let world: World | undefined;
let closing: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await closing?.();
  closing = undefined;
  await world?.close();
  world = undefined;
});

async function launchpad(folder: string, host: ContentHost) {
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    host,
  );
  closing = () => app.close();
  const url = new URL(app.url);
  const headers = {
    Origin: url.origin,
    Authorization: `Bearer ${url.hash.slice(1)}`,
  };
  return {
    get: (path: string) => fetch(new URL(path, url), { headers }),
    post: (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(new URL(path, url), {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          ...extra,
        },
        body: JSON.stringify(body),
      }),
  };
}

async function untilEnded(
  get: (path: string) => Promise<Response>,
  id: string,
) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = (await (await get(`/api/content/jobs/${id}`)).json()) as {
      id: string;
      state: string;
      steps: unknown[];
    };
    if (job.state !== "running") return job;
    await Bun.sleep(25);
  }
  throw new Error("The job did not end");
}

test("the install body is {} or a list of named items", () => {
  expect(parseInstallBody({})).toEqual({});
  expect(
    parseInstallBody({
      items: [
        { kind: "organization", login: "Alpha" },
        { kind: "personalspace" },
      ],
    }),
  ).toEqual({
    items: [
      { kind: "organization", login: "Alpha" },
      { kind: "personalspace" },
    ],
  });
  for (const body of [
    { items: [] },
    { items: [{ kind: "organization" }] },
    { items: [{ kind: "organization", login: "-bad" }] },
    { items: [{ kind: "personalspace", login: "x" }] },
    { items: [{ kind: "module", login: "x" }] },
    { items: "all" },
    { everything: true },
    [],
  ])
    expect(parseInstallBody(body)).toBeNull();
});

posixTest(
  "the Launchpad installs through one job at a time and reports its steps",
  async () => {
    world = await createWorld();
    await remoteRepository(world, "example/example_GEN3", (directory) =>
      writeFile(join(directory, "README.md"), "mine"),
    );
    const folder = await presetFolder(world, "local");
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { github } = stubGitHub(world, {
      repositories: {
        "example/example_GEN3": {
          owner: { login: "example", databaseId: 12345, kind: "User" },
        },
      },
    });
    // The status reads gh's account at once; the job waits at the gate.
    let gated = false;
    const host = contentHost(world, {
      ...github,
      viewer: async () => {
        if (gated) await gate;
        return github.viewer();
      },
    });
    const { get, post } = await launchpad(folder, host);

    const status = await get("/api/content");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      allowed: true,
      items: [
        {
          kind: "personalspace",
          login: "example",
          state: "absent",
          onGitHub: "exists",
        },
      ],
    });

    // No job yet: the newest is not found.
    expect((await get("/api/content/jobs/latest")).status).toBe(404);
    gated = true;
    const started = await post("/api/content/install", {});
    expect(started.status).toBe(202);
    const { job } = (await started.json()) as { job: string };
    expect(job).toMatch(/^[0-9a-f]{32}$/);
    // A second start while the first runs: 409 with the running job's id.
    const busy = await post("/api/content/install", {
      items: [{ kind: "personalspace" }],
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "busy", job });
    const running = (await (await get(`/api/content/jobs/${job}`)).json()) as {
      id: string;
      state: string;
      steps: unknown[];
    };
    expect(running).toEqual({
      id: job,
      state: "running",
      steps: [
        { item: { kind: "personalspace" }, key: "find", state: "running" },
      ],
    });
    // The newest job, for a page that did not start it.
    expect(
      ((await (await get("/api/content/jobs/latest")).json()) as { id: string })
        .id,
    ).toBe(job);
    open();
    expect(await untilEnded(get, job)).toEqual({
      id: job,
      state: "succeeded",
      steps: [
        {
          item: { kind: "personalspace" },
          key: "find",
          state: "done",
          detail: "found example/example_GEN3",
        },
        {
          item: { kind: "personalspace" },
          key: "clone",
          state: "done",
          detail: "cloned into personalspace/example_GEN3",
        },
        {
          item: { kind: "personalspace" },
          key: "check",
          state: "done",
          detail: "checkout of example/example_GEN3",
        },
      ],
    });

    // The Folder's content lock held elsewhere (a terminal's install): 409
    // without a job of this Launchpad.
    const held = await tryContentLock(world.lockDirectory, folder);
    const outside = await post("/api/content/install", {});
    expect(outside.status).toBe(409);
    expect(await outside.json()).toEqual({ error: "busy" });
    await held?.release();

    // Item outside this Environment's kind, malformed bodies and methods.
    expect((await post("/api/content/install", { items: [{}] })).status).toBe(
      400,
    );
    expect(
      (await post("/api/content/install", {}, { "Content-Type": "text/plain" }))
        .status,
    ).toBe(415);
    expect((await get("/api/content/install")).status).toBe(405);
    expect((await post("/api/content", {})).status).toBe(405);
    expect((await get(`/api/content/jobs/${"0".repeat(32)}`)).status).toBe(404);
    // After it ended, still the newest, the same as by its id.
    expect(await (await get("/api/content/jobs/latest")).json()).toEqual(
      await (await get(`/api/content/jobs/${job}`)).json(),
    );
    expect((await post("/api/content/jobs/latest", {})).status).toBe(405);
    expect((await get("/api/content/jobs/not-an-id")).status).toBe(404);
  },
  60_000,
);

posixTest(
  "the newest job stays readable for a reload: jobs.latest() and the reader accessors",
  async () => {
    world = await createWorld();
    await remoteRepository(world, "example/example_GEN3", (directory) =>
      writeFile(join(directory, "README.md"), "mine"),
    );
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, {
      repositories: {
        "example/example_GEN3": {
          owner: { login: "example", databaseId: 12345, kind: "User" },
        },
      },
    });
    const routes = createContentRoutes({
      folder,
      host: () => contentHost(world as World, github),
      headers: {},
    });
    expect(await routes.lastJob()).toBeNull();
    expect(await routes.list()).toEqual({
      allowed: true,
      items: [
        {
          kind: "personalspace",
          login: "example",
          state: "absent",
          onGitHub: "exists",
        },
      ],
    });
    const jobs = createContentJobs({
      folder,
      host: () => contentHost(world as World, github),
    });
    expect(jobs.latest()).toBeUndefined();
    const first = await jobs.start({});
    await jobs.settled();
    const second = await jobs.start({ items: [{ kind: "personalspace" }] });
    await jobs.settled();
    expect(first.kind === "started" && second.kind === "started").toBe(true);
    const latest = jobs.latest();
    expect(latest?.id).toBe(second.kind === "started" ? second.job : "");
    expect(latest?.state).toBe("succeeded");
    expect(latest).toEqual(jobs.get(latest?.id ?? ""));
  },
  30_000,
);

posixTest(
  "the Launchpad refuses content where the Environment's kind does not hold it",
  async () => {
    world = await createWorld();
    const { github } = stubGitHub(world);
    const host = contentHost(world, github);
    const team = await presetFolder(
      world,
      "hosted-organization-team",
      bindings.assignedTeam,
    );
    const teamLaunchpad = await launchpad(team, host);
    expect(await (await teamLaunchpad.get("/api/content")).json()).toEqual({
      allowed: false,
      reason: "prepared-by-hosting",
      items: [],
    });
    const refused = await teamLaunchpad.post("/api/content/install", {});
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "not-allowed",
      reason: "prepared-by-hosting",
    });
    await closing?.();
    closing = undefined;

    const work = await presetFolder(
      world,
      "hosted-organization-personal",
      bindings.organization,
    );
    const workLaunchpad = await launchpad(work, host);
    const personalspace = await workLaunchpad.post("/api/content/install", {
      items: [{ kind: "personalspace" }],
    });
    expect(personalspace.status).toBe(403);
    expect(await personalspace.json()).toEqual({
      error: "not-allowed",
      reason: "not-for-this-environment",
    });
  },
  30_000,
);

posixTest(
  "the Launchpad picks the install's form from the person's live role",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    // The Folder already holds the Organization (installed by an Admin).
    const owner = stubGitHub(world, {
      repositories: {
        "Alpha/alpha_GEN3": {},
        "Alpha/web": {},
        "Alpha/mission-control": {},
        "Alpha/firmware": {},
      },
    });
    await installContent(
      folder,
      {
        items: [{ kind: "organization", login: "Alpha" }],
        roots: { alpha: "Alpha/alpha_GEN3" },
      },
      () => {},
      contentHost(world, owner.github),
    );
    // In the Launchpad, gh works as a member with write on the root: the
    // live role is Builder, and the install is scoped to it.
    const builder = stubGitHub(world, {
      repositories: {
        "Alpha/alpha_GEN3": { permission: "write" },
        "Alpha/web": {},
        "Alpha/mission-control": {},
        "Alpha/firmware": {},
      },
      membership: { kind: "member", state: "active", role: "member" },
    });
    const { get, post } = await launchpad(
      folder,
      contentHost(world, builder.github),
    );
    const started = await post("/api/content/install", {
      items: [{ kind: "organization", login: "Alpha" }],
    });
    expect(started.status).toBe(202);
    const { job } = (await started.json()) as { job: string };
    const ended = (await untilEnded(get, job)) as {
      state: string;
      steps: { key: string; state: string; detail?: string }[];
    };
    expect(ended.state).toBe("succeeded");
    expect(ended.steps.find((step) => step.key === "access")?.detail).toBe(
      "as example (builder, restricted slots excluded); root Alpha/alpha_GEN3",
    );
    expect(
      builder.calls.some(
        (call) =>
          call.kind === "repository" &&
          call.args.join("/").toLowerCase().startsWith("alpha/secret"),
      ),
    ).toBe(false);
  },
  60_000,
);

posixTest(
  "the Launchpad's content routes need the Launchpad's admission",
  async () => {
    world = await createWorld();
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world);
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      contentHost(world, github),
    );
    closing = () => app.close();
    const url = new URL(app.url);
    // No token, or a cross-origin write: refused before any content code.
    expect((await fetch(new URL("/api/content", url))).status).toBe(403);
    const crossOrigin = await fetch(new URL("/api/content/install", url), {
      method: "POST",
      headers: {
        Origin: "http://example.invalid",
        Authorization: `Bearer ${url.hash.slice(1)}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);
  },
);

// ---- CLI ------------------------------------------------------------------

function cliContext(home: string): CliContext {
  return {
    identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
    platform: process.platform,
    env: { HOME: home },
    executable: join(home, "lazurio"),
    hostedFolder: async () => undefined,
  };
}

posixTest(
  "lazurio organization install prints one JSON line per step and the result",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, {
      repositories: {
        "Alpha/alpha_GEN3": {},
        "Alpha/web": {},
        "Alpha/mission-control": {},
        "Alpha/firmware": {},
      },
    });
    const host = contentHost(world, github);
    const lines: string[] = [];
    const code = await runContentCommand(
      [
        "organization",
        "install",
        "Alpha",
        "--root",
        "Alpha/alpha_GEN3",
        "--folder",
        folder,
        "--json",
      ],
      cliContext(world.home),
      (line) => lines.push(line),
      () => host,
    );
    expect(code).toBe(0);
    const parsed = lines.map((line) => JSON.parse(line));
    expect(
      parsed
        .filter((line) => line.kind === "content-step")
        .map((line) => `${line.key}:${line.state}`),
    ).toEqual([
      "access:running",
      "access:done",
      "root:running",
      "root:done",
      "modules:running",
      "modules:done",
      "preparation:running",
      "preparation:done",
      "check:running",
      "check:done",
    ]);
    const result = parsed.at(-1);
    expect(result.kind).toBe("content-install");
    expect(result.state).toBe("succeeded");
    expect(result.items[0].role).toBe("admin");

    // --role narrows the scope to the asserted role GitHub confirms.
    const builder: string[] = [];
    expect(
      await runContentCommand(
        [
          "organization",
          "install",
          "Alpha",
          "--role",
          "builder",
          "--folder",
          folder,
          "--json",
        ],
        cliContext(world.home),
        (line) => builder.push(line),
        () => host,
      ),
    ).toBe(0);
    const scoped = JSON.parse(builder.at(-1) as string);
    expect(scoped.items[0].role).toBe("builder");
    expect(
      scoped.items[0].repositories.find(
        (entry: { path: string }) => entry.path === "workspace/secret",
      ).result,
    ).toBe("excluded_by_role_scope");

    // The bare form is the Admin installation: for an account GitHub does
    // not confirm as an Owner it fails closed (exit 1), even with write.
    const member = stubGitHub(world, {
      repositories: { "Alpha/alpha_GEN3": { permission: "write" } },
      membership: { kind: "member", state: "active", role: "member" },
    });
    const bare: string[] = [];
    expect(
      await runContentCommand(
        ["organization", "install", "Alpha", "--folder", folder, "--json"],
        cliContext(world.home),
        (line) => bare.push(line),
        () => contentHost(world as World, member.github),
      ),
    ).toBe(1);
    expect(JSON.parse(bare.at(-1) as string).failure.code).toBe(
      "role-unverified",
    );
    // Its agent learns there how to name a narrower role.
    expect(JSON.parse(bare.at(-1) as string).failure.detail).toEndWith(
      "without --role this is the Admin installation: name the role GitHub confirms with --role steward, --role builder or --role reader",
    );
    // The same account with --role builder: confirmed by write.
    expect(
      await runContentCommand(
        [
          "organization",
          "install",
          "Alpha",
          "--role",
          "builder",
          "--folder",
          folder,
        ],
        cliContext(world.home),
        () => {},
        () => contentHost(world as World, member.github),
      ),
    ).toBe(0);

    // A Reader: an active member who only reads the root. The Builder
    // form fails closed for that account, --role reader installs.
    const reader = stubGitHub(world, {
      repositories: { "Alpha/alpha_GEN3": { permission: "read" } },
      membership: { kind: "member", state: "active", role: "member" },
    });
    const asBuilder: string[] = [];
    expect(
      await runContentCommand(
        [
          "organization",
          "install",
          "Alpha",
          "--role",
          "builder",
          "--folder",
          folder,
          "--json",
        ],
        cliContext(world.home),
        (line) => asBuilder.push(line),
        () => contentHost(world as World, reader.github),
      ),
    ).toBe(1);
    expect(JSON.parse(asBuilder.at(-1) as string).failure.code).toBe(
      "role-unverified",
    );
    const asReader: string[] = [];
    expect(
      await runContentCommand(
        [
          "organization",
          "install",
          "Alpha",
          "--role",
          "reader",
          "--folder",
          folder,
          "--json",
        ],
        cliContext(world.home),
        (line) => asReader.push(line),
        () => contentHost(world as World, reader.github),
      ),
    ).toBe(0);
    expect(JSON.parse(asReader.at(-1) as string).items[0].role).toBe("reader");

    // An Organization none of whose repositories declares itself the root
    // fails the run (exit 1), with its code.
    const second: string[] = [];
    expect(
      await runContentCommand(
        ["organization", "install", "Beta", "--folder", folder, "--json"],
        cliContext(world.home),
        (line) => second.push(line),
        () => host,
      ),
    ).toBe(1);
    expect(JSON.parse(second.at(-1) as string).failure.code).toBe(
      "root-not-found",
    );
  },
  60_000,
);

posixTest(
  "lazurio personalspace install: usage and not-allowed exit 2",
  async () => {
    world = await createWorld();
    const { github } = stubGitHub(world);
    const host = contentHost(world, github);
    const work = await presetFolder(
      world,
      "hosted-organization-personal",
      bindings.organization,
    );
    const lines: string[] = [];
    expect(
      await runContentCommand(
        ["personalspace", "install", "--folder", work, "--json"],
        cliContext(world.home),
        (line) => lines.push(line),
        () => host,
      ),
    ).toBe(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { kind: "blocked", reason: "not-for-this-environment" },
    ]);
    for (const args of [
      ["organization", "install"],
      ["organization", "install", "-x"],
      ["organization", "install", "Alpha", "--root", "not a repository"],
      ["personalspace", "install", "extra"],
      ["personalspace", "install", "--root", "Alpha/alpha_GEN3"],
      ["personalspace", "install", "--role", "admin"],
      ["personalspace", "install", "--role", "reader"],
      ["organization", "install", "Alpha", "--role", "owner"],
      ["organization", "install", "Alpha", "--role", "Reader"],
      // As the resident CLI: an Admin installs without --role.
      ["organization", "install", "Alpha", "--role", "admin"],
      ["personalspace", "install", "--folder", "relative/Folder"],
    ])
      await expect(
        runContentCommand(
          args,
          cliContext(world.home),
          () => {},
          () => host,
        ),
      ).rejects.toBeInstanceOf(ContentUsageError);
  },
);
