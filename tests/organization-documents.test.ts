import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrganizationDocuments } from "../src/organizations/read-documents";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Organization acquisition keeps missing, invalid and present documents separate without fallback or writes",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "organization-documents-")),
    );
    const canonical = join(root, "lazurio.organization.json");
    const legacy = join(root, "company.gen3.json");
    const modules = join(root, "modules.manifest.json");
    try {
      expect(await readOrganizationDocuments(root)).toEqual({
        kind: "documents-observed",
        canonical: { kind: "missing" },
        legacy: { kind: "missing" },
        modules: { kind: "missing" },
      });
      const source = JSON.stringify({ fixture: { nested: [1, 2] } });
      await writeFile(canonical, source);
      await writeFile(legacy, "invalid fixture JSON");
      await writeFile(modules, "{}");
      const result = await readOrganizationDocuments(root);
      expect(result).toMatchObject({
        kind: "documents-observed",
        canonical: { kind: "present" },
        legacy: { kind: "invalid" },
        modules: { kind: "present" },
      });
      if (
        result.kind !== "documents-observed" ||
        result.canonical.kind !== "present"
      )
        throw new Error("fixture not read");
      expect(Object.isFrozen(result.canonical.value)).toBe(true);
      expect(Object.isFrozen(result.canonical.value.fixture)).toBe(true);
      expect(await readFile(canonical, "utf8")).toBe(source);
      expect(await readFile(legacy, "utf8")).toBe("invalid fixture JSON");
      // A valid JSON object is acquired, not declared semantically valid.
      for (const content of [
        "null",
        "[]",
        "1",
        Buffer.from([0xff]),
        " ".repeat(1024 * 1024 + 1),
      ]) {
        await writeFile(canonical, content);
        expect(await readOrganizationDocuments(root)).toMatchObject({
          canonical: { kind: "invalid" },
        });
      }
      await rm(canonical);
      await symlink(modules, canonical);
      expect(await readOrganizationDocuments(root)).toMatchObject({
        canonical: { kind: "invalid" },
      });
      await rm(canonical);
      await link(modules, canonical);
      expect(await readOrganizationDocuments(root)).toMatchObject({
        canonical: { kind: "invalid" },
        modules: { kind: "invalid" },
      });
      await rm(canonical);
      await mkdir(canonical);
      expect(await readOrganizationDocuments(root)).toMatchObject({
        canonical: { kind: "invalid" },
      });
      await chmod(modules, 0o666);
      expect(await readOrganizationDocuments(root)).toMatchObject({
        modules: { kind: "invalid" },
      });
      await chmod(root, 0o777);
      expect(await readOrganizationDocuments(root)).toEqual({
        kind: "unavailable",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
