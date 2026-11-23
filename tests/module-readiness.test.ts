import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assessReadiness,
  environmentDependencies,
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

const serverPackage = (
  dependencies: Record<string, string>,
  healthPath = "/health",
) =>
  JSON.stringify({
    name: "fixture",
    packageManager: "bun@1.3.4",
    scripts: { dev: "bun run dev", start: "bun run server.ts" },
    dependencies,
    lazurio: { runtime: runtime({ start_script: "start" }, healthPath) },
  });

/** A V3 server app that meets every static requirement. */
function readyServer(): Files {
  return {
    "lazurio.module.json": manifest(["app/v3/package.json"]),
    "app/v3/package.json": serverPackage({
      "@lazurio/module-kit": "github:Lazurio/module-kit#v0.4.0",
      "@lazurio/repository-db": "github:Lazurio/repository-db#v3.3.0",
    }),
    "app/v3/bun.lock": "{}",
    "app/v3/server.ts":
      "const access = appAccess(request);\nconst writer = process.env.LAZURIO_RUNTIME_DATA_WRITER;\n",
    "app/v3/tests/contract.test.ts":
      'import { mcpCall } from "@lazurio/module-kit/tools/testing";\n',
    ".github/workflows/ci.yml": "on: push\n",
  };
}

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: root,
    },
  });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
}

/** A Module checkout: `files` committed, `untracked` only on disk. With
 * `repository: false` it is a plain directory without Git. */
async function fixture<T>(
  files: Files,
  run: (root: string) => Promise<T>,
  options: {
    untracked?: Files;
    repository?: boolean;
    after?: (root: string) => Promise<void>;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "module-ready-")));
  const write = async (all: Files) => {
    for (const [path, content] of Object.entries(all)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  };
  try {
    await write(files);
    if (options.repository !== false) {
      git(root, "init", "-q");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "fixture");
    }
    await write(options.untracked ?? {});
    await options.after?.(root);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const assess = (
  files: Files,
  options?: {
    untracked?: Files;
    repository?: boolean;
    after?: (root: string) => Promise<void>;
  },
  app?: string,
) =>
  fixture(
    files,
    async (root) => assessReadiness(await readReadinessInput(root, app)),
    options,
  );

const ids = (result: { findings: readonly { id: string }[] }) =>
  result.findings.map((item) => item.id).sort();

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
  "a V3 server that meets the static requirements is ready for live use, without a release tag",
  async () => {
    const result = await assess(readyServer());
    expect(result.generation).toBe("V3");
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe("ready-for-live");
  },
);

posixTest(
  "a V3 server without the module kit, appAccess, the writer guard and deep health is not ready",
  async () => {
    const files = readyServer();
    files["app/v3/package.json"] = serverPackage(
      {
        "@lazurio/module-kit": "github:Lazurio/module-kit#v0.2.0",
        "@lazurio/repository-db": "github:Lazurio/repository-db#v3.3.0",
      },
      "/",
    );
    files["app/v3/server.ts"] = "export {};\n";
    delete files["app/v3/tests/contract.test.ts"];
    const result = await assess(files);
    expect(result.verdict).toBe("not-ready");
    expect(ids(result)).toEqual(
      [
        "app-access",
        "contract-tests",
        "health-shallow",
        "module-kit",
        "writer-guard",
      ].sort(),
    );
  },
);

posixTest(
  "an app in app/v3 is V3 by its directory even without a direct repository-db dependency",
  async () => {
    const files = readyServer();
    files["app/v3/package.json"] = serverPackage({
      "@lazurio/module-kit": "github:Lazurio/module-kit#v0.4.0",
      "@example/data-wrapper": "1.0.0",
    });
    files["app/v3/server.ts"] = "const access = appAccess(request);\n";
    const result = await assess(files);
    expect(result.generation).toBe("V3");
    expect(ids(result)).toEqual(["writer-guard"]);
  },
);

posixTest(
  "committed environment files anywhere are found, an ignored local one is not, and an untracked lockfile does not count",
  async () => {
    const files = readyServer();
    delete files["app/v3/bun.lock"];
    files[".env.staging"] = "A=1\n";
    files["tools/.env"] = "B=2\n";
    files[".env.example"] = "A=\n";
    files[".gitignore"] = "/.env\n";
    const result = await assess(files, {
      untracked: { ".env": "LOCAL=1\n", "app/v3/bun.lock": "{}" },
    });
    expect(ids(result)).toEqual(["env-file", "lockfile"]);
    const env = result.findings.find((item) => item.id === "env-file");
    expect(env?.message).toContain(".env.staging");
    expect(env?.message).toContain("tools/.env");
    expect(env?.message).not.toContain(".env.example");
    expect(env?.message).not.toContain(", .env)");
  },
);

posixTest(
  "without Git the committed evidence is unknown, and an unchecked dependency on a person's Environment keeps the app from a trial too",
  async () => {
    const result = await assess(readyServer(), { repository: false });
    expect(ids(result)).toEqual(["git-unavailable", "source-incomplete"]);
    const unknown = result.findings.find(
      (item) => item.id === "source-incomplete",
    );
    expect(unknown?.level).toBe("blocker");
    expect(unknown?.message).toContain("a person's Environment");
    expect(result.verdict).toBe("not-ready");
  },
);

posixTest(
  "an app outside the Module named by --app is refused and nothing of it is read",
  async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "outside-")));
    try {
      await mkdir(join(outer, "app"), { recursive: true });
      await writeFile(
        join(outer, "app/package.json"),
        serverPackage({ "@lazurio/module-kit": "0.4.0" }),
      );
      await writeFile(join(outer, "app/secret.ts"), "appAccess(\n");
      await fixture(readyServer(), async (root) => {
        const input = await readReadinessInput(
          root,
          `../${outer.split("/").pop()}/app/package.json`,
        );
        expect(input.app?.declarationError).toBe("app-not-declared");
        expect(input.app?.pkg).toBeNull();
        expect(input.app?.source).toBe("");
        const result = assessReadiness(input);
        expect(result.verdict).toBe("not-ready");
        expect(ids(result)).toEqual(["declaration-invalid"]);
      });
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  },
);

posixTest(
  "an app with only a development script and no Bun pin is not ready",
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
    expect(ids(result)).toEqual(
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

posixTest(
  "source markers come from the committed tree, never through a symlinked directory",
  async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "outside-src-")));
    try {
      await writeFile(join(outer, "access.ts"), "appAccess(request);\n");
      const files = readyServer();
      files["app/v3/server.ts"] =
        "const writer = process.env.LAZURIO_RUNTIME_DATA_WRITER;\n";
      files["app/v3/sub/access.ts"] = "export {};\n";
      const result = await assess(files, {
        after: async (root) => {
          await rename(join(root, "app/v3/sub"), join(root, "app/v3/sub-old"));
          await symlink(outer, join(root, "app/v3/sub"));
        },
      });
      expect(ids(result)).toEqual(["app-access"]);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  },
);

posixTest(
  "committed evidence is HEAD's: a staged deletion hides no .env file, .envrc counts, a staged lockfile does not",
  async () => {
    const files = readyServer();
    files[".env.staging"] = "A=1\n";
    files[".envrc"] = "export B=2\n";
    delete files["app/v3/bun.lock"];
    const result = await assess(files, {
      untracked: { "app/v3/bun.lock": "{}" },
      after: async (root) => {
        git(root, "rm", "-q", "--cached", ".env.staging");
        git(root, "add", "app/v3/bun.lock");
      },
    });
    expect(ids(result)).toEqual(["env-file", "lockfile"]);
    const env = result.findings.find((item) => item.id === "env-file");
    expect(env?.message).toContain(".env.staging");
    expect(env?.message).toContain(".envrc");
  },
);

posixTest("an uncommitted CI workflow does not count", async () => {
  const files = readyServer();
  delete files[".github/workflows/ci.yml"];
  const result = await assess(files, {
    untracked: { ".github/workflows/ci.yml": "on: push\n" },
  });
  expect(ids(result)).toEqual(["ci-missing"]);
  expect(result.verdict).toBe("ready-for-trial");
});

posixTest(
  "a V3 app with only a static build has no server for its data",
  async () => {
    const result = await assess({
      "lazurio.module.json": manifest(["app/v3/package.json"]),
      "app/v3/package.json": JSON.stringify({
        name: "fixture",
        packageManager: "bun@1.3.4",
        scripts: { dev: "vite", build: "vite build" },
        dependencies: {
          "@lazurio/repository-db": "github:Lazurio/repository-db#v3.3.0",
        },
        lazurio: {
          runtime: runtime({ build_script: "build", build_output: "dist" }),
        },
      }),
      "app/v3/bun.lock": "{}",
      "app/v3/src/main.ts": "const writer = 'LAZURIO_RUNTIME_DATA_WRITER';\n",
      ".github/workflows/ci.yml": "on: push\n",
    });
    expect(result.generation).toBe("V3");
    expect(ids(result)).toEqual(["data-without-server"]);
    expect(result.verdict).toBe("not-ready");
  },
);

posixTest(
  "a committed source file over the read limit makes its markers unknown, never absent",
  async () => {
    const files = readyServer();
    files["app/v3/server.ts"] =
      `const access = appAccess(request);\nconst writer = process.env.LAZURIO_RUNTIME_DATA_WRITER;\n// ${"x".repeat(1024 * 1024 + 10)}\n`;
    const result = await assess(files);
    expect(ids(result)).toEqual(["source-incomplete"]);
    expect(result.findings[0]?.message).toContain("app/v3/server.ts");
    expect(result.verdict).toBe("not-ready");
  },
);

posixTest(
  "a marker found in the read source counts even when another file was skipped",
  async () => {
    const files = readyServer();
    files["app/v3/fixtures/generated.ts"] =
      `// ${"x".repeat(1024 * 1024 + 10)}\n`;
    const result = await assess(files);
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe("ready-for-live");
  },
);

posixTest(
  "an unknown live-only marker is live evidence, not a blocker, and the message names only it",
  async () => {
    const files = readyServer();
    files["app/v3/tests/contract.test.ts"] =
      `import { mcpCall } from "@lazurio/module-kit/tools/testing";\n// ${"x".repeat(1024 * 1024 + 10)}\n`;
    const result = await assess(files);
    expect(ids(result)).toEqual(["source-incomplete"]);
    expect(result.findings[0]?.level).toBe("live");
    expect(result.findings[0]?.message).toContain("contract tests");
    expect(result.findings[0]?.message).not.toContain("appAccess");
    expect(result.verdict).toBe("ready-for-trial");
  },
);

posixTest(
  "code that runs and was not read makes a dependency on a person's Environment unknown, never absent",
  async () => {
    const files = readyServer();
    files["app/v3/generated.ts"] = `// ${"x".repeat(1024 * 1024 + 10)}\n`;
    const result = await assess(files);
    expect(ids(result)).toEqual(["source-incomplete"]);
    expect(result.findings[0]?.level).toBe("blocker");
    expect(result.findings[0]?.message).toContain(
      "a dependency on a person's Environment",
    );
    expect(result.findings[0]?.message).toContain("app/v3/generated.ts");
    expect(result.verdict).toBe("not-ready");
  },
);

test("every kind of a person's Environment is found in code that runs", () => {
  expect(environmentDependencies('spawnSync("gh", ["api", path])')).toEqual([
    "GitHub sign-in",
  ]);
  expect(
    environmentDependencies("await $`composio execute OUTLOOK_SEND_EMAIL`"),
  ).toEqual(["Integrations"]);
  expect(
    environmentDependencies('join(os.homedir(), "OneDrive", "Revize")'),
  ).toEqual(["files"]);
  expect(
    environmentDependencies(
      'fetch("https://launchpad.station.example.lazurio.io/x")',
    ),
  ).toEqual(["network"]);
  expect(
    environmentDependencies(
      "const writer = process.env.LAZURIO_RUNTIME_DATA_WRITER;",
    ),
  ).toEqual([]);
  // An Organization's own service address is no Environment's address.
  expect(
    environmentDependencies(
      'const vault = "https://vault.example.lazurio.io";',
    ),
  ).toEqual([]);
});

posixTest(
  "an app that relies on a person's Environment is not ready, and a test that does is no evidence",
  async () => {
    const files = readyServer();
    const inTestOnly = await assess({
      ...files,
      "app/v3/tests/github.test.ts": 'spawnSync("gh", ["auth", "status"]);\n',
    });
    expect(inTestOnly.verdict).toBe("ready-for-live");
    const relies = await assess({
      ...files,
      "app/v3/server.ts": `${files["app/v3/server.ts"]}spawnSync("gh", ["auth", "git-credential"]);\nconst root = join(os.homedir(), "inbox");\n`,
    });
    expect(relies.verdict).toBe("not-ready");
    const finding = relies.findings.find(
      (item) => item.id === "environment-dependency",
    );
    expect(finding?.level).toBe("blocker");
    expect(finding?.message).toContain("GitHub sign-in, files");
  },
);

posixTest(
  "code that runs imports a file under scripts/ or migrations/: it runs too and its dependency counts",
  async () => {
    const files = readyServer();
    const result = await assess({
      ...files,
      "app/v3/server.ts": `import { whoami } from "./scripts/client";\n${files["app/v3/server.ts"]}`,
      "app/v3/scripts/client.ts":
        'import { token } from "../migrations/auth.js";\nexport const whoami = () => spawnSync("gh", ["api", "user"]);\n',
      "app/v3/migrations/auth.ts":
        "export const token = () => join(os.homedir(), '.config');\n",
      // Not imported by code that runs: still no evidence.
      "app/v3/scripts/release.ts": 'spawnSync("gh", ["release", "create"]);\n',
    });
    const finding = result.findings.find(
      (item) => item.id === "environment-dependency",
    );
    expect(finding?.message).toContain("GitHub sign-in, files");
    expect(result.verdict).toBe("not-ready");
    const alone = await assess({
      ...files,
      "app/v3/scripts/release.ts": 'spawnSync("gh", ["release", "create"]);\n',
    });
    expect(alone.verdict).toBe("ready-for-live");
  },
);

posixTest(
  "a Module that is only a tool of the Environment is no Application, whatever its code relies on",
  async () => {
    const files = readyServer();
    const declared = JSON.parse(files["lazurio.module.json"] as string);
    const result = await assess({
      ...files,
      "lazurio.module.json": JSON.stringify({
        ...declared,
        application: false,
      }),
      "app/v3/server.ts": 'spawnSync("gh", ["api", "user"]);\n',
    });
    expect(result.verdict).toBe("no-application");
    expect(result.generation).toBe("V3");
    expect(result.findings).toEqual([]);
  },
);
