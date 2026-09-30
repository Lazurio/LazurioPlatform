import type { MessageKey } from "./messages";
import { fill } from "./update-view";

// The recorded assignment of an Organization work VM as the Launchpad's
// "This Environment" shows it, in the words the Folder renders it with
// (src/folder/render.ts assignmentLine). `automation` is the Automated
// Environment of an Organization persona (decision 0169), named by its
// responsible operator.
export type AssignmentView =
  | Readonly<{
      kind: "operator" | "automation";
      githubLogin: string;
      githubId: number;
    }>
  | Readonly<{ kind: "team" }>;

export function assignmentText(
  assignment: AssignmentView,
  copy: Readonly<
    Record<
      Extract<
        MessageKey,
        "machineAssignmentTeam" | "machineAssignmentAutomation"
      >,
      string
    >
  >,
): string {
  if (assignment.kind === "team") return copy.machineAssignmentTeam;
  const operator = `${assignment.githubLogin} (GitHub id ${assignment.githubId})`;
  return assignment.kind === "automation"
    ? fill(copy.machineAssignmentAutomation, { operator })
    : operator;
}
