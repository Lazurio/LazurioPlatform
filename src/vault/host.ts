import { isAbsolute, join } from "node:path";
import { readFolderTools } from "../folder/inspect-tools-change";
import { FolderOperationBusyError, withFolderReadLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readFolderState } from "../folder/read-state";
import { updateTools } from "../folder/update-profile";
import { presetKinds } from "../launchpad/shell-document";
import {
  bindMachineOperator,
  MachineContextError,
  productionMachineContextSource,
  readMachineContext,
} from "../machine/context";
import {
  type HostedOperatorSources,
  readLinuxOperator,
} from "../machine/operator";
import { vaultToolName } from "../tools/catalog";
import type { ToolRunner } from "../tools/status";
import { resolveInstallBase } from "../update/base";
import { readConnection } from "./connection";
import {
  connectionDirectory,
  personalVaultContextOf,
  personalVaultName,
  type VaultContext,
  type VaultEnvironmentKind,
  type VaultNeedsConnection,
  type VaultUnsupported,
  type VaultUnsupportedReason,
  vaultContextOf,
  vaultStateDirectory,
} from "./context";
import type { VaultHost, VaultJournalEntry } from "./flow";
import { type PilotContext, pilotContextOf } from "./legacy-0197/context";
import { pilotConnected } from "./legacy-0197/pilot";
import { workstationVaultContext } from "./workstation";

// The production composition of the Environment vault (decisions F43, F53):
// the facts of this Remote Environment from its root-issued handover, read
// anew for every operation, and the kind of the Environment from its Folder.
// Only the handover's declared operator, in a hosted Folder on Linux, has a
// vault. On macOS, a local Folder instead selects an explicitly connected
// Organization account (workstation.ts), never a fabricated handover.
// Missing or unreadable identity refuses before anything runs. A handover that
// names no vault yet may still be a 0197 pilot's (legacy-0197/). A personal
// Environment whose handover names no vault and that is no connected pilot
// keeps its vault in its person's own Bitwarden (root decision 0203 point
// 7): connected as its connection records it, or waiting for its person.

const unsupported = (reason: VaultUnsupportedReason): VaultUnsupported =>
  Object.freeze({ kind: "unsupported", reason });

/** The vault facts of the Environment one Folder records. */
export async function readVaultContext(
  input: Readonly<{
    /** The Folder the Launchpad serves, or the hosted operator's Folder. */
    folder: string | undefined;
    platform: string;
    /** The process's home: it must be the declared operator's. */
    home: string | undefined;
    sources?: HostedOperatorSources | undefined;
    /** Where the accounts' custody is (`VaultHost.directory`): a 0197
     * pilot's is looked at there. */
    directory: VaultHost["directory"];
    /** Where a personal Environment records the Bitwarden its person
     * connected (`VaultHost.connection`). */
    connection: string;
    organization?: string | undefined;
  }>,
): Promise<
  VaultContext | PilotContext | VaultUnsupported | VaultNeedsConnection
> {
  if (
    !["linux", "darwin"].includes(input.platform) ||
    input.folder === undefined
  )
    return unsupported("workstation");
  const folder = input.folder;
  let preset: keyof typeof presetKinds;
  try {
    await inspectOwnedDirectory(folder);
    const state = join(folder, ".lazurio");
    preset = await withFolderReadLock(state, async () => {
      const { preferences } = await readFolderState(state);
      return preferences.preset.name;
    });
  } catch {
    return unsupported("folder-unreadable");
  }
  const kind = presetKinds[preset];
  if (kind === "workstation") {
    if (input.platform !== "darwin" || input.organization === undefined)
      return unsupported("workstation");
    try {
      return (
        (await workstationVaultContext(
          join(input.connection, "..", "workstation"),
          input.organization,
        )) ?? unsupported("workstation")
      );
    } catch {
      return unsupported("connection-unreadable");
    }
  }
  if (input.platform !== "linux") return unsupported("workstation");
  const sources = input.sources ?? {
    handover: productionMachineContextSource,
    operator: readLinuxOperator,
  };
  let handover: Awaited<ReturnType<typeof readMachineContext>>["context"];
  try {
    ({ context: handover } = await readMachineContext(sources.handover));
  } catch (error) {
    return unsupported(
      error instanceof MachineContextError &&
        error.code === "machine-context-missing"
        ? "handover-missing"
        : "handover-unreadable",
    );
  }
  try {
    const operator = await sources.operator();
    bindMachineOperator(handover, operator);
    if (input.home !== operator.homedir) return unsupported("not-operator");
  } catch (error) {
    return unsupported(
      error instanceof MachineContextError &&
        error.code === "machine-operator-mismatch"
        ? "not-operator"
        : "handover-unreadable",
    );
  }
  const environment = kind as VaultEnvironmentKind;
  const own = vaultContextOf({ handover, environment });
  if (own.kind !== "unsupported") return own;
  // No vault named yet: an Environment connected the 0197 way keeps reading
  // its collection until its handover names its own vault.
  const pilot = pilotContextOf({ handover, environment });
  if (environment !== "personal" || handover.owner.kind !== "principal")
    return pilot ?? own;
  // A personal Environment: its person's own Bitwarden, as connected, a
  // connected pilot as before, or waiting for its person.
  let connection: Awaited<ReturnType<typeof readConnection>>;
  try {
    connection = await readConnection(input.connection);
  } catch {
    return unsupported("connection-unreadable");
  }
  if (connection !== null)
    return personalVaultContextOf({ handover, connection }) ?? own;
  if (pilot !== null && (await pilotConnected(input.directory, pilot)))
    return pilot;
  return Object.freeze({
    kind: "needs-connection",
    name: personalVaultName(handover.owner.github_login),
  });
}

/** "Používají agenti" on for the vault in one Folder, at its current
 * revision (decision F53): the change the switch itself makes, refused as
 * the switch is where this Environment does not offer the vault or its
 * Organization does not allow it. A Folder that another change holds or
 * changed meanwhile is read again, as the Organization's settings are
 * applied (src/organization-settings/apply.ts); anything else throws. */
export async function enableVaultForAgents(folder: string): Promise<void> {
  const attempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const recorded = await readFolderTools(folder);
      if (recorded.enabled.includes(vaultToolName)) return;
      const result = await updateTools(
        folder,
        recorded.revision,
        [...recorded.enabled, vaultToolName].sort(),
      );
      if (
        result.kind !== "blocked" ||
        result.reason !== "stale-revision" ||
        attempt >= attempts
      )
        return;
    } catch (error) {
      if (!(error instanceof FolderOperationBusyError) || attempt >= attempts)
        throw error;
    }
    await Bun.sleep(250 * attempt);
  }
}

/** The vault of this process: its home, its install base and `~/.local/bin`,
 * its PATH for bw, and the Folder the context is read from, which is also
 * the one whose agents' switch the vault turns on once it is ready. */
export function processVaultHost(
  input: Readonly<{
    folder: () => Promise<string | undefined>;
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
    arch?: string | undefined;
    organization?: string | undefined;
    run: ToolRunner;
    journal?: ((entry: VaultJournalEntry) => void) | undefined;
    sources?: HostedOperatorSources | undefined;
  }>,
): VaultHost {
  const home =
    input.env.HOME !== undefined && isAbsolute(input.env.HOME)
      ? input.env.HOME
      : undefined;
  const base =
    home === undefined
      ? undefined
      : resolveInstallBase({
          platform: input.platform,
          env: input.env,
          homedir: home,
        });
  const directory = (host: string, key: string) =>
    vaultStateDirectory(host, key, home ?? "/nonexistent", input.env);
  const connection = connectionDirectory(home ?? "/nonexistent", input.env);
  return Object.freeze({
    async context(application) {
      if (home === undefined || base === undefined)
        return unsupported("workstation");
      let folder: string | undefined;
      try {
        folder = await input.folder();
      } catch {
        return unsupported("handover-unreadable");
      }
      return readVaultContext({
        folder,
        platform: input.platform,
        home,
        sources: input.sources,
        directory,
        connection,
        organization: application?.personalspace
          ? undefined
          : (application?.company ?? input.organization),
      });
    },
    directory,
    connection,
    base: base ?? "/nonexistent",
    bin: join(home ?? "/nonexistent", ".local", "bin"),
    home: home ?? "/nonexistent",
    path: input.env.PATH,
    platform: input.platform,
    arch: input.arch ?? process.arch,
    run: input.run,
    journal: input.journal,
    async enableForAgents() {
      const folder = await input.folder();
      if (folder !== undefined) await enableVaultForAgents(folder);
    },
  });
}
