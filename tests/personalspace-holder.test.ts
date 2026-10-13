import { afterEach, expect, test } from "bun:test";
import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ContentGitHub, ViewerAnswer } from "../src/content/github";
import { createPersonalspaceHolder } from "../src/content/holder";
import { personalspaceHolder } from "../src/content/status";
import {
  type PersonalspaceBlockedReason,
  type PersonalspaceHolder,
  resolvePersonalspaceApplication,
  unverifiedPersonalspace,
} from "../src/organizations/personalspace";
import { writePersonalspaceModule } from "./fixtures/catalog-folder";
import {
  checkoutWithOrigin,
  contentHost,
  createWorld,
  presetFolder,
  stubGitHub,
  type World,
} from "./fixtures/content-world";
import { bindings } from "./fixtures/machine-bindings";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// Whose Personalspace this Environment holds (Lazurio/LazurioPlatform#186,
// decided by Matěj on 2026-10-05): the GitHub account this Environment's gh
// is signed in with, and on a personal Remote Environment only the handover's
// Owner. The one decision of `GET /api/content`, the catalog and the module
// lifecycle, made as `verifyPersonalspaceCheckout` makes it; nothing is
// stored but a minute of GitHub's answer in memory. Real git over local
// checkouts, a stub GitHub, synthetic names only.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

type Repositories = NonNullable<
  NonNullable<Parameters<typeof stubGitHub>[1]>["repositories"]
>;

const owned = {
  owner: { login: "example", databaseId: 12345, kind: "User" as const },
};
const ownPersonalspace = { "example/example_GEN3": owned };

const heldAt = (directory: string): PersonalspaceHolder => ({
  kind: "held",
  login: "example",
  directory,
});
const blocked = (
  reason: PersonalspaceBlockedReason,
  login: string | null = null,
): PersonalspaceHolder => ({ kind: "blocked", reason, login });

/** A workstation Folder whose personalspace/ holds `name`, a checkout of
 * `origin`. */
async function workstation(name: string, origin: string) {
  const folder = await presetFolder(world as World, "local");
  const directory = join(folder, "personalspace", name);
  await checkoutWithOrigin(directory, origin);
  await writeFile(join(directory, "README.md"), origin);
  return { folder, directory };
}

/** A stub GitHub whose viewer can change between reads and whose reads can
 * wait at a gate: each read answers with the sign-in at the moment it was
 * asked, delivered when the gate opens, as a response in flight. `calls`
 * logs every read. */
function changingGitHub(repositories: Repositories) {
  const { github, calls } = stubGitHub(world as World, { repositories });
  let viewer: ViewerAnswer = {
    kind: "signed-in",
    viewer: { login: "example", databaseId: 12345 },
  };
  let gate: Promise<void> = Promise.resolve();
  let fail = false;
  const changing: ContentGitHub = {
    ...github,
    async viewer() {
      calls.push({ kind: "viewer", args: [] });
      const answer = viewer;
      const failing = fail;
      await gate;
      if (failing) throw new Error("gh could not be run");
      return answer;
    },
  };
  return {
    github: changing,
    calls,
    count: (kind: string) => calls.filter((call) => call.kind === kind).length,
    signIn(answer: ViewerAnswer) {
      viewer = answer;
    },
    /** Holds every read asked from now on until the returned function
     * opens this gate; a later hold makes a gate of its own. */
    hold() {
      let open = () => {};
      const held = new Promise<void>((resolve) => {
        open = resolve;
      });
      gate = held;
      return () => {
        if (gate === held) gate = Promise.resolve();
        open();
      };
    },
    failing(value: boolean) {
      fail = value;
    },
  };
}

// The answer of `work` if it settles within `ms`, else "waiting".
const within = <T>(work: Promise<T>, ms = 1000) =>
  Promise.race([
    work,
    new Promise<"waiting">((resolve) =>
      setTimeout(() => resolve("waiting"), ms),
    ),
  ]);

posixTest(
  "a workstation: gh's account holds only its own, private Personalspace; anything else is blocked with its reason and left untouched",
  async () => {
    world = await createWorld();
    const cases: {
      name: string;
      origin: string;
      viewer?: ViewerAnswer;
      repositories: Repositories;
      // Null: held by the viewer.
      holder: PersonalspaceHolder | null;
      asked: string[];
    }[] = [
      {
        name: "example_GEN3",
        origin: "example/example_GEN3",
        repositories: ownPersonalspace,
        holder: null,
        asked: ["viewer", "repository"],
      },
      // gh is not signed in, or GitHub does not answer: never held.
      {
        name: "example_GEN3",
        origin: "example/example_GEN3",
        viewer: { kind: "signed-out" },
        repositories: ownPersonalspace,
        holder: blocked("github-signed-out"),
        asked: ["viewer"],
      },
      {
        name: "example_GEN3",
        origin: "example/example_GEN3",
        viewer: { kind: "unavailable" },
        repositories: ownPersonalspace,
        holder: blocked("github-unavailable"),
        asked: ["viewer"],
      },
      {
        name: "example_GEN3",
        origin: "example/example_GEN3",
        repositories: { "example/example_GEN3": "unavailable" },
        holder: blocked("github-unavailable", "example"),
        asked: ["viewer", "repository"],
      },
      // Another account's Personalspace, under its own name or the
      // viewer's: foreign, and GitHub is not asked about it.
      {
        name: "stranger_GEN3",
        origin: "stranger/stranger_GEN3",
        repositories: ownPersonalspace,
        holder: blocked("personalspace-foreign", "example"),
        asked: ["viewer"],
      },
      {
        name: "example_GEN3",
        origin: "stranger/stranger_GEN3",
        repositories: ownPersonalspace,
        holder: blocked("personalspace-foreign", "example"),
        asked: ["viewer"],
      },
      // The viewer's name and origin, but not theirs on GitHub, or public.
      {
        name: "example_GEN3",
        origin: "example/example_GEN3",
        repositories: {},
        holder: blocked("personalspace-not-owned", "example"),
        asked: ["viewer", "repository"],
      },
      {
        name: "example_GEN3",
        origin: "example/example_GEN3",
        repositories: { "example/example_GEN3": { ...owned, private: false } },
        holder: blocked("personalspace-public", "example"),
        asked: ["viewer", "repository"],
      },
    ];
    for (const entry of cases) {
      const { folder, directory } = await workstation(entry.name, entry.origin);
      const { github, calls } = stubGitHub(world, {
        repositories: entry.repositories,
        ...(entry.viewer === undefined ? {} : { viewer: entry.viewer }),
      });
      const decided = await personalspaceHolder(
        folder,
        contentHost(world, github),
      );
      expect([entry.name, entry.origin, decided]).toEqual([
        entry.name,
        entry.origin,
        entry.holder ?? heldAt(directory),
      ]);
      expect(calls.map((call) => call.kind)).toEqual(entry.asked);
      // Left as it was.
      expect(await readFile(join(directory, "README.md"), "utf8")).toBe(
        entry.origin,
      );
    }
  },
  60_000,
);

posixTest(
  "the layout decides without GitHub: none, more than one, or one that is not a real directory",
  async () => {
    world = await createWorld();
    const { github, calls } = stubGitHub(world, {
      repositories: ownPersonalspace,
    });
    const host = contentHost(world, github);
    // folder-init of a workstation creates an empty personalspace/.
    const empty = await presetFolder(world, "local");
    expect(await personalspaceHolder(empty, host)).toEqual({ kind: "absent" });
    const { folder } = await workstation(
      "example_GEN3",
      "example/example_GEN3",
    );
    await mkdir(join(folder, "personalspace", "another_GEN3"));
    expect(await personalspaceHolder(folder, host)).toEqual({
      kind: "blocked",
      reason: "personalspace-ambiguous",
      login: null,
    });
    const linked = await presetFolder(world, "local");
    await symlink(folder, join(linked, "personalspace", "example_GEN3"));
    expect(await personalspaceHolder(linked, host)).toEqual({
      kind: "blocked",
      reason: "personalspace-unavailable",
      login: null,
    });
    expect(calls).toEqual([]);
  },
  30_000,
);

posixTest(
  "a personal Remote Environment: only the handover's Owner holds it; an Organization Environment never reads personalspace/",
  async () => {
    world = await createWorld();
    const personal = await presetFolder(
      world,
      "hosted-personal",
      bindings.personal,
    );
    const directory = join(personal, "personalspace", "someone_GEN3");
    await checkoutWithOrigin(directory, "someone/someone_GEN3");
    // Another account, holding its own private Personalspace on GitHub:
    // still not this Environment's, and nothing more is asked.
    const someone = stubGitHub(world, {
      viewer: {
        kind: "signed-in",
        viewer: { login: "someone", databaseId: 999 },
      },
      repositories: {
        "someone/someone_GEN3": {
          owner: { login: "someone", databaseId: 999, kind: "User" },
        },
      },
    });
    expect(
      await personalspaceHolder(personal, contentHost(world, someone.github)),
    ).toEqual({
      kind: "blocked",
      reason: "github-identity-mismatch",
      login: "someone",
    });
    expect(someone.calls.map((call) => call.kind)).toEqual(["viewer"]);
    // The Owner (GitHub id 12345 in the handover), under the login gh
    // reports now.
    await rm(directory, { recursive: true });
    const own = join(personal, "personalspace", "example_GEN3");
    await checkoutWithOrigin(own, "example/example_GEN3");
    const owner = stubGitHub(world, { repositories: ownPersonalspace });
    expect(
      await personalspaceHolder(personal, contentHost(world, owner.github)),
    ).toEqual({ kind: "held", login: "example", directory: own });

    // A work Environment: a stray personalspace/ is never read.
    const work = await presetFolder(
      world,
      "hosted-organization-personal",
      bindings.organization,
    );
    await checkoutWithOrigin(
      join(work, "personalspace", "example_GEN3"),
      "example/example_GEN3",
    );
    const asked = stubGitHub(world, { repositories: ownPersonalspace });
    expect(
      await personalspaceHolder(work, contentHost(world, asked.github)),
    ).toEqual({ kind: "absent" });
    expect(asked.calls).toEqual([]);
  },
  30_000,
);

posixTest(
  "remembered a minute: the decision is reused for the same directory, asked again after the minute, for another directory or after forget, and one question at a time",
  async () => {
    world = await createWorld();
    const { folder, directory } = await workstation(
      "example_GEN3",
      "example/example_GEN3",
    );
    const gh = changingGitHub(ownPersonalspace);
    let clock = 1_000_000;
    const holder = createPersonalspaceHolder(
      () => contentHost(world as World, gh.github),
      { now: () => clock },
    );
    const held = heldAt(directory);
    // Three reads at once ask GitHub once.
    expect(
      await Promise.all([
        holder.decide(folder),
        holder.decide(folder),
        holder.decide(folder),
      ]),
    ).toEqual([held, held, held]);
    expect([gh.count("viewer"), gh.count("repository")]).toEqual([1, 1]);
    clock += 59_000;
    expect(await holder.decide(folder)).toEqual(held);
    expect(gh.count("viewer")).toBe(1);
    // The layout is read every time: a second directory is seen at once,
    // and once it is gone the remembered answer holds again.
    const second = join(folder, "personalspace", "another_GEN3");
    await mkdir(second);
    expect(await holder.decide(folder)).toEqual(
      blocked("personalspace-ambiguous"),
    );
    await rm(second, { recursive: true });
    expect(await holder.decide(folder)).toEqual(held);
    expect(gh.count("viewer")).toBe(1);
    // After the minute, GitHub is asked again.
    clock += 2_000;
    gh.signIn({ kind: "signed-out" });
    expect(await holder.decide(folder)).toEqual(blocked("github-signed-out"));
    expect(gh.count("viewer")).toBe(2);
    // forget (a sign-in through the Launchpad): asked again at once.
    gh.signIn({
      kind: "signed-in",
      viewer: { login: "example", databaseId: 12345 },
    });
    holder.forget();
    expect(await holder.decide(folder)).toEqual(held);
    expect(gh.count("viewer")).toBe(3);
    // Another checkout in its place (the same name): asked again at once.
    await rm(directory, { recursive: true });
    await checkoutWithOrigin(directory, "stranger/stranger_GEN3");
    expect(await holder.decide(folder)).toEqual(
      blocked("personalspace-foreign", "example"),
    );
    expect(gh.count("viewer")).toBe(4);
    // An answer that could not be made at all is not remembered.
    await rm(directory, { recursive: true });
    await checkoutWithOrigin(directory, "example/example_GEN3");
    gh.failing(true);
    expect(await holder.decide(folder)).toEqual(
      blocked("personalspace-unavailable"),
    );
    gh.failing(false);
    expect(await holder.decide(folder)).toEqual(held);
    expect(gh.count("viewer")).toBe(6);
  },
  60_000,
);

posixTest(
  "peek never waits for GitHub: unverified until the first answer, then the last answer, asked again in the background when it is old or GitHub did not answer",
  async () => {
    world = await createWorld();
    const { folder, directory } = await workstation(
      "example_GEN3",
      "example/example_GEN3",
    );
    const gh = changingGitHub(ownPersonalspace);
    let clock = 1_000_000;
    const holder = createPersonalspaceHolder(
      () => contentHost(world as World, gh.github),
      { now: () => clock },
    );
    const held = heldAt(directory);
    const unverified = blocked("personalspace-unverified");
    // GitHub does not answer yet: peek answers at once, decide waits.
    const open = gh.hold();
    expect(await within(holder.peek(folder))).toEqual(unverified);
    const deciding = holder.decide(folder);
    expect(await within(deciding, 200)).toBe("waiting");
    // One question for both.
    expect(gh.count("viewer")).toBe(1);
    open();
    expect(await deciding).toEqual(held);
    await holder.settled();
    expect(await holder.peek(folder)).toEqual(held);
    expect(gh.count("viewer")).toBe(1);
    // Older than the minute: the last answer at once, asked again behind it.
    clock += 61_000;
    gh.signIn({ kind: "signed-out" });
    expect(await holder.peek(folder)).toEqual(held);
    await holder.settled();
    const signedOut = blocked("github-signed-out");
    expect(await holder.peek(folder)).toEqual(signedOut);
    expect(await holder.decide(folder)).toEqual(signedOut);
    expect(gh.count("viewer")).toBe(2);
    // GitHub did not answer: peek asks again at once, within the minute.
    gh.signIn({ kind: "unavailable" });
    holder.forget();
    const unavailable = blocked("github-unavailable");
    expect(await holder.decide(folder)).toEqual(unavailable);
    gh.signIn({
      kind: "signed-in",
      viewer: { login: "example", databaseId: 12345 },
    });
    expect(await holder.peek(folder)).toEqual(unavailable);
    await holder.settled();
    expect(await holder.peek(folder)).toEqual(held);
    expect(await holder.decide(folder)).toEqual(held);
    expect(gh.count("viewer")).toBe(4);
    // GitHub's answer, asked while signed in, is still on its way when the
    // Launchpad signs gh out and forgets: that decision is never answered
    // (#382 review), the decision is made again with what is current.
    const late = gh.hold();
    holder.forget();
    const stale = holder.decide(folder);
    while (gh.count("viewer") < 5) await Bun.sleep(5);
    gh.signIn({ kind: "signed-out" });
    holder.forget();
    late();
    expect(await stale).toEqual(signedOut);
    expect(gh.count("viewer")).toBe(6);
    // Nor is it kept, or shown by peek: only what was decided after the
    // forget.
    expect(await holder.peek(folder)).toEqual(signedOut);
    expect(await holder.decide(folder)).toEqual(signedOut);
    expect(gh.count("viewer")).toBe(6);
    // A background decision of peek overtaken by a forget is not kept
    // either: peek says unverified, never the stale answer.
    gh.signIn({
      kind: "signed-in",
      viewer: { login: "example", databaseId: 12345 },
    });
    holder.forget();
    const overtaken = gh.hold();
    expect(await holder.peek(folder)).toEqual(unverified);
    while (gh.count("viewer") < 7) await Bun.sleep(5);
    gh.signIn({ kind: "signed-out" });
    holder.forget();
    overtaken();
    await holder.settled();
    expect(await holder.peek(folder)).toEqual(unverified);
    await holder.settled();
    expect(await holder.peek(folder)).toEqual(signedOut);
    // Forgotten again and again while it decides: never held, not verified.
    gh.signIn({
      kind: "signed-in",
      viewer: { login: "example", databaseId: 12345 },
    });
    holder.forget();
    let release = gh.hold();
    const asked = gh.count("viewer");
    const unsettled = holder.decide(folder);
    for (let round = 1; round <= 3; round += 1) {
      while (gh.count("viewer") < asked + round) await Bun.sleep(5);
      holder.forget();
      const previous = release;
      release = round < 3 ? gh.hold() : () => {};
      previous();
    }
    expect(await unsettled).toEqual(unverified);
    expect(gh.count("viewer")).toBe(asked + 3);
  },
  60_000,
);

posixTest(
  "without a decision, an owner directory is never taken for the Operator's; the app resolution asks the holder again",
  async () => {
    world = await createWorld();
    const { folder, directory } = await workstation(
      "example_GEN3",
      "example/example_GEN3",
    );
    expect(await unverifiedPersonalspace(folder)).toEqual(
      blocked("personalspace-unverified"),
    );
    // The layout's own answers stay.
    expect(
      await unverifiedPersonalspace(await presetFolder(world, "local")),
    ).toEqual({ kind: "absent" });
    await writePersonalspaceModule(folder, "example_GEN3", "example", {
      id: "notes",
    });
    const selection = {
      company: "example",
      module: "notes",
      package: "app/package.json",
    };
    const held = async () =>
      ({ kind: "held", login: "example", directory }) as const;
    expect(
      await resolvePersonalspaceApplication(directory, selection, held),
    ).toEqual({ moduleDirectory: join(directory, "workspace", "notes") });
    for (const holder of [
      unverifiedPersonalspace,
      async () =>
        ({
          kind: "blocked",
          reason: "personalspace-foreign",
          login: "example",
        }) as const,
      // Held, but another directory than the one selected.
      async () =>
        ({
          kind: "held",
          login: "example",
          directory: join(folder, "personalspace", "other_GEN3"),
        }) as const,
    ])
      await expect(
        resolvePersonalspaceApplication(directory, selection, holder),
      ).rejects.toThrow("Selected Personalspace unavailable");
  },
  30_000,
);
