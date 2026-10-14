import { parseArgs } from "node:util";
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
  not set up yet (and the next step), or why this Environment has no vault
  here. The one source of truth: read it before saying anything about the
  vault.
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
  one session and syncs. Safe to run again. Remote Environments on Linux
  only; this computer is the second wave. Exit status: 0 connected, 2
  waiting for a person (no vault named, not allowed by the network, revoked,
  not available here), 1 failure.`;

export type VaultCliContext = CliContext &
  Readonly<{
    /** Test seam: the vault host instead of this process's. */
    host?: VaultHost | undefined;
    /** Where `setup` reports its phases (default: nothing). */
    progress?: ((line: string) => void) | undefined;
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
      return `Failed at ${status.stage}: ${status.reason}. An agent can finish it with lazurio tools prompt bitwarden.`;
  }
}

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
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: vault ${commands.join("|")} [--json]\n${vaultHelp}`,
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
