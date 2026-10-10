import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { readFolderState } from "../folder/read-state";
import type { ToolsEnvironment } from "../tools/overview";
import { embeddedIdentity } from "../update/identity";
import { organizationGoverns } from "./governance";
import { operatorGit, readRepositorySettings } from "./local";
import {
  createSettingsPoller,
  type SettingsPoller,
  type SettingsPollerOptions,
  type SettingsSourceAdapter,
} from "./poller";
import {
  createRelayClient,
  type RelayTransport,
  unixSocketTransport,
} from "./relay";
import {
  fileStateStore,
  memoryStateStore,
  type SettingsStateStore,
} from "./state";

// Where the Launchpad of one Folder gets its Organization's settings
// (decision F45): trusted composition, never request input.
//
// - A personal Environment and the person's own computer: nowhere; an
//   Organization's settings never govern them.
// - An Organization's Environment whose handover names the Environment's
//   relay: the Dashboard through it (contract C3), with reports.
// - An Organization's Environment without the relay: the root of the
//   Organization its handover names, in the Folder (the same document from
//   Git), without reports.
//
// The record of the last applied version lives in the install base of the
// installed Launchpad; a Launchpad without one (a development run) keeps it
// in memory.

export type OrganizationSettingsSeams = Readonly<{
  /** The transport to the relay at `socket`; tests use a socket of their
   * own, as the handover names one under /run. */
  transport?: (socket: string) => RelayTransport;
  /** The relay client's backoff and deadline (tests). */
  client?: Readonly<{ retryDelaysMs?: readonly number[]; timeoutMs?: number }>;
  store?: SettingsStateStore;
  poller?: Partial<
    Pick<
      SettingsPollerOptions,
      | "now"
      | "setTimeout"
      | "clearTimeout"
      | "startupDelayMs"
      | "intervalMs"
      | "nudgeGapMs"
      | "reportIntervalMs"
    >
  >;
}>;

export async function launchpadSettingsPoller(
  input: Readonly<{
    folder: string;
    /** The installed Launchpad's install base, when it has one. */
    base: string | undefined;
    tools: ToolsEnvironment;
    journal: (entry: Readonly<Record<string, unknown>>) => void;
    onApplied: () => void;
    seams?: OrganizationSettingsSeams | undefined;
  }>,
): Promise<SettingsPoller | null> {
  const state = join(input.folder, ".lazurio");
  const { preferences } = await withFolderReadLock(state, () =>
    readFolderState(state),
  );
  if (!organizationGoverns(preferences.preset.name)) return null;
  const machine = preferences.machine;
  const socket = machine?.entry?.environmentRelaySocket;
  let source: SettingsSourceAdapter;
  if (socket !== undefined) {
    const client = createRelayClient({
      transport: (input.seams?.transport ?? unixSocketTransport)(socket),
      ...input.seams?.client,
    });
    source = {
      kind: "dashboard",
      read: (known) => client.readSettings(known),
      report: (report) => client.sendReport(report),
    };
  } else if (machine?.owner.kind === "organization") {
    const organization = machine.owner.organization;
    const git = operatorGit(input.tools);
    source = {
      kind: "repository",
      read: () => readRepositorySettings(input.folder, organization, git),
    };
  } else return null;
  return createSettingsPoller({
    folder: input.folder,
    source,
    store:
      input.seams?.store ??
      (input.base === undefined
        ? memoryStateStore()
        : fileStateStore(input.base, input.folder)),
    platformVersion: embeddedIdentity().version,
    journal: input.journal,
    onApplied: input.onApplied,
    ...input.seams?.poller,
  });
}
