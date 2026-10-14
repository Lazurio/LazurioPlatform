import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type VaultHost,
  type VaultJournalEntry,
  vaultSetup,
} from "../src/vault/flow";
import { agentsCollection } from "../src/vault/organization";
import {
  decrypt,
  deriveMasterKey,
  publicKeyOf,
  rsaDecrypt,
  stretchMasterKey,
  symmetricKey,
} from "../src/vault/register";
import { readAccount, readRecord, vaultPaths } from "../src/vault/store";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownAccount,
  startFakeVault,
  stateDirectory,
  zipOf,
} from "./fixtures/fake-vault";

// The Environment's own organization (decision F53, src/vault/organization.ts)
// as the vault keeps it: what the account sent can be opened by the account
// alone, from its own master password down to the collection's name; and the
// organization step never guesses which collection is Agenti.

const posix = process.platform !== "win32";

async function world() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-org-")));
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const journal: VaultJournalEntry[] = [];
  const host = fakeHost({
    home,
    vault,
    pin,
    download: fakeRelease(pin, zip).fetch,
    journal,
  });
  return {
    vault,
    host,
    journal,
    paths: vaultPaths(
      stateDirectory(home, "vaultwarden.example.lazurio.io", ownAccount),
    ),
    async close() {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test.skipIf(!posix)(
  "the account opens its own organization key with its own master password, and the key opens Agenti's name and the organization's private key",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      expect(await vaultSetup(w.host)).toMatchObject({ state: "connected" });
      const account = await readAccount(w.paths);
      const user = w.vault.users.get(ownAccount);
      const [organization] = w.vault.organizationsOf(ownAccount);
      if (account === null || user === undefined || organization === undefined)
        throw new Error("Expected the account and its vault");
      const member = organization.members.get(user.id);
      if (member === undefined) throw new Error("Expected the membership");

      // The account's keys, as any of its clients unlocks them: the master
      // key from the password, the user key it wraps, the private key the
      // user key wraps.
      const masterKey = await deriveMasterKey(
        account.masterPassword,
        account.email,
      );
      const userKey = symmetricKey(
        await decrypt(user.protectedUserKey, await stretchMasterKey(masterKey)),
      );
      const privateKey = await decrypt(user.encryptedPrivateKey, userKey);
      // The key the organization key was encrypted to is the account's own.
      expect(await publicKeyOf(privateKey)).toBe(user.publicKey);

      // The organization key, encrypted to the account (EncString type 4).
      expect(member.key.startsWith("4.")).toBe(true);
      const organizationKey = symmetricKey(
        await rsaDecrypt(privateKey, member.key),
      );
      // It opens the first collection's name …
      const [first] = organization.collections;
      expect(text(await decrypt(first?.name ?? "", organizationKey))).toBe(
        agentsCollection,
      );
      expect(agentsCollection).toBe("Agenti");
      // … and the organization's private key, whose public key is the one the
      // vault keeps (and the receipt the setup recorded first).
      const organizationPrivateKey = await decrypt(
        organization.encryptedPrivateKey,
        organizationKey,
      );
      expect(await publicKeyOf(organizationPrivateKey)).toBe(
        organization.publicKey,
      );
      // Nothing of the keys is kept on the Environment but the account file
      // the account already had.
      expect(await readRecord(w.paths)).toEqual({
        organizationId: organization.id,
        collectionId: first?.id ?? "?",
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
  "an organization recognized by its receipt with more than one collection is not given an Agenti by guess",
  async () => {
    const w = await world();
    try {
      w.vault.allow(ownAccount);
      let lose = true;
      const host: VaultHost = {
        ...w.host,
        fetch: async (url, init) => {
          const answer = await w.vault.fetch(url, init);
          if (lose && url.endsWith("/api/organizations"))
            throw new Error("connection reset");
          return answer;
        },
      };
      expect(await vaultSetup(host)).toMatchObject({ state: "unreachable" });
      const [organization] = w.vault.organizationsOf(ownAccount);
      if (organization === undefined) throw new Error("Expected the vault");
      // Before the Environment asks again, the organization has a second
      // collection.
      await w.vault.addCollection(organization.id);
      lose = false;
      expect(await vaultSetup(host)).toMatchObject({
        state: "failed",
        stage: "vault",
        reason: "collection-unknown",
        fallback: "agent",
      });
      // The organization is recorded, Agenti is not, and no second
      // organization was created.
      expect(await readRecord(w.paths)).toEqual({
        organizationId: organization.id,
        collectionId: null,
        pendingKey: null,
        pendingSince: null,
      });
      expect(w.vault.organizationsOf(ownAccount)).toHaveLength(1);
      expect(w.journal).not.toContainEqual({
        operation: "vault",
        outcome: "created",
      });
    } finally {
      await w.close();
    }
  },
  60_000,
);
