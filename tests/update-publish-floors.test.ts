import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitRollback, runReleasePublish } from "../scripts/release-publish";
import { DistributionTransport } from "../src/distribution/transport";
import { generateSigner, type Signer } from "../src/publish/keys";
import { floorsOf, rollbackViolations } from "../src/publish/monotonic";
import {
  addRelease,
  type PublishOptions,
  promote,
  type RefreshRole,
  refresh,
} from "../src/publish/repository";
import { initialRoot, nextRoot } from "../src/publish/root";
import { applyPlan, directoryTree } from "../src/publish/tree";
import { checkForUpdate } from "../src/update/check";
import {
  type FloorVector,
  parseFloors,
  violationOf,
} from "../src/update/floors";

/** The publisher against the client's FLOOR VECTOR (docs/update.md "The floor
 * vector"). One Machine keeps its install base — and therefore its
 * `trust/floors.json` — through a normal publishing history and must never
 * see `metadata-rollback`; shown an older generation of the same repository
 * it must see exactly that. All keys are ephemeral and in memory.
 */
const target = "linux-x64";
const clock = () => new Date();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function artifact(version: string) {
  const bytes = Buffer.from(`executable ${version}`);
  return {
    target,
    sha256: sha256(bytes),
    length: bytes.length,
    identity: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        version,
        target,
        sourceCommit: "c".repeat(40),
        toolchain: "bun@0.0.0",
        schemas: { preferences: [1], manifest: [1] },
        artifactSha256: sha256(bytes),
        artifactBytes: bytes.length,
      }),
    ),
    url: `https://github.com/example/product/releases/download/v${version}/lazurio-${target}`,
  };
}

async function scenario() {
  const work = await realpath(await mkdtemp(join(tmpdir(), "publish-floors-")));
  const live = join(work, "live");
  await mkdir(live);
  /** The directory the static server answers from: the live tree, or a copy
   * of an older generation of it. */
  let serving = live;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (path.split("/").includes(".."))
        return new Response(null, { status: 400 });
      const file = Bun.file(join(serving, path));
      return (await file.exists())
        ? new Response(file)
        : new Response("not found", { status: 404 });
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
    await rm(work, { recursive: true, force: true });
  });
  const signers: Record<"root" | "targets" | "snapshot" | "timestamp", Signer> =
    {
      root: generateSigner(),
      targets: generateSigner(),
      snapshot: generateSigner(),
      timestamp: generateSigner(),
    };
  const keys = () => ({
    root: [signers.root.key],
    targets: [signers.targets.key],
    snapshot: [signers.snapshot.key],
    timestamp: [signers.timestamp.key],
  });
  const firstRoot = initialRoot({
    keys: keys(),
    rootSigner: signers.root,
    now: new Date(),
  });
  let root = firstRoot;
  const options = (): PublishOptions => ({ signers, now: new Date(), root });
  const tree = directoryTree(live);
  let generations = 0;
  const publisher = {
    async release(version: string) {
      await applyPlan(
        live,
        await addRelease(
          tree,
          {
            channel: "preview",
            version,
            notes: `Notes of ${version}`,
            artifacts: [artifact(version)],
          },
          options(),
        ),
      );
    },
    async promote(version: string) {
      await applyPlan(live, await promote(tree, { version }, options()));
    },
    /** In the live tree, or — with the same genuine keys — in another one. */
    async refresh(roles: RefreshRole[], directory = live) {
      await applyPlan(
        directory,
        await refresh(directoryTree(directory), roles, options()),
      );
    },
    /** New root key AND new targets key: every role below is re-signed. */
    async rotate() {
      const outgoing = signers.root;
      signers.root = generateSigner();
      signers.targets = generateSigner();
      root = nextRoot({
        current: root,
        keys: keys(),
        rootSigners: [outgoing, signers.root],
        now: new Date(),
      });
      await applyPlan(live, await refresh(tree, [], options()));
    },
    /** A complete copy of what is published now. */
    async keep() {
      const copy = join(work, `generation-${++generations}`);
      await cp(live, copy, { recursive: true });
      return copy;
    },
  };
  const base = join(work, "machine", "base");
  const transport = new DistributionTransport(
    [server.url.origin],
    10_000,
    new AbortController().signal,
    true,
  );
  const check = (channel: "preview" | "stable" = "preview") =>
    checkForUpdate({
      base,
      metadataBaseUrl: `${server.url}metadata/`,
      targetBaseUrl: `${server.url}targets/`,
      channel,
      identity: { version: "1.0.0", commit: "a".repeat(40), target },
      // The compiled-in root of this Machine's executable: root 1, forever.
      bootstrapRoot: firstRoot,
      transport,
      clock,
      lockTimeoutMs: 10_000,
    });
  const floors = async (): Promise<FloorVector> =>
    parseFloors(await readFile(join(base, "trust", "floors.json"), "utf8"));
  return {
    work,
    live,
    tree,
    publisher,
    check,
    floors,
    serve(directory: string | undefined) {
      serving = directory ?? live;
    },
  };
}

test("a normal publishing history never trips the client's floor vector, and every re-signing advances it", async () => {
  const s = await scenario();
  const seen: FloorVector[] = [];
  /** After each publishing step: the Machine checks, the answer is never a
   * rollback, and its vector only ever moves forward. */
  const step = async (
    expected: Record<string, unknown>,
    channel?: "preview" | "stable",
  ) => {
    const result = await s.check(channel);
    expect(result).not.toMatchObject({ code: "metadata-rollback" });
    expect(result).toMatchObject(expected);
    const vector = await s.floors();
    // What the publisher's own gate computes from the tree is what the
    // Machine recorded from the network: one definition of the facts.
    expect(await floorsOf(s.tree)).toEqual(vector);
    seen.push(vector);
    return vector;
  };

  await s.publisher.release("1.1.0");
  const a = await step({ kind: "available", version: "1.1.0" });
  expect([a.timestamp?.version, a.snapshot?.version]).toEqual([1, 1]);
  expect(a.roles["targets.json"]?.version).toBe(1);

  await s.publisher.release("1.2.0");
  const b = await step({ kind: "available", version: "1.2.0" });
  expect(b.roles["targets.json"]?.version).toBe(2);

  await s.publisher.promote("1.2.0");
  await step({ kind: "available", version: "1.2.0" }, "stable");

  // Refreshes: a NEW version every time, never the same version with other
  // signed content (which the client refuses as equivocation).
  const before = await s.floors();
  await s.publisher.refresh(["timestamp"]);
  const t = await step({ kind: "available", version: "1.2.0" });
  expect(t.timestamp?.version).toBe((before.timestamp?.version ?? 0) + 1);
  expect(t.timestamp?.signedSha256).not.toBe(before.timestamp?.signedSha256);
  expect(t.snapshot).toEqual(before.snapshot);
  expect(t.timestamp?.snapshot).toEqual(before.timestamp?.snapshot);

  await s.publisher.refresh(["snapshot"]);
  const n = await step({ kind: "available", version: "1.2.0" });
  expect(n.snapshot?.version).toBe((t.snapshot?.version ?? 0) + 1);
  expect(n.timestamp?.version).toBe((t.timestamp?.version ?? 0) + 1);
  expect(n.timestamp?.snapshot.version).toBe(n.snapshot?.version);
  // Targets were not touched: the entry is the same reference, not a new one.
  expect(n.snapshot?.meta["targets.json"]).toEqual(
    t.snapshot?.meta["targets.json"],
  );
  expect(n.roles["targets.json"]).toEqual(t.roles["targets.json"]);

  await s.publisher.refresh(["targets"]);
  const g = await step({ kind: "available", version: "1.2.0" });
  expect(g.roles["targets.json"]?.version).toBe(
    (n.roles["targets.json"]?.version ?? 0) + 1,
  );

  // Root rotation with a new targets key: the Machine still holds root 1 as
  // its compiled-in root and walks the chain; re-signed roles are NEW versions.
  await s.publisher.rotate();
  const r = await step({ kind: "available", version: "1.2.0" });
  expect(r.root.version).toBe(2);
  expect(Object.keys(r.root.retained).sort()).toEqual(["1", "2"]);
  expect(r.roles["targets.json"]?.version).toBe(
    (g.roles["targets.json"]?.version ?? 0) + 1,
  );

  await s.publisher.release("1.3.0");
  const c = await step({ kind: "available", version: "1.3.0" });
  await step({ kind: "available", version: "1.2.0" }, "stable");

  // The whole history, pairwise: `snapshot.meta` never dropped or lowered an
  // entry, no reference went down, no version repeated with other content.
  for (let index = 1; index < seen.length; index++) {
    const earlier = seen[index - 1] as FloorVector;
    const later = seen[index] as FloorVector;
    expect(Object.keys(later.snapshot?.meta ?? {})).toEqual(
      expect.arrayContaining(Object.keys(earlier.snapshot?.meta ?? {})),
    );
    for (const [name, entry] of Object.entries(earlier.snapshot?.meta ?? {}))
      expect(later.snapshot?.meta[name]?.version).toBeGreaterThanOrEqual(
        entry.version,
      );
    expect(later.timestamp?.version).toBeGreaterThanOrEqual(
      earlier.timestamp?.version ?? 0,
    );
    expect(later.timestamp?.snapshot.version).toBeGreaterThanOrEqual(
      earlier.timestamp?.snapshot.version ?? 0,
    );
  }
  // Release notes and every other target live in targets metadata, which the
  // vector binds by version and signed content: nothing of A or B was lost.
  const targets = JSON.parse(
    await readFile(
      join(s.live, `metadata/${c.roles["targets.json"]?.version}.targets.json`),
      "utf8",
    ),
  ).signed.targets as Record<string, unknown>;
  for (const version of ["1.1.0", "1.2.0", "1.3.0"]) {
    expect(Object.keys(targets)).toContain(`releases/${version}/notes.md`);
    expect(Object.keys(targets)).toContain(
      `artifacts/${artifact(version).sha256}/lazurio`,
    );
  }
}, 60_000);

test("an older generation of the same repository IS refused by the real client as metadata-rollback, and the publisher's gate refuses to publish one", async () => {
  const s = await scenario();
  await s.publisher.release("1.1.0");
  const generationA = await s.publisher.keep();
  await s.publisher.release("1.2.0");
  const generationB = await s.publisher.keep();
  await s.publisher.refresh(["snapshot"]);
  const generationC = await s.publisher.keep();
  expect(await s.check()).toMatchObject({
    kind: "available",
    version: "1.2.0",
  });
  const vector = await s.floors();

  // Every byte of generation A is genuine and correctly signed. It is only old.
  s.serve(generationA);
  const rewound = await s.check();
  expect(rewound).toMatchObject({ kind: "error", code: "metadata-rollback" });
  // Nothing moved: the Machine neither forgot what it saw nor adopted A.
  expect(await s.floors()).toEqual(vector);
  // A Machine that never saw B has no reason to refuse A: retention.
  // (`tests/update-publish-journey.test.ts` proves that with a download.)

  // Back on the live tree the same Machine simply continues.
  s.serve(undefined);
  expect(await s.check()).toMatchObject({
    kind: "available",
    version: "1.2.0",
  });

  // The publisher's gate, with the CLIENT's comparison function: the live
  // tree continues every kept generation; an older one continues no newer one.
  for (const generation of [generationA, generationB, generationC])
    expect(await rollbackViolations(directoryTree(generation), s.tree)).toEqual(
      [],
    );
  const backwards = await rollbackViolations(
    directoryTree(generationC),
    directoryTree(generationA),
  );
  expect(
    backwards.map((violation) => [violation.role, violation.rule]),
  ).toEqual([
    ["timestamp", "version"],
    ["snapshot", "version"],
    ["targets.json", "version"],
  ]);
  // It IS the client's function: the first violation is what `violationOf`
  // answers, for the vector this Machine recorded, to a timestamp of version 1.
  expect(backwards[0]).toEqual(
    violationOf(vector, {
      kind: "timestamp",
      version: 1,
      signedSha256: "0".repeat(64),
      snapshot: { version: 1 },
    }),
  );

  // A branch reset to generation A on which the publisher then built "the
  // next version": genuine keys, fresh signatures — and version 2 of snapshot
  // and timestamp, which every Machine has already seen with OTHER content.
  // That is equivocation, and no version check would notice it.
  const reset = join(s.work, "reset");
  await cp(generationA, reset, { recursive: true });
  await s.publisher.refresh(["snapshot"], reset);
  expect(
    (
      await rollbackViolations(directoryTree(generationB), directoryTree(reset))
    ).map((violation) => [violation.role, violation.rule]),
  ).toEqual([
    ["timestamp", "content"],
    ["snapshot", "content"],
    ["targets.json", "version"],
  ]);
  s.serve(reset);
  expect(await s.check()).toMatchObject({
    kind: "error",
    code: "metadata-rollback",
  });
  s.serve(undefined);

  // The command the workflows run before every deployment.
  const status = (against: string, tree: string, extra: string[] = []) =>
    runReleasePublish(
      ["status", "--tree", tree, "--against", against, ...extra],
      { env: {} },
    );
  expect((await status(generationA, generationC)).code).toBe(0);
  expect((await status(generationC, generationA)).code).toBe(exitRollback);
  const gate = await status(generationB, reset, ["--rollback-only"]);
  expect(gate.code).toBe(exitRollback);
  expect(gate.stdout).toContain(
    "ROLLBACK: installed Machines would refuse this tree as `metadata-rollback`",
  );
  expect(gate.stdout).toContain(
    "- timestamp: rule content, published 2, offered 2",
  );
  expect(gate.stdout).not.toContain("| role |");
  expect(
    (await status(generationA, generationC, ["--rollback-only"])).stdout,
  ).toBe("Monotonic against the published tree: ok");
  expect(
    JSON.parse((await status(generationC, generationA, ["--json"])).stdout)
      .rollback,
  ).toHaveLength(3);
  // A first deployment has nothing published to contradict.
  const nothing = join(s.work, "nothing");
  await mkdir(nothing);
  expect((await status(nothing, generationA, ["--rollback-only"])).code).toBe(
    0,
  );
}, 60_000);
