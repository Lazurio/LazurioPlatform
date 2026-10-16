import { bitwardenRegionOf } from "./endpoints";
import {
  accountKdf,
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

// The Environment's own vault (root decision 0198 point 1, decision F53): its
// own organization in the network's Lazurio Vaultwarden, created by its
// technical account, which is its only Owner, and remembered by ID; names
// never decide what it is. bw cannot create an organization, so this asks
// the vault's API as the account (its API key), with the requests the web
// vault sends; the DEV-6631 study of 2026-10-12 proved them against
// Vaultwarden 1.37.4-lazurio.1 (its `scripts/org.ts`). Nothing secret is
// returned or kept: the organization key exists in memory during its
// creation, then only in the vault, encrypted to the account's own key.
//
// A personal Environment's vault is the same, in the person's own Bitwarden
// (root decision 0203 point 7): a Free organization its agents' account
// creates and owns, on the Bitwarden cloud's API, which also wants
// `useSecretsManager` named. The cloud refuses a second Free organization of
// an account that owns or administers one (`free-organization-limit`).

/** The first collection of every Environment's vault, where agents keep
 * what they create (decision F53). */
export const agentsCollection = "Agenti";

/** A membership the vault reports as confirmed (status 2): the account holds
 * the organization's key. */
const confirmed = 2;

/** How long a creation's receipt keeps every new creation back: far longer
 * than any request may take (30 s), so an organization whose answer was
 * lost, that the vault lists late or whose request arrived late is found by
 * its receipt and never made twice. Only a receipt this old that still
 * matches no organization is taken for a creation that never happened. */
export const receiptBoundMs = 15 * 60_000;

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
  | Readonly<{ kind: "collection-unknown" }>
  /** A creation was asked for and no organization carries its receipt yet
   * (its answer was lost, the vault lists it late, or the request is still
   * under way), or the one that does is not confirmed for the account yet:
   * nothing is created again (unmatched, until the receipt is older than
   * `receiptBoundMs`); the next run looks again. */
  | Readonly<{ kind: "creating" }>;

type Membership = Readonly<{ id: string; name: string; confirmed: boolean }>;

const unexpected = () => new VaultwardenError("unexpected");

/** The organizations the account is a member of, from its profile: the
 * confirmed ones, or (`any`) those of every status, where a creation's
 * receipt is looked for; every entry must read, or the whole answer is
 * unexpected. */
function membershipsOf(
  profile: unknown,
  status: "confirmed" | "any" = "confirmed",
): Membership[] {
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
    const member = organization.status === confirmed;
    return status === "any" || member
      ? [{ id: organization.id, name: organization.name, confirmed: member }]
      : [];
  });
}

/** Whether an answer of the vault refuses the request itself (4xx but a
 * rate limit): it was not carried out. */
const refused = (error: unknown): boolean =>
  error instanceof VaultwardenError &&
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 429;

/** Whether one organization carries a creation's receipt: the public key the
 * vault's API shows the signed-in account for it (`GET /api/organizations/
 * <id>/public-key`) is the one recorded before the creation was asked for
 * (`carries`), another (`other`), or one the vault refuses to show, a 4xx but
 * a rate limit (`refused`). Any other failure throws. The one test of a
 * receipt: the setup finds its creation by it (`ensureOwnVault`), and a
 * personal Environment's connection tells its own vault from another
 * organization of the account by it (connection.ts). */
export async function carriesReceipt(
  ask: (path: string) => Promise<unknown>,
  organizationId: string,
  pendingKey: string,
): Promise<"carries" | "other" | "refused"> {
  let answer: Record<string, unknown> | null;
  try {
    answer = plainObject(
      await ask(`/api/organizations/${organizationId}/public-key`),
    );
  } catch (error) {
    if (refused(error)) return "refused";
    throw error;
  }
  return answer?.publicKey === pendingKey ? "carries" : "other";
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
 *   recorded first, with the time, as the creation's receipt;
 * - a receipt not resolved yet: the organization that carries its public
 *   key, among the account's memberships of any status, recorded once the
 *   membership is confirmed (until then `creating`). While none carries it,
 *   nothing is created again (`creating`) until the receipt is older than
 *   `receiptBoundMs`: an answer that was lost, a profile that lists it late
 *   or a request that arrives late never makes a second vault. Only then is
 *   the receipt taken for a creation that never happened, discarded
 *   (`discarded`) and the vault created anew. A creation the vault refuses
 *   with its answer discards the receipt at once;
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
    now: () => Date;
    /** A receipt older than the bound that matched nothing was discarded. */
    discarded?: (() => void) | undefined;
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
  const profile = await ask("/api/accounts/profile");
  const memberships = membershipsOf(profile);

  // A creation not resolved yet: its organization carries the public key
  // recorded before it was asked for, under a membership of any status. A
  // membership whose key the vault refuses to show is not it; any other
  // failure throws, and the receipt stays for the next run.
  if (record.organizationId === null && record.pendingKey !== null) {
    let found: Membership | null = null;
    for (const membership of membershipsOf(profile, "any"))
      if (
        (await carriesReceipt(ask, membership.id, record.pendingKey)) ===
        "carries"
      ) {
        found = membership;
        break;
      }
    if (found?.confirmed === true)
      await save({
        organizationId: found.id,
        collectionId: null,
        pendingKey: null,
        pendingSince: null,
      });
    // Created, but the account's membership is not confirmed yet: it is
    // this vault, so it is waited for however long it takes.
    else if (found !== null) return Object.freeze({ kind: "creating" });
    // Young, or of a time that does not read: wait.
    else if (
      !(
        input.now().getTime() - Date.parse(record.pendingSince ?? "") >=
        receiptBoundMs
      )
    )
      return Object.freeze({ kind: "creating" });
    else {
      // Older than the bound and found nowhere: that creation never
      // happened, so the vault is created anew.
      await save({
        organizationId: null,
        collectionId: null,
        pendingKey: null,
        pendingSince: null,
      });
      input.discarded?.();
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
      kdf: await accountKdf(client, login, account.email),
    });
    const organizationKey = randomBytes(64);
    const keys = await makeKeyPair(symmetricKey(organizationKey));
    if (!isPublicKey(keys.publicKey)) throw unexpected();
    await save({
      organizationId: null,
      collectionId: null,
      pendingKey: keys.publicKey,
      pendingSince: input.now().toISOString(),
    });
    let answer: Record<string, unknown> | null;
    try {
      answer = plainObject(
        await ask("/api/organizations", {
          json: {
            name: input.name,
            billingEmail: account.email,
            key: await rsaEncrypt(
              await publicKeyOf(privateKey),
              organizationKey,
            ),
            keys: {
              publicKey: keys.publicKey,
              encryptedPrivateKey: keys.encryptedPrivateKey,
            },
            collectionName: await encrypt(
              agentsCollection,
              symmetricKey(organizationKey),
            ),
            // Ignored by Vaultwarden, which has one plan; the web vault
            // sends it, and the Bitwarden cloud takes it: Free.
            planType: 0,
            // The Bitwarden cloud wants it named; the Vaultwarden request
            // stays the one proven against its image.
            ...(bitwardenRegionOf(server) === null
              ? {}
              : { useSecretsManager: false }),
          },
        }),
      );
    } catch (error) {
      // Refused by its answer, it created nothing: the receipt goes. No
      // answer, or a server error, may have created it: the receipt stays.
      if (refused(error))
        await save({
          organizationId: null,
          collectionId: null,
          pendingKey: null,
          pendingSince: null,
        });
      throw error;
    }
    if (!isVaultId(answer?.id)) throw unexpected();
    await save({
      organizationId: answer.id,
      collectionId: null,
      pendingKey: null,
      pendingSince: null,
    });
    organization = { id: answer.id, name: input.name, confirmed: true };
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
      pendingSince: null,
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
