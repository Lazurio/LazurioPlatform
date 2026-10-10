import { expect, test } from "bun:test";
import { parseMachineContext } from "../src/machine/context";
import {
  collectionNameOf,
  environmentNameOf,
  isEnvironmentCollection,
  vaultContextOf,
  vaultOriginOf,
  vaultStateDirectory,
} from "../src/vault/context";
import { assignments, handoverEntry } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// The Environment vault's facts (decision F43): the vault from the handover's
// tailnet control server, the account from the Environment's address, the
// collection from its name and machine. Invented hosts only.

const network = {
  headscale_server_url: "https://headscale.example.lazurio.io",
  headscale_hostname: "example",
};
const handover = (document: unknown) =>
  parseMachineContext(Buffer.from(JSON.stringify(document)));
const personalVm = handover({
  ...personal,
  network,
  entry: handoverEntry("example.lazurio.io"),
});
const { team: _, ...withoutTeam } = organization.owner;
const workVm = handover({
  ...organization,
  owner: { ...withoutTeam, assignment: assignments.operator },
  network: { ...network, headscale_hostname: "example-workspace" },
  entry: handoverEntry("workspace.example.lazurio.io"),
});
const teamVm = handover({
  ...organization,
  owner: { ...organization.owner, assignment: assignments.team },
  network: { ...network, headscale_hostname: "example-workspace" },
  entry: handoverEntry("workspace.example.lazurio.io"),
});

test("the vault of a network is vaultwarden.<zone> of its headscale.<zone>, nothing else", () => {
  expect(vaultOriginOf("https://headscale.example.lazurio.io")).toBe(
    "https://vaultwarden.example.lazurio.io",
  );
  expect(vaultOriginOf("https://headscale.example.lazurio.io/")).toBe(
    "https://vaultwarden.example.lazurio.io",
  );
  for (const refused of [
    "http://headscale.example.lazurio.io",
    "https://network.example.invalid",
    "https://headscale.lazurio",
    "https://headscale.example.lazurio.io:8443",
    "https://headscale.example.lazurio.io/path",
    "https://user@headscale.example.lazurio.io",
    "https://vaultwarden.example.lazurio.io",
    "https://xheadscale.example.lazurio.io",
    "not a url",
  ])
    expect([refused, vaultOriginOf(refused)]).toEqual([refused, null]);
});

test("a personal Remote Environment: its slug, its kind's name, the person's network", () => {
  expect(
    vaultContextOf({ handover: personalVm, kind: "personal", label: null }),
  ).toEqual({
    vault: "https://vaultwarden.example.lazurio.io",
    host: "vaultwarden.example.lazurio.io",
    address: "example.lazurio.io",
    account: "vaultwarden@example.lazurio.io",
    machine: "example",
    kind: "personal",
    name: "Osobní",
    collection: "Environmenty/Osobní · example",
    // A person owns it: no Organization's application reads its secrets.
    organization: null,
  });
});

test("a work, Team and Automated Environment: <machine>.<org> and the name the rail gives it", () => {
  expect(
    vaultContextOf({ handover: workVm, kind: "work", label: null }),
  ).toMatchObject({
    address: "workspace.example.lazurio.io",
    account: "vaultwarden@workspace.example.lazurio.io",
    machine: "workspace",
    name: "Pracovní",
    collection: "Environmenty/Pracovní · workspace",
    // The handover's owning Organization (decision F46).
    organization: "example",
  });
  expect(
    vaultContextOf({ handover: teamVm, kind: "team", label: "Team Sales" }),
  ).toMatchObject({
    name: "Team Sales",
    collection: "Environmenty/Team Sales · workspace",
  });
  // Without the catalog's label: the kind's name, as the rail shows it.
  expect(
    vaultContextOf({ handover: teamVm, kind: "team", label: null }),
  ).toMatchObject({ collection: "Environmenty/Týmový · workspace" });
  expect(
    vaultContextOf({ handover: workVm, kind: "automated", label: "Steward" }),
  ).toMatchObject({ collection: "Environmenty/Steward · workspace" });
});

test("without an entry, a tailnet or a known vault the context fails closed", () => {
  const { entry: _entry, ...noEntry } = { ...personal, network } as Record<
    string,
    unknown
  >;
  for (const [document, reason] of [
    [noEntry, "no-address"],
    [
      {
        ...personal,
        network: {
          ...network,
          headscale_server_url: "https://network.example.invalid",
        },
        entry: handoverEntry("example.lazurio.io"),
      },
      "vault-unknown",
    ],
    // A personal VM whose entry names an Organization's address.
    [
      {
        ...personal,
        network,
        entry: handoverEntry("workspace.example.lazurio.io"),
      },
      "no-address",
    ],
    // An entry outside lazurio.io.
    [
      { ...personal, network, entry: handoverEntry("example.example.invalid") },
      "no-address",
    ],
  ] as const)
    expect(
      vaultContextOf({
        handover: handover(document),
        kind: "personal",
        label: null,
      }),
    ).toEqual({ kind: "unsupported", reason });
  const { network: _network, ...noNetwork } = organization;
  expect(
    vaultContextOf({
      handover: handover({
        ...noNetwork,
        entry: handoverEntry("workspace.example.lazurio.io"),
      }),
      kind: "work",
      label: null,
    }),
  ).toEqual({ kind: "unsupported", reason: "no-network" });
});

test("the collection is the Environment's by its machine; a label that would nest is not used", () => {
  expect(collectionNameOf("Osobní", "example")).toBe(
    "Environmenty/Osobní · example",
  );
  const context = { machine: "workspace" };
  for (const [name, own] of [
    ["Environmenty/Pracovní · workspace", true],
    ["Environmenty/Team Sales · workspace", true],
    ["Environmenty/ · workspace", false],
    ["Environmenty/Pracovní · workspace-2", false],
    ["Infrastruktura", false],
    ["Pracovní · workspace", false],
  ] as const)
    expect([name, isEnvironmentCollection(name, context)]).toEqual([name, own]);
  expect(environmentNameOf("team", "Sales/EU")).toBe("Týmový");
  expect(environmentNameOf("team", " ")).toBe("Týmový");
  expect(environmentNameOf("team", "Team\u0007")).toBe("Týmový");
  expect(environmentNameOf("automated", "Steward")).toBe("Steward");
});

test("the account's state directory is its whole identity and follows XDG_STATE_HOME when it is absolute", () => {
  const identity = {
    host: "vaultwarden.example.lazurio.io",
    address: "workspace.example.lazurio.io",
  };
  expect(vaultStateDirectory(identity, "/home/operator", {})).toBe(
    "/home/operator/.local/state/lazurio/vault/vaultwarden.example.lazurio.io/workspace.example.lazurio.io",
  );
  expect(
    vaultStateDirectory(identity, "/home/operator", {
      XDG_STATE_HOME: "/var/state/operator",
    }),
  ).toBe(
    "/var/state/operator/lazurio/vault/vaultwarden.example.lazurio.io/workspace.example.lazurio.io",
  );
  expect(
    vaultStateDirectory(identity, "/home/operator", {
      XDG_STATE_HOME: "relative/state",
    }),
  ).toBe(
    "/home/operator/.local/state/lazurio/vault/vaultwarden.example.lazurio.io/workspace.example.lazurio.io",
  );
  // Another address in the same vault is another directory.
  expect(
    vaultStateDirectory(
      { ...identity, address: "workspace-2.example.lazurio.io" },
      "/home/operator",
      {},
    ),
  ).not.toBe(vaultStateDirectory(identity, "/home/operator", {}));
});
