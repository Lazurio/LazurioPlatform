import { type BrainState, readBrainState } from "./keys";
import { brainPin } from "./pin";
import { type BrainRoom, brainRoom, type FreeBytes, roomShort } from "./room";
import { interimPresent, interimRelease } from "./takeover";

// What would stop the takeover of the interim installer's brain, or the move
// to the pin right after it, told before its owner consents (plan LZD-0033
// R11a). Read only: Lazurio's own state, the release the interim installer
// recorded, the server's version, the sizes of the brain's files (never
// their content) and the room on the disk. Each blocker is a branch of setup
// that ends in a refusal, a held or stopped move, or a report only, before
// the brain is touched, except the four records of an earlier step
// (`earlierStepBlockers`): setup deals with them first, in any run, which may
// stop the server, put a copy back or finish that step, and a consented run
// may then take the brain over, so a person looks at them first:
//   waits-machines      no handover mark: setup only reports
//   restore-failed      an earlier takeover's way back did not complete
//   move-stopped        an earlier move stopped for a person
//   move-unfinished     an earlier move a run left half way (finished first)
//   vault-unfinished    a rebuild on the vault left half way or not put back
//   meaning-unfinished  a switch to search by meaning left half way
//   held                a move to this pin was given up before: the takeover
//                       goes through, the move does not (not retried)
//   release-unknown     the interim installer's release is not known for sure
//   not-running         the server does not answer its version
//   other-version       the server answers another version than that release
//   command-missing     the interim command the units name is not there, so
//                       the way back would have nothing to start
//   disk                less room than the copies, the pin and the model need
//                       (`./room.ts`), or room that cannot be told
// It cannot tell: another run holding setup's lock (`busy`), a write that
// fails on the day (`copy`, `journal`), Buddy busy (the move then waits),
// and whether the pin answers with the same page count and working keys
// after the move (otherwise the copy comes back: `held`).

export type TakeoverBlocker =
  | "waits-machines"
  | "restore-failed"
  | "move-stopped"
  | "move-unfinished"
  | "vault-unfinished"
  | "meaning-unfinished"
  | "held"
  | "release-unknown"
  | "not-running"
  | "other-version"
  | "command-missing"
  | "disk";

/** The blockers that stop only the move after the takeover: the takeover
 * itself goes through (and rewrites the units), the brain stays on its
 * release under Lazurio's units. Every other blocker refuses the takeover,
 * or leaves it waiting, before anything changes. */
export const moveBlockers: readonly TakeoverBlocker[] = Object.freeze(["held"]);

/** The blockers setup meets before it deals with any earlier step: no
 * handover mark (`waits-machines`, before anything else) and a takeover's
 * way back that did not complete (`restore-failed`, first of the
 * recovery). With either, a run changes nothing, whatever else is there. */
export const stopFirstBlockers: readonly TakeoverBlocker[] = Object.freeze([
  "waits-machines",
  "restore-failed",
]);

/** The records of an earlier step that setup deals with before any
 * takeover, in the same run: it may stop the server, put a copy back or
 * finish that step (`stopped:…` keeps the server down), and then take the
 * brain over in that run. Not a refusal: things change. */
export const earlierStepBlockers: readonly TakeoverBlocker[] = Object.freeze([
  "move-stopped",
  "move-unfinished",
  "vault-unfinished",
  "meaning-unfinished",
]);

export type TakeoverCheck = Readonly<{
  /** The release a takeover would record, or null (`release-unknown`). */
  release: Readonly<{ commit: string; version: string }> | null;
  /** Empty where nothing known now stops the takeover and the move. */
  blockers: readonly TakeoverBlocker[];
  room: BrainRoom;
}>;

function unfinished(state: BrainState): TakeoverBlocker[] {
  const found: TakeoverBlocker[] = [];
  if (state.takeover?.state?.startsWith("restore-failed-"))
    found.push("restore-failed");
  const move = state.move?.result;
  if (move?.startsWith("stopped:")) found.push("move-stopped");
  if (move === "moving") found.push("move-unfinished");
  if (state.move?.to === brainPin.commit && move === "held") found.push("held");
  const rebuild = state.vault?.rebuild?.state;
  if (
    rebuild !== undefined &&
    (rebuild.startsWith("restore-failed-") ||
      ["stopping", "moving", "started"].includes(rebuild))
  )
    found.push("vault-unfinished");
  const attempt = state.meaningAttempt?.result;
  if (attempt === "stopping" || attempt === "started")
    found.push("meaning-unfinished");
  return found;
}

/** The check of an interim installer's brain before its takeover. */
export async function takeoverCheck(
  paths: Parameters<typeof interimRelease>[0],
  seen: Readonly<{
    handover: boolean;
    running: string | null;
    freeBytes?: FreeBytes;
  }>,
): Promise<TakeoverCheck> {
  const blockers: TakeoverBlocker[] = [];
  if (!seen.handover) blockers.push("waits-machines");
  blockers.push(...unfinished(await readBrainState(paths)));
  const release = await interimRelease(paths);
  if (release === null) blockers.push("release-unknown");
  if (seen.running === null) blockers.push("not-running");
  else if (release !== null && seen.running !== release.version)
    blockers.push("other-version");
  if (!(await interimPresent(paths))) blockers.push("command-missing");
  const room = await brainRoom(paths, seen.freeBytes);
  if (roomShort(room)) blockers.push("disk");
  return Object.freeze({
    release,
    blockers: Object.freeze(blockers),
    room,
  });
}
