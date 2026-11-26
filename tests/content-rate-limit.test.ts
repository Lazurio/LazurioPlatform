import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentGitHub } from "../src/content/github";
import type { ContentHost } from "../src/content/host";
import { installContent } from "../src/content/install";
import { createContentJobs, withLimitDetails } from "../src/content/jobs";
import { observeLimit, refusedForLimit } from "../src/content/limit-scope";
import type { ContentFailure, ContentStep } from "../src/content/model";
import { verifyOrganizationRole } from "../src/content/role";
import { contentFact, contentView } from "../src/launchpad/content-view";
import { messages } from "../src/launchpad/messages";
import {
  alphaRemotes,
  contentHost,
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
} from "./fixtures/content-world";

// GitHub's rate limit stops an operation, never a run (#1223, Pablo's third
// review of #1224): the cause belongs to the request GitHub refused, inside
// the operation that failed (`observeLimit`). A stop known without the
// limit (no write permission) keeps its own way forward, also when a later
// or an earlier item of the same run hit the limit; the items the limit
// stopped are kept in `waiting`, whatever stop the run shows.

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const alphaReadable = {
  "Alpha/alpha_GEN3": {},
  "Alpha/web": {},
  "Alpha/mission-control": {},
  "Alpha/firmware": {},
  "Alpha/infra": {},
  "Alpha/secret": {},
};

/** The stub's GitHub with some of its requests refused for the rate limit,
 * as the gh adapter notes them from GitHub's answer. */
function limitedGitHub(
  github: ContentGitHub,
  refuse: Readonly<{
    membership?: boolean;
    repositories?: readonly string[];
  }>,
): ContentGitHub {
  return {
    ...github,
    async membership(organization) {
      if (refuse.membership !== true) return github.membership(organization);
      refusedForLimit();
      return { kind: "unavailable" };
    },
    async repository(owner, name) {
      if (!(refuse.repositories ?? []).includes(`${owner}/${name}`))
        return github.repository(owner, name);
      refusedForLimit();
      return { kind: "unavailable" };
    },
  };
}

async function install(
  github: ContentGitHub,
  folder: string,
  items: readonly ("alpha" | "personalspace")[],
) {
  const steps: ContentStep[] = [];
  const result = await installContent(
    folder,
    {
      items: items.map((item) =>
        item === "alpha"
          ? { kind: "organization" as const, login: "Alpha" }
          : { kind: "personalspace" as const },
      ),
      roots: { alpha: "Alpha/alpha_GEN3" },
    },
    (step) => steps.push(step),
    contentHost(world as World, github),
  );
  if (result.kind !== "content-install") throw new Error(result.kind);
  return { steps, result };
}

test("observeLimit sees only its own operation's refusals, and an enclosing one sees them too", async () => {
  const inner = await observeLimit(async () => {
    const refused = await observeLimit(async () => {
      refusedForLimit();
      return "refused";
    });
    const clean = await observeLimit(async () => "clean");
    return [refused, clean];
  });
  expect(inner.limited).toBe(true);
  expect(inner.value.map((entry) => entry.limited)).toEqual([true, false]);
  expect((await observeLimit(async () => 1)).limited).toBe(false);
  // Outside any operation a refusal changes nothing.
  refusedForLimit();
});

test("a role verdict rests on GitHub's silence alone only when nothing known decides it", () => {
  // The membership not answered and the permission unknown: GitHub's
  // silence alone.
  expect(
    verifyOrganizationRole({
      requested: null,
      membership: { kind: "unavailable" },
      rootPermission: null,
    }),
  ).toMatchObject({ kind: "unverified", unanswered: true });
  // Mixed: no write permission is known without the membership, so it is
  // the verdict's own defect.
  const mixed = verifyOrganizationRole({
    requested: null,
    membership: { kind: "unavailable" },
    rootPermission: "read",
  });
  expect(mixed.kind).toBe("unverified");
  expect("unanswered" in mixed).toBe(false);
  // The Organization Admin's form: only the membership decides.
  expect(
    verifyOrganizationRole({
      requested: "organization-admin",
      membership: { kind: "unavailable" },
      rootPermission: "admin",
    }),
  ).toMatchObject({ unanswered: true });
});

posixTest(
  "an Organization's stop for missing write permission keeps its way forward when the Personalspace later hits the limit, which waits alone",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, {
      repositories: {
        ...alphaReadable,
        "Alpha/alpha_GEN3": { permission: "read" },
      },
      membership: { kind: "none" },
    });
    const { result } = await install(
      limitedGitHub(github, { repositories: ["example/example_GEN3"] }),
      folder,
      ["alpha", "personalspace"],
    );
    // Shown: the Organization's own stop, without the limit's cause.
    expect(result.failure).toMatchObject({
      item: { kind: "organization", login: "Alpha" },
      code: "role-unverified",
    });
    expect(result.failure?.cause).toBeUndefined();
    // Not lost: the Personalspace, which the limit stopped, waits.
    expect(result.waiting).toEqual([{ kind: "personalspace" }]);
  },
  60_000,
);

posixTest(
  "the reverse order: the limit stops the Personalspace first, the Organization's unrelated stop after it is still the one shown",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, {
      repositories: {
        ...alphaReadable,
        "Alpha/alpha_GEN3": { permission: "read" },
      },
      membership: { kind: "none" },
    });
    const { result } = await install(
      limitedGitHub(github, { repositories: ["example/example_GEN3"] }),
      folder,
      ["personalspace", "alpha"],
    );
    expect(result.failure).toMatchObject({
      item: { kind: "organization", login: "Alpha" },
      code: "role-unverified",
    });
    expect(result.failure?.cause).toBeUndefined();
    expect(result.waiting).toEqual([{ kind: "personalspace" }]);
  },
  60_000,
);

posixTest(
  "a membership the limit refused beside a known lack of write permission: the stop is the permission's, nothing waits",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, {
      repositories: {
        ...alphaReadable,
        "Alpha/alpha_GEN3": { permission: "read" },
      },
    });
    const { result } = await install(
      limitedGitHub(github, { membership: true }),
      folder,
      ["alpha"],
    );
    expect(result.failure).toMatchObject({ code: "role-unverified" });
    expect(result.failure?.detail).toContain("no write permission");
    expect(result.failure?.cause).toBeUndefined();
    expect(result.waiting).toBeUndefined();
  },
  60_000,
);

posixTest(
  "the limit alone stops the Personalspace: the stop shown carries the cause and waits",
  async () => {
    world = await createWorld();
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world);
    const { result } = await install(
      limitedGitHub(github, { repositories: ["example/example_GEN3"] }),
      folder,
      ["personalspace"],
    );
    expect(result.failure).toMatchObject({
      code: "github-unavailable",
      cause: { kind: "github-rate-limit" },
    });
    expect(result.waiting).toEqual([{ kind: "personalspace" }]);
  },
  60_000,
);

test("the job adds the limit rate_limit names to the stops' cause, asked only where one waits", async () => {
  let asked = 0;
  const host = {
    github: {
      rateLimit: async () => {
        asked += 1;
        return { kind: "hourly" as const, reset: "2026-11-26T10:00:00.000Z" };
      },
    },
  } as unknown as ContentHost;
  const unrelated: ContentFailure = {
    item: { kind: "organization", login: "Alpha" },
    key: "access",
    code: "role-unverified",
    detail: "no write permission",
  };
  expect(await withLimitDetails({ failure: unrelated }, host)).toEqual({
    failure: unrelated,
  });
  expect(asked).toBe(0);
  const cause = {
    kind: "github-rate-limit",
    limit: "hourly",
    reset: "2026-11-26T10:00:00.000Z",
  } as const;
  expect(
    await withLimitDetails(
      { failure: unrelated, waiting: [{ kind: "personalspace" }] },
      host,
    ),
  ).toEqual({
    failure: unrelated,
    waiting: { items: [{ kind: "personalspace" }], cause },
  });
  const limited: ContentFailure = {
    item: { kind: "personalspace" },
    key: "find",
    code: "github-unavailable",
    detail: "GitHub did not answer for the Personalspace repository",
    cause: { kind: "github-rate-limit" },
  };
  expect(
    await withLimitDetails(
      { failure: limited, waiting: [{ kind: "personalspace" }] },
      host,
    ),
  ).toEqual({
    failure: { ...limited, cause },
    waiting: { items: [{ kind: "personalspace" }], cause },
  });
});

// Pablo's review of 0c8f61a1: the partial retry of what the limit stopped
// must not lose an unrelated stop of the run before it, neither after the
// retry succeeds nor after a reload (which reads the latest job).
posixTest(
  "the Organization's unrelated stop survives the Personalspace's retry after the reset, its success and a reload",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    await remoteRepository(world, "example/example_GEN3", (directory) =>
      writeFile(join(directory, "README.md"), "mine"),
    );
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, {
      repositories: {
        ...alphaReadable,
        "Alpha/alpha_GEN3": { permission: "read" },
        "example/example_GEN3": {
          owner: { login: "example", databaseId: 12345, kind: "User" },
        },
      },
      membership: { kind: "none" },
    });
    let limited = true;
    const switching: ContentGitHub = {
      ...github,
      async repository(owner, name) {
        if (limited && `${owner}/${name}` === "example/example_GEN3") {
          refusedForLimit();
          return { kind: "unavailable" };
        }
        return github.repository(owner, name);
      },
    };
    const jobs = createContentJobs({
      folder,
      host: () => contentHost(world as World, switching),
    });
    await jobs.start({
      items: [
        { kind: "organization", login: "Alpha" },
        { kind: "personalspace" },
      ],
      roots: { alpha: "Alpha/alpha_GEN3" },
    });
    await jobs.settled();
    const first = jobs.latest();
    expect(first?.failure).toMatchObject({
      item: { kind: "organization", login: "Alpha" },
      code: "role-unverified",
    });
    expect(first?.failure?.cause).toBeUndefined();
    expect(first?.waiting?.items).toEqual([{ kind: "personalspace" }]);

    // GitHub answers again: the page runs the Personalspace alone.
    limited = false;
    await jobs.start({ items: [{ kind: "personalspace" }] });
    await jobs.settled();
    // A reload reads the latest job: the Organization's stop is still it,
    // with its steps, and nothing waits any more.
    const after = jobs.latest();
    expect(after?.id).not.toBe(first?.id);
    expect(after?.state).toBe("failed");
    expect(after?.failure).toEqual(first?.failure);
    expect(after?.waiting).toBeUndefined();
    expect(
      after?.steps.some(
        (step) =>
          step.item.kind === "organization" &&
          step.state === "failed" &&
          step.code === "role-unverified",
      ),
    ).toBe(true);
    expect(
      after?.steps.some(
        (step) => step.item.kind === "personalspace" && step.state === "failed",
      ),
    ).toBe(false);
    // As the page reads it: the Organization stopped, with its failure.
    const fact = contentFact(
      {
        allowed: true,
        items: [
          {
            kind: "organization",
            login: "Alpha",
            name: "Alpha",
            state: "absent",
          },
          { kind: "personalspace", login: "example", state: "present" },
        ],
      },
      after as never,
    );
    expect(fact).toMatchObject({
      state: "failed",
      item: { kind: "organization", login: "Alpha" },
    });
    // A run of everything starts afresh: nothing is carried into it.
    await jobs.start({
      items: [
        { kind: "organization", login: "Alpha" },
        { kind: "personalspace" },
      ],
      roots: { alpha: "Alpha/alpha_GEN3" },
    });
    await jobs.settled();
    expect(jobs.latest()?.failure?.code).toBe("role-unverified");
  },
  90_000,
);

// Pablo's review of 685afd23: the Organization's unrelated stop shows
// throughout the Personalspace's partial retry: while it runs, and when it
// stops for another reason (an outage), also as a reload reads it.
posixTest(
  "the Organization's unrelated stop shows while the Personalspace's retry runs and when that retry stops for another reason, after a reload too",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, {
      repositories: {
        ...alphaReadable,
        "Alpha/alpha_GEN3": { permission: "read" },
      },
      membership: { kind: "none" },
    });
    let mode: "limited" | "outage" = "limited";
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const switching: ContentGitHub = {
      ...github,
      async repository(owner, name) {
        if (`${owner}/${name}` !== "example/example_GEN3")
          return github.repository(owner, name);
        if (mode === "limited") refusedForLimit();
        // The retry waits here, so the running job can be read.
        else await held;
        return { kind: "unavailable" };
      },
    };
    const jobs = createContentJobs({
      folder,
      host: () => contentHost(world as World, switching),
    });
    await jobs.start({
      items: [
        { kind: "organization", login: "Alpha" },
        { kind: "personalspace" },
      ],
      roots: { alpha: "Alpha/alpha_GEN3" },
    });
    await jobs.settled();
    const first = jobs.latest();
    expect(first?.waiting?.items).toEqual([{ kind: "personalspace" }]);
    const organizationStop = first?.failure;
    expect(organizationStop).toMatchObject({ code: "role-unverified" });

    const cs = messages("cs");
    const list = {
      allowed: true,
      items: [
        {
          kind: "organization" as const,
          login: "Alpha",
          name: "Alpha",
          state: "absent" as const,
        },
        {
          kind: "personalspace" as const,
          login: "example",
          state: "absent" as const,
        },
      ],
    };
    const row = (job: unknown, login: string | null) =>
      contentView(list, job as never, cs, {
        github: "connected",
        blockedBy: null,
      }).rows.find((entry) =>
        login === null
          ? entry.item.kind === "personalspace"
          : entry.item.kind === "organization",
      );

    // The retry after the reset, while it runs: the Organization's row
    // still shows its stop, the Personalspace's row runs.
    mode = "outage";
    await jobs.start({ items: [{ kind: "personalspace" }] });
    const running = jobs.latest();
    expect(running?.state).toBe("running");
    expect(running?.failures).toEqual([organizationStop as ContentFailure]);
    expect(row(running, "Alpha")).toMatchObject({
      status: cs.contentStopped,
    });
    expect(row(running, "Alpha")?.failure?.details).toContain(
      "(role-unverified)",
    );
    expect(row(running, null)?.failure).toBeNull();

    // The retry stops for an outage (no limit): both stops stay, the
    // Organization's first, each on its row, as a reload reads it.
    release();
    await jobs.settled();
    const after = jobs.latest();
    expect(after?.state).toBe("failed");
    expect(after?.failure).toEqual(organizationStop);
    expect(after?.failures?.map((stop) => [stop.item.kind, stop.code])).toEqual(
      [
        ["organization", "role-unverified"],
        ["personalspace", "github-unavailable"],
      ],
    );
    expect(after?.failures?.[1]?.cause).toBeUndefined();
    expect(after?.waiting).toBeUndefined();
    expect(contentFact(list, after as never)).toMatchObject({
      state: "failed",
      item: { kind: "organization", login: "Alpha" },
    });
    expect(row(after, "Alpha")?.failure?.details).toContain(
      "(role-unverified)",
    );
    expect(row(after, null)?.failure?.details).toContain(
      "(github-unavailable)",
    );
    // Nothing of an outage runs by itself; the Organization's stop is
    // carried again by the next partial run.
    await jobs.start({ items: [{ kind: "personalspace" }] });
    release();
    await jobs.settled();
    expect(jobs.latest()?.failure).toEqual(organizationStop);
  },
  90_000,
);

// The page's bundle includes `src/content/github.ts` through the Tools'
// views; the async scope of the limit's operations is the server's alone
// (`limit-scope.ts`). One `new AsyncLocalStorage()` there at load stopped
// the page from drawing in CI.
test("the page's bundle holds no async context of the limit's operations", async () => {
  const built = await Bun.build({
    entrypoints: [new URL("../src/launchpad/ui.ts", import.meta.url).pathname],
    target: "browser",
  });
  expect(built.success).toBe(true);
  const text = (
    await Promise.all(built.outputs.map((output) => output.text()))
  ).join("\n");
  expect(text).not.toMatch(/AsyncLocalStorage|async_hooks/);
}, 60_000);
