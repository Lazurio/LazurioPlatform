import {
  type AdmittedPerson,
  isAccountSubject,
  isLazurioUsername,
} from "../launchpad/hosted-trust";
import type { BwFailure, BwMember } from "./bw";
import type { VaultContext } from "./context";
import { connectedAccount, deviceOf, type VaultHost } from "./flow";
import { inviteeInvitation, settleInvitee } from "./invitee";
import { accountApi, VaultwardenError, vaultRequest } from "./register";
import { cliOf, lockMs, usableSession, withLock } from "./session";
import {
  plainObject,
  type ReadyAccount,
  readAssignment,
  type VaultPaths,
  vaultPaths,
  writeAssignment,
} from "./store";

// The Správci of the Environment's own vault (root decision 0198 point 2,
// DEV-6631 tasks 638b and 774, decision F53's addendum of 2026-10-14 and its
// amendment of 2026-10-16 after root decision 0203): whoever has
// access to the Environment is an Admin of its vault and has all of its
// passwords. The Environment adds the person the gateway admitted (named by
// its own answer, never by a header of the request) at the address of their
// Lazurio username, once that person has an account in the network's vault
// and only where the network's vault refuses every password path of the
// person's address (`SSO_ONLY`), and a work Environment's Správci all leave
// the vault when the Environment is assigned to someone else. The vault's
// membership is the only list of who is in it; Lazurio keeps none, only the
// fingerprint of the assignment the Správci were added under. Everything
// happens under the account's lock, as the Environment account, the vault's
// only Owner: bw lists and confirms, the vault's API invites and removes (bw
// does neither). Nothing here returns, logs or journals a person's address,
// a member's id or a token.
//
// A personal Environment's own Bitwarden (root decision 0203 point 7) has
// one person, the one who connected it, at the address of their own
// Bitwarden account they entered: invited as a User with Manage on Agenti
// and confirmed once they accepted (invitee.ts), with no gate, since the
// cloud's own sign-in protects their account; the admitted person changes
// nothing there.

/** Where every person's account in a Lazurio Vaultwarden lives (root
 * decision 0203 point 5): `<Lazurio username>@account.lazurio.ai`, an
 * identifier and never a mailbox. */
export const accountAddressDomain = "account.lazurio.ai";

/** The admitted person's address in the vault, built from their Lazurio
 * username alone: never from GitHub, a header of the request or the
 * account's subject. */
export const personAddress = (username: string): string =>
  `${username}@${accountAddressDomain}`;

// The vault's organization roles (`type`) and membership statuses.
const ownerType = 0;
const adminType = 1;
const revoked = -1;
const invited = 0;
const accepted = 1;
const confirmed = 2;

/** Where the person at the browser stands in the Environment's vault. */
export type VaultMemberState =
  /** No account in the network's vault yet: the person signs in to it once
   * with the Lazurio account, then the Environment adds them. */
  | "no-account"
  /** An account that signed in but has no master password yet. */
  | "awaiting-password"
  /** A personal Environment's own Bitwarden: the cloud e-mailed its person
   * the invitation, not accepted yet. */
  | "invitation-pending"
  /** Accepted, but the Environment's confirmation did not go through now;
   * the next look confirms. */
  | "accepted"
  /** In the vault: a Správce, or a person a Správce shared collections
   * with. */
  | "member"
  /** Revoked in the vault by the network's operator: never restored here. */
  | "revoked";

/** Why nothing is known of the person. */
export type VaultMemberUnknown =
  /** The gateway named nobody (and a workstation names nobody). */
  | "no-identity"
  /** The gateway named a person, but its answer carried no Lazurio username
   * (Lazurio Auth issues none yet, or the session is older than the
   * account's username): the person has no address, so nobody is invited
   * or confirmed until a sign-in carries it. */
  | "no-username"
  /** No vault of the Environment's own here (none yet, a workstation, a
   * 0197 pilot). */
  | "no-vault"
  /** The own vault is not set up, or its account lost it. */
  | "not-connected"
  /** A Team or Automated Environment adds and removes nobody until a live
   * answer of who may enter it exists (DEV-6631 C4). */
  | "not-managed"
  /** The network's vault does not refuse a password for the person's
   * address yet (no `SSO_ONLY`): nobody is added or confirmed there
   * (`signInRequired`). */
  | "sign-in-not-required"
  /** Another operation holds the account's lock, or the vault's rate
   * limit: later. */
  | "busy"
  | "unreachable"
  | "failed";

export type VaultMembership =
  | Readonly<{ kind: "vault-member"; state: VaultMemberState }>
  | Readonly<{ kind: "vault-member-unknown"; reason: VaultMemberUnknown }>;

const known = (state: VaultMemberState): VaultMembership =>
  Object.freeze({ kind: "vault-member", state });
const unknown = (reason: VaultMemberUnknown): VaultMembership =>
  Object.freeze({ kind: "vault-member-unknown", reason });

/** Whether the Environment adds the person it admits: a personal or work
 * Environment. A Team Environment does not until removal works there too,
 * and an Automated one names no person whose access ends. */
const addsPeople = (context: VaultContext): boolean =>
  context.environment === "personal" || context.environment === "work";

/** Whether the Správci leave when the assignment changes: a work
 * Environment. A personal Environment never removes: its Owner is its only
 * person. */
const removesOnReassignment = (context: VaultContext): boolean =>
  context.environment === "work" && context.assignment !== null;

class MembershipFailure extends Error {
  constructor(readonly reason: VaultMemberUnknown) {
    super(reason);
  }
}

const ofBw = (reason: BwFailure): MembershipFailure =>
  new MembershipFailure(
    reason === "unauthenticated" || reason === "invalid-credentials"
      ? "not-connected"
      : reason === "unreachable" || reason === "timeout"
        ? "unreachable"
        : reason === "rate-limited"
          ? "busy"
          : "failed",
  );

const ofVault = (error: unknown): MembershipFailure =>
  error instanceof MembershipFailure
    ? error
    : new MembershipFailure(
        !(error instanceof VaultwardenError)
          ? "failed"
          : error.reason === "unreachable"
            ? "unreachable"
            : error.reason === "rate-limited"
              ? "busy"
              : error.reason === "invalid-credentials"
                ? "not-connected"
                : "failed",
      );

/** One turn under the account's lock: bw with the unlocked session for the
 * list and the confirmation, and, only when it is needed, one sign-in with
 * the account's API key for the vault's own API (its rate limit counts
 * sign-ins). */
type Turn = Readonly<{
  host: VaultHost;
  context: VaultContext;
  paths: VaultPaths;
  account: ReadyAccount;
  organizationId: string;
  /** The collection Agenti. */
  collectionId: string;
  members: () => Promise<readonly BwMember[]>;
  confirm: (memberId: string) => Promise<boolean>;
  api: (
    path: string,
    options: Parameters<typeof vaultRequest>[3],
  ) => Promise<unknown>;
}>;

/** The connected own vault of `context` under its lock, with a turn of
 * work, or why there is none. */
async function underLock<T>(
  host: VaultHost,
  context: VaultContext,
  work: (turn: Turn) => Promise<T>,
  failed: (reason: VaultMemberUnknown) => T,
): Promise<T> {
  const paths = vaultPaths(host.directory(context.host, context.account));
  const ready = await connectedAccount(paths, context);
  if (ready === null) return failed("not-connected");
  return withLock(
    paths,
    host.lockMs ?? lockMs,
    () => failed("busy"),
    async () => {
      const bw = cliOf(host, paths);
      const session = await usableSession(host, bw, paths, ready.account);
      if (!session.ok) return failed(ofBw(session.reason).reason);
      const { organizationId, collectionId } = ready.recorded;
      const api = accountApi(
        { fetch: host.fetch },
        {
          serverUrl: context.vault,
          clientId: ready.account.clientId,
          clientSecret: ready.account.clientSecret,
          device: deviceOf(ready.account),
        },
      );
      const turn: Turn = {
        host,
        context,
        paths,
        account: ready.account,
        organizationId,
        collectionId,
        async members() {
          const listed = await bw.orgMembers(session.session, organizationId);
          if (!listed.ok) throw ofBw(listed.reason);
          return listed.value;
        },
        async confirm(memberId) {
          const done = await bw.confirmMember(
            session.session,
            memberId,
            organizationId,
          );
          return done.ok;
        },
        api,
      };
      try {
        return await work(turn);
      } catch (error) {
        const failure = ofVault(error);
        host.journal?.({
          operation: "members",
          outcome: "failed",
          reason: failure.reason,
        });
        return failed(failure.reason);
      }
    },
  );
}

/** One member leaves the vault, by the vault's API as its Owner. */
async function remove(turn: Turn, member: BwMember): Promise<void> {
  await turn.api(
    `/api/organizations/${turn.organizationId}/users/${member.id}`,
    { method: "DELETE" },
  );
}

/**
 * The audience of a work Environment (DEV-6631 C4, "remove when the
 * audience changes"): when its assignment is not the one recorded, every
 * Admin-type member leaves the vault, then the assignment is recorded. A
 * missing or unreadable record counts as a change, so a lost file never
 * keeps anyone in. Only Admins leave: the Environment added them, and only
 * an Owner can add one. The Owner (the Environment's account) and the
 * Users, Managers and Custom members, people a Správce shared collections
 * with, are never touched. Those who still have access are added again
 * when they next come. Returns the members after it.
 */
async function settleAudience(
  turn: Turn,
  members: readonly BwMember[],
): Promise<readonly BwMember[]> {
  const { context } = turn;
  if (!removesOnReassignment(context) || context.assignment === null)
    return members;
  if ((await readAssignment(turn.paths)) === context.assignment) return members;
  const leaving = members.filter((member) => member.type === adminType);
  for (const member of leaving) {
    await remove(turn, member);
    turn.host.journal?.({ operation: "members", outcome: "removed" });
  }
  await writeAssignment(turn.paths, context.assignment);
  return members.filter((member) => member.type !== adminType);
}

const sameAddress = (member: BwMember, address: string) =>
  member.email.trim().toLowerCase() === address;

/**
 * The person at the browser, by their address, behind the gate
 * (`signInRequired`): invited as an Admin when they are not a member, and
 * confirmed once accepted. An invitation to an account without a master
 * password stays Invited (`awaiting-password`) until the person sets it,
 * when Vaultwarden accepts it by itself; the gate is what makes that
 * pending invitation safe. Only Admins the Environment added are ever
 * changed.
 */
async function settlePerson(
  turn: Turn,
  members: readonly BwMember[],
  username: string,
): Promise<VaultMembership> {
  const address = personAddress(username);
  const journal = (outcome: string) =>
    turn.host.journal?.({ operation: "members", outcome });
  let member = members.find((entry) => sameAddress(entry, address));
  if (member === undefined) {
    try {
      await turn.api(`/api/organizations/${turn.organizationId}/users/invite`, {
        // Exactly what Vaultwarden's `InviteData` reads: the Admin role sees
        // every collection, so none is named.
        json: {
          emails: [address],
          groups: [],
          type: adminType,
          collections: [],
          permissions: {},
        },
      });
      journal("invited");
    } catch (error) {
      if (error instanceof VaultwardenError && error.reason === "no-account") {
        journal("no-account");
        return known("no-account");
      }
      // Added meanwhile by another look: read below.
      if (
        !(error instanceof VaultwardenError) ||
        error.reason !== "already-member"
      )
        throw error;
    }
    member = (await turn.members()).find((entry) =>
      sameAddress(entry, address),
    );
    if (member === undefined) throw new MembershipFailure("failed");
  }
  if (member.type === ownerType) return known("member");
  if (member.status === revoked) return known("revoked");
  if (member.status === confirmed) return known("member");
  if (member.type !== adminType)
    return known(member.status === accepted ? "accepted" : "awaiting-password");
  if (member.status === invited) return known("awaiting-password");
  if (member.status === accepted) {
    if (await turn.confirm(member.id)) {
      journal("confirmed");
      return known("member");
    }
    journal("not-confirmed");
    return known("accepted");
  }
  throw new MembershipFailure("failed");
}

/**
 * The gate of every invitation and confirmation (DEV-6631 task 638b,
 * review of 2026-10-14): whether the network's vault refuses every password
 * path of this address, so that nobody can ever set a master password on
 * it but its person through the Lazurio sign-in. Vaultwarden 1.37.4 keeps
 * an invitation row with every invitation to an account without a master
 * password (SMTP off), and while a password can be registered for an
 * address its row lets anyone who knows the address do so; then the
 * account accepts and the Environment would confirm it into the vault.
 * SSO declared, `INVITATIONS_ALLOWED=false` and `SIGNUPS_ALLOWED=false` do
 * not close that; `SSO_ONLY` does (proven against 1.37.4-lazurio.1). The
 * vault's own token endpoint says so: a password grant naming only the
 * address is refused with "SSO sign-in is required" exactly when `SSO_ONLY`
 * covers the address, before any account is looked up and before its rate
 * limit or its sign-in events, and otherwise with a missing field.
 */
async function signInRequired(
  host: VaultHost,
  context: VaultContext,
  address: string,
): Promise<"required" | "not-required" | "unreachable"> {
  try {
    await vaultRequest(
      { fetch: host.fetch },
      context.vault,
      "/identity/connect/token",
      { form: { grant_type: "password", username: address } },
    );
  } catch (error) {
    if (error instanceof VaultwardenError) {
      if (error.reason === "sso-required") return "required";
      if (error.reason === "unreachable" || error.reason === "rate-limited")
        return "unreachable";
    }
  }
  return "not-required";
}

/**
 * The membership of the person the gateway admitted (`person`, whom its
 * answer named: the account's subject and its Lazurio username, each null
 * when the answer did not carry it), and the audience of a work Environment
 * first. A personal or work Environment adds the person, at the address of
 * their username and only behind the gate (`signInRequired`); a Team or
 * Automated Environment touches nobody. A person named without a username
 * has no address: nobody is invited or confirmed (`no-username`). Leaving
 * needs no gate: the audience is settled either way. Status-driven and
 * idempotent: every look reads the vault's members and moves them on.
 */
export async function vaultMembership(
  host: VaultHost,
  person: AdmittedPerson,
): Promise<VaultMembership> {
  const context = await host.context();
  if (context.kind === "needs-connection") return unknown("not-connected");
  if (context.kind !== "own") return unknown("no-vault");
  if (context.bitwarden !== undefined)
    return inviteeMembership(host, context, context.bitwarden.invitee);
  if (!addsPeople(context)) return unknown("not-managed");
  // Nothing is asked of a vault that is not set up here.
  const paths = vaultPaths(host.directory(context.host, context.account));
  if ((await connectedAccount(paths, context)) === null)
    return unknown("not-connected");
  // The person's address, only from the username the gateway's answer
  // carried for a person it named (root decision 0203 point 5).
  const named = isAccountSubject(person.subject);
  const username =
    named && isLazurioUsername(person.username) ? person.username : null;
  // Nobody named, a person without a username, or a vault where a password
  // could still be set on the person's address: nobody is added or
  // confirmed, and the audience, which needs nobody, is settled (it asks the
  // vault only when the assignment changed).
  const gate =
    username === null
      ? null
      : await signInRequired(host, context, personAddress(username));
  if (username === null || gate !== "required") {
    const audience = await vaultAudience(host);
    if (audience !== "unchanged" && audience !== "settled")
      return unknown(audience);
    return unknown(
      username === null
        ? named
          ? "no-username"
          : "no-identity"
        : gate === "unreachable"
          ? "unreachable"
          : "sign-in-not-required",
    );
  }
  return underLock(
    host,
    context,
    async (turn) =>
      settlePerson(
        turn,
        await settleAudience(turn, await turn.members()),
        username,
      ),
    unknown,
  );
}

/**
 * A personal Environment's own Bitwarden (root decision 0203 point 7): the
 * person who connected it, at the address of their own Bitwarden account,
 * invited as a User with Manage on Agenti and confirmed once they accepted
 * the cloud's e-mail (invitee.ts). Whoever the gateway admitted changes
 * nothing, and there is no gate: the cloud's sign-in protects the person's
 * own account, and the Environment confirms only the address it invited.
 */
async function inviteeMembership(
  host: VaultHost,
  context: VaultContext,
  invitee: string,
): Promise<VaultMembership> {
  return underLock(
    host,
    context,
    async (turn) =>
      known(
        await settleInvitee({
          invitee,
          members: turn.members,
          async invite() {
            await turn.api(
              `/api/organizations/${turn.organizationId}/users/invite`,
              { json: inviteeInvitation(invitee, turn.collectionId) },
            );
          },
          confirm: turn.confirm,
          journal: (outcome) =>
            turn.host.journal?.({ operation: "members", outcome }),
        }),
      ),
    unknown,
  );
}

/** What a look at the audience did. */
export type VaultAudience = "unchanged" | "settled" | VaultMemberUnknown;

/**
 * The audience alone, for the Launchpad's start and its periodic look
 * (DEV-6631 task 638b): nothing is asked of the vault unless a work
 * Environment's assignment is not the one recorded; then its Správci leave
 * as `vaultMembership` would make them, without waiting for anyone to open
 * the vault page.
 */
export async function vaultAudience(host: VaultHost): Promise<VaultAudience> {
  const context = await host.context();
  if (context.kind !== "own" || !removesOnReassignment(context))
    return "unchanged";
  const paths = vaultPaths(host.directory(context.host, context.account));
  if ((await readAssignment(paths)) === context.assignment) return "unchanged";
  return underLock(
    host,
    context,
    async (turn): Promise<VaultAudience> => {
      await settleAudience(turn, await turn.members());
      return "settled";
    },
    (reason): VaultAudience => reason,
  );
}

/**
 * Whether the network's vault takes a sign-in with the Lazurio account, so
 * a person without an account there can create one: Vaultwarden's public
 * `GET /identity/sso/prevalidate` answers with a token only while its SSO is
 * on. The token is dropped unread. A vault that does not answer does not.
 */
export async function vaultSignIn(host: VaultHost): Promise<boolean> {
  const context = await host.context();
  // A personal Environment's own Bitwarden takes no Lazurio sign-in.
  if (
    context.kind === "unsupported" ||
    context.kind === "needs-connection" ||
    (context.kind === "own" && context.bitwarden !== undefined)
  )
    return false;
  try {
    const answer = plainObject(
      await vaultRequest(
        { fetch: host.fetch },
        context.vault,
        "/identity/sso/prevalidate",
      ),
    );
    return typeof answer?.token === "string" && answer.token !== "";
  } catch {
    return false;
  }
}
