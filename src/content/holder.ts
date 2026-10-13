import type {
  PersonalspaceHolder,
  PersonalspaceHolderRead,
} from "../organizations/personalspace";
import { type ContentHost, processGitHubHost } from "./host";
import {
  holderOfCheckout,
  type PersonalspaceLayout,
  personalspaceLayout,
} from "./status";

// Whose Personalspace this Environment holds, remembered
// (Lazurio/LazurioPlatform#186, decided by Matěj on 2026-10-05): the decision
// of `personalspaceHolder`, kept about a minute as the setup probe keeps gh's
// sign-in, so that the catalog, read on every page and by every operation on
// a Personalspace module, does not ask GitHub each time. It is memory of this
// process only: nothing is stored, and a restart decides again. The layout
// (`personalspace/` and its one directory) is read on every call, so a new,
// removed or second directory is seen at once; GitHub's answer and the
// checkout's origin are kept for the same checkout only.

/** How long a decision is reused: the setup probe's minute. */
export const personalspaceHolderTtlMs = 60_000;

// How often a decision that a forget overtook while it was made is made
// again before it is answered as not verified.
const decideAttempts = 3;

type Owner = Extract<PersonalspaceLayout, { kind: "owner" }>;

const unverified: PersonalspaceHolder = Object.freeze({
  kind: "blocked",
  reason: "personalspace-unverified",
  login: null,
});
const unavailable: PersonalspaceHolder = Object.freeze({
  kind: "blocked",
  reason: "personalspace-unavailable",
  login: null,
});

// The checkout a decision is kept for: its directory and identity, and the
// Owner a personal Remote Environment's handover names.
const keyOf = (layout: Owner) =>
  [
    layout.directory,
    layout.identity,
    layout.scope.allowed && layout.scope.personalOwner !== null
      ? String(layout.scope.personalOwner.githubId)
      : "",
  ].join("\0");

/** The holder decision of one process over `host` (this Environment's gh and
 * git, composed on first use). The Launchpad keeps one for its life and
 * gives `decide` to `GET /api/content` and the module lifecycle, `peek` to
 * the page's catalog; a CLI command makes one for its own reads. */
export function createPersonalspaceHolder(
  host: () => Pick<ContentHost, "git" | "github">,
  options: Readonly<{ ttlMs?: number; now?: () => number }> = {},
) {
  const ttl = options.ttlMs ?? personalspaceHolderTtlMs;
  const now = options.now ?? Date.now;
  // By Folder: the last decision made, and the one being made.
  const known = new Map<
    string,
    Readonly<{ key: string; holder: PersonalspaceHolder; at: number }>
  >();
  const asking = new Map<
    string,
    Readonly<{
      key: string;
      generation: number;
      done: Promise<PersonalspaceHolder>;
    }>
  >();
  // A forget makes every decision being made then stale: it is neither kept
  // nor answered by `decide` (the review of #382: a request that overlaps a
  // sign-out through the Launchpad must not act on the answer GitHub gave
  // before it). `known` holds only decisions made wholly after the last
  // forget, so `peek` never shows a stale one either.
  let generation = 0;

  function ask(folder: string, layout: Owner): Promise<PersonalspaceHolder> {
    const key = keyOf(layout);
    const running = asking.get(folder);
    if (running?.key === key && running.generation === generation)
      return running.done;
    const asked = generation;
    const done: Promise<PersonalspaceHolder> = Promise.resolve()
      .then(() => holderOfCheckout(layout.directory, layout.scope, host()))
      .then(
        (holder) => {
          if (asked === generation)
            known.set(folder, Object.freeze({ key, holder, at: now() }));
          return holder;
        },
        // A decision that could not be made at all is not remembered.
        () => unavailable,
      )
      .finally(() => {
        if (asking.get(folder)?.done === done) asking.delete(folder);
      });
    asking.set(folder, Object.freeze({ key, generation: asked, done }));
    return done;
  }

  // The decision made last for this checkout, whatever its age.
  const remembered = (folder: string, layout: Owner) => {
    const entry = known.get(folder);
    return entry?.key === keyOf(layout) ? entry : undefined;
  };

  // One decision: one made within the TTL for the same checkout, otherwise
  // one made now (a question of this generation already running is joined).
  async function decideOnce(folder: string): Promise<PersonalspaceHolder> {
    const layout = await personalspaceLayout(folder);
    if (layout.kind === "decided") return layout.holder;
    const entry = remembered(folder, layout);
    if (entry !== undefined && now() - entry.at < ttl) return entry.holder;
    return ask(folder, layout);
  }

  return Object.freeze({
    /** The decision, reusing one made within the TTL for the same checkout,
     * otherwise made now (a question already running is joined). For what
     * acts on the Personalspace or reports it as it is: `GET /api/content`,
     * the module lifecycle, the CLI. A decision that a forget overtook while
     * it was made is never answered: it is made again with what is current
     * then, and one overtaken again and again is not verified. */
    async decide(folder: string): Promise<PersonalspaceHolder> {
      for (let attempt = 0; attempt < decideAttempts; attempt += 1) {
        const started = generation;
        const decided = await decideOnce(folder);
        if (started === generation) return decided;
      }
      return unverified;
    },
    /** The decision at once, never waiting for GitHub: for what a page
     * shows first (the catalog of `POST /api/catalog` and of the boot
     * document). The last decision made for the same checkout, whatever its
     * age; made again in the background when it is older than the TTL or
     * GitHub did not answer; `personalspace-unverified` until the first one
     * is made. A tile drawn from it cannot be operated into a wrong state:
     * every operation decides again. */
    async peek(folder: string): Promise<PersonalspaceHolder> {
      const layout = await personalspaceLayout(folder);
      if (layout.kind === "decided") return layout.holder;
      const entry = remembered(folder, layout);
      if (
        entry === undefined ||
        now() - entry.at >= ttl ||
        (entry.holder.kind === "blocked" &&
          entry.holder.reason === "github-unavailable")
      )
        void ask(folder, layout);
      return entry?.holder ?? unverified;
    },
    /** gh's account or the content changed (a sign-in or sign-out through
     * the Launchpad, a Tools reading that says so, an installation): decide
     * again next time. */
    forget() {
      generation += 1;
      known.clear();
    },
    /** Resolves when the decisions being made now have ended, stale ones
     * included; it answers no decision. */
    async settled(): Promise<void> {
      await Promise.all([...asking.values()].map((entry) => entry.done));
    },
  });
}

/** The decision of one command of this process (`lazurio module …`,
 * `lazurio module list`): this account's gh and git from `env`, remembered
 * for the command's own reads. */
export function processPersonalspaceHolder(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): PersonalspaceHolderRead {
  return createPersonalspaceHolder(() => processGitHubHost({ env, platform }))
    .decide;
}
