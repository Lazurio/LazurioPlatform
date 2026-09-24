import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { runCli } from "../src/cli";
import { applyPreparation } from "../src/folder/apply-preparation";
import { FolderAdoptionError } from "../src/folder/handover-layout";
import { outputPaths } from "../src/folder/outputs";
import { renderOutputs } from "../src/folder/preview";
import { instructionTemplateRevision } from "../src/folder/render";
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
        expect(manual).toContain(workVmLine[locale]);
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

// The outputs and the pending journal exactly as an interruption left them.
async function pending(folder: string) {
  const files: Record<string, string> = {};
  for (const path of outputPaths)
    files[path] = await readFile(join(folder, path), "utf8");
  const transaction = join(folder, ".lazurio", "transaction");
  const journal = await lstat(transaction).then(
    async () => (await readdir(transaction)).sort(),
    () => null,
  );
  return { files, journal };
}
async function foreignEntry(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (error instanceof FolderAdoptionError)
      return { code: error.code, entry: error.entry };
    throw error;
  }
  throw new Error("Expected a Folder boundary refusal");
}

for (const stop of ["prepared", "applied"] as const)
  test.skipIf(process.platform === "win32")(
    `a refresh interrupted after ${stop} refuses a foreign top-level entry on resume, then completes by profile-resume`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await initializeMachineFolder(folder, before, noChoices);
        await expect(
          refreshFolder(folder, after, async (step) => {
            if (step === stop) throw new Error("interrupted");
          }),
        ).rejects.toThrow("interrupted");
        const interrupted = await pending(folder);
        expect(interrupted.journal).not.toBeNull();
        // A foreign entry that appeared after the interruption: recovery is
        // refused by name before any replacement or archive, nothing moves.
        await writeFile(join(folder, "foreign-root"), "not ours");
        expect(await foreignEntry(resumeProfileUpdate(folder, 2))).toEqual({
          code: "foreign-entry",
          entry: "foreign-root",
        });
        expect(await pending(folder)).toEqual(interrupted);
        expect(await readFile(join(folder, "foreign-root"), "utf8")).toBe(
          "not ours",
        );
        await rm(join(folder, "foreign-root"));
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
  "a partly applied refresh re-checks the boundary before the next replacement",
  async () => {
    const { parent, folder } = await setup();
    try {
      await initializeMachineFolder(folder, before, noChoices);
      await expect(
        refreshFolder(folder, after, async (step) => {
          if (step === "prepared") throw new Error("interrupted");
        }),
      ).rejects.toThrow("interrupted");
      // Activation stops after its first replacement (AGENTS.md) …
      await expect(
        applyPreparation(folder, async (step) => {
          if (step === "AGENTS.md") throw new Error("interrupted");
        }),
      ).rejects.toThrow("interrupted");
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        workVmLine.en,
      );
      const partial = await pending(folder);
      expect(partial.files["manual/this-machine.md"]).not.toContain(
        "example-work",
      );
      // … and a foreign entry stops every later replacement, by name.
      await mkdir(join(folder, "foreign-root"));
      expect(await foreignEntry(applyPreparation(folder))).toEqual({
        code: "foreign-entry",
        entry: "foreign-root",
      });
      expect(await foreignEntry(resumeProfileUpdate(folder, 2))).toEqual({
        code: "foreign-entry",
        entry: "foreign-root",
      });
      expect(await pending(folder)).toEqual(partial);
      await rm(join(folder, "foreign-root"), { recursive: true });
      expect(await resumeProfileUpdate(folder, 2)).toEqual({
        kind: "recovered",
        revision: 2,
      });
      expect(
        await readFile(join(folder, "manual", "this-machine.md"), "utf8"),
      ).toContain(workVmLine.en);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the shared transaction refuses a foreign top-level entry for a profile update too, before any journal, and on its resume",
  async () => {
    const { parent, folder } = await setup();
    try {
      await initializeMachineFolder(folder, before, noChoices);
      const profile = (await preferences(folder)).profile;
      const settled = await snapshot(folder);
      await writeFile(join(folder, "notes.txt"), "not ours");
      // Before preparation: refused, no journal is created.
      for (const run of [
        () =>
          updateProfile(folder, 1, { profile: { ...profile, locale: "cs" } }),
        () => refreshFolder(folder, after),
      ])
        expect(await foreignEntry(run())).toEqual({
          code: "foreign-entry",
          entry: "notes.txt",
        });
      expect(await snapshot(folder)).toEqual(settled);
      await rm(join(folder, "notes.txt"));
      // After preparation: the resume of an interrupted profile update too.
      await expect(
        updateProfile(
          folder,
          1,
          { profile: { ...profile, locale: "cs" } },
          async (step) => {
            if (step === "prepared") throw new Error("interrupted");
          },
        ),
      ).rejects.toThrow("interrupted");
      const interrupted = await pending(folder);
      await writeFile(join(folder, "notes.txt"), "not ours");
      expect(await foreignEntry(resumeProfileUpdate(folder, 2))).toEqual({
        code: "foreign-entry",
        entry: "notes.txt",
      });
      // The CLI reports it as a named refusal (exit 2), not an operation failure.
      const printed: string[] = [];
      const log = console.log;
      console.log = (line: string) => void printed.push(line);
      try {
        expect(
          await runCli([
            "profile-resume",
            "--folder",
            folder,
            "--target-revision",
            "2",
          ]),
        ).toBe(2);
      } finally {
        console.log = log;
      }
      expect(JSON.parse(printed[0] ?? "null")).toMatchObject({
        kind: "blocked",
        reason: "folder-foreign-entry",
        entry: "notes.txt",
      });
      expect(await pending(folder)).toEqual(interrupted);
      await rm(join(folder, "notes.txt"));
      expect(await resumeProfileUpdate(folder, 2)).toEqual({
        kind: "recovered",
        revision: 2,
      });
      expect((await preferences(folder)).profile.locale).toBe("cs");
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

// A Folder as an earlier release left it: every generated file carries that
// release's template revision and text this product cannot render, and the
// manifest records exactly those bytes. Nothing else of the Folder changes.
async function renderedBy(folder: string, revision: string) {
  const path = join(folder, ".lazurio", "instructions.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const outputs: Record<string, string> = {};
  for (const output of outputPaths) {
    const content = `${(
      await readFile(join(folder, output), "utf8")
    ).replaceAll(
      instructionTemplateRevision,
      revision,
    )}\nText of an earlier release.\n`;
    await writeFile(join(folder, output), content);
    outputs[output] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(
    path,
    JSON.stringify({ ...manifest, templateRevision: revision, outputs }),
  );
}

for (const locale of ["cs", "en"] as const)
  test.skipIf(process.platform === "win32")(
    `a Folder of an older template revision is re-rendered in ${locale} by the next refresh, and a second refresh is unchanged`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await initializeMachineFolder(folder, after, { ...noChoices, locale });
        const initial = await preferences(folder);
        await renderedBy(folder, "base-instructions-3");
        // The same handover: only the template revision differs.
        expect(await refreshMachineFolder(folder, after)).toEqual({
          code: 0,
          result: { kind: "refreshed", revision: 2 },
        });
        const current = renderOutputs({
          preset: initial.preset.name,
          machine: initial.machine,
          profile: initial.profile,
        });
        for (const path of outputPaths)
          expect(await readFile(join(folder, path), "utf8")).toBe(
            current[path],
          );
        const manifest = JSON.parse(
          await readFile(join(folder, ".lazurio", "instructions.json"), "utf8"),
        );
        expect(manifest.templateRevision).toBe(instructionTemplateRevision);
        expect(manifest.preferenceRevision).toBe(2);
        for (const path of outputPaths)
          expect(manifest.outputs[path]).toBe(
            createHash("sha256").update(current[path]).digest("hex"),
          );
        // The recorded choices and the binding are carried forward unchanged.
        expect(await preferences(folder)).toEqual({ ...initial, revision: 2 });
        expect(await readdir(join(folder, ".lazurio", "history"))).toContain(
          "revision-2",
        );
        expect(
          await readFile(join(folder, "personalspace", "keep"), "utf8"),
        ).toBe("synthetic work");
        const settled = await snapshot(folder);
        expect(await refreshMachineFolder(folder, after)).toEqual({
          code: 0,
          result: { kind: "unchanged" },
        });
        expect(await snapshot(folder)).toEqual(settled);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

test.skipIf(process.platform === "win32")(
  "a profile change upgrades an older template revision through the same planner",
  async () => {
    const { parent, folder } = await setup();
    try {
      await initializeMachineFolder(folder, after, noChoices);
      const initial = await preferences(folder);
      await renderedBy(folder, "base-instructions-3");
      expect(
        await updateProfile(folder, 1, {
          profile: { ...initial.profile, locale: "cs" },
        }),
      ).toEqual({ kind: "updated", revision: 2 });
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        `<!-- ${instructionTemplateRevision}; `,
      );
      expect(
        await readFile(join(folder, "manual", "this-machine.md"), "utf8"),
      ).toContain(workVmLine.cs);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const path of ["AGENTS.md", "manual/roles.md"] as const)
  test.skipIf(process.platform === "win32")(
    `an upgrade with an edited ${path} is refused by path and nothing is written`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await initializeMachineFolder(folder, after, noChoices);
        await renderedBy(folder, "base-instructions-3");
        await appendFile(join(folder, path), "\nmy own note\n");
        const edited = await snapshot(folder);
        expect(await refreshMachineFolder(folder, after)).toEqual({
          code: 2,
          result: { kind: "blocked", reason: "drift", path },
        });
        expect(await snapshot(folder)).toEqual(edited);
        expect(await readdir(join(folder, ".lazurio"))).not.toContain(
          "transaction",
        );
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

for (const revision of ["base-instructions-99", "custom-1"])
  test.skipIf(process.platform === "win32")(
    `a Folder rendered by ${revision} is never downgraded or re-rendered`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await initializeMachineFolder(folder, after, noChoices);
        await renderedBy(folder, revision);
        const newer = await snapshot(folder);
        expect(await refreshMachineFolder(folder, after)).toEqual({
          code: 2,
          result: { kind: "blocked", reason: "template-upgrade-required" },
        });
        const profile = (await preferences(folder)).profile;
        expect(
          await updateProfile(folder, 1, {
            profile: { ...profile, locale: "cs" },
          }),
        ).toEqual({ kind: "blocked", reason: "template-upgrade-required" });
        expect(await snapshot(folder)).toEqual(newer);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

for (const stop of ["prepared", "applied"] as const)
  test.skipIf(process.platform === "win32")(
    `an upgrade interrupted after ${stop} completes by profile-resume against the recorded digests`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await initializeMachineFolder(folder, after, noChoices);
        const initial = await preferences(folder);
        await renderedBy(folder, "base-instructions-3");
        await expect(
          refreshFolder(folder, after, async (step) => {
            if (step === stop) throw new Error("interrupted");
          }),
        ).rejects.toThrow("interrupted");
        expect(await resumeProfileUpdate(folder, 2)).toEqual({
          kind: "recovered",
          revision: 2,
        });
        const current = renderOutputs({
          preset: initial.preset.name,
          machine: initial.machine,
          profile: initial.profile,
        });
        for (const path of outputPaths)
          expect(await readFile(join(folder, path), "utf8")).toBe(
            current[path],
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
