import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { folderStateSchemas } from "../src/folder/state";
import { artifactIdentity } from "./artifact-identity";
import { createPilotFixture } from "./tuf-fixture";

// First installed journey through the real candidate: install (bootstrap →
// TUF download → stage → activate) into an isolated per-user location, then a
// fresh shell resolves `lazurio` through PATH and drives CLI, Launchpad, a new
// Folder and a declared Bun module. The candidate is executed here; the
// distribution origin is a loopback fixture, not official delivery. Compile
// this runner with Bun for a source-free guest; supply that guest's module Bun.
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  allowPositionals: true,
  options: { "module-bun": { type: "string" } },
});
const candidate = positionals[0];
assert.ok(candidate && positionals.length === 1 && isAbsolute(candidate));
assert.ok(["darwin", "linux"].includes(process.platform));
const moduleBun = values["module-bun"];
assert.ok(moduleBun === undefined || isAbsolute(moduleBun));
const executionTarget = `${process.platform}-${process.arch}`;
const payload = await readFile(candidate);
const candidateSha256 = createHash("sha256").update(payload).digest("hex");
const home = await realpath(await mkdtemp(join(tmpdir(), "lazurio-journey-")));
const identity = Buffer.from(
  JSON.stringify({
    kind: "unsigned-development-candidate",
    identity: artifactIdentity({
      version: "0.0.0",
      target: executionTarget,
      sourceCommit: "0".repeat(40),
      toolchain: "bun@1.4.2",
      schemas: folderStateSchemas,
      lockfile: Buffer.from("fixture lock"),
      artifact: payload,
    }),
  }),
);
const fixture = createPilotFixture({
  artifact: payload,
  identity,
  executionTarget,
});
let interruptSnapshot = false;
const repositoryProxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (interruptSnapshot && path === "/metadata/snapshot.json")
      return new Response("fixture interruption", { status: 503 });
    return fetch(new URL(path, fixture.origin));
  },
});
const metadataBaseUrl = `${repositoryProxy.url}metadata/`;
const targetBaseUrl = `${repositoryProxy.url}targets/`;
const env: Record<string, string> = {
  HOME: home,
  XDG_DATA_HOME: join(home, "xdg"),
  PATH: "/usr/bin:/bin",
};
const base =
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Lazurio")
    : join(home, "xdg", "lazurio");
const entrypoint = join(base, "bin", "lazurio");
let launchpad: ReturnType<typeof Bun.spawn> | undefined;
const run = async (
  argv: string[],
  options: { env?: Record<string, string>; stdin?: unknown; cwd?: string } = {},
) => {
  const child = Bun.spawn(argv, {
    cwd: options.cwd ?? home,
    env: options.env ?? env,
    stdin:
      options.stdin === undefined
        ? "ignore"
        : new Blob([JSON.stringify(options.stdin)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output, error };
  } finally {
    clearTimeout(timeout);
  }
};
const json = async (argv: string[], options?: Parameters<typeof run>[1]) => {
  const result = await run(argv, options);
  assert.equal(result.code, 0, result.error || result.output);
  assert.equal(result.error, "");
  return JSON.parse(result.output.trim().split("\n").at(-1) as string);
};
try {
  const bootstrapRoot = join(home, "bootstrap-root.json");
  await writeFile(bootstrapRoot, fixture.rootBytes, { mode: 0o600 });
  // 1. Install: the delivered candidate is itself the installer.
  const installed = await json([
    candidate,
    "product",
    "install",
    "--bootstrap-root",
    bootstrapRoot,
    "--metadata-url",
    metadataBaseUrl,
    "--target-url",
    targetBaseUrl,
    "--loopback-fixture",
  ]);
  assert.equal(installed.kind, "product-installed");
  assert.equal(installed.base, base);
  assert.equal(installed.artifactSha256, candidateSha256);
  assert.equal(installed.entrypoint, entrypoint);
  assert.equal(installed.active.previous, null);
  assert.equal(
    await readlink(entrypoint),
    join(base, "versions", installed.staged, "lazurio"),
  );
  // A second install without the bootstrap root uses the published trust and
  // is idempotent at the same channel sequence.
  const again = await json([
    candidate,
    "product",
    "install",
    "--metadata-url",
    metadataBaseUrl,
    "--target-url",
    targetBaseUrl,
    "--loopback-fixture",
  ]);
  assert.equal(again.staged, installed.staged);
  assert.equal(again.active.name, installed.staged);
  const refused = await run([
    candidate,
    "product",
    "install",
    "--bootstrap-root",
    bootstrapRoot,
    "--metadata-url",
    metadataBaseUrl,
    "--target-url",
    targetBaseUrl,
    "--loopback-fixture",
  ]);
  assert.equal(refused.code, 1);
  assert.match(refused.error, /Product operation failed/);
  // 2. New terminal: a fresh shell with the entrypoint directory on PATH.
  const shellEnv = { ...env, PATH: `${join(base, "bin")}:/usr/bin:/bin` };
  const resolved = await run(
    ["/bin/sh", "-c", "command -v lazurio && lazurio product status"],
    { env: shellEnv },
  );
  assert.equal(resolved.code, 0, resolved.error);
  const [where, statusLine] = resolved.output.trim().split("\n");
  assert.equal(where, entrypoint);
  const status = JSON.parse(statusLine as string);
  assert.equal(status.kind, "product-status");
  assert.equal(status.active.name, installed.staged);
  assert.equal(status.published.channel.sequence, 1);
  const help = await run(["/bin/sh", "-c", "lazurio --help"], {
    env: shellEnv,
  });
  assert.equal(help.code, 0);
  assert.match(help.output, /product install/);
  // 3. CLI through the entrypoint: a new Folder, Czech then English.
  const folder = join(home, "Lazurio");
  const choices = [
    "--access",
    "local",
    "--purpose",
    "human",
    "--detail",
    "technical",
    "--coordination",
    "coordinator",
  ];
  assert.deepEqual(
    await json(
      [
        "lazurio",
        "folder-init",
        "--folder",
        folder,
        ...choices,
        "--locale",
        "cs",
      ],
      { env: shellEnv },
    ),
    { kind: "initialized", revision: 1 },
  );
  assert.match(await readFile(join(folder, "AGENTS.md"), "utf8"), /\S/);
  assert.deepEqual(
    await json(
      [
        "lazurio",
        "profile-update",
        "--folder",
        folder,
        ...choices,
        "--locale",
        "en",
        "--expected-revision",
        "1",
      ],
      { env: shellEnv },
    ),
    { kind: "updated", revision: 2 },
  );
  // Failed preparation is not a Folder migration or an activation rollback.
  // Exercise supported explicit recovery through the installed executable,
  // without deleting any metadata, changing trust, or installing another runtime.
  const witnesses = [
    join(folder, "organizations", "fixture-work.txt"),
    join(folder, "personalspace", "fixture-work.txt"),
  ];
  for (const path of witnesses)
    await writeFile(path, "preserve unfinished fixture work", { mode: 0o600 });
  const protectedFiles = [
    join(base, "active.json"),
    entrypoint,
    join(folder, "AGENTS.md"),
    ...witnesses,
  ];
  const digests = async () =>
    Promise.all(
      protectedFiles.map(async (path) =>
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ),
    );
  const protectedBefore = await digests();
  const linkBefore = await readlink(entrypoint);
  const trustSelection = join(base, "distribution", "trust", "selected.json");
  const publishedBefore = await readFile(trustSelection);
  const networkArguments = [
    "--metadata-url",
    metadataBaseUrl,
    "--target-url",
    targetBaseUrl,
    "--loopback-fixture",
  ];
  const installedOperation = (operation: string) =>
    run(["lazurio", "product", operation, ...networkArguments], {
      env: shellEnv,
    });
  fixture.publish(2);
  interruptSnapshot = true;
  const failedUpdate = await installedOperation("install");
  assert.equal(failedUpdate.code, 1);
  assert.match(failedUpdate.error, /Product operation failed/);
  assert.deepEqual(await digests(), protectedBefore);
  assert.equal(await readlink(entrypoint), linkBefore);
  assert.deepEqual(await readFile(trustSelection), publishedBefore);
  assert.equal(
    (await json([entrypoint, "product", "status"])).active.name,
    installed.staged,
  );
  assert.equal((await run([entrypoint, "--help"])).code, 0);
  // Restoring transport alone does not silently discard the pending attempt.
  interruptSnapshot = false;
  assert.equal((await installedOperation("install")).code, 1);
  assert.deepEqual(await digests(), protectedBefore);
  assert.deepEqual(await readFile(trustSelection), publishedBefore);
  const repaired = await json([
    entrypoint,
    "product",
    "recover",
    ...networkArguments,
  ]);
  assert.equal(repaired.kind, "product-recovered");
  assert.ok(repaired.attempts.length > 0);
  assert.deepEqual(await digests(), protectedBefore);
  assert.equal(await readlink(entrypoint), linkBefore);
  assert.equal(
    (await json([entrypoint, "product", "status"])).published.channel.sequence,
    2,
  );
  const retried = await json([
    entrypoint,
    "product",
    "install",
    ...networkArguments,
  ]);
  assert.equal(retried.kind, "product-installed");
  assert.equal(retried.channelSequence, 2);
  assert.equal(retried.artifactSha256, candidateSha256);
  assert.deepEqual(await digests(), protectedBefore);
  assert.equal(await readlink(entrypoint), linkBefore);
  // 4. Launchpad through the entrypoint, with a declared Bun module when a
  // module toolchain is supplied by the caller (never downloaded here).
  const organizationDirectory = join(home, "Organization");
  const moduleDirectory = join(organizationDirectory, "workspace/fixture");
  const selection = {
    company: "Example",
    module: "fixture",
    package: "app/package.json",
  };
  const reserve = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reservation"),
  });
  const port = reserve.port;
  await reserve.stop(true);
  if (moduleBun) {
    await mkdir(join(moduleDirectory, "app"), { recursive: true, mode: 0o700 });
    const write = (path: string, value: unknown) =>
      writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await write(join(organizationDirectory, "lazurio.organization.json"), {
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
    });
    await write(join(organizationDirectory, "modules.manifest.json"), {
      company: "Example",
      github_org: "Example",
      module_slots: [{ path: "workspace/fixture", slug: "fixture" }],
    });
    await write(join(moduleDirectory, "lazurio.module.json"), {
      schema_version: "lazurio.module.v1",
      id: selection.module,
      company: selection.company,
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port }],
      apps: [selection.package],
      default_app: selection.package,
    });
    const bunVersion = (await run([moduleBun, "--version"])).output.trim();
    assert.match(bunVersion, /^\d+\.\d+\.\d+$/);
    await write(join(moduleDirectory, selection.package), {
      name: "installed-journey-fixture",
      packageManager: `bun@${bunVersion}`,
      dependencies: { "fixture-dependency": "file:./dependency" },
      scripts: {
        "prepare:data": "bun run prepare-data.ts",
        "check:data": "bun run check-data.ts",
        dev: "bun run fixture-server.ts",
      },
      lazurio: {
        preparation: {
          schema_version: "lazurio.preparation.v1",
          owner_package: "app/package.json",
          prepare_script: "prepare:data",
          check_script: "check:data",
        },
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
    const owner = join(moduleDirectory, "app");
    await writeFile(
      join(owner, "fixture-server.ts"),
      'Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST ?? "127.0.0.1", port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT), fetch: () => new Response("installed journey module") });\n',
      { mode: 0o600 },
    );
    await writeFile(
      join(owner, "check-data.ts"),
      "const pkg = await Bun.file('node_modules/fixture-dependency/package.json').json(); if (pkg.name !== 'fixture-dependency' || (await Bun.file('module-data').text()) !== 'prepared') process.exit(1);\n",
      { mode: 0o600 },
    );
    await writeFile(
      join(owner, "prepare-data.ts"),
      "if (!(await Bun.file('module-data').exists())) await Bun.write('module-data', 'prepared');\n",
      { mode: 0o600 },
    );
    await mkdir(join(owner, "dependency"), { mode: 0o700 });
    await write(join(owner, "dependency/package.json"), {
      name: "fixture-dependency",
      version: "1.0.0",
    });
    const moduleEnv = {
      ...shellEnv,
      BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"),
    };
    const seed = await run(
      [moduleBun, "--no-env-file", "install", "--lockfile-only"],
      { cwd: owner, env: moduleEnv },
    );
    assert.equal(seed.code, 0, seed.error);
    const discovered = await json(
      ["lazurio", "organization-inspect", "--directory", organizationDirectory],
      { env: shellEnv },
    );
    assert.equal(discovered.entries[0].apps[0].kind, "runtime-declared");
    launchpad = Bun.spawn(
      [
        "lazurio",
        "launchpad",
        "--folder",
        folder,
        "--organization-directory",
        organizationDirectory,
        "--bun-executable",
        moduleBun,
      ],
      { cwd: home, env: moduleEnv, stdout: "pipe", stderr: "pipe" },
    );
  } else {
    launchpad = Bun.spawn(["lazurio", "launchpad", "--folder", folder], {
      cwd: home,
      env: shellEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
  }
  const reader = (launchpad.stdout as ReadableStream<Uint8Array>).getReader();
  let startup = "";
  while (!startup.includes("\n")) {
    const chunk = await reader.read();
    assert.ok(!chunk.done, "Launchpad exited before readiness");
    startup += new TextDecoder().decode(chunk.value);
    assert.ok(startup.length < 16_384);
  }
  reader.releaseLock();
  const session = new URL(JSON.parse(startup.split("\n")[0] as string).url);
  assert.equal(session.hostname, "127.0.0.1");
  const page = await fetch(session.origin, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("<html"));
  const http = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, session), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: session.origin,
        Authorization: `Bearer ${session.hash.slice(1)}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const profile = await http("/api/profile", {});
  assert.equal(profile.revision, 2);
  assert.equal(profile.profile.locale, "en");
  if (moduleBun) {
    const operation = (operation: string) =>
      json(["lazurio", "app-request"], {
        env: shellEnv,
        stdin: { sessionUrl: session.href, operation, selection },
      });
    assert.equal((await operation("prepare")).kind, "prepared");
    assert.equal((await operation("start")).kind, "started");
    let healthy = false;
    for (let attempt = 0; attempt < 200 && !healthy; attempt++) {
      healthy =
        (await http("/api/apps/status", selection)).observedHealthy === true;
      if (!healthy) await Bun.sleep(100);
    }
    assert.equal(healthy, true);
    const opened = await operation("open");
    assert.equal(opened.url, `http://127.0.0.1:${port}/`);
    const app = await fetch(opened.url, { signal: AbortSignal.timeout(5000) });
    assert.equal(await app.text(), "installed journey module");
    assert.equal((await operation("stop")).kind, "group-stopped");
    assert.equal((await operation("status")).kind, "not-managed");
  }
  launchpad.kill("SIGTERM");
  assert.equal(await launchpad.exited, 0);
  launchpad = undefined;
  assert.equal(
    createHash("sha256")
      .update(await readFile(entrypoint))
      .digest("hex"),
    candidateSha256,
  );
  console.log(
    JSON.stringify({
      pass: true,
      platform: process.platform,
      arch: process.arch,
      candidateSha256,
      staged: installed.staged,
      module: moduleBun ? "declared-bun-module" : "none",
      failedPreparation:
        "snapshot transport refusal; active bytes, entrypoint and fixture work preserved; explicit recover then retry passed",
      repairLimit:
        "still-valid metadata and unchanged fixture repository; same artifact at next channel sequence, not a new-version switch or universal recovery",
      note: "installed journey through the stable entrypoint against a loopback fixture origin; not official delivery, PATH integration or Windows",
    }),
  );
} finally {
  if (launchpad && launchpad.exitCode === null) {
    launchpad.kill("SIGKILL");
    await launchpad.exited;
  }
  await fixture.stop();
  await repositoryProxy.stop(true);
  await rm(home, { recursive: true, force: true });
}
