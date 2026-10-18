import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { processContentGit } from "../src/content/git";
import { type ContentGitHub, ghContentGitHub } from "../src/content/github";
import { tryContentLock } from "../src/content/lock";
import { provideDataMounts } from "../src/modules/data-mounts";
import { RequiredSlotRefused } from "../src/modules/sibling-origins";
import { runTool } from "../src/tools/status";
import { type BrokeredGh, brokeredGh } from "./fixtures/brokered-gh";
import { type Slot, writeOrganization } from "./fixtures/catalog-folder";
import {
  checkoutWithOrigin,
  createWorld,
  remoteRepository,
  type StubCalls,
  stubGitHub,
  type World,
} from "./fixtures/content-world";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

// A module provides its own data mount at its preparation (launchpad-parity
// B7, amended 2026-10-17): the repository database the Organization declares
// directly below it (`materialization: "repository_db_mount"`) is cloned on
// its declared branch when absent, only verified when present, and every
// failure refuses the start with a typed reason and the slot. The consumer
// is an `orders` module whose data live in `example-org/orders-data` on
// `v3`. Real git over local bare repositories, a stub GitHub, synthetic names
// only.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

let world: World | undefined;
// The local servers a test started (a stand-in for github.com).
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await world?.close();
  world = undefined;
});

const dataSlot = (
  module: string,
  branch = "v3",
  repository = `example-org/${module}-data`,
): Slot => ({
  path: `workspace/${module}/db`,
  slug: `${module}-data`,
  source_of_truth: "repository-db:v3",
  status: "active",
  materialization: "repository_db_mount",
  repository_db: {
    repo: repository,
    url: `git@github.com:${repository}.git`,
    branch,
  },
  git: { url: `git@github.com:${repository}.git`, branch },
});

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const childEnv = () => ({ PATH: Bun.env.PATH ?? "/usr/bin:/bin" });

async function git(directory: string, ...args: string[]) {
  const result = await runChild(["git", "-C", directory, ...args], {
    env: { ...childEnv(), HOME: directory },
  });
  return result.stdout.trim();
}

/** The world with `example-org`: `orders` with its data mount on `v3`,
 * `catalog` without one and `stock`, whose data mount is declared too. */
async function setup(slots: Slot[] = [dataSlot("orders"), dataSlot("stock")]) {
  world = await createWorld();
  const folder = join(await realpath(world.root), "Lazurio");
  await mkdir(join(folder, "organizations"), { recursive: true });
  const organization = await writeOrganization(folder, "example-org", {
    slug: "example-org",
    state: "current",
    modules: [{ id: "orders" }, { id: "catalog" }, { id: "stock" }],
    slots,
  });
  await remoteRepository(
    world,
    "example-org/orders-data",
    (directory) => writeFile(join(directory, "README.md"), "orders data"),
    "v3",
  );
  return { world, folder, organization };
}

function provide(
  context: Awaited<ReturnType<typeof setup>>,
  github: ContentGitHub,
  module = "orders",
  gitEnv: Readonly<Record<string, string>> = context.world.gitEnv,
) {
  return provideDataMounts({
    folder: context.folder,
    organizationDirectory: context.organization,
    moduleDirectory: join(context.organization, "workspace", module),
    host: {
      github,
      git: processContentGit({
        path: Bun.env.PATH,
        home: context.world.home,
        platform: process.platform,
        run: runTool,
        env: gitEnv,
      }),
      lockDirectory: context.world.lockDirectory,
    },
    anonymous: async () => false,
  });
}

/** github.com for a Team Environment's clone in a test: the world's bare
 * repositories over Git's dumb HTTP from a local server that answers 401 to
 * any request without the credential `broker` gives for exactly that
 * repository, as GitHub answers a private repository. */
async function privateGitHub(target: World, broker: BrokeredGh) {
  for (const owner of await readdir(target.remotes))
    for (const name of await readdir(join(target.remotes, owner)))
      if (name.endsWith(".git"))
        await runChild(
          [
            "git",
            "--git-dir",
            join(target.remotes, owner, name),
            "update-server-info",
          ],
          { env: childEnv() },
        );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const repository = /^\/([^/]+\/[^/]+)\.git\//.exec(path)?.[1];
      const { user, password } = broker.credential(repository ?? "");
      if (
        repository === undefined ||
        request.headers.get("authorization") !==
          `Basic ${btoa(`${user}:${password}`)}`
      )
        return new Response("", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="GitHub"' },
        });
      const file = resolve(target.remotes, `.${path}`);
      const body = Bun.file(file);
      return file.startsWith(`${target.remotes}/`) && (await body.exists())
        ? new Response(body)
        : new Response("", { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

/** A Team Environment as Machines sets it up (#488): the brokered gh first
 * on the PATH, and git's own configuration, a system one there, with the
 * broker's credential helper and `useHttpPath`; here github.com is the
 * local stand-in. Nothing else of the test's Machine reaches git. */
async function teamEnvironment(context: Awaited<ReturnType<typeof setup>>) {
  const broker = await brokeredGh(context.world.root);
  const origin = await privateGitHub(context.world, broker);
  const github = ghContentGitHub({
    path: `${broker.bin}:${Bun.env.PATH ?? "/usr/bin:/bin"}`,
    home: context.world.home,
    platform: process.platform,
    run: runTool,
  });
  const gitEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: broker.helper,
    GIT_CONFIG_KEY_1: "credential.useHttpPath",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: `url.${origin}/.insteadOf`,
    GIT_CONFIG_VALUE_2: "https://github.com/",
  };
  return { broker, github, gitEnv };
}

async function refusal(promise: Promise<void>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RequiredSlotRefused)
      return { reason: error.reason, slot: error.slot };
    throw error;
  }
  return null;
}

const asked = (calls: StubCalls) =>
  calls.filter((call) => call.kind === "repository").map((call) => call.args);

const leftovers = async (directory: string) =>
  (await readdir(directory)).filter((name) =>
    name.includes(".lazurio-content-"),
  );

posixTest(
  "absent: the module's data mount is cloned on its declared branch; present and correct, it is left exactly as it is",
  async () => {
    const context = await setup();
    const { github, calls } = stubGitHub(context.world, {
      repositories: { "example-org/orders-data": {} },
    });
    expect(await refusal(provide(context, github))).toBeNull();
    const orders = join(context.organization, "workspace", "orders");
    const db = join(orders, "db");
    expect(await git(db, "symbolic-ref", "--short", "HEAD")).toBe("v3");
    expect(await readFile(join(db, "README.md"), "utf8")).toBe("orders data");
    // Only this module's mount: the declared `stock/db` is not provided.
    expect(asked(calls)).toEqual([["example-org", "orders-data"]]);
    expect(
      await exists(join(context.organization, "workspace", "stock", "db")),
    ).toBe(false);
    expect(await leftovers(orders)).toEqual([]);
    // Present: a person's unpublished draft stays, a newer commit on the
    // remote is not fetched, and GitHub is not asked again.
    const head = await git(db, "rev-parse", "HEAD");
    await writeFile(join(db, "draft.json"), "{}");
    await rm(join(context.world.remotes, "example-org", "orders-data.git"), {
      recursive: true,
      force: true,
    });
    await remoteRepository(
      context.world,
      "example-org/orders-data",
      (directory) => writeFile(join(directory, "README.md"), "newer"),
      "v3",
    );
    expect(await refusal(provide(context, github))).toBeNull();
    expect(await git(db, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(db, "draft.json"), "utf8")).toBe("{}");
    expect(await readFile(join(db, "README.md"), "utf8")).toBe("orders data");
    expect(asked(calls)).toHaveLength(1);
  },
  60_000,
);

posixTest(
  "a module without a declared data mount provides nothing and asks GitHub nothing",
  async () => {
    const context = await setup();
    const { github, calls } = stubGitHub(context.world);
    expect(await refusal(provide(context, github, "catalog"))).toBeNull();
    expect(calls).toEqual([]);
  },
);

posixTest(
  "a checkout already at the place starts as it is, whatever its origin or branch, and is never touched",
  async () => {
    const context = await setup();
    const { github, calls } = stubGitHub(context.world, {
      repositories: { "example-org/orders-data": {} },
    });
    const db = join(context.organization, "workspace", "orders", "db");
    // Another repository's checkout.
    await checkoutWithOrigin(db, "example-org/other-data");
    const head = await git(db, "rev-parse", "HEAD");
    expect(await refusal(provide(context, github))).toBeNull();
    expect(await git(db, "remote", "get-url", "origin")).toBe(
      "git@github.com:example-org/other-data.git",
    );
    expect(await git(db, "rev-parse", "HEAD")).toBe(head);
    await rm(db, { recursive: true, force: true });
    // The declared repository, on another branch than the declared one.
    await checkoutWithOrigin(db, "example-org/orders-data");
    const branch = await git(db, "symbolic-ref", "--short", "HEAD");
    expect(branch).not.toBe("v3");
    expect(await refusal(provide(context, github))).toBeNull();
    expect(await git(db, "symbolic-ref", "--short", "HEAD")).toBe(branch);
    // GitHub is never asked about a present checkout.
    expect(asked(calls)).toEqual([]);
  },
  60_000,
);

posixTest(
  "a checkout another start or install publishes while this one asks GitHub starts as it is, whatever GitHub then answers and with the content lock held (review of #476)",
  async () => {
    const context = await setup();
    const db = join(context.organization, "workspace", "orders", "db");
    // GitHub answers only after someone else published the mount: readable,
    // denied or not answering, for the declared repository or another one,
    // with the lock free or held; none of them refuses the start.
    const answers = {
      readable: { "example-org/orders-data": {} },
      denied: {},
      unavailable: { "example-org/orders-data": "unavailable" },
    } as const;
    for (const [origin, answer, lockHeld] of [
      ["example-org/orders-data", "readable", false],
      ["example-org/other-data", "readable", false],
      ["example-org/orders-data", "readable", true],
      ["example-org/orders-data", "denied", false],
      ["example-org/other-data", "denied", false],
      ["example-org/orders-data", "unavailable", false],
      ["example-org/other-data", "unavailable", false],
    ] as const) {
      const { github } = stubGitHub(context.world, {
        repositories: answers[answer],
      });
      const racing: ContentGitHub = {
        ...github,
        repository: async (owner, name) => {
          await checkoutWithOrigin(db, origin);
          return github.repository(owner, name);
        },
      };
      const lock = lockHeld
        ? await tryContentLock(context.world.lockDirectory, context.folder)
        : null;
      try {
        expect(await refusal(provide(context, racing))).toBeNull();
      } finally {
        await lock?.release();
      }
      expect(await git(db, "remote", "get-url", "origin")).toBe(
        `git@github.com:${origin}.git`,
      );
      expect(await git(db, "log", "--format=%s")).toBe("fixture");
      await rm(db, { recursive: true, force: true });
    }
  },
  60_000,
);

posixTest(
  "an empty directory at the place is filled; a directory with files, a file or a link is never touched",
  async () => {
    const context = await setup();
    const { github, calls } = stubGitHub(context.world, {
      repositories: { "example-org/orders-data": {} },
    });
    const orders = join(context.organization, "workspace", "orders");
    const db = join(orders, "db");
    const occupied = {
      reason: "data-mount-occupied",
      slot: "workspace/orders/db",
    } as const;
    // A directory with someone's files.
    await mkdir(db);
    await writeFile(join(db, "notes.txt"), "kept");
    expect(await refusal(provide(context, github))).toEqual(occupied);
    expect(await readdir(db)).toEqual(["notes.txt"]);
    await rm(db, { recursive: true, force: true });
    // A file, and a link to an empty directory elsewhere.
    await writeFile(db, "a file");
    expect(await refusal(provide(context, github))).toEqual(occupied);
    expect(await readFile(db, "utf8")).toBe("a file");
    await rm(db);
    const elsewhere = join(context.world.root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, db);
    expect(await refusal(provide(context, github))).toEqual(occupied);
    expect((await lstat(db)).isSymbolicLink()).toBe(true);
    expect(await readdir(elsewhere)).toEqual([]);
    await rm(db);
    // GitHub is never asked about an occupied place.
    expect(asked(calls)).toEqual([]);
    // An empty directory counts as absent: cloned on `v3` into its place.
    await mkdir(db);
    expect(await refusal(provide(context, github))).toBeNull();
    expect(await git(db, "symbolic-ref", "--short", "HEAD")).toBe("v3");
    expect(await readFile(join(db, "README.md"), "utf8")).toBe("orders data");
    expect(await leftovers(orders)).toEqual([]);
  },
  60_000,
);

posixTest(
  "no access, GitHub not answering, or the content lock held refuse the start and create nothing; the next start provides it",
  async () => {
    const context = await setup();
    const db = join(context.organization, "workspace", "orders", "db");
    const denied = stubGitHub(context.world).github;
    expect(await refusal(provide(context, denied))).toEqual({
      reason: "data-mount-denied",
      slot: "workspace/orders/db",
    });
    const unavailable = stubGitHub(context.world, {
      repositories: { "example-org/orders-data": "unavailable" },
    }).github;
    expect(await refusal(provide(context, unavailable))).toEqual({
      reason: "data-mount-unavailable",
      slot: "workspace/orders/db",
    });
    const readable = stubGitHub(context.world, {
      repositories: { "example-org/orders-data": {} },
    }).github;
    // An install or a module being created holds the Folder's content lock.
    const lock = await tryContentLock(
      context.world.lockDirectory,
      context.folder,
    );
    expect(lock).not.toBeNull();
    try {
      expect(await refusal(provide(context, readable))).toEqual({
        reason: "data-mount-unavailable",
        slot: "workspace/orders/db",
      });
    } finally {
      await lock?.release();
    }
    expect(await exists(db)).toBe(false);
    expect(await refusal(provide(context, readable))).toBeNull();
    expect(await git(db, "symbolic-ref", "--short", "HEAD")).toBe("v3");
  },
  60_000,
);

posixTest(
  "a remote without the declared branch, or an empty one, fails the clone and is never bootstrapped",
  async () => {
    const context = await setup([
      dataSlot("orders", "v4"),
      dataSlot("stock", "v3", "example-org/stock-data"),
    ]);
    // `stock-data` exists on GitHub but holds no commit at all.
    const empty = join(context.world.remotes, "example-org", "stock-data.git");
    await runChild(["git", "init", "--quiet", "--bare", empty], {
      env: childEnv(),
    });
    const { github } = stubGitHub(context.world, {
      repositories: {
        "example-org/orders-data": {},
        "example-org/stock-data": {},
      },
    });
    for (const module of ["orders", "stock"]) {
      expect(await refusal(provide(context, github, module))).toEqual({
        reason: "data-mount-clone-failed",
        slot: `workspace/${module}/db`,
      });
      const parent = join(context.organization, "workspace", module);
      expect(await exists(join(parent, "db"))).toBe(false);
      expect(await leftovers(parent)).toEqual([]);
    }
    // Nothing was pushed anywhere: the empty remote stays empty.
    const refs = await runChild(["git", "--git-dir", empty, "for-each-ref"], {
      env: childEnv(),
    });
    expect(refs.stdout.trim()).toBe("");
  },
  60_000,
);

posixTest(
  "a Team Environment provides an absent private data mount through its brokered gh: the repository named to gh, git's configured helper answering for exactly it (#488)",
  async () => {
    const context = await setup();
    const { broker, github, gitEnv } = await teamEnvironment(context);
    await broker.grant("example-org/orders-data");
    expect(
      await refusal(provide(context, github, "orders", gitEnv)),
    ).toBeNull();
    const db = join(context.organization, "workspace", "orders", "db");
    expect(await git(db, "symbolic-ref", "--short", "HEAD")).toBe("v3");
    expect(await readFile(join(db, "README.md"), "utf8")).toBe("orders data");
    expect(await git(db, "remote", "get-url", "origin")).toBe(
      "https://github.com/example-org/orders-data.git",
    );
    const calls = await broker.calls();
    // The readability check names the repository and runs outside any
    // checkout; only the one `gh auth` command the adapter answers is used,
    // never `gh auth git-credential`.
    expect(calls).toContain(
      "/\texample-org/orders-data\tapi repos/example-org/orders-data",
    );
    expect(calls.every((call) => call.startsWith("/\t"))).toBe(true);
    expect(
      calls
        .map((call) => call.split("\t")[2] as string)
        .filter((args) => args.startsWith("auth")),
    ).toEqual(["auth status --json hosts", "auth status --json hosts"]);
    // git asked its configured helper for exactly this repository.
    expect(
      (await broker.helperCalls()).filter((call) => call.startsWith("get")),
    ).toEqual(["get\texample-org/orders-data.git"]);
  },
  60_000,
);

posixTest(
  "on a Team Environment a data repository the Team has no grant on is data-mount-denied, and a broker that does not answer is data-mount-unavailable; nothing is cloned (#488)",
  async () => {
    const context = await setup();
    const { broker, github, gitEnv } = await teamEnvironment(context);
    const db = join(context.organization, "workspace", "orders", "db");
    // The broker refuses a repository of no grant of the Team.
    await broker.grant("example-org/stock-data");
    expect(await refusal(provide(context, github, "orders", gitEnv))).toEqual({
      reason: "data-mount-denied",
      slot: "workspace/orders/db",
    });
    // The broker not reachable is GitHub not answering now.
    await broker.grant("example-org/orders-data");
    await broker.broker("down");
    expect(await refusal(provide(context, github, "orders", gitEnv))).toEqual({
      reason: "data-mount-unavailable",
      slot: "workspace/orders/db",
    });
    expect(await exists(db)).toBe(false);
    expect(await broker.helperCalls()).toEqual([]);
    // Once it answers, the next start provides it.
    await broker.broker("up");
    expect(
      await refusal(provide(context, github, "orders", gitEnv)),
    ).toBeNull();
    expect(await git(db, "symbolic-ref", "--short", "HEAD")).toBe("v3");
  },
  60_000,
);
