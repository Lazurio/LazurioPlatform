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

// Machines 0.12.93: the entry as its renderer writes it from the gateway's
// route catalog, for the Machine hostname `host` (an Organization work VM:
// `<vm>.<org>.lazurio.io`; a personal VM: `<login>.lazurio.io`).
export function handoverEntry(host: string, listenPort = 20000) {
  return {
    launchpad: {
      external_origin: `https://launchpad.${host}`,
      auth_check_url: `https://${host}/oauth2/auth`,
      auth_cookie_name: "__Secure-lazurio-workspace",
      listen_port: listenPort,
    },
    t3code: { external_origin: `https://t3code.${host}` },
    modules: { origin_template: `https://{module}.${host}` },
  };
}
export const entries = Object.freeze({
  organization: handoverEntry("workspace.example.lazurio.io"),
  personal: handoverEntry("example.lazurio.io"),
});

// The handover shapes the presets derive from, projected exactly as the
// machine CLI would project a validated root-issued document.
export function binding(document: unknown) {
  const bytes = Buffer.from(JSON.stringify(document));
  return machineBinding(
    parseMachineContext(bytes),
    createHash("sha256").update(bytes).digest("hex"),
  );
}
const { team: _, ...withoutTeam } = organization.owner;
// An Organization work VM of one operator (no Team) with its entry on `port`.
export function organizationWithEntry(listenPort = 20000) {
  return binding({
    ...organization,
    owner: withoutTeam,
    entry: handoverEntry("workspace.example.lazurio.io", listenPort),
  });
}
// A personal VM of `example` with its entry on `port`.
export function personalWithEntry(listenPort = 20000) {
  return binding({
    ...personal,
    entry: handoverEntry("example.lazurio.io", listenPort),
  });
}
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
  // Machines 0.12.93 shapes: the entry on both lanes.
  organizationEntry: organizationWithEntry(),
  personalEntry: binding({ ...personal, entry: entries.personal }),
});
