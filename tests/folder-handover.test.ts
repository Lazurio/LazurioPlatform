import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderAdoptionError } from "../src/folder/handover-layout";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { resumeInitialization } from "../src/folder/resume-initialization";
import { updateProfile } from "../src/folder/update-profile";
import {
  describeFolderAdoption,
  initializeMachineFolder,
} from "../src/machine/cli";
import { bindings } from "./fixtures/machine-bindings";

const os = executionOs(process.platform);
const choices = { locale: "cs", detail: "technical" } as const;
const sources = {
  personal: {
    preset: "hosted-personal",
    machine: bindings.personal,
    profile: presetProfile("hosted-personal", os, choices),
  },
  organization: {
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    profile: presetProfile("hosted-organization-personal", os, choices),
  },
  team: {
    preset: "hosted-organization-team",
    machine: bindings.team,
    profile: presetProfile("hosted-organization-team", os, choices),
  },
} as const;
// A Team-bearing handover derives no preset, so its preset is always explicit.
const initialized = (name: keyof typeof sources) => ({
  kind: "initialized" as const,
  revision: 1,
  preset: {
    name: sources[name].preset,
    version: 1 as const,
    selection: name === "team" ? ("explicit" as const) : ("derived" as const),
  },
});
const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;
const legacy = ["launchpad.gen3.json", "launchpad.gen3.local.json"];

// A Folder as Machines delivers it and as real Machines already have it:
// organizations/ with work, an optional personalspace/, legacy launchpad files.
async function setup(
  options: {
    personalspace?: "absent" | "empty" | "used";
    work?: boolean;
    legacy?: boolean;
  } = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "handover-adopt-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  if (options.work !== false) {
    await mkdir(join(folder, "organizations", "example"), { mode: 0o700 });
    await writeFile(
      join(folder, "organizations", "example", "keep"),
      "synthetic work",
    );
  }
  const personalspace = options.personalspace ?? "used";
  if (personalspace !== "absent")
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  if (personalspace === "used")
    await writeFile(
      join(folder, "personalspace", "keep"),
      "synthetic personal work",
    );
  if (options.legacy !== false)
    for (const name of legacy)
      await writeFile(join(folder, name), "legacy resident configuration");
  return { parent, folder };
}
async function snapshot(folder: string) {
  const entries = (await readdir(folder)).sort();
  const files: Record<string, string | number[]> = {};
  for (const name of entries) {
    const stat = await lstat(join(folder, name));
    files[name] = stat.isDirectory()
      ? [Number(stat.dev), Number(stat.ino), stat.mode]
      : await readFile(join(folder, name), "utf8");
  }
  return files;
}
async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (error instanceof FolderAdoptionError)
      return { code: error.code, entry: error.entry };
    throw error;
  }
  throw new Error("Expected an adoption refusal");
}

test.skipIf(process.platform === "win32")(
  "adopts a used personal Folder with legacy launchpad files and reports a re-run as already adopted",
  async () => {
    const { parent, folder } = await setup();
    try {
      const before = await snapshot(folder);
      expect(await initializeHandoverFolder(folder, sources.personal)).toEqual(
        initialized("personal"),
      );
      const after = await snapshot(folder);
      expect(Object.keys(after).sort()).toEqual(
        [...Object.keys(before), ".lazurio", "AGENTS.md", "manual"].sort(),
      );
      for (const name of Object.keys(before))
        expect(after[name]).toEqual(before[name]);
      expect(
        await readFile(join(folder, "personalspace", "keep"), "utf8"),
      ).toBe("synthetic personal work");
      const agents = await readFile(join(folder, "AGENTS.md"), "utf8");
      expect(agents).toContain("hosted-personal");
      const state = await snapshot(join(folder, ".lazurio"));
      expect(await initializeHandoverFolder(folder, sources.personal)).toEqual({
        kind: "already-adopted",
        revision: 1,
        preset: initialized("personal").preset,
      });
      expect(await snapshot(join(folder, ".lazurio"))).toEqual(state);
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(agents);
      expect(await snapshot(folder)).toEqual(after);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const name of ["organization", "team"] as const)
  for (const personalspace of ["absent", "empty", "used"] as const)
    test.skipIf(process.platform === "win32")(
      `${sources[name].preset} with ${personalspace} personalspace ${personalspace === "used" ? "refuses without touching it" : "adopts and never creates one"}`,
      async () => {
        const { parent, folder } = await setup({ personalspace });
        try {
          const before = await snapshot(folder);
          if (personalspace === "used") {
            expect(
              await refusal(initializeHandoverFolder(folder, sources[name])),
            ).toEqual({
              code: "personalspace-conflict",
              entry: "personalspace",
            });
            expect(await snapshot(folder)).toEqual(before);
            expect(
              await readFile(join(folder, "personalspace", "keep"), "utf8"),
            ).toBe("synthetic personal work");
            return;
          }
          expect(await initializeHandoverFolder(folder, sources[name])).toEqual(
            initialized(name),
          );
          expect(await resumeInitialization(folder)).toEqual({
            kind: "recovered",
            revision: 1,
          });
          const after = await snapshot(folder);
          expect(after.personalspace).toEqual(before.personalspace);
          expect(Object.hasOwn(after, "personalspace")).toBe(
            personalspace === "empty",
          );
          expect(await initializeHandoverFolder(folder, sources[name])).toEqual(
            {
              kind: "already-adopted",
              revision: 1,
              preset: initialized(name).preset,
            },
          );
        } finally {
          await rm(parent, { recursive: true, force: true });
        }
      },
    );

test.skipIf(process.platform === "win32")(
  "a missing work directory is refused by name and never created",
  async () => {
    const { parent, folder } = await setup({ personalspace: "absent" });
    try {
      expect(
        await refusal(initializeHandoverFolder(folder, sources.personal)),
      ).toEqual({ code: "layout-missing", entry: "personalspace" });
      await rename(join(folder, "organizations"), join(parent, "saved"));
      for (const name of ["personal", "organization"] as const)
        expect(
          await refusal(initializeHandoverFolder(folder, sources[name])),
        ).toEqual({ code: "layout-missing", entry: "organizations" });
      expect((await readdir(folder)).sort()).toEqual(legacy);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const entry of [
  "AGENTS.md",
  "CLAUDE.md",
  "lazurio",
  "manual",
  "notes.txt",
])
  test.skipIf(process.platform === "win32")(
    `a foreign top-level entry ${entry} fails closed by name before any state exists`,
    async () => {
      const { parent, folder } = await setup();
      try {
        if (entry === "lazurio" || entry === "manual")
          await mkdir(join(folder, entry));
        else await writeFile(join(folder, entry), "resident content");
        const before = await snapshot(folder);
        expect(
          await refusal(initializeHandoverFolder(folder, sources.personal)),
        ).toEqual({ code: "foreign-entry", entry });
        expect(await snapshot(folder)).toEqual(before);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

test.skipIf(process.platform === "win32")(
  "a Folder adopted from another handover or with unrecognized state is refused, not rewritten",
  async () => {
    const { parent, folder } = await setup({ personalspace: "empty" });
    try {
      await mkdir(join(folder, ".lazurio"), { mode: 0o700 });
      expect(
        await refusal(initializeHandoverFolder(folder, sources.organization)),
      ).toEqual({ code: "state-unrecognized", entry: ".lazurio" });
      await rm(join(folder, ".lazurio"), { recursive: true });
      expect(
        await initializeHandoverFolder(folder, sources.organization),
      ).toEqual(initialized("organization"));
      const state = await snapshot(join(folder, ".lazurio"));
      expect(
        await refusal(initializeHandoverFolder(folder, sources.team)),
      ).toEqual({ code: "binding-changed", entry: ".lazurio" });
      expect(await snapshot(join(folder, ".lazurio"))).toEqual(state);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "an adopted Organization Folder changes its preset only within the allow-list",
  async () => {
    const { parent, folder } = await setup({ personalspace: "empty" });
    try {
      await initializeHandoverFolder(folder, sources.organization);
      const profile = sources.organization.profile;
      expect(
        await updateProfile(folder, 1, { preset: "hosted-personal", profile }),
      ).toEqual({ kind: "blocked", reason: "preset-not-allowed" });
      expect(
        await updateProfile(folder, 1, {
          preset: "hosted-organization-team",
          profile: { ...profile, locale: "en" },
        }),
      ).toEqual({ kind: "updated", revision: 2 });
      const preferences = JSON.parse(
        await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
      );
      expect(preferences.preset).toEqual({
        name: "hosted-organization-team",
        version: 1,
        selection: "explicit",
      });
      expect(preferences.machine).toEqual(bindings.organization);
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        "hosted-organization-team",
      );
      expect(
        await initializeHandoverFolder(folder, sources.organization),
      ).toEqual({
        kind: "already-adopted",
        revision: 2,
        preset: preferences.preset,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

for (const stop of [
  null,
  "journal",
  "manual-directory",
  "instructions",
  "manual",
  "preferences",
  "manifest",
  "layout",
] as const) {
  test.skipIf(process.platform === "win32")(
    `adoption initializes/resumes at ${stop ?? "completion"} without moving work directories`,
    async () => {
      const { parent, folder } = await setup({ personalspace: "empty" });
      try {
        const before = await snapshot(folder);
        const result = initializeHandoverFolder(
          folder,
          sources.organization,
          async (step) => {
            if (step === stop) throw new Error("interrupted");
          },
        );
        if (stop) await expect(result).rejects.toThrow("interrupted");
        else expect(await result).toEqual(initialized("organization"));
        expect(await resumeInitialization(folder)).toEqual({
          kind: "recovered",
          revision: 1,
        });
        const after = await snapshot(folder);
        for (const name of Object.keys(before))
          expect(after[name]).toEqual(before[name]);
        await writeFile(join(folder, "organizations", "later"), "more work");
        expect(await resumeInitialization(folder)).toEqual({
          kind: "recovered",
          revision: 1,
        });
        expect(
          await initializeHandoverFolder(folder, sources.organization),
        ).toEqual({
          kind: "already-adopted",
          revision: 1,
          preset: initialized("organization").preset,
        });
        expect(
          await readFile(join(folder, "organizations", "later"), "utf8"),
        ).toBe("more work");
        expect(
          await updateProfile(folder, 1, {
            profile: { ...sources.organization.profile, locale: "en" },
          }),
        ).toEqual({ kind: "updated", revision: 2 });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "handover refuses a symlinked work directory before creating state",
  async () => {
    const { parent, folder } = await setup();
    try {
      await rename(join(folder, "organizations"), join(parent, "saved"));
      await symlink(join(parent, "saved"), join(folder, "organizations"));
      const before = await readdir(folder);
      await expect(
        initializeHandoverFolder(folder, sources.personal),
      ).rejects.toThrow();
      expect(await readdir(folder)).toEqual(before);
      await expect(lstat(join(folder, ".lazurio"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

// Ubuntu's default umask 0002 leaves ~/Lazurio and its children 0775.
for (const [entry, mode] of [
  [".", 0o775],
  ["organizations", 0o775],
  ["personalspace", 0o777],
] as const)
  test.skipIf(process.platform === "win32")(
    `a group- or world-writable ${entry} is refused by name before creating state`,
    async () => {
      const { parent, folder } = await setup();
      try {
        await chmod(join(folder, entry), mode);
        const before = await snapshot(folder);
        expect(
          await refusal(initializeHandoverFolder(folder, sources.personal)),
        ).toEqual({ code: "directory-shared", entry });
        expect(await snapshot(folder)).toEqual(before);
        expect(
          describeFolderAdoption(
            new FolderAdoptionError("directory-shared", entry),
          ),
        ).toMatchObject({
          kind: "blocked",
          reason: "folder-directory-shared",
          entry,
        });
        await chmod(join(folder, entry), 0o700);
        expect(
          await initializeHandoverFolder(folder, sources.personal),
        ).toEqual(initialized("personal"));
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

test.skipIf(process.platform === "win32")(
  "handover resume refuses replaced directories before completing generated files",
  async () => {
    const { parent, folder } = await setup();
    try {
      await expect(
        initializeHandoverFolder(folder, sources.personal, async (step) => {
          if (step === "journal") throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      await rename(join(folder, "organizations"), join(parent, "original"));
      await mkdir(join(folder, "organizations"));
      await expect(resumeInitialization(folder)).rejects.toThrow(
        "Handover layout changed",
      );
      await expect(lstat(join(folder, "AGENTS.md"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "concurrent handover initializers have exactly one winner",
  async () => {
    const { parent, folder } = await setup();
    try {
      const results = await Promise.allSettled([
        initializeHandoverFolder(folder, sources.personal),
        initializeHandoverFolder(folder, sources.personal),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(await resumeInitialization(folder)).toEqual({
        kind: "recovered",
        revision: 1,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("the machine CLI reports an adoption refusal by reason and entry", () => {
  expect(
    describeFolderAdoption(new FolderAdoptionError("foreign-entry", "notes")),
  ).toMatchObject({
    kind: "blocked",
    reason: "folder-foreign-entry",
    entry: "notes",
  });
  expect(
    describeFolderAdoption(
      new FolderAdoptionError("personalspace-conflict", "personalspace"),
    ).next,
  ).toContain("nothing is deleted");
});

test.skipIf(process.platform === "win32")(
  "folder-init never guesses on a Team-bearing handover: blocked without --preset, explicit with it, and a re-run keeps the adopted preset",
  async () => {
    const { parent, folder } = await setup({ personalspace: "empty" });
    try {
      const before = await snapshot(folder);
      const blocked = await initializeMachineFolder(
        folder,
        bindings.team,
        noChoices,
      );
      expect(JSON.stringify(blocked.result)).toBe(
        JSON.stringify({
          kind: "blocked",
          reason: "preset-ambiguous",
          allowed: ["hosted-organization-personal", "hosted-organization-team"],
          next: "Pass --preset: this handover names a Team but not whether the Machine is assigned to one operator or shared; the Machines resident role passes it from the owner infrastructure.",
        }),
      );
      expect(blocked.code).toBe(2);
      expect(
        await initializeMachineFolder(folder, bindings.team, {
          ...noChoices,
          preset: "hosted-personal",
        }),
      ).toEqual({
        code: 2,
        result: {
          kind: "blocked",
          reason: "preset-not-allowed",
          derived: null,
          allowed: ["hosted-organization-personal", "hosted-organization-team"],
          next: "Choose a preset the handover allows; this handover derives none.",
        },
      });
      expect(await snapshot(folder)).toEqual(before);
      const explicit = {
        name: "hosted-organization-personal",
        version: 1,
        selection: "explicit",
      } as const;
      expect(
        await initializeMachineFolder(folder, bindings.team, {
          ...noChoices,
          preset: "hosted-organization-personal",
          locale: "cs",
        }),
      ).toEqual({
        code: 0,
        result: { kind: "initialized", revision: 1, preset: explicit },
      });
      const document = await readFile(join(folder, "AGENTS.md"), "utf8");
      expect(document).toContain("hosted-organization-personal");
      expect(document).not.toContain("sdílený");
      // An adopted Folder already has its preset: the re-run without --preset
      // is not ambiguous, and a different --preset does not rewrite it.
      for (const preset of [undefined, "hosted-organization-team"] as const)
        expect(
          await initializeMachineFolder(folder, bindings.team, {
            ...noChoices,
            preset,
          }),
        ).toEqual({
          code: 0,
          result: { kind: "already-adopted", revision: 1, preset: explicit },
        });
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(document);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "folder-init still derives the preset when the handover decides it",
  async () => {
    const { parent, folder } = await setup({ personalspace: "empty" });
    try {
      expect(
        await initializeMachineFolder(folder, bindings.organization, noChoices),
      ).toEqual({
        code: 0,
        result: initialized("organization"),
      });
      expect(
        await initializeMachineFolder(folder, bindings.organization, noChoices),
      ).toEqual({
        code: 0,
        result: { ...initialized("organization"), kind: "already-adopted" },
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "handover resume refuses a foreign entry inserted after the journal and recovers once it is gone",
  async () => {
    const { parent, folder } = await setup({ personalspace: "empty" });
    try {
      await expect(
        initializeHandoverFolder(folder, sources.organization, async (step) => {
          if (step === "journal") throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      const before = await snapshot(folder);
      await mkdir(join(folder, "foreign-after-journal"));
      expect(await refusal(resumeInitialization(folder))).toEqual({
        code: "foreign-entry",
        entry: "foreign-after-journal",
      });
      await rm(join(folder, "foreign-after-journal"), { recursive: true });
      expect(await snapshot(folder)).toEqual(before);
      expect(await resumeInitialization(folder)).toEqual({
        kind: "recovered",
        revision: 1,
      });
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        "hosted-organization-personal",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "handover resume refuses a manual/ inserted after the journal by name and recovers once it is gone",
  async () => {
    const { parent, folder } = await setup({ personalspace: "empty" });
    try {
      await expect(
        initializeHandoverFolder(folder, sources.organization, async (step) => {
          if (step === "journal") throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      const journal = join(folder, ".lazurio", "transaction");
      const before = await readFile(join(journal, "before.json"));
      await mkdir(join(folder, "manual"));
      await writeFile(join(folder, "manual", "foreign.txt"), "not ours");
      expect(await refusal(resumeInitialization(folder))).toEqual({
        code: "foreign-entry",
        entry: "manual",
      });
      await expect(lstat(join(folder, "AGENTS.md"))).rejects.toThrow();
      expect(await readdir(journal)).toEqual(["before.json"]);
      expect(await readFile(join(journal, "before.json"))).toEqual(before);
      expect(
        await readFile(join(folder, "manual", "foreign.txt"), "utf8"),
      ).toBe("not ours");
      await rm(join(folder, "manual"), { recursive: true });
      expect(await resumeInitialization(folder)).toEqual({
        kind: "recovered",
        revision: 1,
      });
      expect((await readdir(join(folder, "manual"))).sort()).toHaveLength(7);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
