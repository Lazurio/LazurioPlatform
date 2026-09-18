import type { ObservedFile } from "./reconcile";

// Internal single-output recovery decision, not a persisted journal schema.
// Caller must validate transaction ownership and revision under the shared lock.
// Matching bytes establish content only, never writer provenance, ownership or
// transaction completion. Those require separate evidence before any adoption.
export function instructionRecovery(
  beforeDigest: string | null,
  afterDigest: string,
  observed: ObservedFile,
): "matches-before" | "matches-after" | "conflict" | "invalid-transaction" {
  const valid = (value: string) => /^[a-f0-9]{64}$/.test(value);
  if (
    !valid(afterDigest) ||
    (beforeDigest !== null && !valid(beforeDigest)) ||
    beforeDigest === afterDigest
  )
    return "invalid-transaction";
  if (observed.kind === "unsafe") return "conflict";
  if (observed.kind === "absent")
    return beforeDigest === null ? "matches-before" : "conflict";
  if (!valid(observed.digest)) return "conflict";
  if (observed.digest === afterDigest) return "matches-after";
  if (observed.digest === beforeDigest) return "matches-before";
  return "conflict";
}
