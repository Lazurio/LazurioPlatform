import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { readFolderState } from "../folder/read-state";
import type { FolderPreferences } from "../folder/state";
import type { OrganizationTool } from "../organizations/organization-settings";
import {
  type OrganizationToolItem,
  type OrganizationToolsInput,
  provisionOrganizationTools,
} from "../tools/organization-tools";
import type { ToolsEnvironment } from "../tools/overview";
import { organizationGoverns } from "./governance";
import { type GitReader, operatorGit, readRepositorySettings } from "./local";

// Which tools the Organization of this Environment declares (decision F73):
// on an Organization's Environment (work, Team, Automated), the
// `settings.tools` of the Organization its handover names as owner, read
// from that Organization's root in the Folder, the same document and the
// same reader as the settings of decision F45 without the relay. Read from
// Git, not from the Dashboard's answer, and only at the commit the content
// part of the same `lazurio update` verified as what the Organization
// published: the root's `main` on its remote's commit, current or just
// fast-forwarded to it. A root that part left anywhere else (ahead,
// diverged, dirty, busy, failed, not run) gives no declaration at all, so
// a commit nobody published, a local one included, never installs anything
// (review of #992). Doctor, which installs nothing, reads the local `main`.
// A personal Environment and the person's own computer read nothing: the
// Organization's settings never govern them (root decision 0194).

export const organizationToolsNotRunReasons = [
  "not-governed",
  /** The content part did not verify the root on its published commit in
   * this run. */
  "not-published",
  "organization-absent",
  "settings-invalid",
  "settings-unreadable",
] as const;
export type OrganizationToolsNotRun =
  (typeof organizationToolsNotRunReasons)[number];

export type DeclaredOrganizationTools =
  | Readonly<{
      kind: "declared";
      /** The owner Organization's GitHub login. */
      organization: string;
      /** The commit of its `main` they were read at. */
      version: string;
      /** Empty when it declares none. */
      tools: readonly OrganizationTool[];
    }>
  | Readonly<{ kind: "not-run"; reason: OrganizationToolsNotRun }>;

export async function declaredOrganizationTools(
  folder: string,
  tools: ToolsEnvironment,
  published: ReadonlyMap<string, string> | undefined,
  git: GitReader = operatorGit(tools),
): Promise<DeclaredOrganizationTools> {
  const state = join(folder, ".lazurio");
  let preferences: FolderPreferences;
  try {
    ({ preferences } = await withFolderReadLock(state, () =>
      readFolderState(state),
    ));
  } catch {
    return Object.freeze({
      kind: "not-run" as const,
      reason: "settings-unreadable" as const,
    });
  }
  return declaredToolsOf(folder, preferences, git, published);
}

/** The same, for a reader that has the Folder's preferences already and
 * must not take its lock (`lazurio doctor`, which never creates one).
 * `published`: the roots' commits this run verified as published (see
 * `readRepositorySettings`); without it, the local `main`. */
export async function declaredToolsOf(
  folder: string,
  preferences: Pick<FolderPreferences, "preset" | "machine">,
  git: GitReader,
  published?: ReadonlyMap<string, string>,
): Promise<DeclaredOrganizationTools> {
  const owner = preferences.machine?.owner;
  if (
    !organizationGoverns(preferences.preset.name) ||
    owner?.kind !== "organization"
  )
    return Object.freeze({
      kind: "not-run" as const,
      reason: "not-governed" as const,
    });
  const read = await readRepositorySettings(
    folder,
    owner.organization,
    git,
    published,
  );
  if (read.kind === "invalid")
    return Object.freeze({
      kind: "not-run" as const,
      reason: "settings-invalid" as const,
    });
  if (read.kind !== "settings")
    return Object.freeze({
      kind: "not-run" as const,
      reason:
        read.kind === "failed" && read.detail === "organization-absent"
          ? ("organization-absent" as const)
          : read.kind === "failed" && read.detail === "not-published"
            ? ("not-published" as const)
            : ("settings-unreadable" as const),
    });
  return Object.freeze({
    kind: "declared" as const,
    organization: owner.organization,
    version: read.settings.version,
    tools: read.settings.values.tools ?? Object.freeze([]),
  });
}

/** The Organization's tools part of one `lazurio update` (decision F73):
 * the declaration of this Environment's Organization at the commit this
 * run's content part verified as published (`published`), provisioned. The
 * CLI and the Launchpad's update run it alike. */
export async function provisionDeclaredTools(
  folder: string,
  tools: ToolsEnvironment,
  onStep: NonNullable<OrganizationToolsInput["onStep"]>,
  published: ReadonlyMap<string, string>,
): Promise<
  | Readonly<{ kind: "provisioned"; items: readonly OrganizationToolItem[] }>
  | Readonly<{ kind: "not-run"; reason: OrganizationToolsNotRun }>
> {
  const declared = await declaredOrganizationTools(folder, tools, published);
  if (declared.kind === "not-run") return declared;
  return Object.freeze({
    kind: "provisioned" as const,
    items: await provisionOrganizationTools({
      tools: declared.tools,
      path: tools.path,
      home: tools.home,
      xdg: tools.xdg,
      platform: tools.platform,
      run: tools.run,
      onStep,
    }),
  });
}
