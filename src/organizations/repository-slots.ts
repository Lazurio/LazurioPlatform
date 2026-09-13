import { array } from "../modules/manifest";
import { organizationDocumentHash } from "./document-hash";

const rootPaths = new Set([
  "design-system",
  "infra",
  "mission-control",
  "mission-control/db",
]);
const mount = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?";
const direct = new RegExp(`^(workspace|modules|productionspace)/(${mount})$`);
const database = new RegExp(`^(workspace|modules)/(${mount})/db$`);

// Exact repository-mount grammar, not general filesystem normalization. Never
// rewrite historical case/spelling or infer permission from a path or scope.
export function classifyRepositorySlotPath(input: unknown) {
  if (
    typeof input !== "string" ||
    input.includes("\\") ||
    /[\r\n\0]/.test(input)
  )
    return null;
  if (rootPaths.has(input))
    return Object.freeze({
      path: input,
      scope: "root" as const,
      nestedDatabase: false,
    });
  const match = direct.exec(input);
  if (match && match[0] === input)
    return Object.freeze({
      path: input,
      scope:
        match[1] === "productionspace"
          ? ("productionspace" as const)
          : ("workspace" as const),
      nestedDatabase: false,
    });
  const db = database.exec(input);
  if (db && db[0] === input)
    return Object.freeze({
      path: input,
      scope: "workspace" as const,
      nestedDatabase: true,
    });
  return null;
}

type Issue = Readonly<{ code: string; indices: readonly number[] }>;
// Report implicated declaration indices so a later discovery consumer can quarantine
// conflicts without losing unrelated siblings. This is not an app/module catalog.
export function inspectRepositorySlots(input: unknown) {
  organizationDocumentHash(input);
  const declarations = array(input);
  const issues: Issue[] = [];
  const issue = (code: string, ...indices: number[]) =>
    issues.push(Object.freeze({ code, indices: Object.freeze(indices) }));
  const paths = new Map<
    string,
    { path: string; id: string | null; index: number }
  >();
  const ids = new Map<string, { path: string; index: number }>();
  const slots = declarations.map((input, index) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      issue("invalid-declaration", index);
      return null;
    }
    const declaration = input as Record<string, unknown>;
    const path = classifyRepositorySlotPath(declaration.path);
    if (!path) {
      issue("unsupported-path", index);
      return null;
    }
    const fallback = path.path.split("/").at(-1);
    const candidate = Object.hasOwn(declaration, "slug")
      ? declaration.slug
      : path.nestedDatabase
        ? null
        : fallback;
    const id =
      typeof candidate === "string" &&
      candidate !== "root" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) &&
      !/[\r\n]/.test(candidate)
        ? candidate
        : null;
    if (
      id === null &&
      (!path.nestedDatabase || Object.hasOwn(declaration, "slug"))
    )
      issue("invalid-repository-slug", index);
    const previous = paths.get(path.path.toLowerCase());
    if (previous)
      issue(
        previous.path !== path.path
          ? "path-case-collision"
          : previous.id !== id
            ? "path-identity-conflict"
            : "duplicate-path",
        previous.index,
        index,
      );
    else paths.set(path.path.toLowerCase(), { path: path.path, id, index });
    if (id !== null) {
      const previousId = ids.get(id);
      if (previousId) issue("repository-id-collision", previousId.index, index);
      else ids.set(id, { path: path.path, index });
    }
    return Object.freeze({ ...path, id, index });
  });
  for (const slot of slots)
    if (slot?.nestedDatabase) {
      const parent = slot.path.slice(0, -3);
      if (paths.get(parent.toLowerCase())?.path !== parent)
        issue("repository-db-parent-missing", slot.index);
    }
  return Object.freeze({
    slots: Object.freeze(slots),
    issues: Object.freeze(issues),
  });
}
