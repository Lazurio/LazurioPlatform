import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectOutput } from "../src/folder/inventory";
import { outputPaths } from "../src/folder/outputs";
import { previewFolder } from "../src/folder/preview";

const source = (profile: unknown) => ({
  preset: "local",
  machine: null,
  profile,
});

test.skipIf(process.platform === "win32")(
  "real directory preview preserves existing and unknown files",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "folder-preview-"));
    try {
      const inspect = (path: (typeof outputPaths)[number]) =>
        inspectOutput(directory, path);
      const fresh = await previewFolder(source(profile), null, inspect);
      expect(fresh.plan).toEqual({
        kind: "write",
        files: outputPaths.map((path) => ({ kind: "create", path })),
      });
      expect(await readdir(directory)).toEqual([]);
      const content = fresh.desired["AGENTS.md"].content;
      await writeFile(join(directory, "AGENTS.md"), content);
      await writeFile(join(directory, "user-notes.txt"), "Keep my work");
      // Only AGENTS.md is owned here; the absent manual files are created.
      const previous = { "AGENTS.md": fresh.desired["AGENTS.md"].digest };
      const proposed = await previewFolder(
        source({ ...profile, locale: "en" }),
        previous,
        inspect,
      );
      expect(proposed.plan).toEqual({
        kind: "write",
        files: outputPaths.map((path) => ({
          kind: path === "AGENTS.md" ? "replace" : "create",
          path,
        })),
      });
      expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
        content,
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
        (await previewFolder(source(profile), previous, inspect)).plan,
      ).toEqual({ kind: "blocked", reason: "drift", path: "AGENTS.md" });
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
  const first = await previewFolder(source(profile), null, async () => ({
    kind: "absent",
  }));
  expect(first.plan).toEqual({
    kind: "write",
    files: outputPaths.map((path) => ({ kind: "create", path })),
  });
  expect(
    await previewFolder(source(profile), null, async () => ({
      kind: "absent",
    })),
  ).toEqual(first);
  const previous = Object.fromEntries(
    outputPaths.map((path) => [path, first.desired[path].digest]),
  );
  const matching = async (path: (typeof outputPaths)[number]) => ({
    kind: "regular" as const,
    digest: first.desired[path].digest,
  });
  expect(
    (await previewFolder(source(profile), previous, matching)).plan,
  ).toEqual({ kind: "unchanged" });
  const changed = await previewFolder(
    source({ ...profile, locale: "en" }),
    previous,
    matching,
  );
  expect(changed.plan).toEqual({
    kind: "write",
    files: [{ kind: "replace", path: "AGENTS.md" }],
  });
  expect((await previewFolder(source(profile), null, matching)).plan).toEqual({
    kind: "blocked",
    reason: "unowned-file",
    path: "AGENTS.md",
  });
  expect(
    (
      await previewFolder(source(profile), previous, async () => ({
        kind: "regular",
        digest: "b".repeat(64),
      }))
    ).plan,
  ).toEqual({ kind: "blocked", reason: "drift", path: "AGENTS.md" });
});
test("invalid input stops before inventory; inventory failure is not success", async () => {
  let inspected = false;
  const inspect = async () => {
    inspected = true;
    return { kind: "absent" as const };
  };
  await expect(previewFolder(source({}), null, inspect)).rejects.toThrow();
  await expect(
    previewFolder(source(profile), { "AGENTS.md": "invalid" }, inspect),
  ).rejects.toThrow();
  expect(inspected).toBe(false);
  await expect(
    previewFolder(source(profile), null, async () => {
      throw new Error("Inventory unavailable");
    }),
  ).rejects.toThrow("Inventory unavailable");
});
