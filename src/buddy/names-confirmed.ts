// Whether the person's confirmation of Buddy's names counts for his meeting
// and his gate (decision F60's addenda of 2026-10-26 and 2026-11-09). Buddy
// GEN4 (plan LZD-0033, R3) has the names only once `~/Buddy` holds them: a
// confirmed persona still owed there (`pending`) keeps the meeting and the
// gate open, also after a restart, so a refused write never opens him with
// the names he had before. Buddy GEN3 counts the confirmation itself. Pure,
// and the page's as well as the server's.

/** The confirmation that counts, for a persona as the Launchpad shows it. */
export function namesConfirmed(
  persona: Readonly<{ confirmed: boolean; pending: boolean }> | null,
  folderBuddy: boolean,
): boolean {
  if (persona?.confirmed !== true) return false;
  return !folderBuddy || !persona.pending;
}
