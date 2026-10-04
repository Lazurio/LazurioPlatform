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
import { contentStatus } from "../src/content/status";
import { readFolderCatalog } from "../src/organizations/catalog";
import { renameNoReplace } from "../src/platform/rename";
import {
  alphaRemotes,
  contentHost,
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
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
      "workspace/planned": "no-repository",
      "workspace/secret": "restricted",
      "workspace/web": "materialized",
    });
    for (const path of [
      "workspace/web",
      "mission-control",
      "productionspace/firmware",
    ])
      expect(await exists(join(root, path, ".git"))).toBe(true);
    for (const path of [
      "workspace/docs",
      "workspace/secret",
      "infra",
      "mission-control/db",
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

posixTest(
  "an absent Organization without a declared root is an open decision, not a guess",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(world, "local");
    const { github, calls } = stubGitHub(world, {
      repositories: alphaReadable,
    });
    const steps: ContentStep[] = [];
    const result = await installContent(
      folder,
      { items: [{ kind: "organization", login: "Alpha" }] },
      (step) => steps.push(step),
      contentHost(world, github),
    );
    expect(result.kind === "content-install" && result.failure).toEqual({
      item: { kind: "organization", login: "Alpha" },
      key: "access",
      code: "organization-root-needs-decision",
      detail: expect.stringContaining("--root"),
    });
    // Not even the conventional name was asked for.
    expect(calls.filter((call) => call.kind === "repository")).toEqual([]);
    expect(await readdir(join(folder, "organizations"))).toEqual([]);
  },
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
  "a root whose own declaration names another Organization is never published",
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
    expect(summary(steps)).toEqual([
      "access:done",
      "root:failed:root-declaration-mismatch",
    ]);
    // Neither the destination nor the temporary sibling remains.
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
