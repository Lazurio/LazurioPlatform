import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { messages } from "../src/launchpad/messages";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";

// Explicit local browser harness; Playwright and its Chromium are test tooling,
// supplied externally, not dependencies of the distributed Platform executable.
const { chromium } = createRequire(import.meta.url)("playwright");
const locale = process.argv[2] ?? "cs";
assert.ok(locale === "cs" || locale === "en");
const copy = messages(locale);
const root = await realpath(await mkdtemp(join(tmpdir(), "lazurio-app-ui-")));
let launchpad: { url: string; close(): Promise<{ kind: string }> } | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const binary = join(root, "platform");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      resolve("src/cli.ts"),
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      binary,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  assert.equal(await build.exited, 0);
  const folder = join(root, "Folder");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale,
    detail: "concise",
    coordination: "direct",
  });
  const organizationDirectory = join(root, "Organization");
  const directory = join(organizationDirectory, "workspace/fixture");
  await mkdir(join(directory, "app"), { recursive: true, mode: 0o700 });
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
  await writeFile(
    join(organizationDirectory, "lazurio.organization.json"),
    JSON.stringify({
      ...declaration,
      compatibility: {
        legacy_projection: {
          ...declaration.compatibility.legacy_projection,
          sha256: expectedLegacyProjection(declaration, inventory).hash,
        },
      },
    }),
  );
  await writeFile(
    join(organizationDirectory, "modules.manifest.json"),
    JSON.stringify(inventory),
  );
  const reserve = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reservation"),
  });
  const port = reserve.port;
  await reserve.stop(true);
  const selection = {
    company: "Example",
    module: "fixture",
    package: "app/package.json",
  };
  await writeFile(
    join(directory, "lazurio.module.json"),
    JSON.stringify({
      schema_version: "lazurio.module.v1",
      id: selection.module,
      company: selection.company,
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host: "127.0.0.1", port }],
      apps: [selection.package],
      default_app: selection.package,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, selection.package),
    JSON.stringify({
      name: "synthetic-browser-fixture",
      packageManager: `bun@${Bun.version}`,
      dependencies: { "fixture-dependency": "file:./dependency" },
      scripts: {
        "prepare:data": `"${process.execPath}" --no-env-file prepare-data.ts`,
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
    }),
    { mode: 0o600 },
  );
  const ownerDirectory = join(directory, "app");
  await writeFile(
    join(ownerDirectory, "fixture-server.ts"),
    `process.env.FIXTURE_PORT=${JSON.stringify(String(port))}; await import(${JSON.stringify(resolve("tests/fixtures/lifecycle-app.ts"))});`,
    { mode: 0o600 },
  );
  await writeFile(
    join(ownerDirectory, "check-data.ts"),
    `const pkg=await Bun.file('node_modules/fixture-dependency/package.json').json(); if(pkg.name!=='fixture-dependency'||pkg.version!=='1.0.0'||await Bun.file('module-data').text()!=='synthetic prepared data') process.exit(1);`,
    { mode: 0o600 },
  );
  await writeFile(
    join(ownerDirectory, "prepare-data.ts"),
    "if (!(await Bun.file('module-data').exists())) await Bun.write('module-data', 'synthetic prepared data');",
    { mode: 0o600 },
  );
  await mkdir(join(ownerDirectory, "dependency"), { mode: 0o700 });
  await writeFile(
    join(ownerDirectory, "dependency/package.json"),
    JSON.stringify({
      name: "fixture-dependency",
      version: "1.0.0",
    }),
    { mode: 0o600 },
  );
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
    FIXTURE_PORT: String(port),
  };
  const seed = Bun.spawn(
    [process.execPath, "--no-env-file", "install", "--lockfile-only"],
    {
      cwd: ownerDirectory,
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  assert.equal(await seed.exited, 0);
  const verifyPrepared = async () => {
    const pkg = await Bun.file(
      join(ownerDirectory, "node_modules/fixture-dependency/package.json"),
    ).json();
    return (
      pkg.name === "fixture-dependency" &&
      pkg.version === "1.0.0" &&
      (await Bun.file(join(ownerDirectory, "module-data")).text()) ===
        "synthetic prepared data"
    );
  };
  const owner = Bun.spawn(
    [
      binary,
      "launchpad",
      "--folder",
      folder,
      "--organization-directory",
      organizationDirectory,
      "--bun-executable",
      process.execPath,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  // Register cleanup before reading startup output, including failed startup.
  launchpad = {
    url: "",
    async close() {
      owner.kill("SIGTERM");
      return { kind: (await owner.exited) === 0 ? "closed" : "incomplete" };
    },
  };
  const reader = owner.stdout.getReader();
  let startup = "";
  while (!startup.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("CLI owner did not start");
    startup += new TextDecoder().decode(chunk.value);
    assert.ok(startup.length < 16_384);
  }
  reader.releaseLock();
  launchpad.url = JSON.parse(startup.split("\n")[0] as string).url;
  browser = await chromium.launch({
    headless: true,
    env: { PATH: "/usr/bin:/bin", HOME: root },
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(launchpad.url);
  await page.waitForFunction(
    (expected: string) => document.documentElement.lang === expected,
    locale,
  );
  await page
    .getByRole("button", { name: copy.appDiscover, exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !(document.querySelector("#app-discovered") as HTMLSelectElement)
        .disabled,
  );
  await page.locator("#app-discovered").selectOption("0");
  for (const [name, value] of Object.entries(selection))
    assert.equal(
      await page.locator(`#application input[name="${name}"]`).inputValue(),
      value,
    );
  await page
    .getByRole("button", { name: copy.appPrepare, exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector("#app-result")?.textContent?.includes('"prepared"'),
  );
  const lockBeforeClean = await Bun.file(
    join(ownerDirectory, "bun.lock"),
  ).text();
  const packageBeforeClean = await Bun.file(
    join(ownerDirectory, "package.json"),
  ).text();
  await page.getByRole("button", { name: copy.appStart, exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#app-result")?.textContent?.includes('"started"'),
  );
  await writeFile(join(ownerDirectory, "node_modules/stale-ui"), "derived");
  await page
    .getByRole("button", { name: copy.appCleanPrepare, exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector("#app-result")?.textContent?.includes('"prepared"'),
  );
  assert.equal(
    await Bun.file(join(ownerDirectory, "node_modules/stale-ui")).exists(),
    false,
  );
  assert.equal(await verifyPrepared(), true);
  assert.equal(
    await Bun.file(join(ownerDirectory, "bun.lock")).text(),
    lockBeforeClean,
  );
  assert.equal(
    await Bun.file(join(ownerDirectory, "package.json")).text(),
    packageBeforeClean,
  );
  await page.getByRole("button", { name: copy.appStart, exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#app-result")?.textContent?.includes('"started"'),
  );
  let healthy = false;
  for (let attempt = 0; attempt < 20 && !healthy; attempt++) {
    await page
      .getByRole("button", { name: copy.appStatus, exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !(document.querySelector("#app-choices") as HTMLFieldSetElement)
          .disabled,
    );
    healthy =
      JSON.parse(await page.locator("#app-result").innerText())
        .observedHealthy === true;
    if (!healthy) await Bun.sleep(50);
  }
  assert.equal(healthy, true);
  await page.getByRole("button", { name: copy.appOpen, exact: true }).click();
  await page.locator("#app-link").waitFor({ state: "visible" });
  const opened = page.waitForEvent("popup");
  await page.locator("#app-link").click();
  const application = await opened;
  await application.waitForLoadState();
  assert.equal(
    await application.locator("body").innerText(),
    "synthetic module",
  );
  await application.close();
  await page.getByRole("button", { name: copy.appStop, exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#app-result")
      ?.textContent?.includes('"group-stopped"'),
  );
  assert.equal(await page.locator("#app-link").isVisible(), false);
  const sessionUrl = launchpad.url;
  const cli = async (operation: string) => {
    const child = Bun.spawn([binary, "app-request"], {
      cwd: root,
      env: {},
      stdin: new Blob([JSON.stringify({ sessionUrl, operation, selection })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0);
    assert.equal(error, "");
    assert.equal(output.includes(new URL(sessionUrl).hash.slice(1)), false);
    return JSON.parse(output) as Record<string, unknown>;
  };
  assert.equal((await cli("prepare")).kind, "prepared");
  assert.equal((await cli("start")).kind, "started");
  await writeFile(join(ownerDirectory, "node_modules/stale-cli"), "derived");
  assert.equal((await cli("clean-prepare")).kind, "prepared");
  assert.equal((await cli("status")).kind, "not-managed");
  assert.equal(
    await Bun.file(join(ownerDirectory, "node_modules/stale-cli")).exists(),
    false,
  );
  assert.equal(await verifyPrepared(), true);
  assert.equal(
    await Bun.file(join(ownerDirectory, "bun.lock")).text(),
    lockBeforeClean,
  );
  assert.equal(
    await Bun.file(join(ownerDirectory, "package.json")).text(),
    packageBeforeClean,
  );
  assert.equal((await cli("start")).kind, "started");
  healthy = false;
  for (let attempt = 0; attempt < 20 && !healthy; attempt++) {
    healthy = (await cli("status")).observedHealthy === true;
    if (!healthy) await Bun.sleep(50);
  }
  assert.equal(healthy, true);
  const cliLink = await cli("open");
  assert.equal(cliLink.kind, "local-entrypoint");
  assert.equal(cliLink.url, `http://127.0.0.1:${port}/`);
  const cliPage = await browser.newPage();
  await cliPage.goto(String(cliLink.url));
  assert.equal(await cliPage.locator("body").innerText(), "synthetic module");
  await cliPage.close();
  assert.equal((await cli("stop")).kind, "group-stopped");
  await page.getByRole("button", { name: copy.appStatus, exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#app-result")
      ?.textContent?.includes('"not-managed"'),
  );
  await page.locator('#application input[name="module"]').fill("other");
  assert.equal(await page.locator("#app-status").innerText(), "");
  assert.equal(await page.locator("#app-result").innerText(), "");
  assert.deepEqual(errors, []);
  console.log(
    `PASS: canonical discovery/selection in Chromium and compiled CLI frozen install/clean reinstall/module preparation/start/status/link/open synthetic page/stop through one Launchpad owner (${locale}); not real candidate or VM qualification`,
  );
} finally {
  if (browser) await browser.close();
  if (launchpad) assert.equal((await launchpad.close()).kind, "closed");
  await rm(root, { recursive: true, force: true });
}
