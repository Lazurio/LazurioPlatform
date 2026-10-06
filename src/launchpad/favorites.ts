// Favourite modules and repositories (decision F36 addendum of 2026-10-04,
// Anička 2026-10-03): starred from a tile's "⋯" menu, listed in the Apps
// column under "Všechny moduly" and "Soubory" and first in their section of
// the Apps home, in the column's order. They belong to the person and the
// Organization; until the Dashboard account holds them they live in this
// browser's `localStorage`, one list per Organization. Never in the Folder:
// on a Team Environment that would share one person's favourites with the
// whole Team. An Environment shows only those its catalog has. Pure but for
// the storage passed in.

/** A favourite: a module (`m:<id>`) or a production repository
 * (`r:<slug>`), so the two never collide. */
export const moduleFavorite = (id: string): string => `m:${id}`;
export const repositoryFavorite = (slug: string): string => `r:${slug}`;

/** The storage key of one Organization's list (the Personalspace group is
 * `personalspace`); slugs are compared case-insensitively. */
export const favoritesKey = (scope: string): string =>
  `lazurio.favorites:${scope.toLowerCase()}`;

const entry = /^[mr]:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A stored list, read defensively: anything that is not a list of
 * favourites is none; duplicates keep their first place; at most 200. */
export function parseFavorites(raw: string | null): readonly string[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string => typeof item === "string" && entry.test(item),
      ),
    ),
  ].slice(0, 200);
}

/** The list with `favorite` added at its end, or removed. */
export const toggleFavorite = (
  list: readonly string[],
  favorite: string,
): readonly string[] =>
  list.includes(favorite)
    ? list.filter((item) => item !== favorite)
    : [...list, favorite];

/** Favourites first, in the list's order, then the rest in their own. */
export function favoritesFirst<T extends Readonly<{ key: string }>>(
  items: readonly T[],
  list: readonly string[],
): readonly T[] {
  const starred = list.flatMap((key) => {
    const found = items.find((item) => item.key === key);
    return found === undefined ? [] : [found];
  });
  return [...starred, ...items.filter((item) => !list.includes(item.key))];
}
