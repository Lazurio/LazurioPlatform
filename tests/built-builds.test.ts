import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildProcessInput } from "../src/modules/built/build-process";
import {
  type BuildJob,
  type BuildOutcome,
  createBuilds,
} from "../src/modules/built/builds";
import { buildKeyOf, openBuildStore } from "../src/modules/built/store";
import { acquireFileLock } from "../src/platform/flock";

// The builds of an Environment's static apps (decision F58) over fakes of
// the checkout, the start-time step and the build script: the key, the
// whole install of an output under it, the current and previous builds kept
// and older ones removed, one build at a time with the waiting person first,
// a pull during a build coalesced into one more build, a failure that keeps
// what was built, another process's lock, and shutdown.
let root = "";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "builds-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const commit = (n: number) => n.toString(16).padStart(40, "0");

type Checkout = { commit: string; dirty: boolean };

function app(name: string, checkout: Checkout) {
  const cwd = join(root, "checkouts", name);
  const job = (extra: Partial<BuildJob> = {}): BuildJob => ({
    directory: join(root, "cache", name),
    names: { organization: "alpha", module: name, app: "app/package.json" },
    read: async () => ({
      head: {
        commit: checkout.commit,
        branch: "main",
        dirty: checkout.dirty,
        gitDirectory: join(cwd, ".git"),
      },
      inputs: [],
      key: checkout.commit,
      cwd,
      script: "build",
      output: "dist",
      fallback: "404" as const,
      health: "/",
      env: {},
    }),
    prepare: async () => null,
    ...extra,
  });
  return { cwd, job, store: openBuildStore(join(root, "cache", name)) };
}

// A build script that writes `dist/index.html` naming the commit it read,
// waits on a gate when one is set, and fails when told.
function fakeBuild(checkouts: Map<string, Checkout>) {
  const runs: string[] = [];
  let active = 0;
  let most = 0;
  const gates = new Map<string, () => void>();
  const failing = new Set<string>();
  const during = new Map<string, () => void>();
  const run = async (input: BuildProcessInput) => {
    active++;
    most = Math.max(most, active);
    const name = input.cwd.split("/").at(-1) as string;
    const checkout = checkouts.get(name) as Checkout;
    runs.push(`${name}@${checkout.commit.slice(-2)}`);
    try {
      during.get(name)?.();
      during.delete(name);
      if (gates.has(name))
        await new Promise<void>((resolve) => {
          const release = gates.get(name) as () => void;
          gates.set(name, () => {
            release();
            resolve();
          });
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      if (input.signal.aborted) return { kind: "cancelled" as const };
      await writeFile(input.log, `built ${checkout.commit}\n`);
      if (failing.has(name)) return { kind: "exited" as const, code: 1 };
      await rm(join(input.cwd, "dist"), { recursive: true, force: true });
      await mkdir(join(input.cwd, "dist"), { recursive: true });
      await writeFile(
        join(input.cwd, "dist/index.html"),
        `<p>${checkout.commit}</p>`,
      );
      return { kind: "exited" as const, code: 0 };
    } finally {
      active--;
    }
  };
  return {
    run,
    runs,
    most: () => most,
    gate(name: string) {
      gates.set(name, () => {});
    },
    release(name: string) {
      gates.get(name)?.();
      gates.delete(name);
    },
    failing,
    during,
  };
}

function builder(fake: ReturnType<typeof fakeBuild>, lockWaitMs?: number) {
  return createBuilds({
    lockFile: join(root, "state/lazurio/builds.lock"),
    runner: async () => "session",
    executable: process.execPath,
    servable: async (output) => Bun.file(join(output, "index.html")).exists(),
    runBuild: fake.run,
    ...(lockWaitMs === undefined ? {} : { lockWaitMs }),
  });
}

const built = (outcome: BuildOutcome) => {
  if (outcome.kind !== "built") throw new Error(JSON.stringify(outcome));
  return outcome;
};

test("the key is the module's commit, or the digest of every checkout the build reads", () => {
  expect(buildKeyOf(commit(1), [])).toBe(commit(1));
  const one = buildKeyOf(commit(1), [
    { path: "workspace/web/db", commit: commit(7) },
    { path: "workspace/api", commit: null },
  ]);
  expect(one).toMatch(/^[0-9a-f]{64}$/);
  // The same checkouts in any order are one key; a data repository's pull
  // is another.
  expect(
    buildKeyOf(commit(1), [
      { path: "workspace/api", commit: null },
      { path: "workspace/web/db", commit: commit(7) },
    ]),
  ).toBe(one);
  expect(
    buildKeyOf(commit(1), [
      { path: "workspace/web/db", commit: commit(8) },
      { path: "workspace/api", commit: null },
    ]),
  ).not.toBe(one);
});

test("an output is installed whole under its key; the current and previous builds stay, older ones and their logs go", async () => {
  const checkout = { commit: commit(1), dirty: false };
  const fake = fakeBuild(new Map([["web", checkout]]));
  const builds = builder(fake);
  const web = app("web", checkout);
  const first = built(await builds.enqueue(web.job(), "foreground"));
  expect(first.already).toBe(false);
  expect(first.output).toBe(join(web.store.directory, commit(1)));
  expect(await readFile(join(first.output, "index.html"), "utf8")).toBe(
    `<p>${commit(1)}</p>`,
  );
  // Built already: nothing runs.
  expect(built(await builds.enqueue(web.job(), "background")).already).toBe(
    true,
  );
  expect(fake.runs).toEqual(["web@01"]);
  for (const n of [2, 3]) {
    checkout.commit = commit(n);
    built(await builds.enqueue(web.job(), "background"));
  }
  const state = await web.store.state();
  expect(state?.current?.key).toBe(commit(3));
  expect(state?.previous?.key).toBe(commit(2));
  const kept = (await readdir(web.store.directory)).sort();
  expect(kept).toEqual([commit(2), commit(3), "build.json", "logs"].sort());
  expect((await readdir(join(web.store.directory, "logs"))).sort()).toEqual([
    `${commit(2)}.log`,
    `${commit(3)}.log`,
  ]);
  // The build the running app serves stays too, when it is older.
  await web.store.writeServed({
    mode: "built",
    key: commit(2),
    commit: commit(2),
  });
  checkout.commit = commit(4);
  built(await builds.enqueue(web.job(), "background"));
  checkout.commit = commit(5);
  built(await builds.enqueue(web.job(), "background"));
  expect(
    (await readdir(web.store.directory))
      .filter((entry) => /^[0-9a-f]{40}$/.test(entry))
      .sort(),
  ).toEqual([commit(2), commit(4), commit(5)]);
});

test("one build at a time: the person waiting goes before queued background builds, and the same app joins one build", async () => {
  const checkouts = new Map<string, Checkout>([
    ["a", { commit: commit(1), dirty: false }],
    ["b", { commit: commit(2), dirty: false }],
    ["c", { commit: commit(3), dirty: false }],
  ]);
  const fake = fakeBuild(checkouts);
  const builds = builder(fake);
  const [a, b, c] = ["a", "b", "c"].map((name) =>
    app(name, checkouts.get(name) as Checkout),
  ) as [ReturnType<typeof app>, ReturnType<typeof app>, ReturnType<typeof app>];
  fake.gate("a");
  const first = builds.enqueue(a.job(), "background");
  await Bun.sleep(20);
  const second = builds.enqueue(b.job(), "background");
  const waited = builds.enqueue(c.job(), "foreground");
  // The same app again joins its queued build.
  const joined = builds.enqueue(b.job(), "background");
  expect(builds.pending(b.store.directory)).toBe(true);
  fake.release("a");
  await Promise.all([first, second, waited, joined]);
  expect(fake.runs).toEqual(["a@01", "c@03", "b@02"]);
  expect(fake.most()).toBe(1);
  expect(await joined).toEqual(await second);
  await builds.settled();
});

test("a pull while it builds is built instead: the output is never of a mix of two commits", async () => {
  const checkout = { commit: commit(1), dirty: false };
  const fake = fakeBuild(new Map([["web", checkout]]));
  const builds = builder(fake);
  const web = app("web", checkout);
  fake.during.set("web", () => {
    checkout.commit = commit(2);
  });
  const outcome = built(await builds.enqueue(web.job(), "foreground"));
  expect(outcome.record.key).toBe(commit(2));
  expect(fake.runs).toEqual(["web@01", "web@02"]);
  expect(await readdir(web.store.directory)).not.toContain(commit(1));
});

test("a failed build keeps what was built, is recorded with its log, and is built again only when asked", async () => {
  const checkout = { commit: commit(1), dirty: false };
  const fake = fakeBuild(new Map([["web", checkout]]));
  const builds = builder(fake);
  const web = app("web", checkout);
  built(await builds.enqueue(web.job(), "foreground"));
  checkout.commit = commit(2);
  fake.failing.add("web");
  expect(await builds.enqueue(web.job(), "background")).toEqual({
    kind: "failed",
    reason: "build-script-failed",
    key: commit(2),
  });
  let state = await web.store.state();
  expect(state?.current?.key).toBe(commit(1));
  expect(state?.failure).toMatchObject({
    key: commit(2),
    reason: "build-script-failed",
  });
  expect(state?.building).toBeNull();
  expect(await web.store.output(commit(1))).not.toBeNull();
  expect(await readFile(web.store.logFile(commit(2)), "utf8")).toContain(
    commit(2),
  );
  // Not again by itself for the same commit…
  expect((await builds.enqueue(web.job(), "background")).kind).toBe("failed");
  expect(fake.runs).toEqual(["web@01", "web@02"]);
  // …but when asked, and a success clears the failure.
  fake.failing.delete("web");
  built(await builds.enqueue(web.job({ explicit: true }), "foreground"));
  state = await web.store.state();
  expect(state?.failure).toBeNull();
  expect(state?.current?.key).toBe(commit(2));
  expect(state?.previous?.key).toBe(commit(1));
  // A start-time step that fails is the build's reason, before any script.
  checkout.commit = commit(3);
  expect(
    await builds.enqueue(
      web.job({ prepare: async () => "preparation-install-failed" }),
      "background",
    ),
  ).toMatchObject({ kind: "failed", reason: "preparation-install-failed" });
  // An output that cannot answer the health path is not kept.
  checkout.commit = commit(4);
  const unservable = createBuilds({
    lockFile: join(root, "state/lazurio/builds.lock"),
    runner: async () => "session",
    executable: process.execPath,
    servable: async () => false,
    runBuild: fake.run,
  });
  expect(await unservable.enqueue(web.job(), "background")).toMatchObject({
    kind: "failed",
    reason: "build-output-unservable",
  });
  expect(await web.store.output(commit(4))).toBeNull();
});

test("another process's build holds the lock: busy after the wait, nothing recorded", async () => {
  const checkout = { commit: commit(1), dirty: false };
  const fake = fakeBuild(new Map([["web", checkout]]));
  const lockFile = join(root, "state/lazurio/builds.lock");
  await mkdir(join(root, "state/lazurio"), { recursive: true });
  const held = await acquireFileLock(lockFile, { timeoutMs: 1000 });
  try {
    const web = app("web", checkout);
    expect(await builder(fake, 100).enqueue(web.job(), "foreground")).toEqual({
      kind: "busy",
    });
    expect(fake.runs).toEqual([]);
    expect(await web.store.state()).toBeNull();
  } finally {
    await held.release();
  }
});

test("shutdown ends the build under way and answers the queued ones", async () => {
  const checkouts = new Map<string, Checkout>([
    ["a", { commit: commit(1), dirty: false }],
    ["b", { commit: commit(2), dirty: false }],
  ]);
  const fake = fakeBuild(checkouts);
  const builds = builder(fake);
  const a = app("a", checkouts.get("a") as Checkout);
  const b = app("b", checkouts.get("b") as Checkout);
  fake.gate("a");
  const running = builds.enqueue(a.job(), "foreground");
  await Bun.sleep(20);
  const queued = builds.enqueue(b.job(), "background");
  await builds.close();
  expect(await running).toEqual({ kind: "closing" });
  expect(await queued).toEqual({ kind: "closing" });
  expect((await a.store.state())?.building).toBeNull();
  expect(await builds.enqueue(b.job(), "foreground")).toEqual({
    kind: "closing",
  });
});
