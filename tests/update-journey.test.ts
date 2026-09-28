import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { releaseClaims } from "../scripts/update-fixture";
import {
  createAttestationVerifier,
  sigstoreTrustedRoot,
} from "../src/update/attestation";
import { productOrigin } from "../src/update/identity";
import { readLastCheck } from "../src/update/last-check";
import { layout, readHighWater, readSelector } from "../src/update/layout";
import { type ProcessRunner, runProcess } from "../src/update/self-check";
import {
  checkForUpdate,
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
    folderRefresh: null,
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
    highWater: "1.1.0",
    // Only the active version is kept: there is no way back to keep one for.
    versions: ["1.1.0"],
    // No marker and no scratch left.
    update: ["high-water", "last-check.json", "lock"],
  });
  const staged = await stat(join(world.base, "versions/1.1.0/lazurio"));
  expect(staged.mode & 0o777).toBe(0o500);
  expect(await readLastCheck(world.base)).toEqual({
    checkedAt: "2026-09-19T10:00:00.000Z",
    latest: "1.1.0",
    notesUrl: "https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.0",
  });

  // The new version, asked again, is up to date; a third version prunes
  // everything but itself.
  expect(await performUpdate(world.environment("1.1.0"))).toEqual({
    kind: "up-to-date",
    running: "1.1.0",
    latest: "1.1.0",
    folderRefresh: null,
  });
  await world.release("1.2.0");
  expect((await performUpdate(world.environment("1.1.0"))).kind).toBe(
    "updated",
  );
  expect((await disk(world.base)).versions).toEqual(["1.2.0"]);
});

test("the floor: no network path goes below the high-water mark; an installation an older release rolled back may return to its mark", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  await world.release("1.2.0");
  // What a rollback under v0.1.x left: the selector below the mark.
  await writeFile(layout(world.base).highWater, "1.2.0\n");
  expect(await disk(world.base)).toMatchObject({
    active: "1.0.0",
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
  // Equal to the mark and not active: forward to the mark again.
  expect(await performUpdate(environment, "1.2.0")).toMatchObject({
    kind: "updated",
    to: "1.2.0",
  });
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
  // So is an attested release whose artifact is another version's executable
  // (the impostor release of the native qualification bundle, journey 8d):
  // verified and downloaded, then refused by name, and nothing is switched.
  await world.release("1.3.0", {
    artifacts: { [target]: executable("1.2.0") },
  });
  expect(
    await performUpdate(world.environment("1.0.0"), "1.3.0"),
  ).toMatchObject({
    code: "self-check-failed",
    context: { reason: "identity-mismatch" },
  });
  await unchanged(failed, "self-check-failed");
});

/** Every entry under the base with its bytes or link target: what "changed
 * nothing" means, byte for byte. The check's own cache is not the base. */
async function tree(directory: string, prefix = ""): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    if (name === "update/last-check.json") continue;
    if (entry.isSymbolicLink())
      entries.push(`${name} -> ${await readlink(path)}`);
    else if (entry.isDirectory())
      entries.push(...(await tree(path, `${name}/`)));
    else
      entries.push(
        `${name} ${(await stat(path)).mode.toString(8)} ${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`,
      );
  }
  return entries;
}

/** A process runner that records every command and really runs it. */
function recordingRunner() {
  const commands: string[][] = [];
  const run: ProcessRunner = (command, timeoutMs, env) => {
    commands.push([...command]);
    return runProcess(command, timeoutMs, env);
  };
  return { commands, run };
}

test("supervised: self-check and Launchpad probe, switch, restart, health at the new version", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const service = fakeService(world.base, { folder: "/nonexistent/Folder" });
  const { commands, run } = recordingRunner();
  expect(
    await performUpdate(world.environment("1.0.0", { service, run })),
  ).toEqual({
    kind: "updated",
    from: "1.0.0",
    to: "1.1.0",
    restartRequired: false,
    folderRefresh: null,
  });
  // The candidate ran its Launchpad probe against the unit's Folder BEFORE
  // the switch: the point of no return is the switch, never after it.
  expect(commands).toEqual([
    [
      join(world.base, "versions/1.1.0/lazurio"),
      "self-check",
      "--json",
      "--base",
      world.base,
      "--folder",
      "/nonexistent/Folder",
      "--launchpad",
    ],
  ]);
  expect(service).toMatchObject({ restarts: 1, running: "1.1.0" });
  expect(await disk(world.base)).toMatchObject({
    active: "1.1.0",
    highWater: "1.1.0",
    versions: ["1.1.0"],
    update: ["high-water", "last-check.json", "lock"],
  });
});

test("a candidate whose Launchpad fails to start is removed, and the active version is unchanged byte for byte", async () => {
  world = await createWorld();
  await world.release("1.1.0", { launchpadRefused: "folder-state-unreadable" });
  const service = fakeService(world.base, { folder: "/nonexistent/Folder" });
  service.running = "1.0.0";
  const before = await tree(world.base);
  expect(await performUpdate(world.environment("1.0.0", { service }))).toEqual({
    kind: "error",
    code: "self-check-failed",
    context: {
      reason: "launchpad-refused",
      refusal: "folder-state-unreadable",
    },
  });
  // Nothing was switched, restarted or left behind: the base is exactly as
  // it was, and the running Launchpad was never touched.
  expect(await tree(world.base)).toEqual(before);
  expect(service).toMatchObject({ restarts: 0, running: "1.0.0" });
  // Unsupervised there is no Launchpad to probe: nothing names a Folder.
  expect((await performUpdate(world.environment("1.0.0"))).kind).toBe(
    "updated",
  );
});

test("supervised: a version whose Launchpad never reports healthy stays active — activation-unhealthy, nothing undone, repaired forward", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const service = fakeService(world.base, { unhealthy: ["1.1.0"] });
  const environment = world.environment("1.0.0", {
    service,
    healthDeadlineMs: 300,
  });
  expect(await performUpdate(environment)).toEqual({
    kind: "error",
    code: "activation-unhealthy",
    context: { from: "1.0.0", to: "1.1.0" },
  });
  // One restart, of the new version; no switch back.
  expect(service).toMatchObject({ restarts: 1, running: "1.1.0" });
  expect(await disk(world.base)).toMatchObject({
    active: "1.1.0",
    highWater: "1.1.0",
    versions: ["1.1.0"],
    update: ["high-water", "last-check.json", "lock"],
  });
  expect(await readStatus(environment)).toMatchObject({
    active: "1.1.0",
    updateAvailable: false,
    legacyRollbackState: false,
  });
  // Nothing goes below the active version, not even by name …
  await world.release("1.0.0", { latest: false });
  expect(
    await performUpdate(world.environment("1.1.0", { service }), "1.0.0"),
  ).toMatchObject({
    code: "release-invalid",
    context: { reason: "below-floor" },
  });
  // … and a fixed release is the repair.
  await world.release("1.1.1");
  expect(
    await performUpdate(world.environment("1.1.0", { service })),
  ).toMatchObject({ kind: "updated", from: "1.1.0", to: "1.1.1" });
  expect(service.running).toBe("1.1.1");
});

test("status is computed from the paths: versions, the mark and the age of the last verified check", async () => {
  world = await createWorld();
  expect(await readStatus(world.environment("1.0.0"))).toEqual({
    kind: "status",
    running: "1.0.0",
    active: "1.0.0",
    highWater: null,
    supervised: false,
    legacyRollbackState: false,
    stateInvalid: null,
    lastCheck: null,
    updateAvailable: false,
    folderRefresh: null,
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
  ])
    expect(result).toMatchObject({ kind: "error", code: "not-installed" });
  expect(await readdir(world.root)).not.toContain("absent-base");
});
