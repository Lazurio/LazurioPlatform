import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentScope, scopeAdmits } from "../src/content/model";
import { FolderAdoptionError } from "../src/folder/handover-layout";
import {
  type MachineBinding,
  ownerOrganizationCorrection,
} from "../src/folder/machine-binding";
import { outputPaths } from "../src/folder/outputs";
import {
  refreshFolder,
  resumeProfileUpdate,
} from "../src/folder/update-profile";
import { ownerOrganizationKey } from "../src/machine/binding";
import {
  initializeMachineFolder,
  refreshMachineFolder,
} from "../src/machine/cli";
import { parseMachineContext } from "../src/machine/context";
import { assignments, binding } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// Decision F10's addendum of 2026-11-11: a work Environment whose Folder was
// adopted while its handover named the Owner Organization by a runtime label
// (`example`), and whose handover now names it by its GitHub login in lower
// case (`exampleorg`, `organization_key` `ExampleOrg`). Everything else in
// the identity is the same Machine.
const key = "ExampleOrg";
const { team: _, ...owner } = organization.owner;
const workHandover = (
  overrides: Readonly<{
    organization?: string;
    organizationKey?: string | null;
    name?: string;
    team?: string;
    hostname?: string;
  }> = {},
) => {
  const { organization_key: _key, ...rest } = owner;
  return {
    ...organization,
    machine: {
      ...organization.machine,
      name: overrides.name ?? organization.machine.name,
    },
    owner: {
      ...rest,
      organization: overrides.organization ?? "example",
      ...(overrides.organizationKey === null
        ? {}
        : { organization_key: overrides.organizationKey ?? key }),
      ...(overrides.team === undefined ? {} : { team: overrides.team }),
      assignment: assignments.operator,
    },
    network: {
      ...organization.network,
      headscale_hostname:
        overrides.hostname ?? organization.network.headscale_hostname,
    },
  };
};
const recorded = binding(workHandover());
const relabelled = binding(workHandover({ organization: "exampleorg" }));
const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;
const installRequest = { kind: "organization", login: key } as const;

async function setup(initial: MachineBinding = recorded) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "binding-correction-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  if (initial.kind === "personal-vm")
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  expect(await initializeMachineFolder(folder, initial, noChoices)).toEqual({
    code: 0,
    result: expect.objectContaining({ kind: "initialized", revision: 1 }),
  });
  return { parent, folder };
}

// Every generated file, both state files and the history, byte for byte.
async function snapshot(folder: string) {
  const files: Record<string, string> = {};
  for (const path of outputPaths)
    files[path] = await readFile(join(folder, path), "utf8");
  for (const name of ["preferences.json", "instructions.json"])
    files[name] = await readFile(join(folder, ".lazurio", name), "utf8");
  return {
    files,
    history: (await readdir(join(folder, ".lazurio", "history"))).sort(),
    state: (await readdir(join(folder, ".lazurio"))).sort(),
  };
}

async function preferences(folder: string) {
  return JSON.parse(
    await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
  );
}

const admitted = async (folder: string) => {
  const state = await preferences(folder);
  return scopeAdmits(
    contentScope(state.preset.name, state.machine),
    installRequest,
  );
};

test("the handover's organization_key is read only from a work Environment's Organization owner", () => {
  const parse = (document: unknown) =>
    parseMachineContext(Buffer.from(JSON.stringify(document)));
  expect(ownerOrganizationKey(parse(workHandover()))).toBe(key);
  expect(
    ownerOrganizationKey(parse(workHandover({ organizationKey: null }))),
  ).toBeUndefined();
  expect(ownerOrganizationKey(parse(personal))).toBeUndefined();
});

test("only the Owner Organization, relabelled to exactly the lower-cased organization_key, is a correction", () => {
  expect(ownerOrganizationCorrection(recorded, relabelled, key)).toBe(
    "owner-organization",
  );
  // Nothing to correct.
  expect(ownerOrganizationCorrection(recorded, recorded, key)).toBeNull();
  expect(ownerOrganizationCorrection(relabelled, relabelled, key)).toBeNull();
  expect(ownerOrganizationCorrection(null, relabelled, key)).toBeNull();
  expect(ownerOrganizationCorrection(recorded, null, key)).toBeNull();
  // No organization_key in the handover.
  expect(
    ownerOrganizationCorrection(recorded, relabelled, undefined),
  ).toBeNull();
  // The new value is not the key in lower case.
  for (const other of ["exampleorg-x", "another"])
    expect(
      ownerOrganizationCorrection(
        recorded,
        binding(workHandover({ organization: other })),
        key,
      ),
    ).toBeNull();
  expect(
    ownerOrganizationCorrection(recorded, relabelled, "AnotherOrg"),
  ).toBeNull();
  // Any other part of the identity differs as well.
  for (const other of [
    { name: "another" },
    { team: "sample-team" },
    { hostname: "another-workspace" },
  ])
    expect(
      ownerOrganizationCorrection(
        recorded,
        binding(workHandover({ organization: "exampleorg", ...other })),
        key,
      ),
    ).toBeNull();
  // The Owner's kind differs: a person's Environment is never corrected
  // into an Organization's, nor the other way round.
  const person = binding(personal);
  expect(ownerOrganizationCorrection(person, relabelled, key)).toBeNull();
  expect(ownerOrganizationCorrection(relabelled, person, key)).toBeNull();
  // A personal (principal) owner is never corrected, whatever the key.
  const renamed = binding({
    ...personal,
    owner: { ...personal.owner, github_login: "exampleorg" },
  });
  expect(ownerOrganizationCorrection(person, renamed, key)).toBeNull();
});

test.skipIf(process.platform === "win32")(
  "the refresh records the corrected Owner Organization in one archived transaction; install and the identity follow it",
  async () => {
    const { parent, folder } = await setup();
    try {
      // The label is not the Organization's login: an install is refused.
      expect(await admitted(folder)).toBe(false);
      const before = await snapshot(folder);
      const { preset } = await preferences(folder);
      // Without the handover's key the identity is another Machine's.
      await expect(
        initializeMachineFolder(folder, relabelled, noChoices),
      ).rejects.toEqual(new FolderAdoptionError("binding-changed", ".lazurio"));
      // folder-init on that Folder says what the refresh will do, and writes
      // nothing.
      expect(
        await initializeMachineFolder(
          folder,
          relabelled,
          noChoices,
          false,
          key,
        ),
      ).toEqual({
        code: 0,
        result: {
          kind: "already-adopted",
          revision: 1,
          preset,
          bindingCorrection: "owner-organization",
          next: expect.stringContaining("folder-refresh"),
        },
      });
      expect(await snapshot(folder)).toEqual(before);

      expect(
        await refreshMachineFolder(folder, relabelled, undefined, key),
      ).toEqual({
        code: 0,
        result: {
          kind: "refreshed",
          revision: 2,
          bindingCorrected: "owner-organization",
        },
      });
      const state = await preferences(folder);
      expect(state.revision).toBe(2);
      expect(state.machine).toEqual(JSON.parse(JSON.stringify(relabelled)));
      expect(state.preset).toEqual(preset);
      expect((await snapshot(folder)).history).toEqual([
        ...before.history,
        "revision-2",
      ]);
      expect(await admitted(folder)).toBe(true);

      // The same handover again: the identity is the recorded one now.
      expect(
        await refreshMachineFolder(folder, relabelled, undefined, key),
      ).toEqual({ code: 0, result: { kind: "unchanged" } });
      expect(
        await initializeMachineFolder(folder, relabelled, noChoices),
      ).toMatchObject({ code: 0, result: { kind: "already-adopted" } });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

const refused: readonly Readonly<{
  label: string;
  live: MachineBinding;
  key: string | undefined;
  initial?: MachineBinding;
}>[] = [
  {
    label: "the new Organization is not the lower-cased organization_key",
    live: binding(workHandover({ organization: "another" })),
    key,
  },
  {
    label: "the organization_key is another Organization's",
    live: relabelled,
    key: "AnotherOrg",
  },
  {
    label: "the handover has no organization_key",
    live: binding(
      workHandover({ organization: "exampleorg", organizationKey: null }),
    ),
    key: undefined,
  },
  {
    label: "the Machine's name differs as well",
    live: binding(workHandover({ organization: "exampleorg", name: "other" })),
    key,
  },
  {
    label: "the Team differs as well",
    live: binding(
      workHandover({ organization: "exampleorg", team: "sample-team" }),
    ),
    key,
  },
  {
    label: "the tailnet node differs as well",
    live: binding(
      workHandover({ organization: "exampleorg", hostname: "other-node" }),
    ),
    key,
  },
  {
    label: "the Owner's kind differs",
    live: relabelled,
    key,
    initial: binding(personal),
  },
  {
    label: "a personal Environment's principal owner changed",
    live: binding({
      ...personal,
      owner: { ...personal.owner, github_login: "exampleorg" },
    }),
    key,
    initial: binding(personal),
  },
];

for (const { label, live, key: given, initial } of refused)
  test.skipIf(process.platform === "win32")(
    `refused as another Machine, nothing written: ${label}`,
    async () => {
      const { parent, folder } = await setup(initial);
      try {
        const settled = await snapshot(folder);
        // The adoption check refuses it by name …
        await expect(
          refreshMachineFolder(folder, live, undefined, given),
        ).rejects.toEqual(
          new FolderAdoptionError("binding-changed", ".lazurio"),
        );
        // … and so does the planner under the transaction lock.
        expect(
          await refreshFolder(folder, live, undefined, undefined, given),
        ).toEqual({ kind: "blocked", reason: "binding-changed" });
        expect(await snapshot(folder)).toEqual(settled);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

for (const stop of ["prepared", "applied"] as const)
  test.skipIf(process.platform === "win32")(
    `a correcting refresh interrupted after ${stop} is completed by profile-resume`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await expect(
          refreshFolder(
            folder,
            relabelled,
            async (step) => {
              if (step === stop) throw new Error("interrupted");
            },
            undefined,
            key,
          ),
        ).rejects.toThrow("interrupted");
        expect(await resumeProfileUpdate(folder, 2)).toEqual({
          kind: "recovered",
          revision: 2,
        });
        expect((await preferences(folder)).machine).toEqual(
          JSON.parse(JSON.stringify(relabelled)),
        );
        expect(await admitted(folder)).toBe(true);
        expect(
          await refreshMachineFolder(folder, relabelled, undefined, key),
        ).toEqual({ code: 0, result: { kind: "unchanged" } });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
