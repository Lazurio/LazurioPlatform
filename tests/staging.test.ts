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
import { stagePilotCandidate } from "../src/distribution/staging";
import {
  parseTrustCheckpoint,
  writeNewTrustCheckpoint,
} from "../src/distribution/trust-checkpoint";

const required = { preferences: [1], manifest: [1] };

test("staging refuses without published trust, a selectable attempt or a held lock, creating nothing", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stage-root-")));
  const versions = await realpath(
    await mkdtemp(join(tmpdir(), "stage-versions-")),
  );
  const stage = (attempt: string) =>
    stagePilotCandidate({
      root,
      versions,
      attempt,
      executionTarget: "linux-arm64",
      requiredSchemas: required,
    });
  try {
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
    await rm(root, { recursive: true });
    await rm(versions, { recursive: true });
  }
});
