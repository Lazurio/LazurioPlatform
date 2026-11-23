import { expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provideOrganizationFiles } from "../src/modules/organization-files";

test("a root that is no Git checkout with a GitHub remote leaves the copy empty: no files and no revision.json, as on the host before its first fetch (H20)", async () => {
  const parent = await mkdtemp(join(tmpdir(), "orgfiles-plain-"));
  const root = join(parent, "root");
  await Bun.write(join(root, "modules.manifest.json"), "{}\n");
  const directory = join(parent, "copy");
  // An earlier copy is replaced as a whole.
  await Bun.write(join(directory, "modules.manifest.json"), "old\n");
  await writeFile(join(directory, "revision.json"), "{}\n");
  expect(
    await provideOrganizationFiles({
      organizationRoot: root,
      directory,
      files: ["modules.manifest.json"],
    }),
  ).toBe(directory);
  expect(await readdir(directory)).toEqual([]);
  expect(await readdir(parent)).toEqual(["copy", "root"]);
});

test("only the canonical manifests can be copied", async () => {
  await expect(
    provideOrganizationFiles({
      organizationRoot: "/nonexistent",
      directory: join(tmpdir(), "never"),
      files: [".env"],
    }),
  ).rejects.toThrow("Undeclarable organization file");
});
