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

const states = new Set<BuddySignalState>([
  "waiting",
  "failed",
  "answered",
  "quiet",
  "unavailable",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A sign as the shell document and the stream carry it (no version: the
 * shell document's schema versions it); null for anything else. */
export function parseBuddySignal(value: unknown): BuddySignal | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (typeof state !== "string" || !states.has(state as BuddySignalState))
    return null;
  if (state === "unavailable") return unavailableSignal;
  const since =
    typeof value.since === "string" && !Number.isNaN(Date.parse(value.since))
      ? value.since
      : null;
  const kind = isRecord(value.request) ? value.request.kind : undefined;
  const request =
    state === "waiting" && (kind === "question" || kind === "approval")
      ? Object.freeze({ kind })
      : null;
  const startedBy =
    value.startedBy === "person" || value.startedBy === "other"
      ? value.startedBy
      : null;
  return Object.freeze({
    state: state as BuddySignalState,
    since,
    request,
    startedBy,
  });
}
