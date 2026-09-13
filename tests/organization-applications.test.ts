import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { readOrganizationApplications } from "../src/organizations/read-applications";
import { readCanonicalDocuments } from "../src/organizations/read-documents";

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

posixTest(
  "authenticated Launchpad discovery uses only its configured directory and never grants application control",
  async () => {
    await fixture(async (root) => {
      const folder = join(root, "Folder");
      await initializeFolder(folder, {
        os: executionOs(process.platform),
        access: "local",
        purpose: "human",
        locale: "en",
        detail: "concise",
        coordination: "direct",
      });
      const app = await startLaunchpad(folder, undefined, {
        organizationDirectory: root,
      });
      const session = new URL(app.url);
      const headers = {
        "Content-Type": "application/json",
        Origin: session.origin,
        Authorization: `Bearer ${session.hash.slice(1)}`,
      };
      const call = (path: string, body: unknown, override = {}) =>
        fetch(new URL(path, session), {
          method: "POST",
          headers: { ...headers, ...override },
          body: JSON.stringify(body),
        });
      try {
        expect(
          (await call("/api/apps/discover", {}, { Authorization: "" })).status,
        ).toBe(403);
        expect(
          (
            await call(
              "/api/apps/discover",
              {},
              { Origin: "https://foreign.invalid" },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await call("/api/apps/discover", {
              directory: "/not-a-permitted-target",
            })
          ).status,
        ).toBe(400);
        expect(await (await call("/api/apps/discover", {})).json()).toEqual(
          await readOrganizationApplications(root),
        );
        expect(
          (
            await call("/api/apps/start", {
              company: "fixture",
              module: "web",
              package: "app/package.json",
            })
          ).status,
        ).toBe(503);
        await rm(join(root, "lazurio.organization.json"));
        expect(await (await call("/api/apps/discover", {})).json()).toEqual({
          kind: "canonical-documents-required",
        });
      } finally {
        expect((await app.close()).kind).toBe("closed");
      }
    });
  },
);
const canonical = {
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
  extensions: { legacy: {} },
  compatibility: {
    legacy_projection: {
      path: "company.gen3.json",
      algorithm: "sha256-canonical-json-v1",
      sha256: `sha256:${"0".repeat(64)}`,
    },
  },
};
async function fixture(
  run: (
    root: string,
    inventory: {
      company: string;
      github_org: string;
      module_slots: { path: string; slug?: string }[];
    },
  ) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "organization-applications-")),
  );
  const inventory = {
    company: "fixture",
    github_org: "Fixture",
    module_slots: [
      { path: "workspace/web", slug: "web" },
      { path: "workspace/web/db" },
      { path: "productionspace/source", slug: "source" },
    ],
  };
  try {
    await writeFile(
      join(root, "lazurio.organization.json"),
      JSON.stringify(canonical),
    );
    await writeFile(
      join(root, "modules.manifest.json"),
      JSON.stringify(inventory),
    );
    await mkdir(join(root, "workspace/web/app"), { recursive: true });
    await writeFile(
      join(root, "workspace/web/lazurio.module.json"),
      JSON.stringify({
        schema_version: "lazurio.module.v1",
        id: "web",
        company: "fixture",
        tcp_port_policy: { mode: "single" },
        port_leases: [{ id: "main", host: "127.0.0.1", port: 4100 }],
        apps: ["app/package.json"],
        default_app: "app/package.json",
      }),
    );
    await writeFile(
      join(root, "workspace/web/app/package.json"),
      JSON.stringify({
        name: "fixture-web",
        scripts: { dev: "must never execute" },
        lazurio: {
          runtime: {
            schema_version: "lazurio.runtime.v1",
            id: "web",
            title: "Web",
            company: "fixture",
            module: "web",
            surface: "internal",
            dev_script: "dev",
            tags: [],
            listeners: [
              {
                id: "web",
                role: "entrypoint",
                lease: "main",
                protocol: "http",
                health: { kind: "http", path: "/" },
              },
            ],
          },
        },
      }),
    );
    await run(root, inventory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

posixTest(
  "canonical application inspection observes declared apps without executing, scanning DBs or reading legacy state",
  async () => {
    await fixture(async (root) => {
      // A hostile/unreadable legacy reference is irrelevant to canonical acquisition.
      await symlink(
        "/nonexistent-legacy-fixture",
        join(root, "company.gen3.json"),
      );
      expect(await readCanonicalDocuments(root)).not.toHaveProperty("legacy");
      const before = await readFile(
        join(root, "workspace/web/app/package.json"),
      );
      expect(await readOrganizationApplications(root)).toEqual({
        kind: "applications-observed",
        company: "fixture",
        issues: [],
        warnings: [],
        entries: [
          {
            module: "web",
            path: "workspace/web",
            kind: "module-observed",
            defaultApp: "app/package.json",
            apps: [{ package: "app/package.json", kind: "runtime-declared" }],
          },
        ],
      });
      expect(
        await readFile(join(root, "workspace/web/app/package.json")),
      ).toEqual(before);
      await rm(join(root, "lazurio.organization.json"));
      expect(await readOrganizationApplications(root)).toEqual({
        kind: "canonical-documents-required",
      });
    });
  },
);

posixTest(
  "conflicted slots are quarantined, missing siblings do not hide healthy modules, and runtime failure is not readiness",
  async () => {
    await fixture(async (root, inventory) => {
      inventory.module_slots.push({
        path: "workspace/missing",
        slug: "missing",
      });
      await writeFile(
        join(root, "modules.manifest.json"),
        JSON.stringify(inventory),
      );
      const result = await readOrganizationApplications(root);
      expect(result).toMatchObject({
        kind: "applications-observed",
        entries: [{ kind: "module-observed" }, { kind: "module-unavailable" }],
      });
      await writeFile(join(root, "workspace/web/app/package.json"), "{}");
      expect(await readOrganizationApplications(root)).toMatchObject({
        entries: [
          { apps: [{ kind: "invalid-runtime" }] },
          { kind: "module-unavailable" },
        ],
      });
      inventory.module_slots.push({
        path: "workspace/web",
        slug: "conflicting",
      });
      await writeFile(
        join(root, "modules.manifest.json"),
        JSON.stringify(inventory),
      );
      expect(await readOrganizationApplications(root)).toMatchObject({
        entries: [
          { kind: "declaration-conflict" },
          { kind: "module-unavailable" },
          { kind: "declaration-conflict" },
        ],
      });
    });
  },
);

posixTest(
  "foreign module identities and linked parents are refused without following another tree",
  async () => {
    await fixture(async (root) => {
      const path = join(root, "workspace/web/lazurio.module.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...manifest, company: "other" }));
      expect(await readOrganizationApplications(root)).toMatchObject({
        entries: [{ kind: "module-unavailable" }],
      });
      await rm(join(root, "workspace"), { recursive: true });
      await symlink("/nonexistent-workspace-fixture", join(root, "workspace"));
      expect(await readOrganizationApplications(root)).toMatchObject({
        entries: [{ kind: "module-unavailable" }],
      });
    });
  },
);

posixTest(
  "compiled CLI exposes canonical local observation and refuses missing canonical state",
  async () => {
    await fixture(async (root) => {
      const executable = join(root, "fixture-cli");
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          "src/cli.ts",
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          executable,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await build.exited).toBe(0);
      const run = async () => {
        const child = Bun.spawn(
          [executable, "organization-inspect", "--directory", root],
          { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
        );
        return {
          code: await child.exited,
          value: JSON.parse(await new Response(child.stdout).text()),
        };
      };
      expect(await run()).toMatchObject({
        code: 0,
        value: { kind: "applications-observed" },
      });
      await rm(join(root, "lazurio.organization.json"));
      expect(await run()).toEqual({
        code: 2,
        value: { kind: "canonical-documents-required" },
      });
    });
  },
);
