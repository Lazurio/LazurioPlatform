import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstructions } from "../src/folder/inventory";
import { previewFolder } from "../src/folder/preview";

test.skipIf(process.platform === "win32")(
  "real directory preview preserves existing and unknown files",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "folder-preview-"));
    try {
      const inspect = () => inspectInstructions(directory);
      const fresh = await previewFolder(profile, null, inspect);
      expect(fresh.plan.kind).toBe("create");
      expect(await readdir(directory)).toEqual([]);
      await writeFile(join(directory, "AGENTS.md"), fresh.desired.content);
      await writeFile(join(directory, "user-notes.txt"), "Keep my work");
      const proposed = await previewFolder(
        { ...profile, locale: "en" },
        fresh.desired.digest,
        inspect,
      );
      expect(proposed.plan.kind).toBe("replace");
      expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
        fresh.desired.content,
      );
      expect(await readFile(join(directory, "user-notes.txt"), "utf8")).toBe(
        "Keep my work",
      );
      expect((await readdir(directory)).sort()).toEqual([
        "AGENTS.md",
        "user-notes.txt",
      ]);
      await writeFile(join(directory, "AGENTS.md"), "My edits");
      expect(
        (await previewFolder(profile, fresh.desired.digest, inspect)).plan,
      ).toEqual({ kind: "blocked", reason: "drift" });
      expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
        "My edits",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

const profile = {
  os: "macos",
  access: "local",
  purpose: "human",
  locale: "cs",
  detail: "concise",
  coordination: "direct",
};
test("shared preview produces equivalent proposals and refuses drift", async () => {
  const first = await previewFolder(profile, null, async () => ({
    kind: "absent",
  }));
  expect(first.plan).toEqual({ kind: "create", path: "AGENTS.md" });
  expect(
    await previewFolder(profile, null, async () => ({ kind: "absent" })),
  ).toEqual(first);
  const matching = async () => ({
    kind: "regular" as const,
    digest: first.desired.digest,
  });
  expect(
    (await previewFolder(profile, first.desired.digest, matching)).plan,
  ).toEqual({ kind: "unchanged" });
  const changed = await previewFolder(
    { ...profile, locale: "en" },
    first.desired.digest,
    matching,
  );
  expect(changed.plan).toEqual({ kind: "replace", path: "AGENTS.md" });
  expect((await previewFolder(profile, null, matching)).plan).toEqual({
    kind: "blocked",
    reason: "unowned-file",
  });
  expect(
    (
      await previewFolder(profile, first.desired.digest, async () => ({
        kind: "regular",
        digest: "b".repeat(64),
      }))
    ).plan,
  ).toEqual({ kind: "blocked", reason: "drift" });
});
test("invalid input stops before inventory; inventory failure is not success", async () => {
  let inspected = false;
  const inspect = async () => {
    inspected = true;
    return { kind: "absent" as const };
  };
  await expect(previewFolder({}, null, inspect)).rejects.toThrow();
  await expect(previewFolder(profile, "invalid", inspect)).rejects.toThrow();
  expect(inspected).toBe(false);
  await expect(
    previewFolder(profile, null, async () => {
      throw new Error("Inventory unavailable");
    }),
  ).rejects.toThrow("Inventory unavailable");
});
