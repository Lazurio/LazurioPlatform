import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { inspectProfileChange } from "../src/folder/inspect-profile-change";
import { executionOs } from "../src/folder/platform";
import {
  type PreparationStep,
  prepareProfileChange,
} from "../src/folder/prepare-profile-change";
import { previewFolder } from "../src/folder/preview";

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
