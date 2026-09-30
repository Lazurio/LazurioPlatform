import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseMachineBinding } from "../src/folder/machine-binding";
import {
  allowedPresets,
  derivePreset,
  machineAssignment,
  parsePresetReference,
  presetNames,
  presetProfile,
  presetReference,
  selectablePresets,
  validatePresetComposition,
  workspacePreset,
} from "../src/folder/presets";
import { parseFolderPreferences } from "../src/folder/state";
import { machineBinding } from "../src/machine/binding";
import { parseMachineContext } from "../src/machine/context";
import {
  automationAssignment,
  binding,
  bindings,
  workRelationships,
} from "./fixtures/machine-bindings";
import organizationDocument from "./fixtures/machine-context.json";
import personalDocument from "./fixtures/machine-context-personal.json";

const machines = {
  workstation: null,
  "personal-vm": bindings.personal,
  "workspace-vm with owner.team, no assignment": bindings.team,
  "workspace-vm without owner.team, no assignment": bindings.organization,
  "workspace-vm with owner.team assigned to one operator":
    bindings.assignedOperator,
  "workspace-vm with owner.team assigned to the Team": bindings.assignedTeam,
  "workspace-vm without owner.team assigned to the Team": parseMachineBinding({
    ...bindings.organization,
    owner: { ...bindings.organization.owner, assignment: { kind: "team" } },
  }),
  "workspace-vm without owner.team, with relationships": bindings.related,
  "workspace-vm with owner.team of a persona with one responsible operator":
    bindings.automated,
  "workspace-vm without owner.team of a persona with one responsible operator":
    parseMachineBinding({
      ...bindings.organization,
      owner: {
        ...bindings.organization.owner,
        assignment: automationAssignment,
      },
    }),
} as const;
// Every Organization preset is allowed on every workspace VM; the assignment
// selects which one is derived (F10). The Automated Environment of decision
// 0169 adds the third. A stored preset is valid within this allow-list.
const organizationPresets = [
  "hosted-organization-personal",
  "hosted-organization-team",
  "hosted-organization-steward",
] as const;

// Derivation is a function of machine.kind and the assignment. Since Machines
// v0.12.61 `owner.assignment` is the only selector when present; without it
// the handover proves only that a VM without a Team is one operator's. A Team
// alone proves nothing about assignment (an Organization may model one
// operator's VM as a Team named after them), so that handover derives no
// preset and every choice on it is explicit. Relationships never take part.
// A NEW choice (issue #107) is narrowed to the derived preset whenever the
// handover states `owner.assignment`; without it the choice is the allow-list.
test.each([
  ["workstation", null, "local", ["local"], ["local"]],
  [
    "personal-vm",
    "operator",
    "hosted-personal",
    ["hosted-personal"],
    ["hosted-personal"],
  ],
  [
    "workspace-vm with owner.team, no assignment",
    null,
    null,
    organizationPresets,
    organizationPresets,
  ],
  [
    "workspace-vm without owner.team, no assignment",
    "operator",
    "hosted-organization-personal",
    organizationPresets,
    organizationPresets,
  ],
  [
    "workspace-vm with owner.team assigned to one operator",
    "operator",
    "hosted-organization-personal",
    organizationPresets,
    ["hosted-organization-personal"],
  ],
  [
    "workspace-vm with owner.team assigned to the Team",
    "team",
    "hosted-organization-team",
    organizationPresets,
    ["hosted-organization-team"],
  ],
  [
    "workspace-vm without owner.team assigned to the Team",
    "team",
    "hosted-organization-team",
    organizationPresets,
    ["hosted-organization-team"],
  ],
  [
    "workspace-vm without owner.team, with relationships",
    "operator",
    "hosted-organization-personal",
    organizationPresets,
    organizationPresets,
  ],
  [
    "workspace-vm with owner.team of a persona with one responsible operator",
    "automation",
    "hosted-organization-steward",
    organizationPresets,
    ["hosted-organization-steward"],
  ],
  [
    "workspace-vm without owner.team of a persona with one responsible operator",
    "automation",
    "hosted-organization-steward",
    organizationPresets,
    ["hosted-organization-steward"],
  ],
] as const)(
  "%s has assignment %p, derives %p, allows exactly %p and offers %p",
  (machine, assignment, derived, allowed, selectable) => {
    const binding = machines[machine];
    if (binding !== null) expect(machineAssignment(binding)).toBe(assignment);
    expect(derivePreset(binding)).toBe(derived);
    expect(allowedPresets(binding)).toEqual([...allowed]);
    expect(selectablePresets(binding)).toEqual([...selectable]);
    if (derived !== null)
      expect(presetReference(derived, binding)).toEqual({
        name: derived,
        version: 1,
        selection: "derived",
      });
    for (const name of presetNames) {
      const profile = presetProfile(name, "linux");
      // A new choice is recorded only within the selectable set.
      if ((selectable as readonly string[]).includes(name))
        expect(presetReference(name, binding).selection).toBe(
          name === derived ? "derived" : "explicit",
        );
      else expect(() => presetReference(name, binding)).toThrow("not allowed");
      // A stored preset stays valid within the whole allow-list.
      if ((allowed as readonly string[]).includes(name))
        expect(validatePresetComposition(name, binding, profile)).toBe(
          workspacePreset(name),
        );
      else
        expect(() => validatePresetComposition(name, binding, profile)).toThrow(
          "not allowed",
        );
    }
  },
);

// Issue #107: existing Folders keep their recorded preset. The recorded one is
// selectable again (keeping it is no new choice) as long as the machine kind
// allows it; nothing else is added, and a personal VM never gains one.
test("the recorded preset stays selectable next to the derived one", () => {
  expect(
    selectablePresets(bindings.assignedOperator, "hosted-organization-steward"),
  ).toEqual(["hosted-organization-personal", "hosted-organization-steward"]);
  expect(
    selectablePresets(bindings.assignedTeam, "hosted-organization-personal"),
  ).toEqual(["hosted-organization-personal", "hosted-organization-team"]);
  expect(
    selectablePresets(bindings.automated, "hosted-organization-steward"),
  ).toEqual(["hosted-organization-steward"]);
  expect(
    selectablePresets(bindings.team, "hosted-organization-steward"),
  ).toEqual([...organizationPresets]);
  expect(
    selectablePresets(bindings.personal, "hosted-organization-steward"),
  ).toEqual(["hosted-personal"]);
  expect(selectablePresets(null, "hosted-personal")).toEqual(["local"]);
  // A stored explicit preset outside the selectable set parses unchanged.
  for (const [name, machine] of [
    ["hosted-organization-steward", bindings.assignedOperator],
    ["hosted-organization-personal", bindings.assignedTeam],
    ["hosted-organization-team", bindings.automated],
  ] as const) {
    const stored = parseFolderPreferences({
      schemaVersion: 2,
      revision: 3,
      customInstructions: "",
      preset: { name, version: 1, selection: "explicit" },
      machine,
      profile: presetProfile(name, "linux"),
    });
    expect(stored.preset.name).toBe(name);
    expect(selectablePresets(machine)).not.toContain(name);
  }
});

test("presets are complete compositions with defaults the Principal may override", () => {
  for (const name of presetNames) {
    const preset = workspacePreset(name);
    expect(preset.version).toBe(1);
    expect(Object.isFrozen(preset)).toBe(true);
    expect(presetProfile(name, "macos")).toEqual({
      os: "macos",
      ...preset.composition,
      ...preset.defaults,
    });
    expect(presetProfile(name, "linux", { locale: "cs" }).locale).toBe("cs");
  }
  expect(workspacePreset("local").composition.access).toBe("local");
  expect(workspacePreset("hosted-personal").personalspace).toBe("present");
  expect(workspacePreset("hosted-organization-personal").personalspace).toBe(
    "never",
  );
  expect(workspacePreset("hosted-organization-team").providerIdentity).toBe(
    "brokered-organization",
  );
});

// The four presets that existed before decision 0169, field by field: adding
// the Automated preset changes none of them (each only states that it runs no
// bot team).
test("the presets that existed before decision 0169 are unchanged", () => {
  const defaults = { locale: "en", detail: "concise", coordination: "direct" };
  const hosted = ["launchpad", "hosted-entry"];
  const organization = {
    version: 1,
    machineKinds: ["workspace-vm"],
    composition: { access: "remote", purpose: "human" },
    defaults,
    personalspace: "never",
    surfaces: hosted,
    supervision: "os-service-manager",
    botTeam: null,
  };
  const before: unknown = Object.fromEntries(
    presetNames
      .filter((name) => name !== "hosted-organization-steward")
      .map((name) => [name, workspacePreset(name)]),
  );
  expect(before).toEqual({
    local: {
      name: "local",
      version: 1,
      machineKinds: ["workstation"],
      composition: { access: "local", purpose: "human" },
      defaults,
      personalspace: "present",
      providerIdentity: "own-sign-in",
      surfaces: ["launchpad"],
      supervision: "session",
      botTeam: null,
    },
    "hosted-personal": {
      name: "hosted-personal",
      version: 1,
      machineKinds: ["personal-vm"],
      composition: { access: "remote", purpose: "human" },
      defaults,
      personalspace: "present",
      providerIdentity: "own-sign-in",
      surfaces: hosted,
      supervision: "os-service-manager",
      botTeam: null,
    },
    "hosted-organization-personal": {
      ...organization,
      name: "hosted-organization-personal",
      providerIdentity: "own-sign-in",
    },
    "hosted-organization-team": {
      ...organization,
      name: "hosted-organization-team",
      providerIdentity: "brokered-organization",
    },
  });
});

// Decision 0169: the Automated Environment of an Organization persona. An
// Organization work VM (Personalspace never, Organization repositories under
// organizations/<org>/) whose GitHub identity is the persona's own machine
// user account, signed in by the responsible operator; Lazurio MausBot runs
// the persona's bot team as a service next to the Launchpad and T3 Code.
test("the Steward preset composes the Automated Environment of decision 0169", () => {
  const preset = workspacePreset("hosted-organization-steward");
  expect(preset).toEqual({
    name: "hosted-organization-steward",
    version: 1,
    machineKinds: ["workspace-vm"],
    composition: { access: "remote", purpose: "human" },
    defaults: { locale: "en", detail: "concise", coordination: "direct" },
    personalspace: "never",
    providerIdentity: "persona-account",
    surfaces: ["launchpad", "hosted-entry", "openmausbot"],
    supervision: "os-service-manager",
    botTeam: {
      runtime: "openmausbot",
      workingFolder: "lazurio-folder",
      team: "lazurio/teams/steward.openmaus.json",
      githubIntake: {
        bot: "team-leader",
        scope: "organization",
        owners: "machine-organization",
        exclude: ["infra", "productionspace"],
      },
    },
  });
  expect(Object.isFrozen(preset.botTeam)).toBe(true);
  expect(Object.isFrozen(preset.botTeam?.githubIntake.exclude)).toBe(true);
  // Only the Steward preset runs a bot team or has a persona identity.
  for (const name of presetNames)
    if (name !== "hosted-organization-steward") {
      expect(workspacePreset(name).botTeam).toBeNull();
      expect(workspacePreset(name).providerIdentity).not.toBe(
        "persona-account",
      );
    }
});

test("a profile whose fixed axes disagree with the preset never validates", () => {
  const profile = presetProfile("local", "linux");
  expect(() =>
    validatePresetComposition("local", null, {
      ...profile,
      access: "remote",
    }),
  ).toThrow("composition");
  expect(() =>
    validatePresetComposition("local", null, {
      ...profile,
      purpose: "buddy",
    }),
  ).toThrow("composition");
});

test("unknown preset names, versions and selections fail before any use", () => {
  for (const input of [
    { name: "hosted-private", version: 1, selection: "derived" },
    { name: "local", version: 2, selection: "derived" },
    { name: "local", version: 1, selection: "manual" },
    { name: "local", version: 1 },
    { name: "local", version: 1, selection: "derived", authority: "admin" },
  ])
    expect(() => parsePresetReference(input)).toThrow();
  expect(() => workspacePreset("hosted-team" as never)).toThrow("Unknown");
});

test("preferences validate preset, Machine and profile as one composition", () => {
  const base = {
    schemaVersion: 2,
    revision: 1,
    preset: {
      name: "hosted-organization-team",
      version: 1,
      selection: "derived",
    },
    machine: bindings.team,
    profile: presetProfile("hosted-organization-team", "linux"),
    customInstructions: "",
  };
  expect(parseFolderPreferences(base).machine).toEqual(bindings.team);
  expect(parseFolderPreferences(JSON.parse(JSON.stringify(base)))).toEqual(
    parseFolderPreferences(base),
  );
  for (const change of [
    { machine: bindings.personal },
    { machine: null },
    { profile: { ...base.profile, access: "local" } },
    { preset: { ...base.preset, name: "local" } },
    { schemaVersion: 1 },
  ])
    expect(() => parseFolderPreferences({ ...base, ...change })).toThrow();
});

test("Machine bindings are typed projections; branches never mix, assignment and relationships are optional and exact", () => {
  expect(parseMachineBinding(null)).toBeNull();
  for (const binding of Object.values(bindings)) {
    expect(parseMachineBinding(binding)).toEqual(binding);
    expect(parseMachineBinding(JSON.parse(JSON.stringify(binding)))).toEqual(
      binding,
    );
  }
  // The projection keeps the handover's optional fields exactly: absent stays
  // absent (a v0.12.59 binding is unchanged), present is copied field by field.
  expect("assignment" in bindings.team.owner).toBe(false);
  expect("relationships" in bindings.team).toBe(false);
  expect(bindings.assignedOperator.owner).toEqual({
    kind: "organization",
    organization: "example",
    team: "sample-team",
    assignment: { kind: "operator", githubLogin: "example", githubId: 12345 },
  });
  expect(bindings.assignedTeam.owner).toEqual({
    kind: "organization",
    organization: "example",
    team: "sample-team",
    assignment: { kind: "team" },
  });
  expect(bindings.related.relationships).toEqual(workRelationships);
  expect(Object.isFrozen(bindings.related.relationships?.peers[0])).toBe(true);
  const peer = workRelationships.peers[0];
  for (const change of [
    { kind: "workspace-vm" },
    { owner: bindings.team.owner },
    { host: bindings.team.host },
    { network: null },
    { contextDigest: "short" },
    { name: "Example" },
    { owner: { ...bindings.personal.owner, assignment: { kind: "team" } } },
    { relationships: null },
    { relationships: workRelationships },
    { relationships: { zone: "personal" } },
    {
      relationships: { zone: "personal", peers: [{ ...peer, kind: "phone" }] },
    },
    {
      relationships: {
        zone: "personal",
        peers: [
          {
            ...peer,
            ssh: { host: "example-laptop", user: null, direction: "inbound" },
          },
        ],
      },
    },
    {
      relationships: {
        zone: "personal",
        peers: [{ ...peer, https: ["a.example.invalid", "a.example.invalid"] }],
      },
    },
    { relationships: { zone: "personal", peers: [{ ...peer, node_id: "1" }] } },
    // Values the vendored schema refuses in a handover must not survive in a
    // stored binding either (Pablo, #19): a peer name is one DNS label, an
    // Organization login has no leading, trailing or doubled hyphen.
    ...["bad-", "-bad", "Bad", "a".repeat(64), ""].map((name) => ({
      relationships: { zone: "personal", peers: [{ ...peer, name }] },
    })),
    ...["bad--organization", "bad-", "-bad", "a".repeat(40)].map(
      (organization) => ({
        relationships: { zone: "personal", peers: [{ ...peer, organization }] },
      }),
    ),
    { owner: { ...bindings.personal.owner, githubLogin: "bad--login" } },
    // A personal Machine name is a DNS slug of at most 32; only the workspace
    // branch's name may end in a hyphen (schema `^[a-z][a-z0-9-]{0,31}$`).
    { name: "bad-" },
    { name: "a".repeat(33) },
    { relationships: [{ machine: "x", kind: "personal-vm", access: "both" }] },
    { authority: "admin" },
  ])
    expect(() =>
      parseMachineBinding({ ...bindings.personal, ...change }),
    ).toThrow();
  // The Automated assignment (decision 0169) is the responsible operator,
  // exactly like `operator`; anything else fails closed.
  expect(bindings.automated.owner).toEqual({
    kind: "organization",
    organization: "example",
    team: "sample-team",
    assignment: { kind: "automation", githubLogin: "example", githubId: 12345 },
  });
  expect(Object.isFrozen(bindings.automated.owner)).toBe(true);
  for (const owner of [
    { ...bindings.team.owner, assignment: { kind: "automation" } },
    {
      ...bindings.team.owner,
      assignment: { kind: "automation", githubLogin: "example" },
    },
    {
      ...bindings.team.owner,
      assignment: { ...automationAssignment, githubLogin: "Example" },
    },
    {
      ...bindings.team.owner,
      assignment: { ...automationAssignment, githubId: 0 },
    },
    {
      ...bindings.team.owner,
      assignment: {
        ...automationAssignment,
        persona: { githubLogin: "example-bot", githubId: 2 },
      },
    },
    {
      ...bindings.team.owner,
      assignment: { ...automationAssignment, kind: "Automation" },
    },
    {
      ...bindings.team.owner,
      assignment: { ...automationAssignment, kind: "persona" },
    },
    { ...bindings.personal.owner, assignment: automationAssignment },
    { ...bindings.team.owner, assignment: null },
    { ...bindings.team.owner, assignment: { kind: "everyone" } },
    { ...bindings.team.owner, assignment: { kind: "team", team: "x" } },
    {
      ...bindings.team.owner,
      assignment: { kind: "operator", githubLogin: "example" },
    },
    {
      ...bindings.team.owner,
      assignment: { kind: "operator", githubLogin: "Example", githubId: 1 },
    },
    {
      ...bindings.team.owner,
      assignment: { kind: "operator", githubLogin: "example", githubId: 0 },
    },
    bindings.personal.owner,
  ])
    expect(() => parseMachineBinding({ ...bindings.team, owner })).toThrow();
  expect(() =>
    parseMachineBinding({ ...bindings.team, relationships: personalOnWork }),
  ).toThrow("zone");
  let invoked = false;
  expect(() =>
    parseMachineBinding({
      ...bindings.team,
      get name() {
        invoked = true;
        return "x";
      },
    }),
  ).toThrow();
  expect(invoked).toBe(false);
});
const personalOnWork = { zone: "personal", peers: [] };

// Every document the vendored schema accepts must survive the whole stored path:
// handover -> binding -> preferences -> read back byte-for-byte equal. Shapes at
// the schema's edges, per branch (Pablo, #19: a workspace name may end in a
// hyphen while a personal name may not).
test("a schema-valid handover projects into preferences that read back exactly", () => {
  const edges: Record<string, unknown>[] = [
    organizationDocument,
    {
      ...organizationDocument,
      machine: { ...organizationDocument.machine, name: "a-" },
    },
    {
      ...organizationDocument,
      machine: { ...organizationDocument.machine, name: `a${"-".repeat(31)}` },
    },
    personalDocument,
    {
      ...personalDocument,
      machine: { ...personalDocument.machine, name: "a1-b2".padEnd(32, "z") },
    },
    {
      ...personalDocument,
      owner: { ...personalDocument.owner, github_login: "a".repeat(39) },
      relationships: {
        zone: "personal",
        peers: [
          {
            name: `a${"-".repeat(61)}a`,
            kind: "client-device",
            zone: "personal",
            organization: "a".repeat(39),
            ssh: { host: "1.2.3.4", user: "_x", direction: "both" },
            https: [],
          },
        ],
      },
    },
  ];
  for (const document of edges) {
    const bytes = Buffer.from(JSON.stringify(document));
    const machine = machineBinding(
      parseMachineContext(bytes),
      createHash("sha256").update(bytes).digest("hex"),
    );
    const name = derivePreset(machine) ?? "hosted-organization-personal";
    const preferences = {
      schemaVersion: 2,
      revision: 1,
      preset: { name, version: 1, selection: "derived" },
      machine,
      profile: presetProfile(name, "linux"),
      customInstructions: "",
    };
    expect(
      parseFolderPreferences(JSON.parse(JSON.stringify(preferences))),
    ).toEqual(parseFolderPreferences(preferences));
    expect(parseFolderPreferences(preferences).machine).toEqual(machine);
  }
  // And the schema's refusals stay refusals before any binding exists.
  for (const document of [
    {
      ...personalDocument,
      machine: { ...personalDocument.machine, name: "a-" },
    },
    {
      ...organizationDocument,
      machine: { ...organizationDocument.machine, name: "1a" },
    },
  ])
    expect(() =>
      parseMachineContext(Buffer.from(JSON.stringify(document))),
    ).toThrow();
});

// The Automated assignment reaches Platform through the vendored handover
// schema, which Machines owns (Machines #277): a handover declaring it reads,
// projects and derives the Steward preset; no heuristic stands in for it
// (F10), and on it the Steward preset is the only new choice (#107).
test("the vendored handover schema carries the Automated assignment and derives the Steward preset", () => {
  const document = {
    ...organizationDocument,
    owner: {
      ...organizationDocument.owner,
      assignment: { kind: "automation", github_login: "example", github_id: 1 },
    },
  };
  const automated = binding(document);
  expect(automated.owner).toEqual({
    kind: "organization",
    organization: "example",
    team: "sample-team",
    assignment: { kind: "automation", githubLogin: "example", githubId: 1 },
  });
  expect(derivePreset(automated)).toBe("hosted-organization-steward");
  expect(presetReference("hosted-organization-steward", automated)).toEqual({
    name: "hosted-organization-steward",
    version: 1,
    selection: "derived",
  });
  // Without an assignment the Steward preset stays an explicit choice.
  const unassigned = binding(organizationDocument);
  expect(derivePreset(unassigned)).toBeNull();
  expect(presetReference("hosted-organization-steward", unassigned)).toEqual({
    name: "hosted-organization-steward",
    version: 1,
    selection: "explicit",
  });
});
