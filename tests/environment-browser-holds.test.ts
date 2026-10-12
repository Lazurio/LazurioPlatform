import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  holderDirectory,
  holdsReader,
  isStrip,
  keptTabs,
  liveTabsPath,
  parseBootTime,
  parseHolder,
  parseLiveTabs,
  processAlive,
  readBootClock,
  readHolds,
  unreadableHolderFiles,
  watchHolds,
  writeLiveTabs,
} from "../src/browser/people/holds";

// Who keeps a remote tab of the Environment browser (decision F47 points 4
// and 5): the holder files the apps' servers write and the agent-browser
// sessions whose daemon runs.

const id = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
test("a strip is a file name in agent-browser's session alphabet", () => {
  for (const name of ["launchpad", "t3-abc_DEF-123", "x".repeat(64)])
    expect(isStrip(name)).toBe(true);
  for (const name of ["", "../x", "a/b", "a.b", "x".repeat(65), 7, null])
    expect(isStrip(name)).toBe(false);
});

test("the holder directory lives in the runtime directory, never elsewhere", () => {
  expect(holderDirectory({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
    "/run/user/1000/lazurio-browser/holders",
  );
  expect(holderDirectory({ XDG_RUNTIME_DIR: "run/user" })).toBeUndefined();
  expect(holderDirectory({})).toBeUndefined();
});

test("a holder file holds only target ids, under its own strip name", () => {
  const text = (value: unknown) => JSON.stringify(value);
  expect(
    parseHolder(
      "t3-a.json",
      text({
        strip: "t3-a",
        label: "  Vlákno o webu  ",
        tabs: [id(1), id(1).toLowerCase(), "nope", 5, id(2)],
      }),
    ),
  ).toEqual({ strip: "t3-a", label: "Vlákno o webu", tabs: [id(1), id(2)] });
  // The label is optional and cut; the strip must be the file's name.
  expect(
    parseHolder("launchpad.json", text({ strip: "launchpad", tabs: [] })),
  ).toEqual({ strip: "launchpad", label: "", tabs: [] });
  expect(
    parseHolder(
      "launchpad.json",
      text({ strip: "launchpad", label: "x".repeat(500), tabs: [] }),
    )?.label.length,
  ).toBe(200);
  for (const [name, body] of [
    ["t3-a.json", text({ strip: "t3-b", tabs: [] })],
    ["t3-a.tmp", text({ strip: "t3-a", tabs: [] })],
    ["..json", text({ strip: ".", tabs: [] })],
    ["t3-a.json", text({ strip: "t3-a", tabs: "x" })],
    ["t3-a.json", text([id(1)])],
    ["t3-a.json", "{"],
    ["t3-a.json", text({ strip: "t3-a", tabs: [], pad: "x".repeat(70_000) })],
  ] as const)
    expect(parseHolder(name, body)).toBeNull();
  // At most 500 tabs per holder.
  expect(
    parseHolder(
      "t3-a.json",
      text({
        strip: "t3-a",
        tabs: Array.from({ length: 600 }, (_, n) => id(n + 1)),
      }),
    )?.tabs.length,
  ).toBe(500);
});

test("the holds join every holder file and the sessions whose daemon runs", async () => {
  root = await mkdtemp(join(tmpdir(), "holds-"));
  const holders = join(root, "holders");
  const sockets = join(root, "agent-browser");
  await mkdir(holders);
  await mkdir(sockets);
  const write = (directory: string, name: string, value: unknown) =>
    writeFile(
      join(directory, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  await write(holders, "t3-a.json", {
    strip: "t3-a",
    label: "A",
    tabs: [id(1), id(2)],
  });
  await write(holders, "launchpad.json", {
    strip: "launchpad",
    label: "Launchpad",
    tabs: [id(2)],
  });
  // An app's temporary file is no strip's file.
  await write(holders, "t3-a.json.tmp-1", { strip: "t3-a", tabs: [id(9)] });
  // A live daemon, an ended one (its binding stays), a binding without a
  // daemon file, a daemon file that cannot be understood (working, so its
  // tab stays), and files that are no binding.
  await write(sockets, "codex-1.target", { targetId: id(3) });
  await write(sockets, "codex-1.pid", "4242\n");
  await write(sockets, "t3-old.target", { targetId: id(4).toLowerCase() });
  await write(sockets, "t3-old.pid", "4343");
  await write(sockets, "claude-2.target", { targetId: id(3) });
  await write(sockets, "odd-3.target", { targetId: id(5) });
  await write(sockets, "odd-3.pid", "not a pid");
  await write(sockets, "codex-1.sock", "");
  await write(sockets, "short.target", { targetId: "abc" });
  const { holds, unreadable } = await readHolds(
    { holders, sockets },
    (pid) => pid === 4242,
  );
  expect(unreadable).toEqual([]);
  expect(Object.fromEntries(holds.holders)).toEqual({
    [id(1)]: [{ strip: "t3-a", label: "A" }],
    [id(2)]: [
      { strip: "launchpad", label: "Launchpad" },
      { strip: "t3-a", label: "A" },
    ],
  });
  expect(Object.fromEntries(holds.working)).toEqual({
    [id(3)]: ["codex-1"],
    [id(5)]: ["odd-3"],
  });
  expect(Object.fromEntries(holds.bound)).toEqual({
    [id(3)]: ["claude-2", "codex-1"],
    [id(4)]: ["t3-old"],
    [id(5)]: ["odd-3"],
  });
});

test("a holder directory that cannot be listed is thrown, never read as holding nothing", async () => {
  root = await mkdtemp(join(tmpdir(), "holds-fail-"));
  const holders = join(root, "holders");
  await mkdir(holders);
  await writeFile(
    join(holders, "t3-a.json"),
    JSON.stringify({ strip: "t3-a", label: "A", tabs: [id(1)] }),
  );
  expect((await readHolds({ holders })).holds.holders.size).toBe(1);
  await chmod(holders, 0o000);
  try {
    await expect(readHolds({ holders })).rejects.toThrow();
  } finally {
    await chmod(holders, 0o700);
  }
});

// Root decision 0191 point 32 (it changes F47 point 5): a file that cannot be
// read keeps holding what it held at its last reading, and only that.
test("a holder file that cannot be read keeps only the tabs it last held; the other files count as they read now", async () => {
  root = await mkdtemp(join(tmpdir(), "holds-file-"));
  const holders = join(root, "holders");
  await mkdir(holders);
  const hold = (strip: string, tabs: string[]) =>
    writeFile(
      join(holders, `${strip}.json`),
      JSON.stringify({ strip, label: strip, tabs }),
    );
  await hold("launchpad", [id(1)]);
  await hold("t3-a", [id(2)]);
  const first = await readHolds({ holders });
  expect([...first.holds.holders.keys()].sort()).toEqual([id(1), id(2)]);
  // The Launchpad's file breaks, and the thread lets go of its tab: the
  // thread's release counts, the Launchpad keeps its tab.
  await writeFile(join(holders, "launchpad.json"), "{");
  await hold("t3-a", []);
  const broken = await readHolds({ holders }, processAlive, first.memory);
  expect(Object.fromEntries(broken.holds.holders)).toEqual({
    [id(1)]: [{ strip: "launchpad", label: "launchpad" }],
  });
  expect(broken.unreadable).toEqual(["launchpad.json"]);
  // Still broken on the next reading: it keeps what it held, no more.
  const again = await readHolds({ holders }, processAlive, broken.memory);
  expect([...again.holds.holders.keys()]).toEqual([id(1)]);
  // A file that cannot be opened counts the same.
  await hold("launchpad", [id(1)]);
  await chmod(join(holders, "launchpad.json"), 0o000);
  try {
    const denied = await readHolds({ holders }, processAlive, again.memory);
    expect([...denied.holds.holders.keys()]).toEqual([id(1)]);
    expect(denied.unreadable).toEqual(["launchpad.json"]);
  } finally {
    await chmod(join(holders, "launchpad.json"), 0o600);
  }
  // Readable again: what it says now counts, a release included.
  await hold("launchpad", []);
  const fixed = await readHolds({ holders }, processAlive, again.memory);
  expect(fixed.holds.holders.size).toBe(0);
  expect(fixed.unreadable).toEqual([]);
  // A file never read holds nothing the reading knows of.
  await writeFile(join(holders, "t3-b.json"), "{");
  const never = await readHolds({ holders }, processAlive, fixed.memory);
  expect(never.holds.holders.size).toBe(0);
  expect(never.unreadable).toEqual(["t3-b.json"]);
  // A file that went holds nothing and is forgotten.
  await rm(join(holders, "t3-b.json"));
  await rm(join(holders, "launchpad.json"));
  const gone = await readHolds({ holders }, processAlive, never.memory);
  expect(gone.memory.holders.size).toBe(1);
  expect(gone.unreadable).toEqual([]);
});

test("a binding that cannot be read keeps its tab; one never read binds nothing; a .pid that cannot be read counts as working", async () => {
  root = await mkdtemp(join(tmpdir(), "holds-binding-"));
  const sockets = join(root, "agent-browser");
  await mkdir(sockets);
  await writeFile(
    join(sockets, "codex-1.target"),
    JSON.stringify({ targetId: id(3) }),
  );
  await writeFile(join(sockets, "codex-1.pid"), "4242");
  const alive = (pid: number) => pid === 4242;
  const first = await readHolds({ sockets }, alive);
  expect(Object.fromEntries(first.holds.working)).toEqual({
    [id(3)]: ["codex-1"],
  });
  await writeFile(join(sockets, "codex-1.target"), "{");
  const broken = await readHolds({ sockets }, alive, first.memory);
  expect(Object.fromEntries(broken.holds.working)).toEqual({
    [id(3)]: ["codex-1"],
  });
  expect(broken.unreadable).toEqual(["codex-1.target"]);
  // Never read: no tab is known for it.
  const never = await readHolds({ sockets }, alive);
  expect(never.holds.bound.size).toBe(0);
  expect(never.unreadable).toEqual(["codex-1.target"]);
  // A .pid that cannot be opened is unclear, and unclear keeps the tab.
  await writeFile(
    join(sockets, "codex-1.target"),
    JSON.stringify({ targetId: id(3) }),
  );
  await writeFile(join(sockets, "codex-1.pid"), "4343");
  expect((await readHolds({ sockets }, alive)).holds.working.size).toBe(0);
  await chmod(join(sockets, "codex-1.pid"), 0o000);
  try {
    expect(
      Object.fromEntries((await readHolds({ sockets }, alive)).holds.working),
    ).toEqual({ [id(3)]: ["codex-1"] });
  } finally {
    await chmod(join(sockets, "codex-1.pid"), 0o600);
  }
});

test("the hub's reader remembers between readings, one at a time, and logs a file that breaks and mends", async () => {
  root = await mkdtemp(join(tmpdir(), "holds-reader-"));
  const holders = join(root, "holders");
  await mkdir(holders);
  await writeFile(
    join(holders, "launchpad.json"),
    JSON.stringify({ strip: "launchpad", tabs: [id(1), id(2)] }),
  );
  const lines: string[] = [];
  const read = holdsReader({ holders }, { log: (line) => lines.push(line) });
  expect((await read()).holders.size).toBe(2);
  await writeFile(join(holders, "launchpad.json"), "{");
  await writeFile(join(holders, "t3-a.json"), "{");
  // Readings asked for together still remember each other.
  const [one, two] = await Promise.all([read(), read()]);
  expect(one.holders.size).toBe(2);
  expect(two.holders.size).toBe(2);
  expect(lines).toEqual([
    "launchpad.json cannot be read: it keeps the 2 tabs it held when it was last read; other files count",
    "t3-a.json cannot be read: it was never read, so it holds no tab; other files count",
  ]);
  // Mended, or gone (which lets go of what it held): two different lines.
  await writeFile(
    join(holders, "launchpad.json"),
    JSON.stringify({ strip: "launchpad", tabs: [] }),
  );
  await rm(join(holders, "t3-a.json"));
  expect((await read()).holders.size).toBe(0);
  expect(lines.slice(2)).toEqual([
    "launchpad.json can be read again",
    "t3-a.json is gone: it holds nothing now",
  ]);
});

test("doctor's list names the holder files that cannot be read, or the directory", async () => {
  root = await mkdtemp(join(tmpdir(), "holds-doctor-"));
  const env = { XDG_RUNTIME_DIR: root };
  expect(await unreadableHolderFiles(env)).toEqual([]);
  expect(await unreadableHolderFiles({})).toEqual([]);
  const holders = holderDirectory(env) as string;
  await mkdir(holders, { recursive: true });
  await writeFile(
    join(holders, "launchpad.json"),
    JSON.stringify({ strip: "launchpad", tabs: [id(1)] }),
  );
  await writeFile(join(holders, "t3-a.json.tmp-1"), "{");
  expect(await unreadableHolderFiles(env)).toEqual([]);
  await writeFile(join(holders, "t3-a.json"), "{");
  await writeFile(
    join(holders, "t3-b.json"),
    JSON.stringify({ strip: "t3-c", tabs: [] }),
  );
  expect(await unreadableHolderFiles(env)).toEqual(["t3-a.json", "t3-b.json"]);
  await chmod(holders, 0o000);
  try {
    expect(await unreadableHolderFiles(env)).toEqual([holders]);
  } finally {
    await chmod(holders, 0o700);
  }
});

test("a .pid releases a tab only when it names a well-formed process id that ended", async () => {
  root = await mkdtemp(join(tmpdir(), "holds-pid-"));
  const sockets = join(root, "agent-browser");
  await mkdir(sockets);
  await writeFile(
    join(sockets, "codex-1.target"),
    JSON.stringify({ targetId: id(3) }),
  );
  const working = async (pid: string | null, alive = false) => {
    if (pid === null) await rm(join(sockets, "codex-1.pid"), { force: true });
    else await writeFile(join(sockets, "codex-1.pid"), pid);
    const { holds } = await readHolds({ sockets }, () => alive);
    return holds.working.has(id(3));
  };
  // Unclear: empty, blank, zero, signed, pid 1, too long, not a number.
  for (const unclear of [
    "",
    " ",
    "\n",
    "0",
    "-1",
    "1",
    "+5",
    "4.2",
    "99999999999",
    "x",
  ])
    expect(await working(unclear)).toBe(true);
  // A well-formed id: working while it runs, ended once it does not.
  expect(await working("4242\n", true)).toBe(true);
  expect(await working("4242")).toBe(false);
  // No .pid: the daemon ended (agent-browser removes it on exit).
  expect(await working(null)).toBe(false);
});

test("directories that do not exist hold nothing", async () => {
  const { holds } = await readHolds({
    holders: join(tmpdir(), "no-such-holders-dir-f47"),
    sockets: undefined,
  });
  expect(holds.holders.size + holds.working.size + holds.bound.size).toBe(0);
});

test("a process is alive while kill -0 reaches it", () => {
  expect(processAlive(process.pid)).toBe(true);
  for (const pid of [0, 1, -5, Number.NaN, 1.5])
    expect(processAlive(pid)).toBe(false);
  expect(processAlive(2 ** 22 + 12_345)).toBe(false);
});

test("a change in a watched directory is reported, and a directory made later is watched on retry", async () => {
  root = await mkdtemp(join(tmpdir(), "holds-watch-"));
  const holders = join(root, "holders");
  const later = join(root, "agent-browser");
  await mkdir(holders);
  let changes = 0;
  const watcher = watchHolds([holders, later, undefined], () => {
    changes++;
  });
  // A watch may miss a change made the instant it starts (macOS), which the
  // hub's periodic read covers; the test writes until the watch sees one.
  const seen = async (path: string, after: number) => {
    const deadline = Date.now() + 5_000;
    for (let n = 0; changes <= after; n++) {
      if (Date.now() > deadline) throw new Error("no change seen");
      await writeFile(path, `{"n":${n}}`);
      await settle(50);
    }
  };
  try {
    await seen(join(holders, "launchpad.json"), 0);
    const before = changes;
    await mkdir(later);
    watcher.retry();
    await seen(join(later, "codex-1.target"), before);
  } finally {
    watcher.stop();
  }
});

const boot = "6f2c1d0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const earlierBoot = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const at = (seconds: number, ofBoot: string = boot) => ({
  boot: ofBoot,
  at: seconds,
});

test("the boot clock reads the boot's id and the seconds since it", async () => {
  const files: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": `${boot}\n`,
    "/proc/uptime": "12345.67 54321.00\n",
  };
  const read = async (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
  expect(await readBootClock(read)).toEqual(at(12345.67));
  files["/proc/uptime"] = "x y";
  expect(await readBootClock(read)).toBeNull();
  // Not Linux: no boot clock.
  expect(
    await readBootClock(async () => {
      throw new Error("ENOENT");
    }),
  ).toBeNull();
  expect(parseBootTime(at(1))).toEqual(at(1));
  for (const value of [
    null,
    {},
    { boot, at: -1 },
    { boot: "x", at: 1 },
    { boot, at: "1" },
  ])
    expect(parseBootTime(value)).toBeNull();
});

test("the list of live tabs is written atomically, owner-only, and read back", async () => {
  root = await mkdtemp(join(tmpdir(), "live-tabs-"));
  expect(liveTabsPath({ XDG_RUNTIME_DIR: root })).toBe(
    join(root, "lazurio-browser", "tabs.json"),
  );
  expect(liveTabsPath({})).toBeUndefined();
  const path = join(root, "lazurio-browser", "tabs.json");
  await writeLiveTabs(path, [id(1), id(2)], at(100));
  await writeLiveTabs(path, [id(3)], at(105.5));
  expect(parseLiveTabs(await readFile(path, "utf8"))).toEqual({
    tabs: [id(3)],
    takenAt: at(105.5),
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(root, "lazurio-browser"))).toEqual(["tabs.json"]);
  for (const text of [
    "{",
    "[]",
    JSON.stringify({ tabs: [id(1)] }),
    JSON.stringify({ tabs: [id(1)], takenAt: "2026-10-11T12:00:00Z" }),
    JSON.stringify({ tabs: ["x"], takenAt: at(1) }),
    JSON.stringify({ tabs: id(1), takenAt: at(1) }),
  ])
    expect(parseLiveTabs(text)).toBeNull();
});

test("an app drops a stored tab only when a list of this boot taken after its record lacks it", () => {
  const list = { tabs: [id(1)], takenAt: at(100) };
  const stored = [
    { id: id(1), recordedAt: at(10) },
    { id: id(2), recordedAt: at(90) },
    { id: id(3), recordedAt: at(100) },
    { id: id(4).toLowerCase(), recordedAt: at(100.5) },
    { id: id(5), recordedAt: null },
    { id: id(6), recordedAt: at(5_000, earlierBoot) },
  ];
  // id(2) ended before the snapshot began. id(5) has no time and id(6) is
  // from an earlier boot, so both count as older than every list of this
  // boot. id(3) and id(4) were recorded when or after it began.
  expect(keptTabs(stored, list, boot)).toEqual([
    id(1),
    id(3),
    id(4).toLowerCase(),
  ]);
  // A list of another boot, no list, or no boot clock: nothing is dropped.
  const all = stored.map((tab) => tab.id);
  expect(
    keptTabs(stored, { tabs: [], takenAt: at(100, earlierBoot) }, boot),
  ).toEqual(all);
  expect(keptTabs(stored, null, boot)).toEqual(all);
  expect(keptTabs(stored, list, null)).toEqual(all);
});

test("a record of a tab that had already ended goes with the hub's next periodic snapshot", () => {
  // The tab ended at 199 s and the hub's snapshot then lacks it; the app
  // recorded it only at 200 s, so that snapshot cannot drop it.
  const record = [{ id: id(6), recordedAt: at(200) }];
  expect(keptTabs(record, { tabs: [], takenAt: at(199) }, boot)).toEqual([
    id(6),
  ]);
  // The periodic snapshot 30 s later began after the record and lacks it.
  expect(keptTabs(record, { tabs: [], takenAt: at(229) }, boot)).toEqual([]);
});

test("a step of the wall clock changes nothing: a record made after a snapshot began is kept", () => {
  // The snapshot began at boot second 100; the wall clock then stepped back
  // ten seconds; the app recorded a live tab, which the boot clock reads as
  // 100.4. The record is later than the snapshot, so the tab stays.
  const record = [{ id: id(7), recordedAt: at(100.4) }];
  expect(keptTabs(record, { tabs: [], takenAt: at(100) }, boot)).toEqual([
    id(7),
  ]);
});
