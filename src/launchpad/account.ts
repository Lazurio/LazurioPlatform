import {
  accountDocumentPath,
  accountReadMs,
  pageAccountJson,
} from "../shell/account";
import { parseFavorites } from "./favorites";

// The person's Lazurio account as Apps reads it (root decision 0185 S12 and
// S18, F37's account namespace): `GET /.lazurio/account/environments` on this
// Environment's own origin, which the Environment's gateway answers from the
// Dashboard with the person's own token (`lazurio.account.v1`). Apps reads
// two things of it: where module apps open (`preferences.openApps`) and the
// favourites of this Environment's Organization (`favourites`, keyed by the
// Organization slug). Everything else in it (the spaces, the Environments,
// the last one used) is the shell library's, which also makes the page's one
// read cycle (`src/shell/account.ts`). Until the gateway relays the
// namespace the read fails (404) and Apps keeps today's behaviour: favourites
// in this browser, apps in a new tab. Nothing here holds a token: the
// requests are plain same-origin ones, and the gateway adds the person's
// token on its own side. Pure but for the read and the fetch passed in.

export const accountSchema = "lazurio.account.v1";
export { accountDocumentPath, accountReadMs };

/** Where module apps open (S18): a new tab, or this window. */
export type OpenApps = "tab" | "same";

export type Account = Readonly<{
  openApps: OpenApps;
  /** Favourite keys (`m:<module id>`, `r:<repository slug>`) by the
   * Organization slug (lowercased), in the account's order. A missing slug
   * has none. */
  favourites: ReadonlyMap<string, readonly string[]>;
}>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** One Organization's favourites as stored keys, read defensively: entries
 * that are not `{ kind: "module" | "repository", id }` with a valid id are
 * dropped, duplicates keep their first place, at most 200. */
function favouriteKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return parseFavorites(
    JSON.stringify(
      value.flatMap((entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        (entry.kind === "module" || entry.kind === "repository")
          ? [`${entry.kind === "module" ? "m" : "r"}:${entry.id}`]
          : [],
      ),
    ),
  );
}

/** What Apps reads of an account document: null unless its `schema` is
 * `lazurio.account.v1`. Every other member is read defensively: an
 * `openApps` other than `"same"` is `"tab"`, malformed favourites are none,
 * and members Apps does not use are ignored. */
export function parseAccount(input: unknown): Account | null {
  if (!isRecord(input) || input.schema !== accountSchema) return null;
  const preferences = isRecord(input.preferences) ? input.preferences : {};
  const favourites = new Map<string, readonly string[]>();
  if (isRecord(input.favourites))
    for (const [slug, list] of Object.entries(input.favourites)) {
      const key = slug.toLowerCase();
      if (slug.trim() !== "" && !favourites.has(key))
        favourites.set(key, Object.freeze(favouriteKeys(list)));
    }
  return Object.freeze({
    openApps: preferences.openApps === "same" ? "same" : "tab",
    favourites,
  });
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** What Apps reads of the account: the answer this page read once (the
 * shell library's `pageAccountJson`, which the rail merges too, so the page
 * shares one bounded recovery cycle), or null when it is unavailable (no
 * gateway relay yet, a refusal, a sign-in redirect, a slow answer, anything else than
 * `lazurio.account.v1`). Never throws. */
export async function readAccount(
  read: () => Promise<unknown> = pageAccountJson,
): Promise<Account | null> {
  try {
    return parseAccount(await read());
  } catch {
    return null;
  }
}

// A path segment of the account namespace: the gateway's grammar, never `.`
// or `..`.
const segment = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

/** The account path that stars or unstars one favourite of an
 * Organization: `/.lazurio/account/favourites/<org slug>/<module|repository>/<id>`;
 * null when the slug or the id is not a segment the gateway passes. */
export function favouritePath(slug: string, key: string): string | null {
  const kind = key.startsWith("m:")
    ? "module"
    : key.startsWith("r:")
      ? "repository"
      : null;
  const id = key.slice(2);
  if (kind === null || !segment.test(slug) || !segment.test(id)) return null;
  return `/.lazurio/account/favourites/${slug}/${kind}/${id}`;
}

/** One write of the account (`PUT` stars, `DELETE` unstars): whether the
 * account took it, within `timeoutMs`. Never throws. */
export function accountWriter(
  fetcher: Fetch = fetch,
  timeoutMs = accountReadMs,
): (method: "PUT" | "DELETE", path: string) => Promise<boolean> {
  return async (method, path) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

// One favourite's writes: what the account last took (`held`), what the
// person's last click wants (`wanted`), how many clicks there were, the
// place it had when its first pending click left it, and the clicks still
// waiting for an answer.
type Pending = {
  held: boolean;
  wanted: boolean;
  clicks: number;
  writing: boolean;
  at: number;
  waiting: ((taken: boolean) => void)[];
};

/** The favourites of the account, as Apps shows and changes them: a star
 * shows at once (optimistic). One favourite has one write under way at a
 * time, sent in the order of the clicks, so the account ends as the
 * person's last click wants (Pablo's review of #159): a click while a write
 * is under way is sent after it, only when it still differs from what the
 * account holds. A failure is put back only when no later click wants
 * something else; then the favourite shows what the account holds, in its
 * place. Different favourites never wait for each other. */
export function createAccountFavourites(
  initial: Account["favourites"],
  write: (method: "PUT" | "DELETE", path: string) => Promise<boolean>,
) {
  const lists = new Map(initial);
  const pending = new Map<string, Pending>();
  const list = (scope: string) => lists.get(scope) ?? [];
  // Shows a favourite starred or not; `at` puts a star back in its place.
  function show(scope: string, key: string, starred: boolean, at?: number) {
    const without = list(scope).filter((item) => item !== key);
    if (!starred) lists.set(scope, without);
    else if (at === undefined || at < 0)
      lists.set(
        scope,
        list(scope).includes(key) ? list(scope) : [...without, key],
      );
    else lists.set(scope, [...without.slice(0, at), key, ...without.slice(at)]);
  }
  async function drain(
    scope: string,
    slug: string,
    key: string,
    state: Pending,
  ) {
    state.writing = true;
    let refused = false;
    let moved = false;
    while (state.wanted !== state.held) {
      const target = state.wanted;
      const sent = state.clicks;
      const path = favouritePath(slug, key);
      const taken =
        path !== null &&
        (await write(target ? "PUT" : "DELETE", path).catch(() => false));
      if (taken) {
        state.held = target;
        moved = true;
      } else if (state.clicks === sent) {
        // The last click's own write failed: back to what the account holds.
        state.wanted = state.held;
        refused = true;
      }
      // Otherwise a later click wants something: the loop writes that.
    }
    // A star the account never let go of returns to its place.
    if (state.held && !moved) show(scope, key, true, state.at);
    else show(scope, key, state.held);
    state.writing = false;
    pending.delete(`${scope}\n${key}`);
    const waiting = state.waiting.splice(0);
    for (const [index, done] of waiting.entries())
      done(!(refused && index === waiting.length - 1));
  }
  return {
    /** One Organization's favourites, in the account's order. */
    list(slug: string): readonly string[] {
      return list(slug.toLowerCase());
    },
    /** Stars or unstars at once; resolves, once this favourite's writes
     * are done, whether this click stood: false only for a last click the
     * account did not take. */
    toggle(slug: string, key: string): Promise<boolean> {
      const scope = slug.toLowerCase();
      const id = `${scope}\n${key}`;
      let state = pending.get(id);
      if (state === undefined) {
        const starred = list(scope).includes(key);
        state = {
          held: starred,
          wanted: starred,
          clicks: 0,
          writing: false,
          at: list(scope).indexOf(key),
          waiting: [],
        };
        pending.set(id, state);
      }
      state.clicks += 1;
      state.wanted = !state.wanted;
      show(scope, key, state.wanted);
      const answered = new Promise<boolean>((done) => state.waiting.push(done));
      if (!state.writing) void drain(scope, slug, key, state);
      return answered;
    },
  };
}

export type AccountFavourites = ReturnType<typeof createAccountFavourites>;
