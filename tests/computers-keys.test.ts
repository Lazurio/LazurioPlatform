import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addComputerKey,
  addDeviceKey,
  computerKeyLine,
  type KeysLocation,
  listComputerKeys,
  listKeys,
  parseComputerLine,
  parseDeviceKey,
  removeComputerKey,
  removeDeviceKey,
} from "../src/ssh-access/keys";

// A person's computer for agents (decision F73): its key may only run the
// forced command `lazurio computer attach`. Its line is added, listed and
// removed by its id; F49's page neither lists nor removes it, and every
// other line of `authorized_keys` stays byte for byte. Every test runs in a
// temporary home.

const posix = process.platform !== "win32";
const wire = (bytes: Buffer) =>
  Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
const keyOf = (seed: number) =>
  `ssh-ed25519 ${Buffer.concat([wire(Buffer.from("ssh-ed25519")), wire(Buffer.alloc(32, seed))]).toString("base64")}`;
const entry = "/home/alex/.local/bin/lazurio";

function parsed(seed: number) {
  const key = parseDeviceKey(keyOf(seed));
  if ("refused" in key || key.type !== "ssh-ed25519") throw new Error("key");
  return {
    type: "ssh-ed25519" as const,
    key: key.key,
    fingerprint: key.fingerprint,
  };
}

async function withHome(
  run: (location: KeysLocation, file: string) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "lazurio-computer-keys-"));
  try {
    await run(
      { home, uid: process.getuid?.() },
      join(home, ".ssh", "authorized_keys"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a computer's line is exactly restricted to its forced command", () => {
  const line = computerKeyLine({
    key: parsed(1),
    entry,
    device: "alex-macbook",
    addedBy: "alex",
    date: "2026-11-12",
  });
  expect(line).toBe(
    `restrict,command="${entry} computer attach --device alex-macbook" ${keyOf(1)} lazurio-computer:alex-macbook:alex:2026-11-12`,
  );
  expect(parseComputerLine(line)).toMatchObject({
    device: "alex-macbook",
    addedBy: "alex",
    added: "2026-11-12",
    entry,
    fingerprint: parsed(1).fingerprint,
  });
  // The command and the marker must name the same computer, with exactly
  // these options and nothing more.
  expect(
    parseComputerLine(line.replace("--device alex-macbook", "--device other")),
  ).toBeNull();
  expect(
    parseComputerLine(line.replace("restrict,", "restrict,pty,")),
  ).toBeNull();
  expect(parseComputerLine(line.replace("restrict,", ""))).toBeNull();
  expect(parseComputerLine(line.replace(entry, "lazurio"))).toBeNull();
  expect(() =>
    computerKeyLine({
      key: parsed(1),
      entry: '/bin/sh" x',
      device: "alex-macbook",
      addedBy: "alex",
      date: "2026-11-12",
    }),
  ).toThrow();
});

test.skipIf(!posix)(
  "adds, lists and removes a computer, keeping every other line",
  () =>
    withHome(async (location, file) => {
      await mkdir(join(location.home, ".ssh"), { mode: 0o700 });
      const before = `# provisioning\n${keyOf(9)} provisioning@host\n`;
      await writeFile(file, before, { mode: 0o600 });
      const added = await addComputerKey(location, {
        key: parsed(1),
        entry,
        device: "alex-macbook",
        addedBy: "alex",
        date: "2026-11-12",
      });
      expect(added).toMatchObject({
        kind: "computer-key-added",
        outcome: "added",
      });
      // The same key on the same id again: nothing written.
      const again = await addComputerKey(location, {
        key: parsed(1),
        entry,
        device: "alex-macbook",
        addedBy: "alex",
        date: "2026-11-13",
      });
      expect(again).toMatchObject({ outcome: "already-present" });
      // Another key on the same id, or the same key on another id: refused.
      expect(
        await addComputerKey(location, {
          key: parsed(2),
          entry,
          device: "alex-macbook",
          addedBy: "alex",
          date: "2026-11-12",
        }),
      ).toEqual({ kind: "blocked", reason: "device-taken" });
      expect(
        await addComputerKey(location, {
          key: parsed(1),
          entry,
          device: "alex-windows",
          addedBy: "alex",
          date: "2026-11-12",
        }),
      ).toEqual({ kind: "blocked", reason: "key-in-use" });
      // A key that already signs in without restriction is never a
      // computer's: sshd would reach the open line first.
      expect(
        await addComputerKey(location, {
          key: parsed(9),
          entry,
          device: "alex-windows",
          addedBy: "alex",
          date: "2026-11-12",
        }),
      ).toEqual({ kind: "blocked", reason: "key-in-use" });

      const listed = await listComputerKeys(location);
      expect(
        "computers" in listed && listed.computers.map((c) => c.device),
      ).toEqual(["alex-macbook"]);
      // F49's page does not list the computer, and cannot remove it or add
      // its key as an ordinary sign-in.
      const f49 = await listKeys(location);
      expect("keys" in f49 && f49.keys.length).toBe(1);
      expect(await removeDeviceKey(location, parsed(1).fingerprint)).toEqual({
        kind: "blocked",
        reason: "not-launchpad-key",
      });
      expect(
        await addDeviceKey(location, {
          key: parsed(1),
          device: "alex-macbook",
          addedBy: "alex",
          date: "2026-11-12",
        }),
      ).toEqual({ kind: "blocked", reason: "key-restricted-outside" });

      expect(await removeComputerKey(location, "alex-macbook")).toMatchObject({
        kind: "computer-key-removed",
      });
      expect(await readFile(file, "utf8")).toBe(before);
      expect(await removeComputerKey(location, "alex-macbook")).toEqual({
        kind: "blocked",
        reason: "not-found",
      });
    }),
);
