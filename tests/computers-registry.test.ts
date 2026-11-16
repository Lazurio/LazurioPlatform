import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RegistryEntry,
  readRegistry,
  updateRegistry,
} from "../src/computers/registry";

// The registry's transaction across processes (review of #943): the
// Launchpad's pairing and `lazurio computer remove` are separate writers. A
// pairing that read the registry before a removal waits for nothing in its own
// process, so only the registry's lock keeps it from writing the removed
// computer back. Two real processes take the registry in a fixed order.

const posix = process.platform !== "win32";
const registryModule = join(
  import.meta.dir,
  "..",
  "src",
  "computers",
  "registry.ts",
);

const wire = (bytes: Buffer) =>
  Buffer.concat([Buffer.alloc(4), bytes])
    .fill(0, 0, 3)
    .fill(bytes.length, 3, 4);

function sshKey(publicKey: KeyObject): string {
  const raw = Buffer.from(
    publicKey.export({ format: "jwk" }).x as string,
    "base64url",
  );
  return `ssh-ed25519 ${Buffer.concat([wire(Buffer.from("ssh-ed25519")), wire(raw)]).toString("base64")}`;
}

const entry = (deviceId: string): RegistryEntry => ({
  deviceId,
  name: deviceId,
  os: "macos",
  publicKey: sshKey(generateKeyPairSync("ed25519").publicKey),
  fingerprint: "SHA256:test",
  addedBy: "alex",
  added: "2026-11-15",
  executor: null,
});

async function waitFor(check: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

test.skipIf(!posix)(
  "a removal waits for a pairing that read before it in another process, and the removed computer stays removed",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "lzr-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const signals = join(home, "signals");
    await mkdir(signals);
    const uid = process.getuid?.();
    await updateRegistry(home, uid, () => ({
      computers: [entry("alex-macbook")],
      result: null,
    }));
    // The pairing reads, says so and holds its transaction until `go`.
    const pairing = join(home, "pairing.ts");
    await writeFile(
      pairing,
      `import { existsSync, writeFileSync } from "node:fs";
import { updateRegistry } from ${JSON.stringify(registryModule)};
const [home, signals, added] = process.argv.slice(2);
const answer = await updateRegistry(home, process.getuid?.(), (computers) => {
  writeFileSync(signals + "/pairing-read", "");
  while (!existsSync(signals + "/go")) Bun.sleepSync(5);
  return { computers: [...computers, JSON.parse(added)], result: "paired" };
});
if (answer !== "paired") process.exit(1);
`,
    );
    // The removal starts while the pairing holds its read.
    const removal = join(home, "removal.ts");
    await writeFile(
      removal,
      `import { writeFileSync } from "node:fs";
import { updateRegistry } from ${JSON.stringify(registryModule)};
const [home, signals] = process.argv.slice(2);
writeFileSync(signals + "/removal-start", "");
const answer = await updateRegistry(home, process.getuid?.(), (computers) => {
  writeFileSync(signals + "/removal-saw", computers.map((c) => c.deviceId).join(","));
  return { computers: computers.filter((c) => c.deviceId !== "alex-macbook"), result: "removed" };
});
if (answer !== "removed") process.exit(1);
`,
    );
    const first = Bun.spawn(
      [
        process.execPath,
        pairing,
        home,
        signals,
        JSON.stringify(entry("bob-laptop")),
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    await waitFor(() => existsSync(join(signals, "pairing-read")));
    const second = Bun.spawn([process.execPath, removal, home, signals], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await waitFor(() => existsSync(join(signals, "removal-start")));
    await writeFile(join(signals, "go"), "");
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    // The removal read the pairing's write, not the registry from before it.
    expect(await readFile(join(signals, "removal-saw"), "utf8")).toBe(
      "alex-macbook,bob-laptop",
    );
    const read = await readRegistry(home, uid);
    expect(
      "computers" in read ? read.computers.map((c) => c.deviceId) : read,
    ).toEqual(["bob-laptop"]);
  },
);
