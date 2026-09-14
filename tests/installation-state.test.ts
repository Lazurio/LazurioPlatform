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
  downloadPilotUnderOwner,
  readPublishedPilotTrust,
  recoverPilotAttempts,
} from "../src/distribution/installation-state";
import {
  parseTrustCheckpoint,
  writeNewTrustCheckpoint,
} from "../src/distribution/trust-checkpoint";

const metadata = Object.fromEntries(
  ["root", "timestamp", "snapshot", "targets"].map((role) => [
    role,
    JSON.stringify({ signed: { _type: role, version: 1 }, signatures: [] }),
  ]),
);
const checkpoint = parseTrustCheckpoint({ schemaVersion: 1, metadata });
const channel = { sequence: 2, documentSha256: "ab".repeat(32) };
// Never contacted: every refusal below happens before any network use.
const network = {
  executionTarget: "linux-arm64",
  metadataBaseUrl: "https://pilot.invalid/metadata/",
  targetBaseUrl: "https://pilot.invalid/targets/",
  allowedOrigins: ["https://pilot.invalid"],
  timeoutMs: 1000,
  signal: new AbortController().signal,
  maxArtifactBytes: 1,
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "install-owner-")));
  return { root, trust: join(root, "trust") };
}

test("published trust never falls back to another readable generation and fails closed on damage", async () => {
  const { root, trust } = await fixture();
  const selected = join(trust, "selected.json");
  try {
    expect(await readPublishedPilotTrust(root)).toBeNull();
    await mkdir(trust, { mode: 0o700 });
    expect(await readPublishedPilotTrust(root)).toBeNull();
    await writeNewTrustCheckpoint(join(trust, "old"), checkpoint);
    await expect(readPublishedPilotTrust(root)).rejects.toThrow(
      "requires recovery",
    );
    for (const generation of ["missing", "../old", "/old", "", "old/../old"]) {
      await writeFile(
        selected,
        JSON.stringify({ schemaVersion: 1, generation, channel }),
        { mode: 0o600 },
      );
      await expect(readPublishedPilotTrust(root)).rejects.toThrow();
    }
    for (const bad of [
      { schemaVersion: 1, generation: "old" },
      { schemaVersion: 1, generation: "old", channel: { sequence: 2 } },
      {
        schemaVersion: 1,
        generation: "old",
        channel: { ...channel, extra: 1 },
      },
      {
        schemaVersion: 1,
        generation: "old",
        channel: { ...channel, sequence: 0 },
      },
      { schemaVersion: 2, generation: "old", channel },
    ]) {
      await writeFile(selected, JSON.stringify(bad), { mode: 0o600 });
      await expect(readPublishedPilotTrust(root)).rejects.toThrow();
    }
    await writeFile(
      selected,
      JSON.stringify({ schemaVersion: 1, generation: "old", channel }),
      { mode: 0o600 },
    );
    expect(await readPublishedPilotTrust(root)).toEqual({
      generation: "old",
      trust: { kind: "established", checkpoint, channel },
    });
    await writeFile(join(trust, "old", "trust.json"), "\u0000");
    await writeNewTrustCheckpoint(join(trust, "other"), checkpoint);
    await expect(readPublishedPilotTrust(root)).rejects.toThrow();
    await writeFile(selected, "\u0000");
    await expect(readPublishedPilotTrust(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("download refuses missing bootstrap, bootstrap over published trust, damaged trust and pending attempts before any network use", async () => {
  const { root, trust } = await fixture();
  try {
    await expect(downloadPilotUnderOwner({ root, ...network })).rejects.toThrow(
      "Bootstrap root required",
    );
    expect(await readdir(join(root, "attempts"))).toEqual([]);
    await writeNewTrustCheckpoint(join(trust, "gen"), checkpoint);
    await expect(
      downloadPilotUnderOwner({ root, bootstrapRoot: "{}", ...network }),
    ).rejects.toThrow("requires recovery");
    await writeFile(
      join(trust, "selected.json"),
      JSON.stringify({ schemaVersion: 1, generation: "gen", channel }),
      { mode: 0o600 },
    );
    await expect(
      downloadPilotUnderOwner({ root, bootstrapRoot: "{}", ...network }),
    ).rejects.toThrow("bootstrap refused");
    await mkdir(join(root, "attempts", "0123456789abcdef"), { mode: 0o700 });
    await expect(downloadPilotUnderOwner({ root, ...network })).rejects.toThrow(
      "requires recovery: 0123456789abcdef",
    );
    await mkdir(join(root, "attempts", "Not Valid"), { mode: 0o700 });
    await expect(downloadPilotUnderOwner({ root, ...network })).rejects.toThrow(
      "Unrecognized installation attempt",
    );
    await expect(
      recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
    ).rejects.toThrow("Unrecognized installation attempt");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("recovery closes attempts without received metadata, binds evidence to the owner and reports damage", async () => {
  const { root, trust } = await fixture();
  const attempts = join(root, "attempts");
  const history = join(root, "history");
  try {
    await mkdir(attempts, { mode: 0o700 });
    await mkdir(join(attempts, "empty"), { mode: 0o700 });
    await mkdir(join(attempts, "input-only"), { mode: 0o700 });
    await writeFile(
      join(attempts, "input-only", "input-trust.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "bootstrap",
        metadata: { root: "{}" },
        channel: null,
      }),
      { mode: 0o600 },
    );
    await mkdir(join(attempts, "input-only", "received-metadata"), {
      mode: 0o700,
    });
    expect(
      await recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
    ).toEqual([
      { attempt: "empty", published: false, candidate: null },
      { attempt: "input-only", published: false, candidate: null },
    ]);
    expect(await readdir(attempts)).toEqual([]);
    expect((await readdir(history)).sort()).toEqual(["empty", "input-only"]);
    expect(await readPublishedPilotTrust(root)).toBeNull();
    // A record exists: the input must bind to the owner before any replay.
    const bound = join(attempts, "bound");
    await mkdir(bound, { mode: 0o700 });
    await mkdir(join(bound, "received-metadata"), { mode: 0o700 });
    await writeFile(
      join(bound, "received-metadata", "001-timestamp.json"),
      "{}",
      {
        mode: 0o600,
      },
    );
    await writeFile(
      join(bound, "input-trust.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "bootstrap",
        metadata: { root: "{}" },
        channel: null,
      }),
      { mode: 0o600 },
    );
    await expect(
      recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
    ).rejects.toThrow("Bootstrap root required");
    await expect(
      recoverPilotAttempts({
        root,
        bootstrapRoot: "{ }",
        executionTarget: "linux-arm64",
      }),
    ).rejects.toThrow("does not match the bootstrap root");
    await writeNewTrustCheckpoint(join(trust, "gen"), checkpoint);
    await writeFile(
      join(trust, "selected.json"),
      JSON.stringify({ schemaVersion: 1, generation: "gen", channel }),
      { mode: 0o600 },
    );
    await expect(
      recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
    ).rejects.toThrow("did not start from the published trust");
    await writeFile(
      join(bound, "input-trust.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "established",
        metadata,
        channel: { ...channel, sequence: 1 },
      }),
      { mode: 0o600 },
    );
    await expect(
      recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
    ).rejects.toThrow("does not match published trust");
    expect(await readdir(attempts)).toEqual(["bound"]);
    expect(await readPublishedPilotTrust(root)).toEqual({
      generation: "gen",
      trust: { kind: "established", checkpoint, channel },
    });
    await rm(join(trust, "selected.json"));
    await expect(
      recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
    ).rejects.toThrow("requires recovery");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("owner operations refuse a held or replaced operation lock", async () => {
  const { root } = await fixture();
  try {
    await mkdir(join(root, ".operation-lock"), { mode: 0o700 });
    await expect(
      downloadPilotUnderOwner({ root, bootstrapRoot: "{}", ...network }),
    ).rejects.toThrow("busy or requires recovery");
    await expect(
      recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
    ).rejects.toThrow("busy or requires recovery");
    expect(await readdir(join(root, "attempts"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true });
  }
});
