import { parseFavorites, toggleFavorite } from "./favorites";

// The person's Lazurio account as Apps reads it (root decision 0185 S12 and
// S18, F37's account namespace): `GET /.lazurio/account/environments` on this
// Environment's own origin, which the Environment's gateway answers from the
// Dashboard with the person's own token (`lazurio.account.v1`). Apps reads
// two things of it: where module apps open (`preferences.openApps`) and the
// favourites of this Environment's Organization (`favourites`, keyed by the
// Organization slug). Everything else in it (the spaces, the Environments,
// the last one used) is the shell library's. Until the gateway relays the
// namespace the read fails (404) and Apps keeps today's behaviour: favourites
// in this browser, apps in a new tab. Nothing here holds a token: the
// requests are plain same-origin ones, and the gateway adds the person's
// token on its own side. Pure but for the fetch passed in.

export const accountSchema = "lazurio.account.v1";
export const accountDocumentPath = "/.lazurio/account/environments";
/** How long Apps waits for the account before it keeps today's behaviour. */
export const accountReadMs = 4_000;

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

/** Reads the account once: the document, or null when it is unavailable
 * (no gateway relay yet, a refusal, a sign-in redirect, a slow answer past
 * `timeoutMs`, anything else than `lazurio.account.v1`). Never throws. */
export async function readAccount(
  fetcher: Fetch = fetch,
  timeoutMs = accountReadMs,
): Promise<Account | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(accountDocumentPath, {
      credentials: "same-origin",
      cache: "no-store",
      // An expired session is a refusal, never a sign-in page to follow.
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseAccount(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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

/** The favourites of the account, as Apps shows and changes them: a star
 * shows at once (optimistic); when the account does not take it, that one
 * favourite is put back as it was, unless a later click changed it since. */
export function createAccountFavourites(
  initial: Account["favourites"],
  write: (method: "PUT" | "DELETE", path: string) => Promise<boolean>,
) {
  const lists = new Map(initial);
  return {
    /** One Organization's favourites, in the account's order. */
    list(slug: string): readonly string[] {
      return lists.get(slug.toLowerCase()) ?? [];
    },
    /** Stars or unstars at once; resolves whether the account took it. */
    async toggle(slug: string, key: string): Promise<boolean> {
      const scope = slug.toLowerCase();
      const before = lists.get(scope) ?? [];
      const adding = !before.includes(key);
      const at = before.indexOf(key);
      lists.set(scope, toggleFavorite(before, key));
      const path = favouritePath(slug, key);
      const ok =
        path !== null &&
        (await write(adding ? "PUT" : "DELETE", path).catch(() => false));
      if (ok) return true;
      const now = lists.get(scope) ?? [];
      if (adding && now.includes(key))
        lists.set(
          scope,
          now.filter((item) => item !== key),
        );
      else if (!adding && !now.includes(key))
        lists.set(scope, [...now.slice(0, at), key, ...now.slice(at)]);
      return false;
    },
  };
}

export type AccountFavourites = ReturnType<typeof createAccountFavourites>;
