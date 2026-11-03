import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import {
  builtInMarketplace,
  type MarketplaceCatalog,
  parseMarketplaceIndex,
} from "./marketplace";

// Where the Marketplace's offers come from (plan DEV-6593, docs/marketplace.md
// "The registry"): the public registry `Lazurio/marketplace`, read at one
// exact commit of its `main`, so a template listed by a curator's merge
// needs no Lazurio release. The repository is named by its numeric GitHub
// id, so a rename or a transfer cannot put another repository in its place.
// One read asks which commit `main` is, and only when that moved, the
// `index.json` of exactly that commit, which the Launchpad parses in full
// (marketplace.ts) or refuses. The last index read is kept in the install
// base and survives a restart; without one, or offline, the copy built into
// this release is shown. A listing grants nothing: whatever an index says,
// adoption stays a brief the agent checks against the release itself.

/** The registry this release reads. */
export const registrySource = Object.freeze({
  repository: "Lazurio/marketplace",
  id: 1444094703,
  branch: "main",
});

/** How often an open Marketplace asks the registry again. */
export const registryInterval = 60 * 60 * 1000;
/** How soon a question that failed (offline, rate-limited, refused) is
 * asked again, instead of an interval later. */
export const registryRetry = 5 * 60 * 1000;
const requestTimeoutMs = 10_000;
const maxIndexBytes = 1024 * 1024;

export type RegistryFetch = (
  url: string,
  init: Readonly<{
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }>,
) => Promise<Response>;

export type MarketplaceRegistry = Readonly<{
  /** What the Launchpad shows now, without waiting for anything. */
  current: () => MarketplaceCatalog;
  /** The catalog to answer with: the kept index once it is loaded, and
   * the registry asked again when the last question is an interval old.
   * While nothing was ever read from the registry the answer waits for
   * that question; otherwise it never waits for the network. */
  read: () => Promise<MarketplaceCatalog>;
  /** Whether a question to the registry is under way: its answer can change
   * the catalog within the question's 10 s, so an open page reads again. */
  checking: () => boolean;
  /** The catalogs an adoption prompt may name: the current one, those it
   * replaced within `keptFor`, and the built-in copy. A page that showed a
   * catalog just before the registry moved still hands over exactly what
   * it showed; an older page's prompt is a 404. */
  catalogs: () => readonly MarketplaceCatalog[];
}>;

/** How long a replaced catalog still answers the prompts of a page that
 * showed it: as long as an open page may go without reading again. */
export const keptFor = registryInterval;
const keptAtMost = 4;

const api = (path: string) =>
  `https://api.github.com/repositories/${registrySource.id}${path}`;

const headers = (accept: string) =>
  Object.freeze({
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lazurio-launchpad",
  });

/** The catalog of a kept or fetched index at a commit, or null. */
function catalogOf(commit: unknown, index: unknown): MarketplaceCatalog | null {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return null;
  const offers = parseMarketplaceIndex(index);
  return offers === null
    ? null
    : Object.freeze({ source: "registry", commit, offers });
}

async function body(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new Error("too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error("too large");
  return new TextDecoder().decode(bytes);
}

export function createMarketplaceRegistry(
  options: Readonly<{
    /** How the registry is asked; null never asks (a Launchpad that is not
     * an installed one shows the built-in copy only). */
    fetch: RegistryFetch | null;
    /** Where the last index read is kept, or null to keep none. */
    cacheFile: string | null;
    now?: () => number;
  }>,
): MarketplaceRegistry {
  const now = options.now ?? Date.now;
  let catalog: MarketplaceCatalog = builtInMarketplace;
  // The catalogs replaced, newest first, with when they were.
  let replaced: { catalog: MarketplaceCatalog; at: number }[] = [];
  const show = (next: MarketplaceCatalog) => {
    if (catalog !== builtInMarketplace)
      replaced = [{ catalog, at: now() }, ...replaced].slice(0, keptAtMost);
    catalog = next;
  };
  let asked = Number.NEGATIVE_INFINITY;
  let asking: Promise<void> | null = null;

  const loaded = (async () => {
    if (options.cacheFile === null) return;
    try {
      const kept = JSON.parse(await readFile(options.cacheFile, "utf8")) as {
        commit?: unknown;
        index?: unknown;
      } | null;
      const read = catalogOf(kept?.commit, kept?.index);
      if (read !== null) catalog = read;
    } catch {}
  })();

  async function keep(commit: string, index: unknown) {
    const file = options.cacheFile;
    if (file === null) return;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeDurableFile(
        dirname(file),
        basename(file),
        Buffer.from(`${JSON.stringify({ commit, index })}\n`),
      );
    } catch {}
  }

  /** Whether the registry answered: `main` unchanged, or its index read. */
  async function ask(fetcher: RegistryFetch): Promise<boolean> {
    const signal = AbortSignal.timeout(requestTimeoutMs);
    try {
      const head = await fetcher(api(`/commits/${registrySource.branch}`), {
        headers: headers("application/vnd.github.sha"),
        signal,
      });
      if (!head.ok) return false;
      const commit = (await body(head, 100)).trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) return false;
      if (commit === catalog.commit) return true;
      const file = await fetcher(api(`/contents/index.json?ref=${commit}`), {
        headers: headers("application/vnd.github.raw+json"),
        signal,
      });
      if (!file.ok) return false;
      const index: unknown = JSON.parse(await body(file, maxIndexBytes));
      const read = catalogOf(commit, index);
      if (read === null) return false;
      show(read);
      await keep(commit, index);
      return true;
    } catch {
      return false;
    }
  }

  function refresh(): Promise<void> {
    const fetcher = options.fetch;
    if (fetcher === null) return Promise.resolve();
    if (asking !== null) return asking;
    if (now() - asked < registryInterval) return Promise.resolve();
    asked = now();
    asking = ask(fetcher)
      .then((answered) => {
        // A failed question is asked again a retry later, not an hour.
        if (!answered) asked = now() - registryInterval + registryRetry;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  }

  return Object.freeze({
    current: () => catalog,
    async read() {
      await loaded;
      const question = refresh();
      if (catalog.source === "built-in") await question;
      return catalog;
    },
    checking: () => asking !== null,
    catalogs: () => [
      catalog,
      ...replaced
        .filter((entry) => now() - entry.at < keptFor)
        .map((entry) => entry.catalog),
      ...(catalog === builtInMarketplace ? [] : [builtInMarketplace]),
    ],
  });
}
