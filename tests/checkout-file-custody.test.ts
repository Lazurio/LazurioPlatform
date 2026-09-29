import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  chown,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkoutDirectoryRefusal,
  inspectCheckoutDirectory,
  inspectOwnedDirectory,
} from "../src/folder/owned-directory";
import {
  CheckoutRefused,
  checkoutRefusal,
} from "../src/providers/checkout-custody";
import {
  checkoutFileRefusal,
  readCheckoutFileBytes,
  readCustodiedDeclarationBytes,
} from "../src/providers/owned-json";

// The checkout rule of decision F23 on real files: a file of the operator's
// own checkout is read when it is a regular file of a bounded size owned by
// the operator; its permission bits and link count are not reasons. The
// strict rule of what the product or root writes is unchanged.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
const uid = process.getuid?.() ?? -1;
let root = "";
beforeAll(async () => {
  if (supported)
    root = await realpath(await mkdtemp(join(tmpdir(), "checkout-file-")));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const bytes = Buffer.from('{"name":"fixture"}');
let count = 0;
async function file(mode = 0o644) {
  const directory = join(root, `case-${count++}`);
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "package.json");
  await writeFile(path, bytes, { mode });
  await chmod(path, mode);
  return { directory, path };
}
async function refusal(read: Promise<unknown>) {
  try {
    await read;
  } catch (error) {
    return error instanceof CheckoutRefused ? error.reason : "other";
  }
  return null;
}

posixTest(
  "permission bits are not a reason: 0644, 0664 (umask 002) and 0666 are read",
  async () => {
    for (const mode of [0o600, 0o644, 0o664, 0o666]) {
      const { path } = await file(mode);
      expect(await readCheckoutFileBytes(path)).toEqual(bytes);
    }
  },
);

posixTest(
  "the link count is not a reason: a hard-linked file is read under either name",
  async () => {
    const { directory, path } = await file();
    await link(path, join(directory, "node_modules-copy.json"));
    await link(path, join(directory, "third-name.json"));
    expect(await readCheckoutFileBytes(path)).toEqual(bytes);
    expect(
      await readCheckoutFileBytes(join(directory, "node_modules-copy.json")),
    ).toEqual(bytes);
  },
);

posixTest(
  "not a regular file: a symlink (even to a readable file) and a directory are refused",
  async () => {
    const { directory, path } = await file();
    const linked = join(directory, "linked.json");
    await symlink(path, linked);
    expect(await refusal(readCheckoutFileBytes(linked))).toBe(
      "declaration-not-regular",
    );
    const dangling = join(directory, "dangling.json");
    await symlink(join(directory, "missing.json"), dangling);
    expect(await refusal(readCheckoutFileBytes(dangling))).toBe(
      "declaration-not-regular",
    );
    const folder = join(directory, "folder.json");
    await mkdir(folder, { mode: 0o700 });
    expect(await refusal(readCheckoutFileBytes(folder))).toBe(
      "declaration-not-regular",
    );
  },
);

posixTest("a file larger than 1 MiB is refused; 1 MiB is read", async () => {
  const { directory } = await file();
  const exact = join(directory, "exact.json");
  await writeFile(exact, Buffer.alloc(1024 * 1024, 32), { mode: 0o644 });
  expect((await readCheckoutFileBytes(exact)).length).toBe(1024 * 1024);
  const large = join(directory, "large.json");
  await writeFile(large, Buffer.alloc(1024 * 1024 + 1, 32), { mode: 0o644 });
  expect(await refusal(readCheckoutFileBytes(large))).toBe(
    "declaration-too-large",
  );
});

posixTest(
  "another account's file is refused: read as another expected owner",
  async () => {
    const { path } = await file();
    expect(
      await refusal(readCheckoutFileBytes(path, { expectedUid: uid + 1 })),
    ).toBe("declaration-owner");
    expect(await readCheckoutFileBytes(path, { expectedUid: uid })).toEqual(
      bytes,
    );
  },
);

// A real second owner needs root; without it the rule is tested over a
// faked stat below, and the reader above over another expected owner.
test.skipIf(!supported || uid !== 0)(
  "another account's file is refused (root: a real second owner)",
  async () => {
    const { path } = await file();
    await chown(path, 1, 1);
    expect(await refusal(readCheckoutFileBytes(path, { expectedUid: 0 }))).toBe(
      "declaration-owner",
    );
  },
);

test("the rule over a stat: type first, then owner, then size; mode and links never", () => {
  const stat = (
    overrides: Partial<{ file: boolean; uid: number; size: number }>,
  ) => ({
    isFile: () => overrides.file ?? true,
    uid: overrides.uid ?? 1000,
    size: overrides.size ?? 10,
    // Not part of the rule; present to show they are ignored.
    mode: 0o100666,
    nlink: 7,
  });
  expect(checkoutFileRefusal(stat({}), 1000)).toBeNull();
  expect(checkoutFileRefusal(stat({ uid: 1001 }), 1000)).toBe(
    "declaration-owner",
  );
  expect(checkoutFileRefusal(stat({ uid: 0 }), 1000)).toBe("declaration-owner");
  expect(checkoutFileRefusal(stat({ size: 1024 * 1024 + 1 }), 1000)).toBe(
    "declaration-too-large",
  );
  expect(
    checkoutFileRefusal(stat({ file: false, uid: 0, size: 1 << 30 }), 1000),
  ).toBe("declaration-not-regular");
});

test("a refusal is named relative to its base or home, never by an absolute path", () => {
  const refused = new CheckoutRefused(
    "declaration-owner",
    "/srv/folder/organizations/alpha/workspace/web/app/package.json",
  );
  expect(refused.message).not.toContain("/srv");
  expect(
    checkoutRefusal(refused, "/srv/folder/organizations/alpha/workspace/web"),
  ).toEqual({ reason: "declaration-owner", file: "app/package.json" });
  expect(
    checkoutRefusal(
      new CheckoutRefused("declaration-owner", "/home/operator/.npmrc"),
      "/srv/folder/organizations/alpha/workspace/web",
      "/home/operator",
    ),
  ).toEqual({ reason: "declaration-owner", file: "~/.npmrc" });
  expect(
    checkoutRefusal(
      new CheckoutRefused("declaration-too-large", "/etc/elsewhere/x.json"),
      "/srv/folder",
      "/home/operator",
    ),
  ).toEqual({ reason: "declaration-too-large", file: "x.json" });
  expect(checkoutRefusal(new Error("other"), "/srv/folder")).toBeNull();
});

posixTest(
  "the strict rule of product- and root-written files is unchanged: shared-write, a second link and another owner are refused",
  async () => {
    const accepted = await file(0o644);
    expect(await readCustodiedDeclarationBytes(accepted.path, uid)).toEqual(
      bytes,
    );
    const shared = await file(0o664);
    await expect(
      readCustodiedDeclarationBytes(shared.path, uid),
    ).rejects.toThrow("Unsafe declaration file");
    const linked = await file(0o644);
    await link(linked.path, join(linked.directory, "alias.json"));
    await expect(
      readCustodiedDeclarationBytes(linked.path, uid),
    ).rejects.toThrow("Unsafe declaration file");
    await expect(
      readCustodiedDeclarationBytes(accepted.path, uid + 1),
    ).rejects.toThrow("Unsafe declaration file");
  },
);

posixTest(
  "lockfiles have their own bound: 1 MiB + 1 byte is read, 16 MiB + 1 byte is refused as declaration-too-large",
  async () => {
    const { directory } = await file();
    for (const name of ["bun.lock", "bun.lockb", "package-lock.json"]) {
      const lock = join(directory, name);
      await writeFile(lock, Buffer.alloc(1024 * 1024 + 1, 32), { mode: 0o664 });
      expect((await readCheckoutFileBytes(lock)).length).toBe(1024 * 1024 + 1);
      await writeFile(lock, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
      expect(await refusal(readCheckoutFileBytes(lock))).toBe(
        "declaration-too-large",
      );
    }
    // A declaration of the same size keeps the 1 MiB bound.
    const declaration = join(directory, "package.json");
    await writeFile(declaration, Buffer.alloc(1024 * 1024 + 1, 32));
    expect(await refusal(readCheckoutFileBytes(declaration))).toBe(
      "declaration-too-large",
    );
  },
);

posixTest(
  "checkout directories: write bits are not a reason (0775, 0777); a symlinked directory is refused; the strict rule is unchanged",
  async () => {
    const { directory } = await file();
    for (const mode of [0o700, 0o755, 0o775, 0o777]) {
      await chmod(directory, mode);
      expect((await inspectCheckoutDirectory(directory)).isDirectory()).toBe(
        true,
      );
    }
    // The strict rule of what the product, root or the system writes.
    await expect(inspectOwnedDirectory(directory)).rejects.toThrow(
      "Caller-owned non-shared directory required",
    );
    await chmod(directory, 0o700);
    expect((await inspectOwnedDirectory(directory)).isDirectory()).toBe(true);
    const linked = join(root, `linked-${count++}`);
    await symlink(directory, linked);
    expect(await refusal(inspectCheckoutDirectory(linked))).toBe(
      "directory-not-regular",
    );
    // A path through a symlink is not canonical either.
    await mkdir(join(directory, "inner"), { mode: 0o775 });
    expect(await refusal(inspectCheckoutDirectory(join(linked, "inner")))).toBe(
      "directory-not-regular",
    );
    expect(
      await refusal(inspectCheckoutDirectory(join(directory, "package.json"))),
    ).toBe("directory-not-regular");
  },
);

test("the directory rule over a stat: another owner is directory-owner, write bits never", () => {
  const stat = (directory: boolean, uid: number) => ({
    isDirectory: () => directory,
    uid,
    mode: 0o040777,
  });
  expect(checkoutDirectoryRefusal(stat(true, 1000), 1000)).toBeNull();
  expect(checkoutDirectoryRefusal(stat(true, 1001), 1000)).toBe(
    "directory-owner",
  );
  expect(checkoutDirectoryRefusal(stat(false, 1000), 1000)).toBe(
    "directory-not-regular",
  );
});

test.skipIf(!supported || uid !== 0)(
  "another account's directory is refused (root: a real second owner)",
  async () => {
    const { directory } = await file();
    await chown(directory, 1, 1);
    expect(await refusal(inspectCheckoutDirectory(directory))).toBe(
      "directory-owner",
    );
  },
);
