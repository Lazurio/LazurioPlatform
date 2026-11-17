import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assessReadiness,
  readReadinessInput,
  specVersion,
} from "../src/modules/readiness";
import { runModuleReadinessCommand } from "../src/modules/readiness-cli";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

const posixTest = test.skipIf(process.platform === "win32");

type Files = Record<string, string>;

const manifest = (apps: string[]) =>
  JSON.stringify({
    schema_version: "lazurio.module.v1",
    id: "fixture",
    company: "Example",
    tcp_port_policy: { mode: apps.length === 0 ? "none" : "single" },
    port_leases:
      apps.length === 0 ? [] : [{ id: "main", host: "127.0.0.1", port: 4100 }],
    apps,
    ...(apps.length === 0 ? {} : { default_app: apps[0] }),
  });

const runtime = (extra: Record<string, unknown>, healthPath = "/health") => ({
  schema_version: "lazurio.runtime.v1",
  id: "fixture-web",
  title: "Fixture",
  company: "Example",
  module: "fixture",
  surface: "internal",
  dev_script: "dev",
  tags: [],
  listeners: [
    {
      id: "web",
      role: "entrypoint",
      lease: "main",
      protocol: "http",
      health: { kind: "http", path: healthPath },
    },
  ],
  ...extra,
});

/** A V3 server app that meets every static requirement. */
function readyServer(): Files {
  return {
    "lazurio.module.json": manifest(["app/v3/package.json"]),
    "app/v3/package.json": JSON.stringify({
      name: "fixture",
      packageManager: "bun@1.3.4",
      scripts: { dev: "bun run dev", start: "bun run server.ts" },
      dependencies: {
        "@lazurio/module-kit": "github:Lazurio/module-kit#v0.4.0",
        "@lazurio/repository-db": "github:Lazurio/repository-db#v3.3.0",
      },
      lazurio: { runtime: runtime({ start_script: "start" }) },
    }),
    "app/v3/bun.lock": "{}",
    "app/v3/server.ts":
      "const access = appAccess(request);\nconst writer = process.env.LAZURIO_RUNTIME_DATA_WRITER;\n",
    "app/v3/tests/contract.test.ts":
      'import { mcpCall } from "@lazurio/module-kit/tools/testing";\n',
    ".github/workflows/ci.yml": "on: push\n",
  };
}

async function fixture<T>(files: Files, run: (root: string) => Promise<T>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "module-ready-")));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const assess = (files: Files) =>
  fixture(files, async (root) =>
    assessReadiness(await readReadinessInput(root)),
  );

test("dependency specs name their version", () => {
  expect(specVersion("github:Lazurio/module-kit#v0.3.0")).toEqual([0, 3, 0]);
  expect(specVersion("^0.4.1")).toEqual([0, 4, 1]);
  expect(specVersion("0.2.0")).toEqual([0, 2, 0]);
  expect(specVersion("github:Lazurio/module-kit")).toBeNull();
});

posixTest("a Module without an app is V0 and has no Application", async () => {
  const result = await assess({ "lazurio.module.json": manifest([]) });
  expect(result.generation).toBe("V0");
  expect(result.verdict).toBe("no-application");
  expect(result.findings).toEqual([]);
});

posixTest(
  "a V3 server that meets the static requirements is ready for live use (no Git, so no tag finding)",
  async () => {
    const result = await assess(readyServer());
    expect(result.generation).toBe("V3");
    // Outside a Git checkout the tag cannot be read, so it is not reported.
    expect(result.findings.map((item) => item.id)).toEqual([]);
    expect(result.verdict).toBe("ready-for-live");
  },
);

posixTest(
  "a V3 server without the module kit, appAccess, the writer guard and deep health is not ready",
  async () => {
    const files = readyServer();
    files["app/v3/package.json"] = JSON.stringify({
      name: "fixture",
      packageManager: "bun@1.3.4",
      scripts: { dev: "bun run dev", start: "bun run server.ts" },
      dependencies: {
        "@lazurio/module-kit": "github:Lazurio/module-kit#v0.2.0",
        "@lazurio/repository-db": "github:Lazurio/repository-db#v3.3.0",
      },
      lazurio: { runtime: runtime({ start_script: "start" }, "/") },
    });
    files["app/v3/server.ts"] = "export {};\n";
    delete files["app/v3/tests/contract.test.ts"];
    files[".env"] = "SECRET=x\n";
    const result = await assess(files);
    expect(result.verdict).toBe("not-ready");
    expect(result.findings.map((item) => item.id).sort()).toEqual(
      [
        "app-access",
        "contract-tests",
        "env-file",
        "health-shallow",
        "module-kit",
        "writer-guard",
      ].sort(),
    );
  },
);

posixTest(
  "an app with only a development script, no Bun pin and no lockfile is not ready",
  async () => {
    const result = await assess({
      "lazurio.module.json": manifest(["app/v1/package.json"]),
      "app/v1/package.json": JSON.stringify({
        name: "fixture",
        scripts: { dev: "vite" },
        lazurio: { runtime: runtime({}) },
      }),
    });
    expect(result.generation).toBe("V1");
    expect(result.findings.map((item) => item.id).sort()).toEqual(
      ["built-version-missing", "bun-pin", "ci-missing", "lockfile"].sort(),
    );
    expect(result.verdict).toBe("not-ready");
  },
);

posixTest(
  "a static V2 app with siblings reports host conditions apart from its own verdict",
  async () => {
    const result = await assess({
      "lazurio.module.json": manifest(["app/v2/package.json"]),
      "app/v2/package.json": JSON.stringify({
        name: "fixture",
        packageManager: "bun@1.3.4",
        scripts: { dev: "astro dev", build: "astro build" },
        lazurio: {
          runtime: runtime({
            build_script: "build",
            build_output: "dist",
            required_module_slots: ["workspace/jobs/db", "workspace/stock"],
          }),
        },
      }),
      "app/v2/bun.lock": "{}",
      "data/v2/pages/index.md": "# Hello\n",
      ".github/workflows/ci.yml": "on: push\n",
    });
    expect(result.generation).toBe("V2");
    expect(result.verdict).toBe("ready-for-live");
    expect(result.hostConditions.map((item) => item.id)).toEqual([
      "static-app",
      "data-sibling",
      "api-sibling",
    ]);
  },
);

posixTest("an invalid manifest is not ready and names the reason", async () => {
  const result = await assess({ "lazurio.module.json": "{}" });
  expect(result.verdict).toBe("not-ready");
  expect(result.findings[0]?.id).toBe("manifest-invalid");
});

posixTest(
  "the command answers JSON and exits 1 only when not ready",
  async () => {
    await fixture(readyServer(), async (root) => {
      const ready = await runModuleReadinessCommand([
        "module",
        "readiness",
        root,
        "--json",
      ]);
      expect(ready.code).toBe(0);
      expect(JSON.parse(ready.text).verdict).toBe("ready-for-live");
    });
    await fixture({ "lazurio.module.json": "{}" }, async (root) => {
      const refused = await runModuleReadinessCommand([
        "module",
        "readiness",
        root,
      ]);
      expect(refused.code).toBe(1);
      expect(refused.text).toContain("not-ready");
    });
    await expect(
      runModuleReadinessCommand(["module", "readiness", "relative/path"]),
    ).rejects.toThrow("Usage");
  },
);
