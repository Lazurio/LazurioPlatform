import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogChecks } from "../src/doctor/doctor";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { runModuleCommand } from "../src/modules/module-cli";
import {
  createModuleOperations,
  type ModuleHost,
} from "../src/modules/module-operations";
import type { RuntimeSecretSource } from "../src/modules/runtime-secrets";
import { readFolderCatalog } from "../src/organizations/catalog";
import type { CliContext } from "../src/update/cli";
import {
  folderFixture,
  writeOrganization,
  writePersonalspaceModule,
} from "./fixtures/catalog-folder";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";
import { organizationWithEntry } from "./fixtures/machine-bindings";
import {
  compilePlatform,
  linuxHost,
  runnableModule,
} from "./fixtures/module-host";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// The declared runtime secrets of an application, through the module
// operations the CLI and the Launchpad share (decision F46, root decisions
// 0177 and 0196): read before every start, passed to the application's own
// unit only, never as an argument of a process, never to the preparation's
// check, never in an answer; a required one without a value refuses the
// start with `runtime-secret-unavailable`, an optional one is a note. The
// vault is a fake source here (its own reading is tests/vault-secrets.test.ts);
// the user manager is the in-memory one. Every name and value is invented.

const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "runtime-secrets-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const machineHost = "workspace.example.lazurio.io";
const value = "fake-runtime-secret-value-91c3e7";
const changed = "fake-runtime-secret-value-changed-5d02aa";

function cliContext(home: string): CliContext {
  return {
    identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
    platform: process.platform,
    env: { HOME: home },
    executable: join(home, "lazurio"),
    hostedFolder: async () => undefined,
  };
}

/** The vault of the work Environment of `example`: only its own apps read
 * it, and it holds what `values` holds now. */
function fakeVault(values: Record<string, string>) {
  const reads: { company: string; names: readonly string[] }[] = [];
  const source: RuntimeSecretSource = {
    admit: async (company) =>
      company.toLowerCase() === "example" ? null : "other-organization",
    read: async ({ company, names }) => {
      reads.push({ company, names });
      if (company.toLowerCase() !== "example")
        return { kind: "vault-secrets-refused", reason: "other-organization" };
      return {
        kind: "vault-secrets",
        secrets: new Map(
          names.map((name) => {
            const found = values[name];
            return [
              name,
              found === undefined
                ? { kind: "absent" as const, reason: "missing" as const }
                : { kind: "value" as const, value: found },
            ];
          }),
        ),
      };
    },
  };
  return { source, reads };
}

// A Folder in <parent>: a work Environment of `example` (its handover
// recorded with the entry), or a workstation.
async function fixtureFolder(parent: string, place: "hosted" | "local") {
  const folder = join(parent, "Lazurio");
  if (place === "hosted") {
    await mkdir(folder);
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    const preset = "hosted-organization-personal";
    await initializeHandoverFolder(folder, {
      preset,
      machine: organizationWithEntry(20000, machineHost),
      profile: presetProfile(preset, executionOs(process.platform)),
    });
  } else
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
  const home = join(parent, "home");
  await mkdir(home);
  return { folder, home };
}

// The module `notes` of the Organization `<slug>`, runnable, its app
// declaring `secrets` and `optional_secrets`; its declared check writes the
// environment it got to `<home>/check-<n>.json`.
async function notes(
  folder: string,
  home: string,
  slug: string,
  declared: { secrets?: string[]; optional?: string[] },
) {
  const organization = await writeOrganization(folder, slug, {
    slug,
    state: "current",
    modules: [{ id: "notes" }],
  });
  const module = join(organization, "workspace", "notes");
  const port = await runnableModule(
    module,
    home,
    `await Bun.write(${JSON.stringify(join(home, "check-"))} + crypto.randomUUID() + ".json", JSON.stringify(process.env)); process.exit(0);`,
  );
  const app = join(module, "app");
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  if (declared.secrets) pkg.lazurio.runtime.secrets = declared.secrets;
  if (declared.optional)
    pkg.lazurio.runtime.optional_secrets = declared.optional;
  await writeFile(join(app, "package.json"), JSON.stringify(pkg));
  return { module, port };
}

/** Every environment the declared check got, as text. */
async function checkEnvironments(home: string) {
  let text = "";
  for await (const name of new Bun.Glob("check-*.json").scan(home))
    text += await readFile(join(home, name), "utf8");
  return text;
}

posixTest(
  "a started app gets its secrets in its own unit only, by name on systemd-run's command line; a restart reads them again",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "hosted-")));
    const { folder, home } = await fixtureFolder(parent, "hosted");
    const { port } = await notes(folder, home, "example", {
      secrets: ["EXTERNAL_API_KEY"],
      optional: ["OPTIONAL_KEY"],
    });
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const values: Record<string, string> = { EXTERNAL_API_KEY: value };
    const vault = fakeVault(values);
    const host: ModuleHost = {
      ...linuxHost(manager, home, port, binary),
      runtimeSecrets: () => vault.source,
    };
    const operations = createModuleOperations({ folder, owner: "cli", host });
    const started = await operations.start("example/notes");
    expect(started).toMatchObject({
      kind: "module",
      outcome: "started",
      healthy: true,
      // The optional one has no item: noted, not set, the app runs.
      secretsNotProvided: [{ name: "OPTIONAL_KEY", reason: "missing" }],
    });
    expect(JSON.stringify(started)).not.toContain(value);
    expect(vault.reads).toEqual([
      { company: "example", names: ["EXTERNAL_API_KEY", "OPTIONAL_KEY"] },
    ]);
    const [unit] = [...manager.units.values()];
    const environment = Object.fromEntries(
      (unit?.environment ?? []).map((entry) => [
        entry.slice(0, entry.indexOf("=")),
        entry.slice(entry.indexOf("=") + 1),
      ]),
    );
    expect(environment.LAZURIO_RUNTIME_SECRET_EXTERNAL_API_KEY).toBe(value);
    expect(
      Object.hasOwn(environment, "LAZURIO_RUNTIME_SECRET_OPTIONAL_KEY"),
    ).toBe(false);
    expect(environment.LAZURIO_RUNTIME_LISTENERS_JSON).not.toContain(value);
    // Named on the command line; the value only in systemd-run's own
    // environment; the unit's description binds the name, not the value.
    const [run] = manager.commands("systemd-run");
    expect(run?.args).toContain(
      "--setenv=LAZURIO_RUNTIME_SECRET_EXTERNAL_API_KEY",
    );
    expect(JSON.stringify(manager.commands("systemd-run"))).not.toContain(
      value,
    );
    expect(run?.envNames).toEqual(["LAZURIO_RUNTIME_SECRET_EXTERNAL_API_KEY"]);
    expect(unit?.description).not.toContain(value);
    // The declared check (a preparation process) ran, and got none of it.
    const checked = await checkEnvironments(home);
    expect(checked).toContain("PATH");
    expect(checked).not.toContain("LAZURIO_RUNTIME_SECRET_");
    expect(checked).not.toContain(value);
    // The unit is still recognized as the one this runner created.
    expect(await operations.status("example/notes")).toMatchObject({
      outcome: "status",
      healthy: true,
    });
    // A value changed in the vault reaches the app at its next start.
    expect(await operations.stop("example/notes")).toMatchObject({
      outcome: "group-stopped",
    });
    values.EXTERNAL_API_KEY = changed;
    values.OPTIONAL_KEY = value;
    const again = await operations.start("example/notes");
    expect(again).toMatchObject({ outcome: "started", healthy: true });
    expect(again).not.toHaveProperty("secretsNotProvided");
    const [restarted] = [...manager.units.values()];
    expect(restarted?.environment).toContain(
      `LAZURIO_RUNTIME_SECRET_EXTERNAL_API_KEY=${changed}`,
    );
    expect(restarted?.environment).toContain(
      `LAZURIO_RUNTIME_SECRET_OPTIONAL_KEY=${value}`,
    );
    expect(vault.reads.length).toBe(2);
    await operations.stop("example/notes");
    await operations.close();
    await rm(parent, { recursive: true, force: true });
  },
  60_000,
);

posixTest(
  "a required secret without a value refuses the start with runtime-secret-unavailable, naming it and never a value",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "missing-")));
    const { folder, home } = await fixtureFolder(parent, "hosted");
    const { port } = await notes(folder, home, "example", {
      secrets: ["EXTERNAL_API_KEY", "SECOND_KEY"],
    });
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const vault = fakeVault({ EXTERNAL_API_KEY: value });
    const host: ModuleHost = {
      ...linuxHost(manager, home, port, binary),
      runtimeSecrets: () => vault.source,
    };
    const { result, text } = await runModuleCommand(
      ["module", "start", "example/notes", "--folder", folder],
      cliContext(home),
      host,
    );
    expect(result).toEqual({
      kind: "blocked",
      operation: "start",
      reason: "runtime-secret-unavailable",
      organization: "example",
      module: "notes",
      app: "app/package.json",
      secrets: [{ name: "SECOND_KEY", reason: "missing" }],
    });
    expect(text).toContain("runtime-secret-unavailable (SECOND_KEY: missing)");
    expect(text).not.toContain(value);
    expect(manager.commands("systemd-run")).toEqual([]);
    // Without a vault composed at all, it does not start either.
    const { result: none } = await runModuleCommand(
      ["module", "start", "example/notes", "--folder", folder, "--json"],
      cliContext(home),
      linuxHost(manager, home, port, binary),
    );
    expect(none).toMatchObject({
      reason: "runtime-secret-unavailable",
      secrets: [
        { name: "EXTERNAL_API_KEY", reason: "no-vault-identity" },
        { name: "SECOND_KEY", reason: "no-vault-identity" },
      ],
    });
    expect(manager.commands("systemd-run")).toEqual([]);
    await rm(parent, { recursive: true, force: true });
  },
  60_000,
);

posixTest(
  "an app of another Organization and every app on a workstation are refused before anything is installed; with only optional secrets they start without them",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "boundary-")));
    const { folder, home } = await fixtureFolder(parent, "hosted");
    // `gamma` is mounted here, but the Environment and its vault are
    // `example`'s.
    const { port } = await notes(folder, home, "gamma", {
      secrets: ["EXTERNAL_API_KEY"],
    });
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const vault = fakeVault({ EXTERNAL_API_KEY: value });
    const host: ModuleHost = {
      ...linuxHost(manager, home, port, binary),
      runtimeSecrets: () => vault.source,
    };
    const operations = createModuleOperations({ folder, owner: "cli", host });
    expect(await operations.start("gamma/notes")).toMatchObject({
      kind: "blocked",
      reason: "runtime-secret-unavailable",
      secrets: [{ name: "EXTERNAL_API_KEY", reason: "other-organization" }],
    });
    expect(vault.reads).toEqual([]);
    expect(await checkEnvironments(home)).toBe("");
    expect(manager.commands("systemd-run")).toEqual([]);
    // Diagnostics: the catalog and doctor know it without the vault; status
    // still operates the module.
    const catalog = await readFolderCatalog(folder);
    expect(catalog.organizations[0]?.modules[0]).toMatchObject({
      executable: false,
      reason: "runtime-secret-unavailable",
      preparationRefused: true,
      secrets: [{ name: "EXTERNAL_API_KEY", reason: "other-organization" }],
    });
    expect(
      catalogChecks(catalog).find((check) => check.id === "module"),
    ).toEqual({
      id: "module",
      outcome: "warn",
      reason: "runtime-secret-unavailable",
      context: {
        organization: "gamma",
        module: "notes",
        secrets: "EXTERNAL_API_KEY",
        secretReason: "other-organization",
      },
    });
    expect(await operations.status("gamma/notes")).toMatchObject({
      kind: "module",
      state: "stopped",
    });

    // Only optional secrets: it starts without them, and says why.
    const pkgPath = join(
      folder,
      "organizations",
      "gamma",
      "workspace",
      "notes",
      "app",
      "package.json",
    );
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    delete pkg.lazurio.runtime.secrets;
    pkg.lazurio.runtime.optional_secrets = ["EXTERNAL_API_KEY"];
    await writeFile(pkgPath, JSON.stringify(pkg));
    expect(
      catalogChecks(await readFolderCatalog(folder)).find(
        (check) => check.id === "module",
      ),
    ).toEqual({
      id: "module",
      outcome: "ok",
      reason: "runtime-secret-not-provided",
      context: {
        organization: "gamma",
        module: "notes",
        secrets: "EXTERNAL_API_KEY",
        secretReason: "other-organization",
      },
    });
    const started = await operations.start("gamma/notes");
    expect(started).toMatchObject({
      outcome: "started",
      secretsNotProvided: [
        { name: "EXTERNAL_API_KEY", reason: "other-organization" },
      ],
    });
    const [unit] = [...manager.units.values()];
    expect(JSON.stringify(unit?.environment)).not.toContain(
      "LAZURIO_RUNTIME_SECRET_",
    );
    await operations.stop("gamma/notes");
    await operations.close();

    // A workstation: no vault identity yet.
    const local = await realpath(await mkdtemp(join(root, "local-")));
    const station = await fixtureFolder(local, "local");
    await notes(station.folder, station.home, "example", {
      secrets: ["EXTERNAL_API_KEY"],
    });
    const { result } = await runModuleCommand(
      [
        "module",
        "start",
        "example/notes",
        "--folder",
        station.folder,
        "--json",
      ],
      cliContext(station.home),
      host,
    );
    expect(result).toMatchObject({
      reason: "runtime-secret-unavailable",
      secrets: [{ name: "EXTERNAL_API_KEY", reason: "workstation" }],
    });
    await rm(local, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  },
  60_000,
);

posixTest(
  "a Personalspace module's required secrets have no vault: the catalog and the start say so, and optional ones are a note",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const module = await writePersonalspaceModule(
        folder,
        "privateowner",
        "privatelogin",
        { id: "notes" },
      );
      const port = await runnableModule(module, home);
      const pkgPath = join(module, "app", "package.json");
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      pkg.lazurio.runtime.secrets = ["EXTERNAL_API_KEY"];
      await writeFile(pkgPath, JSON.stringify(pkg));
      const vault = fakeVault({ EXTERNAL_API_KEY: value });
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      await mkdir(manager.runtimeDirectory);
      const host: ModuleHost = {
        ...linuxHost(manager, home, port, binary),
        runtimeSecrets: () => vault.source,
      };
      const finding = [{ name: "EXTERNAL_API_KEY", reason: "personalspace" }];
      expect(
        (await readFolderCatalog(folder)).personalspace?.modules[0],
      ).toMatchObject({
        executable: false,
        reason: "runtime-secret-unavailable",
        secrets: finding,
      });
      const operations = createModuleOperations({ folder, owner: "cli", host });
      expect(await operations.start("personalspace/notes")).toMatchObject({
        kind: "blocked",
        reason: "runtime-secret-unavailable",
        secrets: finding,
      });
      // Only optional: it starts, without them.
      delete pkg.lazurio.runtime.secrets;
      pkg.lazurio.runtime.optional_secrets = ["EXTERNAL_API_KEY"];
      await writeFile(pkgPath, JSON.stringify(pkg));
      expect(
        (await readFolderCatalog(folder)).personalspace?.modules[0],
      ).toMatchObject({ executable: true, secretsNotProvided: finding });
      expect(await operations.start("personalspace/notes")).toMatchObject({
        outcome: "started",
        secretsNotProvided: finding,
      });
      expect(vault.reads).toEqual([]);
      await operations.stop("personalspace/notes");
      await operations.close();
    });
  },
  60_000,
);
