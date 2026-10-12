import { expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computerSettings,
  hostKeyOf,
  readHostKey,
  readTailnet,
  sshAlias,
  tailnetOfStatus,
} from "../src/ssh-access/host";
import type { ToolRunner } from "../src/tools/status";

// What a person's computer writes to reach this Environment (decision F49):
// its tailnet name from Tailscale itself (never guessed), the account, and
// the Environment's own host key, pinned under an alias in a known_hosts
// file of its own.

const hostKey =
  "AAAAC3NzaC1lZDI1NTE5AAAAIDSQ6IIHQipQN9YXjjwhCNuecXaQZ6xS2/QbEsUFltVy";

test("the tailnet name is Self.DNSName while Tailscale runs with MagicDNS", () => {
  const status = (value: unknown) => tailnetOfStatus(JSON.stringify(value));
  expect(
    status({
      BackendState: "Running",
      Self: { DNSName: "Alex-Work.example-org.ts.example." },
      CurrentTailnet: { MagicDNSEnabled: true },
    }),
  ).toEqual({ state: "known", dnsName: "alex-work.example-org.ts.example" });
  expect(
    status({ BackendState: "Stopped", Self: { DNSName: "a.b.example." } }),
  ).toEqual({ state: "unavailable", reason: "tailnet-not-running" });
  expect(
    status({
      BackendState: "Running",
      Self: { DNSName: "a.b.example." },
      CurrentTailnet: { MagicDNSEnabled: false },
    }),
  ).toEqual({ state: "unavailable", reason: "no-dns-name" });
  expect(status({ BackendState: "Running", Self: { DNSName: "" } })).toEqual({
    state: "unavailable",
    reason: "no-dns-name",
  });
  expect(
    status({ BackendState: "Running", Self: { DNSName: "single." } }),
  ).toEqual({ state: "unavailable", reason: "no-dns-name" });
  expect(tailnetOfStatus("not json")).toEqual({
    state: "unavailable",
    reason: "tailscale-failed",
  });
});

test.skipIf(process.platform === "win32")(
  "Tailscale is asked on the PATH, and its absence or failure is said, not guessed",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "ssh-tailnet-")),
    );
    try {
      const asked: string[][] = [];
      const answer: { exitCode: number; stdout: string } = {
        exitCode: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "alex-work.example-org.ts.example." },
        }),
      };
      const run: ToolRunner = async (command) => {
        asked.push([...command]);
        return { ...answer, stderr: "" };
      };
      const tools = {
        path: directory,
        home: directory,
        platform: "linux",
        run,
      };
      expect(await readTailnet(tools)).toEqual({
        state: "unavailable",
        reason: "tailscale-missing",
      });
      expect(asked).toEqual([]);
      const tailscale = join(directory, "tailscale");
      await writeFile(tailscale, "#!/bin/sh\nexit 0\n");
      await chmod(tailscale, 0o755);
      expect(await readTailnet(tools)).toEqual({
        state: "known",
        dnsName: "alex-work.example-org.ts.example",
      });
      expect(asked).toEqual([[tailscale, "status", "--json"]]);
      answer.exitCode = 1;
      expect(await readTailnet(tools)).toEqual({
        state: "unavailable",
        reason: "tailscale-failed",
      });
      expect(
        await readTailnet({ ...tools, run: async () => "timeout" }),
      ).toEqual({ state: "unavailable", reason: "tailscale-failed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("the host key is the ed25519 key of the .pub file, without its comment", async () => {
  expect(hostKeyOf(`ssh-ed25519 ${hostKey} root@alex-work\n`)).toEqual({
    type: "ssh-ed25519",
    key: hostKey,
  });
  expect(hostKeyOf("ssh-rsa AAAAB3NzaC1yc2E root@alex-work")).toBeNull();
  expect(hostKeyOf(`ssh-ed25519 ${hostKey.slice(0, 40)}`)).toBeNull();
  expect(hostKeyOf("")).toBeNull();
  const directory = await mkdtemp(join(tmpdir(), "ssh-host-key-"));
  try {
    const path = join(directory, "ssh_host_ed25519_key.pub");
    expect(await readHostKey(path)).toBeNull();
    await writeFile(path, `ssh-ed25519 ${hostKey} root@alex-work\n`);
    expect(await readHostKey(path)).toEqual({
      type: "ssh-ed25519",
      key: hostKey,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a computer's settings: one Host block and one pinned known_hosts line", () => {
  expect(sshAlias("alex-work.example-org.ts.example")).toBe("alex-work");
  expect(
    computerSettings({
      user: "alex",
      tailnet: { state: "known", dnsName: "alex-work.example-org.ts.example" },
      hostKey: { type: "ssh-ed25519", key: hostKey },
    }),
  ).toEqual({
    state: "ready",
    alias: "alex-work",
    keyPath: "~/.ssh/alex-work-ed25519",
    config: [
      "Host alex-work",
      "  HostName alex-work.example-org.ts.example",
      "  User alex",
      "  IdentityFile ~/.ssh/alex-work-ed25519",
      "  IdentitiesOnly yes",
      "  HostKeyAlias alex-work",
      "  UserKnownHostsFile ~/.ssh/known_hosts_lazurio",
      "  StrictHostKeyChecking yes",
    ].join("\n"),
    knownHosts: `alex-work ssh-ed25519 ${hostKey}`,
  });
  // Everything missing is said, nothing is guessed.
  expect(
    computerSettings({
      user: "alex smith",
      tailnet: { state: "unavailable", reason: "tailscale-missing" },
      hostKey: null,
    }),
  ).toEqual({
    state: "unavailable",
    missing: ["tailscale-missing", "host-key-missing", "user-invalid"],
  });
});
