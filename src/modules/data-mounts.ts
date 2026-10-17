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
// identity reads it, under the Folder's content lock. A present one is only
// looked at: its origin and branch must be the declared ones, and it is never
// fetched, pulled, reset or rewritten. Nothing runs in the background, and an
// empty remote or a missing branch is never bootstrapped. Each failure
// refuses the start with its slot (`RequiredSlotRefused`): no access
// (`data-mount-denied`), something else at the place, which stays untouched
// (`data-mount-occupied`), GitHub or the lock not answering now, retried at
// the next start (`data-mount-unavailable`), or a clone that failed
// (`data-mount-clone-failed`).

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

export async function provideDataMounts(input: {
  /** The Folder, whose content lock a clone takes. */
  folder: string;
  organizationDirectory: string;
  moduleDirectory: string;
  host: DataMountHost;
  /** Whether this is a public Environment, where GitHub is not asked and a
   * clone is anonymous; read only for a module that declares a data mount. */
  anonymous: () => Promise<boolean>;
}): Promise<void> {
  const module = relative(input.organizationDirectory, input.moduleDirectory)
    .split(sep)
    .join("/");
  const documents = await readOrganizationDocuments(
    input.organizationDirectory,
  );
  if (
    documents.kind !== "documents-observed" ||
    documents.modules.kind !== "present"
  )
    throw new Error("Organization manifest unavailable");
  const slots = documents.modules.value.module_slots;
  const mounts = (Array.isArray(slots) ? slots : [])
    .map(dataMountOf)
    .filter((mount) => mount !== null && mount.parent === module);
  if (mounts.length === 0) return;
  const anonymous = await input.anonymous();
  for (const mount of mounts) {
    if (mount === null) continue;
    // A declared mount without a GitHub remote has nothing to clone from:
    // one that is there is left as it is, an absent one refuses the start.
    if (mount.repository === null) {
      if (await present(join(input.organizationDirectory, mount.path)))
        continue;
      throw new RequiredSlotRefused("data-mount-clone-failed", mount.path);
    }
    const outcome = await provideRepository({
      root: input.organizationDirectory,
      path: mount.path,
      repository: mount.repository,
      branch: mount.branch,
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
