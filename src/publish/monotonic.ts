import {
  emptyFloors,
  type FloorVector,
  type FloorViolation,
  factsOf,
  mergeFloors,
  type RoleFacts,
  violationOf,
} from "../update/floors";
import { loadRepository, type Repository, type Tree } from "./repository";

/** What an installed Lazurio refuses as `metadata-rollback`, asked BEFORE a
 * tree is published. There is one definition of "backwards" — the client's
 * floor vector (`src/update/floors.ts`, docs/update.md "The floor vector") —
 * and this module only feeds it: the facts of the currently published tree
 * become a vector, exactly as a Machine that has seen that tree holds it, and
 * every role of the candidate tree is held against it with the client's own
 * `violationOf`. Nothing here restates a rule.
 *
 * The publisher's operations cannot produce a violation by construction (every
 * rebuilt role gets the next version, `snapshot.meta` always lists
 * `targets.json`, nothing is removed). This is the check on the INPUT they
 * build on: a branch that was reset to an older commit would make "the next
 * version" a version clients have already seen with other content.
 */
function facts(repository: Repository): RoleFacts[] {
  const text = (loaded: { bytes: Buffer }) => loaded.bytes.toString("utf8");
  return [
    ...repository.roots.map((root) =>
      factsOf(`${root.version}.root.json`, text(root)),
    ),
    ...(repository.timestamp
      ? [factsOf("timestamp.json", text(repository.timestamp))]
      : []),
    ...(repository.snapshot
      ? [factsOf("snapshot.json", text(repository.snapshot))]
      : []),
    ...(repository.targets
      ? [factsOf("targets.json", text(repository.targets))]
      : []),
  ];
}

/** The vector of a Machine whose last successful check saw this tree. */
export async function floorsOf(tree: Tree): Promise<FloorVector> {
  const repository = await loadRepository(tree);
  return repository ? mergeFloors(emptyFloors, facts(repository)) : emptyFloors;
}

/** Every rule the candidate tree would break for a Machine that has seen the
 * published one. Empty: safe to publish. Both trees are verified as
 * repositories first (`loadRepository`), so this is never asked of metadata
 * nobody authenticated.
 */
export async function rollbackViolations(
  published: Tree,
  candidate: Tree,
): Promise<readonly FloorViolation[]> {
  const vector = await floorsOf(published);
  const repository = await loadRepository(candidate);
  if (!repository) return [];
  const violations: FloorViolation[] = [];
  for (const candidateFacts of facts(repository)) {
    const violation = violationOf(vector, candidateFacts);
    if (violation) violations.push(violation);
  }
  // A published root the candidate no longer holds breaks the chain clients
  // walk one link at a time.
  const held = new Set(repository.roots.map((root) => String(root.version)));
  for (const version of Object.keys(vector.root.retained))
    if (!held.has(version))
      violations.push({
        role: "root",
        rule: "root",
        floor: Number(version),
        offered: 0,
      });
  return violations;
}
