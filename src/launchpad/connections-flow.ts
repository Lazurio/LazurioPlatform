import type { ConnectionsOverview, PairedDevice } from "../connections/pairing";
import {
  parseConnectionsOverview,
  parsePairing,
  parsePoll,
  refusalOf,
} from "./connections-view";

type Answer = Promise<{ value: unknown; ok: boolean }>;

// Spárovat telefon's dialog without the DOM (decision F71): the code shown,
// the poll and the end, so that the sequence is tested without a browser.
// Each open of the dialog is an attempt; closing it, or starting again, ends
// the attempt, and an answer that arrives for an ended attempt is dropped:
// a late code never fills a closed dialog and no poll starts for it. The
// code itself stays valid at ChatGPT until it expires or a phone takes it
// (Codex cannot end it), so the server answers it again at the next open.

export type PairingView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "code";
      manualCode: string | null;
      qrSource: string;
      expiresAt: number;
    }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "paired"; devices: readonly PairedDevice[] }>
  | Readonly<{
      kind: "refused";
      tooMany: boolean;
      overview: ConnectionsOverview | null;
    }>;

export function createPairingFlow(
  options: Readonly<{
    post: (path: string, body: unknown) => Answer;
    show: (view: PairingView) => void;
    /** Repeats `step` every `ms` while the page is shown; answers the stop. */
    poll: (step: () => Promise<void>, ms: number) => () => void;
    now?: () => number;
  }>,
) {
  const now = options.now ?? Date.now;
  let attempt = 0;
  let session: string | null = null;
  let expiresAt = 0;
  let stopPoll: (() => void) | null = null;

  function stop() {
    stopPoll?.();
    stopPoll = null;
    session = null;
  }

  function expire() {
    stop();
    options.show({ kind: "expired" });
  }

  async function step(mine: number, current: string) {
    if (mine !== attempt || session !== current) return;
    if (now() >= expiresAt) {
      expire();
      return;
    }
    let answer: Awaited<Answer>;
    try {
      answer = await options.post("/api/connections/pair/poll", {
        session: current,
      });
    } catch {
      return;
    }
    if (mine !== attempt || session !== current) return;
    const result = answer.ok ? parsePoll(answer.value) : null;
    if (result === null) return;
    if (result.kind === "waiting") {
      expiresAt = result.expiresAt;
      return;
    }
    if (result.kind === "paired") {
      stop();
      options.show({ kind: "paired", devices: result.devices });
      return;
    }
    expire();
  }

  async function start() {
    const mine = ++attempt;
    stop();
    options.show({ kind: "loading" });
    let answer: Awaited<Answer>;
    try {
      answer = await options.post("/api/connections/pair", {});
    } catch {
      if (mine === attempt)
        options.show({ kind: "refused", tooMany: false, overview: null });
      return;
    }
    // Closed or started again while the server answered.
    if (mine !== attempt) return;
    const started = answer.ok ? parsePairing(answer.value) : null;
    if (started === null) {
      const value = answer.value as { overview?: unknown } | null;
      options.show({
        kind: "refused",
        tooMany: refusalOf(answer.value) === "too-many-starts",
        overview: parseConnectionsOverview(value?.overview),
      });
      return;
    }
    session = started.session;
    expiresAt = started.expiresAt;
    options.show({
      kind: "code",
      manualCode: started.manualCode,
      qrSource: started.qrSource,
      expiresAt,
    });
    const current = started.session;
    stopPoll = options.poll(() => step(mine, current), 2_000);
  }

  return Object.freeze({
    start,
    /** The dialog closed: nothing of this attempt reaches the page again. */
    close() {
      attempt += 1;
      stop();
    },
    /** When the code shown ends; 0 when none is shown. */
    expiresAt: () => (session === null ? 0 : expiresAt),
    /** The countdown reached zero. */
    tick() {
      if (session !== null && now() >= expiresAt) expire();
    },
  });
}
