import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { updateProfile } from "../src/folder/update-profile";

for (const stop of [
  null,
  "folder",
  "journal",
  "instructions",
  "preferences",
  "manifest",
  "layout",
] as const) {
  test.skipIf(process.platform === "win32")(
    `fresh initialization ${stop ?? "completes"} never adopts an occupied path`,
    async () => {
      const parent = await realpath(
        await mkdtemp(join(tmpdir(), "folder-init-")),
      );
      const folder = join(parent, "Lazurio");
      const profile = {
        os: executionOs(process.platform),
        access: "local",
        purpose: "human",
        locale: "en",
        detail: "concise",
        coordination: "direct",
      };
      try {
        const run = initializeFolder(folder, profile, async (step) => {
          if (step === stop) throw new Error("Interrupted initialization");
        });
        if (stop) {
          await expect(run).rejects.toThrow("Interrupted initialization");
          await expect(
            updateProfile(folder, 1, { ...profile, locale: "cs" }),
          ).rejects.toThrow();
        } else {
          expect(await run).toEqual({ kind: "initialized", revision: 1 });
          expect((await readdir(folder)).sort()).toEqual([
            ".lazurio",
            "AGENTS.md",
            "organizations",
            "personalspace",
          ]);
          expect(
            await updateProfile(folder, 1, { ...profile, locale: "cs" }),
          ).toEqual({ kind: "updated", revision: 2 });
          expect(
            JSON.parse(
              await readFile(
                join(folder, ".lazurio", "preferences.json"),
                "utf8",
              ),
            ).profile.locale,
          ).toBe("cs");
        }
        const contents = await readdir(folder);
        await expect(initializeFolder(folder, profile)).rejects.toThrow();
        expect(await readdir(folder)).toEqual(contents);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
}
