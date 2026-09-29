import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { workspacePreset } from "../folder/presets";
import { readStateJson } from "../folder/read-state";
import { parseFolderPreferences } from "../folder/state";
import { object, text } from "../modules/manifest";
import { observeModuleDirectory } from "./read-applications";

// The Personalspace's workspace modules (launchpad-parity B11): on a preset
// that has a Personalspace (`local`, `hosted-personal`), the modules under
// `<Folder>/personalspace/<owner>/workspace/<module>/`, read by the same module
// reader as an Organization's (`observeModuleDirectory`), the glob the
// Machines gateway serves (`M:workloads/workspace-vm/gateway-catalog.py:106-107`).
// There is no Organization manifest: a directory with a `lazurio.module.json`
// is a module, its id is its directory name. The Personalspace is private
// (decision 0091): nothing here reads more than the owner directory's module
// declarations, and exactly one owner directory is read; with more than one,
// none is, because which one is the Principal's is not guessed.

/** The name the Personalspace group is addressed by: `personalspace/<module>`
 * in `lazurio module …`, `/o/personalspace` on the page, the `organization`
 * field of its modules. */
export const personalspaceName = "personalspace";

const moduleId = /^[a-z0-9][a-z0-9-]*$/;

/** Whether the Folder's recorded preset has a Personalspace. A Folder whose
 * state cannot be read has none (fail closed). The preset's Personalspace
 * policy never changes for a Folder: a workstation takes only `local`, a
 * personal VM only `hosted-personal`, a work VM only Organization presets
 * (`allowedPresets`). So the preferences are read without the Folder lock,
 * as `observeFolder` reads them: taking it would wait behind a mutation and
 * create a missing lock, and the catalog is a read that writes nothing. */
export async function folderHasPersonalspace(folder: string): Promise<boolean> {
  try {
    const preferences = parseFolderPreferences(
      await readStateJson(join(folder, ".lazurio"), "preferences.json"),
    );
    return workspacePreset(preferences.preset.name).personalspace === "present";
  } catch {
    return false;
  }
}

// Entries that may be directories, hidden ones left out as the resident's
// and the gateway's globs leave them out; a link is refused by the reader.
async function candidates(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        !entry.name.startsWith(".") &&
        (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const absent = (path: string) =>
  lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;
      throw error;
    },
  );

export type PersonalspaceLocation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "owner"; directory: string }>
  | Readonly<{
      kind: "blocked";
      reason: "personalspace-ambiguous" | "personalspace-unavailable";
    }>;

/** The owner directory of `<Folder>/personalspace/`: absent without one,
 * blocked with more than one or when it is not a real, caller-owned
 * directory. Its name is returned only to the caller, never shown. */
export async function locatePersonalspace(
  folder: string,
): Promise<PersonalspaceLocation> {
  const root = join(folder, personalspaceName);
  try {
    if (await absent(root)) return { kind: "absent" };
    await inspectCheckoutDirectory(root);
    const names = await candidates(root);
    if (names.length === 0) return { kind: "absent" };
    if (names.length > 1)
      return { kind: "blocked", reason: "personalspace-ambiguous" };
    const directory = join(root, names[0] as string);
    await inspectCheckoutDirectory(directory);
    return { kind: "owner", directory };
  } catch {
    return { kind: "blocked", reason: "personalspace-unavailable" };
  }
}

/** The ids of the modules in an owner directory: every directory in
 * `workspace/` named like a module id that holds a `lazurio.module.json`.
 * Throws when `workspace/` is not a real, caller-owned directory
 * (decision F23: its write bits are the operator's). */
export async function personalspaceModuleIds(space: string): Promise<string[]> {
  const workspace = join(space, "workspace");
  if (await absent(workspace)) return [];
  await inspectCheckoutDirectory(workspace);
  const ids = [];
  for (const name of await candidates(workspace))
    if (
      moduleId.test(name) &&
      !(await absent(join(workspace, name, "lazurio.module.json")))
    )
      ids.push(name);
  return ids;
}

/** One module of the owner directory `space`, by the shared module reader:
 * its declared id must be its directory name. Throws when it cannot be read. */
export async function observePersonalspaceModule(space: string, id: string) {
  const name = text(id, moduleId);
  await inspectCheckoutDirectory(space);
  const workspace = join(space, "workspace");
  await inspectCheckoutDirectory(workspace);
  const path = join(workspace, name);
  return {
    path,
    observed: await observeModuleDirectory(
      path,
      (module) => module.id === name,
    ),
  };
}

/** The lifecycle's authorization of a Personalspace app, the counterpart of
 * `resolveOrganizationApplication`, invoked again at every operation
 * boundary: `space` must still be the one owner directory of its Folder, the
 * module must declare the selected company and id, and the package must be a
 * declared app whose runtime names the module. */
export async function resolvePersonalspaceApplication(
  space: string,
  input: unknown,
) {
  const value = object(input, ["company", "module", "package"]);
  const company = text(value.company, /^[A-Za-z0-9][A-Za-z0-9-]*$/);
  const module = text(value.module, moduleId);
  const pkg = text(value.package, /\S/);
  const located = await locatePersonalspace(dirname(dirname(space)));
  if (located.kind !== "owner" || located.directory !== space)
    throw new Error("Selected Personalspace unavailable");
  const { path, observed } = await observePersonalspaceModule(space, module);
  if (
    observed.kind !== "module-observed" ||
    observed.company !== company ||
    !observed.apps.some(
      (app) => app.package === pkg && app.kind === "runtime-declared",
    )
  )
    throw new Error("Selected application unavailable");
  return Object.freeze({ moduleDirectory: path });
}
