import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectOwnedDirectory } from "../src/folder/owned-directory";
import { createOwnerOperations } from "../src/modules/owner-operations";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "slow custody inspection cannot reorder install and start admission",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "owner-admission-")),
    );
    const waiting = gate();
    const release = gate();
    const events: string[] = [];
    let checks = 0;
    const queue = createOwnerOperations(async (path) => {
      const stat = await inspectOwnedDirectory(path);
      if (++checks === 1) {
        waiting.release();
        await release.promise;
      }
      return stat;
    });
    try {
      const install = queue.run(root, async () => {
        events.push("install");
      });
      await waiting.promise;
      const start = queue.run(root, async () => {
        events.push("start");
      });
      release.release();
      await Promise.all([install, start]);
      expect(events).toEqual(["install", "start"]);
    } finally {
      release.release();
      await queue.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "owner queue serializes conflicting work, drains failures and preserves independent owners",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "owner-operations-")),
    );
    const one = join(root, "one");
    const two = join(root, "two");
    await mkdir(one, { mode: 0o700 });
    await mkdir(two, { mode: 0o700 });
    const queue = createOwnerOperations();
    const started = gate();
    const finish = gate();
    const events: string[] = [];
    try {
      const first = queue.run(one, async () => {
        events.push("install");
        started.release();
        await finish.promise;
        throw new Error("fixture install failure");
      });
      const failure = first.catch((error) => (error as Error).message);
      await started.promise;
      const second = queue.run(one, async () => {
        events.push("start");
        return "started";
      });
      await queue.run(two, async () => {
        events.push("other-owner");
      });
      expect(events).toEqual(["install", "other-owner"]);
      finish.release();
      expect(await failure).toBe("fixture install failure");
      expect(await second).toBe("started");
      expect(events).toEqual(["install", "other-owner", "start"]);
      await queue.close();
      await expect(queue.run(one, async () => "unexpected")).rejects.toThrow(
        "closing",
      );
    } finally {
      finish.release();
      await queue.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "owner queue refuses aliases and replaced queued owners before invoking work",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "owner-replaced-")),
    );
    const owner = join(root, "owner");
    await mkdir(owner, { mode: 0o700 });
    const observed = gate();
    let ownerInspections = 0;
    const queue = createOwnerOperations(async (path) => {
      const stat = await inspectOwnedDirectory(path);
      if (path === owner && ++ownerInspections === 3) observed.release();
      return stat;
    });
    const started = gate();
    const finish = gate();
    try {
      const alias = join(root, "alias");
      await symlink(owner, alias);
      await expect(queue.run(alias, async () => true)).rejects.toThrow();
      const first = queue.run(owner, async () => {
        started.release();
        await finish.promise;
      });
      await started.promise;
      let invoked = false;
      const second = queue.run(owner, async () => {
        invoked = true;
      });
      await observed.promise;
      await rename(owner, join(root, "retained-owner"));
      await mkdir(owner, { mode: 0o700 });
      finish.release();
      await first;
      await expect(second).rejects.toThrow("changed");
      expect(invoked).toBe(false);
      // A renamed scope cannot safely release its old lock by the new path.
      await expect(queue.close()).rejects.toThrow();
    } finally {
      finish.release();
      await queue.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "dependency exclusion survives action return and drain until confirmed close",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "owner-retained-")),
    );
    const first = createOwnerOperations();
    const second = createOwnerOperations();
    try {
      await first.run(root, async () => "started");
      await expect(second.run(root, async () => "unsafe")).rejects.toThrow(
        "busy",
      );
      await first.drain();
      await expect(second.run(root, async () => "unsafe")).rejects.toThrow(
        "busy",
      );
      await first.close();
      expect(await second.run(root, async () => "safe")).toBe("safe");
    } finally {
      await first.close();
      await second.close();
      await rm(root, { recursive: true });
    }
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "close drains accepted operations and refuses work still in custody inspection",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "owner-close-")));
    const inspected = gate();
    const proceed = gate();
    let checks = 0;
    const queue = createOwnerOperations(async (path) => {
      const stat = await inspectOwnedDirectory(path);
      if (++checks === 1) {
        inspected.release();
        await proceed.promise;
      }
      return stat;
    });
    let invoked = false;
    try {
      const pending = queue.run(root, async () => {
        invoked = true;
      });
      const rejected = pending.catch((error) => (error as Error).message);
      await inspected.promise;
      await queue.close();
      proceed.release();
      expect(await rejected).toBe("Owner operations closing");
      expect(invoked).toBe(false);
      const live = createOwnerOperations();
      const started = gate();
      const finish = gate();
      const operation = live.run(root, async () => {
        started.release();
        await finish.promise;
      });
      await started.promise;
      let closed = false;
      const closing = live.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      finish.release();
      await operation;
      await closing;
      expect(closed).toBe(true);
    } finally {
      proceed.release();
      await queue.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
