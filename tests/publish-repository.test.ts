import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReleaseKeys } from "../scripts/release-keys";
import { exitValidityLow, runReleasePublish } from "../scripts/release-publish";
import { PublishError } from "../src/publish/errors";
import { generateSigner, type Signer } from "../src/publish/keys";
import {
  buildSnapshot,
  buildTargets,
  buildTimestamp,
  parseMetadata,
  type TargetEntry,
  verifiesUnder,
} from "../src/publish/metadata";
import {
  addRelease,
  loadRepository,
  type PublishOptions,
  promote,
  type ReleaseArtifact,
  refresh,
  repositoryStatus,
} from "../src/publish/repository";
import { initialRoot, nextRoot } from "../src/publish/root";
import { applyPlan, directoryTree } from "../src/publish/tree";
import { parseChannelDocument } from "../src/update/channel";

// Every key here is created in memory or in a temporary directory and dies
// with the test. Nothing in this file touches a network.
const day = 86_400_000;
const start = new Date("2026-09-19T10:00:00.000Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function temporary(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function artifact(
  version: string,
  target = "linux-x64",
  url = `https://github.com/example/product/releases/download/v${version}/lazurio-${target}`,
): ReleaseArtifact {
  const bytes = Buffer.from(`executable ${version} ${target}`);
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
    url,
  };
}

async function repository() {
  const directory = await temporary("publish-tree-");
  const tree = directoryTree(directory);
  const signers: Record<"root" | "targets" | "snapshot" | "timestamp", Signer> =
    {
      root: generateSigner(),
      targets: generateSigner(),
      snapshot: generateSigner(),
      timestamp: generateSigner(),
    };
  const root = initialRoot({
    keys: {
      root: [signers.root.key],
      targets: [signers.targets.key],
      snapshot: [signers.snapshot.key],
      timestamp: [signers.timestamp.key],
    },
    rootSigner: signers.root,
    now: start,
  });
  const options = (
    now = start,
    overrides: Partial<PublishOptions> = {},
  ): PublishOptions => ({ signers, now, root, ...overrides });
  const release = async (
    version: string,
    now = start,
    targets = ["linux-x64"],
  ) => {
    const plan = await addRelease(
      tree,
      {
        channel: "preview",
        version,
        notes: `Notes of ${version}`,
        artifacts: targets.map((target) => artifact(version, target)),
      },
      options(now),
    );
    return { plan, written: await applyPlan(directory, plan) };
  };
  const files = async () => {
    const found: Record<string, string> = {};
    const walk = async (relative: string) => {
      for (const entry of await readdir(join(directory, relative), {
        withFileTypes: true,
      })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else found[path] = sha256(await readFile(join(directory, path)));
      }
    };
    await walk("");
    return found;
  };
  return { directory, tree, signers, root, options, release, files };
}

const refusal = async (action: Promise<unknown>) => {
  try {
    await action;
  } catch (error) {
    if (error instanceof PublishError) return error.code;
    throw error;
  }
  return "accepted";
};

test("a release on an empty tree is a consistent snapshot: numbered roles, hash-addressed targets, the timestamp planned and written last", async () => {
  const r = await repository();
  const { plan, written } = await r.release("1.1.0");
  expect(plan.result).toEqual({
    kind: "published",
    channel: "preview",
    version: "1.1.0",
    sequence: 1,
  });
  const release = artifact("1.1.0");
  const paths = plan.writes.map((write) => write.path);
  expect(paths.at(-1)).toBe("metadata/timestamp.json");
  expect(paths.slice(-4)).toEqual([
    "metadata/1.root.json",
    "metadata/1.targets.json",
    "metadata/1.snapshot.json",
    "metadata/timestamp.json",
  ]);
  expect(written).toEqual(paths);
  expect(Object.keys(await r.files()).sort()).toEqual(
    [
      "metadata/1.root.json",
      "metadata/1.snapshot.json",
      "metadata/1.targets.json",
      "metadata/timestamp.json",
      `targets/artifacts/${release.sha256}/${sha256(release.identity)}.identity.json`,
      `targets/channels/${sha256(
        await readFile(
          join(
            r.directory,
            paths.find((path) => path.includes("preview")) as string,
          ),
        ),
      )}.preview.json`,
      `targets/releases/1.1.0/${sha256(Buffer.from("Notes of 1.1.0"))}.notes.md`,
    ].sort(),
  );
  // The executable stays a release asset: its location is part of the SIGNED
  // target, next to its length and digest.
  const loaded = await loadRepository(r.tree);
  const signed =
    loaded?.targets?.metadata.signed.targets[
      `artifacts/${release.sha256}/lazurio`
    ];
  expect(signed?.length).toBe(release.length);
  expect(signed?.hashes.sha256).toBe(release.sha256);
  expect(signed?.custom).toEqual({ url: release.url });
  // Lifetimes of docs/release-cycle.md.
  const status = repositoryStatus(loaded as NonNullable<typeof loaded>, start);
  expect(status.roles.map((role) => [role.role, role.remainingDays])).toEqual([
    ["root", 365],
    ["targets", 90],
    ["snapshot", 30],
    ["timestamp", 7],
  ]);
  expect(status.low).toEqual([]);
});

test("every object a previous generation referenced is retained byte for byte; only the timestamp is replaced", async () => {
  const r = await repository();
  await r.release("1.1.0");
  const before = await r.files();
  const { written } = await r.release("1.2.0", new Date(start.getTime() + day));
  const after = await r.files();
  for (const [path, digest] of Object.entries(before))
    if (path !== "metadata/timestamp.json") expect(after[path]).toBe(digest);
  expect(after["metadata/timestamp.json"]).not.toBe(
    before["metadata/timestamp.json"],
  );
  expect(written).toContain("metadata/2.targets.json");
  expect(written).toContain("metadata/2.snapshot.json");
  expect(written).not.toContain("metadata/1.root.json");
  // The older artifact is still a signed target: `stable` may still select it.
  const targets = (await loadRepository(r.tree))?.targets?.metadata.signed
    .targets;
  expect(Object.keys(targets ?? {})).toContain(
    `artifacts/${artifact("1.1.0").sha256}/lazurio`,
  );
});

test("nothing immutable is rewritten: a plan whose bytes differ is refused as a whole and changes nothing", async () => {
  const r = await repository();
  await r.release("1.1.0");
  const before = await r.files();
  expect(
    await refusal(
      applyPlan(r.directory, {
        writes: [
          { path: "targets/new/file.txt", bytes: Buffer.from("new") },
          { path: "metadata/1.targets.json", bytes: Buffer.from("other") },
          { path: "metadata/timestamp.json", bytes: Buffer.from("later") },
        ],
      }),
    ),
  ).toBe("immutable-conflict");
  expect(await r.files()).toEqual(before);
  // The timestamp must be last, and a path never leaves the tree.
  for (const writes of [
    [
      { path: "metadata/timestamp.json", bytes: Buffer.from("t") },
      { path: "metadata/9.snapshot.json", bytes: Buffer.from("s") },
    ],
    [{ path: "metadata/../../escape", bytes: Buffer.from("x") }],
    [{ path: "elsewhere/file", bytes: Buffer.from("x") }],
  ])
    expect(await refusal(applyPlan(r.directory, { writes }))).toBe(
      "invalid-input",
    );
  expect(await r.files()).toEqual(before);
  // Identical bytes are not a conflict: the same plan can be applied again.
  const again = await r.release("1.1.0");
  expect(again.plan.result.kind).toBe("unchanged");
  expect(again.written).toEqual([]);
  // The same artifact under another signed location, other bytes under a
  // version the channel already reached, an older version, a dropped target.
  const publish = (artifacts: ReleaseArtifact[], version: string) =>
    refusal(
      addRelease(
        r.tree,
        { channel: "preview", version, notes: "", artifacts },
        r.options(),
      ),
    );
  expect(
    await publish(
      [
        {
          ...artifact("1.1.0"),
          url: "https://github.com/example/other/lazurio",
        },
      ],
      "1.1.0",
    ),
  ).toBe("immutable-conflict");
  const other = Buffer.from("other bytes");
  expect(
    await publish(
      [
        {
          ...artifact("1.1.0"),
          sha256: sha256(other),
          length: other.length,
          identity: Buffer.from(
            JSON.stringify({
              ...JSON.parse(artifact("1.1.0").identity.toString()),
              artifactSha256: sha256(other),
              artifactBytes: other.length,
            }),
          ),
        },
      ],
      "1.1.0",
    ),
  ).toBe("not-newer");
  expect(await publish([artifact("1.0.9")], "1.0.9")).toBe("not-newer");
  expect(await publish([artifact("1.3.0", "darwin-arm64")], "1.3.0")).toBe(
    "target-dropped",
  );
  // An identity that the client would refuse is never signed.
  expect(await publish([artifact("1.3.0")], "1.4.0")).toBe("invalid-input");
  expect(
    await publish(
      [{ ...artifact("1.3.0"), url: "http://github.com/x" }],
      "1.3.0",
    ),
  ).toBe("invalid-input");
  expect(await r.files()).toEqual(before);
});

test("promotion signs a stable document that names the same digests as preview, for exactly the reviewed version", async () => {
  const r = await repository();
  await r.release("1.1.0", start, ["linux-x64", "darwin-arm64"]);
  expect(
    await refusal(promote(r.tree, { version: "1.0.0" }, r.options())),
  ).toBe("version-mismatch");
  const before = await r.files();
  const plan = await promote(r.tree, { version: "1.1.0" }, r.options());
  const written = await applyPlan(r.directory, plan);
  expect(plan.result).toMatchObject({ kind: "published", channel: "stable" });
  // Promotion adds one document and metadata; no artifact, identity or notes.
  expect(written.filter((path) => path.startsWith("targets/"))).toEqual([
    expect.stringMatching(/^targets\/channels\/[a-f0-9]{64}\.stable\.json$/),
  ]);
  const document = async (channel: "stable" | "preview") => {
    const name = (await readdir(join(r.directory, "targets/channels"))).find(
      (entry) => entry.endsWith(`.${channel}.json`),
    ) as string;
    return parseChannelDocument(
      await readFile(join(r.directory, "targets/channels", name)),
      channel,
    );
  };
  const stable = await document("stable");
  const preview = await document("preview");
  expect(stable.targets).toEqual(preview.targets);
  expect(stable.version).toBe(preview.version);
  expect(stable.sequence).toBe(1);
  for (const [path, digest] of Object.entries(before))
    if (path !== "metadata/timestamp.json")
      expect((await r.files())[path]).toBe(digest);
  // Repeating it is a no-op; a pre-release is never promoted.
  const again = await promote(r.tree, { version: "1.1.0" }, r.options());
  expect(again).toMatchObject({ writes: [], result: { kind: "unchanged" } });
  await r.release("1.2.0-rc.1", start, ["linux-x64", "darwin-arm64"]);
  expect(
    await refusal(promote(r.tree, { version: "1.2.0-rc.1" }, r.options())),
  ).toBe("invalid-input");
});

test("refresh re-signs only snapshot and timestamp, or only the timestamp; targets are untouched", async () => {
  const r = await repository();
  await r.release("1.1.0");
  const later = new Date(start.getTime() + 3 * day);
  const timestampOnly = await refresh(r.tree, ["timestamp"], r.options(later));
  expect(timestampOnly.result.rewritten).toEqual(["metadata/timestamp.json"]);
  await applyPlan(r.directory, timestampOnly);
  const both = await refresh(r.tree, ["snapshot"], r.options(later));
  expect(both.result.rewritten).toEqual([
    "metadata/2.snapshot.json",
    "metadata/timestamp.json",
  ]);
  await applyPlan(r.directory, both);
  const loaded = await loadRepository(r.tree);
  expect(loaded?.targets?.version).toBe(1);
  expect(loaded?.snapshot?.version).toBe(2);
  expect(loaded?.timestamp?.version).toBe(3);
  expect(loaded?.timestamp?.metadata.signed.expires).toBe(
    "2026-09-29T10:00:00Z",
  );
  // The refresh job holds no targets key and never needs one.
  const { targets: _targets, ...freshness } = r.signers;
  const withoutTargets = await refresh(r.tree, ["snapshot"], {
    ...r.options(later),
    signers: freshness,
  });
  expect(withoutTargets.result.rewritten).toHaveLength(2);
  expect(
    await refusal(
      refresh(r.tree, ["targets"], {
        ...r.options(later),
        signers: freshness,
      }),
    ),
  ).toBe("key-missing");
  // A key the root does not name for the role is refused before signing.
  expect(
    await refusal(
      refresh(r.tree, ["timestamp"], {
        ...r.options(later),
        signers: { ...r.signers, timestamp: generateSigner() },
      }),
    ),
  ).toBe("key-unauthorized");
});

test("the tree is storage, not authority: metadata that does not verify under the published root is refused, never adopted and re-signed with the real keys", async () => {
  const r = await repository();
  await r.release("1.1.0");
  await applyPlan(
    r.directory,
    await promote(r.tree, { version: "1.1.0" }, r.options()),
  );
  const before = await r.files();
  const every = async () => [
    await refusal(refresh(r.tree, ["targets"], r.options())),
    await refusal(refresh(r.tree, ["timestamp"], r.options())),
    await refusal(promote(r.tree, { version: "1.1.0" }, r.options())),
    await refusal(
      addRelease(
        r.tree,
        {
          channel: "preview",
          version: "1.2.0",
          notes: "",
          artifacts: [artifact("1.2.0")],
        },
        r.options(),
      ),
    ),
    await refusal(loadRepository(r.tree)),
  ];
  const restore = async () => {
    for (const path of Object.keys(await r.files()))
      if (!(path in before)) await rm(join(r.directory, path));
    await writeFile(
      join(r.directory, "metadata/timestamp.json"),
      timestampBefore,
    );
    expect(await r.files()).toEqual(before);
  };
  const timestampBefore = await readFile(
    join(r.directory, "metadata/timestamp.json"),
  );

  // Somebody who can write to the branch — but holds no real key — publishes
  // a complete generation of their own with one more artifact in it. The next
  // approved run must not launder that entry through the real targets key.
  const forger = {
    targets: generateSigner(),
    snapshot: generateSigner(),
    timestamp: generateSigner(),
  };
  const entries = new Map<string, TargetEntry>();
  const published = (await loadRepository(r.tree))?.targets?.metadata.signed
    .targets;
  for (const [path, file] of Object.entries(published ?? {}))
    entries.set(path, {
      length: file.length,
      sha256: file.hashes.sha256 as string,
    });
  entries.set(`artifacts/${"e".repeat(64)}/lazurio`, {
    length: 1,
    sha256: "e".repeat(64),
    custom: { url: "https://github.com/attacker/x/releases/download/v9/x" },
  });
  const expires = "2030-01-01T00:00:00Z";
  const forge = async (signers: typeof forger) => {
    const targets = buildTargets({
      version: 3,
      expires,
      targets: entries,
      signer: signers.targets,
    });
    const snapshot = buildSnapshot({
      version: 3,
      expires,
      targetsVersion: 3,
      targetsBytes: targets,
      signer: signers.snapshot,
    });
    const timestamp = buildTimestamp({
      version: 3,
      expires,
      snapshotVersion: 3,
      snapshotBytes: snapshot,
      signer: signers.timestamp,
    });
    await writeFile(join(r.directory, "metadata/3.targets.json"), targets);
    await writeFile(join(r.directory, "metadata/3.snapshot.json"), snapshot);
    await writeFile(join(r.directory, "metadata/timestamp.json"), timestamp);
  };
  await forge(forger);
  expect(new Set(await every())).toEqual(new Set(["repository-invalid"]));
  await restore();
  // The holder of the REAL snapshot and timestamp keys (the daily job) still
  // cannot add a target: targets metadata needs the targets key.
  await forge({
    ...forger,
    snapshot: r.signers.snapshot,
    timestamp: r.signers.timestamp,
  });
  expect(new Set(await every())).toEqual(new Set(["repository-invalid"]));
  await restore();
  // … and pointing the timestamp back at an older, genuine state is noticed:
  // numbered metadata above what the timestamp references is never ignored.
  const first = parseMetadata(
    "snapshot",
    await readFile(join(r.directory, "metadata/1.snapshot.json")),
  );
  expect(first.signed.version).toBe(1);
  await writeFile(
    join(r.directory, "metadata/timestamp.json"),
    buildTimestamp({
      version: 9,
      expires,
      snapshotVersion: 1,
      snapshotBytes: await readFile(
        join(r.directory, "metadata/1.snapshot.json"),
      ),
      signer: r.signers.timestamp,
    }),
  );
  expect(new Set(await every())).toEqual(new Set(["repository-invalid"]));
  await restore();
  // The leftover of an interrupted local run is the same case: a person
  // removes it; the publisher never guesses.
  await writeFile(join(r.directory, "metadata/3.snapshot.json"), "leftover");
  expect(new Set(await every())).toEqual(new Set(["repository-invalid"]));
  await restore();
  expect(new Set(await every())).not.toContain("repository-invalid");
});

test("status reports the remaining validity of every role and the command exits non-zero below a margin", async () => {
  const r = await repository();
  await r.release("1.1.0");
  const loaded = (await loadRepository(r.tree)) as NonNullable<
    Awaited<ReturnType<typeof loadRepository>>
  >;
  const at = (days: number) => new Date(start.getTime() + days * day);
  expect(repositoryStatus(loaded, at(1)).low).toEqual([]);
  expect(repositoryStatus(loaded, at(2.5)).low).toEqual(["timestamp"]);
  expect(repositoryStatus(loaded, at(11)).low).toEqual([
    "snapshot",
    "timestamp",
  ]);
  expect(repositoryStatus(loaded, at(61)).low).toEqual([
    "targets",
    "snapshot",
    "timestamp",
  ]);
  expect(repositoryStatus(loaded, at(306)).low).toContain("root");
  expect(repositoryStatus(loaded, at(2.5), { timestamp: 1 }).low).toEqual([]);

  const run = (args: string[], days: number) =>
    runReleasePublish([...args, "--tree", r.directory], {
      env: {},
      now: () => at(days),
    });
  expect((await run(["status"], 1)).code).toBe(0);
  const low = await run(["status"], 61);
  expect(low.code).toBe(exitValidityLow);
  expect(low.stdout).toContain("| targets | 1 |");
  expect(low.stdout).toContain("Below margin: targets, snapshot, timestamp");
  expect(JSON.parse((await run(["status", "--json"], 61)).stdout).low).toEqual([
    "targets",
    "snapshot",
    "timestamp",
  ]);
  // `--when-low` without any key is fine while nothing is low …
  expect(await run(["refresh", "--when-low"], 1)).toMatchObject({
    code: 0,
    stdout: "nothing to renew",
  });
  // … and names the missing key, never anything else, when it has to sign.
  expect(await run(["refresh", "--when-low"], 2.5)).toMatchObject({
    code: 1,
    stderr: "Refused: key-missing (timestamp)",
  });
});

test("a rotated root is signed by the outgoing and the incoming key, continues the chain, and forces re-signing of exactly the roles whose key changed", async () => {
  const r = await repository();
  await r.release("1.1.0");
  const incoming = generateSigner();
  const targets = generateSigner();
  const keys = {
    root: [incoming.key],
    targets: [targets.key],
    snapshot: [r.signers.snapshot.key],
    timestamp: [r.signers.timestamp.key],
  };
  // Without the outgoing key no installation would accept it.
  expect(() =>
    nextRoot({ current: r.root, keys, rootSigners: [incoming], now: start }),
  ).toThrow(PublishError);
  expect(() =>
    nextRoot({
      current: r.root,
      keys,
      rootSigners: [r.signers.root],
      now: start,
    }),
  ).toThrow(PublishError);
  const second = nextRoot({
    current: r.root,
    keys,
    rootSigners: [r.signers.root, incoming],
    now: start,
  });
  const first = parseMetadata("root", r.root);
  const next = parseMetadata("root", second);
  expect(next.signed.version).toBe(2);
  expect(verifiesUnder(first, "root", next)).toBe(true);
  expect(verifiesUnder(next, "root", next)).toBe(true);

  // The old targets key is no longer authorized; the new one re-signs.
  expect(
    await refusal(refresh(r.tree, [], r.options(start, { root: second }))),
  ).toBe("key-unauthorized");
  const plan = await refresh(r.tree, [], {
    ...r.options(start, { root: second }),
    signers: { ...r.signers, targets },
  });
  expect(plan.result.rewritten).toEqual([
    "metadata/2.root.json",
    "metadata/2.targets.json",
    "metadata/2.snapshot.json",
    "metadata/timestamp.json",
  ]);
  await applyPlan(r.directory, plan);
  const loaded = await loadRepository(r.tree);
  expect(loaded?.roots.map((root) => root.version)).toEqual([1, 2]);
  // A root that skips a version, or other bytes under a published version.
  const third = nextRoot({
    current: second,
    keys,
    rootSigners: [incoming],
    now: start,
  });
  const fourth = nextRoot({
    current: third,
    keys,
    rootSigners: [incoming],
    now: start,
  });
  const resign = (root: Buffer) =>
    refusal(
      refresh(r.tree, [], {
        ...r.options(start, { root }),
        signers: { ...r.signers, targets },
      }),
    );
  expect(await resign(fourth)).toBe("root-chain");
  expect(await resign(second)).toBe("accepted");
  // A release tag from before the rotation still carries root 1: a no-op.
  expect(await resign(r.root)).toBe("accepted");
  const forged = initialRoot({
    keys,
    rootSigner: incoming,
    now: new Date(start.getTime() + day),
  });
  expect(await resign(forged)).toBe("root-chain");
  // An empty tree without a root is refused, never invented.
  const empty = await temporary("publish-empty-");
  expect(
    await refusal(
      addRelease(
        directoryTree(empty),
        {
          channel: "preview",
          version: "1.0.0",
          notes: "",
          artifacts: [artifact("1.0.0")],
        },
        { signers: r.signers, now: start },
      ),
    ),
  ).toBe("root-missing");
});

test("the key tool writes a 0600 private key outside any repository, builds and rotates the root, and never prints key material", async () => {
  const keys = await temporary("release-keys-");
  const outputs: string[] = [];
  const run = async (args: string[]) => {
    const output = await runReleaseKeys(args, () => start);
    outputs.push(output.stdout, output.stderr);
    return output;
  };
  for (const role of ["root", "targets", "snapshot", "timestamp"])
    expect((await run(["generate", "--role", role, "--out", keys])).code).toBe(
      0,
    );
  expect((await stat(join(keys, "root.private.pem"))).mode & 0o777).toBe(0o600);
  // Never overwritten, never inside a repository, never an unknown role.
  expect((await run(["generate", "--role", "root", "--out", keys])).code).toBe(
    1,
  );
  expect(
    await run([
      "generate",
      "--role",
      "root",
      "--out",
      join(import.meta.dir, "generated-keys"),
    ]),
  ).toMatchObject({
    code: 1,
    stderr:
      "Refused: invalid-input: keys are never generated inside a repository",
  });
  expect((await run(["generate", "--role", "admin", "--out", keys])).code).toBe(
    1,
  );

  const release = join(keys, "release");
  await mkdir(release);
  const rootFile = join(release, "root.json");
  const publics = ["targets", "snapshot", "timestamp"].flatMap((role) => [
    `--${role}`,
    join(keys, `${role}.public.json`),
  ]);
  expect(
    (
      await run([
        "init-root",
        "--root-key",
        join(keys, "root.private.pem"),
        ...publics,
        "--out",
        rootFile,
      ])
    ).code,
  ).toBe(0);
  const first = await readFile(rootFile);
  const parsed = parseMetadata("root", first);
  expect(parsed.signed.version).toBe(1);
  expect(parsed.signed.expires).toBe("2027-09-19T10:00:00Z");
  expect(parsed.signed.consistentSnapshot).toBe(true);
  for (const role of ["root", "targets", "snapshot", "timestamp"])
    expect(parsed.signed.roles[role]?.threshold).toBe(1);
  // A world-readable private key is refused.
  const loose = join(keys, "loose.pem");
  await writeFile(loose, await readFile(join(keys, "root.private.pem")), {
    mode: 0o644,
  });
  expect(
    (
      await run([
        "init-root",
        "--root-key",
        loose,
        ...publics,
        "--out",
        join(release, "other.json"),
      ])
    ).code,
  ).toBe(1);

  // Rotate the root key in place; the published chain accepts the result.
  const next = await temporary("release-keys-next-");
  await run(["generate", "--role", "root", "--out", next]);
  expect(
    (
      await run([
        "rotate-root",
        "--current",
        rootFile,
        "--root-key",
        join(keys, "root.private.pem"),
        "--new-root-key",
        join(next, "root.private.pem"),
        "--out",
        rootFile,
      ])
    ).code,
  ).toBe(0);
  const second = parseMetadata("root", await readFile(rootFile));
  expect(second.signed.version).toBe(2);
  expect(verifiesUnder(parsed, "root", second)).toBe(true);
  expect(second.signed.roles.targets?.keyIDs).toEqual(
    parsed.signed.roles.targets?.keyIDs,
  );

  const everything = outputs.join("\n");
  expect(everything).not.toContain("PRIVATE KEY");
  for (const role of ["root", "targets", "snapshot", "timestamp"]) {
    const pem = await readFile(join(keys, `${role}.private.pem`), "utf8");
    const body = pem.split("\n")[1] as string;
    expect(body.length).toBeGreaterThan(40);
    expect(everything).not.toContain(body);
  }
});

test("the tree branch is append-only: one commit per deployment, a rewritten or removed file stops the push", async () => {
  const r = await repository();
  const work = await temporary("publish-branch-");
  const remote = join(work, "remote.git");
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  expect(git(["init", "--bare", "--quiet", remote]).exitCode).toBe(0);
  const script = join(import.meta.dir, "../scripts/update-tree.sh");
  const tool = (args: string[], from = remote) => {
    const result = Bun.spawnSync(["bash", script, ...args], {
      env: { PATH: process.env.PATH ?? "", UPDATE_TREE_REMOTE: from },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, stdout: result.stdout.toString() };
  };
  const commits = () =>
    git(["-C", remote, "rev-list", "--count", "gh-pages"])
      .stdout.toString()
      .trim();
  // A remote that cannot be read is an error, never "nothing published yet":
  // that reading would let the daily refresh go green while metadata lapses.
  expect(
    tool(["checkout", join(work, "unreachable")], join(work, "absent.git"))
      .code,
  ).toBe(1);
  // First run: no branch yet. The publisher writes into the checkout.
  const first = join(work, "first");
  expect(tool(["checkout", first]).code).toBe(0);
  const plan = await addRelease(
    directoryTree(first),
    {
      channel: "preview",
      version: "1.1.0",
      notes: "",
      artifacts: [artifact("1.1.0")],
    },
    r.options(),
  );
  await applyPlan(first, plan);
  expect(tool(["push", first, "Release 1.1.0 to preview"]).code).toBe(0);
  expect(commits()).toBe("1");
  // Nothing changed: nothing is pushed.
  expect(tool(["push", first, "again"]).stdout).toContain("Nothing changed");
  expect(commits()).toBe("1");
  // A later run starts from what is published and appends to it.
  const second = join(work, "second");
  expect(tool(["checkout", second]).code).toBe(0);
  expect((await loadRepository(directoryTree(second)))?.targets?.version).toBe(
    1,
  );
  await applyPlan(
    second,
    await refresh(directoryTree(second), ["snapshot"], r.options()),
  );
  expect(tool(["push", second, "Refresh update metadata"]).code).toBe(0);
  expect(commits()).toBe("2");
  // Whatever produced it, a changed or deleted published file never leaves.
  await writeFile(join(second, "metadata/1.targets.json"), "rewritten");
  expect(tool(["push", second, "rewrite"]).code).toBe(1);
  git(["-C", second, "reset", "--quiet", "--hard"]);
  await rm(join(second, "metadata/1.snapshot.json"));
  expect(tool(["push", second, "remove"]).code).toBe(1);
  expect(commits()).toBe("2");
});
