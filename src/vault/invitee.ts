import type { BwMember } from "./bw";
import { VaultwardenError } from "./register";

// The person of a personal Environment's own Bitwarden (root decision 0203
// point 7, DEV-6631 task 775): the vault is a Free organization for two, the
// agents' account (its Owner) and the person, at the address of the
// person's own Bitwarden account they entered. The Environment invites that
// address as a User with Manage on the collection Agenti, never as an Admin:
// the Bitwarden cloud lets an account be Owner or Admin of only one Free
// organization, checked when an invitation is accepted, confirmed or its
// role changed, so a person who already owns a Free organization could
// never join as an Admin. The cloud e-mails the invitation; once the person
// accepts it, the Environment confirms them with bw, which hands them the
// organization's key (no fingerprint is compared: the person chose this
// service and trusts it as every Bitwarden client does). Status-driven:
// every look reads the members and moves the person on. Nothing here
// returns, logs or journals an address or a member's id.

/** Where the person stands in their personal Environment's own Bitwarden. */
export type InviteeState =
  /** Invited by the cloud's e-mail, not accepted yet. */
  | "invitation-pending"
  /** Accepted, but the confirmation did not go through now; the next look
   * confirms. */
  | "accepted"
  /** Confirmed: the person holds the vault's key. */
  | "member"
  /** Revoked in the organization, by a person in the web vault: never
   * restored here. */
  | "revoked";

/** The vault's organization roles (`type`) and membership statuses. */
const userType = 2;
const revoked = -1;
const invited = 0;
const accepted = 1;
const confirmed = 2;

/** The invitation as the Bitwarden cloud's API reads it
 * (`OrganizationUserInviteRequestModel`): one address, the User role, Manage
 * on Agenti, no Secrets Manager, no group, no custom permission. */
export const inviteeInvitation = (
  invitee: string,
  collectionId: string,
): Readonly<Record<string, unknown>> =>
  Object.freeze({
    emails: [invitee],
    type: userType,
    accessSecretsManager: false,
    collections: [
      { id: collectionId, readOnly: false, hidePasswords: false, manage: true },
    ],
    groups: [],
    permissions: {},
  });

export class InviteeFailure extends Error {
  constructor() {
    super("The person is not listed in the vault");
    this.name = "InviteeFailure";
  }
}

/** One look: the person invited when they are not a member yet, confirmed
 * once they accepted. `members` lists the organization's members (bw),
 * `invite` sends the invitation (the vault's API), `confirm` confirms one
 * accepted member (bw). A failure of any of them throws, and so does a
 * person the vault does not list after their invitation (`InviteeFailure`). A
 * member's role is never changed here. */
export async function settleInvitee(
  input: Readonly<{
    invitee: string;
    members: () => Promise<readonly BwMember[]>;
    invite: () => Promise<void>;
    confirm: (memberId: string) => Promise<boolean>;
    journal: (outcome: "invited" | "confirmed" | "not-confirmed") => void;
  }>,
): Promise<InviteeState> {
  const same = (member: BwMember) =>
    member.email.trim().toLowerCase() === input.invitee;
  let member = (await input.members()).find(same);
  if (member === undefined) {
    try {
      await input.invite();
      input.journal("invited");
    } catch (error) {
      // Invited meanwhile by another look: read below.
      if (
        !(error instanceof VaultwardenError) ||
        error.reason !== "already-member"
      )
        throw error;
    }
    member = (await input.members()).find(same);
    if (member === undefined) throw new InviteeFailure();
  }
  if (member.status === revoked) return "revoked";
  if (member.status === confirmed) return "member";
  if (member.status === invited) return "invitation-pending";
  if (member.status === accepted) {
    if (await input.confirm(member.id)) {
      input.journal("confirmed");
      return "member";
    }
    input.journal("not-confirmed");
    return "accepted";
  }
  throw new InviteeFailure();
}
