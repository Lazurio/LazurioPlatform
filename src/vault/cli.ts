import { parseArgs } from "node:util";
import { readStartState } from "../launchpad/start-check";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import type { VaultUnsupportedReason } from "./context";
import {
  type VaultEnvRefusal,
  type VaultEnvResult,
  type VaultHost,
  type VaultPhase,
  type VaultStatus,
  vaultEnv,
  vaultRefresh,
  vaultSetup,
  vaultStatus,
} from "./flow";
import { processVaultHost } from "./host";
import { secretRequestPath } from "./request-id";
import {
  createSecretRequest,
  listSecretRequests,
  type SecretRequest,
  type SecretRequestRefusal,
  secretRequestLimits,
  secretRequestOf,
} from "./requests";

/** `lazurio vault`: the Environment's own vault for agents (decisions F43,
 * F53). The same core as the Launchpad's Settings → Tools → bitwarden and its
 * start. */
export const vaultHelp = `vault env [--json]
  This Environment's vault for this shell: prints shell exports of
  BITWARDENCLI_APPDATA_DIR, BW_SESSION, LAZURIO_VAULT_ORGANIZATION_ID (the
  Environment's own vault) and LAZURIO_VAULT_COLLECTION_ID (its collection
  Agenti). Run it as eval "$(lazurio vault env)", then plain bw. The
  Environment keeps one unlocked session for all its agents; when that
  session is no longer the unlocked one, this command unlocks it again (each
  unlock ends the earlier session, so run it again when bw says the vault is
  locked). Never run bw login, unlock, lock, logout or config. Not set up:
  one line on stderr, nothing on stdout. --json prints {kind: "vault-env",
  env} with the same four values. The session is printed by design, for the
  agent's shell only: never paste it into chat, Git, a log or a pull
  request.
vault status [--json]
  This Environment's vault as the Launchpad shows it, from bw's local copy
  (no network): connected (its organization and how many items it holds),
  not set up yet (and the next step), needs-connection (a personal
  Environment whose person has not connected their own Bitwarden yet: only
  they do it, in the Launchpad's Settings → Vault; never ask for or enter
  that account's credentials), or why this Environment has no vault here.
  The one source of truth: read it before saying anything about the vault.
vault refresh [--json]
  Syncs with the vault, unlocks the session again when needed, then the
  status: also revoked (the vault is gone or its account refused) or
  unreachable.
vault setup [--json]
  What the Launchpad does at its start: installs the pinned Bitwarden CLI,
  registers this Environment's account (the address its Machine handover
  names, which the network pre-allowed) with a password generated here,
  creates the Environment's own vault, an organization named as the handover
  says with the first collection Agenti (or finds it by its ID and renames it
  when the name changed), signs bw in with the account's API key, unlocks the
  one session and syncs. On a personal Environment whose person connected
  their own Bitwarden it does the same with the agents' account they
  entered (never registered here), and invites them into the vault once
  they asked for it in Settings → Vault. Safe to
  run again. Remote Environments on Linux only; this computer is the second
  wave. Exit status: 0 connected, 2 waiting for a person (no vault named,
  not allowed by the network, revoked, not connected by the person, not
  available here), 1 failure.
vault request --item <name> --need <text> --why <text> --where <text>
    --field <Name>[:secret] [--field ...] [--json]
  Asks a person for a secret you cannot get any other way (root decision
  0198 point 9 (c)): never in chat. The person opens the printed link, the
  request's page in this Environment's Launchpad (Nastavení → Trezor lists
  it too), fills in the fields and saves them, or declines. Anyone admitted
  to the Environment can answer; no account in the vault is needed. The
  Environment saves the values as one Secure note named <name> in its own
  vault, in the collection Agenti: one custom field per --field, hidden for
  a :secret one, and the need, why and where as its notes. Write it so the
  person understands what is wanted: --need what you need as you would say
  it mid-sentence (the API key of the invoicing service), --why one short
  line, --where where in the service they find it (Settings → API clients).
  --field is the name the service gives the value; 1 to 10 fields. Prints
  the request's id and link; --json prints {kind: "vault-request", id,
  state, item, need, why, where, fields, createdAt, answeredAt, link}. Give
  the person the link and go on with other work. Only where the
  Environment's own vault is connected. Exit status: 0 created, 2 refused
  (invalid input, no vault, too many waiting), 1 failure.
vault request status <id> [--json]
  pending, saved (the vault holds it as the item named in the request: read
  it from the vault, never print it) or declined (nothing was saved).
vault request list [--json]
  Every request of this Environment's vault, oldest first, with its state.`;

export type VaultCliContext = CliContext &
  Readonly<{
    /** Test seam: the vault host instead of this process's. */
    host?: VaultHost | undefined;
    /** Where `setup` reports its phases (default: nothing). */
    progress?: ((line: string) => void) | undefined;
    /** Test seam: the Launchpad's external origin (the Folder's recorded
     * entry), or null where none is recorded. */
    launchpadOrigin?: (() => Promise<string | null>) | undefined;
  }>;

const reasons: Readonly<Record<VaultUnsupportedReason, string>> = {
  workstation:
    "this Environment has no vault: only a Remote Environment on Linux has one now (this computer is the second wave)",
  "folder-unreadable": "this Environment's Folder cannot be read",
  "handover-missing":
    "this Environment has no vault: there is no Machine handover",
  "handover-unreadable": "the Machine handover cannot be read",
  "not-operator": "this account is not the Environment's declared operator",
  "no-vault":
    "this Environment has no vault yet: its Machine handover names none",
  "connection-unreadable":
    "the record of the Bitwarden this personal Environment's person connected cannot be read; they disconnect it in the Launchpad's Settings → Vault and connect it again",
};

const notSetUp =
  "this Environment's vault is not set up yet (lazurio vault status says why; the Launchpad sets it up at its start, lazurio vault setup does the same)";

const envRefusals: Readonly<Record<VaultEnvRefusal, string>> = {
  ...reasons,
  "not-installed": notSetUp,
  "not-connected": notSetUp,
  busy: "the vault is busy with another operation; run it again in a moment",
  "unlock-failed":
    "the vault session could not be unlocked; lazurio vault status shows the state",
};

/** One shell word: single quotes, a quote inside closed and escaped. */
export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export function exportsOf(
  env: Extract<VaultEnvResult, { kind: "vault-env" }>["env"],
): string {
  return (
    [
      "BITWARDENCLI_APPDATA_DIR",
      "BW_SESSION",
      "LAZURIO_VAULT_ORGANIZATION_ID",
      "LAZURIO_VAULT_COLLECTION_ID",
    ] as const
  )
    .map((name) => `export ${name}=${shellQuote(env[name])}`)
    .join("\n");
}

/** Where people open the Environment's vault: the web vault of the network,
 * filtered to the vault's organization. */
export const vaultLinkOf = (vault: string, organizationId: string): string =>
  `${vault.replace(/\/+$/, "")}/#/vault?organizationId=${encodeURIComponent(organizationId)}`;

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const stepText: Readonly<Record<VaultPhase, string>> = {
  install: "installing the pinned Bitwarden CLI",
  account: "registering the account",
  vault: "creating the Environment's vault",
  "sign-in": "signing bw in",
};

/** The status in one or two plain lines; never a secret. */
export function statusText(status: VaultStatus): string {
  if (status.state === "unsupported")
    return `Not available: ${reasons[status.reason]}.`;
  if (status.state === "needs-connection")
    return "Not connected yet: this personal Environment keeps its vault in its person's own Bitwarden (bitwarden.eu or bitwarden.com), which they connect in the Launchpad's Settings → Vault with a separate agents' account. Only they do it there: never ask for that account's credentials or enter them yourself.";
  const where = `${status.account} in ${status.vault}`;
  const pilot = status.origin === "pilot-0197";
  switch (status.state) {
    case "not-set-up":
      return `Not set up yet: ${where}; the next step is ${stepText[status.next]}. The Launchpad sets it up at its start; lazurio vault setup does the same.`;
    case "creating":
      return `Being created: the creation of this Environment's vault for ${where} is not confirmed yet (its answer was lost, or the vault does not list it yet). The next setup looks for it again and never creates a second one; lazurio vault setup does it now.`;
    case "not-allowed":
      return `Not allowed yet: the vault refused to register ${where}. The network has not pre-allowed this address, or removed an unused pre-allowance; the network's operator allows it again at the next apply of its host, then run lazurio vault setup.`;
    case "connected": {
      const seen =
        status.items === null || status.organization === null
          ? " (locked: lazurio vault refresh unlocks it)"
          : `; it holds ${plural(status.items, "item", "items")}`;
      return pilot
        ? `Connected the 0197 way (read only until this Environment's own vault replaces it): ${where}, collection ${status.collectionId}${
            status.organization === null ? "" : ` of ${status.organization}`
          }${seen}.`
        : `Connected: this Environment's own vault${
            status.organization === null ? "" : ` "${status.organization}"`
          }, ${where}${seen}. Open it at ${vaultLinkOf(status.vault, status.organizationId)}.`;
    }
    case "revoked":
      return pilot
        ? `Access removed in the vault: ${status.account} no longer sees its collection.`
        : `Revoked: ${where} no longer has this Environment's vault (its organization is gone or its API key refused). The network's operator decides what happens next.`;
    case "unreachable":
      return `The vault does not answer (${status.reason}): ${status.vault}.`;
    case "failed":
      return status.region === undefined
        ? `Failed at ${status.stage}: ${status.reason}. An agent can finish it with lazurio tools prompt bitwarden.`
        : `Failed at ${status.stage}: ${status.reason}. ${personalFailures[status.reason] ?? "The person sees it in the Launchpad's Settings → Vault; lazurio vault setup tries again."}`;
  }
}

/** What a personal Environment's person does about a failure of their own
 * Bitwarden (root decision 0203 point 7). */
const personalFailures: Readonly<Record<string, string>> = {
  "free-organization-limit":
    "The agents' account owns or administers another free Bitwarden organization already, and Bitwarden allows one; the person disconnects it in the Launchpad's Settings → Vault and connects a new agents' account.",
  "account-missing":
    "The agents' account is no longer on this Environment; the person disconnects it in the Launchpad's Settings → Vault and connects it again.",
};

const phaseText: Readonly<Record<VaultPhase, string>> = {
  install: "Installing the pinned Bitwarden CLI…",
  account: "Registering the account…",
  vault: "Setting up the Environment's vault…",
  "sign-in": "Signing in…",
};

const commands = ["env", "status", "refresh", "setup"] as const;

export async function runVaultCommand(
  args: readonly string[],
  context: VaultCliContext,
): Promise<CommandOutput> {
  if (args[0] === "request")
    return runVaultRequestCommand(args.slice(1), context);
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: vault ${[...commands, "request"].join("|")} [--json]\n${vaultHelp}`,
  });
  let json = false;
  let command: string;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: { json: { type: "boolean" } },
    });
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (parsed.positionals.length !== 1 || new Set(names).size !== names.length)
      return usage;
    command = parsed.positionals[0] as string;
    json = parsed.values.json === true;
  } catch {
    return usage;
  }
  if (!(commands as readonly string[]).includes(command)) return usage;
  const host = vaultHostOf(context);
  try {
    if (command === "env") {
      const result = await vaultEnv(host);
      if (result.kind === "vault-env")
        return {
          code: exitOk,
          stdout: json ? JSON.stringify(result) : exportsOf(result.env),
        };
      return {
        code:
          result.reason === "busy" || result.reason === "unlock-failed"
            ? exitFailure
            : exitUsage,
        stderr: `Vault not available: ${envRefusals[result.reason]}.`,
      };
    }
    const status =
      command === "status"
        ? await vaultStatus(host)
        : command === "refresh"
          ? await vaultRefresh(host)
          : await vaultSetup(host, (phase: VaultPhase) => {
              if (!json) context.progress?.(phaseText[phase]);
            });
    const code =
      status.state === "failed" ||
      status.state === "unreachable" ||
      (command === "setup" && status.state === "creating")
        ? exitFailure
        : command === "setup" &&
            (status.state === "unsupported" ||
              status.state === "needs-connection" ||
              status.state === "not-allowed" ||
              status.state === "revoked")
          ? exitUsage
          : exitOk;
    return {
      code,
      stdout: json ? JSON.stringify(status) : statusText(status),
    };
  } catch {
    // Never a path, an output of bw or a value.
    return { code: exitFailure, stderr: `Vault ${command} failed.` };
  }
}

const vaultHostOf = (context: VaultCliContext): VaultHost =>
  context.host ??
  processVaultHost({
    folder: async () => context.hostedFolder?.(),
    env: context.env,
    platform: context.platform,
    run: runTool,
  });

// --- Secret requests (root decision 0198 point 9 (c), decision F54) -------

const requestSynopsis = `vault request --item <name> --need <text> --why <text> --where <text> --field <Name>[:secret] [--field ...] [--json]
       vault request status <id> [--json]
       vault request list [--json]`;

/** Its link: the Launchpad's external origin and the page; null where the
 * Folder records no entry (the page is then only in the Launchpad itself). */
export const secretRequestLink = (
  origin: string | null,
  id: string,
): string | null =>
  origin === null
    ? null
    : `${origin.replace(/\/+$/, "")}${secretRequestPath(id)}`;

/** The Launchpad's external origin, from the Folder's recorded entry. */
async function recordedOrigin(
  context: VaultCliContext,
): Promise<string | null> {
  if (context.launchpadOrigin !== undefined) return context.launchpadOrigin();
  try {
    const folder = await context.hostedFolder?.();
    if (folder === undefined) return null;
    const state = await readStartState(folder, { locked: false });
    return state.entry?.externalOrigin ?? null;
  } catch {
    return null;
  }
}

const requestRefusals: Readonly<Record<SecretRequestRefusal, string>> = {
  ...reasons,
  "pilot-0197":
    "this Environment's vault is still the read-only 0197 pilot; requests need its own vault (lazurio vault status)",
  "not-connected": notSetUp,
  "not-found": "there is no request of this id in this Environment's vault",
  answered: "the request is answered already",
  "too-many": `${secretRequestLimits.pending} requests wait for a person already; wait for their answers (lazurio vault request list)`,
  "item-invalid": `--item is the vault item's name: one line of 1 to ${secretRequestLimits.item} characters`,
  "need-invalid": `--need says what you need, as you would say it mid-sentence: one line of 3 to ${secretRequestLimits.need} characters`,
  "why-invalid": `--why says why, in one line of 3 to ${secretRequestLimits.why} characters`,
  "where-invalid": `--where says where in the service the person finds it, in one line of 3 to ${secretRequestLimits.where} characters`,
  "fields-missing":
    "name at least one --field: the value's name in the service, :secret for a secret one",
  "too-many-fields": `at most ${secretRequestLimits.fields} --field`,
  "field-invalid": `--field is <Name> or <Name>:secret, the name one line of 1 to ${secretRequestLimits.field} characters`,
  "field-duplicate": "two --field have the same name",
  "values-invalid": "the values are not the request's fields",
  busy: "the vault is busy with another operation; run it again in a moment",
  locked:
    "the vault session could not be unlocked; lazurio vault status shows the state",
  unreachable: "the vault does not answer",
  "vault-failed": "the vault did not answer as expected",
};

const inputRefusals: ReadonlySet<SecretRequestRefusal> = new Set([
  "item-invalid",
  "need-invalid",
  "why-invalid",
  "where-invalid",
  "fields-missing",
  "too-many-fields",
  "field-invalid",
  "field-duplicate",
]);

/** What an agent reads of a request: never a value (it has none). */
const requestJson = (request: SecretRequest, origin: string | null) =>
  JSON.stringify({
    kind: "vault-request",
    ...request,
    link: secretRequestLink(origin, request.id),
  });

const whereToAnswer = (request: SecretRequest, origin: string | null) =>
  secretRequestLink(origin, request.id) ??
  `Nastavení → Trezor in this Environment's Launchpad (${secretRequestPath(request.id)})`;

/** The state of a request in one line. */
export function secretRequestText(
  request: SecretRequest,
  origin: string | null,
): string {
  switch (request.state) {
    case "pending":
      return `Pending: request ${request.id} waits for a person: ${whereToAnswer(request, origin)}`;
    case "saved":
      return `Saved: the vault holds it as the item "${request.item}" in the collection Agenti. After eval "$(lazurio vault env)" and bw sync, pass its fields from bw get item "${request.item}" straight into the command that needs them; never print them.`;
    case "declined":
      return `Declined: the person declined request ${request.id}; nothing was saved.`;
  }
}

async function runVaultRequestCommand(
  args: readonly string[],
  context: VaultCliContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: ${requestSynopsis}`,
  });
  let parsed: ReturnType<typeof parseRequestArgs>;
  try {
    parsed = parseRequestArgs(args);
  } catch {
    return usage;
  }
  if (parsed === null) return usage;
  const host = vaultHostOf(context);
  const refuse = (reason: SecretRequestRefusal) =>
    Object.freeze({
      code:
        reason === "busy" ||
        reason === "locked" ||
        reason === "unreachable" ||
        reason === "vault-failed"
          ? exitFailure
          : exitUsage,
      ...(parsed?.json === true
        ? {
            stdout: JSON.stringify({
              kind: "vault-request-refused",
              reason,
            }),
          }
        : {}),
      stderr: `Vault request ${inputRefusals.has(reason) ? "invalid" : "refused"} (${reason}): ${requestRefusals[reason]}.`,
    });
  try {
    if (parsed.command === "list") {
      const answer = await listSecretRequests(host);
      if (answer.kind !== "vault-requests") return refuse(answer.reason);
      const origin = await recordedOrigin(context);
      return {
        code: exitOk,
        stdout: parsed.json
          ? JSON.stringify({
              kind: "vault-requests",
              requests: answer.requests.map((request) => ({
                ...request,
                link: secretRequestLink(origin, request.id),
              })),
            })
          : answer.requests.length === 0
            ? "No requests."
            : answer.requests
                .map(
                  (request) =>
                    `${request.id}  ${request.state.padEnd(8)}  ${request.item}`,
                )
                .join("\n"),
      };
    }
    if (parsed.command === "status") {
      const answer = await secretRequestOf(host, parsed.id);
      if (answer.kind !== "vault-request") return refuse(answer.reason);
      const origin = await recordedOrigin(context);
      return {
        code: exitOk,
        stdout: parsed.json
          ? requestJson(answer, origin)
          : secretRequestText(answer, origin),
      };
    }
    const answer = await createSecretRequest(host, parsed.input);
    if (answer.kind !== "vault-request") return refuse(answer.reason);
    const origin = await recordedOrigin(context);
    return {
      code: exitOk,
      stdout: parsed.json
        ? requestJson(answer, origin)
        : [
            `Request ${answer.id}: ${whereToAnswer(answer, origin)}`,
            `Give the person this link and go on with other work; lazurio vault request status ${answer.id} says when it is answered.`,
          ].join("\n"),
    };
  } catch {
    // Never a path, an output of bw or a value.
    return { code: exitFailure, stderr: "Vault request failed." };
  }
}

type RequestArgs =
  | Readonly<{
      command: "create";
      json: boolean;
      input: Readonly<{
        item: string | undefined;
        need: string | undefined;
        why: string | undefined;
        where: string | undefined;
        fields: readonly string[];
      }>;
    }>
  | Readonly<{ command: "status"; json: boolean; id: string }>
  | Readonly<{ command: "list"; json: boolean }>;

/** The request's arguments, or null when they are not one of its three
 * forms. Every option at most once but --field. */
function parseRequestArgs(args: readonly string[]): RequestArgs | null {
  const parsed = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {
      json: { type: "boolean" },
      item: { type: "string" },
      need: { type: "string" },
      why: { type: "string" },
      where: { type: "string" },
      field: { type: "string", multiple: true },
    },
  });
  const names = parsed.tokens.flatMap((token) =>
    token.kind === "option" && token.name !== "field" ? [token.name] : [],
  );
  if (new Set(names).size !== names.length) return null;
  const json = parsed.values.json === true;
  const { item, need, why, where, field } = parsed.values;
  const creating = [item, need, why, where, field].some(
    (value) => value !== undefined,
  );
  const [command, id, ...rest] = parsed.positionals;
  if (command === undefined)
    return {
      command: "create",
      json,
      input: { item, need, why, where, fields: field ?? [] },
    };
  if (creating || rest.length > 0) return null;
  if (command === "list" && id === undefined) return { command, json };
  if (command === "status" && id !== undefined) return { command, json, id };
  return null;
}
