import { parseArgs } from "node:util";
import { BuddyFolderRefused } from "../folder/buddy-folder";
import { FolderAdoptionError } from "../folder/handover-layout";
import {
  adoptedHandoverFolder,
  adoptionReadWaitMs,
  initializeHandoverFolder,
} from "../folder/initialize-folder";
import { FolderOperationBusyError } from "../folder/lock";
import {
  assignedEnvironments,
  type MachineBinding,
} from "../folder/machine-binding";
import { executionOs } from "../folder/platform";
import {
  allowedPresets,
  derivePreset,
  type PresetName,
  parsePresetName,
  presetProfile,
  selectablePresets,
  workspacePreset,
} from "../folder/presets";
import { refreshFolder } from "../folder/update-profile";
import {
  type AccessServiceLocation,
  accessServiceOf,
} from "../ssh-access/access-service";
import {
  type EnvironmentSshLocation,
  writeEnvironmentRoutes,
} from "../ssh-access/environments";
import {
  commitRoutes,
  liveRoutesSource,
  type RoutesSeams,
  type RoutesWrite,
  syncEnvironmentRoutes,
} from "../ssh-access/routes";
import {
  issueLiveLinkPairing,
  settleLiveLinkPairing,
  syncLiveT3Links,
} from "../t3-links/live";
import { runTool } from "../tools/status";
import { createAssignedFolderLayout, isAuthSourced } from "./assignment";
import { machineBinding, ownerOrganizationKey } from "./binding";
import {
  bindMachineOperator,
  MachineContextError,
  type MachineHandover,
  readMachineContext,
  readMachineHandover,
} from "./context";
import { requireInstalledProduct, runningProduct } from "./installed-product";
import {
  type LaunchpadSeams,
  recordedEntry,
  recordedEntryDigest,
  recordRestartOwed,
  restartLaunchpadForEntry,
  restartOwedFor,
} from "./launchpad-entry";
import { readLinuxOperator } from "./operator";

export const machineHelp = `machine inspect
Read the root-issued /etc/lazurio/lazurio.machine.json on Linux only and print
it as written, including its optional entry (how the gateway reaches the
Launchpad, T3 Code and modules of this Remote Environment).
Output contains private Environment/Organization context; do not publish it.
The declaration grants no permissions, provider identity or access.
machine folder-init [--preset <name>] [--locale <cs|en>]
  [--detail <concise|technical>] [--coordination <direct|coordinator>]
Initialize the declared operator's standard Lazurio Folder from the handover.
On a free Environment (an auth-sourced handover, root decision 0216) the
operator is the person its assignment receipt /etc/lazurio/assignment.json
names: the Folder is created in that person's home once the receipt names
them, with the preset the receipt's kind derives (personal-vm ->
hosted-personal, workspace-vm -> hosted-organization-personal); before that
every machine command except inspect is blocked with
machine-assignment-pending and nothing is created or refreshed for anybody.
The workspace preset is derived from the handover (personal-vm -> hosted-personal;
workspace-vm with owner.assignment operator -> hosted-organization-personal, team
-> hosted-organization-team, automation (the Henry Environment of an
Organization persona, decision 0169) -> hosted-organization-steward, services
(the services Environment of a server, root decision 0209) ->
hosted-organization-team; without owner.assignment and without owner.team ->
hosted-organization-personal). When
the handover states owner.assignment, --preset may name only the preset it
derives. A workspace-vm handover with owner.team and no owner.assignment does
not say whether the Remote Environment is assigned to one user or shared, so
it derives nothing: --preset with one of hosted-organization-personal,
hosted-organization-team or hosted-organization-steward is required and
recorded as an explicit choice; without owner.assignment --preset may pick any
of these on a workspace-vm. Omitted communication choices take the preset's
defaults; all are changeable later in the Launchpad.
Adopts the existing Folder: organizations/ and personalspace/ may hold work
and are never entered; launchpad.gen3.json and launchpad.gen3.local.json are
tolerated; any other top-level entry is refused by name. Re-running on an
adopted Folder reports already-adopted and changes nothing; a rewritten
handover reaches the Folder through folder-refresh. On a personal Remote
Environment an "initialized" answer also writes the SSH config for its
assigned Work Environments and adds "environmentSsh", as folder-refresh does.
Run as the declared operator, never root. No path or custody override.
No Organization checkout, gateway change, resident removal or migration.
An interrupted recognized journal can be completed using folder-resume;
missing/damaged journals require a user's diagnosis, never blanket cleanup.
machine folder-refresh [--preset <name>]
Re-render the adopted Folder's generated files (AGENTS.md, manual/) from the
current handover, keeping the recorded preset and profile. Run it as the
declared operator after every handover rewrite; lazurio update runs it itself
after a product update when the Folder records an older template revision. --preset
names the preset the handover now derives, to take it after
preset-derivation-changed; no other preset is taken here. A Folder rendered by
an older template revision is re-rendered in full when every generated file
still matches its recorded digest.
The Environment identity (kind, name, Owner, tailnet node) must be the one the
Folder was adopted for; the host, assignment, relationships and the document
digest follow the handover. One correction of the identity is recorded: on a
work Environment whose Folder recorded the Owner Organization by another value,
a handover that now names it by exactly owner.organization_key in lower case,
with everything else in the identity the same, is the same Environment; the
refresh records it and adds "bindingCorrected":"owner-organization" to its
answer (folder-init on that Folder answers already-adopted with
"bindingCorrection":"owner-organization" and writes nothing). Prints
{"kind":"refreshed","revision":<n>} after one
archived update transaction, or {"kind":"unchanged"} when the Folder already
records the current handover's digest and it renders the same bytes (nothing
is written, the revision stays). A handover rewritten where nothing is
rendered or recorded (installed, for example) is recorded by its digest alone,
every generated file byte for byte the same, so doctor's machine-binding is ok
after it: {"kind":"refreshed","revision":<n>,"bindingRebound":"handover-digest"}.
On a personal Remote Environment either answer then also writes, from the
recorded binding's assigned Work Environments, ~/.ssh/config.d/lazurio-environments.conf
(0600), ~/.ssh/known_hosts_lazurio_environments (0644) and one Include line at
the top of ~/.ssh/config, or removes the two files when there are none, and
adds "environmentSsh": written, unchanged, removed, none, blocked (with reason
and path: a file Lazurio did not write or an unsafe path, nothing changed) or
failed; the exit code stays the refresh's. A refresh
that records a different entry restarts the supervised Launchpad of this
Folder, which reads its entry only when it starts, and waits for it to answer;
modules, T3 Code and Codex keep running. The answer then adds "launchpad":
restarted, restart-failed or not-supervised (no installer unit of this base
starts this Folder; the Launchpad takes the entry at its next start). A
failed restart is kept as owed in the install base
(update/launchpad-restart-owed.json) and made by the next refresh, unchanged
or not, as is one the supervised Launchpad shows by reporting another entry
than the recorded one; it is answered the same way. The debt is recorded
before the refresh and cleared when none was owed; one that cannot be
recorded is blocked with exit 2, nothing written: launchpad-restart-unrecordable. A person
the handover converts to Buddy GEN4 gets ~/Buddy written after the change; a
write that fails there adds "buddyFolder": {"state":"failed","error":...}, the
change, its entry and the Launchpad's restart stand, the exit code stays the
refresh's, and the next refresh writes ~/Buddy again. Blocked with
exit 2, nothing written: folder-not-initialized (run folder-init first),
buddy-folder-mismatch, buddy-folder-claude-md or buddy-folder-unsafe with its
detail (~/Buddy cannot take Buddy's instructions: not Buddy of this home, a
CLAUDE.md there, a link or a directory or file of another account),
folder-binding-changed, folder-state-unrecognized, drift or unsafe-path with
the edited path (owned files are never overwritten), preset-derivation-changed
(the assignment now derives another preset: take it with folder-refresh
--preset <the derived preset>), preset-not-allowed (--preset is not the
preset the handover derives), template-upgrade-required (a newer product rendered the Folder;
nothing is downgraded), or a machine-context-* code. Exit 1 is an
operation failure; an interrupted refresh is completed with
profile-resume --folder <Folder> --target-revision <n>.
machine t3-links
Look once at the links between this Environment's Chat T3 Code and the T3 Code
of the Environments its edges reach (root decision 0157, amended 2026-11-17),
as the Launchpad does every five minutes. On a personal Remote Environment it
turns T3 Code's linked environments on, pairs each assigned Work Environment
over its managed SSH route and links it, renews a link with less than seven
days left and forgets one whose edge went. On a work Remote Environment it
turns linked environments on while an inbound edge from a personal Machine
exists and revokes the sessions of linked T3 Code when one goes. Lazurio
never creates or removes an edge; it is the Organization's record. Prints one
JSON object without any pairing code or token; exit 1 when another look holds
the lock (busy) or t3 is missing.
machine t3-link-pair --source <node>
The target's half of one pairing, run by a source's look over its managed SSH
route: only while this work Environment's handover names <node> as an inbound
edge from a personal Machine and no other source's code is out, it records
the source, the time and the sessions of linked T3 Code that exist already,
turns linked environments on through the running T3 Code and prints
{"kind":"t3-link-pair","id":…,"credential":…} for the source to spend at
once. The code reaches nothing but that standard output. Exit 1 with
{"kind":"t3-link-pair","reason":…} when it refuses.
machine t3-link-settle --source <node>
Right after a source's link attempt: the session that appeared for its code
becomes that source's, by id, and its earlier sessions are revoked. Prints
{"kind":"t3-link-settle","result":"settled"|"pending"|"refused"}.
Every outcome of folder-init, folder-refresh and inspect is exactly one JSON
object on stdout; text for people goes to stderr. A Folder whose lock another
Lazurio operation still holds after the adoption check waited answers
{"kind":"blocked","reason":"folder-busy","retryable":true} with exit 2, nothing
changed: the same command may simply be run again. Any other failure answers
{"kind":"failed","reason":"internal"} with exit 1.`;

const choices = {
  locale: ["cs", "en"],
  detail: ["concise", "technical"],
  coordination: ["direct", "coordinator"],
} as const;

// A wrong invocation, before any filesystem access: the CLI prints the help
// text and exits 2. It is not a failed Folder operation.
export class MachineUsageError extends Error {}

const machineOptions = {
  preset: { type: "string" },
  locale: { type: "string" },
  detail: { type: "string" },
  coordination: { type: "string" },
  source: { type: "string" },
} as const;

function parseMachineTokens(args: string[]) {
  try {
    return parseArgs({
      args,
      strict: true,
      tokens: true,
      options: machineOptions,
    });
  } catch {
    throw new MachineUsageError("Unknown or malformed lazurio machine option");
  }
}

// Exported so a test can prove what the parser accepts without reaching the
// handover: runMachineCommand reads the root-issued declaration and acts on
// the declared operator's real Folder, which a test must never do (#782).
export function parseMachineArguments(args: string[]) {
  const [command, ...options] = args;
  if (
    command !== "inspect" &&
    command !== "folder-init" &&
    command !== "folder-refresh" &&
    command !== "t3-links" &&
    command !== "t3-link-pair" &&
    command !== "t3-link-settle"
  )
    throw new MachineUsageError("Unknown lazurio machine command");
  const parsed = parseMachineTokens(options);
  const { values, tokens } = parsed;
  if (
    ((command === "inspect" || command === "t3-links") &&
      tokens.length !== 0) ||
    (command === "t3-link-pair" || command === "t3-link-settle"
      ? values.source === undefined || tokens.length !== 1
      : values.source !== undefined) ||
    (command === "folder-refresh" &&
      tokens.some(
        (token) => token.kind === "option" && token.name !== "preset",
      )) ||
    tokens.some((token) => token.kind !== "option") ||
    new Set(tokens.map((token) => (token.kind === "option" ? token.name : "")))
      .size !== tokens.length
  )
    throw new MachineUsageError(
      "Explicit nonduplicate lazurio machine options required",
    );
  const value = (name: keyof typeof choices) => {
    const chosen = values[name];
    if (
      chosen !== undefined &&
      !(choices[name] as readonly string[]).includes(chosen)
    )
      throw new MachineUsageError(`Invalid lazurio machine choice: ${name}`);
    return chosen;
  };
  let preset: ReturnType<typeof parsePresetName> | undefined;
  try {
    preset =
      values.preset === undefined ? undefined : parsePresetName(values.preset);
  } catch {
    throw new MachineUsageError("Unknown workspace preset");
  }
  return {
    command,
    preset,
    locale: value("locale") as "cs" | "en" | undefined,
    detail: value("detail") as "concise" | "technical" | undefined,
    coordination: value("coordination") as "direct" | "coordinator" | undefined,
    ...(values.source === undefined ? {} : { source: values.source }),
  };
}

// `launchpad` is where folder-refresh finds the supervised Launchpad to
// restart after it recorded a different entry (launchpad-entry.ts); the CLI
// passes the installed one, and without it nothing is restarted.
export async function runMachineCommand(
  args: string[],
  launchpad?: LaunchpadSeams,
) {
  const {
    command,
    preset: requestedPreset,
    source: pairSource,
    ...values
  } = parseMachineArguments(args);
  try {
    if (command === "inspect") {
      const observed = await readMachineHandover();
      // Projected before anything is printed: inspect refuses what
      // folder-init and folder-refresh would refuse. An auth-sourced
      // handover (root decision 0216) is printed as written, whether or not
      // its receipt names a person yet; it names nobody itself.
      if (!isAuthSourced(observed.context))
        machineBinding(observed.context, observed.digest);
      return { code: 0, result: machineInspection(observed) };
    }
    if (command === "t3-links") {
      // The same look as the Launchpad's tick, as the declared operator of
      // the installed product, under the same lock (src/t3-links/).
      const operator = await readLinuxOperator();
      await requireInstalledProduct(await runningProduct(), operator.homedir);
      const report = await syncLiveT3Links(operator.homedir, operator.uid);
      const failed =
        "result" in report &&
        (report.result === "busy" || report.result === "t3-missing");
      return {
        code: failed ? 1 : 0,
        result: { kind: "t3-links" as const, ...report },
      };
    }
    if (command === "t3-link-pair" || command === "t3-link-settle") {
      const operator = await readLinuxOperator();
      await requireInstalledProduct(await runningProduct(), operator.homedir);
      if (command === "t3-link-settle") {
        const settled = await settleLiveLinkPairing(
          operator.homedir,
          operator.uid,
          pairSource as string,
        );
        const result = typeof settled === "string" ? settled : settled.result;
        return {
          code: result === "settled" || result === "pending" ? 0 : 1,
          result: { kind: "t3-link-settle" as const, result },
        };
      }
      const answer = await issueLiveLinkPairing(
        operator.homedir,
        operator.uid,
        pairSource as string,
      );
      return "kind" in answer && answer.kind === "issued"
        ? {
            code: 0,
            result: {
              kind: "t3-link-pair" as const,
              id: answer.id,
              credential: answer.credential,
            },
          }
        : {
            code: 1,
            result: {
              kind: "t3-link-pair" as const,
              reason: "reason" in answer ? answer.reason : answer.result,
            },
          };
    }
    // An auth-sourced handover resolves through its receipt, and only once
    // the receipt names a person (machine-assignment-pending before).
    const observed = await readMachineContext();
    const machine = machineBinding(observed.context, observed.digest);
    const organizationKey = ownerOrganizationKey(observed.context);
    const operator = await readLinuxOperator();
    // Only the installed product acts on this operator's Folder and home;
    // refused before the binding reads them (decision F68, #782).
    await requireInstalledProduct(await runningProduct(), operator.homedir);
    const folder = bindMachineOperator(observed.context, operator);
    const { code, result } =
      command === "folder-refresh"
        ? await refreshMachineFolderAndLaunchpad(
            folder,
            machine,
            requestedPreset,
            launchpad,
            organizationKey,
          )
        : await initializeMachineFolder(
            folder,
            machine,
            { preset: requestedPreset, ...values },
            // A free Environment's Folder is the Platform's to create, in
            // the person's home, at the assignment (root decision 0216):
            // nobody delivered its layout ahead.
            observed.authSourced,
            organizationKey,
          );
    return {
      code,
      result: {
        ...(await withEnvironmentSsh(
          result,
          machine,
          { home: operator.homedir, uid: operator.uid },
          undefined,
          { run: runTool, now: Date.now, current: liveRoutesSource() },
        )),
        machineContextDigest: observed.digest,
      },
    };
  } catch (error) {
    return machineFailureAnswer(error);
  }
}

// A Folder whose lock another Lazurio operation holds: nothing changed, and
// the same command may simply run again. `profile-update` answers the same,
// so `lazurio update` retries either refresh (decision F17's addendum of
// 2026-10-30).
export const folderBusyAnswer = Object.freeze({
  kind: "blocked" as const,
  reason: "folder-busy" as const,
  retryable: true as const,
  next: "Another Lazurio operation holds this Folder; run the same command again in a moment. Nothing was changed.",
});

// Every failure of folder-init, folder-refresh and inspect is one JSON answer
// too, because Lazurio Machines reads exactly one (issue #655). A busy Folder
// is named as retryable; anything unexpected names nothing it read, as the
// CLI's own failure text does, and says only that the operation failed.
export function machineFailureAnswer(error: unknown) {
  if (error instanceof FolderAdoptionError)
    return { code: 2, result: describeFolderAdoption(error) };
  if (error instanceof MachineContextError)
    return {
      code: 2,
      result: {
        kind: "blocked" as const,
        reason: error.code,
        next: machineContextNext(error.code),
      },
    };
  if (error instanceof FolderOperationBusyError)
    return { code: 2, result: folderBusyAnswer };
  // Buddy GEN4's folder cannot take his instructions: found before anything
  // changed (plan LZD-0033 R2).
  if (error instanceof BuddyFolderRefused)
    return {
      code: 2,
      result: {
        kind: "blocked" as const,
        reason: error.reason,
        detail: error.message,
        next: "Nothing was changed. Fix ~/Buddy as the detail says (a CLAUDE.md the person keeps elsewhere, a directory or file of this account, the handover's folder of this home) and run the same command again.",
      },
    };
  return {
    code: 1,
    result: {
      kind: "failed" as const,
      reason: "internal" as const,
      next: "The Folder operation failed and its state may require recovery; no automatic retry or cleanup was performed.",
    },
  };
}

const contextNext: Partial<Record<MachineContextError["code"], string>> = {
  "machine-not-installed-product":
    "Only the installed Lazurio changes this Environment's Folder from its handover: run the installed `lazurio machine …`. A source checkout, a test or a pull request's build never does (decision F68). Nothing was changed.",
  "machine-assignment-pending":
    "This Environment is not assigned to anyone yet. Its Folder is created in the person's home once its assignment names them; nothing was created or changed.",
  "machine-assignment-released":
    "This Environment's assignment was released; nothing is created or refreshed for anybody any more. Nothing was changed.",
};
const machineContextNext = (code: MachineContextError["code"]) =>
  contextNext[code] ??
  "Ask the operator who hosts this Remote Environment to verify the handover; do not edit the identity file or reset product trust.";

// What `machine inspect` prints: the validated handover exactly as written,
// its optional `entry` included, and its digest. Context, never authority.
export function machineInspection(
  observed: Readonly<{ context: MachineHandover; digest: string }>,
) {
  return {
    kind: "machine-context-observed" as const,
    ...observed,
    authority: "none" as const,
  };
}

export type FolderInitChoices = Readonly<{
  preset: PresetName | undefined;
  locale: "cs" | "en" | undefined;
  detail: "concise" | "technical" | undefined;
  coordination: "direct" | "coordinator" | undefined;
}>;

// folder-init after the handover and the operator are bound. The preset is
// --preset when given (within what the handover offers as a new choice: only
// the derived one when it states owner.assignment, issue #107), else the
// derived one. A handover that derives none (see machineAssignment) never gets
// a guess: an already adopted Folder keeps the preset it has, anything else
// needs --preset. On a free Environment (`assigned`, root decision 0216)
// nothing delivered the layout: it is created here, only once the preset
// is allowed, and only after every entry it builds on has passed
// (`createAssignedFolderLayout`), so a refusal writes nothing.
export async function initializeMachineFolder(
  folder: string,
  machine: MachineBinding,
  choices: FolderInitChoices,
  assigned = false,
  organizationKey: string | undefined = undefined,
) {
  const derived = derivePreset(machine);
  const allowed = selectablePresets(machine);
  const preset = choices.preset ?? derived;
  if (preset === null) {
    const adopted = await adoptedHandoverFolder(
      folder,
      machine,
      adoptionReadWaitMs,
      organizationKey,
    );
    if (adopted) return { code: 0, result: adopted };
    return {
      code: 2,
      result: {
        kind: "blocked",
        reason: "preset-ambiguous",
        allowed,
        next: "Pass --preset: this handover names a Team but no owner.assignment, so it does not say whether the Remote Environment is assigned to one user or shared; the Lazurio Machines resident role passes it from the owner infrastructure.",
      },
    };
  }
  if (!allowed.includes(preset)) {
    // Rerunning the command that adopted this Folder is no new choice: a
    // preset the handover still allows reports the adopted Folder (#107).
    if (allowedPresets(machine).includes(preset)) {
      const adopted = await adoptedHandoverFolder(
        folder,
        machine,
        adoptionReadWaitMs,
        organizationKey,
      );
      if (adopted) return { code: 0, result: adopted };
    }
    return {
      code: 2,
      result: {
        kind: "blocked",
        reason: "preset-not-allowed",
        derived,
        allowed,
        next:
          derived === null
            ? "Choose a preset the handover allows; this handover derives none."
            : "Choose a preset the handover allows, or omit --preset for the derived one.",
      },
    };
  }
  const profile = presetProfile(preset, executionOs(process.platform), {
    ...(choices.locale === undefined ? {} : { locale: choices.locale }),
    ...(choices.detail === undefined ? {} : { detail: choices.detail }),
    ...(choices.coordination === undefined
      ? {}
      : { coordination: choices.coordination }),
  });
  if (assigned)
    await createAssignedFolderLayout(
      folder,
      machine,
      workspacePreset(preset).personalspace,
    );
  const result = await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile,
    ...(organizationKey === undefined ? {} : { organizationKey }),
  });
  return { code: 0, result };
}

// folder-refresh after the handover and the operator are bound. The adoption
// check refuses another Machine's or unrecognized state by name before the
// update transaction; the planner checks the identity again under its lock.
// `preset` is the preset the handover now derives, taken with it (#107).
// `organizationKey` is the handover's `owner.organization_key`: with it the
// one correction of the identity is recorded (`bindingCorrected`). A
// rewritten handover that changes nothing else is recorded by its digest
// alone (`bindingRebound`, issue #111).
export async function refreshMachineFolder(
  folder: string,
  machine: MachineBinding,
  preset: PresetName | undefined = undefined,
  organizationKey: string | undefined = undefined,
) {
  const adopted = await adoptedHandoverFolder(
    folder,
    machine,
    adoptionReadWaitMs,
    organizationKey,
  );
  if (adopted === null)
    return {
      code: 2,
      result: {
        kind: "blocked",
        reason: "folder-not-initialized",
        next: "Run lazurio machine folder-init first; nothing was created.",
      },
    };
  const result = await refreshFolder(
    folder,
    machine,
    undefined,
    preset,
    organizationKey,
  );
  return { code: result.kind === "blocked" ? 2 : 0, result };
}

// The refresh, then the running Launchpad: it read its entry when it started,
// so a refresh that records a different entry restarts the supervised
// Launchpad of this Folder and says so in `launchpad`. An unchanged entry
// (unchanged, blocked, or a refresh of rendered text only) restarts nothing
// and adds nothing to the answer.
// A restart owed from an earlier refresh: the supervised Launchpad of this
// Folder reports an entry other than the one recorded (its restart failed,
// or an earlier refresh stopped before it). Only a Launchpad that reports its
// entry can owe one; an older release, no unit or no answer owes none.
async function restartOwed(
  folder: string,
  seams: LaunchpadSeams,
): Promise<boolean> {
  const service = await seams.service().catch(() => null);
  if (service === null || service.folder !== folder) return false;
  const running = await service.launchpadEntry?.().catch(() => null);
  if (typeof running !== "string") return false;
  const recorded = await recordedEntryDigest(folder);
  return recorded !== null && running !== recorded;
}

export async function refreshMachineFolderAndLaunchpad(
  folder: string,
  machine: MachineBinding,
  preset: PresetName | undefined,
  launchpad: LaunchpadSeams | undefined,
  organizationKey: string | undefined = undefined,
) {
  const before = launchpad === undefined ? null : await recordedEntry(folder);
  // The restart is owed ahead of the refresh, so that no failure between the
  // recorded entry and the restart (an interruption included) can lose it; a
  // refresh that owes none clears it again. A debt that cannot be recorded
  // stops the refresh before anything changes.
  const owedBefore =
    launchpad === undefined
      ? false
      : await restartOwedFor(launchpad.owed, folder);
  if (launchpad !== undefined && !owedBefore)
    try {
      await recordRestartOwed(launchpad.owed, folder, true);
    } catch {
      return {
        code: 2,
        result: {
          kind: "blocked" as const,
          reason: "launchpad-restart-unrecordable",
          next: "Nothing was changed: this install base cannot keep a restart of its Launchpad owed (its update directory). Fix that directory and run the same command again.",
        },
      };
    }
  const refreshed = await refreshMachineFolder(
    folder,
    machine,
    preset,
    organizationKey,
  );
  if (launchpad === undefined) return refreshed;
  const settled = async (owed: boolean) =>
    recordRestartOwed(launchpad.owed, folder, owed).catch(() => undefined);
  if (
    refreshed.result.kind !== "refreshed" &&
    refreshed.result.kind !== "unchanged"
  ) {
    // Blocked or failed: what was owed before stays, nothing new is.
    if (!owedBefore) await settled(false);
    return refreshed;
  }
  if (
    (await recordedEntry(folder)) === before &&
    !owedBefore &&
    !(await restartOwed(folder, launchpad))
  ) {
    await settled(false);
    return refreshed;
  }
  const restart = await restartLaunchpadForEntry(folder, launchpad);
  // Kept until a restart succeeds or finds the Launchpad unsupervised;
  // clearing it may fail, which only owes one more restart.
  if (restart !== "restart-failed") await settled(false);
  return {
    code: refreshed.code,
    result: {
      ...refreshed.result,
      launchpad: restart,
    },
  };
}

// When the Folder records exactly this handover's binding (folder-init that
// initialized it, folder-refresh that recorded it or found it the same), the
// person's SSH config follows the routes of this Environment, and the answer
// says how. "already-adopted" may record an older handover until the
// refresh that follows it, and a blocked operation wrote nothing: neither
// writes here. Neither a refusal nor a failure of this step changes the exit
// code: the Folder is what it is, and the files are the person's to fix.
//
// - Where the handover declares the home access service (root decision
//   0224, `accessServiceOf`), on any Machine: one synchronization with it
//   (`syncEnvironmentRoutes`: the source key, its registration, the
//   targets) and a try of each route it wrote (`testRoutes`),
//   reported as `environmentRoutes`.
// - Otherwise the binding's own routes, exactly (decision F70, amendment of
//   2026-11-03, point 6): a personal Machine's assigned peers (root decision
//   0192, addendum of 2026-10-26), and on any other Machine none, so the
//   routes of a service whose declaration was removed go at once. Reported
//   as `environmentSsh`; on a Machine other than a personal one only when
//   there was something to remove or say.
//
// Either writes only under the routes lock and only while the live handover
// still declares what this binding declares (`commitRoutes`, point 5): a
// handover rewritten meanwhile is `superseded`, and its own refresh or the
// Launchpad's next tick writes its routes.
const recordsThisBinding: ReadonlySet<string> = new Set([
  "initialized",
  "refreshed",
  "unchanged",
]);
const supersededText =
  "The handover changed while this Environment's routes were being written; nothing was written, and the next refresh or the Launchpad's next minute writes the current ones.";
export async function withEnvironmentSsh<
  Result extends Readonly<{ kind: string }>,
>(
  result: Result,
  machine: MachineBinding,
  location: EnvironmentSshLocation,
  service: AccessServiceLocation | null = accessServiceOf(machine),
  seams: RoutesSeams,
) {
  if (!recordsThisBinding.has(result.kind)) return result;
  if (service !== null) {
    // Onboarding and every refresh try each route once it is written.
    const environmentRoutes = await syncEnvironmentRoutes(
      location,
      service,
      seams,
      true,
    );
    if (environmentRoutes.ssh.kind === "superseded")
      console.error(supersededText);
    else if (environmentRoutes.targets !== "answered")
      console.error(
        `The access service did not give this Environment its routes (${environmentRoutes.targets}); no route was added, and the recorded ones end at their deadline.`,
      );
    return { ...result, environmentRoutes };
  }
  const personal = machine.kind === "personal-vm";
  // The binding's own routes (a personal Machine's assigned peers, none on
  // any other), written only while the live handover declares exactly these
  // (`RoutesSource`, point 5).
  const own = assignedEnvironments(machine);
  const environmentSsh: RoutesWrite = await commitRoutes(
    location,
    own,
    seams.current,
    () => writeEnvironmentRoutes(location, own),
  );
  if (!personal && environmentSsh.kind === "none") return result;
  const routes = personal
    ? "The SSH config for the assigned Work Environments"
    : "The SSH config of this Environment's routes";
  if (environmentSsh.kind === "blocked")
    console.error(
      `${routes} was not written: ${environmentSsh.path} is ${environmentSsh.reason === "file-foreign" ? "not Lazurio's file" : "not a plain file or directory of this account"}. Nothing was changed; move it away and refresh again.`,
    );
  else if (environmentSsh.kind === "failed")
    console.error(
      `${routes} could not be written; the Folder itself is unaffected.`,
    );
  else if (environmentSsh.kind === "superseded") console.error(supersededText);
  return { ...result, environmentSsh };
}

// The refusal names the entry; the operator decides what to do with it.
export function describeFolderAdoption(error: FolderAdoptionError) {
  const next = {
    "foreign-entry":
      "Move this entry out of the Folder; only organizations/, personalspace/, the two legacy launchpad files and what Lazurio generated may be present.",
    "layout-missing":
      "Ask the operator who hosts this Remote Environment to deliver the standard Folder layout; nothing is created in its place.",
    "personalspace-conflict":
      "An Organization preset never has a Personalspace; move it away yourself, nothing is deleted.",
    "state-unrecognized":
      "Complete a recognized initialization with folder-resume or diagnose the state; nothing is reset.",
    "binding-changed":
      "The Folder was adopted from a different handover; verify the identity of this Remote Environment with the operator who hosts it.",
    "directory-shared":
      "chmod g-w,o-w this path under the Lazurio Folder (Ubuntu's default umask 0002 makes new directories group-writable); nothing was changed.",
  } as const;
  return {
    kind: "blocked" as const,
    reason: `folder-${error.code}` as const,
    entry: error.entry,
    next: next[error.code],
  };
}
