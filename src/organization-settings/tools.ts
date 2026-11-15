import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { readFolderState } from "../folder/read-state";
import type {
  OrganizationTool,
  OrganizationToolId,
} from "../organizations/organization-settings";
import {
  type OrganizationToolItem,
  provisionOrganizationTools,
} from "../tools/organization-tools";
import type { ToolsEnvironment } from "../tools/overview";
import { organizationGoverns } from "./governance";
import { type GitReader, operatorGit, readRepositorySettings } from "./local";

// Which tools the Organization of this Environment declares (decision F73):
// on an Organization's Environment (work, Team, Automated), the
// `settings.tools` of the Organization its handover names as owner, read
// from that Organization's root in the Folder at the commit of its `main`,
// the same document and the same reader as the settings of decision F45
// without the relay. Read from Git, not from the Dashboard's answer: the
// content part of the same `lazurio update` has just brought that `main` to
// what the Organization published, and a tool waits for no other service.
// A personal Environment and the person's own computer read nothing: the
// Organization's settings never govern them (root decision 0194).

export const organizationToolsNotRunReasons = [
  "not-governed",
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
  git: GitReader = operatorGit(tools),
): Promise<DeclaredOrganizationTools> {
  const state = join(folder, ".lazurio");
  let preferences: Awaited<ReturnType<typeof readFolderState>>["preferences"];
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
  const owner = preferences.machine?.owner;
  if (
    !organizationGoverns(preferences.preset.name) ||
    owner?.kind !== "organization"
  )
    return Object.freeze({
      kind: "not-run" as const,
      reason: "not-governed" as const,
    });
  const read = await readRepositorySettings(folder, owner.organization, git);
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
 * the declaration of this Environment's Organization, provisioned. The CLI
 * and the Launchpad's update run it alike. */
export async function provisionDeclaredTools(
  folder: string,
  tools: ToolsEnvironment,
  onStep: (tool: OrganizationToolId, step: "installing" | "updating") => void,
): Promise<
  | Readonly<{ kind: "provisioned"; items: readonly OrganizationToolItem[] }>
  | Readonly<{ kind: "not-run"; reason: OrganizationToolsNotRun }>
> {
  const declared = await declaredOrganizationTools(folder, tools);
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
