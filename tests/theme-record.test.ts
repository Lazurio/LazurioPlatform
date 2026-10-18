import { expect, test } from "bun:test";
import {
  chmod,
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
import { basename, dirname, join } from "node:path";
import { acquireFileLock } from "../src/platform/flock";
import {
  changeRecord,
  defaultThemeRecord,
  fileThemeStore,
  memoryThemeStore,
  parseThemeRecord,
  themeRecordFile,
} from "../src/theme/record";

// Root decision 0208 point 1: one theme record per Environment, owned by its
// Launchpad, changed only at the revision it was read at (compare and set),
// by Settings and by `lazurio theme` alike: the install base's record of the
// Folder, which a release before this one never sees in the Folder's
// `.lazurio/`.

const at = (iso: string) => () => new Date(iso);
const posixTest = test.skipIf(process.platform === "win32");

test("a change is made only at the revision it was asked at; the theme it has is unchanged", () => {
  const now = new Date("2026-10-18T10:00:00.000Z");
  expect(changeRecord(defaultThemeRecord, "ocean", 0, now)).toEqual({
    kind: "set",
    record: { theme: "ocean", revision: 1, setAt: "2026-10-18T10:00:00.000Z" },
  });
  const ocean = {
    theme: "ocean",
    revision: 4,
    setAt: now.toISOString(),
  } as const;
  expect(changeRecord(ocean, "ember", 3, now)).toEqual({
    kind: "blocked",
    reason: "theme-changed",
    record: ocean,
  });
  expect(changeRecord(ocean, "ember", 4, now).kind).toBe("set");
  // Without an expected revision, on top of whatever it is.
  expect(changeRecord(ocean, "ember", null, now)).toEqual({
    kind: "set",
    record: { theme: "ember", revision: 5, setAt: now.toISOString() },
  });
  // Asking for the theme it has changes nothing, whatever the revision.
  expect(changeRecord(ocean, "ocean", 1, now)).toEqual({
    kind: "unchanged",
    record: ocean,
  });
});

test("the record is read only in its exact form", () => {
  const record = {
    schemaVersion: 1,
    theme: "iris",
    revision: 2,
    setAt: "2026-10-18T10:00:00.000Z",
  };
  expect(parseThemeRecord(record)).toEqual({
    theme: "iris",
    revision: 2,
    setAt: "2026-10-18T10:00:00.000Z",
  });
  for (const refused of [
    null,
    [],
    { ...record, schemaVersion: 2 },
    { ...record, theme: "t3-chat" },
    { ...record, theme: "Ocean" },
    { ...record, revision: 0 },
    { ...record, revision: 1.5 },
    { ...record, setAt: null },
    { ...record, setAt: "yesterday" },
    { ...record, extra: true },
    { theme: "iris", revision: 2, setAt: record.setAt },
  ])
    expect(() => parseThemeRecord(refused)).toThrow();
});

test("in memory: the same change and the same answers, kept in the process", async () => {
  const store = memoryThemeStore(undefined, at("2026-10-18T10:00:00.000Z"));
  expect(await store.read()).toEqual(defaultThemeRecord);
  expect((await store.change("grove", 0)).kind).toBe("set");
  expect(await store.read()).toEqual({
    theme: "grove",
    revision: 1,
    setAt: "2026-10-18T10:00:00.000Z",
  });
  expect(await store.change("iris", 0)).toEqual({
    kind: "blocked",
    reason: "theme-changed",
    record: await store.read(),
  });
});

async function base(run: (base: string, folder: string) => Promise<void>) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "theme-record-")));
  try {
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await run(join(parent, "base"), folder);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

posixTest(
  "in the install base: the Folder's own record, owner-only, read by every store of the same Folder",
  async () => {
    await base(async (root, folder) => {
      const launchpad = fileThemeStore(root, folder, {
        now: at("2026-10-18T10:00:00.000Z"),
      });
      // The CLI's own store of the same Folder and base.
      const cli = fileThemeStore(root, folder);
      expect(await launchpad.read()).toEqual(defaultThemeRecord);
      expect(await cli.change("ocean", 0)).toMatchObject({
        kind: "set",
        record: { theme: "ocean", revision: 1 },
      });
      expect(await launchpad.read()).toMatchObject({
        theme: "ocean",
        revision: 1,
      });
      // The Launchpad read the CLI's change; its own stale change is refused.
      expect(await launchpad.change("ember", 0)).toMatchObject({
        kind: "blocked",
        reason: "theme-changed",
        record: { theme: "ocean", revision: 1 },
      });
      const file = themeRecordFile(root, folder);
      expect(dirname(file)).toBe(join(root, "theme"));
      expect(basename(file)).toMatch(/^[0-9a-f]{32}\.json$/);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        schemaVersion: 1,
        theme: "ocean",
        revision: 1,
      });
      // Never in the Folder: its `.lazurio/` admits no entry it does not know.
      expect(await readdir(folder)).toEqual([]);
      // Another Folder of the same base has a record of its own.
      const other = join(dirname(folder), "Other");
      await mkdir(other, { mode: 0o700 });
      expect(await fileThemeStore(root, other).read()).toEqual(
        defaultThemeRecord,
      );
    });
  },
);

posixTest(
  "a record that cannot be read is the default, and the next change replaces it",
  async () => {
    await base(async (root, folder) => {
      const store = fileThemeStore(root, folder);
      const file = themeRecordFile(root, folder);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      for (const [content, mode] of [
        ["{", 0o600],
        ['{"schemaVersion":1,"theme":"ocean","theme":"iris"}', 0o600],
        [
          JSON.stringify({
            schemaVersion: 1,
            theme: "ocean",
            revision: 3,
            setAt: "2026-10-18T10:00:00.000Z",
          }),
          0o644,
        ],
      ] as const) {
        await writeFile(file, content);
        await chmod(file, mode);
        expect(await store.read()).toEqual(defaultThemeRecord);
      }
      expect(await store.change("iris", 0)).toMatchObject({
        kind: "set",
        record: { theme: "iris", revision: 1 },
      });
      expect(await store.read()).toMatchObject({ theme: "iris", revision: 1 });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    });
  },
);

posixTest(
  "one change at a time: a change waits for another one, and says so when it outlasts the wait",
  async () => {
    await base(async (root, folder) => {
      await fileThemeStore(root, folder).change("grove", 0);
      const lock = await acquireFileLock(
        themeRecordFile(root, folder).replace(/\.json$/, ".lock"),
        { timeoutMs: 0 },
      );
      try {
        expect(
          await fileThemeStore(root, folder, { lockWaitMs: 0 }).change(
            "ocean",
            1,
          ),
        ).toEqual({ kind: "blocked", reason: "theme-busy" });
      } finally {
        await lock.release();
      }
      expect((await fileThemeStore(root, folder).change("ocean", 1)).kind).toBe(
        "set",
      );
    });
  },
);

posixTest(
  "a killed writer's leftover of this record goes with the next change; another Folder's stays",
  async () => {
    await base(async (root, folder) => {
      const store = fileThemeStore(root, folder);
      await store.change("grove", 0);
      const file = themeRecordFile(root, folder);
      const directory = dirname(file);
      const mine = `.${basename(file)}.tmp-0123456789abcdef`;
      const theirs = `.${"f".repeat(32)}.json.tmp-0123456789abcdef`;
      await writeFile(join(directory, mine), "partial");
      await writeFile(join(directory, theirs), "partial");
      await store.change("ocean", 1);
      const left = await readdir(directory);
      expect(left).not.toContain(mine);
      expect(left).toContain(theirs);
      // A change that changes nothing leaves the record as it was.
      const before = await readFile(file, "utf8");
      expect((await store.change("ocean", 1)).kind).toBe("unchanged");
      expect(await readFile(file, "utf8")).toBe(before);
    });
  },
);
