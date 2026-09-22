import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { closeOnExecFlag, lockDirectoryDescriptor } from "./native-lock";
import { inspectOwnedDirectory } from "./owned-directory";

const marker = "lazurio-directory-flock-v1\n";

// One persistent inode per explicit owner. Never unlink it: a waiter may still
// reference it, producing two lock domains. Unmarked old locks stay refused.
export async function acquireFolderOperationLock(stateDirectory: string) {
  const cloexec = closeOnExecFlag();
  const parent = await inspectOwnedDirectory(stateDirectory);
  const filesystem = await statfs(stateDirectory);
  if (
    (process.platform === "darwin" && filesystem.type !== 26) ||
    (process.platform === "linux" && filesystem.type !== 0xef53)
  )
    // The observed type is named so an unqualified runner or mount can be
    // identified from the failure itself.
    throw new Error(
      `Unqualified lock filesystem (${process.platform} type ${filesystem.type})`,
    );
  const path = join(stateDirectory, ".operation-lock");
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const observed = await inspectOwnedDirectory(path);
  if (!created && !(await readdir(path)).includes("protocol"))
    throw new Error(
      "Folder operation busy or requires recovery; unrecognized lock",
    );
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | cloexec,
  );
  let released = false;
  try {
    const opened = await handle.stat();
    const assertIdentity = async () => {
      if (released) throw new Error("Folder operation lock released");
      const currentParent = await inspectOwnedDirectory(stateDirectory);
      const current = await inspectOwnedDirectory(path);
      if (
        currentParent.dev !== parent.dev ||
        currentParent.ino !== parent.ino ||
        opened.dev !== parent.dev ||
        opened.dev !== observed.dev ||
        opened.ino !== observed.ino ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      )
        throw new Error("Folder operation lock changed; recovery required");
    };
    await assertIdentity();
    lockDirectoryDescriptor(handle.fd);
    if (created) {
      // Interrupted initialization stays unrecognized, never adopted on retry.
      await assertIdentity();
      const file = await open(join(path, "protocol"), "wx", 0o600);
      try {
        await file.writeFile(marker);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const assertHeld = async () => {
      await assertIdentity();
      const entries = await readdir(path);
      if (entries.length !== 1 || entries[0] !== "protocol")
        throw new Error(
          "Folder operation busy or requires recovery; unrecognized lock",
        );
      const file = await open(
        join(path, "protocol"),
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          cloexec,
      );
      try {
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== process.getuid?.() ||
          (before.mode & 0o022) !== 0 ||
          before.dev !== opened.dev ||
          before.size !== Buffer.byteLength(marker)
        )
          throw new Error("Unsafe lock protocol; recovery required");
        const bytes = Buffer.alloc(Buffer.byteLength(marker));
        const read = await file.read(bytes, 0, bytes.length, 0);
        const after = await lstat(join(path, "protocol"));
        if (
          read.bytesRead !== bytes.length ||
          bytes.toString() !== marker ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.ctimeMs !== before.ctimeMs ||
          after.size !== before.size
        )
          throw new Error("Lock protocol changed; recovery required");
      } finally {
        await file.close();
      }
      await assertIdentity();
    };
    await assertHeld();
    await handle.sync();
    const parentHandle = await open(
      stateDirectory,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        cloexec,
    );
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
    return Object.freeze({
      assertHeld,
      async release() {
        try {
          await assertHeld();
        } finally {
          released = true;
          await handle.close();
        }
      },
    });
  } catch (error) {
    released = true;
    await handle.close();
    throw error;
  }
}

export async function withFolderOperationLock<T>(
  stateDirectory: string,
  operation: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lock = await acquireFolderOperationLock(stateDirectory);
  try {
    return await operation(lock.assertHeld);
  } finally {
    await lock.release();
  }
}
