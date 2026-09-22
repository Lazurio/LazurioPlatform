import { type OutputPath, outputPaths } from "./outputs";

// Pure planner for the generated outputs. Filesystem inventory, identity,
// locks and application belong to the local core.
export type ObservedFile =
  | { kind: "absent" }
  | { kind: "regular"; digest: string }
  | { kind: "unsafe" };

export type BlockedPlan = {
  kind: "blocked";
  reason: "invalid-digest" | "unsafe-path" | "unowned-file" | "drift";
  path: OutputPath;
};

export type InstructionPlan =
  | BlockedPlan
  | { kind: "unchanged" }
  | { kind: "create" | "replace" | "remove"; path: OutputPath };

// One file. null means no prior ownership / no desired output, never an unknown
// digest. A manifest claim alone cannot authorize replacing current, divergent
// bytes. A refusal names the file so the operator can act on it.
export function planInstructions(
  path: OutputPath,
  previousDigest: string | null,
  desiredDigest: string | null,
  observed: ObservedFile,
): InstructionPlan {
  const digests = [previousDigest, desiredDigest];
  if (observed.kind === "regular") digests.push(observed.digest);
  if (
    digests.some((digest) => digest !== null && !/^[a-f0-9]{64}$/.test(digest))
  )
    return { kind: "blocked", reason: "invalid-digest", path };
  if (observed.kind === "unsafe")
    return { kind: "blocked", reason: "unsafe-path", path };
  if (previousDigest === null) {
    if (observed.kind !== "absent")
      return { kind: "blocked", reason: "unowned-file", path };
    return desiredDigest === null
      ? { kind: "unchanged" }
      : { kind: "create", path };
  }
  if (observed.kind === "absent" || observed.digest !== previousDigest)
    return { kind: "blocked", reason: "drift", path };
  if (desiredDigest === previousDigest) return { kind: "unchanged" };
  return { kind: desiredDigest === null ? "remove" : "replace", path };
}

export type FolderPlan =
  | BlockedPlan
  | { kind: "unchanged" }
  | {
      kind: "write";
      files: readonly { kind: "create" | "replace"; path: OutputPath }[];
    };

// All outputs as one plan: the first refusal wins and names its file; otherwise
// the files that would be created or replaced, or nothing at all.
export function planOutputs(
  previous: Readonly<Partial<Record<OutputPath, string>>>,
  desired: Readonly<Record<OutputPath, string>>,
  observed: Readonly<Record<OutputPath, ObservedFile>>,
): FolderPlan {
  const files: { kind: "create" | "replace"; path: OutputPath }[] = [];
  for (const path of outputPaths) {
    const plan = planInstructions(
      path,
      previous[path] ?? null,
      desired[path],
      observed[path],
    );
    if (plan.kind === "blocked") return plan;
    if (plan.kind === "create" || plan.kind === "replace")
      files.push({ kind: plan.kind, path });
  }
  return files.length === 0 ? { kind: "unchanged" } : { kind: "write", files };
}
