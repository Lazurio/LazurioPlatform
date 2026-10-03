import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  catalogSelection,
  moduleRoute,
  parseCatalog,
} from "../src/launchpad/catalog-view";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { runModuleCommand } from "../src/modules/module-cli";
import {
  createModuleOperations,
  type ModuleHost,
} from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
import { applicationUnitName } from "../src/modules/systemd-user-runner";
import { readFolderCatalog } from "../src/organizations/catalog";
import { selectCatalogOrganization } from "../src/organizations/catalog-selection";
import { runCatalogCommand } from "../src/organizations/cli";
import type { CliContext } from "../src/update/cli";
import {
  folderFixture,
  writeOrganization,
  writePersonalspaceModule,
} from "./fixtures/catalog-folder";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";
import {
  organizationWithEntry,
  personalWithEntry,
} from "./fixtures/machine-bindings";
import {
  compilePlatform,
  linuxHost,
  runnableModule,
} from "./fixtures/module-host";
import { mkdirOwnedFixture as mkdir } from "./fixtures/owned-files";

// The Personalspace's workspace modules (launchpad-parity B11): one more
// catalog group `personalspace` on the presets that have a Personalspace,
// addressed as `personalspace/<module>` by `lazurio module`, the Launchpad and
// the gateway's `ensure`, and never read on an Organization preset. The owner
// directory and the company a module declares are private: no output names
// them. Synthetic names only; nothing touches the account's home.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "personalspace-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

// Names that must never appear in any output.
const owner = "privateowner_GEN3";
const company = "privatelogin";

function cliContext(home: string): CliContext {
  return {
    identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
    platform: process.platform,
    env: { HOME: home },
    executable: join(home, "lazurio"),
    hostedFolder: async () => undefined,
  };
}

// The fixture Personalspace: `notes` runs, `diary`'s default app has no
// runtime declaration; a directory without a module declaration and a hidden
// entry in personalspace/ are neither modules nor owners.
async function personalspace(folder: string) {
  const notes = await writePersonalspaceModule(folder, owner, company, {
    id: "notes",
  });
  await writePersonalspaceModule(folder, owner, company, {
    id: "diary",
    broken: true,
  });
  await mkdir(join(folder, "personalspace", owner, "workspace", "scratch"));
  await mkdir(join(folder, "personalspace", ".git"));
  return notes;
}

const privateNames = (text: string) => {
  expect(text).not.toContain(owner);
  expect(text).not.toContain(company);
};

posixTest(
  "the catalog's Personalspace group: equal from the reader, the CLI and the Launchpad, typed reasons, private names never shown",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const before = await readFolderCatalog(folder);
      // folder-init of a workstation creates an empty personalspace/: no group.
      expect(before.personalspace).toBeUndefined();
      await personalspace(folder);
      const catalog = await readFolderCatalog(folder);
      expect(catalog.organizations).toEqual(before.organizations);
      const module = {
        organization: "personalspace",
        path: "workspace/diary",
        layout: "workspace" as const,
        teams: [],
        teamsSource: "none" as const,
        apps: [
          { package: "app/package.json", kind: "invalid-runtime" as const },
        ],
        defaultApp: "app/package.json",
        state: null,
      };
      expect(catalog.personalspace).toEqual({
        directory: "personalspace",
        organization: "personalspace",
        displayName: "Personalspace",
        state: null,
        issues: [],
        executable: true,
        teams: [],
        modules: [
          {
            ...module,
            module: "diary",
            executable: false,
            reason: "default-app-invalid",
          },
          {
            ...module,
            module: "notes",
            path: "workspace/notes",
            apps: [
              {
                package: "app/package.json",
                kind: "runtime-declared" as const,
              },
            ],
            executable: true,
          },
        ],
        repositories: [],
      });
      privateNames(JSON.stringify(catalog));

      const run = async (...args: string[]) =>
        runCatalogCommand([...args, "--folder", folder], cliContext(home));
      const organizations = await run("organization", "list", "--json");
      expect(JSON.parse(organizations.text)).toEqual(
        JSON.parse(JSON.stringify(catalog)),
      );
      // The Personalspace is not an Organization: not in that table.
      expect((await run("organization", "list")).text).not.toContain(
        "personalspace",
      );
      const modules = (await run("module", "list")).text;
      // The name column is as wide as the Folder's longest module name,
      // alpha/mission-control.
      expect(modules).toContain(
        "personalspace/diary    -           app/package.json  default-app-invalid",
      );
      expect(modules).toContain(
        "personalspace/notes    -           app/package.json  executable",
      );
      privateNames(modules);
      expect(
        JSON.parse(
          (await run("module", "list", "personalspace", "--json")).text,
        ),
      ).toEqual({
        kind: "module-list",
        organization: "personalspace",
        modules: JSON.parse(JSON.stringify(catalog.personalspace?.modules)),
      });

      // The Launchpad's catalog route answers the same.
      const app = await startLaunchpad(folder);
      try {
        const session = new URL(app.url);
        const answer = await fetch(new URL("/api/catalog", session), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: session.origin,
            Authorization: `Bearer ${session.hash.slice(1)}`,
          },
          body: "{}",
        });
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual(JSON.parse(organizations.text));
      } finally {
        await app.close();
      }

      // The page reads the group as one more Organization-shaped group and
      // routes it as /o/personalspace.
      const page = parseCatalog(JSON.parse(organizations.text));
      if (page?.personalspace === undefined) throw new Error("No group");
      const notes = page.personalspace.modules[1];
      if (notes === undefined) throw new Error("No module");
      expect(moduleRoute(page, page.personalspace, notes)).toBe(
        "/o/personalspace/notes",
      );
      expect(
        catalogSelection(page, {
          view: "module",
          organization: "personalspace",
          module: "notes",
        }),
      ).toEqual({
        kind: "module",
        organization: page.personalspace,
        module: notes,
      });
      // An Organization whose slug is `personalspace` is ambiguous with it.
      await writeOrganization(folder, "odd", {
        slug: "personalspace",
        state: "current",
        modules: [{ id: "web" }],
      });
      const twins = await readFolderCatalog(folder);
      expect(selectCatalogOrganization(twins, "personalspace").kind).toBe(
        "ambiguous",
      );
    });
  },
  30_000,
);

posixTest(
  "a second directory in personalspace/ isolates the group; none of them is read",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      await personalspace(folder);
      await writePersonalspaceModule(folder, "another_GEN3", "someone", {
        id: "notes",
      });
      const catalog = await readFolderCatalog(folder);
      expect(catalog.personalspace).toEqual({
        directory: "personalspace",
        organization: "personalspace",
        displayName: "Personalspace",
        state: null,
        issues: [],
        executable: false,
        reason: "personalspace-ambiguous",
        teams: [],
        modules: [],
        repositories: [],
      });
      const listed = await runCatalogCommand(
        ["module", "list", "personalspace", "--folder", folder],
        cliContext(home),
      );
      expect(listed.text).toBe("personalspace: personalspace-ambiguous");
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      const host = linuxHost(manager, home, 1, binary);
      expect(
        (
          await runModuleCommand(
            ["module", "start", "personalspace/notes", "--folder", folder],
            cliContext(home),
            host,
          )
        ).result,
      ).toEqual({
        kind: "blocked",
        operation: "start",
        reason: "personalspace-ambiguous",
        organization: "personalspace",
        module: "notes",
      });
      const operations = createModuleOperations({
        folder,
        owner: "cli",
        host,
      });
      // The gateway's id finds no module: an isolated group lists none.
      expect(await operations.ensure("notes", { mayStart: true })).toEqual({
        kind: "blocked",
        operation: "ensure",
        reason: "module-unknown",
        module: "notes",
      });
      expect(manager.calls).toEqual([]);
    });
  },
  30_000,
);

posixTest(
  "an Organization preset never reads personalspace/",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "organization-")));
    try {
      const folder = join(parent, "Lazurio");
      await mkdir(folder);
      await mkdir(join(folder, "organizations"), { mode: 0o755 });
      const preset = "hosted-organization-personal";
      await initializeHandoverFolder(folder, {
        preset,
        machine: organizationWithEntry(),
        profile: presetProfile(preset, executionOs(process.platform)),
      });
      // Written after the handover, which refuses a used personalspace/.
      await personalspace(folder);
      const catalog = await readFolderCatalog(folder);
      expect(Object.keys(catalog).sort()).toEqual(["kind", "organizations"]);
      const home = join(parent, "home");
      await mkdir(home);
      const manager = createFakeServiceManager({
        runtimeDirectory: join(parent, "runtime"),
      });
      const host = linuxHost(manager, home, 1, binary);
      expect(
        (
          await runModuleCommand(
            ["module", "status", "personalspace/notes", "--folder", folder],
            cliContext(home),
            host,
          )
        ).result,
      ).toMatchObject({ kind: "blocked", reason: "organization-unknown" });
      expect(
        await createModuleOperations({ folder, owner: "cli", host }).ensure(
          "notes",
          { mayStart: true },
        ),
      ).toEqual({
        kind: "blocked",
        operation: "ensure",
        reason: "module-unknown",
        module: "notes",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

// Local Launchpad requests with the fragment token, as the page sends them.
function client(app: Awaited<ReturnType<typeof startLaunchpad>>) {
  const url = new URL(app.url);
  const path = (verb: string) =>
    `${url.origin}/api/modules/personalspace/notes/${verb}`;
  const authorization = `Bearer ${url.hash.slice(1)}`;
  return {
    async status() {
      const response = await fetch(path("status"), {
        headers: { Authorization: authorization },
      });
      return { code: response.status, body: await response.json() };
    },
    async post(verb: "start" | "stop") {
      const response = await fetch(path(verb), {
        method: "POST",
        headers: {
          Origin: url.origin,
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      return { code: response.status, body: await response.json() };
    },
  };
}

posixTest(
  "Linux: start, status, logs and stop of personalspace/notes through the user manager, equal from the CLI and the Launchpad",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const notes = await personalspace(folder);
      const port = await runnableModule(notes, join(folder, ".."));
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      await mkdir(manager.runtimeDirectory);
      const host = linuxHost(manager, home, port, binary);
      const cli = async (...args: string[]) => {
        const result = await runModuleCommand(
          ["module", ...args, "--folder", folder, "--json"],
          cliContext(home),
          host,
        );
        return { code: result.code, body: JSON.parse(result.text) };
      };
      // The unit is keyed by the owner directory and the declared company,
      // as an Organization app's by its root and slug.
      const unit = applicationUnitName(join(folder, "personalspace", owner), {
        company,
        module: "notes",
        package: "app/package.json",
      });
      const app = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        undefined,
        host,
      );
      try {
        const http = client(app);
        const started = await http.post("start");
        expect(started).toMatchObject({
          code: 200,
          body: {
            kind: "module",
            operation: "start",
            organization: "personalspace",
            module: "notes",
            app: "app/package.json",
            outcome: "started",
            state: "running",
            healthy: true,
            service: { unit },
            runtime: { url: `http://127.0.0.1:${port}/` },
          },
        });
        const fromCli = await cli("status", "personalspace/notes");
        const fromHttp = await http.status();
        expect(fromCli.code).toBe(0);
        expect(fromHttp.body).toEqual(fromCli.body);
        expect(fromCli.body).toMatchObject({ state: "running", healthy: true });
        // The declared company is part of the unit's readable name, as the
        // resident's inventory named it; the human answer shows neither.
        const human = await runModuleCommand(
          ["module", "status", "personalspace/notes", "--folder", folder],
          cliContext(home),
          host,
        );
        expect(human.text).toStartWith("personalspace/notes: running, healthy");
        privateNames(human.text);
        manager.log(unit, "personal module listening");
        expect(await cli("logs", "personalspace/notes")).toMatchObject({
          code: 0,
          body: {
            kind: "module-logs",
            organization: "personalspace",
            lines: ["personal module listening"],
          },
        });
        // The broken module is refused with its catalog reason.
        expect((await cli("start", "personalspace/diary")).body).toMatchObject({
          reason: "default-app-invalid",
          organization: "personalspace",
        });
        expect(await cli("stop", "personalspace/notes")).toMatchObject({
          code: 0,
          body: { outcome: "group-stopped", state: "stopped" },
        });
        expect(manager.commands("systemd-run")).toHaveLength(1);
      } finally {
        expect(await app.close()).toEqual({ kind: "closed" });
      }
    });
  },
  60_000,
);

posixTest(
  "session (macOS): the Launchpad starts personalspace/notes as its child and it answers",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const notes = await personalspace(folder);
      const port = await runnableModule(notes, join(folder, ".."));
      const host: ModuleHost = {
        platform: "darwin",
        home,
        path: "/usr/bin:/bin",
        runtimeDirectory: undefined,
        platformExecutable: binary,
        bunExecutable: process.execPath,
        runnerKind: async () => "session",
        createRunner: () => createSessionRunner(binary),
        readJournal: async () => {
          throw new Error("A session app has no journal");
        },
      };
      const app = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        undefined,
        host,
      );
      let closed = false;
      try {
        const http = client(app);
        expect(await http.post("start")).toMatchObject({
          code: 200,
          body: {
            organization: "personalspace",
            outcome: "started",
            runner: "session",
          },
        });
        let status = (await http.status()).body;
        for (let attempt = 0; attempt < 50 && !status.healthy; attempt++) {
          await Bun.sleep(100);
          status = (await http.status()).body;
        }
        expect(status).toMatchObject({
          state: "running",
          healthy: true,
          runtime: { url: `http://127.0.0.1:${port}/` },
        });
        expect(await (await fetch(status.runtime.url)).text()).toBe(
          "synthetic module",
        );
        expect(await app.close()).toEqual({ kind: "closed" });
        closed = true;
        // The session ended with its Launchpad.
        await expect(
          fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(2000),
          }),
        ).rejects.toThrow();
      } finally {
        if (!closed) await app.close();
      }
    });
  },
  60_000,
);

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  return port;
};
const cookieName = "__Secure-lazurio-workspace";
const fetcher: AuthFetcher = async (_url, init) =>
  new Headers(init.headers).get("cookie") === `${cookieName}=valid`
    ? new Response("ok")
    : new Response("no", { status: 401 });

posixTest(
  "ensure on a personal VM: the gateway's subrequest starts personalspace/notes by its id; an Organization module of the same id is ambiguous",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "personal-vm-")));
    const folder = join(parent, "Lazurio");
    await mkdir(folder);
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-personal";
    const machine = personalWithEntry(freePort());
    const entry = machine.entry;
    if (entry === undefined) throw new Error("The fixture has an entry");
    await initializeHandoverFolder(folder, {
      preset,
      machine,
      profile: presetProfile(preset, executionOs(process.platform)),
    });
    const notes = await personalspace(folder);
    const port = await runnableModule(notes, parent);
    const home = join(parent, "home");
    await mkdir(home);
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, port, binary);
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher, ensureWaitMs: 10_000 },
      undefined,
      {},
      undefined,
      host,
    );
    // The Machines gateway's subrequest (see launchpad-ensure.test.ts).
    const ensure = async (id: string) => {
      const response = await fetch(
        `http://127.0.0.1:${entry.listenPort}/api/internal/hosted/modules/${id}/ensure?`,
        {
          headers: {
            host: "launchpad.example.lazurio.io",
            origin: entry.externalOrigin,
            "sec-fetch-site": "same-origin",
            cookie: `${cookieName}=valid`,
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        },
      );
      const text = await response.text();
      return { code: response.status, body: text === "" ? null : text };
    };
    try {
      expect(await ensure("notes")).toEqual({ code: 204, body: null });
      expect(manager.commands("systemd-run")).toHaveLength(1);
      const status = (
        await runModuleCommand(
          ["module", "status", "personalspace/notes", "--folder", folder],
          cliContext(home),
          host,
        )
      ).result;
      expect(status).toMatchObject({
        organization: "personalspace",
        state: "running",
        healthy: true,
        runtime: { url: "https://notes.example.lazurio.io/" },
      });
      const refused = await ensure("diary");
      expect(refused.code).toBe(404);
      expect(JSON.parse(refused.body as string)).toMatchObject({
        reason: "default-app-invalid",
        organization: "personalspace",
      });
      // An Organization declaring the same id: the gateway serves one
      // hostname for both, so none is guessed.
      await writeOrganization(folder, "gamma", {
        slug: "gamma",
        state: "current",
        modules: [{ id: "notes" }],
      });
      const ambiguous = await ensure("notes");
      expect(ambiguous.code).toBe(409);
      expect(JSON.parse(ambiguous.body as string)).toEqual({
        kind: "blocked",
        operation: "ensure",
        reason: "module-ambiguous",
        module: "notes",
        candidates: ["gamma", "personalspace"],
      });
      privateNames(`${refused.body}${ambiguous.body}`);
      await runModuleCommand(
        ["module", "stop", "personalspace/notes", "--folder", folder],
        cliContext(home),
        host,
      );
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);
