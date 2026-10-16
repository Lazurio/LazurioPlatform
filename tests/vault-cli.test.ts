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
  statusText,
  type VaultCliContext,
} from "../src/vault/cli";
import { readRecord, readSession, vaultPaths } from "../src/vault/store";
import {
  collectionId,
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  organizationId,
  ownAccount,
  startFakeVault,
  stateDirectory,
  vaultName,
  vaultOrigin,
  zipOf,
} from "./fixtures/fake-vault";

// `lazurio vault` (decisions F43, F53): what an agent's shell gets, what it
// reads when there is nothing to get, and the commands over the same core.

const posix = process.platform !== "win32";

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
      stateDirectory(home, "vaultwarden.example.lazurio.io", ownAccount),
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
      // Not set up: a refusal an agent can read, exit 2, no stdout.
      const refused = await runVaultCommand(["env"], w.context);
      expect(refused.code).toBe(2);
      expect(refused.stdout).toBeUndefined();
      expect(refused.stderr?.split("\n")).toHaveLength(1);
      expect(refused.stderr).toContain("not set up yet");
      expect(refused.stderr).toContain("lazurio vault status");

      // Not allowed by the network yet: exit 2, waiting for a person.
      const notAllowed = await runVaultCommand(["setup"], w.context);
      expect(notAllowed.code).toBe(2);
      expect(notAllowed.stdout).toContain("Not allowed yet");

      // An agent sets it up (what the Launchpad does at its start).
      w.vault.allow(ownAccount);
      w.progress.length = 0;
      const setup = await runVaultCommand(["setup"], w.context);
      expect(setup.code).toBe(0);
      const record = await readRecord(w.paths);
      expect(setup.stdout).toBe(
        `Connected: this Environment's own vault "${vaultName}", ${ownAccount} in ${vaultOrigin}; it holds 0 items. Open it at ${vaultOrigin}/#/vault?organizationId=${record.organizationId}.`,
      );
      expect(w.progress).toEqual([
        "Installing the pinned Bitwarden CLI…",
        "Registering the account…",
        "Setting up the Environment's vault…",
        "Signing in…",
      ]);
      const status = await runVaultCommand(["status", "--json"], w.context);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout ?? "")).toMatchObject({
        kind: "vault-status",
        state: "connected",
        origin: "own",
        organizationId: record.organizationId,
        collectionId: record.collectionId,
      });
      const refreshed = await runVaultCommand(["refresh", "--json"], w.context);
      expect(refreshed.code).toBe(0);
      expect(JSON.parse(refreshed.stdout ?? "")).toMatchObject({
        state: "connected",
      });

      const env = await runVaultCommand(["env"], w.context);
      expect(env.code).toBe(0);
      expect(env.stderr).toBeUndefined();
      const session = await readSession(w.paths);
      expect(env.stdout).toBe(
        [
          `export BITWARDENCLI_APPDATA_DIR='${w.paths.data}'`,
          `export BW_SESSION='${session}'`,
          `export LAZURIO_VAULT_ORGANIZATION_ID='${record.organizationId}'`,
          `export LAZURIO_VAULT_COLLECTION_ID='${record.collectionId}'`,
        ].join("\n"),
      );
      const json = await runVaultCommand(["env", "--json"], w.context);
      expect(JSON.parse(json.stdout ?? "")).toEqual({
        kind: "vault-env",
        env: {
          BITWARDENCLI_APPDATA_DIR: w.paths.data,
          BW_SESSION: session,
          LAZURIO_VAULT_ORGANIZATION_ID: record.organizationId,
          LAZURIO_VAULT_COLLECTION_ID: record.collectionId,
        },
      });
      // The status never carries a secret.
      expect(status.stdout).not.toContain(session ?? "?");
      // An agent's `bw` after eval: the pinned one, with the session, sees
      // the vault's collection Agenti.
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
        expect.objectContaining({
          id: record.collectionId,
          organizationId: record.organizationId,
          name: "Agenti",
        }),
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

test("the status in words names what is missing and never a secret", () => {
  const facts = {
    kind: "vault-status",
    vault: vaultOrigin,
    account: ownAccount,
    name: vaultName,
    team: false,
    origin: "own",
  } as const;
  expect(
    statusText({
      kind: "vault-status",
      state: "unsupported",
      reason: "no-vault",
    }),
  ).toBe(
    "Not available: this Environment has no vault yet: its Machine handover names none.",
  );
  expect(statusText({ ...facts, state: "not-set-up", next: "vault" })).toBe(
    `Not set up yet: ${ownAccount} in ${vaultOrigin}; the next step is creating the Environment's vault. The Launchpad sets it up at its start; lazurio vault setup does the same.`,
  );
  expect(statusText({ ...facts, state: "revoked" })).toContain(
    "The network's operator decides",
  );
  expect(
    statusText({
      ...facts,
      name: null,
      origin: "pilot-0197",
      account: "vaultwarden@example.lazurio.io",
      state: "connected",
      organizationId,
      collectionId,
      organization: "Example Organization",
      items: 2,
    }),
  ).toBe(
    `Connected the 0197 way (read only until this Environment's own vault replaces it): vaultwarden@example.lazurio.io in ${vaultOrigin}, collection ${collectionId} of Example Organization; it holds 2 items.`,
  );
  // A personal Environment's own Bitwarden (root decision 0203 point 7):
  // its person connects it; an agent never asks for its credentials.
  const waiting = statusText({
    kind: "vault-status",
    state: "needs-connection",
  });
  expect(waiting).toContain("Settings → Vault");
  expect(waiting).toContain("never ask for that account's credentials");
  const personal = {
    ...facts,
    vault: "https://vault.bitwarden.eu",
    account: "agents.example+lazurio@example.com",
    name: "Osobní example",
    region: "eu",
  } as const;
  expect(
    statusText({
      ...personal,
      state: "failed",
      stage: "vault",
      reason: "free-organization-limit",
      fallback: "agent",
    }),
  ).toContain("connects a new agents' account");
  expect(
    statusText({
      kind: "vault-status",
      state: "unsupported",
      reason: "connection-unreadable",
    }),
  ).toContain("disconnect it");
});

test.skipIf(!posix)(
  "setup on a personal Environment waiting for its person runs nothing and waits for them (exit 2)",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-cli-")));
    try {
      const context: VaultCliContext = {
        identity: embeddedIdentity(),
        platform: "linux",
        env: {},
        executable: process.execPath,
        host: {
          context: async () => ({ kind: "needs-connection" }),
          directory: () => join(parent, "never"),
          connection: join(parent, "never"),
          base: join(parent, "never"),
          bin: join(parent, "never"),
          home: parent,
          path: undefined,
          platform: "linux",
          arch: "x64",
          run: async () => {
            throw new Error("nothing may run");
          },
        },
      };
      const setup = await runVaultCommand(["setup", "--json"], context);
      expect(setup.code).toBe(2);
      expect(JSON.parse(setup.stdout ?? "")).toEqual({
        kind: "vault-status",
        state: "needs-connection",
      });
      const env = await runVaultCommand(["env"], context);
      expect(env.code).toBe(2);
      expect(env.stdout).toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
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
      connection: "/nonexistent",
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
    ["connect"],
    ["disconnect"],
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
          command: "lazurio vault setup",
        });
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
