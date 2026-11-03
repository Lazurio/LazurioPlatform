import { expect, test } from "bun:test";
import type { MarketplaceCatalog } from "../src/launchpad/marketplace";
import builtInIndex from "../src/launchpad/marketplace-index.json";
import {
  createMarketplaceRefresh,
  type MarketplaceAnswer,
  pageInterval,
  pageRetry,
  pageSettle,
  type RefreshTimers,
} from "../src/launchpad/marketplace-refresh";
import {
  createMarketplaceRegistry,
  type RegistryFetch,
  registryInterval,
  registrySource,
} from "../src/launchpad/marketplace-registry";

// The open Marketplace page (plan DEV-6593, marketplace-refresh.ts): read
// on every visit, again while open, a failure retried, and once more after
// the Launchpad's question to the registry, so a change of the registry
// reaches a page that is open or opened again.

/** Timers the test runs by hand: the pending one and its delay. */
function manualTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  const timers: RefreshTimers = {
    set: (run, ms) => {
      next += 1;
      pending.set(next, { run, ms });
      return next;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fire() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.run();
    },
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

const catalog = (commit: string): MarketplaceCatalog => ({
  source: "registry",
  commit,
  offers: [],
});

test("the page reads on every visit, again while open, retries a failure and settles after a question", async () => {
  const clock = manualTimers();
  const answers: (MarketplaceAnswer | null)[] = [];
  let reads = 0;
  const seen: [string | null, boolean][] = [];
  const refresh = createMarketplaceRefresh({
    load: async () => {
      reads += 1;
      const answer = answers.shift();
      if (answer === undefined) throw new Error("offline");
      return answer;
    },
    answered: (read, changed) => seen.push([read?.commit ?? null, changed]),
    timers: clock.timers,
  });
  // First visit: a failure, retried while the page is open.
  refresh.enter();
  await settled();
  expect(seen).toEqual([[null, false]]);
  expect(clock.delays()).toEqual([pageRetry]);
  // The retry gets the kept index while the Launchpad asks the registry.
  answers.push({ ...catalog("a".repeat(40)), checking: true });
  clock.fire();
  await settled();
  expect(seen.at(-1)).toEqual(["a".repeat(40), true]);
  expect(clock.delays()).toEqual([pageSettle]);
  // After the question the registry's new index is shown.
  answers.push({ ...catalog("b".repeat(40)), checking: false });
  clock.fire();
  await settled();
  expect(seen.at(-1)).toEqual(["b".repeat(40), true]);
  expect(clock.delays()).toEqual([pageInterval]);
  // While open, the same answer changes nothing.
  answers.push(catalog("b".repeat(40)));
  clock.fire();
  await settled();
  expect(seen.at(-1)).toEqual(["b".repeat(40), false]);
  // Left: nothing more is read; a second enter while open reads nothing.
  refresh.leave();
  expect(clock.delays()).toEqual([]);
  const before = reads;
  // Entered again: read at once.
  answers.push(catalog("c".repeat(40)));
  refresh.enter();
  refresh.enter();
  await settled();
  expect(reads).toBe(before + 1);
  expect(seen.at(-1)).toEqual(["c".repeat(40), true]);
  // Visible again after it was hidden: read at once; hidden pages left alone.
  answers.push(catalog("c".repeat(40)));
  refresh.wake();
  await settled();
  expect(reads).toBe(before + 2);
  refresh.leave();
  refresh.wake();
  await settled();
  expect(reads).toBe(before + 2);
});

test("a registry change reaches a page that stays open, through the Launchpad's hourly question", async () => {
  const head = "a".repeat(40);
  const next = "b".repeat(40);
  const api = `https://api.github.com/repositories/${registrySource.id}`;
  const released = (title: string) => ({
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
  const state = {
    main: head,
    indexes: { [head]: released("Presentations") } as Record<string, unknown>,
  };
  const fetcher: RegistryFetch = async (url) => {
    if (url === `${api}/commits/main`) return new Response(state.main);
    const match = /ref=([0-9a-f]{40})$/.exec(url);
    const value = match === null ? undefined : state.indexes[match[1] ?? ""];
    return value === undefined
      ? new Response("{}", { status: 404 })
      : new Response(JSON.stringify(value));
  };
  let now = 1_000;
  const registry = createMarketplaceRegistry({
    fetch: fetcher,
    cacheFile: null,
    now: () => now,
  });
  const clock = manualTimers();
  const titles: string[] = [];
  const refresh = createMarketplaceRefresh({
    // What POST /api/marketplace answers (server.ts).
    load: async () => ({
      ...(await registry.read()),
      checking: registry.checking(),
    }),
    answered: (read, changed) => {
      if (read !== null && changed)
        titles.push(read.offers.map((offer) => offer.title).join());
    },
    timers: clock.timers,
  });
  refresh.enter();
  await settled();
  expect(titles).toEqual(["Presentations"]);
  // The registry's main moves; an hour later the page's own read starts
  // the Launchpad's question, and the read after it shows the change.
  state.main = next;
  state.indexes[next] = released("Slides");
  now += registryInterval;
  for (let i = 0; i < 3 && titles.length < 2; i += 1) {
    clock.fire();
    await settled();
  }
  expect(titles).toEqual(["Presentations", "Slides"]);
  refresh.leave();
});
