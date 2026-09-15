import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareInstallLocation,
  resolveInstallLocation,
} from "../src/distribution/install-location";
import { stagePilotCandidate } from "../src/distribution/staging";
import {
  parseTrustCheckpoint,
  writeNewTrustCheckpoint,
} from "../src/distribution/trust-checkpoint";

const required = { preferences: [1], manifest: [1] };

test("staging refuses an unbound location, missing trust, an unselectable attempt or a held lock, creating nothing", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "stage-home-")));
  const location = resolveInstallLocation({
    platform: "linux",
    env: { XDG_DATA_HOME: home },
    homedir: home,
  });
  const stage = (attempt: string, target = location) =>
    stagePilotCandidate({
      location: target,
      attempt,
      executionTarget: "linux-arm64",
      requiredSchemas: required,
    });
  try {
    // An owner-owned but uninitialized location is not a staging target.
    const unbound = {
      base: join(home, "unbound"),
      owner: join(home, "unbound", "distribution"),
      versions: join(home, "unbound", "versions"),
    };
    await mkdir(unbound.versions, { recursive: true, mode: 0o700 });
    await mkdir(unbound.owner, { mode: 0o700 });
    await expect(stage("closed", unbound)).rejects.toThrow();
    expect(await readdir(unbound.versions)).toEqual([]);
    await prepareInstallLocation(location);
    const root = location.owner;
    const versions = location.versions;
    await expect(stage("../x")).rejects.toThrow("Invalid attempt");
    await expect(stage("absent")).rejects.toThrow();
    await mkdir(join(root, "history", "closed"), {
      recursive: true,
      mode: 0o700,
    });
    await expect(stage("closed")).rejects.toThrow("No published trust");
    const metadata = Object.fromEntries(
      ["root", "timestamp", "snapshot", "targets"].map((role) => [
        role,
        JSON.stringify({
          signed: { _type: role, version: 1, targets: {} },
          signatures: [],
        }),
      ]),
    );
    await mkdir(join(root, "trust"), { mode: 0o700 });
    await writeNewTrustCheckpoint(
      join(root, "trust", "gen"),
      parseTrustCheckpoint({ schemaVersion: 1, metadata }),
    );
    await writeFile(
      join(root, "trust", "selected.json"),
      JSON.stringify({
        schemaVersion: 1,
        generation: "gen",
        channel: { sequence: 1, documentSha256: "ab".repeat(32) },
      }),
      { mode: 0o600 },
    );
    await expect(stage("closed")).rejects.toThrow("not selectable");
    await mkdir(join(root, ".operation-lock"), { mode: 0o700 });
    await expect(stage("closed")).rejects.toThrow("busy or requires recovery");
    expect(await readdir(versions)).toEqual([]);
  } finally {
    await rm(home, { recursive: true });
  }
});
