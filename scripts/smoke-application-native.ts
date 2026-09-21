import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { createSessionRunner } from "../src/modules/session-runner";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import { readOrganizationApplications } from "../src/organizations/read-applications";

// Compile this runner and the actual CLI for the guest. No source, Node, Bun,
// credentials or browser installation is needed in the guest. This tests native
// discovery/HTTP/lifecycle, NOT package installation, browser UI or a real module.
if (process.argv[2] === "--fixture-app") {
  const port = Number(process.env.FIXTURE_PORT);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("native synthetic application"),
  });
} else {
  const binary = process.argv[2];
  const locale = process.argv[3] ?? "en";
  assert.ok(binary && isAbsolute(binary));
  assert.ok(locale === "cs" || locale === "en");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-native-application-")),
  );
  let server: Awaited<ReturnType<typeof startLaunchpad>> | undefined;
  const digest = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      locale,
      cliSha256: await digest(binary),
      runnerSha256: await digest(process.execPath),
    }),
  );
  try {
    const folder = join(root, "Folder");
    const organizationDirectory = join(root, "Organization");
    const moduleDirectory = join(organizationDirectory, "workspace/fixture");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale,
      detail: "concise",
      coordination: "direct",
    });
    await mkdir(join(moduleDirectory, "app"), { recursive: true, mode: 0o700 });
    const json = (path: string, value: unknown) =>
      writeFile(path, JSON.stringify(value), { mode: 0o600 });
    const inventory = {
      company: "Example",
      github_org: "Example",
      module_slots: [{ path: "workspace/fixture", slug: "fixture" }],
    };
    const declaration = {
      schema_version: "lazurio.organization.v1",
      kind: "organization",
      organization: {
        slug: "Example",
        display_name: "Example",
        metadata: {},
        forge_binding: {
          forge: "github",
          locator: "Example",
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
    // The declared digest must equal the deterministic projection of these same
    // declarations; a placeholder digest is a `conflict`, not a usable root.
    await json(join(organizationDirectory, "lazurio.organization.json"), {
      ...declaration,
      compatibility: {
        legacy_projection: {
          ...declaration.compatibility.legacy_projection,
          sha256: expectedLegacyProjection(declaration, inventory).hash,
        },
      },
    });
    await json(join(organizationDirectory, "modules.manifest.json"), inventory);
    // Only parity-valid `transition` is executable (decision 0145 finalization
    // gate), so the runnable root carries the exact generated projection too.
    await json(
      join(organizationDirectory, "company.gen3.json"),
      expectedLegacyProjection(declaration, inventory).projection,
    );
    const reserve = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reserve.port;
    await reserve.stop(true);
    const selection = {
      company: "Example",
      module: "fixture",
      package: "app/package.json",
    };
    await json(join(moduleDirectory, "lazurio.module.json"), {
      schema_version: "lazurio.module.v1",
      id: selection.module,
      company: selection.company,
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port }],
      apps: [selection.package],
      default_app: selection.package,
    });
    await json(join(moduleDirectory, selection.package), {
      name: "native-fixture",
      scripts: { dev: "embedded-fixture --fixture-app" },
      lazurio: {
        runtime: {
          schema_version: "lazurio.runtime.v1",
          id: "fixture-app",
          title: "Fixture",
          company: selection.company,
          module: selection.module,
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
    });
    const cli = async (args: string[], stdin?: unknown) => {
      const child = Bun.spawn([binary, ...args], {
        cwd: root,
        env: { HOME: root, PATH: "/usr/bin:/bin" },
        stdin:
          stdin === undefined ? "ignore" : new Blob([JSON.stringify(stdin)]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.equal(code, 0);
        assert.equal(error, "");
        return JSON.parse(output);
      } finally {
        clearTimeout(timeout);
      }
    };
    const discovered = await cli([
      "organization-inspect",
      "--directory",
      organizationDirectory,
    ]);
    assert.equal(discovered.entries[0].apps[0].kind, "runtime-declared");
    server = await startLaunchpad(
      folder,
      {
        runner: createSessionRunner(binary),
        authorize: async (value) => {
          // This authority is limited to this newly created synthetic test fixture.
          assert.deepEqual(value, selection);
          assert.deepEqual(
            await readOrganizationApplications(organizationDirectory),
            discovered,
          );
          return { moduleDirectory };
        },
        prepareLaunch: async (plan, cwd) => {
          assert.equal(plan.runtime.dev_script, "dev");
          return {
            executable: process.execPath,
            args: ["--fixture-app"],
            cwd,
            env: {
              HOME: root,
              PATH: "/usr/bin:/bin",
              FIXTURE_PORT: String(port),
            },
          };
        },
      },
      { organizationDirectory },
    );
    const session = new URL(server.url);
    const http = async (path: string, body: unknown) => {
      const response = await fetch(new URL(path, session), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: session.origin,
          Authorization: `Bearer ${session.hash.slice(1)}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await http("/api/apps/discover", {}), discovered);
    const operation = (operation: string) =>
      cli(["app-request"], { sessionUrl: server?.url, operation, selection });
    assert.equal((await operation("start")).kind, "started");
    let healthy = false;
    for (let attempt = 0; attempt < 40 && !healthy; attempt++) {
      healthy =
        (await http("/api/apps/status", selection)).observedHealthy === true;
      if (!healthy) await Bun.sleep(50);
    }
    assert.equal(healthy, true);
    const entrypoint = await operation("open");
    assert.equal(entrypoint.url, `http://127.0.0.1:${port}/`);
    const page = await fetch(entrypoint.url, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(await page.text(), "native synthetic application");
    assert.equal(
      (await http("/api/apps/stop", selection)).kind,
      "group-stopped",
    );
    assert.equal((await operation("status")).kind, "not-managed");
    assert.equal((await http("/api/apps/start", selection)).kind, "started");
    assert.equal((await operation("stop")).kind, "group-stopped");
    console.log(
      "PASS: native canonical discovery and shared CLI/HTTP start/status/entrypoint/function/stop; no installer, browser, DB or real candidate qualification",
    );
  } finally {
    if (server) assert.equal((await server.close()).kind, "closed");
    await rm(root, { recursive: true, force: true });
  }
}
