import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFixtureSigstore,
  type FixtureRelease,
  type FixtureSigstore,
  writeFixtureRelease,
} from "../../scripts/update-fixture";
import {
  createFixtureOrigin,
  type FixtureOrigin,
} from "../../scripts/update-fixture-server";
import {
  createAttestationVerifier,
  fixtureTrustedRoot,
} from "../../src/update/attestation";
import { nativeTarget, productOrigin } from "../../src/update/identity";
import { performInstall } from "../../src/update/install";
import { readSelector } from "../../src/update/layout";
import type { ServiceControl } from "../../src/update/service-control";
import type { UpdateEnvironment } from "../../src/update/update";

/** One temporary world per test: a signed fixture origin on loopback, an
 * install base, and "executables" that are real shell scripts answering
 * `self-check --json` — so staging runs a real process by its real path.
 */
export const target = nativeTarget(process.platform, process.arch);
export const commitOf = (version: string) =>
  Buffer.from(version).toString("hex").padEnd(40, "0").slice(0, 40);

/** `healthy: false` is a version whose self-check fails. */
export function executable(
  version: string,
  options: Readonly<{ healthy?: boolean; commit?: string }> = {},
): Uint8Array {
  const report = JSON.stringify({
    schemaVersion: 1,
    identity: { version, commit: options.commit ?? commitOf(version), target },
    fixture: false,
    base: { active: null, previous: null, highWater: null },
    folder: { preferences: 1, manifest: 1 },
  });
  return new TextEncoder().encode(
    `#!/bin/sh\n${options.healthy === false ? "exit 1\n" : ""}echo '${report}'\n`,
  );
}

export type World = Readonly<{
  root: string;
  base: string;
  tree: string;
  origin: FixtureOrigin;
  release(
    version: string,
    options?: Partial<FixtureRelease> & { latest?: boolean; healthy?: boolean },
  ): Promise<void>;
  environment(
    running: string,
    overrides?: Partial<UpdateEnvironment>,
  ): UpdateEnvironment;
  close(): Promise<void>;
}>;

let sigstore: Promise<FixtureSigstore> | undefined;
/** One throwaway Sigstore per test file is enough; its keys are in memory. */
export const sharedSigstore = () => {
  sigstore ??= createFixtureSigstore();
  return sigstore;
};
export async function closeSharedSigstore() {
  await (await sigstore)?.close();
  sigstore = undefined;
}

export async function createWorld(
  options: Readonly<{
    installed?: string;
    intercept?: Parameters<typeof createFixtureOrigin>[0]["intercept"];
  }> = {},
): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "upd-")));
  const base = join(root, "base");
  const tree = join(root, "tree");
  await mkdir(tree);
  const signer = await sharedSigstore();
  const rootFile = join(root, "fixture-trusted-root.json");
  await writeFile(rootFile, signer.trustedRoot);
  const origin = createFixtureOrigin({
    tree,
    ...(options.intercept ? { intercept: options.intercept } : {}),
  });
  const installed = options.installed ?? "1.0.0";
  const source = join(root, "downloaded-lazurio");
  await writeFile(source, executable(installed), { mode: 0o700 });
  const result = await performInstall({
    base,
    executable: source,
    identity: { version: installed, commit: commitOf(installed), target },
    platform: process.platform,
    env: {},
  });
  if (result.kind !== "installed" || (await readSelector(base)) !== installed)
    throw new Error("Fixture installation failed");
  return Object.freeze({
    root,
    base,
    tree,
    origin,
    release: (version, release = {}) =>
      writeFixtureRelease(
        tree,
        signer,
        {
          version,
          commit: commitOf(version),
          artifacts: {
            [target]: executable(
              version,
              release.healthy === false ? { healthy: false } : {},
            ),
          },
          ...release,
        },
        { latest: release.latest ?? true },
      ),
    environment: (running, overrides = {}) =>
      Object.freeze({
        base,
        identity: { version: running, commit: commitOf(running), target },
        origin: { ...productOrigin, baseUrl: origin.baseUrl },
        fetcher: (url, init) => fetch(url, init),
        verify: createAttestationVerifier(
          productOrigin,
          fixtureTrustedRoot(rootFile),
        ),
        service: null,
        ...overrides,
      }),
    async close() {
      await origin.close();
      await rm(root, { recursive: true, force: true });
    },
  });
}

/** A systemd stand-in: a restart "starts" whatever the selector names, and the
 * Launchpad reports that version unless it is listed as unhealthy.
 */
export function fakeService(
  base: string,
  options: { unhealthy?: readonly string[]; folder?: string } = {},
): ServiceControl & { restarts: number; running: string | null } {
  const service = {
    folder: options.folder,
    restarts: 0,
    running: null as string | null,
    async restartLaunchpad() {
      service.restarts++;
      service.running = await readSelector(base);
    },
    async launchpadVersion() {
      return service.running !== null &&
        !(options.unhealthy ?? []).includes(service.running)
        ? service.running
        : null;
    },
  };
  return service;
}
