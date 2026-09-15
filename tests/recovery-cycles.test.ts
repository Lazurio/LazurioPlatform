import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Key, Metadata, Root, Signature } from "@tufjs/models";
import { createPilotFixture } from "../scripts/tuf-fixture";
import { authenticateHistoricalRoles } from "../src/distribution/historical-roles";
import {
  beginRecoveryCycle,
  beginRecoveryMetadataCycle,
  reconstructRecoveryCycles,
} from "../src/distribution/recovery-cycles";
import { withFolderOperationLock } from "../src/folder/lock";

async function setup() {
  const attempt = await realpath(
    await mkdtemp(join(tmpdir(), "recovery-cycles-")),
  );
  const fixture = createPilotFixture({
    artifact: Buffer.from("not executed"),
    identity: Buffer.from("{}"),
    executionTarget: "linux-arm64",
  });
  const original = () =>
    authenticateHistoricalRoles(fixture.rootBytes.toString(), []);
  const record = async (journal: string, role: string, index: number) => {
    const response = await fetch(`${fixture.metadataBaseUrl}${role}.json`);
    if (!response.ok) throw new Error("fixture response");
    await writeFile(
      join(journal, `${String(index).padStart(3, "0")}-${role}.json`),
      Buffer.from(await response.arrayBuffer()),
      { flag: "wx", mode: 0o600 },
    );
  };
  const cleanup = async () => {
    await fixture.stop();
    await rm(attempt, { recursive: true });
  };
  return { attempt, fixture, original, record, cleanup };
}

test("escaped cycle writer refuses a released lock and cannot download targets", async () => {
  const f = await setup();
  let calls = 0;
  try {
    const cycle = await withFolderOperationLock(f.attempt, async (held) =>
      beginRecoveryMetadataCycle(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
        {
          async downloadBytes() {
            calls++;
            return Buffer.from("not delivered");
          },
          async downloadFile() {
            calls++;
            throw new Error("transport reached");
          },
        },
        f.fixture.metadataBaseUrl,
      ),
    );
    await expect(
      cycle.fetcher.downloadBytes(
        `${f.fixture.metadataBaseUrl}timestamp.json`,
        100,
      ),
    ).rejects.toThrow();
    await expect(
      cycle.fetcher.downloadFile(
        `${f.fixture.targetBaseUrl}artifact`,
        100,
        async () => "unexpected",
      ),
    ).rejects.toThrow("cannot download targets");
    expect(calls).toBe(0);
    expect(await readdir(cycle.journal)).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("lock revoked during transport prevents new journal evidence and delivery", async () => {
  const f = await setup();
  try {
    await withFolderOperationLock(f.attempt, async (held) => {
      let revoked = false;
      const guard = async () => {
        await held();
        if (revoked) throw new Error("revoked during transport");
      };
      const cycle = await beginRecoveryMetadataCycle(
        f.attempt,
        f.original(),
        "linux-arm64",
        guard,
        {
          async downloadBytes() {
            revoked = true;
            return Buffer.from("not recorded");
          },
          async downloadFile() {
            throw new Error("unexpected target");
          },
        },
        f.fixture.metadataBaseUrl,
      );
      await expect(
        cycle.fetcher.downloadBytes(
          `${f.fixture.metadataBaseUrl}timestamp.json`,
          100,
        ),
      ).rejects.toThrow("revoked during transport");
      expect(await readdir(cycle.journal)).toEqual([]);
    });
  } finally {
    await f.cleanup();
  }
});

test("network cycle journals fresh responses without overwriting prior evidence", async () => {
  const f = await setup();
  try {
    await withFolderOperationLock(f.attempt, async (held) => {
      const first = await beginRecoveryCycle(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
      );
      await f.record(first.journal, "timestamp", 1);
      const old = await readFile(join(first.journal, "001-timestamp.json"));
      const next = await beginRecoveryMetadataCycle(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
        {
          async downloadBytes(url, limit) {
            const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
            if (bytes.length > limit) throw new Error("fixture budget");
            return bytes;
          },
          async downloadFile() {
            throw new Error("Unexpected artifact");
          },
        },
        f.fixture.metadataBaseUrl,
      );
      expect(next.priorRecords).toBe(1);
      expect(next.priorBytes).toBe(old.length);
      expect(next.floors.timestampVersion).toBe(1);
      await next.fetcher.downloadBytes(
        `${f.fixture.metadataBaseUrl}timestamp.json`,
        1024 * 1024,
      );
      expect(await readFile(join(first.journal, "001-timestamp.json"))).toEqual(
        old,
      );
      expect(await readFile(join(next.journal, "001-timestamp.json"))).toEqual(
        old,
      );
      expect(
        (
          await reconstructRecoveryCycles(
            f.attempt,
            f.original(),
            "linux-arm64",
            held,
          )
        ).records,
      ).toBe(2);
    });
  } finally {
    await f.cleanup();
  }
});

test("reconstruction refuses absent or revoked owner custody", async () => {
  const f = await setup();
  try {
    const lost = async () => {
      throw new Error("revoked owner");
    };
    // Refuse at entry, even before touching a nonexistent ledger path.
    await expect(
      reconstructRecoveryCycles(
        join(f.attempt, "missing"),
        f.original(),
        "linux-arm64",
        lost,
      ),
    ).rejects.toThrow("revoked owner");
    await withFolderOperationLock(f.attempt, async (held) => {
      const cycle = await beginRecoveryCycle(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
      );
      await f.record(cycle.journal, "timestamp", 1);
      for (const revokeAt of [2, 3, 4]) {
        let checks = 0;
        await expect(
          reconstructRecoveryCycles(
            f.attempt,
            f.original(),
            "linux-arm64",
            async () => {
              await held();
              if (++checks === revokeAt) throw new Error("revoked owner");
            },
          ),
        ).rejects.toThrow("revoked owner");
        expect(checks).toBe(revokeAt);
      }
      expect(
        (
          await reconstructRecoveryCycles(
            f.attempt,
            f.original(),
            "linux-arm64",
            held,
          )
        ).records,
      ).toBe(1);
    });
  } finally {
    await f.cleanup();
  }
});

test("same root with weaker original floors cannot replace a cycle's actual input", async () => {
  const f = await setup();
  try {
    const response = await fetch(`${f.fixture.metadataBaseUrl}timestamp.json`);
    const stronger = authenticateHistoricalRoles(
      f.fixture.rootBytes.toString(),
      [{ name: "timestamp.json", bytes: await response.text() }],
    );
    await withFolderOperationLock(f.attempt, async (held) => {
      await beginRecoveryCycle(f.attempt, stronger, "linux-arm64", held);
      await expect(
        reconstructRecoveryCycles(f.attempt, f.original(), "linux-arm64", held),
      ).rejects.toThrow("input does not match");
      expect(
        (
          await reconstructRecoveryCycles(
            f.attempt,
            stronger,
            "linux-arm64",
            held,
          )
        ).floors.timestampVersion,
      ).toBe(1);
    });
  } finally {
    await f.cleanup();
  }
});

test("next durable cycle is bound to an authenticated advanced root, not the original root", async () => {
  const f = await setup();
  try {
    const pair = generateKeyPairSync("ed25519");
    const key = new Key({
      keyID: "cycle-root",
      keyType: "ed25519",
      scheme: "ed25519",
      keyVal: {
        public: pair.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    });
    const root = (version: number) => {
      const value = new Root({
        version,
        specVersion: "1.0.0",
        expires: new Date(Date.now() + 86_400_000).toISOString(),
      });
      for (const role of ["root", "timestamp", "snapshot", "targets"])
        value.addKey(key, role);
      const metadata = new Metadata(value);
      metadata.sign(
        (bytes) =>
          new Signature({
            keyID: key.keyID,
            sig: sign(null, bytes, pair.privateKey).toString("hex"),
          }),
      );
      return JSON.stringify(metadata.toJSON());
    };
    const firstRoot = root(1);
    const nextRoot = root(2);
    const original = () => authenticateHistoricalRoles(firstRoot, []);
    await withFolderOperationLock(f.attempt, async (held) => {
      const first = await beginRecoveryCycle(
        f.attempt,
        original(),
        "linux-arm64",
        held,
      );
      await writeFile(join(first.journal, "001-2.root.json"), nextRoot, {
        flag: "wx",
        mode: 0o600,
      });
    });
    await withFolderOperationLock(f.attempt, async (held) => {
      const second = await beginRecoveryCycle(
        f.attempt,
        original(),
        "linux-arm64",
        held,
      );
      const inputPath = join(second.directory, "input.json");
      const input = JSON.parse(await readFile(inputPath, "utf8"));
      expect(input.root).toBe(nextRoot);
      expect(
        (
          await reconstructRecoveryCycles(
            f.attempt,
            original(),
            "linux-arm64",
            held,
          )
        ).floors.rootVersion,
      ).toBe(2);
      await chmod(inputPath, 0o600);
      await writeFile(inputPath, JSON.stringify({ ...input, root: firstRoot }));
      await expect(
        reconstructRecoveryCycles(f.attempt, original(), "linux-arm64", held),
      ).rejects.toThrow("input does not match");
    });
  } finally {
    await f.cleanup();
  }
});

test("cycle storage refuses linked custody and stops at the bounded cycle count", async () => {
  const f = await setup();
  try {
    const outside = join(f.attempt, "outside");
    await mkdir(outside, { mode: 0o700 });
    const linked = join(f.attempt, "linked-attempt");
    await mkdir(linked, { mode: 0o700 });
    await symlink(outside, join(linked, "recovery-cycles"));
    await withFolderOperationLock(linked, async (held) => {
      await expect(
        beginRecoveryCycle(linked, f.original(), "linux-arm64", held),
      ).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    });
    await withFolderOperationLock(f.attempt, async (held) => {
      for (let index = 0; index < 32; index++)
        await beginRecoveryCycle(f.attempt, f.original(), "linux-arm64", held);
      await expect(
        beginRecoveryCycle(f.attempt, f.original(), "linux-arm64", held),
      ).rejects.toThrow("evidence limit reached");
      expect((await readdir(join(f.attempt, "recovery-cycles"))).length).toBe(
        32,
      );
    });
  } finally {
    await f.cleanup();
  }
});

test("cycles reconstruct floors after another partial refresh without serialized counters", async () => {
  const f = await setup();
  try {
    f.fixture.publish(7, new Date(Date.now() - 86_400_000).toISOString());
    await withFolderOperationLock(f.attempt, async (held) => {
      const first = await beginRecoveryCycle(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
      );
      await f.record(first.journal, "timestamp", 1);
    });
    // Reconstruct from a fresh original anchor, not from an object retained by
    // the first invocation. The second cycle is interrupted after snapshot.
    await withFolderOperationLock(f.attempt, async (held) => {
      const state = await reconstructRecoveryCycles(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
      );
      expect(state.floors.timestampVersion).toBe(7);
      expect(state.floors.snapshotVersion).toBe(7);
      f.fixture.publish(8);
      const second = await beginRecoveryCycle(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
      );
      expect(second.priorRecords).toBe(1);
      await f.record(second.journal, "timestamp", 1);
      await f.record(second.journal, "snapshot", 2);
    });
    await withFolderOperationLock(f.attempt, async (held) => {
      const state = await reconstructRecoveryCycles(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
      );
      expect(state.count).toBe(2);
      expect(state.records).toBe(3);
      expect(state.floors.timestampVersion).toBe(8);
      expect(state.floors.snapshotVersion).toBe(8);
      expect(state.floors.snapshotRoles).toEqual({ "targets.json": 8 });
      expect(state.floors.targetsVersion).toBeUndefined();
    });
  } finally {
    await f.cleanup();
  }
});

test("lost lock refuses before mutation; interrupted unpublished input is never adopted", async () => {
  const f = await setup();
  try {
    await expect(
      beginRecoveryCycle(f.attempt, f.original(), "linux-arm64", async () => {
        throw new Error("lost lock");
      }),
    ).rejects.toThrow("lost lock");
    expect(await readdir(f.attempt)).toEqual([]);
    await withFolderOperationLock(f.attempt, async (held) => {
      let calls = 0;
      await expect(
        beginRecoveryCycle(f.attempt, f.original(), "linux-arm64", async () => {
          await held();
          if (++calls === 5) throw new Error("injected before publication");
        }),
      ).rejects.toThrow("injected before publication");
      expect(await readdir(join(f.attempt, "recovery-cycles"))).toEqual([]);
      const abandoned = (await readdir(f.attempt)).filter((name) =>
        name.startsWith(".recovery-init-"),
      );
      expect(abandoned).toHaveLength(1);
      await beginRecoveryCycle(f.attempt, f.original(), "linux-arm64", held);
      expect(
        (
          await reconstructRecoveryCycles(
            f.attempt,
            f.original(),
            "linux-arm64",
            held,
          )
        ).count,
      ).toBe(1);
      expect((await readdir(f.attempt)).includes(abandoned[0] ?? "")).toBe(
        true,
      );
    });
  } finally {
    await f.cleanup();
  }
});

test("published empty cycle survives interruption after rename", async () => {
  const f = await setup();
  try {
    await withFolderOperationLock(f.attempt, async (held) => {
      let calls = 0;
      await expect(
        beginRecoveryCycle(f.attempt, f.original(), "linux-arm64", async () => {
          await held();
          if (++calls === 6) throw new Error("after publication");
        }),
      ).rejects.toThrow("after publication");
      const state = await reconstructRecoveryCycles(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
      );
      expect(state.count).toBe(1);
      expect(state.records).toBe(0);
      expect(state.floors.timestampVersion).toBeUndefined();
    });
  } finally {
    await f.cleanup();
  }
});

test("wrong input binding, gapped cycles and corrupt journal refuse without fallback", async () => {
  const f = await setup();
  try {
    await withFolderOperationLock(f.attempt, async (held) => {
      const cycle = await beginRecoveryCycle(
        f.attempt,
        f.original(),
        "linux-arm64",
        held,
      );
      await expect(
        reconstructRecoveryCycles(
          f.attempt,
          f.original(),
          "darwin-arm64",
          held,
        ),
      ).rejects.toThrow("input does not match");
      const path = join(cycle.directory, "input.json");
      const input = JSON.parse(await readFile(path, "utf8"));
      await chmod(path, 0o600);
      await writeFile(path, JSON.stringify({ ...input, root: "foreign root" }));
      await expect(
        reconstructRecoveryCycles(f.attempt, f.original(), "linux-arm64", held),
      ).rejects.toThrow("input does not match");
      await writeFile(path, JSON.stringify(input));
      await writeFile(
        join(cycle.journal, "001-timestamp.json"),
        "partial JSON",
        { mode: 0o600 },
      );
      await expect(
        reconstructRecoveryCycles(f.attempt, f.original(), "linux-arm64", held),
      ).rejects.toThrow();
      expect(
        await readFile(join(cycle.journal, "001-timestamp.json"), "utf8"),
      ).toBe("partial JSON");
    });
    // A separate empty fixture isolates the ledger's sequence check.
    const other = join(f.attempt, "gap-fixture");
    await mkdir(other, { mode: 0o700 });
    await mkdir(join(other, "recovery-cycles"), { mode: 0o700 });
    await mkdir(join(other, "recovery-cycles", "000002"), { mode: 0o700 });
    await withFolderOperationLock(other, async (held) => {
      await expect(
        reconstructRecoveryCycles(other, f.original(), "linux-arm64", held),
      ).rejects.toThrow("Gapped or unknown");
    });
  } finally {
    await f.cleanup();
  }
});
