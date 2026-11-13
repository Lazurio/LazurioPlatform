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
import {
  type ComputersHost,
  migrateSshComputers,
} from "../src/computers/computers";
import { readRegistry } from "../src/computers/registry";
import { recordPath } from "../src/computers/state";
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

// The old SSH path of a person's computer (contract v0, decision F73 before
// its addendum of 2026-11-13): nothing writes its restricted line any more.
// The Launchpad reads such a line, moves it into the computers' registry and
// removes it; F49's page neither lists nor removes it, and every other line
// of `authorized_keys` stays byte for byte. Every test runs in a temporary
// home.

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
  "the move from SSH puts each old computer into the registry and takes its line out",
  () =>
    withHome(async (location, file) => {
      const host: ComputersHost = {
        ...location,
        platform: "linux",
        today: () => "2026-11-13",
        channelUrl: async () => null,
        executorCommand: async () => null,
        executor: null,
        allowed: async () => true,
        locale: async () => "cs",
        version: "test",
      };
      const other = `${keyOf(9)} provisioning@host\n`;
      await writeFile(
        file,
        `${other}${legacyLine(1, "alex-macbook")}\n${legacyLine(2, "alex-windows")}\n`,
        { mode: 0o600 },
      );
      // The old record of one of them: its name, system and Executor's
      // server go with it.
      await mkdir(
        join(location.home, ".local", "state", "lazurio", "computers"),
        {
          recursive: true,
          mode: 0o700,
        },
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
      expect(await migrateSshComputers(host)).toEqual({
        moved: ["alex-macbook", "alex-windows"],
        failed: [],
      });
      expect(await readFile(file, "utf8")).toBe(other);
      expect(
        await stat(recordPath(location.home, "alex-macbook")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      const registry = await readRegistry(location.home, location.uid);
      expect("computers" in registry && registry.computers).toEqual([
        {
          deviceId: "alex-macbook",
          name: "MacBook Pro Alexe",
          os: "macos",
          publicKey: keyOf(1),
          fingerprint: parsed(1).fingerprint,
          addedBy: "alex",
          added: "2026-11-12",
          executor: "po_ta_macbook",
        },
        {
          deviceId: "alex-windows",
          name: "alex-windows",
          os: null,
          publicKey: keyOf(2),
          fingerprint: parsed(2).fingerprint,
          addedBy: "alex",
          added: "2026-11-12",
          executor: null,
        },
      ]);
      // Nothing to do the second time.
      expect(await migrateSshComputers(host)).toEqual({
        moved: [],
        failed: [],
      });
    }),
);
