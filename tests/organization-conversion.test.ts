import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { organizationDocumentHash } from "../src/organizations/document-hash";
import { inspectOrganizationConversion } from "../src/organizations/inspect-conversion";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import {
  OrganizationProjectionConflict,
  prepareOrganizationConversion,
} from "../src/organizations/prepare-conversion";

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "compiled conversion preview is read-only and refuses occupied or invalid targets",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "conversion-preview-")),
    );
    const binary = join(root, "cli");
    const canonical = join(root, "lazurio.organization.json");
    try {
      const { legacy, modules } = fixture();
      const legacyBytes = JSON.stringify(legacy);
      const moduleBytes = JSON.stringify(modules);
      await writeFile(join(root, "company.gen3.json"), legacyBytes, {
        mode: 0o600,
      });
      await writeFile(join(root, "modules.manifest.json"), moduleBytes, {
        mode: 0o600,
      });
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "src/cli.ts",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          binary,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const error = new Response(build.stderr).text();
      expect(await build.exited).toBe(0);
      await error;
      const files = (await readdir(root)).sort();
      const child = Bun.spawn(
        [binary, "organization-conversion-preview", "--directory", root],
        { env: {}, stdout: "pipe", stderr: "pipe" },
      );
      const [code, output, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(output)).toEqual(
        prepareOrganizationConversion(legacy, modules),
      );
      expect((await readdir(root)).sort()).toEqual(files);
      expect(await readFile(join(root, "company.gen3.json"), "utf8")).toBe(
        legacyBytes,
      );
      expect(await readFile(join(root, "modules.manifest.json"), "utf8")).toBe(
        moduleBytes,
      );
      const conflictingBytes = JSON.stringify({
        ...legacy,
        modules: [
          { path: "workspace/private-fixture-marker", note: "do-not-echo" },
        ],
      });
      await writeFile(join(root, "company.gen3.json"), conflictingBytes);
      const refused = Bun.spawn(
        [binary, "organization-conversion-preview", "--directory", root],
        { env: {}, stdout: "pipe", stderr: "pipe" },
      );
      const [refusedCode, refusedOutput, refusedError] = await Promise.all([
        refused.exited,
        new Response(refused.stdout).text(),
        new Response(refused.stderr).text(),
      ]);
      expect(refusedCode).toBe(2);
      expect(refusedError).toBe("");
      expect(JSON.parse(refusedOutput)).toEqual({
        kind: "blocked",
        reason: "declaration-reconciliation-required",
        sections: ["modules"],
      });
      expect(refusedOutput).not.toContain("private-fixture-marker");
      expect(refusedOutput).not.toContain("do-not-echo");
      expect((await readdir(root)).sort()).toEqual(files);
      expect(await readFile(join(root, "company.gen3.json"), "utf8")).toBe(
        conflictingBytes,
      );
      expect(await readFile(join(root, "modules.manifest.json"), "utf8")).toBe(
        moduleBytes,
      );
      await writeFile(join(root, "company.gen3.json"), legacyBytes);
      for (const bytes of ["{}", "malformed"]) {
        await writeFile(canonical, bytes);
        expect(await inspectOrganizationConversion(root)).toEqual({
          kind: "blocked",
          reason: "canonical-target-occupied",
        });
        expect(await readFile(canonical, "utf8")).toBe(bytes);
      }
      await rm(canonical);
      await symlink(join(root, "missing"), canonical);
      expect(await inspectOrganizationConversion(root)).toMatchObject({
        kind: "blocked",
        reason: "canonical-target-occupied",
      });
      await rm(canonical);
      await writeFile(join(root, "company.gen3.json"), "{}");
      expect(await inspectOrganizationConversion(root)).toMatchObject({
        kind: "blocked",
        reason: "declaration-reconciliation-required",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("projection refusal identifies only fixed sections, not private values", () => {
  const { legacy, modules } = fixture();
  const changed = {
    ...legacy,
    modules: [
      {
        path: "workspace/private-fixture-marker",
        secretFixture: "do-not-echo",
      },
    ],
  };
  try {
    prepareOrganizationConversion(changed, modules);
    throw new Error("Expected projection conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(OrganizationProjectionConflict);
    const conflict = error as OrganizationProjectionConflict;
    expect(conflict.sections).toEqual(["modules"]);
    expect(Object.isFrozen(conflict.sections)).toBe(true);
    expect(JSON.stringify(conflict)).not.toContain("private-fixture-marker");
    expect(String(conflict)).not.toContain("do-not-echo");
  }
});

function fixture() {
  return {
    legacy: {
      organization_generation: "gen3",
      organization_kind: "organization",
      company: {
        slug: "fixture",
        display_name: "Fixture",
        github_org: "Fixture",
        custom: { preserved: true },
      },
      modules: [
        {
          path: "workspace/app",
          slug: "app",
          repo: "https://github.com/Fixture/app.git",
        },
      ],
      custom: { nested: [1, "two"] },
    },
    modules: {
      company: "fixture",
      github_org: "Fixture",
      module_slots: [
        {
          path: "workspace/app",
          git: { url: "https://github.com/Fixture/app.git" },
        },
      ],
    },
  };
}

test("explicit conversion preserves complete declarations without inventing provider identity", () => {
  const { legacy, modules } = fixture();
  const before = JSON.stringify({ legacy, modules });
  const result = prepareOrganizationConversion(legacy, modules);
  expect(result.kind).toBe("conversion-draft");
  expect(result.legacyHash).toBe(organizationDocumentHash(legacy));
  expect(result.modulesHash).toBe(organizationDocumentHash(modules));
  expect(
    expectedLegacyProjection(result.canonical, modules).projection,
  ).toEqual(legacy);
  expect(result.canonical.organization).toMatchObject({
    forge_binding: { binding_state: "unverified" },
  });
  expect(JSON.stringify(result.canonical)).not.toContain("organization_id");
  expect(Object.isFrozen(result.canonical)).toBe(true);
  expect(JSON.stringify({ legacy, modules })).toBe(before);
});

test("conversion retains declared stable IDs but refuses conflicting or augmented binding data", () => {
  const { legacy, modules } = fixture();
  const bound = {
    ...legacy,
    company: {
      ...legacy.company,
      root_repository: "Fixture/Fixture_GEN3",
      repository: "git@github.com:Fixture/Fixture_GEN3.git",
      default_branch: "main",
    },
    forge_binding: {
      schema_version: "lazurio.forge-binding.github.v0",
      provider: "github",
      organization: { id: "1", asserted_login: "Fixture" },
      repository: {
        id: "2",
        asserted_full_name: "Fixture/Fixture_GEN3",
        default_branch: "main",
      },
    },
  };
  const result = prepareOrganizationConversion(bound, modules);
  expect(
    expectedLegacyProjection(result.canonical, modules).projection,
  ).toEqual(bound);
  const { default_branch: _branch, ...withoutBranch } = bound.company;
  const source = { ...bound, company: withoutBranch };
  const normalized = prepareOrganizationConversion(source, modules);
  expect(normalized.normalizations).toEqual([
    "company.default_branch from forge_binding.repository.default_branch",
  ]);
  expect(normalized.legacyHash).toBe(organizationDocumentHash(source));
  expect(
    expectedLegacyProjection(normalized.canonical, modules).projection,
  ).toEqual(bound);
  expect(source.company).not.toHaveProperty("default_branch");
  expect(() =>
    prepareOrganizationConversion(
      { ...bound, company: { ...bound.company, default_branch: "other" } },
      modules,
    ),
  ).toThrow();
  for (const binding of [
    { ...bound.forge_binding, provider: "other" },
    { ...bound.forge_binding, extra: true },
    {
      ...bound.forge_binding,
      organization: { id: "1", asserted_login: "Other" },
    },
    {
      ...bound.forge_binding,
      repository: { ...bound.forge_binding.repository, id: 2 },
    },
  ])
    expect(() =>
      prepareOrganizationConversion(
        { ...bound, forge_binding: binding },
        modules,
      ),
    ).toThrow();
});

test("conversion refuses inventory drift, alias loss, malformed input and executable hooks", () => {
  const { legacy, modules } = fixture();
  for (const input of [
    { ...legacy, organization_generation: "gen2" },
    { ...legacy, modules: [] },
    {
      ...legacy,
      company: {
        ...legacy.company,
        git_url: "https://github.com/Fixture/root.git",
      },
    },
    { ...legacy, forge_binding: null },
  ])
    expect(() => prepareOrganizationConversion(input, modules)).toThrow();
  expect(() =>
    prepareOrganizationConversion(legacy, { ...modules, company: "other" }),
  ).toThrow();
  expect(() =>
    prepareOrganizationConversion(legacy, {
      ...modules,
      module_slots: [...modules.module_slots, ...modules.module_slots],
    }),
  ).toThrow();
  let invoked = false;
  const hostile = {
    get company() {
      invoked = true;
      return legacy.company;
    },
  };
  expect(() => prepareOrganizationConversion(hostile, modules)).toThrow();
  expect(invoked).toBe(false);
});
