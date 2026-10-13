import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubRepository, ViewerAnswer } from "../src/content/github";
import { createPersonalspaceHolder } from "../src/content/holder";
import { personalspaceHolder } from "../src/content/status";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { bootElementId, parseBoot } from "../src/launchpad/boot";
import {
  catalogSelection,
  moduleRoute,
  parseCatalog,
} from "../src/launchpad/catalog-view";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { ensureStatus, startLaunchpad } from "../src/launchpad/server";
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
import {
  type PersonalspaceBlockedReason,
  type PersonalspaceHolderRead,
  resolvePersonalspaceApplication,
} from "../src/organizations/personalspace";
import type { CliContext } from "../src/update/cli";
import {
  folderFixture,
  writeOrganization,
  writePersonalspaceModule,
} from "./fixtures/catalog-folder";
import {
  checkoutWithOrigin,
  contentHost,
  createWorld,
  stubGitHub,
  type World,
} from "./fixtures/content-world";
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
// the gateway's `ensure`, and never read on an Organization preset. Only the
// Personalspace this Environment's GitHub account holds is read (#186): any
// other is listed blocked with its reason, and none of it runs. The owner
// directory and the company a module declares are private: no output names
// them. Synthetic names only; nothing touches the account's home.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
let world: World | undefined;
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "personalspace-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
  world = await createWorld();
});
afterAll(async () => {
  await world?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

// Names that must never appear in any output.
const owner = "privateowner_GEN3";
const company = "privatelogin";
// The GitHub account whose Personalspace the fixture is.
const login = "privateowner";
const loginId = 4242;

function cliContext(home: string): CliContext {
  return {
    identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
    platform: process.platform,
    env: { HOME: home },
    executable: join(home, "lazurio"),
    hostedFolder: async () => undefined,
  };
}

// The fixture Personalspace: a checkout of the account's own
// `privateowner/privateowner_GEN3`; `notes` runs, `diary`'s default app has
// no runtime declaration; a directory without a module declaration and a
// hidden entry in personalspace/ are neither modules nor owners.
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
  await checkoutWithOrigin(
    join(folder, "personalspace", owner),
    `${login}/${owner}`,
  );
  return notes;
}

/** This Environment's gh and git as the holder decision reads them: gh
 * signed in as `viewer` (the fixture's own account by default), and GitHub
 * knowing the fixture's repository as that account's own, private one. */
function github(
  options: {
    viewer?: ViewerAnswer;
    id?: number;
    repository?: Partial<GitHubRepository> | "unavailable" | "missing";
  } = {},
) {
  const id = options.id ?? loginId;
  const { github: stub, calls } = stubGitHub(world as World, {
    viewer: options.viewer ?? {
      kind: "signed-in",
      viewer: { login, databaseId: id },
    },
    repositories:
      options.repository === "missing"
        ? {}
        : {
            [`${login}/${owner}`]:
              options.repository === "unavailable"
                ? "unavailable"
                : {
                    owner: { login, databaseId: id, kind: "User" },
                    ...options.repository,
                  },
          },
  });
  const host = contentHost(world as World, stub);
  const holder: PersonalspaceHolderRead = (folder) =>
    personalspaceHolder(folder, host);
  return { host, holder, calls };
}

/** gh as the Launchpad asks it around a sign-out (#382 review): GitHub knows
 * the fixture's repository as the account's own, private one; each viewer
 * read answers with the sign-in at the moment it is asked, and the answer
 * to a held read arrives only when it is released, as a response in
 * flight. */
function signingOut() {
  const { github: stub } = stubGitHub(world as World, {
    repositories: {
      [`${login}/${owner}`]: {
        owner: { login, databaseId: loginId, kind: "User" },
      },
    },
  });
  let signedIn = true;
  let reads = 0;
  const held = new Map<number, Promise<void>>();
  const host = contentHost(world as World, {
    ...stub,
    async viewer() {
      const read = ++reads;
      const answer: ViewerAnswer = signedIn
        ? { kind: "signed-in", viewer: { login, databaseId: loginId } }
        : { kind: "signed-out" };
      await held.get(read);
      return answer;
    },
  });
  return {
    host,
    reads: () => reads,
    signIn() {
      signedIn = true;
    },
    signOut() {
      signedIn = false;
    },
    /** Holds the answer to the `read`-th viewer read until released. */
    hold(read: number) {
      let release = () => {};
      held.set(
        read,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => release();
    },
  };
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
      const { host, holder } = github();
      const before = await readFolderCatalog(folder, holder);
      // folder-init of a workstation creates an empty personalspace/: no group.
      expect(before.personalspace).toBeUndefined();
      await personalspace(folder);
      const catalog = await readFolderCatalog(folder, holder);
      expect(catalog.organizations).toEqual(before.organizations);
      const module = {
        organization: "personalspace",
        path: "workspace/diary",
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
            display: { id: "notes", title: "notes", tags: [] },
            executable: true,
          },
        ],
        repositories: [],
      });
      privateNames(JSON.stringify(catalog));

      const run = async (...args: string[]) =>
        runCatalogCommand(
          [...args, "--folder", folder],
          cliContext(home),
          (folder) => readFolderCatalog(folder, holder),
        );
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

      // The Launchpad's catalog route answers the same, from its own
      // decision through this Environment's gh.
      const app = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        host,
      );
      try {
        // The page's catalog never waits for GitHub: once the Launchpad's
        // first decision is made, it answers with it.
        await (await fetchContent(app)).json();
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
  "a Personalspace this Environment's GitHub account does not hold is listed blocked with its reason; none of it is read, listed or started",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      await personalspace(folder);
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      const host = linuxHost(manager, home, 1, binary);
      const cases: {
        gh: ReturnType<typeof github>;
        reason: PersonalspaceBlockedReason;
      }[] = [
        // gh works as another account: this is not its Personalspace.
        {
          gh: github({
            viewer: {
              kind: "signed-in",
              viewer: { login: "stranger", databaseId: 777 },
            },
          }),
          reason: "personalspace-foreign",
        },
        // GitHub does not know it as the account's own, or it is public.
        {
          gh: github({ repository: "missing" }),
          reason: "personalspace-not-owned",
        },
        {
          gh: github({ repository: { private: false } }),
          reason: "personalspace-public",
        },
        // Without a sign-in or GitHub's answer it is never runnable.
        {
          gh: github({ viewer: { kind: "signed-out" } }),
          reason: "github-signed-out",
        },
        {
          gh: github({ viewer: { kind: "unavailable" } }),
          reason: "github-unavailable",
        },
        {
          gh: github({ repository: "unavailable" }),
          reason: "github-unavailable",
        },
      ];
      for (const { gh, reason } of cases) {
        const catalog = await readFolderCatalog(folder, gh.holder);
        expect([reason, catalog.personalspace]).toEqual([
          reason,
          {
            directory: "personalspace",
            organization: "personalspace",
            displayName: "Personalspace",
            state: null,
            issues: [],
            executable: false,
            reason,
            teams: [],
            modules: [],
            repositories: [],
          },
        ]);
        const listed = await runCatalogCommand(
          ["module", "list", "personalspace", "--folder", folder],
          cliContext(home),
          (folder) => readFolderCatalog(folder, gh.holder),
        );
        expect(listed.text).toBe(`personalspace: ${reason}`);
        for (const verb of ["start", "status", "stop"] as const) {
          const refused = await runModuleCommand(
            [
              "module",
              verb,
              "personalspace/notes",
              "--folder",
              folder,
              "--json",
            ],
            cliContext(home),
            host,
            gh.holder,
          );
          expect([verb, refused.code, refused.result]).toEqual([
            verb,
            2,
            {
              kind: "blocked",
              operation: verb,
              reason,
              organization: "personalspace",
              module: "notes",
            },
          ]);
          privateNames(refused.text);
        }
        // The gateway's id finds no module: a blocked group lists none.
        expect(
          await createModuleOperations({
            folder,
            owner: "cli",
            host,
            personalspace: gh.holder,
          }).ensure("notes", { mayStart: true }),
        ).toEqual({
          kind: "blocked",
          operation: "ensure",
          reason: "module-unknown",
          module: "notes",
        });
        privateNames(`${JSON.stringify(catalog)}${listed.text}`);
      }
      expect(manager.calls).toEqual([]);
      // Left as it was.
      expect(
        (
          await readdir(join(folder, "personalspace", owner, "workspace"))
        ).sort(),
      ).toEqual(["diary", "notes", "scratch"]);
      // A reader given no decision takes no owner directory for the
      // Operator's.
      expect((await readFolderCatalog(folder)).personalspace).toMatchObject({
        executable: false,
        reason: "personalspace-unverified",
        modules: [],
      });
      expect(
        await createModuleOperations({ folder, owner: "cli", host }).start(
          "personalspace/notes",
        ),
      ).toEqual({
        kind: "blocked",
        operation: "start",
        reason: "personalspace-unverified",
        organization: "personalspace",
        module: "notes",
      });
    });
  },
  60_000,
);

posixTest(
  "an operation that overlaps a gh sign-out through the Launchpad never acts on the decision GitHub was asked for before it",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      await personalspace(folder);
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      await mkdir(manager.runtimeDirectory);
      const gh = signingOut();
      // The Launchpad's memory of the decision, with every read asking
      // GitHub, as after the minute.
      const holder = createPersonalspaceHolder(() => gh.host, { ttlMs: 0 });
      const operations = createModuleOperations({
        folder,
        owner: "cli",
        host: linuxHost(manager, home, 1, binary),
        personalspace: holder.decide,
      });
      expect(await operations.status("personalspace/notes")).toMatchObject({
        kind: "module",
        organization: "personalspace",
        module: "notes",
        state: "stopped",
      });
      // The selection reads the catalog (one question), then decides again
      // for its target (the next). GitHub's answer to that one, asked while
      // gh was signed in, arrives after the Launchpad signed gh out and
      // forgot, as `server.ts` does on a sign-out.
      const target = gh.reads() + 2;
      const release = gh.hold(target);
      const status = operations.status("personalspace/notes");
      while (gh.reads() < target) await Bun.sleep(5);
      gh.signOut();
      holder.forget();
      release();
      expect(await status).toEqual({
        kind: "blocked",
        operation: "status",
        reason: "github-signed-out",
        organization: "personalspace",
        module: "notes",
      });
      // The lifecycle's authorization at an operation boundary, the same.
      gh.signIn();
      const space = join(folder, "personalspace", owner);
      const selection = {
        company,
        module: "notes",
        package: "app/package.json",
      };
      expect(
        await resolvePersonalspaceApplication(space, selection, holder.decide),
      ).toEqual({ moduleDirectory: join(space, "workspace", "notes") });
      const authorizing = gh.hold(gh.reads() + 1);
      const asked = gh.reads();
      const authorized = resolvePersonalspaceApplication(
        space,
        selection,
        holder.decide,
      );
      while (gh.reads() === asked) await Bun.sleep(5);
      gh.signOut();
      holder.forget();
      authorizing();
      await expect(authorized).rejects.toThrow(
        "Selected Personalspace unavailable",
      );
    });
  },
  30_000,
);

posixTest(
  "the gateway's ensure resolves an Organization's module without the decision whose Personalspace this is; an id the Personalspace's directory also has stays ambiguous; the Personalspace alone waits at most the request's deadline",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      await personalspace(folder);
      // The Personalspace's directory also has `web`, as alpha does.
      await writePersonalspaceModule(folder, owner, company, { id: "web" });
      // A decision that never comes, as GitHub that does not answer.
      const asked: string[] = [];
      const never: PersonalspaceHolderRead = (folder) => {
        asked.push(folder);
        return new Promise(() => {});
      };
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      await mkdir(manager.runtimeDirectory);
      const operations = createModuleOperations({
        folder,
        owner: "cli",
        host: linuxHost(manager, home, 1, binary),
        personalspace: never,
      });
      const within = <T>(work: Promise<T>) =>
        Promise.race([work, Bun.sleep(5_000).then(() => "waited" as const)]);
      // An Organization's module: nothing is asked about the Personalspace.
      expect(
        await within(
          operations.ensure("api", { mayStart: false, waitMs: 100 }),
        ),
      ).toMatchObject({
        kind: "module",
        operation: "ensure",
        organization: "beta",
        module: "api",
        state: "stopped",
      });
      // An id an Organization and the Personalspace's directory both have:
      // the gateway routes it to one of their ports, whoever holds the
      // Personalspace, so none is guessed.
      expect(
        await within(operations.ensure("web", { mayStart: true, waitMs: 100 })),
      ).toEqual({
        kind: "blocked",
        operation: "ensure",
        reason: "module-ambiguous",
        module: "web",
        candidates: ["alpha_GEN3", "personalspace"],
      });
      expect(
        await operations.ensure("nothing", { mayStart: true, waitMs: 100 }),
      ).toEqual({
        kind: "blocked",
        operation: "ensure",
        reason: "module-unknown",
        module: "nothing",
      });
      expect(asked).toEqual([]);
      // The Personalspace alone may own `notes`: its holder is asked, at
      // most for the request's deadline, and the gateway's starting page
      // asks again (503).
      const began = performance.now();
      const pending = await within(
        operations.ensure("notes", { mayStart: true, waitMs: 100 }),
      );
      expect(performance.now() - began).toBeLessThan(2_000);
      expect(pending).toEqual({
        kind: "blocked",
        operation: "ensure",
        reason: "personalspace-unverified",
        module: "notes",
      });
      expect(asked).toHaveLength(1);
      if (pending !== "waited") expect(ensureStatus(pending)).toBe(503);
      expect(manager.commands("systemd-run")).toEqual([]);
    });
  },
  30_000,
);

posixTest(
  "an Organization's module and lists that do not show the Personalspace never wait for the decision whose it is",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      await personalspace(folder);
      // A decision that never comes, as GitHub that does not answer.
      const asked: string[] = [];
      const never: PersonalspaceHolderRead = (folder) => {
        asked.push(folder);
        return new Promise(() => {});
      };
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      await mkdir(manager.runtimeDirectory);
      const operations = createModuleOperations({
        folder,
        owner: "cli",
        host: linuxHost(manager, home, 1, binary),
        personalspace: never,
      });
      expect(
        await Promise.race([
          operations.status("alpha/web"),
          Bun.sleep(5_000).then(() => "waited"),
        ]),
      ).toMatchObject({
        kind: "module",
        organization: "alpha",
        module: "web",
        state: "stopped",
      });
      expect(asked).toEqual([]);
      // The CLI asks only for an output that shows the group's modules.
      const decided: [string, boolean][] = [];
      for (const args of [
        ["organization", "list"],
        ["organization", "list", "--json"],
        ["module", "list"],
        ["module", "list", "alpha"],
        ["module", "list", "personalspace"],
        ["module", "list", "PersonalSpace", "--json"],
      ])
        await runCatalogCommand(
          [...args, "--folder", folder],
          cliContext(home),
          async (folder, personalspace) => {
            decided.push([args.join(" "), personalspace]);
            return readFolderCatalog(folder);
          },
        );
      expect(decided).toEqual([
        ["organization list", false],
        ["organization list --json", true],
        ["module list", true],
        ["module list alpha", false],
        ["module list personalspace", true],
        ["module list PersonalSpace --json", true],
      ]);
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

/** `GET /api/content` of a local Launchpad, as the page reads it once idle:
 * it waits for the Launchpad's decision whose Personalspace this is. */
function fetchContent(app: Awaited<ReturnType<typeof startLaunchpad>>) {
  const url = new URL(app.url);
  return fetch(new URL("/api/content", url), {
    headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
  });
}

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
      const gh = github();
      const cli = async (...args: string[]) => {
        const result = await runModuleCommand(
          ["module", ...args, "--folder", folder, "--json"],
          cliContext(home),
          host,
          gh.holder,
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
        undefined,
        gh.host,
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
          gh.holder,
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
        undefined,
        github().host,
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
    // gh is signed in as the handover's Owner (GitHub id 12345), under the
    // login whose Personalspace this is.
    const gh = github({ id: 12345 });
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
      undefined,
      gh.host,
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
          gh.holder,
        )
      ).result;
      expect(status).toMatchObject({
        organization: "personalspace",
        state: "running",
        healthy: true,
        runtime: { url: "https://notes.example.lazurio.io/" },
      });
      // The page's first paint carries the group as last decided (#186).
      const page = await fetch(`http://127.0.0.1:${entry.listenPort}/`, {
        headers: {
          host: "launchpad.example.lazurio.io",
          cookie: `${cookieName}=valid`,
        },
      });
      const boot = parseBoot(
        new RegExp(
          `<script type="application/json" id="${bootElementId}">([\\s\\S]*?)</script>`,
        ).exec(await page.text())?.[1],
      );
      expect(boot?.catalog?.personalspace).toMatchObject({
        executable: true,
        modules: [{ module: "diary" }, { module: "notes" }],
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
        gh.holder,
      );
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);
