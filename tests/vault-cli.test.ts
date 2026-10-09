import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../src/tools/catalog";
import { runToolsCommand } from "../src/tools/cli";
import { runTool, toolsStatus } from "../src/tools/status";
import { embeddedIdentity } from "../src/update/identity";
import {
  exportsOf,
  runVaultCommand,
  shellQuote,
  type VaultCliContext,
} from "../src/vault/cli";
import { readSession, vaultPaths } from "../src/vault/store";
import {
  collectionId,
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  organizationId,
  startFakeVault,
  zipOf,
} from "./fixtures/fake-vault";

// `lazurio vault` (decision F43): what an agent's shell gets, what it reads
// when there is nothing to get, and the commands over the same core.

const posix = process.platform !== "win32";
const account = "vaultwarden@example.lazurio.io";

async function world() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-cli-")));
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const host = fakeHost({
    home,
    vault,
    pin,
    download: fakeRelease(pin, zip).fetch,
  });
  const progress: string[] = [];
  const context: VaultCliContext = {
    identity: embeddedIdentity(),
    platform: "linux",
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    executable: process.execPath,
    host,
    progress: (line) => progress.push(line),
  };
  return {
    home,
    vault,
    host,
    context,
    progress,
    paths: vaultPaths(
      join(
        home,
        ".local",
        "state",
        "lazurio",
        "vault",
        "vaultwarden.example.lazurio.io",
        "example.lazurio.io",
      ),
    ),
    async close() {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test("the exports are single-quoted shell words that eval back exactly", () => {
  const value = 'it\'s a $(test) `value` with "quotes"';
  expect(shellQuote(value)).toBe(
    "'it'\\''s a $(test) `value` with \"quotes\"'",
  );
  const exports = exportsOf({
    BITWARDENCLI_APPDATA_DIR: "/home/operator/.local/state/lazurio/vault/v/bw",
    BW_SESSION: value,
    LAZURIO_VAULT_ORGANIZATION_ID: organizationId,
    LAZURIO_VAULT_COLLECTION_ID: collectionId,
  });
  expect(exports.split("\n")).toHaveLength(4);
  if (!posix) return;
  const evaluated = spawnSync(
    "/bin/sh",
    [
      "-c",
      'eval "$1"; printf "%s|%s" "$BW_SESSION" "$LAZURIO_VAULT_COLLECTION_ID"',
      "sh",
      exports,
    ],
    { encoding: "utf8" },
  );
  expect(evaluated.stdout).toBe(`${value}|${collectionId}`);
});

test.skipIf(!posix)(
  "vault env prints the exports alone, or one line on stderr and nothing on stdout",
  async () => {
    const w = await world();
    try {
      // Not connected: a refusal an agent can read, exit 2, no stdout.
      const refused = await runVaultCommand(["env"], w.context);
      expect(refused.code).toBe(2);
      expect(refused.stdout).toBeUndefined();
      expect(refused.stderr?.split("\n")).toHaveLength(1);
      expect(refused.stderr).toContain("Settings → Tools → bitwarden");

      // An agent connects (the fallback of the Launchpad's flow).
      w.vault.invite(account);
      const connect = await runVaultCommand(["connect"], w.context);
      expect(connect.code).toBe(0);
      expect(connect.stdout).toContain("Waiting for the confirmation");
      expect(connect.stdout).toContain("steep-flavor-uncut-scouring-unnoticed");
      expect(w.progress).toEqual([
        "Installing the pinned Bitwarden CLI…",
        "Creating the account…",
        "Signing in…",
      ]);
      await w.vault.confirm("Environmenty/Osobní · example", 2);
      const refreshed = await runVaultCommand(["refresh", "--json"], w.context);
      expect(refreshed.code).toBe(0);
      expect(JSON.parse(refreshed.stdout ?? "")).toMatchObject({
        kind: "vault-status",
        state: "connected",
        collections: 1,
        items: 2,
      });

      const env = await runVaultCommand(["env"], w.context);
      expect(env.code).toBe(0);
      expect(env.stderr).toBeUndefined();
      const session = await readSession(w.paths);
      expect(env.stdout).toBe(
        [
          `export BITWARDENCLI_APPDATA_DIR='${w.paths.data}'`,
          `export BW_SESSION='${session}'`,
          `export LAZURIO_VAULT_ORGANIZATION_ID='${organizationId}'`,
          `export LAZURIO_VAULT_COLLECTION_ID='${collectionId}'`,
        ].join("\n"),
      );
      const json = await runVaultCommand(["env", "--json"], w.context);
      expect(JSON.parse(json.stdout ?? "")).toEqual({
        kind: "vault-env",
        env: {
          BITWARDENCLI_APPDATA_DIR: w.paths.data,
          BW_SESSION: session,
          LAZURIO_VAULT_ORGANIZATION_ID: organizationId,
          LAZURIO_VAULT_COLLECTION_ID: collectionId,
        },
      });
      // The status never carries a secret.
      const status = await runVaultCommand(["status", "--json"], w.context);
      expect(status.stdout).not.toContain(session ?? "?");
      expect(status.code).toBe(0);
      // An agent's `bw` after eval: the pinned one, with the session.
      const shell = spawnSync(
        "/bin/sh",
        [
          "-c",
          'eval "$1"; PATH="$2:$PATH"; bw list collections',
          "sh",
          env.stdout ?? "",
          join(w.home, ".local", "bin"),
        ],
        { encoding: "utf8", env: { HOME: w.home, PATH: "/usr/bin:/bin" } },
      );
      expect(JSON.parse(shell.stdout)).toEqual([
        expect.objectContaining({ id: collectionId }),
      ]);
      // Without eval the wrapper still uses this Environment's data, which
      // says locked instead of reaching a default profile.
      const bare = spawnSync(
        "/bin/sh",
        [
          "-c",
          'PATH="$1:$PATH"; bw list collections',
          "sh",
          join(w.home, ".local", "bin"),
        ],
        { encoding: "utf8", env: { HOME: w.home, PATH: "/usr/bin:/bin" } },
      );
      expect(bare.status).not.toBe(0);
      expect(bare.stderr).toContain("Vault is locked.");
    } finally {
      await w.close();
    }
  },
  60_000,
);

test("a wrong invocation is a usage error with the help", async () => {
  const context: VaultCliContext = {
    identity: embeddedIdentity(),
    platform: "linux",
    env: {},
    executable: process.execPath,
    host: {
      context: async () => {
        throw new Error("nothing may be read");
      },
      directory: () => "/nonexistent",
      base: "/nonexistent",
      bin: "/nonexistent",
      home: "/nonexistent",
      path: undefined,
      platform: "linux",
      arch: "x64",
      run: async () => {
        throw new Error("nothing may run");
      },
    },
  };
  for (const args of [
    [],
    ["login"],
    ["env", "extra"],
    ["env", "--json", "--json"],
    ["status", "--session", "x"],
  ]) {
    const output = await runVaultCommand(args, context);
    expect(output.code).toBe(2);
    expect(output.stderr).toContain("vault env [--json]");
  }
  // An operation that throws says which, and nothing else.
  expect(await runVaultCommand(["status"], context)).toEqual({
    code: 1,
    stderr: "Vault status failed.",
  });
});

test.skipIf(!posix)(
  "a version probe of bw gets a data directory of its own, and F19's commands send to the vault's",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "vault-probe-")),
    );
    try {
      const bin = join(parent, "bin");
      await mkdir(bin);
      // A bw that records where it would write its data file.
      await writeFile(
        join(bin, "bw"),
        `#!/bin/sh\necho "$BITWARDENCLI_APPDATA_DIR" > "${join(parent, "seen")}"\necho 2026.7.0\n`,
        { mode: 0o755 },
      );
      const entry = findTool("bitwarden");
      if (entry === undefined) throw new Error("Expected the vault tool");
      const status = await toolsStatus({
        path: bin,
        home: join(parent, "home"),
        platform: process.platform,
        run: runTool,
        catalog: [entry],
      });
      expect(status.tools[0]).toMatchObject({
        name: "bitwarden",
        installed: true,
        version: "2026.7.0",
      });
      const seen = (await readFile(join(parent, "seen"), "utf8")).trim();
      expect(seen.startsWith(tmpdir()) || seen.startsWith("/tmp")).toBe(true);
      expect(seen).not.toContain(join(parent, "home"));
      // Removed after the probe.
      expect(await stat(seen).catch(() => null)).toBeNull();
      // The curated install and sign-in of F19 point to the vault's flow.
      for (const command of ["install", "login", "logout"]) {
        const refused = await runToolsCommand(
          [command, "bitwarden", "--json"],
          { env: { HOME: join(parent, "home"), PATH: bin }, platform: "linux" },
        );
        expect(refused.code).toBe(2);
        expect(refused.result).toEqual({
          kind: "blocked",
          reason: "setup-vault",
          tool: "bitwarden",
          command: "lazurio vault connect",
        });
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
