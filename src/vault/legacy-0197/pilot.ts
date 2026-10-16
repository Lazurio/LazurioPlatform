import { parseUniqueJson } from "../../providers/unique-json";
import type { BwCli } from "../bw";
import type { VaultHost } from "../flow";
import { pinnedInstalled } from "../install";
import {
  cliOf,
  lockMs,
  readSecrets,
  sharedSession,
  signedInAs,
  usableSession,
  withLock,
} from "../session";
import {
  accountOf,
  failedStatus,
  type SecretApplication,
  unsupportedStatus,
  type VaultEnvResult,
  type VaultFacts,
  type VaultSecretsRefusal,
  type VaultSecretsResult,
  type VaultStatus,
} from "../status";
import {
  isReady,
  isVaultId,
  plainObject,
  type ReadyAccount,
  readOwned,
  readSession,
  type VaultPaths,
  vaultPaths,
} from "../store";
import type { PilotContext } from "./context";

// FROZEN (README.md here): an Environment connected the 0197 way (decision
// F43) keeps working, read only, exactly as before, until its handover names
// its own vault: its status (connected, revoked, unreachable or failed), the
// one shared session unlocked for its agents, and the runtime secrets of
// decision F46 from the collection it recorded. Nothing here connects,
// registers, confirms, adopts a collection by its name or disconnects, and
// no file of the pilot is written but the shared session.

type Pilot = Readonly<{
  paths: VaultPaths;
  account: ReadyAccount;
  organizationId: string;
  collectionId: string;
}>;

/** The record of a 0197 connection, as F43 wrote it; anything else is no
 * record. */
async function pilotRecord(
  paths: VaultPaths,
): Promise<Readonly<{ organizationId: string; collectionId: string }> | null> {
  try {
    const text = await readOwned(paths.record);
    if (text === null) return null;
    const value = plainObject(parseUniqueJson(text));
    if (
      value === null ||
      Object.keys(value).sort().join() !==
        "collectionId,fingerprint,organizationId" ||
      !isVaultId(value.organizationId) ||
      !isVaultId(value.collectionId)
    )
      return null;
    return {
      organizationId: value.organizationId,
      collectionId: value.collectionId,
    };
  } catch {
    return null;
  }
}

/** The pilot of this Environment: its own readable, ready account file and
 * a recorded collection, in the directory F43 keyed by the Environment's
 * address. Null when it was never connected (or was disconnected): then the
 * Environment has no vault yet. */
async function pilotOf(
  host: Pick<VaultHost, "directory">,
  context: PilotContext,
): Promise<Pilot | null> {
  const paths = vaultPaths(host.directory(context.host, context.address));
  const account = await accountOf(paths, context);
  if (
    account === "unreadable" ||
    account === "mismatch" ||
    account === null ||
    !isReady(account)
  )
    return null;
  const record = await pilotRecord(paths);
  return record === null ? null : { paths, account, ...record };
}

/** Whether this Environment was connected the 0197 way and still is: read by
 * the production composition (`../host.ts`), so that a personal Environment
 * whose pilot was never connected connects its person's own Bitwarden
 * instead (root decision 0203 point 7), while a connected pilot keeps
 * working as before. */
export async function pilotConnected(
  directory: VaultHost["directory"],
  context: PilotContext,
): Promise<boolean> {
  return (await pilotOf({ directory }, context)) !== null;
}

const factsOf = (context: PilotContext): VaultFacts => ({
  vault: context.vault,
  account: context.account,
  name: null,
  team: context.environment === "team",
  origin: "pilot-0197",
});

/** The recorded collection in bw's copy, in an organization the account is
 * a confirmed member of, or gone. */
async function observe(
  bw: BwCli,
  session: string,
  pilot: Pilot,
  facts: VaultFacts,
): Promise<VaultStatus | "locked" | "unauthenticated"> {
  const organizations = await bw.organizations(session);
  if (!organizations.ok)
    return organizations.reason === "locked" ||
      organizations.reason === "unauthenticated"
      ? organizations.reason
      : failedStatus(facts, "status", organizations.reason);
  const collections = await bw.collections(session);
  if (!collections.ok)
    return collections.reason === "locked" ||
      collections.reason === "unauthenticated"
      ? collections.reason
      : failedStatus(facts, "status", collections.reason);
  const organization = organizations.value.find(
    (entry) => entry.id === pilot.organizationId && entry.status === 2,
  );
  const visible = collections.value.some(
    (entry) =>
      entry.id === pilot.collectionId &&
      entry.organizationId === pilot.organizationId,
  );
  if (organization === undefined || !visible)
    return { kind: "vault-status", state: "revoked", ...facts };
  const items = await bw.itemCount(session);
  return {
    kind: "vault-status",
    state: "connected",
    ...facts,
    organizationId: pilot.organizationId,
    collectionId: pilot.collectionId,
    organization: organization.name,
    items: items.ok ? items.value : null,
  };
}

const lockedStatus = (facts: VaultFacts, pilot: Pilot): VaultStatus => ({
  kind: "vault-status",
  state: "connected",
  ...facts,
  organizationId: pilot.organizationId,
  collectionId: pilot.collectionId,
  organization: null,
  items: null,
  locked: true,
});

/** The pilot's status from bw's local copy: no network, no mutation. */
export async function pilotStatus(
  host: VaultHost,
  context: PilotContext,
): Promise<VaultStatus> {
  const pilot = await pilotOf(host, context);
  if (pilot === null) return unsupportedStatus("no-vault");
  const facts = factsOf(context);
  if (!(await pinnedInstalled(host.base, host.pin)))
    return failedStatus(facts, "install", "not-installed");
  const bw = cliOf(host, pilot.paths);
  const session = await readSession(pilot.paths).catch(() => null);
  const state = await bw.status(session);
  if (state.ok && !signedInAs(state.value, pilot.account))
    return failedStatus(facts, "sign-in", "signed-out");
  if (session === null) return lockedStatus(facts, pilot);
  const seen = await observe(bw, session, pilot, facts);
  if (seen === "locked") return lockedStatus(facts, pilot);
  if (seen === "unauthenticated")
    return failedStatus(facts, "sign-in", "signed-out");
  return seen;
}

/** A sync, a new unlock when the session is no longer the unlocked one, and
 * the status after it. */
export async function pilotRefresh(
  host: VaultHost,
  context: PilotContext,
): Promise<VaultStatus> {
  const pilot = await pilotOf(host, context);
  if (pilot === null) return unsupportedStatus("no-vault");
  if (!(await pinnedInstalled(host.base, host.pin)))
    return pilotStatus(host, context);
  const facts = factsOf(context);
  return withLock(
    pilot.paths,
    host.lockMs ?? lockMs,
    () => pilotStatus(host, context),
    async () => {
      const journal = (status: VaultStatus) => {
        host.journal?.({
          operation: "refresh",
          outcome: status.state,
          ...("reason" in status ? { reason: status.reason } : {}),
        });
        return status;
      };
      const bw = cliOf(host, pilot.paths);
      let session = await usableSession(host, bw, pilot.paths, pilot.account);
      if (!session.ok)
        return journal(
          failedStatus(
            facts,
            "sign-in",
            session.reason === "unauthenticated"
              ? "signed-out"
              : session.reason,
          ),
        );
      let synced = await bw.sync(session.session);
      // Unlocked by another bw run since the check: unlock once more.
      if (!synced.ok && synced.reason === "locked" && !session.fresh) {
        session = await usableSession(host, bw, pilot.paths, pilot.account);
        if (!session.ok)
          return journal(failedStatus(facts, "sign-in", session.reason));
        synced = await bw.sync(session.session);
      }
      if (!synced.ok) {
        if (synced.reason === "unauthenticated")
          return journal(failedStatus(facts, "sign-in", "signed-out"));
        if (synced.reason === "invalid-credentials")
          return journal({ kind: "vault-status", state: "revoked", ...facts });
        if (synced.reason === "spawn-failed")
          return journal(failedStatus(facts, "sync", synced.reason));
        return journal({
          kind: "vault-status",
          state: "unreachable",
          ...facts,
          reason: synced.reason,
        });
      }
      const seen = await observe(bw, session.session, pilot, facts);
      if (seen === "locked" || seen === "unauthenticated")
        return journal(failedStatus(facts, "status", seen));
      return journal(seen);
    },
  );
}

/** The shared session and the pilot's recorded ids, for an agent's shell. */
export async function pilotEnv(
  host: VaultHost,
  context: PilotContext,
): Promise<VaultEnvResult> {
  const pilot = await pilotOf(host, context);
  if (pilot === null) return { kind: "vault-env-refused", reason: "no-vault" };
  const shared = await sharedSession(host, pilot.paths, pilot.account);
  if (!shared.ok) return { kind: "vault-env-refused", reason: shared.reason };
  return {
    kind: "vault-env",
    env: {
      BITWARDENCLI_APPDATA_DIR: pilot.paths.data,
      BW_SESSION: shared.session,
      LAZURIO_VAULT_ORGANIZATION_ID: pilot.organizationId,
      LAZURIO_VAULT_COLLECTION_ID: pilot.collectionId,
    },
  };
}

/** F46's rule of 0197, frozen: an application of the Organization that owns
 * the Environment (the collection is that Organization's); never a
 * Personalspace module, never on a personal Environment. */
function admission(
  context: PilotContext,
  application: SecretApplication,
): VaultSecretsRefusal | null {
  if (application.personalspace) return "personalspace";
  return context.organization !== null &&
    context.organization.toLowerCase() === application.company.toLowerCase()
    ? null
    : "other-organization";
}

/** Whether an application may read the pilot's collection, as far as is
 * known without running bw: a pilot that is not there is no vault. */
export async function pilotSecretsAdmission(
  host: VaultHost,
  context: PilotContext,
  application: SecretApplication,
): Promise<VaultSecretsRefusal | null> {
  if ((await pilotOf(host, context)) === null) return "no-vault-identity";
  return admission(context, application);
}

/** The runtime secrets from the recorded collection, as F46 read them. */
export async function pilotSecrets(
  host: VaultHost,
  context: PilotContext,
  input: SecretApplication & Readonly<{ names: readonly string[] }>,
): Promise<VaultSecretsResult> {
  const refuse = (reason: VaultSecretsRefusal): VaultSecretsResult => ({
    kind: "vault-secrets-refused",
    reason,
  });
  const pilot = await pilotOf(host, context);
  if (pilot === null) return refuse("no-vault-identity");
  const refusal = admission(context, input);
  if (refusal !== null) return refuse(refusal);
  const read = await readSecrets(
    () => sharedSession(host, pilot.paths, pilot.account),
    {
      organizationId: pilot.organizationId,
      collectionId: pilot.collectionId,
    },
    input.names,
  );
  return read.ok
    ? { kind: "vault-secrets", secrets: read.secrets }
    : refuse(read.reason);
}
