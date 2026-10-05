import { afterEach, expect, test } from "bun:test";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { installContent, planContentInstall } from "../src/content/install";
import { tryContentLock } from "../src/content/lock";
import {
  isDestinationName,
  materializationMarker,
} from "../src/content/materialize";
import type { ContentStep } from "../src/content/model";
import {
  classifySlotAccess,
  verifyOrganizationRole,
} from "../src/content/role";
import { contentStatus } from "../src/content/status";
import { readFolderCatalog } from "../src/organizations/catalog";
import { renameNoReplace } from "../src/platform/rename";
import { type Slot, writeModule } from "./fixtures/catalog-folder";
import {
  alphaRemotes,
  alphaSlots,
  contentHost,
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
  writeOrganizationRoot,
} from "./fixtures/content-world";
import { bindings } from "./fixtures/machine-bindings";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// Content installation (decision F9, addendum of 2026-10-04): the root first
// into a temporary sibling, verified and published with a no-replace rename;
// the children from the root's own declaration; the preparation of what it
// cloned; the doctor's check. Real git over local bare repositories, a stub
// GitHub, synthetic names only.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const alphaReadable = {
  "Alpha/alpha_GEN3": {},
  "Alpha/web": {},
  "Alpha/mission-control": {},
  "Alpha/firmware": {},
  "Alpha/infra": {},
  "Alpha/secret": {},
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const summary = (steps: ContentStep[]) =>
  steps
    .filter((step) => step.state !== "running")
    .map(
      (step) => `${step.key}:${step.state}${step.code ? `:${step.code}` : ""}`,
    );

posixTest(
  "renameNoReplace never replaces, not even an empty directory",
  async () => {
    world = await createWorld();
    const from = join(world.root, "from");
    const to = join(world.root, "to");
    await mkdir(from);
    await mkdir(to);
    expect(renameNoReplace(from, to)).toBe("exists");
    expect(await exists(from)).toBe(true);
    const absent = join(world.root, "absent");
    expect(renameNoReplace(from, absent)).toBe("renamed");
    expect(await exists(from)).toBe(false);
    expect(isDestinationName(".hidden")).toBe(false);
    expect(isDestinationName("alpha_GEN3")).toBe(true);
  },
);

posixTest(
  "an Organization installs root first, then the declared children it can read",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, { repositories: alphaReadable });
    const host = contentHost(world, github);
    const steps: ContentStep[] = [];
    const result = await installContent(
      folder,
      {
        items: [{ kind: "organization", login: "Alpha" }],
        roots: { alpha: "Alpha/alpha_GEN3" },
      },
      (step) => steps.push(step),
      host,
    );
    expect(result.kind).toBe("content-install");
    if (result.kind !== "content-install") return;
    expect(result.state).toBe("succeeded");
    // Every step reports running, then its end; in the fixed order.
    expect(steps.map((step) => `${step.key}:${step.state}`)).toEqual([
      "access:running",
      "access:done",
      "root:running",
      "root:done",
      "modules:running",
      "modules:done",
      "preparation:running",
      "preparation:done",
      "check:running",
      "check:done",
    ]);
    const root = join(folder, "organizations", "alpha_GEN3");
    expect(await exists(join(root, "lazurio.organization.json"))).toBe(true);
    const outcome = result.items[0];
    expect(outcome?.directory).toBe("organizations/alpha_GEN3");
    expect(outcome?.repository).toBe("Alpha/alpha_GEN3");
    expect(
      Object.fromEntries(
        (outcome?.repositories ?? []).map((entry) => [
          entry.path,
          entry.result,
        ]),
      ),
    ).toEqual({
      infra: "excluded",
      "mission-control": "materialized",
      "mission-control/db": "excluded",
      "productionspace/firmware": "materialized",
      "workspace/docs": "denied",
      "workspace/odd": "blocked",
      "workspace/planned": "no-repository",
      // A verified Admin (the stub's default membership) installs the
      // restricted slot too.
      "workspace/secret": "materialized",
      "workspace/secret/db": "excluded",
      "workspace/web": "materialized",
    });
    expect(outcome?.role).toBe("admin");
    for (const path of [
      "workspace/web",
      "mission-control",
      "productionspace/firmware",
      "workspace/secret",
    ])
      expect(await exists(join(root, path, ".git"))).toBe(true);
    for (const path of [
      "workspace/docs",
      "workspace/odd",
      "infra",
      "mission-control/db",
      "workspace/secret/db",
    ])
      expect(await exists(join(root, path))).toBe(false);
    // Only the modules this run cloned are prepared; never productionspace.
    expect(host.prepared.sort()).toEqual([
      "alpha/mission-control",
      "alpha/web",
    ]);
    // No temporary sibling is left anywhere.
    for (const directory of [
      join(folder, "organizations"),
      root,
      join(root, "workspace"),
      join(root, "productionspace"),
    ])
      expect(
        (await readdir(directory)).filter((name) =>
          name.includes(".lazurio-content-"),
        ),
      ).toEqual([]);
    // The catalog now holds the Organization.
    const catalog = await readFolderCatalog(folder);
    expect(catalog.organizations.map((entry) => entry.forgeLogin)).toEqual([
      "Alpha",
    ]);
    // And the status of this workstation lists it as present.
    expect((await contentStatus(folder, host)).items).toEqual([
      {
        kind: "organization",
        login: "Alpha",
        name: "Alpha Company",
        state: "present",
      },
      {
        kind: "personalspace",
        login: "example",
        state: "absent",
        onGitHub: "missing",
      },
    ]);
    // A second install of a present Organization takes the root as it is,
    // clones nothing more and prepares nothing.
    const again: ContentStep[] = [];
    const second = await installContent(
      folder,
      { items: [{ kind: "organization", login: "alpha" }] },
      (step) => again.push(step),
      host,
    );
    expect(second.kind === "content-install" && second.state).toBe("succeeded");
    expect(summary(again)).toEqual([
      "access:done",
      "root:done",
      "modules:done",
      "preparation:skipped",
      "check:done",
    ]);
    expect(
      again.find((step) => step.key === "root" && step.state === "done")
        ?.detail,
    ).toBe("present at organizations/alpha_GEN3");
  },
  60_000,
);

// ---- The person's live role ----------------------------------------------

test("the role GitHub confirms, and the scope it gives", () => {
  const owner = { kind: "member", state: "active", role: "admin" } as const;
  const member = { kind: "member", state: "active", role: "member" } as const;
  const none = { kind: "none" } as const;
  const verify = (
    requested: "admin" | "steward" | "builder" | null,
    membership: Parameters<typeof verifyOrganizationRole>[0]["membership"],
    rootPermission: "admin" | "maintain" | "write" | "triage" | "read" | null,
  ) => {
    const answer = verifyOrganizationRole({
      requested,
      membership,
      rootPermission,
    });
    return answer.kind === "verified"
      ? `${answer.role}:${answer.restricted}`
      : "unverified";
  };
  expect(verify(null, owner, "admin")).toBe("admin:include");
  expect(verify(null, member, "admin")).toBe("steward:exclude");
  expect(verify(null, member, "maintain")).toBe("steward:exclude");
  expect(verify(null, member, "write")).toBe("builder:exclude");
  expect(verify(null, member, "triage")).toBe("unverified");
  expect(verify(null, none, null)).toBe("unverified");
  expect(verify("admin", owner, null)).toBe("admin:include");
  expect(verify("admin", member, "admin")).toBe("unverified");
  expect(
    verify("admin", { kind: "member", state: "pending", role: "admin" }, null),
  ).toBe("unverified");
  expect(verify("steward", none, "maintain")).toBe("steward:exclude");
  expect(verify("steward", owner, "write")).toBe("unverified");
  expect(verify("builder", owner, "admin")).toBe("builder:exclude");
  expect(verify("builder", none, "read")).toBe("unverified");
  expect(classifySlotAccess({ default_access: "private" })).toBe("restricted");
  expect(classifySlotAccess({ default_access: "role_based" })).toBe("ordinary");
  expect(classifySlotAccess({})).toBe("ordinary");
  expect(classifySlotAccess({ default_access: "everyone" })).toBe("unknown");
  expect(classifySlotAccess({ required_roles: "builder" })).toBe("unknown");
});

async function installAlpha(
  github: ReturnType<typeof stubGitHub>["github"],
  folder: string,
  roles?: Record<string, "admin" | "steward" | "builder">,
) {
  const steps: ContentStep[] = [];
  const result = await installContent(
    folder,
    {
      items: [{ kind: "organization", login: "Alpha" }],
      roots: { alpha: "Alpha/alpha_GEN3" },
      ...(roles === undefined ? {} : { roles }),
    },
    (step) => steps.push(step),
    contentHost(world as World, github),
  );
  return { steps, result };
}

const results = (
  result: Awaited<ReturnType<typeof installContent>>,
): Record<string, string> =>
  result.kind === "content-install"
    ? Object.fromEntries(
        (result.items[0]?.repositories ?? []).map((entry) => [
          entry.path,
          entry.result,
        ]),
      )
    : {};

posixTest(
  "a Builder or Steward never gets the restricted slots, and GitHub is not asked for them",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    for (const [role, permission, roles] of [
      // Resolved live: not an Owner, write on the root.
      ["builder", "write", undefined],
      // Asserted: maintain on the root.
      ["steward", "maintain", { alpha: "steward" } as const],
      // An Admin may choose the narrower Builder scope.
      ["builder", "admin", { alpha: "builder" } as const],
    ] as const) {
      const folder = await presetFolder(world, "local");
      const { github, calls } = stubGitHub(world, {
        repositories: {
          ...alphaReadable,
          "Alpha/alpha_GEN3": { permission },
        },
        membership:
          permission === "admin"
            ? { kind: "member", state: "active", role: "admin" }
            : { kind: "member", state: "active", role: "member" },
      });
      const { steps, result } = await installAlpha(github, folder, roles);
      expect(result.kind === "content-install" && result.state).toBe(
        "succeeded",
      );
      expect(result.kind === "content-install" && result.items[0]?.role).toBe(
        role,
      );
      expect(
        steps.find((step) => step.key === "access" && step.state === "done")
          ?.detail,
      ).toBe(
        `as example (${role}, restricted slots excluded); root Alpha/alpha_GEN3 (named)`,
      );
      const scoped = results(result);
      expect(scoped["workspace/secret"]).toBe("excluded_by_role_scope");
      expect(scoped["workspace/secret/db"]).toBe("excluded_by_role_scope");
      expect(scoped["workspace/web"]).toBe("materialized");
      expect(
        await exists(
          join(folder, "organizations", "alpha_GEN3", "workspace", "secret"),
        ),
      ).toBe(false);
      // No provider operation for anything in the restricted scope.
      expect(
        calls.some(
          (call) =>
            call.kind === "repository" &&
            call.args.join("/").toLowerCase().startsWith("alpha/secret"),
        ),
      ).toBe(false);
      // An asserted Steward or Builder is confirmed by the repository
      // permission alone; the membership is not asked.
      expect(calls.some((call) => call.kind === "membership")).toBe(
        roles === undefined,
      );
    }
  },
  90_000,
);

posixTest(
  "a role GitHub does not confirm fails closed before anything is cloned",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    for (const [membership, permission, roles] of [
      // The Admin form (the CLI without --role), but only a member.
      [
        { kind: "member", state: "active", role: "member" },
        "admin",
        { alpha: "admin" },
      ],
      // A pending Owner invitation is not an Owner.
      [
        { kind: "member", state: "pending", role: "admin" },
        "read",
        { alpha: "admin" },
      ],
      // Asserted Steward with write only.
      [{ kind: "none" }, "write", { alpha: "steward" }],
      // Asserted Builder with read only.
      [{ kind: "none" }, "read", { alpha: "builder" }],
      // Resolved live (the Launchpad): neither an Owner nor write.
      [{ kind: "member", state: "active", role: "member" }, "read", undefined],
      // Resolved live while GitHub does not answer the membership.
      [{ kind: "unavailable" }, "read", undefined],
    ] as const) {
      const folder = await presetFolder(world, "local");
      const { github, calls } = stubGitHub(world, {
        repositories: { ...alphaReadable, "Alpha/alpha_GEN3": { permission } },
        membership,
      });
      const { steps, result } = await installAlpha(
        github,
        folder,
        roles === undefined ? undefined : { ...roles },
      );
      expect(summary(steps)).toEqual(["access:failed:role-unverified"]);
      expect(result.kind === "content-install" && result.failure?.code).toBe(
        "role-unverified",
      );
      expect(await readdir(join(folder, "organizations"))).toEqual([]);
      // Only the root was asked about; no child.
      expect(
        calls
          .filter((call) => call.kind === "repository")
          .map((call) => call.args.join("/")),
      ).toEqual(["Alpha/alpha_GEN3"]);
    }
  },
  60_000,
);

// ---- Where the root is: a name is only a candidate --------------------------

/** A root `Alpha/<name>` that declares itself (or `declares` another
 * repository, or none), with the one module `web`. */
async function alphaRoot(
  name: string,
  declares: string | null = `Alpha/${name}`,
) {
  await remoteRepository(world as World, `Alpha/${name}`, (directory) =>
    writeOrganizationRoot(directory, {
      slug: "alpha",
      forge: "Alpha",
      slots: [alphaSlots[0] as Slot],
      ...(declares === null ? {} : { root: declares }),
    }),
  );
}

async function resolveAlpha(
  github: ReturnType<typeof stubGitHub>["github"],
  folder: string,
  root?: string,
) {
  const steps: ContentStep[] = [];
  const result = await installContent(
    folder,
    {
      items: [{ kind: "organization", login: "Alpha" }],
      ...(root === undefined ? {} : { roots: { alpha: root } }),
    },
    (step) => steps.push(step),
    contentHost(world as World, github),
  );
  return { steps, result };
}

const accessDetail = (steps: ContentStep[]) =>
  steps.find((step) => step.key === "access" && step.state !== "running");

posixTest(
  "the conventional name is accepted when the repository declares itself the root",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const { github, calls } = stubGitHub(world, {
      repositories: alphaReadable,
    });
    const { steps, result } = await resolveAlpha(github, folder);
    expect(result.kind === "content-install" && result.state).toBe("succeeded");
    expect(accessDetail(steps)?.detail).toBe(
      "as example (admin); root Alpha/alpha_GEN3 (by name)",
    );
    // Its declaration was read before anything was cloned; no scan.
    // (GitHub compares names case-insensitively; the login is as named.)
    expect(calls.find((call) => call.kind === "declaration")?.args).toEqual([
      "Alpha",
      "Alpha_GEN3",
    ]);
    expect(calls.some((call) => call.kind === "organizationRepositories")).toBe(
      false,
    );
    expect(await readdir(join(folder, "organizations"))).toEqual([
      "alpha_GEN3",
    ]);
  },
  30_000,
);

posixTest(
  "a name that does not declare itself the root is passed over for the one that does",
  async () => {
    world = await createWorld();
    // alpha_GEN3 exists but declares no root; home declares itself.
    await alphaRoot("alpha_GEN3", null);
    await alphaRoot("home");
    await remoteRepository(world, "Alpha/web", (directory) =>
      writeModule(directory, "alpha", { id: "web" }),
    );
    const folder = await presetFolder(world, "local");
    const { github, calls } = stubGitHub(world, {
      repositories: {
        "Alpha/alpha_GEN3": {},
        "Alpha/home": {},
        "Alpha/web": {},
      },
    });
    const { steps, result } = await resolveAlpha(github, folder);
    expect(result.kind === "content-install" && result.state).toBe("succeeded");
    expect(accessDetail(steps)?.detail).toBe(
      "as example (admin); root Alpha/home (by scan)",
    );
    expect(calls.some((call) => call.kind === "organizationRepositories")).toBe(
      true,
    );
    expect(await readdir(join(folder, "organizations"))).toEqual(["home"]);
    expect(
      await exists(join(folder, "organizations", "home", "workspace", "web")),
    ).toBe(true);
  },
  30_000,
);

posixTest(
  "a root whose cloned commit does not declare itself the root is never published",
  async () => {
    world = await createWorld();
    // GitHub's default branch answered with a declaring document; the commit
    // the clone gets declares no root.
    await alphaRoot("alpha_GEN3", null);
    await alphaRoot("declaring", "Alpha/alpha_GEN3");
    await remoteRepository(world, "Alpha/web", (directory) =>
      writeModule(directory, "alpha", { id: "web" }),
    );
    const folder = await presetFolder(world, "local");
    const stub = stubGitHub(world, {
      repositories: {
        "Alpha/alpha_GEN3": {},
        "Alpha/declaring": {},
        "Alpha/web": {},
      },
    }).github;
    const github: typeof stub = {
      ...stub,
      declaration: (owner: string, name: string) =>
        `${owner}/${name}`.toLowerCase() === "alpha/alpha_gen3"
          ? stub.declaration("Alpha", "declaring")
          : stub.declaration(owner, name),
    };
    const { steps, result } = await resolveAlpha(github, folder);
    expect(summary(steps)).toEqual([
      "access:done",
      "root:failed:root-declaration-mismatch",
    ]);
    expect(result.kind === "content-install" && result.state).toBe("failed");
    expect(await exists(join(folder, "organizations", "alpha_GEN3"))).toBe(
      false,
    );
  },
  30_000,
);

posixTest(
  "a scan accepts exactly one repository that declares itself the root",
  async () => {
    world = await createWorld();
    for (const [roots, code] of [
      // None declares itself (one names another repository, one nothing).
      [
        [
          ["elsewhere", "Alpha/someone-else"],
          ["plain", null],
        ],
        "root-not-found",
      ],
      // Two declare themselves.
      [
        [
          ["first", "Alpha/first"],
          ["second", "Alpha/second"],
        ],
        "root-ambiguous",
      ],
    ] as const) {
      const repositories: Record<string, object> = {};
      for (const [name, declares] of roots) {
        await alphaRoot(name, declares);
        repositories[`Alpha/${name}`] = {};
      }
      const folder = await presetFolder(world, "local");
      const { github } = stubGitHub(world, { repositories });
      const { steps, result } = await resolveAlpha(github, folder);
      expect(summary(steps)).toEqual([`access:failed:${code}`]);
      if (code === "root-ambiguous")
        expect(
          result.kind === "content-install" && result.failure?.detail,
        ).toContain("Alpha/first, Alpha/second");
      expect(await readdir(join(folder, "organizations"))).toEqual([]);
    }
    // A listing GitHub does not answer is not "none".
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, { listing: "unavailable" });
    const { steps } = await resolveAlpha(github, folder);
    expect(summary(steps)).toEqual(["access:failed:github-unavailable"]);
  },
  30_000,
);

posixTest(
  "an explicit --root is verified the same way, and rejected when it does not declare itself",
  async () => {
    world = await createWorld();
    await alphaRoot("home");
    await alphaRoot("other", "Alpha/home");
    await remoteRepository(world, "Alpha/web", (directory) =>
      writeModule(directory, "alpha", { id: "web" }),
    );
    const repositories = {
      "Alpha/home": {},
      "Alpha/other": {},
      "Alpha/web": {},
    };
    const accepted = await resolveAlpha(
      stubGitHub(world, { repositories }).github,
      await presetFolder(world, "local"),
      "Alpha/home",
    );
    expect(accessDetail(accepted.steps)?.detail).toBe(
      "as example (admin); root Alpha/home (named)",
    );
    // `other` declares `home` its root, not itself: refused, and no other
    // source is tried.
    const stub = stubGitHub(world, { repositories });
    const folder = await presetFolder(world, "local");
    const rejected = await resolveAlpha(stub.github, folder, "Alpha/other");
    expect(summary(rejected.steps)).toEqual([
      "access:failed:root-declaration-mismatch",
    ]);
    expect(
      stub.calls.some((call) => call.kind === "organizationRepositories"),
    ).toBe(false);
    expect(await readdir(join(folder, "organizations"))).toEqual([]);
    // A root of another owner is refused before GitHub is asked.
    const foreign = stubGitHub(world, { repositories });
    const wrongOwner = await resolveAlpha(
      foreign.github,
      await presetFolder(world, "local"),
      "Beta/home",
    );
    expect(summary(wrongOwner.steps)).toEqual([
      "access:failed:root-owner-mismatch",
    ]);
    expect(foreign.calls.some((call) => call.kind === "declaration")).toBe(
      false,
    );
  },
  30_000,
);

posixTest(
  "an occupied destination is left untouched and nothing is cloned over it",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const occupied = join(folder, "organizations", "alpha_GEN3");
    await mkdir(occupied);
    await writeFile(join(occupied, "work.txt"), "the operator's own work");
    const { github } = stubGitHub(world, { repositories: alphaReadable });
    const steps: ContentStep[] = [];
    const result = await installContent(
      folder,
      {
        items: [{ kind: "organization", login: "Alpha" }],
        roots: { alpha: "Alpha/alpha_GEN3" },
      },
      (step) => steps.push(step),
      contentHost(world, github),
    );
    expect(summary(steps)).toEqual([
      "access:done",
      "root:failed:destination-occupied",
    ]);
    expect(result.kind === "content-install" && result.state).toBe("failed");
    expect(await readdir(occupied)).toEqual(["work.txt"]);
    expect(await readFile(join(occupied, "work.txt"), "utf8")).toBe(
      "the operator's own work",
    );
    expect(await readdir(join(folder, "organizations"))).toEqual([
      "alpha_GEN3",
    ]);
  },
  30_000,
);

posixTest(
  "a root whose own declaration names another Organization is never cloned",
  async () => {
    world = await createWorld();
    // A valid declaration, but of another Organization and its own root.
    await alphaRemotes(world, { forge: "Beta", root: "Beta/beta_GEN3" });
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, { repositories: alphaReadable });
    const steps: ContentStep[] = [];
    await installContent(
      folder,
      {
        items: [{ kind: "organization", login: "Alpha" }],
        roots: { alpha: "Alpha/alpha_GEN3" },
      },
      (step) => steps.push(step),
      contentHost(world, github),
    );
    expect(summary(steps)).toEqual(["access:failed:root-declaration-mismatch"]);
    expect(await readdir(join(folder, "organizations"))).toEqual([]);
  },
  30_000,
);

posixTest(
  "an interrupted temporary sibling is removed only by the same operation",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const organizations = join(folder, "organizations");
    // A crashed run's own sibling (with its marker), and a lookalike that is
    // not ours (no marker).
    const own = join(
      organizations,
      ".alpha_GEN3.lazurio-content-0123456789abcdef",
    );
    const foreign = join(
      organizations,
      ".alpha_GEN3.lazurio-content-fedcba9876543210",
    );
    await mkdir(join(own, "checkout"), { recursive: true });
    await writeFile(join(own, "checkout", "partial"), "half a clone");
    await writeFile(
      join(own, materializationMarker),
      "lazurio-content-materialization-v1\n",
    );
    await mkdir(foreign);
    await writeFile(join(foreign, "keep"), "not ours");
    const { github } = stubGitHub(world, { repositories: alphaReadable });
    const host = contentHost(world, github);
    // Reads never clean up.
    await contentStatus(folder, host);
    await readFolderCatalog(folder);
    expect((await readdir(organizations)).sort()).toEqual(
      [
        ".alpha_GEN3.lazurio-content-0123456789abcdef",
        ".alpha_GEN3.lazurio-content-fedcba9876543210",
      ].sort(),
    );
    const result = await installContent(
      folder,
      {
        items: [{ kind: "organization", login: "Alpha" }],
        roots: { alpha: "Alpha/alpha_GEN3" },
      },
      () => {},
      host,
    );
    expect(result.kind === "content-install" && result.state).toBe("succeeded");
    expect((await readdir(organizations)).sort()).toEqual(
      [".alpha_GEN3.lazurio-content-fedcba9876543210", "alpha_GEN3"].sort(),
    );
    expect(await readFile(join(foreign, "keep"), "utf8")).toBe("not ours");
  },
  60_000,
);

posixTest("one content operation at a time per Folder", async () => {
  world = await createWorld();
  const folder = await presetFolder(world, "local");
  const { github } = stubGitHub(world);
  const held = await tryContentLock(world.lockDirectory, folder);
  expect(held).not.toBeNull();
  const result = await installContent(
    folder,
    { items: [{ kind: "personalspace" }] },
    () => {},
    contentHost(world, github),
  );
  expect(result).toEqual({ kind: "busy" });
  await held?.release();
});

// ---- Personalspace --------------------------------------------------------

posixTest(
  "an existing Personalspace on GitHub is only cloned",
  async () => {
    world = await createWorld();
    await remoteRepository(world, "example/example_GEN3", (directory) =>
      writeFile(join(directory, "README.md"), "mine"),
    );
    const folder = await presetFolder(world, "local");
    const { github, calls } = stubGitHub(world, {
      repositories: {
        "example/example_GEN3": {
          owner: { login: "example", databaseId: 12345, kind: "User" },
        },
      },
    });
    const host = contentHost(world, github);
    const steps: ContentStep[] = [];
    const result = await installContent(
      folder,
      { items: [{ kind: "personalspace" }] },
      (step) => steps.push(step),
      host,
    );
    expect(summary(steps)).toEqual(["find:done", "clone:done", "check:done"]);
    expect(calls.some((call) => call.kind === "generate")).toBe(false);
    expect(calls.some((call) => call.kind === "templateDerived")).toBe(false);
    expect(result.kind === "content-install" && result.items[0]).toEqual({
      item: { kind: "personalspace" },
      state: "succeeded",
      repository: "example/example_GEN3",
      directory: "personalspace/example_GEN3",
    });
    expect(
      await readFile(
        join(folder, "personalspace", "example_GEN3", "README.md"),
        "utf8",
      ),
    ).toBe("mine");
    // Present now: found locally, nothing cloned again.
    const again: ContentStep[] = [];
    await installContent(
      folder,
      { items: [{ kind: "personalspace" }] },
      (step) => again.push(step),
      host,
    );
    expect(summary(again)).toEqual([
      "find:done",
      "clone:skipped",
      "check:done",
    ]);
  },
  30_000,
);

// A checkout of `fullName` in `directory`, cloned outside the install the way
// a person or an earlier tool would have left it (origin on github.com).
async function checkoutOf(fullName: string, directory: string) {
  const clone = Bun.spawnSync(
    ["git", "clone", "--quiet", `git@github.com:${fullName}.git`, directory],
    {
      env: {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        HOME: (world as World).home,
        ...(world as World).gitEnv,
      },
    },
  );
  if (clone.exitCode !== 0)
    throw new Error(`clone failed: ${clone.stderr.toString()}`);
}

posixTest(
  "a checkout already in personalspace/ counts only when it is the account's own, private Personalspace",
  async () => {
    world = await createWorld();
    for (const fullName of [
      "stranger/stranger_GEN3",
      "example/example_GEN3",
    ] as const)
      await remoteRepository(world, fullName, (directory) =>
        writeFile(join(directory, "README.md"), fullName),
      );
    const owned = {
      owner: { login: "example", databaseId: 12345, kind: "User" as const },
    };
    const cases = [
      // Another account's Personalspace, under its own name.
      {
        name: "stranger_GEN3",
        origin: "stranger/stranger_GEN3",
        repositories: { "example/example_GEN3": owned },
        code: "personalspace-foreign",
      },
      // Another account's checkout under the viewer's name.
      {
        name: "example_GEN3",
        origin: "stranger/stranger_GEN3",
        repositories: { "example/example_GEN3": owned },
        code: "personalspace-foreign",
      },
      // The viewer's name and origin, but GitHub does not know it as theirs.
      {
        name: "example_GEN3",
        origin: "example/example_GEN3",
        repositories: {},
        code: "personalspace-not-owned",
      },
      // Theirs, but public.
      {
        name: "example_GEN3",
        origin: "example/example_GEN3",
        repositories: { "example/example_GEN3": { ...owned, private: false } },
        code: "personalspace-public",
      },
    ];
    for (const entry of cases) {
      const folder = await presetFolder(world, "local");
      const directory = join(folder, "personalspace", entry.name);
      await checkoutOf(entry.origin, directory);
      const { github, calls } = stubGitHub(world, {
        repositories: entry.repositories,
      });
      const host = contentHost(world, github);
      const steps: ContentStep[] = [];
      const result = await installContent(
        folder,
        { items: [{ kind: "personalspace" }] },
        (step) => steps.push(step),
        host,
      );
      expect([entry.name, entry.origin, summary(steps)]).toEqual([
        entry.name,
        entry.origin,
        [`find:failed:${entry.code}`],
      ]);
      expect(result.kind === "content-install" && result.state).toBe("failed");
      // Left untouched, and nothing created or cloned.
      expect(await readdir(join(folder, "personalspace"))).toEqual([
        entry.name,
      ]);
      expect(await readFile(join(directory, "README.md"), "utf8")).toBe(
        entry.origin,
      );
      expect(calls.some((call) => call.kind === "generate")).toBe(false);
      // What lives here says so too: a foreign checkout is not "present".
      if (entry.code === "personalspace-foreign")
        expect((await contentStatus(folder, host)).items).toEqual([
          {
            kind: "personalspace",
            login: "example",
            state: "blocked",
            reason: "personalspace-foreign",
          },
        ]);
    }
  },
  60_000,
);

posixTest(
  "a missing Personalspace is created private from the template, then cloned",
  async () => {
    world = await createWorld();
    const folder = await presetFolder(world, "local");
    const { github, calls } = stubGitHub(world);
    const steps: ContentStep[] = [];
    const result = await installContent(
      folder,
      { items: [{ kind: "personalspace" }] },
      (step) => steps.push(step),
      contentHost(world, github),
    );
    expect(summary(steps)).toEqual([
      "find:done",
      "create:done",
      "clone:done",
      "check:done",
    ]);
    expect(result.kind === "content-install" && result.state).toBe("succeeded");
    expect(calls.find((call) => call.kind === "generate")?.args).toEqual([
      "Lazurio/PersonalspaceTemplate_GEN3",
      "example",
      "example_GEN3",
      "Privátní Personalspace GEN3.",
    ]);
    expect(
      await exists(
        join(
          folder,
          "personalspace",
          "example_GEN3",
          "personalspace.template.json",
        ),
      ),
    ).toBe(true);
  },
  30_000,
);

posixTest(
  "a Personalspace already created from the template under another name blocks creation",
  async () => {
    world = await createWorld();
    const folder = await presetFolder(world, "local");
    const { github, calls } = stubGitHub(world, {
      derived: ["example/oldname_GEN3"],
    });
    const steps: ContentStep[] = [];
    const result = await installContent(
      folder,
      { items: [{ kind: "personalspace" }] },
      (step) => steps.push(step),
      contentHost(world, github),
    );
    expect(summary(steps)).toEqual(["find:failed:personalspace-elsewhere"]);
    expect(
      result.kind === "content-install" && result.failure?.detail,
    ).toContain("example/oldname_GEN3");
    expect(calls.some((call) => call.kind === "generate")).toBe(false);
    expect(await readdir(join(folder, "personalspace"))).toEqual([]);
  },
);

posixTest(
  "a public repository is never taken as the Personalspace",
  async () => {
    world = await createWorld();
    const folder = await presetFolder(world, "local");
    const { github } = stubGitHub(world, {
      repositories: {
        "example/example_GEN3": {
          private: false,
          owner: { login: "example", databaseId: 12345, kind: "User" },
        },
      },
    });
    const steps: ContentStep[] = [];
    await installContent(
      folder,
      { items: [{ kind: "personalspace" }] },
      (step) => steps.push(step),
      contentHost(world, github),
    );
    expect(summary(steps)).toEqual(["find:failed:personalspace-public"]);
  },
);

posixTest("gh signed out stops before anything is asked", async () => {
  world = await createWorld();
  const folder = await presetFolder(world, "local");
  const { github } = stubGitHub(world, { viewer: { kind: "signed-out" } });
  const steps: ContentStep[] = [];
  await installContent(
    folder,
    { items: [{ kind: "personalspace" }] },
    (step) => steps.push(step),
    contentHost(world, github),
  );
  expect(summary(steps)).toEqual(["find:failed:github-signed-out"]);
});

// ---- Presets --------------------------------------------------------------

posixTest(
  "the Environment's kind decides its content",
  async () => {
    world = await createWorld();
    const { github } = stubGitHub(world);
    const host = contentHost(world, github);
    const organization = { kind: "organization", login: "example" } as const;
    const personalspace = { kind: "personalspace" } as const;

    // A personal Remote Environment: only the Personalspace.
    const personal = await presetFolder(
      world,
      "hosted-personal",
      bindings.personal,
    );
    expect(await contentStatus(personal, host)).toEqual({
      allowed: true,
      items: [
        {
          kind: "personalspace",
          login: "example",
          state: "absent",
          onGitHub: "missing",
        },
      ],
    });
    expect(
      await planContentInstall(personal, { items: [organization] }, host),
    ).toEqual({ kind: "not-allowed", reason: "not-for-this-environment" });
    const personalPlan = await planContentInstall(personal, {}, host);
    expect(personalPlan.kind === "planned" && personalPlan.items).toEqual([
      personalspace,
    ]);

    // A work Environment: only its own Organization.
    const work = await presetFolder(
      world,
      "hosted-organization-personal",
      bindings.organization,
    );
    expect(await contentStatus(work, host)).toEqual({
      allowed: true,
      items: [{ kind: "organization", login: "example", state: "absent" }],
    });
    for (const item of [
      personalspace,
      { kind: "organization", login: "other" } as const,
    ])
      expect(await planContentInstall(work, { items: [item] }, host)).toEqual({
        kind: "not-allowed",
        reason: "not-for-this-environment",
      });
    const workPlan = await planContentInstall(work, {}, host);
    expect(workPlan.kind === "planned" && workPlan.items).toEqual([
      organization,
    ]);

    // The person's own computer: its Organizations and the Personalspace.
    const local = await presetFolder(world, "local");
    const localPlan = await planContentInstall(
      local,
      { items: [organization, personalspace] },
      host,
    );
    expect(localPlan.kind === "planned" && localPlan.items).toEqual([
      organization,
      personalspace,
    ]);
    expect((await contentStatus(local, host)).items).toEqual([
      {
        kind: "personalspace",
        login: "example",
        state: "absent",
        onGitHub: "missing",
      },
    ]);

    // Team and Automated Environments: prepared by the hosting.
    for (const [preset, machine] of [
      ["hosted-organization-team", bindings.assignedTeam],
      ["hosted-organization-steward", bindings.automated],
    ] as const) {
      const folder = await presetFolder(world, preset, machine);
      expect(await contentStatus(folder, host)).toEqual({
        allowed: false,
        reason: "prepared-by-hosting",
        items: [],
      });
      const steps: ContentStep[] = [];
      expect(
        await installContent(folder, {}, (step) => steps.push(step), host),
      ).toEqual({ kind: "not-allowed", reason: "prepared-by-hosting" });
      expect(steps).toEqual([]);
    }
  },
  60_000,
);

posixTest(
  "a personal Remote Environment holds only its owner's Personalspace",
  async () => {
    world = await createWorld();
    const { github, calls } = stubGitHub(world, {
      viewer: {
        kind: "signed-in",
        viewer: { login: "someone", databaseId: 999 },
      },
    });
    const host = contentHost(world, github);
    const personal = await presetFolder(
      world,
      "hosted-personal",
      bindings.personal,
    );
    expect((await contentStatus(personal, host)).items).toEqual([
      {
        kind: "personalspace",
        login: "someone",
        state: "absent",
        onGitHub: "unknown",
        reason: "github-identity-mismatch",
      },
    ]);
    const steps: ContentStep[] = [];
    await installContent(personal, {}, (step) => steps.push(step), host);
    expect(summary(steps)).toEqual(["find:failed:github-identity-mismatch"]);
    expect(calls.some((call) => call.kind === "repository")).toBe(false);
  },
  30_000,
);
