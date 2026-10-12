import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  lstat,
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
import {
  addDeviceKey,
  addedByLabel,
  deviceName,
  type KeysLocation,
  listKeys,
  markerComment,
  parseDeviceKey,
  parseKeyLine,
  parseMarker,
  removeDeviceKey,
} from "../src/ssh-access/keys";

// SSH from the person's devices (decision F49): `authorized_keys` of the
// Launchpad's account is the one truth. The Launchpad adds a device's key
// with its marker, lists every line, removes only its own lines, and keeps
// every other byte. Every test runs in a temporary home; the real `~/.ssh`
// is never read or written.

const posix = process.platform !== "win32";

// A key ssh-keygen created for this test (its private half was discarded)
// and the fingerprint `ssh-keygen -lf` printed for it.
const knownKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSQ6IIHQipQN9YXjjwhCNuecXaQZ6xS2/QbEsUFltVy alex@alex-laptop";
const knownFingerprint = "SHA256:o/4CeG0P+h9I7TE9MUuHkiJxKeDhAX4agiNUhz2gZsM";

const wire = (bytes: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};
/** A structurally complete ed25519 public key whose 32 bytes are `seed`. */
function edKey(seed: number, type = "ssh-ed25519"): string {
  const parts = [
    wire(Buffer.from(type)),
    wire(Buffer.alloc(32, seed)),
    ...(type === "sk-ssh-ed25519@openssh.com"
      ? [wire(Buffer.from("ssh:"))]
      : []),
  ];
  return `${type} ${Buffer.concat(parts).toString("base64")}`;
}
const keyOf = (line: string) => {
  const parsed = parseDeviceKey(line);
  if ("refused" in parsed) throw new Error(parsed.refused);
  return parsed;
};

async function home(): Promise<{
  location: KeysLocation;
  done: () => Promise<void>;
}> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "ssh-access-")),
  );
  return {
    location: { home: directory, uid: process.getuid?.() },
    done: () => rm(directory, { recursive: true, force: true }),
  };
}
const keysPath = (location: KeysLocation) =>
  join(location.home, ".ssh", "authorized_keys");
const add = (
  location: KeysLocation,
  line: string,
  device = "alex-laptop",
  addedBy = "alex",
) =>
  addDeviceKey(location, {
    key: keyOf(line),
    device,
    addedBy,
    date: "2026-10-12",
  });

test("the fingerprint is ssh-keygen's: SHA256 of the decoded key, unpadded", () => {
  expect(keyOf(knownKey)).toEqual({
    type: "ssh-ed25519",
    key: "AAAAC3NzaC1lZDI1NTE5AAAAIDSQ6IIHQipQN9YXjjwhCNuecXaQZ6xS2/QbEsUFltVy",
    fingerprint: knownFingerprint,
  });
});

test.skipIf(
  !posix ||
    spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error !== undefined,
)(
  "a key ssh-keygen creates now has the fingerprint ssh-keygen -lf prints",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ssh-keygen-"));
    try {
      const file = join(directory, "device");
      const created = spawnSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "alex@alex-laptop",
        "-f",
        file,
      ]);
      expect(created.status).toBe(0);
      const printed = spawnSync("ssh-keygen", ["-lf", `${file}.pub`], {
        encoding: "utf8",
      });
      expect(printed.status).toBe(0);
      const fingerprint = printed.stdout.split(" ")[1];
      expect(keyOf(await readFile(`${file}.pub`, "utf8")).fingerprint).toBe(
        fingerprint as string,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a device registers exactly one ed25519 public key line; its comment is dropped", () => {
  expect(keyOf(`${edKey(1)}\n`).type).toBe("ssh-ed25519");
  expect(keyOf(`  ${edKey(1)}   alex@laptop with words  \r\n`).key).toBe(
    edKey(1).split(" ")[1] as string,
  );
  expect(keyOf(edKey(2, "sk-ssh-ed25519@openssh.com")).type).toBe(
    "sk-ssh-ed25519@openssh.com",
  );
  const refused = (raw: unknown) => {
    const parsed = parseDeviceKey(raw);
    return "refused" in parsed ? parsed.refused : "accepted";
  };
  expect(refused("")).toBe("key-missing");
  expect(refused("  \n ")).toBe("key-missing");
  expect(refused(42)).toBe("key-missing");
  // Built here so that no file of this repository looks like a private key.
  const privateHeader = ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ");
  expect(refused(`${privateHeader}\nb3BlbnNzaC1rZXktdjEAAAAA\n`)).toBe(
    "private-key",
  );
  expect(refused("PuTTY-User-Key-File-3: ssh-ed25519")).toBe("private-key");
  expect(refused(`${edKey(1)}\n${edKey(2)}`)).toBe("multiple-lines");
  expect(refused(`command="echo hi" ${edKey(1)}`)).toBe("options-not-allowed");
  expect(refused(`from="10.0.0.1",no-pty ${edKey(1)} x`)).toBe(
    "options-not-allowed",
  );
  expect(refused(`restrict ${edKey(1)}`)).toBe("options-not-allowed");
  expect(
    refused(
      "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBDt/uz2z/vRTCuQwz59G87rfyWruWZPmWxFXLwXBFEI6dqy+5UKFLy9YqT1wcIeht9zML930iB07gr1rdbRfks8= alex@alex-laptop",
    ),
  ).toBe("unsupported-type");
  expect(refused("ssh-rsa AAAAB3NzaC1yc2E alex")).toBe("unsupported-type");
  expect(refused("ssh-ed25519")).toBe("invalid-key");
  expect(refused("ssh-ed25519 not*base64")).toBe("invalid-key");
  // A key of another type behind the ed25519 name.
  expect(
    refused(
      `ssh-ed25519 ${edKey(2, "sk-ssh-ed25519@openssh.com").split(" ")[1]}`,
    ),
  ).toBe("invalid-key");
  // Cut short, and with bytes after the key.
  const full = Buffer.from(edKey(3).split(" ")[1] as string, "base64");
  expect(
    refused(`ssh-ed25519 ${full.subarray(0, 40).toString("base64")}`),
  ).toBe("invalid-key");
  expect(
    refused(
      `ssh-ed25519 ${Buffer.concat([full, Buffer.from([0])]).toString("base64")}`,
    ),
  ).toBe("invalid-key");
  expect(refused("hello world")).toBe("not-a-public-key");
});

test("a device's name and who added it are written as the marker allows", () => {
  expect(deviceName("Alexův MacBook Pro")).toBe("alexuv-macbook-pro");
  expect(deviceName("  alex_laptop.local ")).toBe("alex-laptop-local");
  expect(deviceName("a".repeat(60))).toBe("a".repeat(40));
  expect(deviceName(`${"a".repeat(39)}-b`)).toBe("a".repeat(39));
  expect(deviceName(" --- ")).toBeNull();
  expect(deviceName("")).toBeNull();
  expect(deviceName(7)).toBeNull();
  expect(addedByLabel(undefined)).toBe("local");
  expect(addedByLabel(null)).toBe("local");
  expect(addedByLabel("Alex-Example")).toBe("alex-example");
  expect(addedByLabel("alex:admin")).toBeNull();
  expect(addedByLabel("")).toBeNull();
  const comment = markerComment("alex-laptop", "alex", "2026-10-12");
  expect(comment).toBe("lazurio-device:alex-laptop:alex:2026-10-12");
  expect(parseMarker(comment)).toEqual({
    device: "alex-laptop",
    addedBy: "alex",
    added: "2026-10-12",
  });
  expect(parseMarker("lazurio-device:Alex:alex:2026-10-12")).toBeNull();
  expect(parseMarker(`${comment} more`)).toBeNull();
});

test("authorized_keys lines: comments, keys with and without options, unreadable", () => {
  expect(parseKeyLine("")).toEqual({ kind: "other" });
  expect(parseKeyLine("  # provisioning key below")).toEqual({ kind: "other" });
  expect(parseKeyLine(`${edKey(1)} ops@provisioning\r`)).toEqual({
    kind: "key",
    type: "ssh-ed25519",
    key: edKey(1).split(" ")[1] as string,
    comment: "ops@provisioning",
    options: false,
  });
  expect(
    parseKeyLine(`command="echo \\"a b\\"",no-pty ${edKey(2)} restricted one`),
  ).toMatchObject({ kind: "key", options: true, comment: "restricted one" });
  expect(parseKeyLine('command="never closed ssh-ed25519 AAAA')).toEqual({
    kind: "unreadable",
  });
  expect(parseKeyLine("not a key at all")).toEqual({ kind: "unreadable" });
});

test.skipIf(!posix)(
  "a device is added, listed and removed; the file is created owner-only",
  async () => {
    const { location, done } = await home();
    try {
      expect(await listKeys(location)).toEqual({ keys: [] });
      const added = await add(location, knownKey);
      expect(added).toEqual({
        kind: "ssh-key-added",
        outcome: "added",
        key: {
          origin: "launchpad",
          type: "ssh-ed25519",
          fingerprint: knownFingerprint,
          device: "alex-laptop",
          addedBy: "alex",
          added: "2026-10-12",
        },
      });
      expect(await readFile(keysPath(location), "utf8")).toBe(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSQ6IIHQipQN9YXjjwhCNuecXaQZ6xS2/QbEsUFltVy lazurio-device:alex-laptop:alex:2026-10-12\n",
      );
      expect((await lstat(join(location.home, ".ssh"))).mode & 0o777).toBe(
        0o700,
      );
      expect((await lstat(keysPath(location))).mode & 0o777).toBe(0o600);
      if (added.kind !== "ssh-key-added") throw new Error(added.reason);
      expect(await listKeys(location)).toEqual({ keys: [added.key] });
      expect(await removeDeviceKey(location, knownFingerprint)).toEqual({
        kind: "ssh-key-removed",
        key: {
          origin: "launchpad",
          type: "ssh-ed25519",
          fingerprint: knownFingerprint,
          device: "alex-laptop",
          addedBy: "alex",
          added: "2026-10-12",
        },
        stillAllowed: false,
      });
      expect(await readFile(keysPath(location), "utf8")).toBe("");
      // Nothing but the file itself is left in ~/.ssh.
      expect(await readdir(join(location.home, ".ssh"))).toEqual([
        "authorized_keys",
      ]);
    } finally {
      await done();
    }
  },
);

test.skipIf(!posix)(
  "every line added outside Launchpad stays byte for byte, and is never removed",
  async () => {
    const { location, done } = await home();
    try {
      await mkdir(join(location.home, ".ssh"), { mode: 0o700 });
      const foreign = [
        "# provisioning key, do not remove",
        `${edKey(1)} ops@provisioning`,
        "",
        `command="echo \\"a b\\"",no-pty ${edKey(2)} restricted`,
        `${edKey(3)} lazurio-device:by-hand:alex:2026-10-01\r`,
        `from="10.0.0.1" ${edKey(4)} lazurio-device:with-options:alex:2026-10-01`,
        "garbage line with ünïcödé",
        `${edKey(5)}`,
      ].join("\n");
      await writeFile(keysPath(location), foreign, { mode: 0o644 });
      const listed = await listKeys(location);
      if (!("keys" in listed)) throw new Error("not listed");
      // A marker with a carriage return after it, or behind options, is
      // not the Launchpad's own line.
      expect(listed.keys.map((key) => key.origin)).toEqual([
        "outside",
        "outside",
        "launchpad",
        "outside",
        "outside",
        "outside",
      ]);
      expect(listed.keys[0]).toMatchObject({ comment: "ops@provisioning" });
      expect(listed.keys[4]).toEqual({
        origin: "outside",
        type: null,
        fingerprint: null,
        comment: null,
      });
      expect(listed.keys[5]).toMatchObject({ comment: null });
      // Added at the end; the last line gets the newline it lacked.
      await add(location, knownKey, "alex-laptop");
      const withDevice = `${foreign}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSQ6IIHQipQN9YXjjwhCNuecXaQZ6xS2/QbEsUFltVy lazurio-device:alex-laptop:alex:2026-10-12\n`;
      expect(await readFile(keysPath(location), "utf8")).toBe(withDevice);
      expect((await lstat(keysPath(location))).mode & 0o777).toBe(0o600);
      // A key added outside Launchpad is refused and stays.
      for (const seed of [1, 2, 4, 5]) {
        const fingerprint = keyOf(edKey(seed)).fingerprint;
        expect(await removeDeviceKey(location, fingerprint)).toEqual({
          kind: "blocked",
          reason: "not-launchpad-key",
        });
      }
      expect(
        await removeDeviceKey(location, keyOf(edKey(9)).fingerprint),
      ).toEqual({ kind: "blocked", reason: "not-found" });
      expect(await readFile(keysPath(location), "utf8")).toBe(withDevice);
      // Its own line goes; every other byte stays.
      await removeDeviceKey(location, knownFingerprint);
      expect(await readFile(keysPath(location), "utf8")).toBe(`${foreign}\n`);
    } finally {
      await done();
    }
  },
);

test.skipIf(!posix)(
  "adding a key that is already allowed changes nothing and answers its line",
  async () => {
    const { location, done } = await home();
    try {
      await add(location, knownKey);
      const before = await readFile(keysPath(location));
      // Retried by an agent, under another name and comment.
      expect(
        await add(
          location,
          `${knownKey.split(" ").slice(0, 2).join(" ")} x`,
          "other",
        ),
      ).toMatchObject({
        kind: "ssh-key-added",
        outcome: "already-present",
        key: { origin: "launchpad", device: "alex-laptop" },
      });
      expect(await readFile(keysPath(location))).toEqual(before);
      // A key a line outside Launchpad already allows.
      await writeFile(
        keysPath(location),
        `${before.toString()}${edKey(6)} by-hand\n`,
      );
      const withForeign = await readFile(keysPath(location));
      expect(await add(location, edKey(6))).toMatchObject({
        outcome: "already-present",
        key: { origin: "outside", comment: "by-hand" },
      });
      expect(await readFile(keysPath(location))).toEqual(withForeign);
    } finally {
      await done();
    }
  },
);

test.skipIf(!posix)(
  "removing the Launchpad's line says when a line outside it still allows the key",
  async () => {
    const { location, done } = await home();
    try {
      await add(location, knownKey);
      const own = await readFile(keysPath(location), "utf8");
      await writeFile(keysPath(location), `${own}${knownKey}\n`);
      expect(await removeDeviceKey(location, knownFingerprint)).toMatchObject({
        kind: "ssh-key-removed",
        stillAllowed: true,
      });
      expect(await readFile(keysPath(location), "utf8")).toBe(`${knownKey}\n`);
    } finally {
      await done();
    }
  },
);

test.skipIf(!posix)(
  "a linked file or directory, or one of another account, is refused and untouched",
  async () => {
    const { location, done } = await home();
    try {
      const directory = join(location.home, ".ssh");
      await mkdir(directory, { mode: 0o700 });
      const elsewhere = join(location.home, "elsewhere");
      await writeFile(elsewhere, `${edKey(1)} target\n`);
      await symlink(elsewhere, keysPath(location));
      expect(await listKeys(location)).toEqual({
        refused: "authorized-keys-symlink",
      });
      expect(await add(location, knownKey)).toEqual({
        kind: "blocked",
        reason: "authorized-keys-symlink",
      });
      expect(
        await removeDeviceKey(location, keyOf(edKey(1)).fingerprint),
      ).toEqual({ kind: "blocked", reason: "authorized-keys-symlink" });
      expect(await readFile(elsewhere, "utf8")).toBe(`${edKey(1)} target\n`);
      expect((await lstat(keysPath(location))).isSymbolicLink()).toBe(true);
      await rm(keysPath(location));
      // Not a regular file.
      await mkdir(keysPath(location));
      expect(await add(location, knownKey)).toEqual({
        kind: "blocked",
        reason: "authorized-keys-not-file",
      });
      await rm(keysPath(location), { recursive: true });
      // Owned by another account (the uid the Launchpad runs as differs).
      await writeFile(keysPath(location), `${edKey(1)} target\n`);
      const other = { ...location, uid: (location.uid ?? 0) + 1 };
      expect(await add(other, knownKey)).toEqual({
        kind: "blocked",
        reason: "authorized-keys-foreign-owner",
      });
      expect(await listKeys(other)).toEqual({
        refused: "authorized-keys-foreign-owner",
      });
      expect(await readFile(keysPath(location), "utf8")).toBe(
        `${edKey(1)} target\n`,
      );
      // ~/.ssh itself a link.
      await rm(directory, { recursive: true });
      const real = join(location.home, "real-ssh");
      await mkdir(real, { mode: 0o700 });
      await symlink(real, directory);
      expect(await listKeys(location)).toEqual({
        refused: "ssh-directory-unsafe",
      });
      expect(await add(location, knownKey)).toEqual({
        kind: "blocked",
        reason: "ssh-directory-unsafe",
      });
      expect(await readdir(real)).toEqual([]);
    } finally {
      await done();
    }
  },
);

test.skipIf(!posix)(
  "concurrent additions are serialized: every key is written once",
  async () => {
    const { location, done } = await home();
    try {
      const results = await Promise.all(
        [11, 12, 13, 14, 15, 11].map((seed, index) =>
          add(location, edKey(seed), `device-${index}`),
        ),
      );
      expect(
        results.map((result) =>
          result.kind === "ssh-key-added" ? result.outcome : result.reason,
        ),
      ).toEqual([
        "added",
        "added",
        "added",
        "added",
        "added",
        "already-present",
      ]);
      const listed = await listKeys(location);
      if (!("keys" in listed)) throw new Error("not listed");
      expect(listed.keys.length).toBe(5);
      expect(
        (await readFile(keysPath(location), "utf8")).split("\n").length,
      ).toBe(6);
    } finally {
      await done();
    }
  },
);
