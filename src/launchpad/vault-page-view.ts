import type { VaultEnvironmentKind } from "../vault/context";
import type { BitwardenRegion } from "../vault/endpoints";
import type { VaultPhase, VaultStatus } from "../vault/flow";
import type { VaultMemberState, VaultMemberUnknown } from "../vault/members";
import { pluralKey } from "./apps-view";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";
import { parseVaultStatus } from "./vault-view";

// Settings → Vault, Nastavení → Trezor (root decision 0198 point 5, the
// wireframe's EnvVault of prototypes-lazurio#33): the page's pure part. What
// the server's answers say, in the page's words, and where each action
// leads. The vault itself is Lazurio Vaultwarden's web vault on its own
// address; the Launchpad never lists items or shows a value. Every server
// value is accepted only in its exact form, and everything returned is text
// for `textContent` or an https link into the network's vault.

type Copy = Readonly<Record<MessageKey, string>>;

const kinds: readonly VaultEnvironmentKind[] = [
  "personal",
  "work",
  "team",
  "automated",
];
const phases: readonly VaultPhase[] = [
  "install",
  "account",
  "vault",
  "sign-in",
];
const memberStates: readonly VaultMemberState[] = [
  "no-account",
  "awaiting-password",
  "invitation-pending",
  "accepted",
  "member",
  "revoked",
];
const unknownReasons: readonly VaultMemberUnknown[] = [
  "no-identity",
  "no-username",
  "no-vault",
  "not-connected",
  "not-managed",
  "sign-in-not-required",
  "busy",
  "unreachable",
  "failed",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `GET /api/vault`, in its exact form. */
export type VaultPageModel = Readonly<{
  status: VaultStatus;
  setup: VaultPhase | null;
  environment: VaultEnvironmentKind | null;
}>;

export function parseVaultPage(input: unknown): VaultPageModel | null {
  if (!isRecord(input) || input.kind !== "vault-page") return null;
  const status = parseVaultStatus(input.status);
  if (status === null) return null;
  if (input.setup !== null && !phases.includes(input.setup as VaultPhase))
    return null;
  if (
    input.environment !== null &&
    !kinds.includes(input.environment as VaultEnvironmentKind)
  )
    return null;
  return {
    status,
    setup: input.setup as VaultPhase | null,
    environment: input.environment as VaultEnvironmentKind | null,
  };
}

/** Where the person at the browser stands, as `POST /api/vault/membership`
 * answers. */
export type VaultPagePerson =
  | Readonly<{ kind: "known"; state: VaultMemberState; signIn: boolean }>
  | Readonly<{ kind: "unknown"; reason: VaultMemberUnknown }>;

export function parseVaultMembership(input: unknown): VaultPagePerson | null {
  if (!isRecord(input)) return null;
  if (input.kind === "vault-member-unknown")
    return unknownReasons.includes(input.reason as VaultMemberUnknown)
      ? { kind: "unknown", reason: input.reason as VaultMemberUnknown }
      : null;
  if (
    input.kind !== "vault-member" ||
    !memberStates.includes(input.state as VaultMemberState) ||
    (input.signIn !== undefined && typeof input.signIn !== "boolean")
  )
    return null;
  return {
    kind: "known",
    state: input.state as VaultMemberState,
    signIn: input.signIn === true,
  };
}

const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** The network vault's own origin: https and a host, nothing else. */
function origin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Where each action leads, in the web vault's own addresses (the DEV-6631
 * study, REPORT.md §0 point 8 and §11c):
 *
 * - `add`: the vault filtered to its collection Agenti, where the web
 *   vault's New preselects the vault and the collection (phase 1; our web
 *   vault build opens New itself in phase 2);
 * - `open`: the vault (a 0197 pilot: its collection in the person's
 *   organization);
 * - `account`: the sign-in, where the first sign-in with the Lazurio account
 *   creates the person's account. */
export type VaultPageLinks = Readonly<{
  add: string | null;
  open: string | null;
  account: string | null;
}>;

export function vaultPageLinks(status: VaultStatus | null): VaultPageLinks {
  const none = { add: null, open: null, account: null };
  if (
    status === null ||
    status.state === "unsupported" ||
    status.state === "needs-connection"
  )
    return none;
  const base = origin(status.vault);
  if (base === null) return none;
  const account = `${base}/#/login`;
  if (
    status.state !== "connected" ||
    !id(status.organizationId) ||
    !id(status.collectionId)
  )
    return { ...none, account };
  const vault = `${base}/#/vault?organizationId=${status.organizationId}`;
  const collection = `${vault}&collectionId=${status.collectionId}`;
  return status.origin === "pilot-0197"
    ? { add: null, open: collection, account }
    : { add: collection, open: vault, account };
}

export type VaultPageAction = Readonly<{
  control: "add" | "open" | "account";
  label: string;
  href: string;
  /** The ink button of the row: the way in. */
  primary: boolean;
}>;

/** The vault's state in a few words, and its colour: `ok` (success),
 * `busy` and `quiet` (muted), `warn`. */
type RowState = Readonly<{
  line: string;
  tone: "ok" | "busy" | "warn" | "quiet";
}>;

/** What the page shows. */
export type VaultPageView = Readonly<{
  /** The rule above the vault. */
  rule: boolean;
  /** One short line instead of the vault (this computer, no vault yet). */
  note: string | null;
  /** The vault's row: its name and its state. */
  row: (RowState & Readonly<{ title: string }>) | null;
  actions: readonly VaultPageAction[];
  /** One line under the row (a Team or Automated Environment, a sign-in
   * without the person's Lazurio username). */
  hint: string | null;
  /** How the vault is used from here (DEV-6631 task 947): tell the agent
   * in Chat what it needs, and it asks for the value on this page. Shown
   * only with a ready own vault (connected, unlocked, no setup running),
   * never for a 0197 pilot, which takes no requests. */
  guide: boolean;
  /** The form that connects a personal Environment's own Bitwarden, while
   * its person has not connected it (root decision 0203 point 7). */
  connect: boolean;
  /** "Odpojit Bitwarden": a personal Environment's own Bitwarden, once
   * connected (or its record unreadable), while no setup runs. */
  disconnect: boolean;
}>;

/** The vault's state in a few words: the items, the creation, no answer. */
function rowLine(
  status: VaultStatus,
  setup: VaultPhase | null,
  copy: Copy,
): RowState {
  if (setup !== null) return { line: copy.vaultPageCreating, tone: "busy" };
  switch (status.state) {
    case "connected":
      return status.items === null
        ? { line: copy.vaultRowConnected, tone: "ok" }
        : {
            line: fill(
              copy[
                pluralKey(status.items, {
                  one: "vaultPageItemsOne",
                  few: "vaultPageItemsFew",
                  many: "vaultPageItemsMany",
                })
              ],
              { count: String(status.items) },
            ),
            tone: "ok",
          };
    // A creation asked for and not confirmed yet: the next setup (at the
    // Launchpad's start, or the Tools row's "Zkusit znovu") finds it.
    case "creating":
      return { line: copy.vaultPageCreating, tone: "busy" };
    case "unreachable":
      return { line: copy.vaultPageUnreachable, tone: "warn" };
    case "not-set-up":
      return { line: copy.vaultRowNotSetUp, tone: "quiet" };
    case "not-allowed":
      return { line: copy.vaultRowNotAllowed, tone: "warn" };
    case "revoked":
      return {
        line:
          status.origin === "own" ? copy.vaultRowRemoved : copy.vaultRowRevoked,
        tone: "warn",
      };
    case "failed":
      return { line: copy.vaultRowFailed, tone: "warn" };
    // Every state has its words: a new one fails to compile here.
    case "needs-connection":
      return { line: copy.vaultRowNeedsConnection, tone: "quiet" };
    case "unsupported":
      return { line: copy.vaultRowUnavailable, tone: "quiet" };
  }
}

/**
 * The page from its model (`null` while it is read), the person's
 * membership (`null` while it is asked) and the vault's own answer
 * (`fresh`, the Tools row's refresh; `null` until it came), which is newer
 * than the state recorded here; while the vault does not answer, its links
 * still come from the recorded state:
 *
 * - this computer, or an Environment without a vault: one short line;
 * - otherwise the rule and the vault's row: its name and the item count,
 *   "Zakládání trezoru…" while a setup runs, "Neodpovídá" when the vault
 *   does not answer;
 * - the actions follow the person: with an account in the network's vault
 *   "Přidat položku" and "Otevřít trezor"; without one (or without a master
 *   password yet) only "Vytvořit účet v trezoru", and only where the vault
 *   takes the Lazurio sign-in; not known, "Otevřít trezor", and when the
 *   sign-in did not carry the person's Lazurio username, a line that says
 *   so and asks them to sign in again. A 0197 pilot has "Otevřít trezor" to
 *   its collection. A Team or Automated Environment, or a network whose
 *   vault does not require the Lazurio sign-in of people yet, adds nobody: a
 *   line says so, and the row has no action.
 */
export function vaultPageView(
  model: VaultPageModel | null,
  person: VaultPagePerson | null,
  copy: Copy,
  fresh: VaultStatus | null = null,
): VaultPageView {
  const view = (fields: Partial<VaultPageView>): VaultPageView => ({
    rule: true,
    note: null,
    row: null,
    actions: [],
    hint: null,
    guide: false,
    connect: false,
    disconnect: false,
    ...fields,
  });
  if (model === null) return view({});
  const { setup } = model;
  const status = fresh ?? model.status;
  // A personal Environment whose record of its own Bitwarden does not read:
  // one line, and the way out (root decision 0203 point 7).
  if (
    status.state === "unsupported" &&
    status.reason === "connection-unreadable"
  )
    return view({
      rule: false,
      note: copy.vaultPageConnectionUnreadable,
      disconnect: setup === null,
    });
  if (status.state === "unsupported")
    return view({
      rule: false,
      note:
        status.reason === "workstation"
          ? copy.vaultPageWorkstation
          : status.reason === "no-vault"
            ? copy.vaultPageNoVault
            : copy.vaultRowUnavailable,
    });
  // A personal Environment whose person has not connected their own
  // Bitwarden yet: the form, with its own explanation.
  if (status.state === "needs-connection")
    return view({ rule: false, connect: true });
  // The vault's name; a 0197 pilot has none: the organization bw names.
  const named =
    status.name ??
    (status.state === "connected" ? status.organization : null) ??
    copy.vaultPageTitle;
  const row = { title: named, ...rowLine(status, setup, copy) };
  // How the vault is used, shown only with a ready own vault: connected,
  // its session unlocked and no setup running. A 0197 pilot takes no
  // requests, and a vault still being set up or locked cannot save one yet.
  const guide =
    status.state === "connected" &&
    status.origin !== "pilot-0197" &&
    status.locked !== true &&
    setup === null;
  if (model.environment === "team" || model.environment === "automated")
    return view({ guide, row, hint: copy.vaultPageAgentsOnly });
  const links = vaultPageLinks(
    status.state === "unreachable" ? model.status : status,
  );
  if (status.region !== undefined)
    return personalBitwardenView(status, setup, person, links, copy, {
      guide,
      row,
      view,
    });
  if (setup !== null || links.open === null) return view({ guide, row });
  const open: VaultPageAction = {
    control: "open",
    label: copy.vaultPageOpen,
    href: links.open,
    primary: true,
  };
  if (status.origin === "pilot-0197")
    return view({ guide, row, actions: [open] });
  if (person === null) return view({ guide, row });
  // Nobody is added here yet (a Team or Automated Environment, or a network
  // whose vault does not require the Lazurio sign-in of people yet): only
  // the agents use the vault. A person whose sign-in carried no Lazurio
  // username has no address in it yet: the vault opens, and a line says
  // why they are not added.
  if (person.kind === "unknown") {
    const agentsOnly =
      person.reason === "not-managed" ||
      person.reason === "sign-in-not-required";
    return view({
      guide,
      row,
      actions: agentsOnly ? [] : [open],
      hint: agentsOnly
        ? copy.vaultPageAgentsOnly
        : person.reason === "no-username"
          ? copy.vaultPageNoUsername
          : null,
    });
  }
  if (person.state === "no-account" || person.state === "awaiting-password")
    return view({
      guide,
      row,
      actions:
        person.signIn && links.account !== null
          ? [
              {
                control: "account",
                label: copy.vaultPageCreateAccount,
                href: links.account,
                primary: true,
              },
            ]
          : [],
    });
  if (person.state === "revoked") return view({ guide, row, actions: [open] });
  return view({
    guide,
    row,
    actions:
      links.add === null
        ? [open]
        : [
            {
              control: "add",
              label: copy.vaultPageAddItem,
              href: links.add,
              primary: false,
            },
            open,
          ],
  });
}

/**
 * A personal Environment's own Bitwarden (root decision 0203 point 7): the
 * row and "Odpojit Bitwarden", and what the person does next. A member adds
 * and opens; an invitation not accepted yet, or accepted and not confirmed
 * yet, says so in one line; a person removed in Bitwarden is told so. A
 * vault Bitwarden no longer accepts, and a failure the person resolves (the
 * agents' account owns another Free organization, its file is gone), says
 * what to do. Nobody else is added here: the person is whom they named when
 * connecting.
 */
function personalBitwardenView(
  status: VaultStatus,
  setup: VaultPhase | null,
  person: VaultPagePerson | null,
  links: VaultPageLinks,
  copy: Copy,
  shown: Readonly<{
    guide: boolean;
    row: NonNullable<VaultPageView["row"]>;
    view: (fields: Partial<VaultPageView>) => VaultPageView;
  }>,
): VaultPageView {
  const { guide, row, view } = shown;
  const disconnect = setup === null;
  // What the person does about a vault that stopped: disconnect and connect
  // again (a fresh agents' account where the old one owns another Free
  // organization).
  const problem =
    status.state === "revoked"
      ? copy.vaultPageRevokedPersonal
      : status.state === "failed"
        ? status.reason === "free-organization-limit"
          ? copy.vaultPageFreeLimit
          : status.reason === "account-missing"
            ? copy.vaultPageAccountMissing
            : null
        : null;
  if (setup !== null || problem !== null || links.open === null)
    return view({ guide, row, hint: problem, disconnect });
  const open: VaultPageAction = {
    control: "open",
    label: copy.vaultPageOpen,
    href: links.open,
    primary: true,
  };
  if (person === null || person.kind === "unknown")
    return view({ guide, row, actions: [open], disconnect });
  switch (person.state) {
    case "invitation-pending":
      return view({
        guide,
        row,
        hint: copy.vaultPageInvitationPending,
        disconnect,
      });
    case "accepted":
      return view({
        guide,
        row,
        hint: copy.vaultPageInvitationAccepted,
        disconnect,
      });
    case "revoked":
      return view({
        guide,
        row,
        hint: copy.vaultPageMemberRevoked,
        disconnect,
      });
    case "member":
      return view({
        guide,
        row,
        actions:
          links.add === null
            ? [open]
            : [
                {
                  control: "add",
                  label: copy.vaultPageAddItem,
                  href: links.add,
                  primary: false,
                },
                open,
              ],
        disconnect,
      });
    // A Lazurio Vaultwarden's states: never a personal Bitwarden's.
    case "no-account":
    case "awaiting-password":
      return view({ guide, row, actions: [open], disconnect });
  }
}

/** Where this Environment's vault is for the Bitwarden extension in Codex
 * Desktop and the person's own browser (F53's addendum of 2026-10-16): an
 * Organization's Lazurio Vaultwarden at its own address, added as a
 * self-hosted server (root decision 0203 point 1), or a personal
 * Environment's own Bitwarden in its region's service (point 7). */
export type BitwardenTarget =
  | Readonly<{ kind: "server"; server: string }>
  | Readonly<{ kind: "cloud"; service: string }>;

/** The services Bitwarden's extension offers under „Přistupujete na“
 * ("Accessing"), by the region of a personal Environment's own Bitwarden. */
const bitwardenServices: Readonly<Record<BitwardenRegion, string>> = {
  eu: "bitwarden.eu",
  us: "bitwarden.com",
};

/**
 * Where the person adds this Environment's vault to Bitwarden: a personal or
 * work Environment whose vault is its Organization's Lazurio Vaultwarden, in
 * any state, since the person's account there does not depend on this
 * Environment's own vault, or its person's own Bitwarden once connected. Null
 * on this computer, without a vault, while a personal Environment waits for
 * its person's Bitwarden, on a Team or Automated Environment, and where the
 * person's membership answer says that only the agents use the vault (a
 * network that does not require the Lazurio sign-in of people yet). The
 * person is null while not known.
 */
export function bitwardenTarget(
  model: VaultPageModel | null,
  person: VaultPagePerson | null = null,
): BitwardenTarget | null {
  if (
    model === null ||
    (model.environment !== "personal" && model.environment !== "work") ||
    (person?.kind === "unknown" &&
      (person.reason === "not-managed" ||
        person.reason === "sign-in-not-required"))
  )
    return null;
  const { status } = model;
  if (status.state === "unsupported" || status.state === "needs-connection")
    return null;
  if (status.region !== undefined)
    return { kind: "cloud", service: bitwardenServices[status.region] };
  const server = origin(status.vault);
  return server === null ? null : { kind: "server", server };
}

/**
 * Whether Začínáme shows "Trezor v Bitwardenu": exactly where Nastavení →
 * Trezor gives the steps. A Lazurio Vaultwarden's steps depend on the
 * person's membership answer, so its row waits for that answer; a personal
 * Environment's own Bitwarden needs none.
 */
export function offersBitwarden(
  model: VaultPageModel | null,
  person: VaultPagePerson | null,
): boolean {
  const target = bitwardenTarget(model, person);
  return target !== null && (target.kind === "cloud" || person !== null);
}

/**
 * What a pending "Návod" of Začínáme does now (the steps brought into view
 * and focus on Nastavení → Trezor): reveal them, wait for the answer that
 * decides whether they show, or forget it. Forgotten once the page is left or
 * the steps will not show; a Lazurio Vaultwarden's wait for the person's
 * membership answer, so a heading never gets the focus just before an
 * answer hides it.
 */
export function bitwardenReveal(
  input: Readonly<{
    /** Whether Nastavení → Trezor is the page shown now. */
    shown: boolean;
    /** Whether the page's model is being read. */
    loading: boolean;
    model: VaultPageModel | null;
    person: VaultPagePerson | null;
    /** Whether the steps are drawn now. */
    steps: boolean;
  }>,
): "reveal" | "wait" | "forget" {
  if (!input.shown) return "forget";
  if (input.model === null) return input.loading ? "wait" : "forget";
  const target = bitwardenTarget(input.model);
  if (target === null) return "forget";
  if (target.kind === "server" && input.person === null) return "wait";
  return input.steps ? "reveal" : "forget";
}

/** One step of the guide, and the value it asks for with its Copy button
 * where the page has it. */
export type BitwardenStep = Readonly<{ text: string; value: string | null }>;

/** "V Codex Desktopu a ve vašem prohlížeči" on Nastavení → Trezor. */
export type BitwardenGuide = Readonly<{
  kind: BitwardenTarget["kind"];
  /** Before the steps: create the account first, while the page offers
   * "Vytvořit účet v trezoru". */
  first: string | null;
  steps: readonly BitwardenStep[];
  /** After the steps: a Lazurio Vaultwarden answers only on its network. */
  note: string | null;
}>;

/**
 * The steps that add this Environment's vault to the Bitwarden extension in
 * Codex Desktop (Nastavení → Prohlížeč → Rozšíření) and in the person's own
 * browser (F53's addendum of 2026-10-16). An Organization's Lazurio
 * Vaultwarden: its address as the self-hosted server, to copy; the person's
 * Lazurio address, `<username>@account.lazurio.ai`, with single sign-on
 * through Lazurio and their master password, since the vault takes people's
 * accounts only through the Lazurio sign-in (root decisions 0197 point 2 and
 * 0203 point 5); a line first while the page (`view`) offers "Vytvořit účet v
 * trezoru", and the network under the steps. The page has no person's
 * username to copy: the gateway names it only for the membership. A personal
 * Environment's own Bitwarden: its region's service and the person's own
 * account. None where `bitwardenTarget` has none for the person.
 */
export function bitwardenGuide(
  model: VaultPageModel | null,
  person: VaultPagePerson | null,
  copy: Copy,
  view: Pick<VaultPageView, "actions"> | null = null,
): BitwardenGuide | null {
  const target = bitwardenTarget(model, person);
  if (target === null) return null;
  const add = { text: copy.vaultBitwardenAdd, value: null };
  if (target.kind === "cloud")
    return {
      kind: "cloud",
      first: null,
      steps: [
        add,
        {
          text: fill(copy.vaultBitwardenCloud, { service: target.service }),
          value: null,
        },
      ],
      note: null,
    };
  return {
    kind: "server",
    first:
      view?.actions.some((action) => action.control === "account") === true
        ? copy.vaultBitwardenAccount
        : null,
    steps: [
      add,
      { text: copy.vaultBitwardenServer, value: target.server },
      { text: copy.vaultBitwardenAddress, value: null },
      { text: copy.vaultBitwardenSignIn, value: null },
    ],
    note: copy.vaultBitwardenNetwork,
  };
}

/** Why a connection was refused, in the page's words; null for none. */
export function connectionRefusalText(
  reason: unknown,
  copy: Copy,
): string | null {
  switch (reason) {
    case "region-invalid":
      return copy.vaultConnectRegionInvalid;
    case "client-id-invalid":
      return copy.vaultConnectClientIdInvalid;
    case "client-secret-invalid":
      return copy.vaultConnectClientSecretInvalid;
    case "password-invalid":
      return copy.vaultConnectPasswordInvalid;
    case "email-invalid":
      return copy.vaultConnectEmailInvalid;
    case "invalid-credentials":
      return copy.vaultConnectInvalidCredentials;
    case "wrong-password":
      return copy.vaultConnectWrongPassword;
    case "same-account":
      return copy.vaultConnectSameAccount;
    case "owns-organization":
      return copy.vaultConnectOwnsOrganization;
    case "unsupported-kdf":
    case "unsupported-keys":
      return copy.vaultConnectUnsupported;
    case "rate-limited":
    case "unreachable":
    case "busy":
    case "setting-up":
      return copy.vaultConnectBusy;
    case "connected":
      return copy.vaultConnectConnected;
    case "not-offered":
    case "pilot-0197":
    case "not-connected":
      return copy.vaultConnectNotOffered;
    case "failed":
      return copy.vaultConnectFailed;
    default:
      return null;
  }
}

/** The form's values as the person typed them: every field filled in. */
export const connectionFilled = (
  values: Readonly<Record<string, string>>,
): boolean =>
  ["region", "clientId", "clientSecret", "masterPassword", "email"].every(
    (field) => (values[field] ?? "").trim() !== "",
  );

/** How soon the page is read again while a setup creates the vault. */
export const vaultPageSetupPollMs = 2_000;
