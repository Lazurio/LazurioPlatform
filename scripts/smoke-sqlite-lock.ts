import { constants, Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// Isolated feasibility test, not a product lock or state format.
assert.ok(
  ["darwin", "linux"].includes(process.platform),
  "Unqualified platform",
);
if (["hold", "contend"].includes(process.argv[2] ?? "")) {
  const databasePath = process.argv[3];
  assert.ok(databasePath && isAbsolute(databasePath));
  if (process.argv[2] === "contend") {
    const gate = Bun.stdin.stream().getReader();
    await gate.read();
    gate.releaseLock();
  }
  const db = new Database(
    databasePath,
    constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (error) {
    if (
      process.argv[2] !== "contend" ||
      (error as { code?: string }).code !== "SQLITE_BUSY"
    )
      throw error;
    console.log("busy");
    db.close(true);
    process.exit(0);
  }
  console.log("held");
  await Bun.stdin.text();
  db.exec("ROLLBACK");
  db.close(true);
} else {
  assert.equal(process.argv.length, 2, "No probe arguments expected");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sqlite-lock-probe-")));
  const path = join(root, "lock.sqlite");
  const db = new Database(path, { create: true });
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserve'); PRAGMA busy_timeout=0;",
    );
    const before = readFileSync(path);
    const alias = join(root, "alias.sqlite");
    symlinkSync(path, alias);
    assert.throws(
      () =>
        new Database(
          alias,
          constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
        ),
      /open|symlink/i,
    );
    assert.deepEqual(readFileSync(path), before);
    const legacy = join(root, "legacy-directory");
    mkdirSync(legacy);
    assert.throws(
      () =>
        new Database(
          legacy,
          constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
        ),
      /open|directory/i,
    );
    const child = Bun.spawn([process.execPath, "hold", path], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const children = [child];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      for (const process of children) process.kill("SIGKILL");
    }, 5000);
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      if (ready.done) throw new Error("Lock holder exited before readiness");
      assert.equal(new TextDecoder().decode(ready.value).trim(), "held");
      reader.releaseLock();
      assert.throws(() => db.exec("BEGIN EXCLUSIVE"), /locked/);
      child.kill("SIGKILL");
      await child.exited;
      assert.equal(timedOut, false, "Probe watchdog expired");
      assert.equal(child.signalCode, "SIGKILL", "Holder did not die by signal");
      db.exec("BEGIN EXCLUSIVE");
      assert.deepEqual(db.query("SELECT value FROM sentinel").all(), [
        { value: "preserve" },
      ]);
      db.exec("ROLLBACK");
      const contenders: typeof children = [];
      const outcomes: string[] = [];
      for (let index = 0; index < 2; index++) {
        const contender = Bun.spawn([process.execPath, "contend", path], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        children.push(contender);
        contenders.push(contender);
        // Complete acquisition before the next process opens SQLite. Concurrent
        // database opens can themselves contend; that is not a lock takeover test.
        contender.stdin.write("go\n");
        await contender.stdin.flush();
        const reader = contender.stdout.getReader();
        const result = await reader.read();
        reader.releaseLock();
        assert.equal(result.done, false, "Contender exited before outcome");
        const outcome = new TextDecoder().decode(result.value).trim();
        assert.equal(outcome, index === 0 ? "held" : "busy");
        outcomes.push(outcome);
      }
      assert.deepEqual([...outcomes].sort(), ["busy", "held"]);
      const winner = contenders[outcomes.indexOf("held")];
      const loser = contenders[outcomes.indexOf("busy")];
      assert.ok(winner && loser);
      assert.equal(await loser.exited, 0, "Rejected contender failed");
      // Readiness output alone does not prove the winner still owns the lock.
      assert.throws(() => db.exec("BEGIN EXCLUSIVE"), /locked/);
      winner.kill("SIGKILL");
      await winner.exited;
      assert.equal(timedOut, false, "Probe watchdog expired");
      assert.equal(
        winner.signalCode,
        "SIGKILL",
        "Winner did not die by signal",
      );
      db.exec("BEGIN EXCLUSIVE");
      assert.deepEqual(db.query("SELECT value FROM sentinel").all(), [
        { value: "preserve" },
      ]);
      db.exec("ROLLBACK");
      console.log(
        "PASS: competing process excluded; SIGKILL releases transaction lock; sentinel retained",
      );
      console.log(
        "PASS: confirmed post-crash holder excludes the next contender; subsequent acquisition succeeds",
      );
      console.log(
        "PASS: NOFOLLOW refuses symlink target and legacy directory without modifying database bytes",
      );
    } finally {
      clearTimeout(timer);
      for (const process of children) process.kill("SIGKILL");
      await Promise.all(children.map((process) => process.exited));
    }
  } finally {
    db.close(true);
    rmSync(root, { recursive: true });
  }
}
