import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSshComputers } from "../src/computers/computers";
import { readRecord, recordPath } from "../src/computers/state";
import {
  addDeviceKey,
  type KeysLocation,
  listComputerKeys,
  listKeys,
  parseComputerLine,
  parseDeviceKey,
  removeComputerKey,
  removeDeviceKey,
} from "../src/ssh-access/keys";

// The old SSH path of a person's computer (contract v0, decision F75 before
// its addendum of 2026-11-13): nothing writes its restricted line any more,
// and since contract v3 a computer attaches only through the gateway. The
// installed Launchpad removes such a line, since it would let a computer
// around the gateway; F49's page neither lists nor removes it, and every
// other line of `authorized_keys` stays byte for byte. Every test runs in a
// temporary home.

const posix = process.platform !== "win32";
const wire = (bytes: Buffer) =>
  Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
const keyOf = (seed: number) =>
  `ssh-ed25519 ${Buffer.concat([wire(Buffer.from("ssh-ed25519")), wire(Buffer.alloc(32, seed))]).toString("base64")}`;
const entry = "/home/alex/.local/bin/lazurio";
const legacyLine = (seed: number, device: string) =>
  `restrict,command="${entry} computer attach --device ${device}" ${keyOf(seed)} lazurio-computer:${device}:alex:2026-11-12`;

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
    await mkdir(join(home, ".ssh"), { mode: 0o700 });
    await run(
      { home, uid: process.getuid?.() },
      join(home, ".ssh", "authorized_keys"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a computer's old line is read only in its exact restricted shape", () => {
  const line = legacyLine(1, "alex-macbook");
  expect(parseComputerLine(line)).toEqual({
    device: "alex-macbook",
    addedBy: "alex",
    added: "2026-11-12",
    key: parsed(1).key,
    fingerprint: parsed(1).fingerprint,
  });
  expect(
    parseComputerLine(line.replace("--device alex-macbook", "--device other")),
  ).toBeNull();
  expect(
    parseComputerLine(line.replace("restrict,", "restrict,pty,")),
  ).toBeNull();
  expect(parseComputerLine(line.replace("restrict,", ""))).toBeNull();
  expect(parseComputerLine(line.replace(entry, "lazurio"))).toBeNull();
});

test.skipIf(!posix)(
  "F49 leaves an old computer's line alone; removing it keeps every other byte",
  () =>
    withHome(async (location, file) => {
      const before = `# provisioning\n${keyOf(9)} provisioning@host\n`;
      await writeFile(file, `${before}${legacyLine(1, "alex-macbook")}\n`, {
        mode: 0o600,
      });
      const listed = await listComputerKeys(location);
      expect(
        "computers" in listed && listed.computers.map((c) => c.device),
      ).toEqual(["alex-macbook"]);
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

test.skipIf(!posix)(
  "the cleanup takes every old computer's line out, and leaves every other byte and its record",
  () =>
    withHome(async (location, file) => {
      // Lines of every kind around them, CRLF and a missing final newline
      // included: they stay exactly as they are.
      const before = `# provisioning\r\n${keyOf(9)} provisioning@host\n\n`;
      const between = `restrict ${keyOf(8)} someone-else\n`;
      const after = `${keyOf(7)} last-line-without-newline`;
      await writeFile(
        file,
        `${before}${legacyLine(1, "alex-macbook")}\n${between}${legacyLine(2, "alex-windows")}\n${legacyLine(3, "alex-macbook")}\n${after}`,
        { mode: 0o600 },
      );
      // An old record stays: the computer's next attach over the gateway
      // keeps its name.
      await mkdir(
        join(location.home, ".local", "state", "lazurio", "computers"),
        { recursive: true, mode: 0o700 },
      );
      await writeFile(
        recordPath(location.home, "alex-macbook"),
        JSON.stringify({
          deviceId: "alex-macbook",
          name: "MacBook Pro Alexe",
          os: "macos",
          executor: "po_ta_macbook",
        }),
        { mode: 0o600 },
      );
      expect(await cleanupSshComputers(location)).toEqual({
        removed: ["alex-macbook", "alex-windows"],
        failed: [],
      });
      expect(await readFile(file, "utf8")).toBe(`${before}${between}${after}`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readRecord(location.home, "alex-macbook")).toEqual({
        deviceId: "alex-macbook",
        name: "MacBook Pro Alexe",
        os: "macos",
        executor: "po_ta_macbook",
      });
      // Nothing to do the second time, and a file without such lines is
      // never written.
      const { mtimeMs } = await stat(file);
      expect(await cleanupSshComputers(location)).toEqual({
        removed: [],
        failed: [],
      });
      expect((await stat(file)).mtimeMs).toBe(mtimeMs);
    }),
);

test.skipIf(!posix)("the cleanup without authorized_keys does nothing", () =>
  withHome(async (location, file) => {
    expect(await cleanupSshComputers(location)).toEqual({
      removed: [],
      failed: [],
    });
    expect(
      await stat(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  }),
);
