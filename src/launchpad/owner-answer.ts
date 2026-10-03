// How long an Owner answer stands, and the page's copy of the answers
// (decision F36 addendum of 2026-10-04). The Launchpad keeps GitHub's answer
// this long per login (organization-owner.ts); the page asks again once its
// own copy is this old, when the bound login changes, and after a catalog
// read. Pure, shared by the server and the page.
export const ownerAnswerMs = 5 * 60_000;

type Answer = Readonly<{ owner: boolean; until: number; reading: boolean }>;

export function createOwnerAnswers(now: () => number = Date.now) {
  const answers = new Map<string, Answer>();
  const key = (organization: string, login: string) =>
    `${organization}\n${login.toLowerCase()}`;
  return {
    /** What to show now for an Organization bound to a login, and whether
     * to ask the Launchpad (then marked as being asked: the last answer
     * stands meanwhile, and nothing is asked twice at once). */
    read(
      organization: string,
      login: string,
    ): Readonly<{ owner: boolean; ask: boolean }> {
      const known = answers.get(key(organization, login));
      if (known !== undefined && (known.reading || known.until > now()))
        return { owner: known.owner, ask: false };
      answers.set(key(organization, login), {
        owner: known?.owner ?? false,
        until: 0,
        reading: true,
      });
      return { owner: known?.owner ?? false, ask: true };
    },
    /** GitHub's answer, as the Launchpad gave it (false on any failure). */
    settle(organization: string, login: string, owner: boolean) {
      answers.set(key(organization, login), {
        owner,
        until: now() + ownerAnswerMs,
        reading: false,
      });
    },
    /** Forgets every answer: the next read asks again. */
    clear() {
      answers.clear();
    },
  };
}
