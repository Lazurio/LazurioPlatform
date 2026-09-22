import { createHash } from "node:crypto";
import { machineBinding } from "../../src/machine/binding";
import { parseMachineContext } from "../../src/machine/context";
import organization from "./machine-context.json";
import personal from "./machine-context-personal.json";

// The v0.12.61 fields as Machines writes them: the assignment copied from the
// owner overlay, and the peers derived from the Conglomerate Host grants.
export const assignments = Object.freeze({
  operator: { kind: "operator", github_login: "example", github_id: 12345 },
  team: { kind: "team" },
} as const);
// A work VM of operator `example`: their laptop and personal VM may reach it,
// it reaches the Conglomerate Host gateway over HTTPS and nothing over SSH.
export const workRelationships = Object.freeze({
  zone: "work",
  peers: [
    {
      name: "example-laptop",
      kind: "client-device",
      zone: "personal",
      organization: null,
      ssh: {
        host: "example-laptop.tailnet.example.invalid",
        user: null,
        direction: "inbound",
      },
      https: [],
    },
    {
      name: "example",
      kind: "personal-vm",
      zone: "personal",
      organization: null,
      ssh: {
        host: "example.tailnet.example.invalid",
        user: "operator",
        direction: "inbound",
      },
      https: [],
    },
    {
      name: "example-gateway",
      kind: "conglomerate-host",
      zone: null,
      organization: "example",
      ssh: null,
      https: ["auth.example.lazurio.io"],
    },
  ],
} as const);
// The personal VM of `example`: both ways with their laptop, outbound to
// their work VM and its Launchpad.
export const personalRelationships = Object.freeze({
  zone: "personal",
  peers: [
    {
      name: "example-laptop",
      kind: "client-device",
      zone: "personal",
      organization: null,
      ssh: {
        host: "example-laptop.tailnet.example.invalid",
        user: null,
        direction: "both",
      },
      https: [],
    },
    {
      name: "example-workspace",
      kind: "workspace-vm",
      zone: "work",
      organization: "example",
      ssh: {
        host: "example-workspace.tailnet.example.invalid",
        user: "operator",
        direction: "outbound",
      },
      https: ["launchpad.example-workspace.example.lazurio.io"],
    },
  ],
} as const);

// The handover shapes the presets derive from, projected exactly as the
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
  // v0.12.59 shapes: a Team without assignment, and no Team at all.
  team: binding(organization),
  organization: binding({ ...organization, owner: withoutTeam }),
  // v0.12.61 shapes: the Team-bearing canary resolved by owner.assignment.
  assignedOperator: binding({
    ...organization,
    owner: { ...organization.owner, assignment: assignments.operator },
  }),
  assignedTeam: binding({
    ...organization,
    owner: { ...organization.owner, assignment: assignments.team },
  }),
  related: binding({
    ...organization,
    owner: withoutTeam,
    relationships: workRelationships,
  }),
  personalRelated: binding({
    ...personal,
    relationships: personalRelationships,
  }),
});
