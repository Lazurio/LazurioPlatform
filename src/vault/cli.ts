import { parseArgs } from "node:util";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import type { VaultUnsupportedReason } from "./context";
import {
  type VaultEnvResult,
  type VaultHost,
  type VaultPhase,
  type VaultStatus,
  vaultConnect,
  vaultEnv,
  vaultRefresh,
  vaultStatus,
} from "./flow";
import { processVaultHost } from "./host";

/** `lazurio vault`: the Environment vault for agents (decision F43). The same
 * core as the Launchpad's Settings → Tools → bitwarden. */
export const vaultHelp = `vault env [--json]
  The Environment vault for this shell: prints shell exports of
  BITWARDENCLI_APPDATA_DIR, BW_SESSION, LAZURIO_VAULT_ORGANIZATION_ID and
  LAZURIO_VAULT_COLLECTION_ID. Run it as eval "$(lazurio vault env)", then
  plain bw. The Launchpad keeps one unlocked session for the whole
  Environment; when that session is no longer the unlocked one, this command
  unlocks it again (each unlock ends the earlier session, so run it again
  when bw says the vault is locked). Never run bw login, unlock, lock, logout
  or config. Not connected: one line on stderr, nothing on stdout. --json
  prints {kind: "vault-env", env} with the same four values. The session is
  printed by design, for the agent's shell only: never paste it into chat,
  Git, a log or a pull request.
vault status [--json]
  This Environment's vault account as the Launchpad shows it, from bw's local
  copy (no network): connected (organization, collections, items), waiting
  for the Admin's confirmation (with the fingerprint phrase), not connected,
  or why this Environment has no vault account here.
vault refresh [--json]
  Syncs with the vault, unlocks the session again when needed, then the
  status: also revoked (access removed in the vault) or unreachable.
vault connect [--json]
  What Settings → Tools → bitwarden does, for an agent: installs the pinned
  Bitwarden CLI, creates the account vaultwarden@<Environment address> with a
  password generated here (an Admin or Owner of the vault's organization must
  have invited the address into the collection Environmenty/<name> ·
  <machine> first), signs it in with its API key, unlocks the one session and
  syncs. Then an Admin confirms the member by the fingerprint phrase printed
  here. Remote Environments on Linux only; this computer is the second wave.
  Exit status: 0 connected or waiting for confirmation, 2 waiting for a
  person (not invited, revoked, not available here), 1 failure.`;

export type VaultCliContext = CliContext &
  Readonly<{
    /** Test seam: the vault host instead of this process's. */
    host?: VaultHost | undefined;
    /** Where `connect` reports its phases (default: nothing). */
    progress?: ((line: string) => void) | undefined;
  }>;

const reasons: Readonly<Record<VaultUnsupportedReason, string>> = {
  workstation:
    "this Environment has no vault account: only a Remote Environment on Linux has one now (this computer is the second wave)",
  "folder-unreadable": "this Environment's Folder cannot be read",
  "handover-missing":
    "this Environment has no vault account: there is no Machine handover",
  "handover-unreadable": "the Machine handover cannot be read",
  "not-operator": "this account is not the Environment's declared operator",
  "no-address":
    "the Machine handover records no hosted entry, so the Environment's address is not known",
  "no-network":
    "the Machine handover names no tailnet, so the Environment's vault is not known",
  "vault-unknown":
    "the tailnet's control server is not headscale.<zone>, so the Environment's vault is not known",
};

const envRefusals: Readonly<
  Record<
    Extract<VaultEnvResult, { kind: "vault-env-refused" }>["reason"],
    string
  >
> = {
  ...reasons,
  "not-installed":
    "the vault is not connected in this Environment: ask the Operator to connect it in the Launchpad (Settings → Tools → bitwarden)",
  "not-connected":
    "the vault is not connected in this Environment: ask the Operator to connect it in the Launchpad (Settings → Tools → bitwarden)",
  busy: "the vault is busy with another operation; run it again in a moment",
  "unlock-failed":
    "the vault session could not be unlocked; tell the Operator (Settings → Tools → bitwarden shows the state)",
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

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** The status in one or two plain lines; never a secret. */
export function statusText(status: VaultStatus): string {
  if (status.state === "unsupported")
    return `Not available: ${reasons[status.reason]}.`;
  const where = `${status.account} in ${status.vault}`;
  switch (status.state) {
    case "not-installed":
    case "none":
      return status.registered
        ? `Not connected: the account ${where} exists; lazurio vault connect signs it in again.`
        : `Not connected. An Admin or Owner of the vault's organization invites ${status.account} with edit rights into the collection "${status.collection}" in ${status.vault}; then run lazurio vault connect (or Settings → Tools → bitwarden).`;
    case "awaiting-invite":
      return `Not invited yet: the vault refused to create ${status.account}. An Admin or Owner of the vault's organization invites it with edit rights into the collection "${status.collection}" in ${status.vault}, then run lazurio vault connect again.`;
    case "confirming":
      return `Waiting for the confirmation: an Admin or Owner confirms the member ${status.account} in ${status.vault}; the fingerprint phrase must be ${status.fingerprint}.${
        status.organization === null
          ? ""
          : ` Confirmed in ${status.organization}, but the collection "${status.collection}" is not visible yet.`
      }`;
    case "connected":
      return `Connected: ${where}, collection "${status.collection}"${
        status.organization === null ? "" : ` of ${status.organization}`
      }${
        status.collections === null || status.items === null
          ? " (locked: lazurio vault refresh unlocks it)"
          : `; it sees ${plural(status.collections, "collection", "collections")} and ${plural(status.items, "item", "items")}`
      }. Fingerprint: ${status.fingerprint}.`;
    case "revoked":
      return `Access removed in the vault: ${status.account} no longer sees its collection. An Admin or Owner invites it again; then lazurio vault connect.`;
    case "unreachable":
      return `The vault does not answer (${status.reason}): ${status.vault}.`;
    case "failed":
      return `Failed at ${status.stage}: ${status.reason}. An agent can finish it with lazurio tools prompt bitwarden.`;
  }
}

const phaseText: Readonly<Record<VaultPhase, string>> = {
  install: "Installing the pinned Bitwarden CLI…",
  account: "Creating the account…",
  "sign-in": "Signing in…",
};

export async function runVaultCommand(
  args: readonly string[],
  context: VaultCliContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: vault env|status|refresh|connect [--json]\n${vaultHelp}`,
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
  if (!["env", "status", "refresh", "connect"].includes(command)) return usage;
  const host =
    context.host ??
    processVaultHost({
      folder: async () => context.hostedFolder?.(),
      env: context.env,
      platform: context.platform,
      run: runTool,
    });
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
          : await vaultConnect(host, (phase) => {
              if (!json) context.progress?.(phaseText[phase]);
            });
    const code =
      status.state === "failed" || status.state === "unreachable"
        ? exitFailure
        : command === "connect" &&
            (status.state === "unsupported" ||
              status.state === "awaiting-invite" ||
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
