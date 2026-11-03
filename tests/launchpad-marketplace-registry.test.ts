import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtInMarketplace } from "../src/launchpad/marketplace";
import builtInIndex from "../src/launchpad/marketplace-index.json";
import {
  createMarketplaceRegistry,
  keptFor,
  type RegistryFetch,
  registryInterval,
  registryRetry,
  registrySource,
} from "../src/launchpad/marketplace-registry";

// The registry the Marketplace reads (plan DEV-6593): `main`'s commit, the
// index of exactly that commit, kept across restarts; anything else leaves
// what the page showed.

const head = "a".repeat(40);
const next = "b".repeat(40);
const api = `https://api.github.com/repositories/${registrySource.id}`;

/** The built-in index with Presentations released under this title. */
const index = (title = "Presentations") => ({
  ...builtInIndex,
  offers: builtInIndex.offers.map((offer) =>
    offer.id === "presentations"
      ? {
          ...offer,
          title,
          releases: offer.releases.map((release) => ({
            ...release,
            commit: "c".repeat(40),
          })),
        }
      : offer,
  ),
});

/** A GitHub answering `main` and the index of each commit, counting asks. */
function github(
  state: { main: string; indexes: Record<string, unknown>; status?: number },
  asked: string[],
): RegistryFetch {
  return async (url, init) => {
    asked.push(url);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (state.status !== undefined)
      return new Response("{}", { status: state.status });
    if (url === `${api}/commits/main`) {
      expect(init.headers.Accept).toBe("application/vnd.github.sha");
      return new Response(state.main);
    }
    const match = /\/contents\/index\.json\?ref=([0-9a-f]{40})$/.exec(url);
    const value = match === null ? undefined : state.indexes[match[1] ?? ""];
    return value === undefined
      ? new Response("{}", { status: 404 })
      : new Response(typeof value === "string" ? value : JSON.stringify(value));
  };
}

/** Lets a question asked in the background finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-market-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the registry is read at main's commit, kept, and read again only when main moved, an interval later", async () => {
  await withDirectory(async (directory) => {
    const cacheFile = join(directory, "marketplace", "registry.json");
    const asked: string[] = [];
    const state = {
      main: head,
      indexes: { [head]: index() } as Record<string, unknown>,
    };
    let clock = 1_000;
    const registry = createMarketplaceRegistry({
      fetch: github(state, asked),
      cacheFile,
      now: () => clock,
    });
    expect(registry.current()).toBe(builtInMarketplace);
    const first = await registry.read();
    expect(first.source).toBe("registry");
    expect(first.commit).toBe(head);
    // Only the released offer is shown.
    expect(first.offers.map((offer) => offer.id)).toEqual(["presentations"]);
    expect(asked).toEqual([
      `${api}/commits/main`,
      `${api}/contents/index.json?ref=${head}`,
    ]);
    // Within the interval nothing is asked.
    await registry.read();
    expect(asked).toHaveLength(2);
    // An interval later main is asked; the same commit fetches nothing.
    clock += registryInterval;
    await registry.read();
    await settled();
    expect(asked).toHaveLength(3);
    // main moved: the new index replaces the shown one once it is read.
    state.main = next;
    state.indexes[next] = index("Slides");
    clock += registryInterval;
    expect((await registry.read()).commit).toBe(head);
    await settled();
    expect(registry.current().commit).toBe(next);
    const kept = JSON.parse(await readFile(cacheFile, "utf8"));
    expect(kept.commit).toBe(next);

    // A restart shows the kept index at once, before any question.
    const offline = createMarketplaceRegistry({
      fetch: github({ main: head, indexes: {}, status: 500 }, []),
      cacheFile,
      now: () => 0,
    });
    const restarted = await offline.read();
    expect(restarted.commit).toBe(next);
    expect(
      restarted.offers.find((offer) => offer.id === "presentations")?.title,
    ).toBe("Slides");
  });
});

test("a private or unreachable registry, an unreadable index and a damaged keep leave the built-in copy", async () => {
  for (const state of [
    { main: head, indexes: {}, status: 404 },
    { main: head, indexes: {}, status: 403 },
    { main: "not a commit", indexes: {} },
    { main: head, indexes: {} },
    { main: head, indexes: { [head]: "{not json" } },
    {
      main: head,
      indexes: {
        [head]: { ...index(), schemaVersion: "lazurio.marketplace.index.v2" },
      },
    },
    { main: head, indexes: { [head]: { ...index(), offers: [{ id: "x" }] } } },
  ]) {
    const registry = createMarketplaceRegistry({
      fetch: github(state, []),
      cacheFile: null,
    });
    expect(await registry.read()).toBe(builtInMarketplace);
  }
  const thrown = createMarketplaceRegistry({
    fetch: async () => {
      throw new Error("offline");
    },
    cacheFile: null,
  });
  expect(await thrown.read()).toBe(builtInMarketplace);
  await withDirectory(async (directory) => {
    const cacheFile = join(directory, "registry.json");
    await writeFile(
      cacheFile,
      JSON.stringify({ commit: head, index: { offers: 1 } }),
    );
    const registry = createMarketplaceRegistry({ fetch: null, cacheFile });
    expect(await registry.read()).toBe(builtInMarketplace);
  });
});

test("a Launchpad that is not installed never asks", async () => {
  const registry = createMarketplaceRegistry({ fetch: null, cacheFile: null });
  expect(await registry.read()).toBe(builtInMarketplace);
});

test("an index larger than a mebibyte is refused before it is parsed", async () => {
  const registry = createMarketplaceRegistry({
    fetch: async (url) =>
      url.endsWith("/commits/main")
        ? new Response(head)
        : new Response("x".repeat(1024 * 1024 + 1)),
    cacheFile: null,
  });
  expect(await registry.read()).toBe(builtInMarketplace);
});

test("a failed question is asked again a retry later, and checking says while one is under way", async () => {
  const asked: string[] = [];
  const state: {
    main: string;
    indexes: Record<string, unknown>;
    status?: number;
  } = { main: head, indexes: { [head]: index() }, status: 503 };
  let clock = 1_000;
  let release: () => void = () => {};
  let hold = false;
  const answering = github(state, asked);
  const registry = createMarketplaceRegistry({
    fetch: async (url, init) => {
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return answering(url, init);
    },
    cacheFile: null,
    now: () => clock,
  });
  // GitHub refuses: the built-in copy, and nothing more within the retry.
  expect(await registry.read()).toBe(builtInMarketplace);
  expect(asked).toHaveLength(1);
  clock += registryRetry - 1;
  await registry.read();
  expect(asked).toHaveLength(1);
  // A retry later it is asked again, not only an interval later.
  delete state.status;
  clock += 1;
  expect((await registry.read()).commit).toBe(head);
  expect(asked).toHaveLength(3);
  expect(registry.checking()).toBe(false);
  // An interval later the question runs in the background; checking says so
  // until it is over.
  hold = true;
  clock += registryInterval;
  expect((await registry.read()).commit).toBe(head);
  expect(registry.checking()).toBe(true);
  hold = false;
  release();
  await settled();
  expect(registry.checking()).toBe(false);
});

test("a replaced catalog is still served to prompts for an hour, the built-in copy always", async () => {
  const state = {
    main: head,
    indexes: { [head]: index(), [next]: index("Slides") } as Record<
      string,
      unknown
    >,
  };
  let clock = 1_000;
  const registry = createMarketplaceRegistry({
    fetch: github(state, []),
    cacheFile: null,
    now: () => clock,
  });
  const commits = () => registry.catalogs().map((catalog) => catalog.commit);
  expect(commits()).toEqual([null]);
  await registry.read();
  // The built-in copy was only waited for, so it is not kept as replaced.
  expect(commits()).toEqual([head, null]);
  state.main = next;
  clock += registryInterval;
  await registry.read();
  await settled();
  expect(commits()).toEqual([next, head, null]);
  // An hour after it was replaced, the old catalog answers no prompt.
  clock += keptFor - 1;
  expect(commits()).toEqual([next, head, null]);
  clock += 1;
  expect(commits()).toEqual([next, null]);
});
