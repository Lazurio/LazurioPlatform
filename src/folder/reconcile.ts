// Pure first consumer: reconcile the generated base instruction file only.
// Filesystem inventory, identity, locks and application belong to the local core.
export type ObservedFile =
  | { kind: "absent" }
  | { kind: "regular"; digest: string }
  | { kind: "unsafe" };

export type InstructionPlan =
  | {
      kind: "blocked";
      reason: "invalid-digest" | "unsafe-path" | "unowned-file" | "drift";
    }
  | { kind: "unchanged" }
  | { kind: "create" | "replace" | "remove"; path: "AGENTS.md" };

// null means no prior ownership / no desired output, never an unknown digest.
// A manifest claim alone cannot authorize replacing current, divergent bytes.
export function planInstructions(
  previousDigest: string | null,
  desiredDigest: string | null,
  observed: ObservedFile,
): InstructionPlan {
  const digests = [previousDigest, desiredDigest];
  if (observed.kind === "regular") digests.push(observed.digest);
  if (
    digests.some((digest) => digest !== null && !/^[a-f0-9]{64}$/.test(digest))
  )
    return { kind: "blocked", reason: "invalid-digest" };
  if (observed.kind === "unsafe")
    return { kind: "blocked", reason: "unsafe-path" };
  if (previousDigest === null) {
    if (observed.kind !== "absent")
      return { kind: "blocked", reason: "unowned-file" };
    return desiredDigest === null
      ? { kind: "unchanged" }
      : { kind: "create", path: "AGENTS.md" };
  }
  if (observed.kind === "absent" || observed.digest !== previousDigest)
    return { kind: "blocked", reason: "drift" };
  if (desiredDigest === previousDigest) return { kind: "unchanged" };
  return {
    kind: desiredDigest === null ? "remove" : "replace",
    path: "AGENTS.md",
  };
}
