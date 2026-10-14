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
import {
  setUpAtStart,
  type VaultHost,
  type VaultJournalEntry,
  type VaultStatus,
  vaultEnv,
  vaultRefresh,
  vaultSetup,
  vaultStatus,
} from "../src/vault/flow";
import { pinnedBinary } from "../src/vault/install";
import {
  readAccount,
  readRecord,
  readSession,
  vaultPaths,
} from "../src/vault/store";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownAccount,
  ownContext,
  personalHandoverAt,
  startFakeVault,
  stateDirectory,
  vaultMember,
  vaultName,
  vaultOrigin,
  zipOf,
} from "./fixtures/fake-vault";

// The Environment's own vault (root decision 0198, decision F53) through its
// one core: the account the handover names registers itself, creates the
// Environment's own organization with the collection Agenti, keeps it by ID
// and one shared session for its agents. Against the fake Vaultwarden and the
// fake bw; every name, id and value is invented.

const posix = process.platform !== "win32";
const host = "vaultwarden.example.lazurio.io";

async function world() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-flow-")));
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const release = fakeRelease(pin, zip);
  const journal: VaultJournalEntry[] = [];
  // How often the agents' switch was turned on for the vault.
  let enabled = 0;
  const host_: VaultHost = {
    ...fakeHost({
      home,
      vault,
      pin,
      download: release.fetch,
      journal,
    }),
    enableForAgents: async () => {
      enabled += 1;
    },
  };
  const paths = vaultPaths(stateDirectory(home, host, ownAccount));
  return {
    home,
    vault,
    pin,
    release,
    journal,
    host: host_,
    paths,
    enabled: () => enabled,
    /** The own organizations of the account. */
    owned: () => vault.organizationsOf(ownAccount),
    async close() {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const mode = async (path: string) => (await lstat(path)).mode & 0o777;
const facts = {
  vault: vaultOrigin,
  account: ownAccount,
  name: vaultName,
  team: false,
  origin: "own",
} as const;

test.skipIf(!posix)(
  "an Environment sets up its own vault: not allowed, then registered, its organization created with Agenti, connected, and set up again without a change",
  async () => {
    const w = await world();
    try {
      // Nothing yet, and nothing is read from the network.
      expect(await vaultStatus(w.host)).toEqual({
        kind: "vault-status",
        state: "not-set-up",
        ...facts,
        next: "install",
      });
      expect(w.vault.requests).toHaveLength(0);

      // Not pre-allowed: the vault refuses the registration and nothing of
      // the account is left behind (the CLI is installed by then).
      const phases: string[] = [];
      expect(await vaultSetup(w.host, (phase) => phases.push(phase))).toEqual({
        kind: "vault-status",
        state: "not-allowed",
        ...facts,
      });
      expect(phases).toEqual(["install", "account"]);
      expect(await readAccount(w.paths)).toBeNull();
      expect(w.vault.users.size).toBe(0);
      expect(await vaultStatus(w.host)).toMatchObject({
        state: "not-set-up",
        next: "account",
      });

      // Pre-allowed by the network: registered, its own vault created, bw
      // signed in and unlocked.
      w.vault.allow(ownAccount);
      phases.length = 0;
      const connected = await vaultSetup(w.host, (phase) => phases.push(phase));
      expect(phases).toEqual(["install", "account", "vault", "sign-in"]);
      const [organization] = w.owned();
      if (organization === undefined) throw new Error("Expected the vault");
      const agentsId = organization.collections[0]?.id ?? "?";
      expect(connected).toEqual({
        kind: "vault-status",
        state: "connected",
        ...facts,
        organizationId: organization.id,
        collectionId: agentsId,
        organization: vaultName,
        items: 0,
      });
      // Exactly one organization, named as the handover says, with the
      // account its only member, an Owner, and one collection.
      expect(w.owned()).toHaveLength(1);
      expect(organization.name).toBe(vaultName);
      expect(organization.billingEmail).toBe(ownAccount);
      expect([...organization.members.values()]).toEqual([
        expect.objectContaining({ type: 0, status: 2 }),
      ]);
      expect(organization.collections).toHaveLength(1);
      // The request carries keys only in their encrypted forms.
      const [created] = w.vault.of("/api/organizations", "POST");
      expect(created?.body).toEqual({
        name: vaultName,
        billingEmail: ownAccount,
        key: expect.stringMatching(/^4\./),
        keys: {
          publicKey: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/),
          encryptedPrivateKey: expect.stringMatching(/^2\./),
        },
        collectionName: expect.stringMatching(/^2\./),
        planType: 0,
      });
      // The vault is remembered by its ID, and so is Agenti.
      expect(await readRecord(w.paths)).toEqual({
        organizationId: organization.id,
        collectionId: agentsId,
        pendingKey: null,
        pendingSince: null,
      });
      expect(w.journal).toContainEqual({
        operation: "vault",
        outcome: "created",
      });
      const stored = await readAccount(w.paths);
      expect(stored).toMatchObject({ email: ownAccount, server: vaultOrigin });
      expect(stored?.clientId).toBe(
        `user.${w.vault.users.get(ownAccount)?.id ?? "?"}`,
      );
      // The one device of the Environment is the account file's, for the
      // password and the API-key logins alike.
      expect(w.vault.users.get(ownAccount)?.devices).toEqual([
        stored?.deviceIdentifier ?? "?",
      ]);
      expect(await mode(w.paths.directory)).toBe(0o700);
      expect(await mode(w.paths.data)).toBe(0o700);
      expect(await mode(w.paths.account)).toBe(0o600);
      expect(await mode(w.paths.session)).toBe(0o600);
      expect(await mode(w.paths.record)).toBe(0o600);

      // The local status reads the same from bw's copy.
      expect(await vaultStatus(w.host)).toEqual(connected);
      expect(setUpAtStart(connected)).toBe(false);

      // Agents get the one unlocked session, the vault and Agenti.
      const session = await readSession(w.paths);
      expect(await vaultEnv(w.host)).toEqual({
        kind: "vault-env",
        env: {
          BITWARDENCLI_APPDATA_DIR: w.paths.data,
          BW_SESSION: session ?? "?",
          LAZURIO_VAULT_ORGANIZATION_ID: organization.id,
          LAZURIO_VAULT_COLLECTION_ID: agentsId,
        },
      });

      // Set up again: the same vault, no registration, creation or rename.
      const before = w.vault.requests.length;
      expect(await vaultSetup(w.host)).toEqual(connected);
      const again = w.vault.requests.slice(before).map((entry) => entry.path);
      expect(again).not.toContain("/identity/accounts/register/finish");
      expect(again).not.toContain("/api/organizations");
      expect(w.vault.of("/api/organizations", "POST")).toHaveLength(1);
      expect(w.vault.requests.some((entry) => entry.method === "PUT")).toBe(
        false,
      );

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
      // The release was downloaded once; the later setups found it.
      expect(w.release.requests).toHaveLength(1);
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a new name in the handover renames the vault, which stays the same by its ID",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      const first = await vaultSetup(w.host);
      expect(first).toMatchObject({ state: "connected" });
      const renamed: VaultHost = {
        ...w.host,
        context: async () =>
          ownContext(
            personalHandoverAt(
              "example.lazurio.io",
              vaultMember(ownAccount, "Example Osobní renamed"),
            ),
          ),
      };
      // The local status sees the name the handover now gives: the start
      // sets it up again.
      const before = await vaultStatus(renamed);
      expect(before).toMatchObject({
        state: "connected",
        name: "Example Osobní renamed",
        organization: vaultName,
      });
      expect(setUpAtStart(before)).toBe(true);
      const after = await vaultSetup(renamed);
      expect(after).toMatchObject({
        state: "connected",
        organization: "Example Osobní renamed",
      });
      expect(setUpAtStart(after)).toBe(false);
      expect(w.owned()).toHaveLength(1);
      expect(w.owned()[0]?.name).toBe("Example Osobní renamed");
      const [rename] = w.vault.requests.filter(
        (entry) => entry.method === "PUT",
      );
      expect(rename?.body).toEqual({
        name: "Example Osobní renamed",
        billingEmail: ownAccount,
      });
      expect(w.journal).toContainEqual({
        operation: "vault",
        outcome: "renamed",
      });
      // The record is the same: the ID is the vault.
      expect((await readRecord(w.paths)).organizationId).toBe(
        first.state === "connected" ? first.organizationId : "?",
      );
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a creation whose answer was lost is recognized by its receipt and never made twice",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      // The vault creates the organization, then the answer is lost.
      let lose = true;
      const host_: VaultHost = {
        ...w.host,
        fetch: async (url, init) => {
          const answer = await w.vault.fetch(url, init);
          if (lose && url.endsWith("/api/organizations"))
            throw new Error("connection reset");
          return answer;
        },
      };
      expect(await vaultSetup(host_)).toMatchObject({
        state: "unreachable",
        reason: "unreachable",
      });
      expect(w.owned()).toHaveLength(1);
      const receipt = await readRecord(w.paths);
      expect(receipt).toEqual({
        organizationId: null,
        collectionId: null,
        pendingKey: w.owned()[0]?.publicKey ?? "?",
        pendingSince: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      });
      // Not confirmed yet: the start looks for it again.
      const pending = await vaultStatus(host_);
      expect(pending).toEqual({
        kind: "vault-status",
        state: "creating",
        ...facts,
      });
      expect(setUpAtStart(pending)).toBe(true);
      lose = false;
      const connected = await vaultSetup(host_);
      expect(connected).toMatchObject({
        state: "connected",
        organizationId: w.owned()[0]?.id,
      });
      expect(w.owned()).toHaveLength(1);
      expect(w.vault.of("/api/organizations", "POST")).toHaveLength(1);
      expect(await readRecord(w.paths)).toMatchObject({ pendingKey: null });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an unresolved creation is never made again: a profile that omits the new organization leaves the vault creating, and the organization found later is the one vault",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      // The vault creates the organization, then the answer is lost.
      let lose = true;
      // How many profiles omit every organization (the vault lists the new
      // one late, or the request is still under way).
      let omit = 0;
      const host_: VaultHost = {
        ...w.host,
        fetch: async (url, init) => {
          const answer = await w.vault.fetch(url, init);
          if (lose && url.endsWith("/api/organizations"))
            throw new Error("connection reset");
          if (omit > 0 && url.endsWith("/api/accounts/profile")) {
            omit -= 1;
            const profile = (await answer.json()) as Record<string, unknown>;
            return Response.json({ ...profile, organizations: [] });
          }
          return answer;
        },
      };
      expect(await vaultSetup(host_)).toMatchObject({ state: "unreachable" });
      expect(w.owned()).toHaveLength(1);
      const receipt = await readRecord(w.paths);
      lose = false;
      omit = 1;
      // The profile omits it: nothing is created, the receipt stays.
      expect(await vaultSetup(host_)).toEqual({
        kind: "vault-status",
        state: "creating",
        ...facts,
      });
      expect(w.owned()).toHaveLength(1);
      expect(w.vault.of("/api/organizations", "POST")).toHaveLength(1);
      expect(await readRecord(w.paths)).toEqual(receipt);
      expect(await vaultStatus(host_)).toMatchObject({ state: "creating" });
      // Listed again: the organization that carries the receipt is the vault.
      expect(await vaultSetup(host_)).toMatchObject({
        state: "connected",
        organizationId: w.owned()[0]?.id,
      });
      expect(w.owned()).toHaveLength(1);
      expect(w.vault.of("/api/organizations", "POST")).toHaveLength(1);
      expect(await readRecord(w.paths)).toMatchObject({
        organizationId: w.owned()[0]?.id,
        pendingKey: null,
        pendingSince: null,
      });
      expect(w.journal).not.toContainEqual({
        operation: "vault",
        outcome: "receipt-expired",
      });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a receipt that matches nothing waits out its bound, then the creation that never happened is made once",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      let clock = Date.parse("2026-10-14T01:00:00.000Z");
      // The creation never reaches the vault: no answer, no organization.
      let drop = true;
      const host_: VaultHost = {
        ...w.host,
        now: () => new Date(clock),
        fetch: async (url, init) => {
          if (drop && url.endsWith("/api/organizations"))
            throw new Error("connection reset");
          return w.vault.fetch(url, init);
        },
      };
      expect(await vaultSetup(host_)).toMatchObject({ state: "unreachable" });
      drop = false;
      expect(w.owned()).toHaveLength(0);
      expect(await readRecord(w.paths)).toMatchObject({
        organizationId: null,
        pendingSince: "2026-10-14T01:00:00.000Z",
      });
      // Within the bound nothing is created, however often it is asked.
      for (const minutes of [1, 14]) {
        clock = Date.parse("2026-10-14T01:00:00.000Z") + minutes * 60_000;
        expect(await vaultSetup(host_)).toMatchObject({ state: "creating" });
      }
      expect(w.vault.of("/api/organizations", "POST")).toHaveLength(0);
      // Past it, still found nowhere: the receipt is discarded, and the
      // vault is created once.
      clock = Date.parse("2026-10-14T01:15:00.000Z");
      expect(await vaultSetup(host_)).toMatchObject({ state: "connected" });
      expect(w.owned()).toHaveLength(1);
      expect(w.vault.of("/api/organizations", "POST")).toHaveLength(1);
      expect(w.journal).toContainEqual({
        operation: "vault",
        outcome: "receipt-expired",
      });
      expect(await readRecord(w.paths)).toMatchObject({
        organizationId: w.owned()[0]?.id,
        pendingKey: null,
        pendingSince: null,
      });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a vault that is gone or an API key refused is revoked and never replaced; a damaged record is never written over",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      const connected = await vaultSetup(w.host);
      if (connected.state !== "connected") throw new Error("Expected it");
      // The network's operator deletes the organization.
      await w.vault.deleteOrganization(connected.organizationId);
      expect(await vaultRefresh(w.host)).toEqual({
        kind: "vault-status",
        state: "revoked",
        ...facts,
      });
      expect(await vaultStatus(w.host)).toMatchObject({ state: "revoked" });
      expect(setUpAtStart(await vaultStatus(w.host))).toBe(false);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "revoked" });
      expect(w.vault.of("/api/organizations", "POST")).toHaveLength(1);
      expect((await readRecord(w.paths)).organizationId).toBe(
        connected.organizationId,
      );

      // A damaged record: the setup refuses and leaves it as it is.
      await writeFile(w.paths.record, "{damaged", { mode: 0o600 });
      const damaged = {
        state: "failed",
        stage: "vault",
        reason: "record-unreadable",
        fallback: "agent",
      };
      expect(await vaultStatus(w.host)).toMatchObject(damaged);
      expect(await vaultSetup(w.host)).toMatchObject(damaged);
      expect(await readFile(w.paths.record, "utf8")).toBe("{damaged");
      expect(w.vault.of("/api/organizations", "POST")).toHaveLength(1);
      expect(await vaultEnv(w.host)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "the setup in which the own vault becomes ready turns the agents' switch on once: never a refused setup, a later one, one after a lost session or a rename; a switch that fails is journaled, never the setup's",
  async () => {
    const w = await world();
    try {
      // Not allowed yet: no vault, no switch.
      expect(await vaultSetup(w.host)).toMatchObject({ state: "not-allowed" });
      expect(w.enabled()).toBe(0);
      w.vault.allow(ownAccount);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      expect(w.enabled()).toBe(1);
      expect(w.journal).toContainEqual({
        operation: "vault",
        outcome: "ready",
      });
      // The same vault set up again, after its session was lost (the start's
      // case after a person turned the switch off) and under a new name.
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      await rm(join(w.paths.data, "fake", "session"));
      expect(await vaultStatus(w.host)).toMatchObject({ locked: true });
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      const renamed: VaultHost = {
        ...w.host,
        context: async () =>
          ownContext(
            personalHandoverAt(
              "example.lazurio.io",
              vaultMember(ownAccount, "Example Osobní renamed"),
            ),
          ),
      };
      expect(await vaultSetup(renamed)).toMatchObject({
        state: "connected",
        organization: "Example Osobní renamed",
      });
      expect(w.enabled()).toBe(1);
      expect(
        w.journal.filter((entry) => entry.outcome === "ready"),
      ).toHaveLength(1);
    } finally {
      await w.close();
    }
    // A switch that cannot be turned: the setup still connects, and the
    // journal says so with a fixed code.
    const failing = await world();
    try {
      failing.vault.allow(ownAccount);
      const host: VaultHost = {
        ...failing.host,
        enableForAgents: async () => {
          throw new Error("The Folder is busy");
        },
      };
      expect(await vaultSetup(host)).toMatchObject({ state: "connected" });
      expect(failing.journal).toContainEqual({
        operation: "vault",
        outcome: "agents-not-enabled",
      });
    } finally {
      await failing.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a refused API key is revoked, and a vault that does not let the account create organizations says so",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      w.vault.flags.organizationRefused = true;
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "failed",
        stage: "vault",
        reason: "organization-refused",
        fallback: "agent",
      });
      expect(w.owned()).toHaveLength(0);
      w.vault.flags.organizationRefused = false;
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      await w.vault.rotateApiKey(ownAccount);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "revoked" });
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
      w.vault.allow(ownAccount);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      const first = await readSession(w.paths);
      // A rogue `bw lock` (agents never run it): the session is no longer
      // the unlocked one.
      const store = join(w.paths.data, "fake", "session");
      await rm(store);
      const locked = await vaultStatus(w.host);
      expect(locked).toMatchObject({
        state: "connected",
        locked: true,
        organization: null,
        items: null,
      });
      expect(setUpAtStart(locked)).toBe(true);
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
      expect(
        w.journal.filter((entry) => entry.operation === "unlock"),
      ).toHaveLength(3);
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
      w.vault.allow(ownAccount);
      w.vault.flags.rateLimit = true;
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "failed",
        stage: "account",
        reason: "rate-limited",
        fallback: "agent",
      });
      w.vault.flags.rateLimit = false;
      w.vault.flags.smtp = true;
      expect(await vaultSetup(w.host)).toMatchObject({
        state: "failed",
        stage: "account",
        reason: "smtp-enabled",
      });
      w.vault.flags.smtp = false;
      // The password written before the first attempt is the one that
      // registers now.
      const pending = await readAccount(w.paths);
      expect(pending?.clientId).toBeUndefined();
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      expect((await readAccount(w.paths))?.masterPassword).toBe(
        pending?.masterPassword,
      );
      await w.vault.unreachable(true);
      expect(await vaultRefresh(w.host)).toMatchObject({
        state: "unreachable",
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
  "a registration interrupted before its API key is resumed by a login, never a second registration, and its account file is never removed",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      // The vault answers the registration, then the network drops before
      // the login.
      let drop = true;
      const host_: VaultHost = {
        ...w.host,
        fetch: async (url, init) => {
          if (drop && url.endsWith("/identity/accounts/prelogin"))
            throw new Error("network down");
          return w.vault.fetch(url, init);
        },
      };
      expect(await vaultSetup(host_)).toMatchObject({
        state: "unreachable",
        reason: "unreachable",
      });
      expect(w.vault.users.has(ownAccount)).toBe(true);
      const pending = await readAccount(w.paths);
      expect(pending?.clientId).toBeUndefined();
      drop = false;
      // The vault refuses the login of the registered account (here: it no
      // longer takes the password), so the resumed run asks to register,
      // and the vault refuses that too, as it refuses an address that is
      // not allowed. The account file is the only copy of the registered
      // account's password: it stays.
      const user = w.vault.users.get(ownAccount);
      if (user === undefined) throw new Error("registered user");
      const hash = user.hash;
      user.hash = "refused";
      expect(await vaultSetup(host_)).toMatchObject({ state: "not-allowed" });
      expect(await readAccount(w.paths)).toEqual(pending);
      user.hash = hash;
      expect(await vaultSetup(host_)).toMatchObject({ state: "connected" });
      expect(w.vault.of("/identity/accounts/register/finish")).toHaveLength(1);
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an account the handover replaces starts in a directory of its own, the earlier one is untouched, and an account file out of place is never used",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      const before = {
        account: await readFile(w.paths.account, "utf8"),
        session: await readSession(w.paths),
        record: await readFile(w.paths.record, "utf8"),
      };
      // The network hands this Environment another account.
      const replaced =
        "vaultwarden-aaaabbbbccccddddeeeeffffgg@example.lazurio.io";
      const host_: VaultHost = {
        ...w.host,
        context: async () =>
          ownContext(
            personalHandoverAt(
              "example.lazurio.io",
              vaultMember(replaced, "Example Osobní replaced"),
            ),
          ),
      };
      const unlocks = () =>
        w.journal.filter((entry) => entry.operation === "unlock").length;
      const unlocked = unlocks();
      expect(await vaultStatus(host_)).toEqual({
        kind: "vault-status",
        state: "not-set-up",
        vault: vaultOrigin,
        account: replaced,
        name: "Example Osobní replaced",
        team: false,
        origin: "own",
        next: "account",
      });
      expect(await vaultEnv(host_)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });
      expect(unlocks()).toBe(unlocked);
      // Not allowed by the network yet: refused, nothing of it left.
      expect(await vaultSetup(host_)).toMatchObject({
        state: "not-allowed",
        account: replaced,
      });
      // The earlier account's files are untouched.
      expect(await readFile(w.paths.account, "utf8")).toBe(before.account);
      expect(await readSession(w.paths)).toBe(before.session);
      expect(await readFile(w.paths.record, "utf8")).toBe(before.record);

      // The earlier account's files copied under the new account are not the
      // new account's: everything refuses, nothing runs, and the file is
      // never replaced.
      const misplaced = vaultPaths(stateDirectory(w.home, host, replaced));
      await writeFile(misplaced.account, before.account, { mode: 0o600 });
      const mismatch = {
        state: "failed",
        stage: "account",
        reason: "account-mismatch",
      };
      expect(await vaultStatus(host_)).toMatchObject(mismatch);
      expect(await vaultRefresh(host_)).toMatchObject(mismatch);
      expect(await vaultSetup(host_)).toMatchObject(mismatch);
      expect(await vaultEnv(host_)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });
      expect(unlocks()).toBe(unlocked);
      expect(await readFile(misplaced.account, "utf8")).toBe(before.account);
      expect(w.journal.at(-1)).toEqual({
        operation: "setup",
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
  "a damaged or missing account file changes nothing, and the file restored restores the vault",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      const original = await readFile(w.paths.account, "utf8");
      const session = await readSession(w.paths);
      const files = async () =>
        Promise.all(
          [
            join(w.paths.data, "data.json"),
            join(w.paths.data, "fake", "user"),
            w.paths.session,
            w.paths.record,
          ].map((path) => readFile(path, "utf8").catch(() => null)),
        );
      const before = await files();
      expect(before).not.toContain(null);
      const unlocks = () =>
        w.journal.filter((entry) => entry.operation === "unlock").length;
      const unlocked = unlocks();

      await writeFile(w.paths.account, "{invalid", { mode: 0o600 });
      const unreadable = {
        state: "failed",
        stage: "account",
        reason: "account-unreadable",
      };
      expect(await vaultStatus(w.host)).toMatchObject(unreadable);
      expect(await vaultRefresh(w.host)).toMatchObject(unreadable);
      expect(await vaultSetup(w.host)).toMatchObject(unreadable);
      expect(await vaultEnv(w.host)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });
      expect(await readFile(w.paths.account, "utf8")).toBe("{invalid");
      expect(await files()).toEqual(before);
      expect(unlocks()).toBe(unlocked);

      // Restored: connected as before, with the same session.
      await writeFile(w.paths.account, original, { mode: 0o600 });
      expect(await vaultStatus(w.host)).toMatchObject({ state: "connected" });
      const env = await vaultEnv(w.host);
      expect(env.kind === "vault-env" ? env.env.BW_SESSION : null).toBe(
        session,
      );
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a bw profile signed in to another account in the Environment's data directory is never used, and setup signs the Environment's own account in again",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      const email = join(w.paths.data, "fake", "email");
      await writeFile(email, "person@example.lazurio.io\n");
      const unlocks = () =>
        w.journal.filter((entry) => entry.operation === "unlock").length;
      const unlocked = unlocks();
      const signedOut = await vaultStatus(w.host);
      expect(signedOut).toMatchObject({ state: "not-set-up", next: "sign-in" });
      expect(setUpAtStart(signedOut)).toBe(true);
      expect(await vaultRefresh(w.host)).toMatchObject({
        state: "not-set-up",
        next: "sign-in",
      });
      expect(await vaultEnv(w.host)).toEqual({
        kind: "vault-env-refused",
        reason: "not-connected",
      });
      expect(unlocks()).toBe(unlocked);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      expect((await readFile(email, "utf8")).trim()).toBe(ownAccount);
      expect(w.owned()).toHaveLength(1);
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
      w.vault.allow(ownAccount);
      await vaultSetup(w.host);
      const binary = pinnedBinary(w.host.base, w.pin);
      expect(await mode(binary)).toBe(0o755);
      const entry = join(w.home, ".local", "bin", "bw");
      const wrapper = await readFile(entry, "utf8");
      expect(wrapper).toContain(`exec '${binary}' "$@"`);
      expect(wrapper).toContain(`BITWARDENCLI_APPDATA_DIR='${w.paths.data}'`);
      // A tampered release is refused before anything is read from it.
      await rm(binary);
      const host_: VaultHost = {
        ...w.host,
        download: async () =>
          new Response(new Uint8Array(zipOf("bw", "#!/bin/sh\nexit 0\n"))),
      };
      expect(await vaultSetup(host_)).toMatchObject({
        state: "failed",
        stage: "install",
        reason: "checksum-mismatch",
      });
      // A `bw` in ~/.local/bin that is not Lazurio's is never replaced.
      await writeFile(entry, "#!/bin/sh\necho mine\n", { mode: 0o755 });
      expect(await vaultSetup(w.host)).toMatchObject({
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
    for (const reason of ["workstation", "no-vault"] as const) {
      const host_: VaultHost = {
        context: async () => ({ kind: "unsupported", reason }),
        directory: () => join(parent, "never"),
        base: join(parent, "never"),
        bin: join(parent, "never"),
        home: parent,
        path: undefined,
        platform: "linux",
        arch: "x64",
        run: async () => {
          throw new Error("nothing may run");
        },
        fetch: async () => {
          throw new Error("nothing may be asked");
        },
      };
      const unsupported: VaultStatus = {
        kind: "vault-status",
        state: "unsupported",
        reason,
      };
      expect(await vaultStatus(host_)).toEqual(unsupported);
      expect(await vaultSetup(host_)).toEqual(unsupported);
      expect(await vaultRefresh(host_)).toEqual(unsupported);
      expect(setUpAtStart(unsupported)).toBe(false);
      expect(await vaultEnv(host_)).toEqual({
        kind: "vault-env-refused",
        reason,
      });
    }
    expect(await lstat(join(parent, "never")).catch(() => null)).toBeNull();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the start sets up only an own vault that needs it", () => {
  const status = (value: object) => value as VaultStatus;
  expect(
    setUpAtStart(status({ state: "not-set-up", origin: "own", next: "vault" })),
  ).toBe(true);
  // A creation not confirmed yet is looked for again.
  expect(setUpAtStart(status({ state: "creating", origin: "own" }))).toBe(true);
  for (const state of ["not-allowed", "revoked", "unreachable", "failed"])
    expect([state, setUpAtStart(status({ state, origin: "own" }))]).toEqual([
      state,
      false,
    ]);
  // A 0197 pilot is only read.
  expect(
    setUpAtStart(
      status({
        state: "connected",
        origin: "pilot-0197",
        locked: true,
        organization: null,
        name: null,
      }),
    ),
  ).toBe(false);
});
