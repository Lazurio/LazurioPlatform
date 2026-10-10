import { createHash } from "node:crypto";
import { machineBinding } from "../../src/machine/binding";
import { parseMachineContext } from "../../src/machine/context";
import organization from "./machine-context.json";
import personal from "./machine-context-personal.json";

// The v0.12.61 fields as Machines writes them: the assignment copied from the
// owner overlay, and the peers derived from the Conglomerate Host grants.
// `automation` (Machines #277, decision 0169) names the responsible operator
// of an Automated Environment, with the operator's shape.
export const assignments = Object.freeze({
  operator: { kind: "operator", github_login: "example", github_id: 12345 },
  team: { kind: "team" },
  automation: { kind: "automation", github_login: "example", github_id: 12345 },
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
// Root decision 0191 (F38): the entry of a Machine whose roster routes the
// Environment browser's view, as Machines writes `entry.browser`.
export function withBrowser(
  entry: ReturnType<typeof handoverEntry>,
  host: string,
  listenPort = 4848,
) {
  return {
    ...entry,
    browser: {
      external_origin: `https://browser.${host}`,
      listen_port: listenPort,
    },
  };
}

// Root decision 0194 (DEV-6653, contract C3): the entry of an Organization
// work VM that declares its own identity, as Machines writes
// `entry.environment_relay` (Machines #449).
export const environmentRelaySocket = "/run/lazurio-environment/relay.sock";
export function withEnvironmentRelay<T extends object>(
  entry: T,
  socket = environmentRelaySocket,
) {
  return { ...entry, environment_relay: { socket } };
}

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
// An Organization work VM of one operator (no Team) with its entry on `port`,
// for the Machine hostname `host`; with `browser`, the entry also routes the
// Environment browser's view (root decision 0191).
export function organizationWithEntry(
  listenPort = 20000,
  host = "workspace.example.lazurio.io",
  browser = false,
) {
  const entry = handoverEntry(host, listenPort);
  return binding({
    ...organization,
    owner: withoutTeam,
    entry: browser ? withBrowser(entry, host) : entry,
  });
}
// An Organization work VM of one operator whose entry, on `port`, carries
// the Environment's relay to the Dashboard (root decision 0194, Machines
// #449).
export function organizationWithRelay(
  listenPort = 20000,
  host = "workspace.example.lazurio.io",
) {
  return binding({
    ...organization,
    owner: withoutTeam,
    entry: withEnvironmentRelay(handoverEntry(host, listenPort)),
  });
}
// A personal VM of `example` with its entry on `port`, and with `browser`
// the Environment browser's view.
export function personalWithEntry(listenPort = 20000, browser = false) {
  const host = "example.lazurio.io";
  const entry = handoverEntry(host, listenPort);
  return binding({
    ...personal,
    entry: browser ? withBrowser(entry, host) : entry,
  });
}
// The Automated Environment of decision 0169 as the binding records it: a work
// VM of an Organization persona with one responsible operator, projected from
// the handover's `owner.assignment` of kind `automation`.
export const automationAssignment = Object.freeze({
  kind: "automation",
  githubLogin: "example",
  githubId: 12345,
} as const);
const assignedOperator = binding({
  ...organization,
  owner: { ...organization.owner, assignment: assignments.operator },
});
export const bindings = Object.freeze({
  personal: binding(personal),
  // v0.12.59 shapes: a Team without assignment, and no Team at all.
  team: binding(organization),
  organization: binding({ ...organization, owner: withoutTeam }),
  // v0.12.61 shapes: the Team-bearing canary resolved by owner.assignment.
  assignedOperator,
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
  // Decision 0169: the Automated Environment, projected from its handover.
  automated: binding({
    ...organization,
    owner: { ...organization.owner, assignment: assignments.automation },
  }),
  // A Team Environment and an Automated Environment with their entry.
  teamEntry: binding({ ...organization, entry: entries.organization }),
  // Root decision 0191: the entry with the Environment browser's view, on a
  // work Environment of one operator, a Team Environment and a personal one.
  organizationBrowser: binding({
    ...organization,
    owner: withoutTeam,
    entry: withBrowser(entries.organization, "workspace.example.lazurio.io"),
  }),
  teamBrowser: binding({
    ...organization,
    entry: withBrowser(entries.organization, "workspace.example.lazurio.io"),
  }),
  personalBrowser: binding({
    ...personal,
    entry: withBrowser(entries.personal, "example.lazurio.io"),
  }),
  automatedEntry: binding({
    ...organization,
    owner: { ...organization.owner, assignment: assignments.automation },
    entry: entries.organization,
  }),
  // Root decision 0194 (DEV-6653): the entry with the Environment's relay to
  // the Dashboard, on a work Environment of one operator and, as a schema
  // could carry it, on a personal one (which ignores Organization settings).
  organizationRelay: binding({
    ...organization,
    owner: withoutTeam,
    entry: withEnvironmentRelay(entries.organization),
  }),
  personalRelay: binding({
    ...personal,
    entry: withEnvironmentRelay(entries.personal),
  }),
});
