import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fetcher } from "tuf-js";
import { MetadataJournalFetcher } from "../src/distribution/metadata-journal";

test("new cycle uses remaining budget without inheriting old journal indices", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cycle-budget-")),
  );
  const limits = { records: 2, bytes: 5 };
  const requested: number[] = [];
  const base = "https://example.invalid/metadata/";
  const transport: Fetcher = {
    async downloadBytes(_url, limit) {
      requested.push(limit);
      return Buffer.alloc(Math.min(3, limit));
    },
    async downloadFile() {
      throw new Error("Unexpected target");
    },
  };
  try {
    const journal = new MetadataJournalFetcher(
      transport,
      directory,
      base,
      undefined,
      limits,
    );
    limits.records = 260;
    limits.bytes = 32 * 1024 * 1024;
    await journal.downloadBytes(`${base}timestamp.json`, 100);
    await journal.downloadBytes(`${base}snapshot.json`, 100);
    expect(requested).toEqual([5, 2]);
    expect((await readFile(join(directory, "001-timestamp.json"))).length).toBe(
      3,
    );
    expect((await readFile(join(directory, "002-snapshot.json"))).length).toBe(
      2,
    );
    await expect(
      journal.downloadBytes(`${base}targets.json`, 100),
    ).rejects.toThrow("record limit");
    expect(requested).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("oversized transport response is never delivered or recorded", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cycle-overflow-")),
  );
  const base = "https://example.invalid/metadata/";
  const transport: Fetcher = {
    async downloadBytes() {
      return Buffer.alloc(3);
    },
    async downloadFile() {
      throw new Error("Unexpected target");
    },
  };
  try {
    const journal = new MetadataJournalFetcher(
      transport,
      directory,
      base,
      undefined,
      { records: 10, bytes: 2 },
    );
    await expect(
      journal.downloadBytes(`${base}timestamp.json`, 100),
    ).rejects.toThrow("byte limit");
    await expect(
      readFile(join(directory, "001-timestamp.json")),
    ).rejects.toThrow();
    await expect(
      journal.downloadBytes(`${base}timestamp.json`, 100),
    ).rejects.toThrow("requires recovery");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("revoked custody after durable write keeps evidence but refuses delivery", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "journal-final-guard-")),
  );
  let checks = 0;
  try {
    const journal = new MetadataJournalFetcher(
      {
        async downloadBytes() {
          return Buffer.from("retained evidence");
        },
        async downloadFile() {
          throw new Error("unexpected target");
        },
      },
      directory,
      "https://example.invalid/metadata/",
      undefined,
      undefined,
      async () => {
        if (++checks === 3) throw new Error("lost after write");
      },
    );
    await expect(
      journal.downloadBytes(
        "https://example.invalid/metadata/timestamp.json",
        100,
      ),
    ).rejects.toThrow("lost after write");
    expect(await readFile(join(directory, "001-timestamp.json"), "utf8")).toBe(
      "retained evidence",
    );
    await expect(
      journal.downloadBytes(
        "https://example.invalid/metadata/snapshot.json",
        100,
      ),
    ).rejects.toThrow("requires recovery");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("returned metadata evidence survives abrupt process exit", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "metadata-exit-")),
  );
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL("./fixtures/metadata-journal-exit.ts", import.meta.url),
        ),
        directory,
      ],
      { stdout: "pipe", stderr: "pipe", env: {}, timeout: 5000 },
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 23, stderr: "" });
    expect(await readFile(join(directory, "001-2.root.json"), "utf8")).toBe(
      "received before exit",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("metadata bytes are retained before return; occupied evidence refuses delivery", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "metadata-journal-")),
  );
  const bytes = Buffer.from(
    "untrusted response; deliberately not valid signed metadata",
  );
  let calls = 0;
  let limit = 0;
  const transport: Fetcher = {
    async downloadBytes(_url, maxLength) {
      calls++;
      limit = maxLength;
      return bytes;
    },
    async downloadFile() {
      throw new Error("Unexpected target request");
    },
  };
  const base = "https://example.invalid/metadata/";
  try {
    const journal = new MetadataJournalFetcher(transport, directory, base);
    expect(
      await journal.downloadBytes(`${base}2.root.json`, 5 * 1024 * 1024),
    ).toEqual(bytes);
    expect(limit).toBe(1024 * 1024);
    expect(await readFile(join(directory, "001-2.root.json"))).toEqual(bytes);
    for (const url of [
      `${base}timestamp.json?credential=fixture`,
      "https://example.invalid/elsewhere/timestamp.json",
      "invalid-url",
    ]) {
      await expect(journal.downloadBytes(url, 100)).rejects.toThrow();
    }
    expect(calls).toBe(1);
    await writeFile(
      join(directory, "002-timestamp.json"),
      "preserve this evidence",
      { flag: "wx" },
    );
    await expect(
      journal.downloadBytes(`${base}timestamp.json`, 100),
    ).rejects.toThrow();
    expect(await readFile(join(directory, "002-timestamp.json"), "utf8")).toBe(
      "preserve this evidence",
    );
    await expect(
      journal.downloadBytes(`${base}snapshot.json`, 100),
    ).rejects.toThrow("requires recovery");
    expect(calls).toBe(2);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("metadata journal refuses concurrent ordering", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "metadata-order-")),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: Fetcher = {
    async downloadBytes() {
      await gate;
      return Buffer.from("response");
    },
    async downloadFile() {
      throw new Error("Unexpected target request");
    },
  };
  try {
    const journal = new MetadataJournalFetcher(
      transport,
      directory,
      "https://example.invalid/metadata/",
    );
    const first = journal.downloadBytes(
      "https://example.invalid/metadata/timestamp.json",
      100,
    );
    await expect(
      journal.downloadBytes(
        "https://example.invalid/metadata/snapshot.json",
        100,
      ),
    ).rejects.toThrow("Concurrent");
    release();
    await first;
    expect(await readFile(join(directory, "001-timestamp.json"), "utf8")).toBe(
      "response",
    );
  } finally {
    release();
    await rm(directory, { recursive: true });
  }
});

test("resumed journal preserves the prefix and applies cumulative bounds", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "journal-resume-")),
  );
  const base = "https://example.invalid/metadata/";
  let calls = 0;
  const transport: Fetcher = {
    async downloadBytes() {
      calls++;
      return Buffer.from("second");
    },
    async downloadFile() {
      throw new Error("Unexpected target");
    },
  };
  try {
    await writeFile(join(directory, "001-timestamp.json"), "first", {
      mode: 0o600,
    });
    const journal = new MetadataJournalFetcher(transport, directory, base, {
      records: 1,
      bytes: 5,
    });
    expect(await journal.downloadBytes(`${base}snapshot.json`, 100)).toEqual(
      Buffer.from("second"),
    );
    expect(await readFile(join(directory, "001-timestamp.json"), "utf8")).toBe(
      "first",
    );
    expect(await readFile(join(directory, "002-snapshot.json"), "utf8")).toBe(
      "second",
    );
    const countBound = new MetadataJournalFetcher(transport, directory, base, {
      records: 260,
      bytes: 11,
    });
    await expect(
      countBound.downloadBytes(`${base}targets.json`, 100),
    ).rejects.toThrow("record limit");
    expect(calls).toBe(1);
    const bytesBound = new MetadataJournalFetcher(transport, directory, base, {
      records: 2,
      bytes: 32 * 1024 * 1024,
    });
    await expect(
      bytesBound.downloadBytes(`${base}targets.json`, 100),
    ).rejects.toThrow("byte limit");
    await expect(
      readFile(join(directory, "003-targets.json")),
    ).rejects.toThrow();
    const collision = new MetadataJournalFetcher(transport, directory, base, {
      records: 1,
      bytes: 5,
    });
    await expect(
      collision.downloadBytes(`${base}snapshot.json`, 100),
    ).rejects.toThrow();
    expect(await readFile(join(directory, "002-snapshot.json"), "utf8")).toBe(
      "second",
    );
    for (const retained of [
      { records: -1, bytes: 0 },
      { records: 261, bytes: 0 },
      { records: 0, bytes: Number.NaN },
    ])
      expect(
        () => new MetadataJournalFetcher(transport, directory, base, retained),
      ).toThrow("bounds");
  } finally {
    await rm(directory, { recursive: true });
  }
});
