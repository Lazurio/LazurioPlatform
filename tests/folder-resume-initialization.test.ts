import { expect, test } from "bun:test";
import {
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
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { previewFolder } from "../src/folder/preview";
import { resumeInitialization } from "../src/folder/resume-initialization";
import { updateProfile } from "../src/folder/update-profile";

const profile = {
  os: executionOs(process.platform),
  access: "local",
  purpose: "human",
  locale: "en",
  detail: "concise",
  coordination: "direct",
};
for (const scenario of ["foreign-identical", "edit-during-resume"] as const) {
  test.skipIf(process.platform === "win32")(
    `initialization refuses ${scenario}`,
    async () => {
      const parent = await realpath(
        await mkdtemp(join(tmpdir(), "init-provenance-")),
      );
      const folder = join(parent, "Lazurio");
      try {
        await expect(
          initializeFolder(folder, profile, async (step) => {
            if (step === "journal") throw new Error("stop");
          }),
        ).rejects.toThrow();
        if (scenario === "foreign-identical") {
          const desired = await previewFolder(
            { preset: "local", machine: null, profile },
            null,
            async () => ({ kind: "absent" }),
          );
          const content = desired.desired["AGENTS.md"].content;
          await writeFile(join(folder, "AGENTS.md"), content);
          await expect(resumeInitialization(folder)).rejects.toThrow();
          expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
            content,
          );
        } else {
          await expect(
            resumeInitialization(folder, async (step) => {
              if (step === "AGENTS.md")
                await writeFile(
                  join(folder, "AGENTS.md"),
                  "edited during recovery",
                );
            }),
          ).rejects.toThrow();
          expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
            "edited during recovery",
          );
        }
        expect(
          await readFile(
            join(folder, ".lazurio", "transaction", "before.json"),
            "utf8",
          ),
        ).toContain("fresh-folder-initialization");
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
}
for (const stop of [
  "journal",
  "instructions",
  "manual",
  "preferences",
  "manifest",
  "layout",
] as const) {
  test.skipIf(process.platform === "win32")(
    `resume initialization after ${stop} and interrupted recovery`,
    async () => {
      const parent = await realpath(
        await mkdtemp(join(tmpdir(), "init-resume-")),
      );
      const folder = join(parent, "Lazurio");
      try {
        await expect(
          initializeFolder(folder, profile, async (step) => {
            if (step === stop) throw new Error("interrupted");
          }),
        ).rejects.toThrow("interrupted");
        await expect(
          resumeInitialization(folder, async (step) => {
            if (step === "preferences.json")
              throw new Error("interrupted recovery");
          }),
        ).rejects.toThrow("interrupted recovery");
        await expect(
          resumeInitialization(folder, async (step) => {
            if (step === "archived") throw new Error("archive interruption");
          }),
        ).rejects.toThrow("archive interruption");
        expect(await resumeInitialization(folder)).toEqual({
          kind: "recovered",
          revision: 1,
        });
        await writeFile(
          join(folder, "organizations", "keep"),
          "synthetic work",
        );
        expect(await resumeInitialization(folder)).toEqual({
          kind: "recovered",
          revision: 1,
        });
        expect(
          await readFile(join(folder, "organizations", "keep"), "utf8"),
        ).toBe("synthetic work");
        expect(
          await updateProfile(folder, 1, {
            profile: { ...profile, locale: "cs" },
          }),
        ).toEqual({ kind: "updated", revision: 2 });
        await expect(resumeInitialization(folder)).rejects.toThrow();
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "initialization recovery preserves manual edits and rejects missing journal",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "init-preserve-")),
    );
    try {
      const folder = join(parent, "Lazurio");
      await expect(
        initializeFolder(folder, profile, async (step) => {
          if (step === "instructions") throw new Error("stop");
        }),
      ).rejects.toThrow();
      await writeFile(join(folder, "AGENTS.md"), "manual work");
      await expect(resumeInitialization(folder)).rejects.toThrow();
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
        "manual work",
      );
      await expect(
        readFile(join(folder, ".lazurio", "preferences.json")),
      ).rejects.toThrow();
      const early = join(parent, "Early");
      await expect(
        initializeFolder(early, profile, async (step) => {
          if (step === "folder") throw new Error("stop");
        }),
      ).rejects.toThrow();
      await expect(resumeInitialization(early)).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

// A foreign top-level entry that appears after the journal is refused by the
// same Folder boundary the initializer applies: nothing is written, the
// journal stays, and a later resume after the entry is gone still recovers.
test.skipIf(process.platform === "win32")(
  "recovery refuses a foreign entry inserted after the journal before writing anything",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "init-boundary-")),
    );
    const folder = join(parent, "Lazurio");
    try {
      await expect(
        initializeFolder(folder, profile, async (step) => {
          if (step === "journal") throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      const journal = join(folder, ".lazurio", "transaction");
      const before = await readFile(join(journal, "before.json"));
      await mkdir(join(folder, "foreign-after-journal"));
      await expect(resumeInitialization(folder)).rejects.toThrow(
        new FolderAdoptionError("foreign-entry", "foreign-after-journal"),
      );
      expect((await readdir(folder)).sort()).toEqual([
        ".lazurio",
        "foreign-after-journal",
      ]);
      expect(await readdir(journal)).toEqual(["before.json"]);
      expect(await readFile(join(journal, "before.json"))).toEqual(before);
      await rm(join(folder, "foreign-after-journal"), { recursive: true });
      expect(await resumeInitialization(folder)).toEqual({
        kind: "recovered",
        revision: 1,
      });
      expect((await readdir(folder)).sort()).toEqual([
        ".lazurio",
        "AGENTS.md",
        "manual",
        "organizations",
        "personalspace",
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
