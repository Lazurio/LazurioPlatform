import { expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultContextOf } from "../src/vault/context";
import {
  type VaultHost,
  type VaultJournalEntry,
  type VaultStatus,
  vaultConnect,
  vaultDisconnect,
  vaultEnv,
  vaultRefresh,
  vaultStatus,
} from "../src/vault/flow";
import { pinnedBinary } from "../src/vault/install";
import { readAccount, readSession, vaultPaths } from "../src/vault/store";
import {
  collectionId,
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  fingerprint,
  organizationId,
  personalHandover,
  personalHandoverAt,
  startFakeVault,
  vaultOrigin,
  zipOf,
} from "./fixtures/fake-vault";

const posix = process.platform !== "win32";
const account = "vaultwarden@example.lazurio.io";
const collection = "Environmenty/Osobní · example";

async function world() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-flow-")));
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const release = fakeRelease(pin, zip);
  const journal: VaultJournalEntry[] = [];
  const host = fakeHost({
    home,
    vault,
    pin,
    download: release.fetch,
    journal,
  });
  const paths = vaultPaths(
    join(
      home,
      ".local",
      "state",
      "lazurio",
      "vault",
      "vaultwarden.example.lazurio.io",
      "example.lazurio.io",
    ),
  );
  return {
    home,
    vault,
    pin,
    release,
    journal,
    host,
    paths,
    async close() {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const mode = async (path: string) => (await lstat(path)).mode & 0o777;

test.skipIf(!posix)(
  "an Environment connects: not invited, invited and confirming, confirmed and connected, revoked, disconnected and back",
  async () => {
    const w = await world();
    try {
      // Nothing yet: the facts the operator needs to invite the account.
      expect(await vaultStatus(w.host)).toEqual({
        kind: "vault-status",
        state: "not-installed",
        vault: vaultOrigin,
        account,
        collection,
        name: "Osobní",
        team: false,
        registered: false,
      });

      // Not invited: the vault refuses the registration and nothing of the
      // account is left behind (the CLI is installed by then).
      const phases: string[] = [];
      expect(
        await vaultConnect(w.host, (phase) => phases.push(phase)),
      ).toMatchObject({ state: "awaiting-invite", account, collection });
      expect(phases).toEqual(["install", "account"]);
      expect(await readAccount(w.paths)).toBeNull();
      expect(w.vault.users.size).toBe(0);
      expect(await vaultStatus(w.host)).toMatchObject({
        state: "none",
        registered: false,
      });

      // Invited: the account is created, signed in and unlocked; it waits
      // for the Admin's confirmation by its fingerprint.
      w.vault.invite(account);
      phases.length = 0;
      expect(await vaultConnect(w.host, (phase) => phases.push(phase))).toEqual(
        {
          kind: "vault-status",
          state: "confirming",
          vault: vaultOrigin,
          account,
          collection,
          name: "Osobní",
          team: false,
          fingerprint,
          organization: null,
        },
      );
      expect(phases).toEqual(["install", "account", "sign-in"]);
      const stored = await readAccount(w.paths);
      expect(stored).toMatchObject({
        email: account,
        server: vaultOrigin,
      });
      expect(stored?.clientId).toBe(
        `user.${w.vault.users.get(account)?.id ?? "?"}`,
      );
      // The one device of the Environment is the account file's.
      expect(w.vault.users.get(account)?.devices).toEqual([
        stored?.deviceIdentifier ?? "?",
      ]);
      expect(await mode(w.paths.directory)).toBe(0o700);
      expect(await mode(w.paths.data)).toBe(0o700);
      expect(await mode(w.paths.account)).toBe(0o600);
      expect(await mode(w.paths.session)).toBe(0o600);
      expect(await vaultStatus(w.host)).toMatchObject({
        state: "confirming",
        fingerprint,
      });
      // Not connected yet: agents get nothing.
      expect(await vaultEnv(w.host)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });

      // Confirmed by the Admin: the next refresh sees the collection.
      await w.vault.confirm(collection, 3, ["Infrastruktura"]);
      const connected: VaultStatus = {
        kind: "vault-status",
        state: "connected",
        vault: vaultOrigin,
        account,
        collection,
        name: "Osobní",
        team: false,
        fingerprint,
        organization: "Example Organization",
        collections: 2,
        items: 3,
      };
      expect(await vaultRefresh(w.host)).toEqual(connected);
      // The local status reads the same from bw's copy.
      expect(await vaultStatus(w.host)).toEqual(connected);

      // Agents get the one unlocked session and the collection.
      const session = await readSession(w.paths);
      expect(await vaultEnv(w.host)).toEqual({
        kind: "vault-env",
        env: {
          BITWARDENCLI_APPDATA_DIR: w.paths.data,
          BW_SESSION: session ?? "?",
          LAZURIO_VAULT_ORGANIZATION_ID: organizationId,
          LAZURIO_VAULT_COLLECTION_ID: collectionId,
        },
      });

      // Revoked in the vault: the sync says so, and so does the local
      // status afterwards.
      await w.vault.remove();
      expect(await vaultRefresh(w.host)).toMatchObject({
        state: "revoked",
        fingerprint,
      });
      expect(await vaultStatus(w.host)).toMatchObject({ state: "revoked" });

      // Disconnect: bw's store, the session and the record go; the account
      // stays and connecting again signs it in without a registration.
      expect(await vaultDisconnect(w.host)).toMatchObject({
        state: "none",
        registered: true,
      });
      expect(await readSession(w.paths)).toBeNull();
      expect((await readAccount(w.paths))?.clientId).toBe(stored?.clientId);
      const registrations = w.vault.requests.filter(
        (entry) => entry.path === "/identity/accounts/register/finish",
      ).length;
      await w.vault.confirm(collection, 1);
      expect(await vaultConnect(w.host)).toMatchObject({
        state: "connected",
        collections: 1,
        items: 1,
      });
      expect(
        w.vault.requests.filter(
          (entry) => entry.path === "/identity/accounts/register/finish",
        ).length,
      ).toBe(registrations);

      // No secret ever reached argv, and the journal holds codes only.
      const calls = await w.vault.calls();
      const secrets = [
        stored?.masterPassword,
        stored?.clientSecret,
        session,
        await readSession(w.paths),
      ];
      for (const secret of secrets) {
        expect(secret).toBeString();
        expect(calls).not.toContain(secret as string);
      }
      expect(calls).not.toContain("--session");
      for (const entry of w.journal) {
        expect(Object.keys(entry).sort()).toEqual(
          entry.reason === undefined
            ? ["operation", "outcome"]
            : ["operation", "outcome", "reason"],
        );
        for (const secret of secrets)
          expect(JSON.stringify(entry)).not.toContain(secret as string);
      }
      // The release was downloaded once; the second connect found it.
      expect(w.release.requests).toHaveLength(1);
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a session ended by another unlock is replaced once, by env or refresh, and the newest one is shared",
  async () => {
    const w = await world();
    try {
      w.vault.invite(account);
      await w.vault.confirm(collection);
      expect(await vaultConnect(w.host)).toMatchObject({ state: "connected" });
      const first = await readSession(w.paths);
      // A rogue `bw lock` (agents never run it): the session is no longer
      // the unlocked one.
      const store = join(w.paths.data, "fake", "session");
      await rm(store);
      const env = await vaultEnv(w.host);
      expect(env.kind).toBe("vault-env");
      const second = await readSession(w.paths);
      expect(second).not.toBe(first);
      expect(env.kind === "vault-env" ? env.env.BW_SESSION : null).toBe(second);
      // The next env keeps it.
      const again = await vaultEnv(w.host);
      expect(again.kind === "vault-env" ? again.env.BW_SESSION : null).toBe(
        second,
      );
      // Refresh unlocks again when it is gone.
      await rm(store);
      expect(await vaultRefresh(w.host)).toMatchObject({ state: "connected" });
      expect(await readSession(w.paths)).not.toBe(second);
      expect(w.journal.filter((entry) => entry.operation === "unlock")).toEqual(
        [
          { operation: "unlock", outcome: "unlocked" },
          { operation: "unlock", outcome: "unlocked" },
          { operation: "unlock", outcome: "unlocked" },
        ],
      );
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an unreachable vault, a rate limit and SMTP end with their reason and lose no account",
  async () => {
    const w = await world();
    try {
      w.vault.invite(account);
      w.vault.flags.rateLimit = true;
      expect(await vaultConnect(w.host)).toMatchObject({
        state: "failed",
        stage: "account",
        reason: "rate-limited",
        fallback: "agent",
      });
      w.vault.flags.rateLimit = false;
      w.vault.flags.smtp = true;
      expect(await vaultConnect(w.host)).toMatchObject({
        state: "failed",
        stage: "account",
        reason: "smtp-enabled",
      });
      w.vault.flags.smtp = false;
      // The password written before the first attempt is the one that
      // registers now.
      const pending = await readAccount(w.paths);
      expect(pending?.clientId).toBeUndefined();
      expect(await vaultConnect(w.host)).toMatchObject({ state: "confirming" });
      expect((await readAccount(w.paths))?.masterPassword).toBe(
        pending?.masterPassword,
      );
      await w.vault.confirm(collection);
      await w.vault.unreachable(true);
      expect(await vaultRefresh(w.host)).toMatchObject({
        state: "unreachable",
        fingerprint,
      });
      await w.vault.unreachable(false);
      expect(await vaultRefresh(w.host)).toMatchObject({ state: "connected" });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a registration interrupted before its API key is resumed by a login, never a second registration",
  async () => {
    const w = await world();
    try {
      w.vault.invite(account);
      // The vault answers the registration, then the network drops before
      // the login.
      let drop = true;
      const host: VaultHost = {
        ...w.host,
        fetch: async (url, init) => {
          if (drop && url.endsWith("/identity/accounts/prelogin"))
            throw new Error("network down");
          return w.vault.fetch(url, init);
        },
      };
      expect(await vaultConnect(host)).toMatchObject({
        state: "unreachable",
        reason: "unreachable",
      });
      expect(w.vault.users.has(account)).toBe(true);
      expect((await readAccount(w.paths))?.clientId).toBeUndefined();
      drop = false;
      expect(await vaultConnect(host)).toMatchObject({ state: "confirming" });
      expect(
        w.vault.requests.filter(
          (entry) => entry.path === "/identity/accounts/register/finish",
        ),
      ).toHaveLength(1);
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an Environment whose address changes in the same network never gets the account it had, and an account file out of place is never used",
  async () => {
    const w = await world();
    try {
      w.vault.invite(account);
      await w.vault.confirm(collection);
      expect(await vaultConnect(w.host)).toMatchObject({ state: "connected" });
      const before = {
        account: await readFile(w.paths.account, "utf8"),
        session: await readSession(w.paths),
      };
      // The same Remote Environment now answers at another address in the
      // same network: the vault is the same, the account is not.
      const moved = "vaultwarden@moved.lazurio.io";
      const host: VaultHost = {
        ...w.host,
        context: async () =>
          vaultContextOf({
            handover: personalHandoverAt("moved.lazurio.io"),
            kind: "personal",
            label: null,
          }),
      };
      const unlocks = () =>
        w.journal.filter((entry) => entry.operation === "unlock").length;
      const unlocked = unlocks();
      expect(await vaultStatus(host)).toEqual({
        kind: "vault-status",
        state: "none",
        vault: vaultOrigin,
        account: moved,
        collection: "Environmenty/Osobní · moved",
        name: "Osobní",
        team: false,
        registered: false,
      });
      expect(await vaultRefresh(host)).toMatchObject({
        state: "none",
        account: moved,
      });
      expect(await vaultEnv(host)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });
      expect(unlocks()).toBe(unlocked);
      // Connecting registers the new address, which waits for its own
      // invitation.
      expect(await vaultConnect(host)).toMatchObject({
        state: "awaiting-invite",
        account: moved,
      });
      // The earlier account's files are untouched, and it still serves the
      // address it belongs to.
      expect(await readFile(w.paths.account, "utf8")).toBe(before.account);
      expect(await readSession(w.paths)).toBe(before.session);
      const own = await vaultEnv(w.host);
      expect(own.kind === "vault-env" ? own.env.BW_SESSION : null).toBe(
        before.session,
      );

      // The earlier account's files copied under the new address are not
      // the new address's account: everything refuses, nothing runs, and
      // the file is never replaced.
      const misplaced = vaultPaths(
        w.host.directory({
          host: "vaultwarden.example.lazurio.io",
          address: "moved.lazurio.io",
        }),
      );
      await writeFile(misplaced.account, before.account, { mode: 0o600 });
      await writeFile(misplaced.session, before.session ?? "", {
        mode: 0o600,
      });
      const mismatch = {
        state: "failed",
        stage: "account",
        reason: "account-mismatch",
      };
      const logouts = async () =>
        (await w.vault.calls())
          .split("\n")
          .filter((line) => line.startsWith("logout")).length;
      const loggedOut = await logouts();
      const store = await readFile(join(misplaced.data, "data.json"), "utf8");
      expect(await vaultStatus(host)).toMatchObject(mismatch);
      expect(await vaultRefresh(host)).toMatchObject(mismatch);
      expect(await vaultConnect(host)).toMatchObject(mismatch);
      expect(await vaultDisconnect(host)).toMatchObject(mismatch);
      expect(await vaultEnv(host)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });
      expect(unlocks()).toBe(unlocked);
      expect(await logouts()).toBe(loggedOut);
      expect(await readFile(misplaced.account, "utf8")).toBe(before.account);
      expect(await readSession(misplaced)).toBe(before.session);
      expect(await readFile(join(misplaced.data, "data.json"), "utf8")).toBe(
        store,
      );
      expect(w.journal.at(-1)).toEqual({
        operation: "disconnect",
        outcome: "failed",
        reason: "account-mismatch",
      });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "the pinned CLI is installed once from the verified release, with the standard entry agents call",
  async () => {
    const w = await world();
    try {
      w.vault.invite(account);
      await vaultConnect(w.host);
      const binary = pinnedBinary(w.host.base, w.pin);
      expect(await mode(binary)).toBe(0o755);
      const entry = join(w.home, ".local", "bin", "bw");
      const wrapper = await readFile(entry, "utf8");
      expect(wrapper).toContain(`exec '${binary}' "$@"`);
      expect(wrapper).toContain(`BITWARDENCLI_APPDATA_DIR='${w.paths.data}'`);
      // A tampered release is refused before anything is read from it.
      await rm(binary);
      const host: VaultHost = {
        ...w.host,
        download: async () =>
          new Response(new Uint8Array(zipOf("bw", "#!/bin/sh\nexit 0\n"))),
      };
      expect(await vaultConnect(host)).toMatchObject({
        state: "failed",
        stage: "install",
        reason: "checksum-mismatch",
      });
      // A `bw` in ~/.local/bin that is not Lazurio's is never replaced.
      await writeFile(entry, "#!/bin/sh\necho mine\n", { mode: 0o755 });
      expect(await vaultConnect(w.host)).toMatchObject({
        state: "failed",
        stage: "install",
        reason: "entry-conflict",
      });
      expect(await readFile(entry, "utf8")).toBe("#!/bin/sh\necho mine\n");
    } finally {
      await w.close();
    }
  },
  60_000,
);

test("a Remote Environment without a vault refuses everything before anything runs", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-none-")));
  try {
    const host: VaultHost = {
      context: async () => ({ kind: "unsupported", reason: "workstation" }),
      directory: () => join(parent, "never"),
      base: join(parent, "never"),
      bin: join(parent, "never"),
      home: parent,
      path: undefined,
      platform: "darwin",
      arch: "arm64",
      run: async () => {
        throw new Error("nothing may run");
      },
    };
    const unsupported: VaultStatus = {
      kind: "vault-status",
      state: "unsupported",
      reason: "workstation",
    };
    expect(await vaultStatus(host)).toEqual(unsupported);
    expect(await vaultConnect(host)).toEqual(unsupported);
    expect(await vaultRefresh(host)).toEqual(unsupported);
    expect(await vaultDisconnect(host)).toEqual(unsupported);
    expect(await vaultEnv(host)).toEqual({
      kind: "vault-env-refused",
      reason: "workstation",
    });
    expect(await lstat(join(parent, "never")).catch(() => null)).toBeNull();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the context of the fixture is the personal Environment of example", () => {
  expect(
    vaultContextOf({
      handover: personalHandover,
      kind: "personal",
      label: null,
    }),
  ).toMatchObject({ account, collection, vault: vaultOrigin });
});
