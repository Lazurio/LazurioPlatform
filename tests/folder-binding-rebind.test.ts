import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderAdoptionError } from "../src/folder/handover-layout";
import type { MachineBinding } from "../src/folder/machine-binding";
import { outputPaths } from "../src/folder/outputs";
import {
  refreshFolder,
  resumeProfileUpdate,
} from "../src/folder/update-profile";
import {
  initializeMachineFolder,
  refreshMachineFolder,
} from "../src/machine/cli";
import { assignments, binding } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// Issue #111 (and its duplicate #193), decision F10's addendum of 2026-11-12:
// every Machines apply rewrites the handover, often only where the Folder
// renders and records nothing (`installed`: the Machines release, the
// deployment head, the time of the apply). The refresh records the live
// handover's digest alone, in the one archived update transaction, and says
// so (`bindingRebound`); only the same digest is `unchanged`. Doctor's
// `machine-binding` compares exactly that digest (tests/doctor.test.ts).
const laterApply = Object.freeze({
  machines_release: {
    repository: "Example/Machines",
    version: "v1.0.1",
    commit: "c".repeat(40),
  },
  deployment_head: "d".repeat(40),
  recorded_at: "2026-11-12T06:17:00Z",
});
const evenLaterApply = Object.freeze({
  ...laterApply,
  recorded_at: "2026-11-12T09:40:00Z",
});

type Installed = typeof organization.installed;
const { team: _, ...owner } = organization.owner;
// An Organization work Environment of one operator; by default its Owner
// Organization and organization_key agree (`example`, `Example`).
const workHandover = (
  overrides: Readonly<{
    installed?: Installed;
    organization?: string;
    organizationKey?: string;
    name?: string;
    hostname?: string;
  }> = {},
) => ({
  ...organization,
  machine: {
    ...organization.machine,
    name: overrides.name ?? organization.machine.name,
  },
  owner: {
    ...owner,
    organization: overrides.organization ?? owner.organization,
    organization_key: overrides.organizationKey ?? owner.organization_key,
    assignment: assignments.operator,
  },
  network: {
    ...organization.network,
    headscale_hostname:
      overrides.hostname ?? organization.network.headscale_hostname,
  },
  installed: overrides.installed ?? organization.installed,
});
const personalHandover = (installed: Installed = personal.installed) => ({
  ...personal,
  installed,
});

const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;

async function setup(initial: MachineBinding) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "binding-rebind-")),
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

const stateFiles = ["preferences.json", "instructions.json"] as const;
const located = (folder: string, name: string) =>
  stateFiles.includes(name as (typeof stateFiles)[number])
    ? join(folder, ".lazurio", name)
    : join(folder, name);

// Every generated file and both state files byte for byte, the history, the
// state directory and the Folder's top level.
async function snapshot(folder: string) {
  const files: Record<string, string> = {};
  for (const name of [...outputPaths, ...stateFiles])
    files[name] = await readFile(located(folder, name), "utf8");
  return {
    files,
    history: (await readdir(join(folder, ".lazurio", "history"))).sort(),
    state: (await readdir(join(folder, ".lazurio"))).sort(),
    top: (await readdir(folder)).sort(),
  };
}

// The same files, by identity and modification time: an unchanged refresh
// replaces nothing, not even with the same bytes.
async function identities(folder: string) {
  const seen: Record<string, string> = {};
  for (const name of [...outputPaths, ...stateFiles]) {
    const stat = await lstat(located(folder, name));
    seen[name] = `${stat.ino}:${stat.mtimeMs}`;
  }
  return seen;
}

const recordedState = async (folder: string) =>
  JSON.parse(
    await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
  );

// What the rebinding changed: the revision and the binding's digest in the
// preferences, the preference revision in the manifest, nothing else.
function expectDigestOnly(
  before: Awaited<ReturnType<typeof snapshot>>,
  after: Awaited<ReturnType<typeof snapshot>>,
  live: MachineBinding,
  revision: number,
) {
  for (const path of outputPaths)
    expect(after.files[path]).toBe(before.files[path]);
  const previous = JSON.parse(before.files["preferences.json"] ?? "null");
  expect(JSON.parse(after.files["preferences.json"] ?? "null")).toEqual({
    ...previous,
    revision,
    machine: { ...previous.machine, contextDigest: live.contextDigest },
  });
  expect(JSON.parse(after.files["instructions.json"] ?? "null")).toEqual({
    ...JSON.parse(before.files["instructions.json"] ?? "null"),
    preferenceRevision: revision,
  });
  expect(after.history).toEqual([...before.history, `revision-${revision}`]);
  // No transaction left behind and nothing new in the Folder.
  expect(after.state).toEqual(before.state);
  expect(after.top).toEqual(before.top);
}

const rebinding = [
  {
    label: "an Organization's work Environment",
    adopted: binding(workHandover()),
    live: binding(workHandover({ installed: laterApply })),
    later: binding(workHandover({ installed: evenLaterApply })),
  },
  {
    label: "a personal Environment",
    adopted: binding(personalHandover()),
    live: binding(personalHandover(laterApply)),
    later: binding(personalHandover(evenLaterApply)),
  },
] as const;

for (const { label, adopted, live, later } of rebinding)
  test.skipIf(process.platform === "win32")(
    `${label}: a handover rewritten only in installed is recorded by its digest alone, then the same handover is unchanged`,
    async () => {
      expect(live.contextDigest).not.toBe(adopted.contextDigest);
      const { parent, folder } = await setup(adopted);
      try {
        const before = await snapshot(folder);
        expect((await recordedState(folder)).machine.contextDigest).toBe(
          adopted.contextDigest,
        );
        expect(await refreshMachineFolder(folder, live)).toEqual({
          code: 0,
          result: {
            kind: "refreshed",
            revision: 2,
            bindingRebound: "handover-digest",
          },
        });
        const rebound = await snapshot(folder);
        expectDigestOnly(before, rebound, live, 2);
        // The recorded binding is now exactly the live one, which is what
        // doctor's machine-binding compares.
        expect((await recordedState(folder)).machine).toEqual(
          JSON.parse(JSON.stringify(live)),
        );

        // The same handover again: nothing to record, nothing written.
        const settled = await identities(folder);
        expect(await refreshMachineFolder(folder, live)).toEqual({
          code: 0,
          result: { kind: "unchanged" },
        });
        expect(await snapshot(folder)).toEqual(rebound);
        expect(await identities(folder)).toEqual(settled);

        // The next apply rewrites it again: the next revision records it.
        expect(await refreshFolder(folder, later)).toEqual({
          kind: "refreshed",
          revision: 3,
          bindingRebound: "handover-digest",
        });
        expectDigestOnly(rebound, await snapshot(folder), later, 3);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
    30_000,
  );

test.skipIf(process.platform === "win32")(
  "the handover the Folder records is unchanged: no revision, no archive, no file replaced",
  async () => {
    const adopted = binding(workHandover());
    const { parent, folder } = await setup(adopted);
    try {
      const before = await snapshot(folder);
      const seen = await identities(folder);
      expect(await refreshMachineFolder(folder, adopted)).toEqual({
        code: 0,
        result: { kind: "unchanged" },
      });
      expect(await refreshFolder(folder, adopted)).toEqual({
        kind: "unchanged",
      });
      expect(await snapshot(folder)).toEqual(before);
      expect(await identities(folder)).toEqual(seen);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

// A rewritten handover of another Machine is refused as before, and its
// digest is never recorded.
const refused = [
  { label: "the Environment's name", name: "another" },
  { label: "the tailnet node", hostname: "another-node" },
  { label: "the Owner Organization", organization: "another" },
] as const;

for (const change of refused)
  test.skipIf(process.platform === "win32")(
    `${change.label} changed with installed: refused as another Machine, the digest is not recorded`,
    async () => {
      const adopted = binding(workHandover());
      const live = binding(workHandover({ ...change, installed: laterApply }));
      const { parent, folder } = await setup(adopted);
      try {
        const before = await snapshot(folder);
        const seen = await identities(folder);
        await expect(refreshMachineFolder(folder, live)).rejects.toEqual(
          new FolderAdoptionError("binding-changed", ".lazurio"),
        );
        expect(
          await refreshFolder(
            folder,
            live,
            undefined,
            undefined,
            owner.organization_key,
          ),
        ).toEqual({ kind: "blocked", reason: "binding-changed" });
        expect(await snapshot(folder)).toEqual(before);
        expect(await identities(folder)).toEqual(seen);
        expect((await recordedState(folder)).machine.contextDigest).toBe(
          adopted.contextDigest,
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
    30_000,
  );

// Decision F10's addendum of 2026-11-11 (#931) is unchanged: the corrected
// Owner Organization is recorded with the handover it came with and the
// answer names the correction only. A later apply that rewrites only
// `installed` is then rebound like any other.
test.skipIf(process.platform === "win32")(
  "an Owner Organization correction records its handover's digest and says bindingCorrected only; the next rewrite is rebound",
  async () => {
    const key = "ExampleOrg";
    const labelled = binding(workHandover({ organizationKey: key }));
    const corrected = binding(
      workHandover({
        organization: "exampleorg",
        organizationKey: key,
        installed: laterApply,
      }),
    );
    const reapplied = binding(
      workHandover({
        organization: "exampleorg",
        organizationKey: key,
        installed: evenLaterApply,
      }),
    );
    const { parent, folder } = await setup(labelled);
    try {
      expect(
        await refreshMachineFolder(folder, corrected, undefined, key),
      ).toEqual({
        code: 0,
        result: {
          kind: "refreshed",
          revision: 2,
          bindingCorrected: "owner-organization",
        },
      });
      expect((await recordedState(folder)).machine).toEqual(
        JSON.parse(JSON.stringify(corrected)),
      );
      const settled = await snapshot(folder);
      expect(
        await refreshMachineFolder(folder, reapplied, undefined, key),
      ).toEqual({
        code: 0,
        result: {
          kind: "refreshed",
          revision: 3,
          bindingRebound: "handover-digest",
        },
      });
      expectDigestOnly(settled, await snapshot(folder), reapplied, 3);
      expect(
        await refreshMachineFolder(folder, reapplied, undefined, key),
      ).toEqual({ code: 0, result: { kind: "unchanged" } });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

for (const stop of ["prepared", "applied"] as const)
  test.skipIf(process.platform === "win32")(
    `a rebinding refresh interrupted after ${stop} is completed forward by profile-resume`,
    async () => {
      const adopted = binding(workHandover());
      const live = binding(workHandover({ installed: laterApply }));
      const { parent, folder } = await setup(adopted);
      try {
        const before = await snapshot(folder);
        await expect(
          refreshFolder(folder, live, async (step) => {
            if (step === stop) throw new Error("interrupted");
          }),
        ).rejects.toThrow("interrupted");
        // The transaction is pending: the journal is still in place.
        expect((await snapshot(folder)).state).toContain("transaction");
        expect(await resumeProfileUpdate(folder, 2)).toEqual({
          kind: "recovered",
          revision: 2,
        });
        expectDigestOnly(before, await snapshot(folder), live, 2);
        expect(await refreshMachineFolder(folder, live)).toEqual({
          code: 0,
          result: { kind: "unchanged" },
        });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
    30_000,
  );
