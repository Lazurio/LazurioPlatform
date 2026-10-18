import { expect, test } from "bun:test";
import { parseMachineContext } from "../src/machine/context";
import {
  assignmentOf,
  vaultContextOf,
  vaultStateDirectory,
} from "../src/vault/context";
import { pilotContextOf, pilotVaultOf } from "../src/vault/legacy-0197/context";
import {
  ownAccount,
  vaultMember,
  vaultName,
  workAccount,
} from "./fixtures/fake-vault";
import { assignments, handoverEntry } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// The Environment's vault facts (decision F53): everything from the
// handover's `vault` member, nothing derived or guessed; and the 0197 pilot's
// facts, derived as F43 derived them, only where the handover names no
// vault. Invented hosts only.

const network = {
  headscale_server_url: "https://headscale.example.lazurio.io",
  headscale_hostname: "example",
};
const handover = (document: unknown) =>
  parseMachineContext(Buffer.from(JSON.stringify(document)));
const { team: _, ...withoutTeam } = organization.owner;
const personalVm = (vault: unknown = vaultMember()) =>
  handover({
    ...personal,
    network,
    entry: handoverEntry("example.lazurio.io"),
    ...(vault === null ? {} : { vault }),
  });
const workVm = (vault: unknown = vaultMember(workAccount, "Example work")) =>
  handover({
    ...organization,
    owner: { ...withoutTeam, assignment: assignments.operator },
    network: { ...network, headscale_hostname: "example-workspace" },
    entry: handoverEntry("workspace.example.lazurio.io"),
    ...(vault === null ? {} : { vault }),
  });

test("a personal Remote Environment's vault is exactly the handover's member", () => {
  expect(
    vaultContextOf({ handover: personalVm(), environment: "personal" }),
  ).toEqual({
    kind: "own",
    vault: "https://vaultwarden.example.lazurio.io",
    host: "vaultwarden.example.lazurio.io",
    account: ownAccount,
    name: vaultName,
    environment: "personal",
    organization: null,
    assignment: null,
  });
});

test("a work, Team or Automated Environment's vault names the Organization that owns it", () => {
  for (const environment of ["work", "team", "automated"] as const)
    expect(vaultContextOf({ handover: workVm(), environment })).toEqual({
      kind: "own",
      vault: "https://vaultwarden.example.lazurio.io",
      host: "vaultwarden.example.lazurio.io",
      account: workAccount,
      name: "Example work",
      environment,
      organization: "example",
      assignment: assignmentOf(workVm()),
    });
});

// Whom an Organization's Environment is assigned to, as the vault's state
// keeps it (DEV-6631 task 638b): a fingerprint of the Organization and the
// assignment's kind and GitHub id, so a renamed login is the same assignment
// and anything else is another one; a personal Environment has none.
test("the assignment's fingerprint changes with whom the Environment is assigned to, not with a login", () => {
  const assigned = (assignment: unknown, owner: object = withoutTeam) =>
    assignmentOf(
      handover({
        ...organization,
        owner: { ...owner, ...(assignment === null ? {} : { assignment }) },
        entry: handoverEntry("workspace.example.lazurio.io"),
      }),
    );
  const first = assigned(assignments.operator);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  // The same person under a new login is the same assignment.
  expect(
    assigned({ ...assignments.operator, github_login: "renamed-example" }),
  ).toBe(first);
  // Another person, another kind, no assignment, another Organization: each
  // is another assignment.
  const others = [
    assigned({ ...assignments.operator, github_id: 67890 }),
    assigned(assignments.automation),
    assigned(assignments.team),
    assigned(null),
    assigned(assignments.operator, { ...withoutTeam, organization: "other" }),
  ];
  expect(new Set([first, ...others]).size).toBe(others.length + 1);
  // Nothing of the person is in it.
  expect(first).not.toContain("example");
  expect(assignmentOf(personalVm())).toBeNull();
});

test("without the member the Environment has no vault yet, whatever else the handover says", () => {
  for (const document of [personalVm(null), workVm(null)])
    expect(
      vaultContextOf({ handover: document, environment: "personal" }),
    ).toEqual({ kind: "unsupported", reason: "no-vault" });
  // Neither the tailnet nor the address derives a vault any more.
  const { entry: _entry, ...noEntry } = {
    ...personal,
    network,
    vault: vaultMember(),
  } as Record<string, unknown>;
  expect(
    vaultContextOf({ handover: handover(noEntry), environment: "personal" }),
  ).toMatchObject({ kind: "own", account: ownAccount });
});

// An Organization's Environment reached without a private network: Machines
// writes no `network` for the work VMs of a public Organization (root
// decision 0204, its public-entry guests) and for no other, and a Lazurio
// Vaultwarden answers only inside its network (root decision 0203), so such
// an Environment has no vault by design, not yet (DEV-6631, F53's addendum
// of 2026-10-17).
test("an Organization's Environment without a tailnet has no vault by design; with one and no member, none yet", () => {
  const { network: _network, ...withoutNetwork } = organization;
  const publicVm = (vault: unknown = null) =>
    handover({
      ...withoutNetwork,
      owner: { ...withoutTeam, assignment: assignments.operator },
      entry: handoverEntry("workspace.example.lazurio.io"),
      ...(vault === null ? {} : { vault }),
    });
  for (const environment of ["work", "team", "automated"] as const) {
    expect(vaultContextOf({ handover: publicVm(), environment })).toEqual({
      kind: "unsupported",
      reason: "no-tailnet",
    });
    expect(vaultContextOf({ handover: workVm(null), environment })).toEqual({
      kind: "unsupported",
      reason: "no-vault",
    });
  }
  // A vault the handover names is the vault, tailnet or not.
  expect(
    vaultContextOf({
      handover: publicVm(vaultMember(workAccount, "Example work")),
      environment: "work",
    }),
  ).toMatchObject({ kind: "own", account: workAccount });
});

test("the pilot's vault is vaultwarden.<zone> of its headscale.<zone>, nothing else", () => {
  expect(pilotVaultOf("https://headscale.example.lazurio.io")).toBe(
    "https://vaultwarden.example.lazurio.io",
  );
  expect(pilotVaultOf("https://headscale.example.lazurio.io/")).toBe(
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
    expect([refused, pilotVaultOf(refused)]).toEqual([refused, null]);
});

test("the pilot's account is vaultwarden@<address>, and without an address or a vault there is no pilot", () => {
  expect(
    pilotContextOf({ handover: personalVm(null), environment: "personal" }),
  ).toEqual({
    kind: "pilot",
    vault: "https://vaultwarden.example.lazurio.io",
    host: "vaultwarden.example.lazurio.io",
    address: "example.lazurio.io",
    account: "vaultwarden@example.lazurio.io",
    environment: "personal",
    organization: null,
  });
  expect(
    pilotContextOf({ handover: workVm(null), environment: "work" }),
  ).toMatchObject({
    address: "workspace.example.lazurio.io",
    account: "vaultwarden@workspace.example.lazurio.io",
    organization: "example",
  });
  const { entry: _entry, ...noEntry } = { ...personal, network } as Record<
    string,
    unknown
  >;
  for (const document of [
    noEntry,
    {
      ...personal,
      network: {
        ...network,
        headscale_server_url: "https://network.example.invalid",
      },
      entry: handoverEntry("example.lazurio.io"),
    },
    // A personal VM whose entry names an Organization's address.
    {
      ...personal,
      network,
      entry: handoverEntry("workspace.example.lazurio.io"),
    },
    { ...personal, network, entry: handoverEntry("example.example.invalid") },
  ])
    expect(
      pilotContextOf({
        handover: handover(document),
        environment: "personal",
      }),
    ).toBeNull();
});

test("the account's state directory is keyed by the vault and the account, follows XDG_STATE_HOME when it is absolute, and refuses a path", () => {
  const host = "vaultwarden.example.lazurio.io";
  expect(vaultStateDirectory(host, ownAccount, "/home/operator", {})).toBe(
    `/home/operator/.local/state/lazurio/vault/${host}/${ownAccount}`,
  );
  expect(
    vaultStateDirectory(host, ownAccount, "/home/operator", {
      XDG_STATE_HOME: "/var/state/operator",
    }),
  ).toBe(`/var/state/operator/lazurio/vault/${host}/${ownAccount}`);
  expect(
    vaultStateDirectory(host, ownAccount, "/home/operator", {
      XDG_STATE_HOME: "relative/state",
    }),
  ).toBe(`/home/operator/.local/state/lazurio/vault/${host}/${ownAccount}`);
  // A pilot's directory (its address) is another one beside it.
  expect(
    vaultStateDirectory(host, "example.lazurio.io", "/home/operator", {}),
  ).not.toBe(vaultStateDirectory(host, ownAccount, "/home/operator", {}));
  for (const [refusedHost, key] of [
    [host, "../escape"],
    [host, ".."],
    [host, "a/b"],
    ["", ownAccount],
    [host, ""],
  ])
    expect(() =>
      vaultStateDirectory(
        refusedHost as string,
        key as string,
        "/home/operator",
        {},
      ),
    ).toThrow();
});
