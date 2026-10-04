import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ContentUsageError, runContentCommand } from "../src/content/cli";
import type { ContentHost } from "../src/content/host";
import { tryContentLock } from "../src/content/lock";
import { parseInstallBody } from "../src/launchpad/content-routes";
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
    expect((await get("/api/content/jobs/not-an-id")).status).toBe(404);
  },
  60_000,
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

    // Without --root the open decision fails the run (exit 1), with its code.
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
      "organization-root-needs-decision",
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
