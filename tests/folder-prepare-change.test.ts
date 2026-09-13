import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPreparation,
  finalizePreparation,
} from "../src/folder/apply-preparation";
import { inspectPreparation } from "../src/folder/inspect-preparation";
import { inspectProfileChange } from "../src/folder/inspect-profile-change";
import { executionOs } from "../src/folder/platform";
import {
  type PreparationStep,
  prepareProfileChange,
} from "../src/folder/prepare-profile-change";
import { previewFolder } from "../src/folder/preview";
import { retireIncompletePreparation } from "../src/folder/retire-preparation";
import { validatePreparation } from "../src/folder/validate-preparation";

async function fixture() {
  const folder = await realpath(
    await mkdtemp(join(tmpdir(), "profile-prepare-")),
  );
  try {
    const state = join(folder, ".lazurio");
    await mkdir(state, { mode: 0o700 });
    const profile = {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    };
    const preview = await previewFolder(profile, null, async () => ({
      kind: "absent",
    }));
    const preferences = JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      profile,
      customInstructions: "",
    });
    const manifest = JSON.stringify({
      schemaVersion: 1,
      preferenceRevision: 1,
      templateRevision: preview.templateRevision,
      output: { path: "AGENTS.md", digest: preview.desired.digest },
    });
    await writeFile(join(folder, "AGENTS.md"), preview.desired.content);
    await writeFile(join(folder, "own-notes"), "Preserve user work");
    await writeFile(join(state, "preferences.json"), preferences, {
      mode: 0o600,
    });
    await writeFile(join(state, "instructions.json"), manifest, {
      mode: 0o600,
    });
    return {
      folder,
      state,
      profile,
      preferences,
      manifest,
      content: preview.desired.content,
    };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

for (const stop of [
  "before",
  "preferences",
  "manifest",
  "instructions",
] as const) {
  test.skipIf(process.platform === "win32")(
    `retire incomplete ${stop} and reprepare without active writes`,
    async () => {
      const f = await fixture();
      const id = "a".repeat(32);
      try {
        await expect(
          prepareProfileChange(
            f.folder,
            1,
            { ...f.profile, locale: "cs" },
            async (step) => {
              if (step === stop) throw new Error("Interrupted");
            },
          ),
        ).rejects.toThrow("Interrupted");
        const transaction = join(f.state, "transaction");
        const files = await readdir(transaction);
        const contents = await Promise.all(
          files.map((name) => readFile(join(transaction, name))),
        );
        await expect(
          retireIncompletePreparation(f.folder, 1, id, async () => {
            throw new Error("Archive interrupted");
          }),
        ).rejects.toThrow("Archive interrupted");
        expect((await retireIncompletePreparation(f.folder, 1, id)).kind).toBe(
          "incomplete-preparation-retained",
        );
        const archive = join(f.state, "history", `incomplete-${id}`);
        expect(
          await Promise.all(files.map((name) => readFile(join(archive, name)))),
        ).toEqual(contents);
        expect(await readFile(join(f.folder, "AGENTS.md"), "utf8")).toBe(
          f.content,
        );
        expect(await readFile(join(f.state, "preferences.json"), "utf8")).toBe(
          f.preferences,
        );
        expect(await readFile(join(f.state, "instructions.json"), "utf8")).toBe(
          f.manifest,
        );
        expect(
          (
            await prepareProfileChange(f.folder, 1, {
              ...f.profile,
              locale: "cs",
            })
          ).kind,
        ).toBe("prepared");
        await applyPreparation(f.folder);
        await finalizePreparation(f.folder, 2);
      } finally {
        await rm(f.folder, { recursive: true, force: true });
      }
    },
  );
}

for (const mode of ["empty", "prepared", "edited"] as const) {
  test.skipIf(process.platform === "win32")(
    `incomplete recovery refuses ${mode}`,
    async () => {
      const f = await fixture();
      try {
        if (mode === "prepared")
          await prepareProfileChange(f.folder, 1, {
            ...f.profile,
            locale: "cs",
          });
        else
          await expect(
            prepareProfileChange(
              f.folder,
              1,
              { ...f.profile, locale: "cs" },
              async (step) => {
                if (step === (mode === "empty" ? "directory" : "before"))
                  throw new Error("Interrupted");
              },
            ),
          ).rejects.toThrow("Interrupted");
        if (mode === "edited")
          await writeFile(join(f.folder, "AGENTS.md"), "Manual edit");
        const active = await readFile(join(f.folder, "AGENTS.md"));
        const files = await readdir(join(f.state, "transaction"));
        await expect(
          retireIncompletePreparation(f.folder, 1, "b".repeat(32)),
        ).rejects.toThrow();
        expect(await readFile(join(f.folder, "AGENTS.md"))).toEqual(active);
        expect(await readdir(join(f.state, "transaction"))).toEqual(files);
      } finally {
        await rm(f.folder, { recursive: true, force: true });
      }
    },
  );
}

for (const stop of [null, "history", "archived"] as const) {
  test.skipIf(process.platform === "win32")(
    `finalization ${stop ?? "completes"} retains evidence and permits the next profile change`,
    async () => {
      const f = await fixture();
      try {
        await prepareProfileChange(f.folder, 1, { ...f.profile, locale: "cs" });
        await expect(finalizePreparation(f.folder, 2)).rejects.toThrow(
          "not fully applied",
        );
        await applyPreparation(f.folder);
        const before = await readFile(
          join(f.state, "transaction", "before.json"),
        );
        const prepared = await readFile(
          join(f.state, "transaction", "prepared.json"),
        );
        if (stop)
          await expect(
            finalizePreparation(f.folder, 2, async (step) => {
              if (step === stop) throw new Error("Interrupted finalization");
            }),
          ).rejects.toThrow("Interrupted finalization");
        expect(await finalizePreparation(f.folder, 2)).toEqual({
          kind: "finalized",
          revision: 2,
        });
        expect(await finalizePreparation(f.folder, 2)).toEqual({
          kind: "finalized",
          revision: 2,
        });
        const archive = join(f.state, "history", "revision-2");
        expect(await readFile(join(archive, "before.json"))).toEqual(before);
        expect(await readFile(join(archive, "prepared.json"))).toEqual(
          prepared,
        );
        expect((await inspectProfileChange(f.folder, 2, f.profile)).kind).toBe(
          "profile-change",
        );
        await prepareProfileChange(f.folder, 2, f.profile);
        expect(
          (await inspectPreparation(f.folder)).plan.preferences.revision,
        ).toBe(3);
        await applyPreparation(f.folder);
        await finalizePreparation(f.folder, 3);
        expect((await readdir(join(f.state, "history"))).sort()).toEqual([
          "revision-2",
          "revision-3",
        ]);
        expect(await readFile(join(archive, "before.json"))).toEqual(before);
        expect(await readFile(join(f.folder, "AGENTS.md"), "utf8")).toBe(
          f.content,
        );
        expect(await readFile(join(f.folder, "own-notes"), "utf8")).toBe(
          "Preserve user work",
        );
        await expect(finalizePreparation(f.folder, 2)).rejects.toThrow();
      } finally {
        await rm(f.folder, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "finalization never replaces occupied history",
  async () => {
    const f = await fixture();
    try {
      await prepareProfileChange(f.folder, 1, { ...f.profile, locale: "cs" });
      await applyPreparation(f.folder);
      const history = join(f.state, "history");
      await mkdir(history, { mode: 0o700 });
      const occupied = join(history, "revision-2");
      await mkdir(occupied, { mode: 0o700 });
      await writeFile(join(occupied, "notes"), "Retained evidence");
      await expect(finalizePreparation(f.folder, 2)).rejects.toThrow(
        "already exists",
      );
      expect(await readFile(join(occupied, "notes"), "utf8")).toBe(
        "Retained evidence",
      );
      expect((await readdir(join(f.state, "transaction"))).sort()).toEqual([
        "before.json",
        "prepared.json",
      ]);
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  },
);

for (const invalid of [
  "partial",
  "out-of-order",
  "foreign-applied-inode",
] as const) {
  test.skipIf(process.platform === "win32")(
    `application refuses ${invalid} without further writes`,
    async () => {
      const f = await fixture();
      try {
        await prepareProfileChange(f.folder, 1, { ...f.profile, locale: "cs" });
        const stage = join(f.state, "transaction");
        if (invalid === "partial") {
          await rm(join(stage, "prepared.json"));
        } else if (invalid === "out-of-order") {
          await rename(
            join(stage, "preferences.json"),
            join(f.state, "preferences.json"),
          );
        } else {
          await rename(join(stage, "AGENTS.md"), join(f.folder, "AGENTS.md"));
          await writeFile(
            join(f.folder, "foreign"),
            await readFile(join(f.folder, "AGENTS.md")),
            { mode: 0o600 },
          );
          await rename(join(f.folder, "foreign"), join(f.folder, "AGENTS.md"));
        }
        const active = await readFile(join(f.folder, "AGENTS.md"));
        const preferences = await readFile(join(f.state, "preferences.json"));
        const entries = (await readdir(stage)).sort();
        await expect(applyPreparation(f.folder)).rejects.toThrow();
        expect(await readFile(join(f.folder, "AGENTS.md"))).toEqual(active);
        expect(await readFile(join(f.state, "preferences.json"))).toEqual(
          preferences,
        );
        expect(await readFile(join(f.state, "instructions.json"), "utf8")).toBe(
          f.manifest,
        );
        expect((await readdir(stage)).sort()).toEqual(entries);
      } finally {
        await rm(f.folder, { recursive: true, force: true });
      }
    },
  );
}

for (const stop of [
  null,
  "renamed:AGENTS.md",
  "renamed:preferences.json",
  "renamed:instructions.json",
  "AGENTS.md",
  "preferences.json",
  "instructions.json",
] as const) {
  test.skipIf(process.platform === "win32")(
    `application resumes after ${stop ?? "no interruption"}`,
    async () => {
      const f = await fixture();
      try {
        await prepareProfileChange(f.folder, 1, { ...f.profile, locale: "cs" });
        const desired = await readFile(
          join(f.state, "transaction", "AGENTS.md"),
          "utf8",
        );
        if (stop) {
          await expect(
            applyPreparation(f.folder, async (step) => {
              if (step === stop)
                throw new Error("Injected application interruption");
            }),
          ).rejects.toThrow("Injected application interruption");
        }
        expect(await applyPreparation(f.folder)).toEqual({
          kind: "applied-journal-retained",
          revision: 2,
        });
        expect(await applyPreparation(f.folder)).toEqual({
          kind: "applied-journal-retained",
          revision: 2,
        });
        expect(await readFile(join(f.folder, "AGENTS.md"), "utf8")).toBe(
          desired,
        );
        expect(
          JSON.parse(await readFile(join(f.state, "preferences.json"), "utf8"))
            .revision,
        ).toBe(2);
        expect(
          JSON.parse(await readFile(join(f.state, "instructions.json"), "utf8"))
            .preferenceRevision,
        ).toBe(2);
        expect((await readdir(join(f.state, "transaction"))).sort()).toEqual([
          "before.json",
          "prepared.json",
        ]);
        expect(await readFile(join(f.folder, "own-notes"), "utf8")).toBe(
          "Preserve user work",
        );
        await expect(
          inspectProfileChange(f.folder, 2, f.profile),
        ).rejects.toThrow("pending");
      } finally {
        await rm(f.folder, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "application preserves edits after interrupted activation",
  async () => {
    const f = await fixture();
    try {
      await prepareProfileChange(f.folder, 1, { ...f.profile, locale: "cs" });
      await expect(
        applyPreparation(f.folder, async () => {
          await writeFile(
            join(f.folder, "AGENTS.md"),
            "New work after activation",
          );
          throw new Error("Interrupted");
        }),
      ).rejects.toThrow("Interrupted");
      await expect(applyPreparation(f.folder)).rejects.toThrow("conflicts");
      expect(await readFile(join(f.folder, "AGENTS.md"), "utf8")).toBe(
        "New work after activation",
      );
      expect(await readFile(join(f.state, "preferences.json"), "utf8")).toBe(
        f.preferences,
      );
      expect(await readFile(join(f.state, "instructions.json"), "utf8")).toBe(
        f.manifest,
      );
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  },
);

for (const stop of [
  null,
  "directory",
  "before",
  "preferences",
  "manifest",
  "instructions",
  "prepared",
] as const) {
  test.skipIf(process.platform === "win32")(
    `preparation ${stop ?? "completes"} preserves active state and retains transaction evidence`,
    async () => {
      const f = await fixture();
      try {
        const requested = { ...f.profile, locale: "cs" };
        const checkpoint = async (step: PreparationStep) => {
          if (step === stop) throw new Error("Injected interruption");
        };
        const pending = prepareProfileChange(
          f.folder,
          1,
          requested,
          checkpoint,
        );
        if (stop)
          await expect(pending).rejects.toThrow("Injected interruption");
        else
          expect(await pending).toEqual({
            kind: "prepared",
            expectedRevision: 1,
            nextRevision: 2,
          });
        expect(await readFile(join(f.folder, "AGENTS.md"), "utf8")).toBe(
          f.content,
        );
        expect(await readFile(join(f.folder, "own-notes"), "utf8")).toBe(
          "Preserve user work",
        );
        expect(await readFile(join(f.state, "preferences.json"), "utf8")).toBe(
          f.preferences,
        );
        expect(await readFile(join(f.state, "instructions.json"), "utf8")).toBe(
          f.manifest,
        );
        expect((await readdir(f.state)).sort()).toEqual([
          "instructions.json",
          "preferences.json",
          "transaction",
        ]);
        await expect(
          inspectProfileChange(f.folder, 1, requested),
        ).rejects.toThrow("pending");
        if (!stop || stop === "prepared") {
          const staged = await readFile(
            join(f.state, "transaction", "AGENTS.md"),
          );
          const marker = JSON.parse(
            await readFile(
              join(f.state, "transaction", "prepared.json"),
              "utf8",
            ),
          );
          expect(marker.outputDigest).toBe(
            createHash("sha256").update(staged).digest("hex"),
          );
          expect(marker.nextRevision).toBe(2);
          expect(
            (await inspectPreparation(f.folder)).plan.preferences.revision,
          ).toBe(2);
          const before = JSON.parse(
            await readFile(join(f.state, "transaction", "before.json"), "utf8"),
          );
          const preferences = JSON.parse(
            await readFile(
              join(f.state, "transaction", "preferences.json"),
              "utf8",
            ),
          );
          const manifest = JSON.parse(
            await readFile(
              join(f.state, "transaction", "instructions.json"),
              "utf8",
            ),
          );
          const valid = await validatePreparation(
            before,
            preferences,
            manifest,
            marker,
            staged.toString("utf8"),
          );
          expect(valid.plan.preferences.revision).toBe(2);
          await expect(
            validatePreparation(
              before,
              preferences,
              manifest,
              { ...marker, nextRevision: 3 },
              staged.toString("utf8"),
            ),
          ).rejects.toThrow("revision");
          await expect(
            validatePreparation(
              before,
              preferences,
              manifest,
              marker,
              "Modified stage",
            ),
          ).rejects.toThrow("regenerated");
          await expect(
            validatePreparation(
              before,
              { ...preferences, customInstructions: "Unreviewed source" },
              manifest,
              marker,
              staged.toString("utf8"),
            ),
          ).rejects.toThrow("regenerated");
          await expect(
            validatePreparation(
              before,
              preferences,
              manifest,
              { ...marker, outputIdentity: { dev: "1", ino: "../file" } },
              staged.toString("utf8"),
            ),
          ).rejects.toThrow("identity");
          await expect(
            validatePreparation(
              { ...before, schemaVersion: 3 },
              preferences,
              manifest,
              marker,
              staged.toString("utf8"),
            ),
          ).rejects.toThrow("schema");
        } else
          expect(await readdir(join(f.state, "transaction"))).not.toContain(
            "prepared.json",
          );
      } finally {
        await rm(f.folder, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "edits during preparation are preserved and prevent the prepared marker",
  async () => {
    const f = await fixture();
    try {
      await expect(
        prepareProfileChange(
          f.folder,
          1,
          { ...f.profile, locale: "cs" },
          async (step) => {
            if (step === "instructions")
              await writeFile(join(f.folder, "AGENTS.md"), "New user edit");
          },
        ),
      ).rejects.toThrow("changed during preparation");
      expect(await readFile(join(f.folder, "AGENTS.md"), "utf8")).toBe(
        "New user edit",
      );
      expect(await readFile(join(f.state, "preferences.json"), "utf8")).toBe(
        f.preferences,
      );
      expect(await readdir(join(f.state, "transaction"))).not.toContain(
        "prepared.json",
      );
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "stale and unchanged requests never create a transaction",
  async () => {
    const f = await fixture();
    try {
      expect(await prepareProfileChange(f.folder, 2, f.profile)).toEqual({
        kind: "blocked",
        reason: "stale-revision",
      });
      expect(await prepareProfileChange(f.folder, 1, f.profile)).toEqual({
        kind: "unchanged",
      });
      expect((await readdir(f.state)).sort()).toEqual([
        "instructions.json",
        "preferences.json",
      ]);
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  },
);

for (const target of ["active", "staged"] as const) {
  for (const name of ["preferences.json", "instructions.json"] as const) {
    test.skipIf(process.platform === "win32")(
      `prepared inspection rejects replacement of ${target} ${name}`,
      async () => {
        const f = await fixture();
        try {
          await prepareProfileChange(f.folder, 1, {
            ...f.profile,
            locale: "cs",
          });
          const path =
            target === "active"
              ? join(f.state, name)
              : join(f.state, "transaction", name);
          const bytes = await readFile(path);
          const replacement = join(f.folder, "replacement");
          await writeFile(replacement, bytes, { mode: 0o600 });
          await rename(replacement, path);
          await expect(inspectPreparation(f.folder)).rejects.toThrow(
            "no longer matches",
          );
          expect(await readFile(path)).toEqual(bytes);
        } finally {
          await rm(f.folder, { recursive: true, force: true });
        }
      },
    );
  }
  test.skipIf(process.platform === "win32")(
    `prepared inspection rejects in-place BOM edit of ${target} instructions`,
    async () => {
      const f = await fixture();
      try {
        await prepareProfileChange(f.folder, 1, { ...f.profile, locale: "cs" });
        const path =
          target === "active"
            ? join(f.folder, "AGENTS.md")
            : join(f.state, "transaction", "AGENTS.md");
        const changed = Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          await readFile(path),
        ]);
        await writeFile(path, changed);
        await expect(inspectPreparation(f.folder)).rejects.toThrow();
        expect(await readFile(path)).toEqual(changed);
      } finally {
        await rm(f.folder, { recursive: true, force: true });
      }
    },
  );
  test.skipIf(process.platform === "win32")(
    `prepared inspection rejects identical-byte ${target} file replacement`,
    async () => {
      const f = await fixture();
      try {
        await prepareProfileChange(f.folder, 1, { ...f.profile, locale: "cs" });
        const path =
          target === "active"
            ? join(f.folder, "AGENTS.md")
            : join(f.state, "transaction", "AGENTS.md");
        const bytes = await readFile(path);
        const replacement = join(f.folder, "replacement");
        await writeFile(replacement, bytes, { mode: 0o600 });
        await rename(replacement, path);
        await expect(inspectPreparation(f.folder)).rejects.toThrow(
          "no longer matches",
        );
        expect(await readFile(path)).toEqual(bytes);
        expect(await readFile(join(f.state, "preferences.json"), "utf8")).toBe(
          f.preferences,
        );
      } finally {
        await rm(f.folder, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "prepared inspection rejects new preference state without reverting it",
  async () => {
    const f = await fixture();
    try {
      await prepareProfileChange(f.folder, 1, { ...f.profile, locale: "cs" });
      const edited = JSON.stringify({
        ...JSON.parse(f.preferences),
        revision: 2,
      });
      await writeFile(join(f.state, "preferences.json"), edited);
      await expect(inspectPreparation(f.folder)).rejects.toThrow(
        "no longer matches",
      );
      expect(await readFile(join(f.state, "preferences.json"), "utf8")).toBe(
        edited,
      );
      expect(await readFile(join(f.folder, "AGENTS.md"), "utf8")).toBe(
        f.content,
      );
    } finally {
      await rm(f.folder, { recursive: true, force: true });
    }
  },
);
