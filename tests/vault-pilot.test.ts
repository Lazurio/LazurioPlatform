import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwCli } from "../src/vault/bw";
import {
  setUpAtStart,
  type VaultHost,
  type VaultJournalEntry,
  type VaultStatus,
  vaultEnv,
  vaultRefresh,
  vaultSecrets,
  vaultSecretsAdmission,
  vaultSetup,
  vaultStatus,
} from "../src/vault/flow";
import { installPinnedBw, pinnedBinary } from "../src/vault/install";
import type { PilotContext } from "../src/vault/legacy-0197/context";
import {
  DEVICE_TYPE_SDK,
  fetchApiKey,
  generateMasterPassword,
  passwordLogin,
  registerAccount,
} from "../src/vault/register";
import {
  completeAccount,
  createAccount,
  ensureVaultDirectories,
  readSession,
  vaultPaths,
  writeSession,
} from "../src/vault/store";
import {
  collectionId,
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  organizationId,
  otherCollectionId,
  ownAccount,
  ownContext,
  personalHandover,
  pilotContext,
  startFakeVault,
  stateDirectory,
  vaultOrigin,
  workHandover,
  zipOf,
} from "./fixtures/fake-vault";

// Pilot safety (DEV-6631 task 638a): an Environment connected the 0197 way
// (decision F43) keeps working read only, exactly as before, while its
// handover names no vault: connected, the shared session unlocked, F46 from
// the recorded collection. Nothing connects the old way any more, and once
// the handover names its own vault the pilot's directory is left untouched
// for the move of task 649. The pilot is seeded as F43 left it.

const posix = process.platform !== "win32";
const host = "vaultwarden.example.lazurio.io";
const value = "fake-pilot-secret-value-5d1c";

async function world(kind: "personal" | "work" = "personal") {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-pilot-")));
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const release = fakeRelease(pin, zip);
  const journal: VaultJournalEntry[] = [];
  const context: PilotContext =
    kind === "personal"
      ? pilotContext()
      : pilotContext(workHandover(null), "work");
  let current: Awaited<ReturnType<VaultHost["context"]>> = context;
  const vaultHost = fakeHost({
    home,
    vault,
    pin,
    download: release.fetch,
    journal,
    context: async () => current,
  });
  const paths = vaultPaths(stateDirectory(home, host, context.address));
  return {
    home,
    vault,
    pin,
    release,
    journal,
    context,
    host: vaultHost,
    paths,
    /** What the host's context is from now on. */
    contextIs(next: Awaited<ReturnType<VaultHost["context"]>>) {
      current = next;
    },
    /** The pilot as F43 left it: registered, signed in and unlocked in its
     * own data directory, its collection in a person's organization
     * recorded beside it. */
    async seed(options: Readonly<{ record?: boolean }> = {}) {
      vault.allow(context.account);
      const client = { fetch: vault.fetch };
      const account = {
        email: context.account,
        server: vaultOrigin,
        deviceIdentifier: randomUUID(),
        masterPassword: generateMasterPassword(),
        createdAt: "2026-10-09T10:00:00.000Z",
      };
      await ensureVaultDirectories(paths);
      await createAccount(paths, account);
      await registerAccount(client, {
        serverUrl: vaultOrigin,
        email: account.email,
        password: account.masterPassword,
      });
      const login = await passwordLogin(client, {
        serverUrl: vaultOrigin,
        email: account.email,
        password: account.masterPassword,
        device: {
          identifier: account.deviceIdentifier,
          name: "Lazurio Launchpad",
          type: DEVICE_TYPE_SDK,
        },
      });
      const ready = await completeAccount(
        paths,
        account,
        await fetchApiKey(client, login),
      );
      const installed = await installPinnedBw({
        base: vaultHost.base,
        bin: vaultHost.bin,
        data: paths.data,
        home,
        path: vaultHost.path,
        platform: "linux",
        arch: "x64",
        run: vaultHost.run,
        fetch: release.fetch,
        pin,
      });
      if (installed.kind !== "installed") throw new Error("Expected bw");
      const bw = bwCli({
        binary: pinnedBinary(vaultHost.base, pin),
        data: paths.data,
        home,
        path: vaultHost.path,
        run: vaultHost.run,
      });
      expect((await bw.configServer(vaultOrigin)).ok).toBe(true);
      expect(
        (await bw.loginApiKey(ready.clientId, ready.clientSecret)).ok,
      ).toBe(true);
      const unlocked = await bw.unlock(ready.masterPassword);
      if (!unlocked.ok) throw new Error("Expected an unlock");
      await writeSession(paths, unlocked.value);
      if (options.record !== false)
        await writeFile(
          paths.record,
          `${JSON.stringify(
            {
              fingerprint: "steep-flavor-uncut-scouring-unnoticed",
              organizationId,
              collectionId,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
      await vault.confirm("Environmenty/Osobní · example", 2);
      expect((await bw.sync(unlocked.value)).ok).toBe(true);
      return ready;
    },
    async close() {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** Every file below a directory with its bytes, for "untouched". */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (at: string) => {
    for (const name of (await readdir(at)).sort()) {
      const path = join(at, name);
      if ((await stat(path)).isDirectory()) await walk(path);
      else files[path] = await readFile(path, "base64");
    }
  };
  await walk(directory);
  return files;
}

test.skipIf(!posix)(
  "a 0197 pilot without a vault in its handover stays connected, read only: status, refresh and the shared session, and no setup the old way",
  async () => {
    const w = await world();
    try {
      await w.seed();
      const facts = {
        vault: vaultOrigin,
        account: "vaultwarden@example.lazurio.io",
        name: null,
        team: false,
        origin: "pilot-0197",
      } as const;
      const connected: VaultStatus = {
        kind: "vault-status",
        state: "connected",
        ...facts,
        organizationId,
        collectionId,
        organization: "Example Organization",
        items: 2,
      };
      expect(await vaultStatus(w.host)).toEqual(connected);
      expect(await vaultRefresh(w.host)).toEqual(connected);
      expect(setUpAtStart(await vaultStatus(w.host))).toBe(false);
      // Agents get the pilot's session and its recorded ids.
      const env = await vaultEnv(w.host);
      expect(env).toEqual({
        kind: "vault-env",
        env: {
          BITWARDENCLI_APPDATA_DIR: w.paths.data,
          BW_SESSION: (await readSession(w.paths)) ?? "?",
          LAZURIO_VAULT_ORGANIZATION_ID: organizationId,
          LAZURIO_VAULT_COLLECTION_ID: collectionId,
        },
      });
      // A session ended by another unlock is replaced, as before.
      await rm(join(w.paths.data, "fake", "session"));
      expect(await vaultStatus(w.host)).toMatchObject({
        state: "connected",
        locked: true,
      });
      const again = await vaultEnv(w.host);
      expect(again.kind).toBe("vault-env");
      expect(again.kind === "vault-env" ? again.env.BW_SESSION : null).toBe(
        await readSession(w.paths),
      );
      // No connection the old way: a setup only reads, and asks nothing.
      const requests = w.vault.requests.length;
      const downloads = w.release.requests.length;
      expect(await vaultSetup(w.host)).toEqual(connected);
      expect(w.vault.requests).toHaveLength(requests);
      expect(w.release.requests).toHaveLength(downloads);
      // The collection is no longer shared: revoked.
      await w.vault.remove();
      expect(await vaultRefresh(w.host)).toEqual({
        kind: "vault-status",
        state: "revoked",
        ...facts,
      });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a pilot's runtime secrets come from its recorded collection under the 0197 rule",
  async () => {
    const w = await world("work");
    try {
      await w.seed();
      await w.vault.items([
        ...[
          { name: "EXAMPLE_TOKEN", collectionIds: [collectionId] },
          // The same name in another collection is not the pilot's.
          { name: "OTHER_TOKEN", collectionIds: [otherCollectionId] },
        ].map((item) => ({
          object: "item",
          id: randomUUID(),
          type: 1,
          name: item.name,
          organizationId,
          collectionIds: item.collectionIds,
          login: { username: "example", password: value },
        })),
        // A Secure note is read only from an own vault (decision F54): the
        // frozen pilot reads login passwords, as before.
        {
          object: "item",
          id: randomUUID(),
          type: 2,
          name: "NOTE_TOKEN",
          organizationId,
          collectionIds: [collectionId],
          secureNote: { type: 0 },
          login: null,
          fields: [{ name: "Token", value, type: 1 }],
        },
      ]);
      const names = ["EXAMPLE_TOKEN", "OTHER_TOKEN", "NOTE_TOKEN"];
      const result = await vaultSecrets(w.host, {
        company: "Example",
        personalspace: false,
        names,
      });
      expect(result.kind).toBe("vault-secrets");
      if (result.kind !== "vault-secrets") return;
      expect(result.secrets.get("EXAMPLE_TOKEN")).toEqual({
        kind: "value",
        value,
      });
      expect(result.secrets.get("OTHER_TOKEN")).toEqual({
        kind: "absent",
        reason: "missing",
      });
      expect(result.secrets.get("NOTE_TOKEN")).toEqual({
        kind: "absent",
        reason: "empty",
      });
      // F46's rule of 0197: never a Personalspace module, never another
      // Organization.
      for (const [application, reason] of [
        [{ company: "example", personalspace: true }, "personalspace"],
        [{ company: "other", personalspace: false }, "other-organization"],
      ] as const) {
        expect(await vaultSecretsAdmission(w.host, application)).toBe(reason);
        expect(await vaultSecrets(w.host, { ...application, names })).toEqual({
          kind: "vault-secrets-refused",
          reason,
        });
      }
      expect(
        await vaultSecretsAdmission(w.host, {
          company: "example",
          personalspace: false,
        }),
      ).toBeNull();
      // The value is in the result only.
      expect(await w.vault.calls()).not.toContain(value);
      expect(JSON.stringify(w.journal)).not.toContain(value);
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an Environment never connected the 0197 way, or disconnected, has no vault yet: nothing is read or created",
  async () => {
    for (const seeded of [false, true]) {
      const w = await world("work");
      try {
        if (seeded) await w.seed({ record: false });
        const requests = w.vault.requests.length;
        const noVault: VaultStatus = {
          kind: "vault-status",
          state: "unsupported",
          reason: "no-vault",
        };
        expect([seeded, await vaultStatus(w.host)]).toEqual([seeded, noVault]);
        expect([seeded, await vaultRefresh(w.host)]).toEqual([seeded, noVault]);
        expect([seeded, await vaultSetup(w.host)]).toEqual([seeded, noVault]);
        expect([seeded, await vaultEnv(w.host)]).toEqual([
          seeded,
          { kind: "vault-env-refused", reason: "no-vault" },
        ]);
        const application = { company: "example", personalspace: false };
        expect(await vaultSecretsAdmission(w.host, application)).toBe(
          "no-vault-identity",
        );
        expect(
          await vaultSecrets(w.host, { ...application, names: ["TOKEN"] }),
        ).toEqual({
          kind: "vault-secrets-refused",
          reason: "no-vault-identity",
        });
        expect(w.vault.requests).toHaveLength(requests);
      } finally {
        await w.close();
      }
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "once the handover names the Environment's own vault, the new account sets it up in its own directory and the pilot's directory stays untouched",
  async () => {
    const w = await world();
    try {
      await w.seed();
      const before = await snapshot(w.paths.directory);
      expect(Object.keys(before).length).toBeGreaterThan(3);
      // Machines writes `vault` for this Environment.
      w.contextIs(ownContext(personalHandover));
      expect(await vaultStatus(w.host)).toMatchObject({
        state: "not-set-up",
        origin: "own",
        account: ownAccount,
      });
      w.vault.allow(ownAccount);
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "connected",
        origin: "own",
      });
      const own = vaultPaths(stateDirectory(w.home, host, ownAccount));
      const env = await vaultEnv(w.host);
      expect(
        env.kind === "vault-env" ? env.env.BITWARDENCLI_APPDATA_DIR : null,
      ).toBe(own.data);
      // The agents' `bw` now defaults to the own account's data.
      expect(
        await readFile(join(w.home, ".local", "bin", "bw"), "utf8"),
      ).toContain(`BITWARDENCLI_APPDATA_DIR='${own.data}'`);
      // The pilot's directory is byte for byte what it was.
      expect(await snapshot(w.paths.directory)).toEqual(before);
    } finally {
      await w.close();
    }
  },
  60_000,
);

test("the pilot's account is derived as F43 derived it, and only from a handover that names no vault", () => {
  expect(pilotContext()).toMatchObject({
    kind: "pilot",
    vault: vaultOrigin,
    address: "example.lazurio.io",
    account: "vaultwarden@example.lazurio.io",
    organization: null,
  });
  expect(pilotContext(workHandover(null), "work")).toMatchObject({
    address: "workspace.example.lazurio.io",
    account: "vaultwarden@workspace.example.lazurio.io",
    organization: "example",
  });
});

test.skipIf(!posix)(
  "the pilot's directory is keyed by its address, beside the own account's",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-dir-")));
    try {
      const pilot = stateDirectory(parent, host, "example.lazurio.io");
      const own = stateDirectory(parent, host, ownAccount);
      await mkdir(pilot, { recursive: true });
      await mkdir(own, { recursive: true });
      expect(
        (
          await readdir(join(parent, ".local/state/lazurio/vault", host))
        ).sort(),
      ).toEqual(["example.lazurio.io", ownAccount].sort());
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
