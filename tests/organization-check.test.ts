import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runOrganizationCheck,
  runOrganizationCheckCommand,
} from "../src/organizations/check-cli";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";

// LazurioPlatform#1094: an edit of the projected text in both
// company.gen3.json and lazurio.organization.json without recomputing
// compatibility.legacy_projection.sha256 made every reader resolve client
// roots as `conflict`. The check names it and --write repairs exactly the
// digest.

const modules = {
  company: "fixture",
  github_org: "Fixture",
  module_slots: [{ path: "workspace/app", slug: "app" }],
};
const unpinned = {
  schema_version: "lazurio.organization.v1",
  kind: "organization",
  organization: {
    slug: "fixture",
    display_name: "Fixture",
    metadata: {},
    forge_binding: {
      forge: "github",
      locator: "Fixture",
      binding_state: "unverified",
    },
  },
  manifests: { modules: "modules.manifest.json" },
  extensions: {
    legacy: {
      access_governance: { agent_rule: "Old sentence." },
    },
  },
  compatibility: {
    legacy_projection: {
      path: "company.gen3.json",
      algorithm: "sha256-canonical-json-v1",
      sha256: `sha256:${"0".repeat(64)}`,
    },
  },
};
const pin = (canonical: typeof unpinned) => ({
  ...canonical,
  compatibility: {
    legacy_projection: {
      ...canonical.compatibility.legacy_projection,
      sha256: expectedLegacyProjection(canonical, modules).hash,
    },
  },
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function root(canonical: unknown, legacy: unknown): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-organization-check-")),
  );
  roots.push(directory);
  await writeFile(
    join(directory, "lazurio.organization.json"),
    `${JSON.stringify(canonical, null, 2)}\n`,
  );
  await writeFile(
    join(directory, "company.gen3.json"),
    `${JSON.stringify(legacy, null, 2)}\n`,
  );
  await writeFile(
    join(directory, "modules.manifest.json"),
    `${JSON.stringify(modules, null, 2)}\n`,
  );
  return directory;
}

/** The incident's edit: the same sentence changed in the canonical
 * manifest's legacy extension and in company.gen3.json, digest untouched. */
function editedWithoutDigest() {
  const before = pin(unpinned);
  const edited = {
    ...before,
    extensions: {
      legacy: { access_governance: { agent_rule: "New sentence." } },
    },
  };
  const legacy = expectedLegacyProjection(
    pin(edited as typeof unpinned),
    modules,
  ).projection;
  return { edited, legacy };
}

test("a pinned root runs and --write has nothing to do", async () => {
  const canonical = pin(unpinned);
  const directory = await root(
    canonical,
    expectedLegacyProjection(canonical, modules).projection,
  );
  const answer = await runOrganizationCheck(directory, true);
  expect(answer.state).toBe("transition");
  expect(answer.executable).toBe(true);
  expect(answer.write).toBe("nothing-to-write");
});

test("an edited projection without its digest is a conflict the check names (#1094)", async () => {
  const { edited, legacy } = editedWithoutDigest();
  const directory = await root(edited, legacy);
  const { code, text } = await runOrganizationCheckCommand([
    "organization",
    "check",
    directory,
  ]);
  expect(code).toBe(1);
  expect(text).toContain("conflict (does not run)");
  expect(text).toContain("canonical_projection_hash_invalid");
  expect(text).toContain("lazurio organization check --write");
});

test("--write rewrites only the digest and the root runs again (#1094)", async () => {
  const { edited, legacy } = editedWithoutDigest();
  const directory = await root(edited, legacy);
  const path = join(directory, "lazurio.organization.json");
  const before = await readFile(path, "utf8");
  const answer = await runOrganizationCheck(directory, true);
  expect(answer.write).toBe("digest-rewritten");
  expect(answer.state).toBe("transition");
  expect(answer.executable).toBe(true);
  expect(answer.declaredDigest).toBe(answer.expectedDigest as string);
  const after = await readFile(path, "utf8");
  const changed = after
    .split("\n")
    .filter((line, index) => line !== before.split("\n")[index]);
  expect(changed).toEqual([`      "sha256": "${answer.expectedDigest}"`]);
});

test("--write leaves a diverging company.gen3.json a conflict", async () => {
  const { edited } = editedWithoutDigest();
  // company.gen3.json keeps the old sentence: the documents disagree, which
  // a digest must never hide.
  const stale = expectedLegacyProjection(pin(unpinned), modules).projection;
  const directory = await root(edited, stale);
  const answer = await runOrganizationCheck(directory, true);
  expect(answer.write).toBe("digest-rewritten");
  expect(answer.state).toBe("conflict");
  expect(answer.executable).toBe(false);
  expect(answer.issues).toEqual(["normalized_semantics_conflict"]);
});

test("a directory without documents does not run", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-organization-check-")),
  );
  roots.push(directory);
  const { code, text } = await runOrganizationCheckCommand(
    ["organization", "check", "--json"],
    directory,
  );
  expect(code).toBe(1);
  expect(JSON.parse(text)).toMatchObject({ executable: false });
});
