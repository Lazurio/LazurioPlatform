// How long an Owner answer stands, and the page's copy of the answers
// (decision F36 addendum of 2026-10-04). The Launchpad keeps GitHub's answer
// this long per login (organization-owner.ts); the page asks again once its
// own copy is this old (waking itself at that moment), when the bound login
// changes, and after a catalog read. Pure, shared by the server and the page.
export const ownerAnswerMs = 5 * 60_000;

type Answer = Readonly<{
  owner: boolean;
  until: number;
  /** The question being asked now, or null: only its answer settles. */
  asking: number | null;
}>;

export function createOwnerAnswers(now: () => number = Date.now) {
  const answers = new Map<string, Answer>();
  let questions = 0;
  const key = (organization: string, login: string) =>
    `${organization}\n${login.toLowerCase()}`;
  return {
    /** What to show now for an Organization bound to a login, and, when the
     * Launchpad must be asked, the question to settle (the last answer
     * stands meanwhile, and nothing is asked twice at once). */
    read(
      organization: string,
      login: string,
    ): Readonly<{ owner: boolean; ask: number | null }> {
      const known = answers.get(key(organization, login));
      if (known !== undefined && (known.asking !== null || known.until > now()))
        return { owner: known.owner, ask: null };
      questions += 1;
      answers.set(key(organization, login), {
        owner: known?.owner ?? false,
        until: 0,
        asking: questions,
      });
      return { owner: known?.owner ?? false, ask: questions };
    },
    /** GitHub's answer to one question, as the Launchpad gave it (false on
     * any failure); an answer to a question no longer asked (forgotten by a
     * catalog read, or overtaken) changes nothing. */
    settle(
      organization: string,
      login: string,
      question: number,
      owner: boolean,
    ) {
      const known = answers.get(key(organization, login));
      if (known === undefined || known.asking !== question) return;
      answers.set(key(organization, login), {
        owner,
        until: now() + ownerAnswerMs,
        asking: null,
      });
    },
    /** When the earliest settled answer expires, or null: the page wakes
     * then and asks again. */
    nextExpiry(): number | null {
      let next: number | null = null;
      for (const answer of answers.values())
        if (answer.asking === null && (next === null || answer.until < next))
          next = answer.until;
      return next;
    },
    /** Forgets every answer and every question still out: the next read
     * asks again. */
    clear() {
      answers.clear();
    },
  };
}
