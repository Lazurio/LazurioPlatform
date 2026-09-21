import { afterAll, afterEach, expect, test } from "bun:test";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { releaseClaims } from "../scripts/update-fixture";
import {
  createAttestationVerifier,
  sigstoreTrustedRoot,
} from "../src/update/attestation";
import { productOrigin } from "../src/update/identity";
import { readLastCheck } from "../src/update/last-check";
import {
  layout,
  readHighWater,
  readPrevious,
  readSelector,
} from "../src/update/layout";
import {
  checkForUpdate,
  performRollback,
  performUpdate,
  readStatus,
} from "../src/update/update";
import {
  closeSharedSigstore,
  commitOf,
  createWorld,
  executable,
  fakeService,
  target,
  type World,
} from "./fixtures/update-world";

// Behaviour against a signed fixture origin on loopback (docs/update.md
// "Evidence required"). The attestation of every release is verified by the
// real sigstore-js verifier; nothing here touches the network.
let world: World;
afterEach(async () => world?.close());
afterAll(closeSharedSigstore);

const disk = async (base: string) => ({
  active: await readSelector(base),
  previous: await readPrevious(base),
  highWater: await readHighWater(base),
  versions: (await readdir(layout(base).versions)).sort(),
  update: (await readdir(layout(base).update)).sort(),
});
const artifactRequests = () =>
  world.origin.requests.filter((path) => path.includes("/lazurio-"));

test("forward update: check, verify, download, self-check, switch; the switch is the commit", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const environment = world.environment("1.0.0", {
    now: () => new Date("2026-09-19T10:00:00.000Z"),
  });
  expect(await checkForUpdate(environment)).toEqual({
    kind: "available",
    running: "1.0.0",
    latest: "1.1.0",
    notesUrl: "https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.0",
  });
  // A check downloads no artifact and changes nothing but its cache.
  expect(artifactRequests()).toEqual([]);
  expect((await disk(world.base)).active).toBe("1.0.0");

  expect(await performUpdate(environment)).toEqual({
    kind: "updated",
    from: "1.0.0",
    to: "1.1.0",
    restartRequired: true,
  });
  // `latest` was asked only for the tag; everything else came by exact tag.
  expect(
    world.origin.requests.filter((path) => path.includes("/latest/")),
  ).toEqual([
    "/releases/latest/download/manifest.json",
    "/releases/latest/download/manifest.json",
  ]);
  expect(artifactRequests()).toEqual([
    `/releases/download/v1.1.0/lazurio-${target}`,
    `/storage/v1.1.0/lazurio-${target}`,
  ]);
  expect(await disk(world.base)).toEqual({
    active: "1.1.0",
    previous: "1.0.0",
    highWater: "1.1.0",
    versions: ["1.0.0", "1.1.0"],
    // No marker on an unsupervised installation, and no scratch left.
    update: ["high-water", "last-check.json", "lock"],
  });
  const staged = await stat(join(world.base, "versions/1.1.0/lazurio"));
  expect(staged.mode & 0o777).toBe(0o500);
  expect(await readLastCheck(world.base)).toEqual({
    checkedAt: "2026-09-19T10:00:00.000Z",
    latest: "1.1.0",
    notesUrl: "https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.0",
  });

  // The new version, asked again, is up to date; a third version prunes the
  // oldest: the active and the previous one are kept.
  expect(await performUpdate(world.environment("1.1.0"))).toEqual({
    kind: "up-to-date",
    running: "1.1.0",
    latest: "1.1.0",
  });
  await world.release("1.2.0");
  expect((await performUpdate(world.environment("1.1.0"))).kind).toBe(
    "updated",
  );
  expect((await disk(world.base)).versions).toEqual(["1.1.0", "1.2.0"]);
});

test("the floor: after a rollback no network path goes below the high-water mark; the equal retry is allowed", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  await world.release("1.2.0");
  expect((await performUpdate(world.environment("1.0.0"))).kind).toBe(
    "updated",
  );
  expect(await performRollback(world.environment("1.2.0"))).toEqual({
    kind: "rolled-back",
    from: "1.2.0",
    to: "1.0.0",
  });
  expect(await disk(world.base)).toMatchObject({
    active: "1.0.0",
    previous: "1.2.0",
    highWater: "1.2.0",
  });
  // `latest` now answers with an older release, as a hostile network could.
  await writeFile(join(world.tree, "latest"), "v1.1.0");
  const environment = world.environment("1.0.0");
  expect((await checkForUpdate(environment)).kind).toBe("up-to-date");
  expect((await performUpdate(environment)).kind).toBe("up-to-date");
  // Named exactly, the refusal is named too.
  const refused = await performUpdate(environment, "1.1.0");
  expect(refused).toMatchObject({
    kind: "error",
    code: "release-invalid",
    context: { resource: "version", reason: "below-floor" },
  });
  expect(artifactRequests().filter((path) => path.includes("v1.1.0"))).toEqual(
    [],
  );
  expect((await disk(world.base)).active).toBe("1.0.0");
  // Equal to the mark and not active: the retry after the rollback.
  expect(await performUpdate(environment, "1.2.0")).toMatchObject({
    kind: "updated",
    to: "1.2.0",
  });
  // The staged bytes were re-established, not downloaded a second time.
  expect(
    artifactRequests().filter((path) => path.startsWith("/storage/v1.2.0")),
  ).toHaveLength(1);
});

test("an exact version is a canary: a prerelease is invisible to latest and reached by name", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  await world.release("2.0.0-rc.1", { latest: false });
  expect(await checkForUpdate(world.environment("1.0.0"))).toMatchObject({
    kind: "available",
    latest: "1.1.0",
  });
  expect(
    await performUpdate(world.environment("1.0.0"), "2.0.0-rc.1"),
  ).toMatchObject({ kind: "updated", to: "2.0.0-rc.1" });
  // It follows that line: the older final is below its floor.
  expect((await checkForUpdate(world.environment("2.0.0-rc.1"))).kind).toBe(
    "up-to-date",
  );
  // An exact check does not feed the pill.
  expect((await readLastCheck(world.base))?.latest).toBe("1.1.0");
  expect(
    await performUpdate(world.environment("2.0.0-rc.1"), "9.9.9"),
  ).toMatchObject({
    code: "release-invalid",
    context: { reason: "not-found" },
  });
});

const unchanged = async (result: unknown, code: string) => {
  expect(result).toMatchObject({ kind: "error", code });
  expect(await disk(world.base)).toMatchObject({
    active: "1.0.0",
    previous: null,
    highWater: null,
    versions: ["1.0.0"],
  });
  // The same action works once the outside condition is restored.
  await world.release("1.5.0");
  expect((await performUpdate(world.environment("1.0.0"))).kind).toBe(
    "updated",
  );
};

test("a manifest of another version than the tag is refused", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  await world.release("1.2.0");
  // v1.2.0 serves the (validly attested) manifest of 1.1.0.
  await writeFile(
    join(world.tree, "v1.2.0/manifest.json"),
    await readFile(join(world.tree, "v1.1.0/manifest.json")),
  );
  const result = await performUpdate(world.environment("1.0.0"));
  expect(result).toMatchObject({ context: { reason: "tag-mismatch" } });
  await unchanged(result, "release-invalid");
});

test("an attestation of another workflow, repository or commit is refused", async () => {
  const release = releaseClaims("1.1.0", commitOf("1.1.0"));
  for (const claims of [
    { identity: release.identity.replace("release.yml", "build.yml") },
    { repositoryId: "42" },
    { ownerId: "42" },
    { commit: "f".repeat(40) },
  ]) {
    world = await createWorld();
    await world.release("1.1.0", { claims });
    await unchanged(
      await performUpdate(world.environment("1.0.0")),
      "attestation-invalid",
    );
    expect(
      artifactRequests().filter((path) => path.includes("v1.1.0")),
    ).toEqual([]);
    await world.close();
  }
  world = await createWorld();
});

test("a tampered artifact and a tampered manifest are refused", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const artifact = join(world.tree, `v1.1.0/lazurio-${target}`);
  const tampered = executable("1.1.0", { commit: "e".repeat(40) });
  const original = await readFile(artifact);
  await writeFile(artifact, tampered.slice(0, original.byteLength));
  const bytes = await performUpdate(world.environment("1.0.0"));
  expect(bytes).toMatchObject({
    code: "release-invalid",
    context: { resource: "artifact" },
  });
  expect((await disk(world.base)).versions).toEqual(["1.0.0"]);

  // A manifest rewritten to describe the tampered bytes is not the attested one.
  const manifestFile = join(world.tree, "v1.1.0/manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.targets[target].sha256 = "0".repeat(64);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await unchanged(
    await performUpdate(world.environment("1.0.0")),
    "attestation-invalid",
  );
});

test("the tag comes from the FIRST redirect of latest; assets are followed into storage on another host", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  // GitHub's shape: latest -> the exact-tag URL of the origin -> signed asset
  // storage elsewhere, whose URL names neither the repository nor the tag.
  expect(new URL(world.origin.storageUrl).port).not.toBe(
    new URL(world.origin.baseUrl).port,
  );
  const hops: string[] = [];
  const result = await performUpdate(
    world.environment("1.0.0", {
      fetcher: (url, init) => {
        hops.push(url);
        return fetch(url, init);
      },
    }),
  );
  expect(result).toMatchObject({ kind: "updated", to: "1.1.0" });
  const storage = hops.filter((url) => url.startsWith(world.origin.storageUrl));
  expect(storage).toHaveLength(3); // manifest, bundle, artifact
  for (const url of storage) expect(url).not.toMatch(/v1\.1\.0|releases/);
  expect(hops[0]).toBe(
    `${world.origin.baseUrl}/releases/latest/download/manifest.json`,
  );
  // `latest` itself is never followed: the next request is the exact tag.
  expect(hops[1]).toBe(
    `${world.origin.baseUrl}/releases/download/v1.1.0/manifest.json`,
  );
});

test("a first redirect that is not a release of the compiled-in origin is refused before anything else is asked", async () => {
  let location: string | null = null;
  world = await createWorld({
    intercept: (path) =>
      path.startsWith("/releases/latest/")
        ? location === null
          ? new Response("a page, not a redirect")
          : new Response(null, { status: 302, headers: { location } })
        : undefined,
  });
  await world.release("1.1.0");
  const base = world.origin.baseUrl;
  const cases: Record<string, [string | null, object]> = {
    "no redirect at all": [
      null,
      {
        code: "network-unavailable",
        context: { reason: "http", httpStatus: 200 },
      },
    ],
    "another repository": [
      `${base.replace("127.0.0.1", "localhost")}/releases/download/v1.1.0/manifest.json`,
      { code: "release-invalid", context: { reason: "redirect" } },
    ],
    "another path of the same host": [
      `${base}/Other/Repository/releases/download/v1.1.0/manifest.json`,
      { code: "release-invalid", context: { reason: "redirect" } },
    ],
    "straight into asset storage": [
      `${world.origin.storageUrl}/release-asset/00?sig=fixture`,
      { code: "release-invalid", context: { reason: "redirect" } },
    ],
    "a tag that is not v<semver>": [
      `${base}/releases/download/nightly/manifest.json`,
      { code: "release-invalid", context: { reason: "redirect" } },
    ],
    "a tag with a path in it": [
      `${base}/releases/download/v1.1.0/x/manifest.json`,
      { code: "release-invalid", context: { reason: "redirect" } },
    ],
    "another asset": [
      `${base}/releases/download/v1.1.0/other.json`,
      { code: "release-invalid", context: { reason: "redirect" } },
    ],
    "plain HTTP elsewhere": [
      "http://example.com/releases/download/v1.1.0/manifest.json",
      { code: "release-invalid", context: { reason: "redirect" } },
    ],
  };
  for (const [name, [first, refusal]] of Object.entries(cases)) {
    location = first;
    const before = world.origin.requests.length;
    const result = await performUpdate(world.environment("1.0.0"));
    expect({ name, result }).toMatchObject({
      name,
      result: { kind: "error", ...refusal },
    });
    // `latest` was the only request.
    expect(world.origin.requests.slice(before)).toEqual([
      "/releases/latest/download/manifest.json",
    ]);
  }
  expect(await readSelector(world.base)).toBe("1.0.0");
});

test("latest moving while an update runs cannot mix two releases", async () => {
  let flipped = false;
  world = await createWorld({
    // The moment the first exact-tag request arrives, `latest` moves on.
    intercept: async (path) => {
      if (path.startsWith("/releases/download/") && !flipped) {
        flipped = true;
        await writeFile(join(world.tree, "latest"), "v1.2.0");
      }
      return undefined;
    },
  });
  await world.release("1.2.0");
  await world.release("1.1.0");
  expect(await performUpdate(world.environment("1.0.0"))).toMatchObject({
    kind: "updated",
    to: "1.1.0",
  });
  expect(
    world.origin.requests.filter((path) => path.includes("v1.2.0")),
  ).toEqual([]);
});

test("a cold Sigstore trust cache offline blocks the update", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const seeds = createRequire(import.meta.url)("@sigstore/tuf/seeds.json");
  const rootPath = join(world.root, "sigstore-root.json");
  await writeFile(
    rootPath,
    Buffer.from(
      seeds["https://tuf-repo-cdn.sigstore.dev"]["root.json"],
      "base64",
    ),
  );
  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  const mirrorURL = `http://127.0.0.1:${closed.port}`;
  await closed.stop(true);
  const result = await performUpdate(
    world.environment("1.0.0", {
      verify: createAttestationVerifier(
        productOrigin,
        sigstoreTrustedRoot(layout(world.base).sigstore, {
          mirrorURL,
          rootPath,
        }),
      ),
    }),
  );
  await unchanged(result, "trust-unavailable");
}, 60_000);

test("a full disk and an unreachable origin are bounded, typed and retryable", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const full = await performUpdate(
    world.environment("1.0.0", { download: { freeBytes: async () => 1024 } }),
  );
  expect(full).toMatchObject({ code: "disk-full" });
  expect((await disk(world.base)).update).toEqual(["last-check.json", "lock"]);

  const offline = await performUpdate(
    world.environment("1.0.0", {
      fetcher: () => Promise.reject(new Error("offline")),
    }),
  );
  expect(offline).toMatchObject({
    code: "network-unavailable",
    context: { resource: "latest", reason: "connection" },
  });
  await unchanged(offline, "network-unavailable");
});

test("concurrent runs: one owns the base, the other is busy and harmless", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  world = await createWorld({
    intercept: async (path) => {
      if (path.startsWith("/storage/") && path.includes("/lazurio-"))
        await held;
      return undefined;
    },
  });
  await world.release("1.1.0");
  const first = performUpdate(world.environment("1.0.0"));
  while (artifactRequests().length < 2) await Bun.sleep(10);
  expect(await performUpdate(world.environment("1.0.0"))).toMatchObject({
    kind: "error",
    code: "busy",
  });
  expect(await performRollback(world.environment("1.0.0"))).toMatchObject({
    code: "busy",
  });
  // A check takes no lock and is never in the way.
  expect((await checkForUpdate(world.environment("1.0.0"))).kind).toBe(
    "available",
  );
  release?.();
  expect((await first).kind).toBe("updated");
});

test("a release that needs a newer updater, or has no artifact for this target, changes nothing", async () => {
  world = await createWorld();
  await world.release("1.1.0", { minimumUpdaterVersion: "1.0.5" });
  expect(await performUpdate(world.environment("1.0.0"))).toMatchObject({
    code: "reinstall-required",
    context: { version: "1.1.0", minimumUpdaterVersion: "1.0.5" },
  });
  expect((await checkForUpdate(world.environment("1.0.0"))).kind).toBe("error");
  await world.release("1.2.0", {
    artifacts: { "plan9-mips": executable("1.2.0") },
  });
  await unchanged(
    await performUpdate(world.environment("1.0.0")),
    "target-unsupported",
  );
});

test("a version that fails its own self-check is never switched to", async () => {
  world = await createWorld();
  await world.release("1.1.0", { healthy: false });
  const failed = await performUpdate(world.environment("1.0.0"));
  expect(failed).toMatchObject({
    code: "self-check-failed",
    context: { reason: "exit", exitCode: 1 },
  });
  // What this run placed is removed again.
  expect((await disk(world.base)).versions).toEqual(["1.0.0"]);
  // A version that reports another commit than the manifest's is refused too.
  await world.release("1.2.0", {
    artifacts: { [target]: executable("1.2.0", { commit: "d".repeat(40) }) },
  });
  expect(await performUpdate(world.environment("1.0.0"))).toMatchObject({
    code: "self-check-failed",
    context: { reason: "identity-mismatch" },
  });
  await unchanged(failed, "self-check-failed");
});

test("supervised: restart, health at the new version, then commit", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const service = fakeService(world.base, { folder: "/nonexistent/Folder" });
  expect(await performUpdate(world.environment("1.0.0", { service }))).toEqual({
    kind: "updated",
    from: "1.0.0",
    to: "1.1.0",
    restartRequired: false,
  });
  expect(service).toMatchObject({ restarts: 1, running: "1.1.0" });
  expect(await disk(world.base)).toMatchObject({
    active: "1.1.0",
    previous: "1.0.0",
    highWater: "1.1.0",
    update: ["high-water", "last-check.json", "lock"],
  });
});

test("supervised: a version that never reports healthy is undone and never raises the mark", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const service = fakeService(world.base, { unhealthy: ["1.1.0"] });
  const environment = world.environment("1.0.0", {
    service,
    healthDeadlineMs: 300,
  });
  expect(await performUpdate(environment)).toMatchObject({
    kind: "error",
    code: "activation-failed",
    context: { from: "1.0.0", to: "1.1.0" },
  });
  // Switched back and restarted: the old version runs again.
  expect(service).toMatchObject({ restarts: 2, running: "1.0.0" });
  expect(await disk(world.base)).toMatchObject({
    active: "1.0.0",
    highWater: null,
    // The verified bytes stay staged for the retry; nothing else remains.
    versions: ["1.0.0", "1.1.0"],
    update: ["last-check.json", "lock"],
  });
  // The pill returns to `available`; the retry is the same action.
  expect(await readStatus(environment)).toMatchObject({
    active: "1.0.0",
    updateAvailable: true,
    pending: null,
  });
  await world.release("1.1.1");
  expect((await performUpdate(environment)).kind).toBe("updated");
});

test("rollback: previous after its own self-check; the version left stays the floor", async () => {
  world = await createWorld();
  expect(await performRollback(world.environment("1.0.0"))).toMatchObject({
    code: "rollback-unavailable",
    context: { reason: "none" },
  });
  await world.release("1.1.0");
  const service = fakeService(world.base);
  await performUpdate(world.environment("1.0.0", { service }));
  // A previous version that can no longer read the state is not an answer.
  const previous = join(world.base, "versions/1.0.0/lazurio");
  const bytes = await readFile(previous);
  await chmod(previous, 0o700);
  await writeFile(previous, executable("1.0.0", { healthy: false }));
  expect(
    await performRollback(world.environment("1.1.0", { service })),
  ).toMatchObject({
    code: "rollback-unavailable",
    context: { reason: "self-check" },
  });
  expect((await disk(world.base)).active).toBe("1.1.0");
  await writeFile(previous, bytes);

  expect(
    await performRollback(world.environment("1.1.0", { service })),
  ).toEqual({ kind: "rolled-back", from: "1.1.0", to: "1.0.0" });
  expect(service.running).toBe("1.0.0");
  expect(await disk(world.base)).toMatchObject({
    active: "1.0.0",
    previous: "1.1.0",
    highWater: "1.1.0",
    update: ["high-water", "last-check.json", "lock"],
  });
  // Rolling "back" again is rolling forward to what was left.
  expect(
    await performRollback(world.environment("1.0.0", { service })),
  ).toMatchObject({ kind: "rolled-back", to: "1.1.0" });
});

test("status is computed from the paths: versions, the mark and the age of the last verified check", async () => {
  world = await createWorld();
  expect(await readStatus(world.environment("1.0.0"))).toEqual({
    kind: "status",
    running: "1.0.0",
    active: "1.0.0",
    previous: null,
    highWater: null,
    supervised: false,
    pending: null,
    stateInvalid: null,
    lastCheck: null,
    updateAvailable: false,
  });
  await world.release("1.1.0");
  await checkForUpdate(
    world.environment("1.0.0", { now: () => new Date("2026-01-02T03:04:05Z") }),
  );
  expect(await readStatus(world.environment("1.0.0"))).toMatchObject({
    lastCheck: { checkedAt: "2026-01-02T03:04:05.000Z", latest: "1.1.0" },
    updateAvailable: true,
  });
  // A disposable cache: garbage only means "never checked".
  await writeFile(layout(world.base).lastCheck, "{");
  expect(await readStatus(world.environment("1.0.0"))).toMatchObject({
    lastCheck: null,
    updateAvailable: false,
  });
});

test("nothing installed: every update command says so and creates no installation", async () => {
  world = await createWorld();
  const environment = {
    ...world.environment("1.0.0"),
    base: join(world.root, "absent-base"),
  };
  for (const result of [
    await checkForUpdate(environment),
    await performUpdate(environment),
    await performRollback(environment),
  ])
    expect(result).toMatchObject({ kind: "error", code: "not-installed" });
  expect(await readdir(world.root)).not.toContain("absent-base");
});
