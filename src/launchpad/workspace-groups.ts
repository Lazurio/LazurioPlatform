import type { AppsTile } from "./apps-view";

export type WorkspaceGroup = "work" | "administration";
export type WorkspaceGroupScope = Readonly<{
  kind: "organization" | "personal";
  id: string;
}>;

type Store = Pick<Storage, "getItem" | "setItem">;
const prefix = "lazurio.workspace-groups.v1:";
const moduleKey = /^m:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const limit = 2000;

/** An origin-local UI preference, separate for each account and space.
 * It is never a catalog, access rule, module declaration or runtime setting. */
export function workspaceGroupsKey(
  login: string,
  scope: WorkspaceGroupScope,
): string {
  return (
    prefix +
    JSON.stringify([login.toLowerCase(), scope.kind, scope.id.toLowerCase()])
  );
}

export function parseWorkspaceGroups(raw: string | null): readonly string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(value) || value.length > limit) return [];
    return [
      ...new Set(
        value.filter(
          (key): key is string =>
            typeof key === "string" && moduleKey.test(key),
        ),
      ),
    ];
  } catch {
    return [];
  }
}

/** Both partitions preserve tile identity, order, actions and unavailable modules.
 * Unknown/new modules stay in Work; stale preference keys create no tiles. */
export function workspaceGroupTiles(
  tiles: readonly AppsTile[],
  administration: readonly string[],
  selected: WorkspaceGroup,
): readonly AppsTile[] {
  const assigned = new Set(administration);
  return tiles.filter(
    (tile) =>
      (tile.kind === "module" && assigned.has(tile.key)) ===
      (selected === "administration"),
  );
}

/** Read before each move so another tab's unrelated changes are preserved.
 * Without an identified account, preferences last for this page only. */
export function createWorkspaceGroups(storage: () => Store) {
  const temporary = new Map<string, readonly string[]>();
  const transientKey = (scope: WorkspaceGroupScope) =>
    JSON.stringify([scope.kind, scope.id.toLowerCase()]);
  const read = (
    login: string | null,
    scope: WorkspaceGroupScope,
  ): readonly string[] =>
    login === null
      ? (temporary.get(transientKey(scope)) ?? [])
      : parseWorkspaceGroups(
          storage().getItem(workspaceGroupsKey(login, scope)),
        );
  return {
    list(login: string | null, scope: WorkspaceGroupScope): readonly string[] {
      try {
        return read(login, scope);
      } catch {
        return [];
      }
    },
    move(
      login: string | null,
      scope: WorkspaceGroupScope,
      key: string,
      destination: WorkspaceGroup,
    ): "saved" | "temporary" | "failed" {
      if (!moduleKey.test(key)) return "failed";
      try {
        const next = read(login, scope).filter((item) => item !== key);
        if (destination === "administration") next.push(key);
        if (next.length > limit) return "failed";
        if (login === null) {
          temporary.set(transientKey(scope), next);
          return "temporary";
        }
        storage().setItem(
          workspaceGroupsKey(login, scope),
          JSON.stringify(next),
        );
        return "saved";
      } catch {
        return "failed";
      }
    },
    isStorageKey(key: string | null): boolean {
      return key === null || key.startsWith(prefix);
    },
  };
}
