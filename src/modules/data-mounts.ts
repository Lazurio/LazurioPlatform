import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ContentGit } from "../content/git";
import type { ContentGitHub } from "../content/github";
import { tryContentLock } from "../content/lock";
import { dataMountOf, provideRepository } from "../content/provide";
import { readOrganizationDocuments } from "../organizations/read-documents";
import { RequiredSlotRefused } from "./sibling-origins";

// A module provides its own data (launchpad-parity B7): before its app is
// prepared or started, every repository database the Organization manifest
// declares directly below the module (`materialization:
// "repository_db_mount"`, `workspace/<module>/db` or `mission-control/db`) is
// required for it, as a slot of `required_module_slots` is. An absent one is
// cloned on its declared branch by the same function as content
// installation (`provideRepository`), as this Environment's own GitHub
// identity reads it, under the Folder's content lock; an empty directory at
// its place counts as absent. Any checkout already there is used as it is,
// whatever its origin or branch: it is never fetched, pulled, reset or
// rewritten, and never refuses the start. Nothing runs in the background, and
// an empty remote or a missing branch is never bootstrapped. Providing an
// absent one can fail, which refuses the start with its slot
// (`RequiredSlotRefused`): no access (`data-mount-denied`), something that is
// no checkout at the place (a non-empty directory, a file, a link), which
// stays untouched (`data-mount-occupied`), GitHub or the lock not answering
// now, retried at the next start (`data-mount-unavailable`), or a clone that
// failed (`data-mount-clone-failed`).

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** What provides a module's data: this Environment's GitHub and git and the
 * install base's content locks. Trusted composition, never request input. */
export type DataMountHost = Readonly<{
  github: ContentGitHub;
  git: ContentGit;
  lockDirectory: string;
}>;

/** The data mounts the Organization manifest declares directly below a
 * module, as `dataMountOf` reads them: what its app reads beside its own
 * checkout (also the inputs of a static app's build, decision F58). */
export async function moduleDataMounts(
  organizationDirectory: string,
  moduleDirectory: string,
) {
  const module = relative(organizationDirectory, moduleDirectory)
    .split(sep)
    .join("/");
  const documents = await readOrganizationDocuments(organizationDirectory);
  if (
    documents.kind !== "documents-observed" ||
    documents.modules.kind !== "present"
  )
    throw new Error("Organization manifest unavailable");
  const slots = documents.modules.value.module_slots;
  return (Array.isArray(slots) ? slots : [])
    .map(dataMountOf)
    .filter((mount) => mount !== null && mount.parent === module);
}

export async function provideDataMounts(input: {
  /** The Folder, whose content lock a clone takes. */
  folder: string;
  organizationDirectory: string;
  moduleDirectory: string;
  host: DataMountHost;
  /** Whether this is a public Environment, where GitHub is not asked and a
   * clone is anonymous; read only when a data mount is to be cloned. */
  anonymous: () => Promise<boolean>;
}): Promise<void> {
  const mounts = await moduleDataMounts(
    input.organizationDirectory,
    input.moduleDirectory,
  );
  // Asked only when a mount is to be cloned.
  let anonymous: boolean | undefined;
  for (const mount of mounts) {
    if (mount === null) continue;
    // A checkout there, of any repository on any branch, starts as before.
    if (
      (
        await input.host.git.inspect(
          join(input.organizationDirectory, mount.path),
        )
      ).kind === "checkout"
    )
      continue;
    // A declared mount without a GitHub remote has nothing to clone from:
    // one that is there is left as it is, an absent one refuses the start.
    if (mount.repository === null) {
      if (await present(join(input.organizationDirectory, mount.path)))
        continue;
      throw new RequiredSlotRefused("data-mount-clone-failed", mount.path);
    }
    anonymous ??= await input.anonymous();
    const outcome = await provideRepository({
      root: input.organizationDirectory,
      path: mount.path,
      repository: mount.repository,
      branch: mount.branch,
      fillEmptyDirectory: true,
      anyCheckoutPresent: true,
      git: input.host.git,
      github: anonymous ? "anonymous" : input.host.github,
      lock: () => tryContentLock(input.host.lockDirectory, input.folder),
    });
    switch (outcome.result) {
      case "materialized":
      case "present":
        continue;
      case "denied":
        throw new RequiredSlotRefused("data-mount-denied", mount.path);
      case "unavailable":
        throw new RequiredSlotRefused("data-mount-unavailable", mount.path);
      case "blocked":
        throw new RequiredSlotRefused("data-mount-occupied", mount.path);
      case "failed":
        throw new RequiredSlotRefused("data-mount-clone-failed", mount.path);
    }
  }
}
