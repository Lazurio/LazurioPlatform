import type { VaultEnvironmentKind } from "../vault/context";
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
  "accepted",
  "member",
  "revoked",
];
const unknownReasons: readonly VaultMemberUnknown[] = [
  "no-identity",
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
  if (status === null || status.state === "unsupported") return none;
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
  /** One line under the row (a Team or Automated Environment). */
  hint: string | null;
  /** How the vault is used from here (DEV-6631 task 947): tell the agent
   * in Chat what it needs, and it asks for the value on this page. Shown
   * with a connected own vault, never for a 0197 pilot, which takes no
   * requests. */
  guide: boolean;
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
 *   takes the Lazurio sign-in; not known, "Otevřít trezor". A 0197 pilot
 *   has "Otevřít trezor" to its collection. A Team or Automated Environment,
 *   or a network whose vault does not require the Lazurio sign-in of people
 *   yet, adds nobody: a line says so, and the row has no action.
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
    ...fields,
  });
  if (model === null) return view({});
  const { setup } = model;
  const status = fresh ?? model.status;
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
  // The vault's name; a 0197 pilot has none: the organization bw names.
  const named =
    status.name ??
    (status.state === "connected" ? status.organization : null) ??
    copy.vaultPageTitle;
  const row = { title: named, ...rowLine(status, setup, copy) };
  // How the vault is used, shown with a connected own vault: a 0197 pilot
  // takes no requests, and a vault that is not ready cannot save one.
  const guide = status.state === "connected" && status.origin !== "pilot-0197";
  if (model.environment === "team" || model.environment === "automated")
    return view({ guide, row, hint: copy.vaultPageAgentsOnly });
  const links = vaultPageLinks(
    status.state === "unreachable" ? model.status : status,
  );
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
  // the agents use the vault.
  if (person.kind === "unknown") {
    const agentsOnly =
      person.reason === "not-managed" ||
      person.reason === "sign-in-not-required";
    return view({
      guide,
      row,
      actions: agentsOnly ? [] : [open],
      hint: agentsOnly ? copy.vaultPageAgentsOnly : null,
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

/** How soon the page is read again while a setup creates the vault. */
export const vaultPageSetupPollMs = 2_000;
