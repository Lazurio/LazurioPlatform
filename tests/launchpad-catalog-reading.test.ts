import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CatalogReading,
  catalogKeptMs,
  catalogUnwatchedKeptMs,
  createCatalogReading,
  type DirectoryWatch,
  organizationsOnly,
} from "../src/launchpad/catalog-reading";
import type { Catalog } from "../src/organizations/catalog";
import {
  type PersonalspaceHolder,
  unverifiedPersonalspace,
} from "../src/organizations/personalspace";
import { folderFixture } from "./fixtures/catalog-folder";

// The Launchpad's reading of the Folder's catalog (plan DEV-6656): kept while
// nothing it depends on changed, as a watch of its directories tells; read
// anew after a change seen there, a change through the Launchpad (`forget`),
// another decision whose Personalspace this is, or a change while it ran; a
// kept reading older than a minute answers once more while it is read anew;
// where the Folder cannot be watched it is kept only a moment.

const folder = "/folder";

function catalogOf(directories: string[]): Catalog {
  return {
    kind: "catalog",
    organizations: directories.map((directory) => ({
      directory,
      organization: directory,
      displayName: directory,
      state: "current",
      issues: [],
      executable: true,
      teams: [],
      modules: [
        {
          organization: directory,
          module: "web",
          path: "workspace/web",
          teams: ["workspace"],
          teamsSource: "default",
          apps: [{ package: "app/package.json", kind: "runtime-declared" }],
          defaultApp: "app/package.json",
          state: "current",
          executable: true,
        },
      ],
      repositories: [
        {
          slug: "firmware",
          path: "productionspace/firmware",
          checkedOut: true,
          url: null,
        },
      ],
    })),
  };
}

function world(
  options: Readonly<{
    watch?: "fake" | "none" | "refusing";
    watchLimit?: number;
  }> = {},
) {
  let clock = 1_000_000;
  let decided: PersonalspaceHolder = { kind: "absent" };
  const readings: Array<{
    answer: (catalog: Catalog) => void;
    fail: (error: Error) => void;
    decided: PersonalspaceHolder;
  }> = [];
  const watched = new Map<
    string,
    { changed: () => void; lost: () => void; closed: boolean }
  >();
  // Every watch ever made, a replaced one included.
  const made: Array<{
    directory: string;
    changed: () => void;
    lost: () => void;
    entry: { closed: boolean };
  }> = [];
  const watch: DirectoryWatch = (directory, changed, lost) => {
    if (options.watch === "refusing" && directory.endsWith("workspace"))
      throw Object.assign(new Error("no"), { code: "EACCES" });
    if (directory.includes("missing"))
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    const entry = { changed, lost, closed: false };
    watched.set(directory, entry);
    made.push({ directory, ...entry, entry });
    return {
      close() {
        entry.closed = true;
      },
    };
  };
  const reading: CatalogReading = createCatalogReading(folder, {
    holder: async () => decided,
    now: () => clock,
    watch: options.watch === "none" ? null : watch,
    ...(options.watchLimit === undefined
      ? {}
      : { watchLimit: options.watchLimit }),
    read: (_folder, holder) =>
      new Promise<Catalog>((resolve, reject) => {
        void holder(folder).then((asked) =>
          readings.push({ answer: resolve, fail: reject, decided: asked }),
        );
      }),
  });
  return {
    reading,
    readings,
    watched,
    made,
    reads: () => readings.length,
    later(ms: number) {
      clock += ms;
    },
    decide(next: PersonalspaceHolder) {
      decided = next;
    },
    /** The last reading started answers. */
    async answer(catalog: Catalog) {
      await Bun.sleep(0);
      readings.at(-1)?.answer(catalog);
      await Bun.sleep(0);
    },
    /** A change of an entry in a watched directory. */
    change(directory: string) {
      const entry = watched.get(directory);
      if (entry === undefined || entry.closed)
        throw new Error(`${directory} is not watched`);
      entry.changed();
    },
  };
}

// One reading, answered; the next read answers from it while settled.
async function settledWorld(
  options: Parameters<typeof world>[0] = {},
  catalog = catalogOf(["alpha"]),
) {
  const w = world(options);
  const first = w.reading.read();
  await w.answer(catalog);
  await first;
  // The first reading found every directory for the first time: the read
  // after it answers and reads anew behind it, and that one is settled.
  expect(await w.reading.read()).toBe(catalog);
  await w.answer(catalog);
  return { ...w, catalog };
}

test("a reading is kept while nothing changed: the reads share it", async () => {
  const w = await settledWorld();
  expect(w.reads()).toBe(2);
  w.later(catalogKeptMs - 1);
  expect(await w.reading.read()).toBe(w.catalog);
  expect(await w.reading.read()).toBe(w.catalog);
  expect(w.reads()).toBe(2);
});

test("it watches the Folder, the Organization's root, each module, app and repository and their parents", async () => {
  const w = await settledWorld();
  const root = join(folder, "organizations", "alpha");
  expect([...w.watched.keys()].sort()).toEqual(
    [
      folder,
      join(folder, "organizations"),
      join(folder, "personalspace"),
      root,
      join(root, "workspace"),
      join(root, "workspace", "web"),
      join(root, "workspace", "web", "app"),
      join(root, "productionspace"),
      join(root, "productionspace", "firmware"),
    ].sort(),
  );
});

test("a change in a watched directory drops the reading: the next read reads anew", async () => {
  const w = await settledWorld();
  for (const directory of [
    join(folder, "organizations"),
    join(folder, "organizations", "alpha", "workspace", "web"),
    join(folder, "organizations", "alpha", "workspace", "web", "app"),
  ]) {
    const before = w.reads();
    w.change(directory);
    const next = w.reading.read();
    await Bun.sleep(0);
    expect([directory, w.reads()]).toEqual([directory, before + 1]);
    const changed = catalogOf(["alpha"]);
    await w.answer(changed);
    expect(await next).toBe(changed);
    expect(await w.reading.read()).toBe(changed);
    expect(w.reads()).toBe(before + 1);
  }
});

test("a change while a reading runs: it answers its own read and is not kept", async () => {
  const w = await settledWorld();
  w.change(join(folder, "organizations"));
  const running = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(3);
  // Changed again before it ends: what it read may be older.
  w.change(join(folder, "organizations", "alpha"));
  const during = catalogOf(["alpha"]);
  await w.answer(during);
  expect(await running).toBe(during);
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(4);
  await w.answer(catalogOf(["alpha", "beta"]));
  expect((await next).organizations.length).toBe(2);
});

test("a reading a forget superseded that ends after the newer one never closes the newer one's watches (#551 review)", async () => {
  const w = world();
  const beta = join(folder, "organizations", "beta");
  // Read A runs; the content changes through the Launchpad; read B runs.
  const a = w.reading.read();
  await Bun.sleep(0);
  w.reading.forget();
  const b = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(2);
  const both = catalogOf(["alpha", "beta"]);
  w.readings[1]?.answer(both);
  expect(await b).toBe(both);
  // B's watches settle: the read after it reads anew behind it, with both.
  expect(await w.reading.read()).toBe(both);
  const settled = catalogOf(["alpha", "beta"]);
  await w.answer(settled);
  expect(w.watched.get(beta)?.closed).toBe(false);
  // A ends last, with alpha only: it answers its own read and nothing else.
  const old = catalogOf(["alpha"]);
  w.readings[0]?.answer(old);
  expect(await a).toBe(old);
  await Bun.sleep(0);
  expect(w.watched.get(beta)?.closed).toBe(false);
  expect(await w.reading.read()).toBe(settled);
  expect(w.reads()).toBe(3);
  // And a change in beta is still told.
  w.change(beta);
  void w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(4);
});

test("a watch event during a reading: that reading is not kept and changes no watch", async () => {
  const w = await settledWorld({}, catalogOf(["alpha", "beta"]));
  const beta = join(folder, "organizations", "beta");
  w.change(join(folder, "organizations"));
  const running = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(3);
  // A change while it reads, then it ends having seen alpha only.
  w.change(join(folder, "organizations", "alpha"));
  const during = catalogOf(["alpha"]);
  await w.answer(during);
  expect(await running).toBe(during);
  expect(w.watched.get(beta)?.closed).toBe(false);
  // The next read reads anew, and only its kept reading changes the watches.
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(4);
  await w.answer(catalogOf(["alpha"]));
  await next;
  expect(w.watched.get(beta)?.closed).toBe(true);
});

test("an older reading of another decision whose Personalspace this is that ends last neither replaces the newer one nor closes its watches", async () => {
  const w = world();
  const beta = join(folder, "organizations", "beta");
  const older = w.reading.read();
  await Bun.sleep(0);
  w.decide({ kind: "blocked", reason: "github-signed-out", login: null });
  const newer = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(2);
  const both = catalogOf(["alpha", "beta"]);
  w.readings[1]?.answer(both);
  expect(await newer).toBe(both);
  w.readings[0]?.answer(catalogOf(["alpha"]));
  await older;
  await Bun.sleep(0);
  expect(w.watched.get(beta)?.closed).toBe(false);
  // The decision now is the newer one's: its catalog answers.
  expect(await w.reading.read()).toBe(both);
});

test("a late word from a watch that was replaced changes nothing; the watch that replaced it is told", async () => {
  const w = await settledWorld();
  const alpha = join(folder, "organizations", "alpha");
  const first = w.made.find((entry) => entry.directory === alpha);
  if (first === undefined) throw new Error("alpha is watched");
  // It ends on its own: the reading is dropped, and the next one watches
  // alpha again with a new watch.
  first.lost();
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(3);
  await w.answer(w.catalog);
  await next;
  const second = w.made.filter((entry) => entry.directory === alpha).at(-1);
  expect(second).not.toBe(first);
  // Settle the reading after the new watch, then the old one speaks late.
  expect(await w.reading.read()).toBe(w.catalog);
  await w.answer(w.catalog);
  const before = w.reads();
  first.changed();
  first.lost();
  expect(await w.reading.read()).toBe(w.catalog);
  expect(w.reads()).toBe(before);
  // The new one is still the one that tells.
  second?.changed();
  void w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(before + 1);
});

test("reads while a reading runs share it; one after a change does not", async () => {
  const w = await settledWorld();
  w.reading.forget();
  const first = w.reading.read();
  const second = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(3);
  w.change(join(folder, "organizations"));
  const third = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(4);
  const old = catalogOf(["alpha"]);
  w.readings[2]?.answer(old);
  const latest = catalogOf(["alpha", "beta"]);
  await w.answer(latest);
  expect(await first).toBe(old);
  expect(await second).toBe(old);
  expect(await third).toBe(latest);
  expect(await w.reading.read()).toBe(latest);
});

test("forget drops the reading: a change through the Launchpad is read at once", async () => {
  const w = await settledWorld();
  w.reading.forget();
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(3);
  const installed = catalogOf(["alpha", "beta"]);
  await w.answer(installed);
  expect(await next).toBe(installed);
});

test("another decision whose Personalspace this is reads anew, with that decision", async () => {
  const w = await settledWorld();
  w.decide({
    kind: "blocked",
    reason: "github-signed-out",
    login: null,
  });
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(3);
  expect(w.readings.at(-1)?.decided).toEqual({
    kind: "blocked",
    reason: "github-signed-out",
    login: null,
  });
  const other = catalogOf(["alpha"]);
  await w.answer(other);
  expect(await next).toBe(other);
  // The decision before is another reading again, not this one.
  w.decide({ kind: "absent" });
  void w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(4);
});

test("a held Personalspace's directories are watched too", async () => {
  const w = world();
  w.decide({ kind: "held", login: "octo-cat", directory: "/folder/ps/own" });
  const read = w.reading.read();
  const group = catalogOf(["personalspace"]).organizations[0];
  if (group === undefined) throw new Error("The fixture has a group");
  await w.answer({
    kind: "catalog",
    organizations: [],
    personalspace: { ...group, repositories: [] },
  });
  await read;
  expect(w.watched.has("/folder/ps/own/workspace/web/app")).toBe(true);
  expect(w.watched.has("/folder/ps/own")).toBe(true);
});

test("older than a minute it still answers at once and is read anew behind it", async () => {
  const w = await settledWorld();
  w.later(catalogKeptMs);
  expect(await w.reading.read()).toBe(w.catalog);
  expect(w.reads()).toBe(3);
  // Once more while that reading runs: still at once, no second reading.
  expect(await w.reading.read()).toBe(w.catalog);
  expect(w.reads()).toBe(3);
  const anew = catalogOf(["alpha"]);
  await w.answer(anew);
  expect(await w.reading.read()).toBe(anew);
  expect(w.reads()).toBe(3);
});

test("a directory a reading finds for the first time was not watched while it read: the next read reads anew behind it", async () => {
  const w = await settledWorld();
  w.change(join(folder, "organizations"));
  const next = w.reading.read();
  const grown = catalogOf(["alpha", "beta"]);
  await w.answer(grown);
  expect(await next).toBe(grown);
  expect(w.watched.has(join(folder, "organizations", "beta"))).toBe(true);
  // beta's directories are watched from now on: answered, and read anew.
  expect(await w.reading.read()).toBe(grown);
  expect(w.reads()).toBe(4);
  await w.answer(grown);
  expect(await w.reading.read()).toBe(grown);
  expect(w.reads()).toBe(4);
});

test("a directory that does not exist is its parent's to watch; a directory the watch refuses keeps the reading only a moment", async () => {
  const missing = await settledWorld({}, catalogOf(["missing"]));
  expect(missing.watched.has(join(folder, "organizations"))).toBe(true);
  expect(await missing.reading.read()).toBe(missing.catalog);
  expect(missing.reads()).toBe(2);
  const w = world({ watch: "refusing" });
  const first = w.reading.read();
  await w.answer(catalogOf(["alpha"]));
  await first;
  w.later(catalogUnwatchedKeptMs - 1);
  await w.reading.read();
  expect(w.reads()).toBe(1);
  w.later(1);
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(2);
  await w.answer(catalogOf(["alpha"]));
  await next;
});

test("without a watch, or with more directories than its bound, a reading is kept only a moment and nothing stays watched", async () => {
  for (const options of [{ watch: "none" as const }, { watchLimit: 3 }]) {
    const w = world(options);
    const first = w.reading.read();
    await w.answer(catalogOf(["alpha"]));
    await first;
    for (const entry of w.watched.values()) expect(entry.closed).toBe(true);
    await w.reading.read();
    expect(w.reads()).toBe(1);
    w.later(catalogUnwatchedKeptMs);
    const next = w.reading.read();
    await Bun.sleep(0);
    expect(w.reads()).toBe(2);
    await w.answer(catalogOf(["alpha"]));
    await next;
  }
});

test("a watch that ends on its own drops the reading, and the next reading watches again", async () => {
  const w = await settledWorld();
  const directory = join(folder, "organizations", "alpha");
  w.watched.get(directory)?.lost();
  w.watched.delete(directory);
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(3);
  await w.answer(w.catalog);
  await next;
  expect(w.watched.has(directory)).toBe(true);
});

test("a directory a later reading no longer has stops being watched", async () => {
  const w = await settledWorld({}, catalogOf(["alpha", "beta"]));
  const beta = join(folder, "organizations", "beta");
  expect(w.watched.get(beta)?.closed).toBe(false);
  w.change(join(folder, "organizations"));
  const next = w.reading.read();
  await w.answer(catalogOf(["alpha"]));
  await next;
  expect(w.watched.get(beta)?.closed).toBe(true);
});

test("a failed reading is not kept: the next read tries again", async () => {
  const w = world();
  const first = w.reading.read();
  await Bun.sleep(0);
  w.readings.at(-1)?.fail(new Error("Folder refused"));
  await expect(first).rejects.toThrow("Folder refused");
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(2);
  await w.answer(catalogOf(["alpha"]));
  await next;
});

test("closed, it watches nothing and keeps nothing", async () => {
  const w = await settledWorld();
  w.reading.close();
  for (const entry of w.watched.values()) expect(entry.closed).toBe(true);
  const next = w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(3);
  await w.answer(w.catalog);
  await next;
  void w.reading.read();
  await Bun.sleep(0);
  expect(w.reads()).toBe(4);
});

test("the routes about one Organization read the catalog without its Personalspace group", () => {
  const group = catalogOf(["personalspace"]).organizations[0];
  if (group === undefined) throw new Error("The fixture has a group");
  const catalog: Catalog = { ...catalogOf(["alpha"]), personalspace: group };
  expect(organizationsOnly(catalog)).toEqual({
    kind: "catalog",
    organizations: catalog.organizations,
  });
});

// The operating system's watch, on a real Folder: an app's package and a
// module's manifest written in place show within a moment, without the
// Launchpad being told.
test.skipIf(process.platform === "win32")(
  "a real Folder: an app's package or a module's manifest written in place shows within a moment",
  async () => {
    await folderFixture(async (path) => {
      const reading = createCatalogReading(path, {
        holder: unverifiedPersonalspace,
      });
      try {
        const web = (catalog: Catalog) =>
          catalog.organizations
            .find((entry) => entry.directory === "alpha_GEN3")
            ?.modules.find((entry) => entry.module === "web");
        const until = async (done: (catalog: Catalog) => boolean) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const catalog = await reading.read();
            if (done(catalog)) return catalog;
            await Bun.sleep(30);
          }
          return reading.read();
        };
        const first = await reading.read();
        expect(web(first)?.executable).toBe(true);
        // The read after the first reads anew behind it; then it is kept.
        expect(await reading.read()).toBe(first);
        await Bun.sleep(100);
        const settled = await reading.read();
        expect(await reading.read()).toBe(settled);
        const module = join(
          path,
          "organizations",
          "alpha_GEN3",
          "workspace",
          "web",
        );
        // The module's manifest, written in place, says nothing usable.
        const manifestPath = join(module, "lazurio.module.json");
        const manifest = await readFile(manifestPath, "utf8");
        await writeFile(manifestPath, "{}");
        const refused = await until(
          (catalog) => web(catalog)?.executable === false,
        );
        expect(refused).not.toBe(settled);
        expect(web(refused)?.reason).toBeDefined();
        // Written back: the module is there again.
        await writeFile(manifestPath, manifest);
        const back = await until(
          (catalog) => web(catalog)?.executable === true,
        );
        expect(web(back)?.executable).toBe(true);
        // The app's package, one directory down, loses its runtime.
        const packagePath = join(module, "app", "package.json");
        const declared = JSON.parse(await readFile(packagePath, "utf8"));
        delete declared.lazurio;
        await writeFile(packagePath, JSON.stringify(declared));
        const undeclared = await until(
          (catalog) => web(catalog)?.executable === false,
        );
        expect(web(undeclared)?.executable).toBe(false);
      } finally {
        reading.close();
      }
    });
  },
  20_000,
);
