// The sign by Buddy GEN4's avatar (plan LZD-0033, the sign) as the shell
// carries it: the Launchpad's document and stream (`buddy.signal`), the
// bubble's badge and the browser's notice. Pure, for the server and the
// page alike. T3 Code computes it from Buddy's thread (Lazurio/t3code#232);
// `unavailable` is every reading that could not be made, never quiet.

import type { ShellBuddySignal, ShellBuddySignalState } from "./contract";

/** Where the Launchpad streams the sign, on every origin of the shell. */
export const buddySignalPath = "/.lazurio/buddy/signal";

export type BuddySignalState = ShellBuddySignalState;
export type BuddySignal = ShellBuddySignal;

export const unavailableSignal: BuddySignal = Object.freeze({
  state: "unavailable",
  since: null,
  request: null,
  startedBy: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A sign as the shell document and the stream carry it, in exactly the
 * shape of its state (no version: the shell document's schema versions it):
 * - `waiting`: since when, what he waits for (`question` or `approval`),
 *   and who started the turn, or null;
 * - `failed`: since when, no request, who started the turn, or null;
 * - `answered`: since when, no request, `person` or `other`;
 * - `quiet` and `unavailable`: nothing more, every member null.
 * Null for anything else, a member missing included. */
export function parseBuddySignal(value: unknown): BuddySignal | null {
  if (!isRecord(value)) return null;
  const { state, since, request, startedBy } = value;
  if (!("since" in value) || !("request" in value) || !("startedBy" in value))
    return null;
  const instant = typeof since === "string" && !Number.isNaN(Date.parse(since));
  const starter = startedBy === "person" || startedBy === "other";
  switch (state) {
    case "quiet":
    case "unavailable":
      return since === null && request === null && startedBy === null
        ? state === "unavailable"
          ? unavailableSignal
          : Object.freeze({ state, since, request, startedBy })
        : null;
    case "waiting": {
      const kind = isRecord(request) ? request.kind : undefined;
      if (!instant || (kind !== "question" && kind !== "approval")) return null;
      if (!(starter || startedBy === null)) return null;
      return Object.freeze({
        state,
        since,
        request: Object.freeze({ kind }),
        startedBy,
      });
    }
    case "failed":
      return instant && request === null && (starter || startedBy === null)
        ? Object.freeze({ state, since, request, startedBy })
        : null;
    case "answered":
      return instant && request === null && starter
        ? Object.freeze({ state, since, request, startedBy })
        : null;
    default:
      return null;
  }
}
