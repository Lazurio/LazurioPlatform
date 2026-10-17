import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { processContentGit } from "../src/content/git";
import type { ContentGitHub } from "../src/content/github";
import { tryContentLock } from "../src/content/lock";
import { provideDataMounts } from "../src/modules/data-mounts";
import { RequiredSlotRefused } from "../src/modules/sibling-origins";
import { runTool } from "../src/tools/status";
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
afterEach(async () => {
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
        env: context.world.gitEnv,
      }),
      lockDirectory: context.world.lockDirectory,
    },
    anonymous: async () => false,
  });
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
