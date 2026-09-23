import { expect, test } from "bun:test";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderAdoptionError } from "../src/folder/handover-layout";
import { outputPaths } from "../src/folder/outputs";
import {
  refreshFolder,
  resumeProfileUpdate,
  updateProfile,
} from "../src/folder/update-profile";
import {
  initializeMachineFolder,
  refreshMachineFolder,
} from "../src/machine/cli";
import { binding } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// A personal VM handover before and after Machines re-applied it with one more
// peer: the operator's work VM, reachable from here over SSH, account unknown.
const laptop = {
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
} as const;
const workVm = {
  name: "example-work",
  kind: "workspace-vm",
  zone: "work",
  organization: "example",
  ssh: {
    host: "example-work.tailnet.example.invalid",
    user: null,
    direction: "outbound",
  },
  https: [],
} as const;
const personalHandover = (peers: readonly unknown[], recordedAt?: string) => ({
  ...personal,
  installed: {
    ...personal.installed,
    recorded_at: recordedAt ?? personal.installed.recorded_at,
  },
  relationships: { zone: "personal", peers },
});
const before = binding(personalHandover([laptop]));
const after = binding(personalHandover([laptop, workVm]));
// The same document rewritten by a later apply: only `installed` differs.
const reapplied = binding(
  personalHandover([laptop, workVm], "2026-09-23T00:00:00Z"),
);

const workVmLine = {
  cs: "- `example-work` (pracovní VM, pracovní zóna, Organizace `example`): SSH odsud na `example-work.tailnet.example.invalid`; bez HTTPS.",
  en: "- `example-work` (work VM, work zone, Organization `example`): SSH from here to `example-work.tailnet.example.invalid`; no HTTPS.",
} as const;
const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;

async function setup() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "folder-refresh-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await writeFile(join(folder, "personalspace", "keep"), "synthetic work");
  return { parent, folder };
}

// Every generated file and both state files, byte for byte, plus the history.
async function snapshot(folder: string) {
  const files: Record<string, string> = {};
  for (const path of outputPaths)
    files[path] = await readFile(join(folder, path), "utf8");
  for (const name of ["preferences.json", "instructions.json"])
    files[name] = await readFile(join(folder, ".lazurio", name), "utf8");
  const history = (await readdir(join(folder, ".lazurio", "history"))).sort();
  return {
    files,
    history,
    state: (await readdir(join(folder, ".lazurio"))).sort(),
  };
}

async function preferences(folder: string) {
  return JSON.parse(
    await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
  );
}

for (const locale of ["cs", "en"] as const)
  test.skipIf(process.platform === "win32")(
    `a handover that adds a work VM peer is rendered into the ${locale} AGENTS.md and the manual; the same handover again is unchanged`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await initializeMachineFolder(folder, before, {
          ...noChoices,
          locale,
        });
        const initial = await preferences(folder);
        expect(await readFile(join(folder, "AGENTS.md"), "utf8")).not.toContain(
          "example-work",
        );
        // What v0.1.2 observed: the handover changed, the Folder did not.
        expect(
          await initializeMachineFolder(folder, after, noChoices),
        ).toMatchObject({ code: 0, result: { kind: "already-adopted" } });
        expect(await readFile(join(folder, "AGENTS.md"), "utf8")).not.toContain(
          "example-work",
        );

        expect(await refreshMachineFolder(folder, after)).toEqual({
          code: 0,
          result: { kind: "refreshed", revision: 2 },
        });
        const agents = await readFile(join(folder, "AGENTS.md"), "utf8");
        expect(agents).toContain(workVmLine[locale]);
        expect(agents).toContain("example-laptop");
        const manual = await readFile(
          join(folder, "manual", "this-machine.md"),
          "utf8",
        );
        expect(manual).toContain(workVmLine.en);
        // The recorded choices are kept; only the binding follows the handover.
        const refreshed = await preferences(folder);
        expect(refreshed).toEqual({
          ...initial,
          revision: 2,
          machine: JSON.parse(JSON.stringify(after)),
        });
        expect(await readdir(join(folder, ".lazurio", "history"))).toContain(
          "revision-2",
        );
        expect(
          await readFile(join(folder, "personalspace", "keep"), "utf8"),
        ).toBe("synthetic work");

        // Identical handover, and one that only rewrote `installed`: nothing
        // is written, the revision stays, the recorded binding stays.
        const settled = await snapshot(folder);
        for (const machine of [after, reapplied])
          expect(await refreshMachineFolder(folder, machine)).toEqual({
            code: 0,
            result: { kind: "unchanged" },
          });
        expect(await snapshot(folder)).toEqual(settled);

        // The refreshed binding is carried forward by a later profile change.
        const other = locale === "cs" ? "en" : "cs";
        expect(
          await updateProfile(folder, 2, {
            profile: { ...initial.profile, locale: other },
          }),
        ).toEqual({ kind: "updated", revision: 3 });
        expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
          workVmLine[other],
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

for (const path of ["AGENTS.md", "manual/this-machine.md"] as const)
  test.skipIf(process.platform === "win32")(
    `an edited ${path} is refused by path and nothing is written`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await initializeMachineFolder(folder, before, noChoices);
        await appendFile(join(folder, path), "\nmy own note\n");
        const edited = await snapshot(folder);
        expect(await refreshMachineFolder(folder, after)).toEqual({
          code: 2,
          result: { kind: "blocked", reason: "drift", path },
        });
        expect(await snapshot(folder)).toEqual(edited);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

test.skipIf(process.platform === "win32")(
  "a removed owned file is refused by path and nothing is written",
  async () => {
    const { parent, folder } = await setup();
    try {
      await initializeMachineFolder(folder, before, noChoices);
      await rm(join(folder, "manual", "roles.md"));
      const state = await readFile(
        join(folder, ".lazurio", "preferences.json"),
        "utf8",
      );
      expect(await refreshMachineFolder(folder, after)).toEqual({
        code: 2,
        result: { kind: "blocked", reason: "drift", path: "manual/roles.md" },
      });
      expect(
        await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
      ).toBe(state);
      await expect(lstat(join(folder, "manual", "roles.md"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "another Machine's handover is refused, before and under the transaction lock",
  async () => {
    const { parent, folder } = await setup();
    try {
      await initializeMachineFolder(folder, before, noChoices);
      const settled = await snapshot(folder);
      const another = binding({
        ...personalHandover([laptop, workVm]),
        host: { ...personal.host, estate_id: "another-estate" },
      });
      await expect(refreshMachineFolder(folder, another)).rejects.toEqual(
        new FolderAdoptionError("binding-changed", ".lazurio"),
      );
      expect(await refreshFolder(folder, another)).toEqual({
        kind: "blocked",
        reason: "binding-changed",
      });
      expect(await snapshot(folder)).toEqual(settled);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a Folder without state is not initialized by a refresh",
  async () => {
    const { parent, folder } = await setup();
    try {
      expect(await refreshMachineFolder(folder, after)).toEqual({
        code: 2,
        result: {
          kind: "blocked",
          reason: "folder-not-initialized",
          next: "Run lazurio machine folder-init first; nothing was created.",
        },
      });
      expect((await readdir(folder)).sort()).toEqual([
        "organizations",
        "personalspace",
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const stop of ["prepared", "applied"] as const)
  test.skipIf(process.platform === "win32")(
    `a refresh interrupted after ${stop} is completed by profile-resume`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await initializeMachineFolder(folder, before, noChoices);
        await expect(
          refreshFolder(folder, after, async (step) => {
            if (step === stop) throw new Error("interrupted");
          }),
        ).rejects.toThrow("interrupted");
        expect(await resumeProfileUpdate(folder, 2)).toEqual({
          kind: "recovered",
          revision: 2,
        });
        expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
          workVmLine.en,
        );
        expect((await preferences(folder)).machine).toEqual(
          JSON.parse(JSON.stringify(after)),
        );
        expect(await refreshMachineFolder(folder, after)).toEqual({
          code: 0,
          result: { kind: "unchanged" },
        });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

test.skipIf(process.platform === "win32")(
  "an assignment that now derives another preset is not carried forward silently",
  async () => {
    const { parent, folder } = await setup();
    try {
      const assigned = (assignment: unknown) =>
        binding({
          ...organization,
          owner: { ...organization.owner, assignment },
        });
      await rm(join(folder, "personalspace"), { recursive: true });
      await initializeMachineFolder(
        folder,
        assigned({ kind: "operator", github_login: "example", github_id: 1 }),
        noChoices,
      );
      const settled = await snapshot(folder);
      expect(
        await refreshMachineFolder(folder, assigned({ kind: "team" })),
      ).toEqual({
        code: 2,
        result: { kind: "blocked", reason: "preset-derivation-changed" },
      });
      expect(await snapshot(folder)).toEqual(settled);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
