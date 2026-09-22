import { expect, test } from "bun:test";
import { parseMachineBinding } from "../src/folder/machine-binding";
import {
  allowedPresets,
  derivePreset,
  machineAssignment,
  parsePresetReference,
  presetNames,
  presetProfile,
  presetReference,
  validatePresetComposition,
  workspacePreset,
} from "../src/folder/presets";
import { parseFolderPreferences } from "../src/folder/state";
import { bindings } from "./fixtures/machine-bindings";

const machines = {
  workstation: null,
  "personal-vm": bindings.personal,
  "workspace-vm with owner.team": bindings.team,
  "workspace-vm without owner.team": bindings.organization,
} as const;

// Derivation is a function of machine.kind and the assignment the handover
// proves. A Team in the handover proves nothing about assignment (an
// Organization may model one operator's VM as a Team named after them), so
// that handover derives no preset and every choice on it is explicit.
test.each([
  ["workstation", null, "local", ["local"]],
  ["personal-vm", "operator", "hosted-personal", ["hosted-personal"]],
  [
    "workspace-vm with owner.team",
    null,
    null,
    ["hosted-organization-personal", "hosted-organization-team"],
  ],
  [
    "workspace-vm without owner.team",
    "operator",
    "hosted-organization-personal",
    ["hosted-organization-personal", "hosted-organization-team"],
  ],
] as const)(
  "%s has assignment %p, derives %p and allows exactly %p",
  (machine, assignment, derived, allowed) => {
    const binding = machines[machine];
    if (binding !== null) expect(machineAssignment(binding)).toBe(assignment);
    expect(derivePreset(binding)).toBe(derived);
    expect(allowedPresets(binding)).toEqual([...allowed]);
    if (derived !== null)
      expect(presetReference(derived, binding)).toEqual({
        name: derived,
        version: 1,
        selection: "derived",
      });
    for (const name of presetNames) {
      if ((allowed as readonly string[]).includes(name)) {
        const reference = presetReference(name, binding);
        expect(reference.selection).toBe(
          name === derived ? "derived" : "explicit",
        );
        const profile = presetProfile(name, "linux");
        expect(validatePresetComposition(reference, binding, profile)).toBe(
          workspacePreset(name),
        );
      } else {
        expect(() => presetReference(name, binding)).toThrow("not allowed");
        expect(() =>
          validatePresetComposition(
            { name, version: 1, selection: "explicit" },
            binding,
            presetProfile(name, "linux"),
          ),
        ).toThrow("not allowed");
      }
    }
  },
);

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

test("a profile whose fixed axes disagree with the preset never validates", () => {
  const reference = presetReference("local", null);
  const profile = presetProfile("local", "linux");
  expect(() =>
    validatePresetComposition(reference, null, {
      ...profile,
      access: "remote",
    }),
  ).toThrow("composition");
  expect(() =>
    validatePresetComposition(reference, null, {
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

test("Machine bindings are typed projections; branches never mix and relationships are optional", () => {
  expect(parseMachineBinding(null)).toBeNull();
  for (const binding of Object.values(bindings)) {
    expect(parseMachineBinding(binding)).toEqual(binding);
    expect(parseMachineBinding(JSON.parse(JSON.stringify(binding)))).toEqual(
      binding,
    );
  }
  const related = {
    ...bindings.personal,
    relationships: [
      { machine: "example-laptop", kind: "personal-client", access: "both" },
      { machine: "example-work", kind: "workspace-vm", access: "outbound" },
    ],
  } as const;
  expect(parseMachineBinding(related)).toEqual(related);
  for (const change of [
    { kind: "workspace-vm" },
    { owner: bindings.team.owner },
    { host: bindings.team.host },
    { network: null },
    { contextDigest: "short" },
    { name: "Example" },
    { relationships: [{ machine: "x", kind: "phone", access: "both" }] },
    { relationships: [{ machine: "x", kind: "personal-vm" }] },
    { authority: "admin" },
  ])
    expect(() =>
      parseMachineBinding({ ...bindings.personal, ...change }),
    ).toThrow();
  expect(() =>
    parseMachineBinding({ ...bindings.team, owner: bindings.personal.owner }),
  ).toThrow();
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
