import {
  apiKeyLogin,
  type Device,
  encrypt,
  makeKeyPair,
  publicKeyOf,
  randomBytes,
  rsaEncrypt,
  symmetricKey,
  unlockPrivateKey,
  type VaultClient,
  VaultwardenError,
  vaultRequest,
} from "./register";
import {
  isPublicKey,
  isVaultId,
  plainObject,
  type ReadyAccount,
  type VaultRecord,
} from "./store";

// The Environment's own vault (root decision 0198 point 1, decision F52): its
// own organization in the network's Lazurio Vaultwarden, created by its
// technical account, which is its only Owner, and remembered by ID; names
// never decide what it is. bw cannot create an organization, so this asks
// the vault's API as the account (its API key), with the requests the web
// vault sends; the DEV-6631 study of 2026-10-12 proved them against
// Vaultwarden 1.37.4-lazurio.1 (its `scripts/org.ts`). Nothing secret is
// returned or kept: the organization key exists in memory during its
// creation, then only in the vault, encrypted to the account's own key.

/** The first collection of every Environment's vault, where agents keep
 * what they create (decision F52). */
export const agentsCollection = "Agenti";

/** A membership the vault reports as confirmed (status 2): the account holds
 * the organization's key. */
const confirmed = 2;

export type OwnVault =
  | Readonly<{
      kind: "ready";
      organizationId: string;
      /** The collection Agenti, by its ID. */
      collectionId: string;
      /** Created in this run. */
      created: boolean;
      /** Renamed to the handover's name in this run. */
      renamed: boolean;
    }>
  /** The recorded organization is no longer the account's: only the
   * network's operator can delete it or remove the account from it (0198
   * point 2), so nothing is created in its place. */
  | Readonly<{ kind: "gone" }>
  /** The organization's collections do not say which one is Agenti (an
   * organization recognized by its receipt after other collections were
   * added): nothing is guessed by a name. */
  | Readonly<{ kind: "collection-unknown" }>;

type Membership = Readonly<{ id: string; name: string }>;

const unexpected = () => new VaultwardenError("unexpected");

/** The organizations the account is a confirmed member of, from its
 * profile; every entry must read, or the whole answer is unexpected. */
function membershipsOf(profile: unknown): Membership[] {
  const value = plainObject(profile);
  if (value === null || !Array.isArray(value.organizations)) throw unexpected();
  return value.organizations.flatMap((entry: unknown) => {
    const organization = plainObject(entry);
    if (
      organization === null ||
      !isVaultId(organization.id) ||
      typeof organization.name !== "string" ||
      organization.name.length > 512 ||
      typeof organization.status !== "number"
    )
      throw unexpected();
    return organization.status === confirmed
      ? [{ id: organization.id, name: organization.name }]
      : [];
  });
}

/**
 * Makes the account's own vault exist, as the record and the handover say,
 * and returns it:
 *
 * - recorded: the organization of the recorded ID, renamed when its name is
 *   not the handover's `vault.name`; gone when the account no longer belongs
 *   to it (never replaced);
 * - not recorded: created with `POST /api/organizations`: a new organization
 *   key (64 random bytes) RSA-OAEP-encrypted to the account's own public key,
 *   which is derived from its own private key (so the key is one this
 *   Environment can open, whatever the server says); the organization's RSA
 *   key pair, its private key wrapped by the organization key; the billing
 *   e-mail the account; the name `vault.name`; and the first collection,
 *   Agenti, its name encrypted with the organization key. Its public key is
 *   recorded first as the creation's receipt, so a creation whose answer was
 *   lost is recognized by it afterwards and never made twice;
 * - Agenti: the one collection of the organization, by its ID.
 *
 * Every step is saved as soon as it is known; a step the vault refuses
 * throws a `VaultwardenError` and the next run goes on from the record.
 */
export async function ensureOwnVault(
  input: Readonly<{
    client: VaultClient;
    server: string;
    account: ReadyAccount;
    name: string;
    device: Device;
    record: VaultRecord;
    save: (record: VaultRecord) => Promise<void>;
  }>,
): Promise<OwnVault> {
  const { account, client, server } = input;
  const login = await apiKeyLogin(client, {
    serverUrl: server,
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    device: input.device,
  });
  const ask = (
    path: string,
    options: Parameters<typeof vaultRequest>[3] = {},
  ) =>
    vaultRequest(client, server, path, {
      ...options,
      token: login.accessToken,
    });
  let record = input.record;
  const save = async (next: VaultRecord) => {
    record = next;
    await input.save(next);
  };
  const memberships = membershipsOf(await ask("/api/accounts/profile"));

  // A creation whose answer was lost: its organization carries the public
  // key recorded before it was asked for.
  if (record.organizationId === null && record.pendingKey !== null)
    for (const membership of memberships) {
      const answer = plainObject(
        await ask(`/api/organizations/${membership.id}/public-key`),
      );
      if (answer?.publicKey === record.pendingKey) {
        await save({
          organizationId: membership.id,
          collectionId: null,
          pendingKey: null,
        });
        break;
      }
    }

  let organization: Membership;
  let created = false;
  if (record.organizationId === null) {
    const privateKey = await unlockPrivateKey({
      email: account.email,
      password: account.masterPassword,
      protectedUserKey: login.protectedUserKey,
      encryptedPrivateKey: login.encryptedPrivateKey,
      iterations: login.iterations,
    });
    const organizationKey = randomBytes(64);
    const keys = await makeKeyPair(symmetricKey(organizationKey));
    if (!isPublicKey(keys.publicKey)) throw unexpected();
    await save({
      organizationId: null,
      collectionId: null,
      pendingKey: keys.publicKey,
    });
    const answer = plainObject(
      await ask("/api/organizations", {
        json: {
          name: input.name,
          billingEmail: account.email,
          key: await rsaEncrypt(await publicKeyOf(privateKey), organizationKey),
          keys: {
            publicKey: keys.publicKey,
            encryptedPrivateKey: keys.encryptedPrivateKey,
          },
          collectionName: await encrypt(
            agentsCollection,
            symmetricKey(organizationKey),
          ),
          // Ignored by Vaultwarden, which has one plan; the web vault sends it.
          planType: 0,
        },
      }),
    );
    if (!isVaultId(answer?.id)) throw unexpected();
    await save({
      organizationId: answer.id,
      collectionId: null,
      pendingKey: null,
    });
    organization = { id: answer.id, name: input.name };
    created = true;
  } else {
    const recorded = memberships.find(
      (membership) => membership.id === record.organizationId,
    );
    if (recorded === undefined) return Object.freeze({ kind: "gone" });
    organization = recorded;
  }

  let collectionId = record.collectionId;
  if (collectionId === null) {
    const answer = plainObject(
      await ask(`/api/organizations/${organization.id}/collections`),
    );
    if (answer === null || !Array.isArray(answer.data)) throw unexpected();
    const ids = answer.data.map((entry: unknown) => {
      const collection = plainObject(entry);
      if (
        collection === null ||
        !isVaultId(collection.id) ||
        collection.organizationId !== organization.id
      )
        throw unexpected();
      return collection.id;
    });
    const [only] = ids;
    if (only === undefined || ids.length !== 1)
      return Object.freeze({ kind: "collection-unknown" });
    collectionId = only;
    await save({
      organizationId: organization.id,
      collectionId,
      pendingKey: null,
    });
  }

  let renamed = false;
  if (organization.name !== input.name) {
    await ask(`/api/organizations/${organization.id}`, {
      method: "PUT",
      json: { name: input.name, billingEmail: account.email },
    });
    renamed = true;
  }
  return Object.freeze({
    kind: "ready",
    organizationId: organization.id,
    collectionId,
    created,
    renamed,
  });
}
