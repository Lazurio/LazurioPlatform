import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir as makeDirectory,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentGitHub } from "../src/content/github";
import { tryContentLock } from "../src/content/lock";
import type { SyncEntry, SyncRun } from "../src/content/sync";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  accessCheckAnswer,
  accessCheckFailed,
  accessLine,
  addedNames,
  parseAccessCheck,
  shownModules,
} from "../src/launchpad/access-check";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import { startLaunchpad } from "../src/launchpad/server";
import type { ModuleHost } from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
import type { Catalog } from "../src/organizations/catalog";
import {
  type Slot,
  writeModule,
  writeOrganization,
} from "./fixtures/catalog-folder";
import {
  contentHost,
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
  writeOrganizationRoot,
} from "./fixtures/content-world";
import { organizationWithEntry } from "./fixtures/machine-bindings";
import { writeOwnedFixture as writeFile } from "./fixtures/owned-files";
import { freePort } from "./fixtures/ports";
import { runChild } from "./fixtures/run-child";

// Zkontrolovat přístupy (decision F36's addendum of 2026-11-05): the hourly
// synchronization of one Organization, now, under the same content lock, and
// the answer of what it brought. Real git over bare remotes in a temporary
// world, as tests/content-sync.test.ts has it; synthetic names only.

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
const cs = messages("cs");
const en = messages("en");

let world: World | undefined;
const closing: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  await world?.close();
  world = undefined;
});

const entry = (fields: Partial<SyncEntry>): SyncEntry => ({
  organization: "Alpha",
  root: "organizations/alpha_GEN3",
  path: ".",
  kind: "root",
  branch: "main",
  result: "current",
  at: "2026-11-05T12:00:00.000Z",
  ...fields,
});
const run = (...entries: SyncEntry[]): SyncRun => ({
  kind: "content-sync",
  at: "2026-11-05T12:00:00.000Z",
  organizations: ["Alpha"],
  entries,
});
const module = (path: string, result: SyncEntry["result"], reason?: string) =>
  entry({
    path,
    kind: "module",
    result,
    ...(reason === undefined ? {} : { reason }),
  });

test("the answer of a run: the modules it cloned, nothing new without access, why it did not finish", () => {
  expect(
    accessCheckAnswer(
      run(
        entry({}),
        module("workspace/web", "current"),
        module("workspace/later", "materialized"),
        entry({
          path: "workspace/later/db",
          kind: "data",
          result: "materialized",
        }),
        module("mission-control", "fast-forwarded"),
      ),
    ),
  ).toEqual({
    kind: "access-check",
    state: "checked",
    added: ["workspace/later"],
  });
  // Without access a module stays quietly absent; a checkout with its own
  // work says nothing about access.
  expect(
    accessCheckAnswer(
      run(
        entry({ result: "fast-forwarded" }),
        module("workspace/later", "absent", "repository-denied"),
        module("workspace/web", "blocked", "dirty"),
      ),
    ),
  ).toEqual({ kind: "access-check", state: "checked", added: [] });
  expect(accessCheckAnswer({ kind: "busy" })).toEqual(
    accessCheckFailed("busy"),
  );
  expect(
    accessCheckAnswer({
      kind: "not-allowed",
      reason: "not-for-this-environment",
    }),
  ).toEqual(accessCheckFailed("not-here"));
  for (const [result, reason] of [
    ["unavailable", "github"],
    ["denied", "denied"],
    ["blocked", "blocked"],
    ["failed", "failed"],
  ] as const)
    expect(accessCheckAnswer(run(entry({ result })))).toEqual(
      accessCheckFailed(reason),
    );
  expect(accessCheckAnswer(run())).toEqual(accessCheckFailed("failed"));
  // GitHub silent for a module: unfinished, unless the run brought something.
  expect(
    accessCheckAnswer(run(entry({}), module("workspace/a", "unavailable"))),
  ).toEqual(accessCheckFailed("github"));
  expect(
    accessCheckAnswer(
      run(
        entry({}),
        module("workspace/a", "unavailable"),
        module("workspace/b", "materialized"),
      ),
    ),
  ).toEqual({ kind: "access-check", state: "checked", added: ["workspace/b"] });
});

test("the page reads only the route's answer", () => {
  const checked = {
    kind: "access-check",
    state: "checked",
    added: ["workspace/a"],
  };
  expect(parseAccessCheck(checked)).toEqual(checked as never);
  expect(parseAccessCheck(accessCheckFailed("busy"))).toEqual(
    accessCheckFailed("busy"),
  );
  for (const value of [
    null,
    "x",
    {},
    { kind: "access-check" },
    { kind: "access-check", state: "checked" },
    { kind: "access-check", state: "checked", added: [1] },
    { kind: "access-check", state: "failed", reason: "other" },
    { error: "not-found" },
  ])
    expect(parseAccessCheck(value)).toBeNull();
});

test("what is new: the run's modules by the name Apps shows, and whatever else shows now", () => {
  const catalog = {
    kind: "catalog",
    organizations: [
      {
        forgeLogin: "Alpha",
        modules: [
          { module: "web", path: "workspace/web", name: "Web" },
          { module: "later", path: "workspace/later", absent: true },
        ],
        guests: [
          { module: "shared", path: "workspace/shared", checkedOut: true },
          {
            module: "gone",
            path: "workspace/gone",
            checkedOut: true,
            revoked: true,
          },
          { module: "far", path: "workspace/far", checkedOut: false },
        ],
      },
    ],
  } as unknown as Catalog;
  const shown = shownModules(catalog, "alpha");
  expect([...shown.keys()]).toEqual(["workspace/web", "workspace/shared"]);
  expect(shownModules(null, "alpha").size).toBe(0);
  expect(shownModules(catalog, "beta").size).toBe(0);
  const before = new Map([["workspace/web", "Web"]]);
  // A module of this run, one the hourly run brought while the page stayed
  // open, and a path the catalog does not show yet.
  expect(addedNames(["workspace/plans"], before, shown)).toEqual([
    "plans",
    "shared",
  ]);
  expect(addedNames([], shown, shown)).toEqual([]);
});

test("the line says the concept's words in both languages, with the reason", () => {
  const checked = {
    kind: "access-check",
    state: "checked",
    added: [],
  } as const;
  expect(accessLine(checked, ["Zakázky"], cs)).toEqual({
    text: "Přibyl modul Zakázky.",
    tone: "success",
  });
  expect(accessLine(checked, ["Zakázky", "Web"], cs).text).toBe(
    "Přibyly moduly Zakázky, Web.",
  );
  expect(accessLine(checked, ["Orders"], en).text).toBe("New module: Orders.");
  expect(accessLine(checked, ["Orders", "Web"], en).text).toBe(
    "New modules: Orders, Web.",
  );
  expect(accessLine(checked, [], cs)).toEqual({
    text: "Nic nového. Přístup k modulu uděluje Admin Organizace.",
    tone: "quiet",
  });
  expect(accessLine(checked, [], en).text).toBe(
    "Nothing new. The Organization Admin grants access to modules.",
  );
  expect(accessLine(accessCheckFailed("github"), [], cs)).toEqual({
    text: "Přístupy se nepodařilo zkontrolovat. GitHub teď neodpovídá.",
    tone: "warning",
  });
  expect(accessLine(null, [], en).text).toBe(
    "Couldn't check access. Try again.",
  );
  expect(accessLine(accessCheckFailed("busy"), [], en).text).toStartWith(
    "Couldn't check access. Lazurio is downloading",
  );
  expect(cs.accessHourly).toBe("Lazurio to kontroluje samo každou hodinu.");
  expect(en.accessHourly).toBe("Lazurio also checks every hour.");
});

const slot = (path: string, repository: string): Slot => ({
  path,
  slug: path.split("/").at(-1) as string,
  git: { url: `git@github.com:${repository}.git`, branch: "main" },
});

async function clone(current: World, repository: string, path: string) {
  const result = await runChild(
    ["git", "clone", "--quiet", `git@github.com:${repository}.git`, path],
    {
      cwd: current.root,
      env: {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        HOME: current.home,
        ...current.gitEnv,
      },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

/** The Organization `alpha` (login `Alpha`) in a workstation Folder with its
 * module `web`, and `later` declared, which this identity cannot read until
 * `grant`, under an installed Launchpad whose module host builds nothing, so
 * no sweep of its own synchronizes. */
async function installedLaunchpad(current: World) {
  await remoteRepository(current, "Alpha/alpha_GEN3", async (directory) => {
    await writeOrganizationRoot(directory, {
      slug: "alpha",
      forge: "Alpha",
      slots: [
        slot("workspace/web", "Alpha/web"),
        slot("workspace/later", "Alpha/later"),
      ],
      root: "Alpha/alpha_GEN3",
    });
    await writeFile(join(directory, ".gitignore"), "workspace/\n.worktrees/\n");
  });
  for (const name of ["web", "later"])
    await remoteRepository(current, `Alpha/${name}`, (directory) =>
      writeModule(directory, "alpha", { id: name }),
    );
  const folder = await presetFolder(current, "local");
  const root = join(folder, "organizations", "alpha_GEN3");
  await clone(current, "Alpha/alpha_GEN3", root);
  await clone(current, "Alpha/web", join(root, "workspace", "web"));
  const denied = stubGitHub(current).github;
  const allowed = stubGitHub(current, {
    repositories: { "Alpha/later": {} },
  }).github;
  let granted = false;
  const github = new Proxy(denied, {
    get: (_, key) => (granted ? allowed : denied)[key as keyof ContentGitHub],
  });
  const moduleHost: ModuleHost = {
    platform: process.platform,
    home: current.root,
    path: "/usr/bin:/bin",
    runtimeDirectory: undefined,
    platformExecutable: process.execPath,
    runnerKind: async () => "session",
    createRunner: () => createSessionRunner(process.execPath),
    readJournal: async () => ({ kind: "unavailable" }),
  };
  // Where an installed Launchpad answers the updater's health question.
  await makeDirectory(join(current.home, "base", "update"), {
    recursive: true,
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    { base: join(current.home, "base"), version: "1.0.0" },
    {},
    {
      path: current.root,
      home: current.root,
      platform: process.platform,
      run: async () => "timeout",
    },
    {},
    undefined,
    moduleHost,
    undefined,
    contentHost(current, github),
  );
  closing.push(() => app.close());
  const url = new URL(app.url);
  const check = (
    organization = "alpha",
    body = "{}",
    token = url.hash.slice(1),
  ) =>
    fetch(new URL(`/api/organizations/${organization}/sync`, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${token}`,
      },
      body,
    });
  return {
    folder,
    at: (path: string) => join(root, path),
    check,
    grant() {
      granted = true;
    },
  };
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

posixTest(
  "POST /api/organizations/<org>/sync: nothing new until GitHub grants the module, then the module it cloned, once",
  async () => {
    world = await createWorld();
    const launchpad = await installedLaunchpad(world);
    const checked = async () => {
      const answer = await launchpad.check();
      expect(answer.status).toBe(200);
      return answer.json();
    };
    expect(await checked()).toEqual({
      kind: "access-check",
      state: "checked",
      added: [],
    });
    expect(await exists(launchpad.at("workspace/later"))).toBe(false);
    launchpad.grant();
    expect(await checked()).toEqual({
      kind: "access-check",
      state: "checked",
      added: ["workspace/later"],
    });
    expect(await exists(launchpad.at("workspace/later/.git"))).toBe(true);
    expect(await checked()).toEqual({
      kind: "access-check",
      state: "checked",
      added: [],
    });
  },
  30_000,
);

posixTest(
  "POST /api/organizations/<org>/sync: a run under way holds the lock and the answer says so; the admission of every write",
  async () => {
    world = await createWorld();
    const launchpad = await installedLaunchpad(world);
    const lock = await tryContentLock(world.lockDirectory, launchpad.folder);
    if (lock === null) throw new Error("Nothing runs now");
    try {
      const busy = await launchpad.check();
      expect([busy.status, await busy.json()]).toEqual([
        200,
        accessCheckFailed("busy"),
      ]);
    } finally {
      await lock.release();
    }
    expect((await launchpad.check("other")).status).toBe(404);
    expect((await launchpad.check("alpha", '{"extra":1}')).status).toBe(400);
    expect((await launchpad.check("alpha", "{}", "wrong")).status).toBe(403);
  },
  30_000,
);

posixTest(
  "a Launchpad that is not installed runs no check; on a Team Environment none either, and a public one answers as absent",
  async () => {
    world = await createWorld();
    const current = world;
    const hosted = async (
      options: Readonly<{
        team?: boolean;
        audience?: boolean;
        installed: boolean;
      }>,
    ) => {
      const parent = await realpath(
        await mkdtemp(join(tmpdir(), "launchpad-access-")),
      );
      closing.push(() => rm(parent, { recursive: true, force: true }));
      const folder = join(parent, "Lazurio");
      await makeDirectory(folder, { mode: 0o700 });
      await makeDirectory(join(folder, "organizations"), { mode: 0o755 });
      const preset = options.team
        ? "hosted-organization-team"
        : "hosted-organization-personal";
      const machine = organizationWithEntry(
        freePort(),
        "vm-01.example.lazurio.io",
        true,
        true,
        options.audience === true,
        options.team ? "team" : null,
      );
      const place = machine.entry;
      if (place === undefined) throw new Error("The fixture has an entry");
      if (!options.team)
        await makeDirectory(join(folder, "personalspace"), { mode: 0o700 });
      await writeOrganization(folder, "example_GEN3", {
        slug: "example",
        state: "current",
        forge: "Example-Org",
        modules: [{ id: "deals" }],
      });
      await initializeHandoverFolder(folder, {
        preset,
        machine,
        profile: presetProfile(preset, executionOs(process.platform), {
          locale: "cs",
        }),
      });
      await makeDirectory(join(parent, "base", "update"), { recursive: true });
      const fetcher: AuthFetcher = async () => new Response("ok");
      const app = await startLaunchpad(
        folder,
        undefined,
        undefined,
        options.installed
          ? {
              base: join(parent, "base"),
              version: "1.0.0",
            }
          : undefined,
        { fetcher },
        {
          path: parent,
          home: parent,
          platform: process.platform,
          run: async () => "timeout",
        },
        {},
        undefined,
        undefined,
        undefined,
        contentHost(current, stubGitHub(current).github),
      );
      closing.unshift(() => app.close());
      const host = new URL(place.externalOrigin).host;
      return fetch(
        `http://127.0.0.1:${place.listenPort}/api/organizations/example/sync`,
        {
          method: "POST",
          headers: {
            host,
            cookie: "__Secure-lazurio-workspace=valid",
            origin: place.externalOrigin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
    };
    const plain = await hosted({ installed: false });
    expect([plain.status, await plain.json()]).toEqual([
      200,
      accessCheckFailed("not-here"),
    ]);
    const team = await hosted({ team: true, installed: true });
    expect([team.status, await team.json()]).toEqual([
      200,
      accessCheckFailed("not-here"),
    ]);
    const open = await hosted({ audience: true, installed: true });
    expect([open.status, await open.json()]).toEqual([
      404,
      { error: "not-found" },
    ]);
  },
  60_000,
);
