import { createHash } from "node:crypto";
import { machineBinding } from "../../src/machine/binding";
import { parseMachineContext } from "../../src/machine/context";
import organization from "./machine-context.json";
import personal from "./machine-context-personal.json";

// The three handover shapes the presets derive from, projected exactly as the
// machine CLI would project a validated root-issued document.
function binding(document: unknown) {
  const bytes = Buffer.from(JSON.stringify(document));
  return machineBinding(
    parseMachineContext(bytes),
    createHash("sha256").update(bytes).digest("hex"),
  );
}
const { team: _, ...withoutTeam } = organization.owner;
export const bindings = Object.freeze({
  personal: binding(personal),
  team: binding(organization),
  organization: binding({ ...organization, owner: withoutTeam }),
});
