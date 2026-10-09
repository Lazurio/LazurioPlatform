import { isAbsolute, join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readFolderState } from "../folder/read-state";
import { presetKinds, teamLabel } from "../launchpad/shell-document";
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
import { readFolderCatalog } from "../organizations/catalog";
import type { ToolRunner } from "../tools/status";
import { resolveInstallBase } from "../update/base";
import {
  type VaultContext,
  type VaultEnvironmentKind,
  type VaultUnsupported,
  type VaultUnsupportedReason,
  vaultContextOf,
  vaultStateDirectory,
} from "./context";
import type { VaultHost, VaultJournalEntry } from "./flow";

// The production composition of the Environment vault (decision F43): the
// facts of this Remote Environment from its root-issued handover, read anew
// for every operation, and the kind and name of the Environment from its
// Folder. Only the handover's declared operator, in a hosted Folder on Linux,
// has a vault account; everything else is a workstation of the second wave
// or a handover that cannot be trusted, and refuses before anything runs.

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
  }>,
): Promise<VaultContext | VaultUnsupported> {
  if (input.platform !== "linux" || input.folder === undefined)
    return unsupported("workstation");
  const folder = input.folder;
  let preset: keyof typeof presetKinds;
  let machine: Awaited<
    ReturnType<typeof readFolderState>
  >["preferences"]["machine"];
  try {
    await inspectOwnedDirectory(folder);
    const state = join(folder, ".lazurio");
    ({ preset, machine } = await withFolderReadLock(state, async () => {
      const { preferences } = await readFolderState(state);
      return {
        preset: preferences.preset.name,
        machine: preferences.machine,
      };
    }));
  } catch {
    return unsupported("folder-unreadable");
  }
  const kind = presetKinds[preset];
  if (kind === "workstation") return unsupported("workstation");
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
  // The Environment's own label, as the rail names it: a Team's or a
  // persona's display name from the Organization's catalog, when the Folder
  // holds it; otherwise its kind's name.
  const catalog = await readFolderCatalog(folder).catch(() => null);
  const label = catalog === null ? null : teamLabel(machine, kind, catalog);
  return vaultContextOf({
    handover,
    kind: kind as VaultEnvironmentKind,
    label,
  });
}

/** The vault of this process: its home, its install base and `~/.local/bin`,
 * its PATH for bw, and the Folder the context is read from. */
export function processVaultHost(
  input: Readonly<{
    folder: () => Promise<string | undefined>;
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
    arch?: string | undefined;
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
  return Object.freeze({
    async context() {
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
      });
    },
    directory: (host: string) =>
      vaultStateDirectory(host, home ?? "/nonexistent", input.env),
    base: base ?? "/nonexistent",
    bin: join(home ?? "/nonexistent", ".local", "bin"),
    home: home ?? "/nonexistent",
    path: input.env.PATH,
    platform: input.platform,
    arch: input.arch ?? process.arch,
    run: input.run,
    journal: input.journal,
  });
}
