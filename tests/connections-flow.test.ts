import { expect, test } from "bun:test";
import {
  createPairingFlow,
  type PairingView,
} from "../src/launchpad/connections-flow";
import { qrMatrix, qrSvg } from "../src/tools/qr";

// Spárovat telefon's dialog (decision F71): a code that arrives after the
// dialog closed never fills it and starts no poll; a newer open wins over an
// older answer; expiry and pairing end the poll.

const session = "0123456789abcdef0123456789abcdef";
const later = Date.now() + 600_000;
const pairing = {
  kind: "pairing",
  session,
  manualCode: "ABCD-EFGH",
  expiresAt: later,
  qrSvg: qrSvg(qrMatrix("https://chatgpt.com/codex/pair?pairing_code=x")),
};

function harness() {
  const views: PairingView[] = [];
  const requests: string[] = [];
  const answers: Array<(value: unknown) => void> = [];
  const polls: Array<{ step: () => Promise<void>; stopped: boolean }> = [];
  let clock = Date.now();
  const flow = createPairingFlow({
    post: (path) => {
      requests.push(path);
      return new Promise((resolve) => {
        answers.push((value) => resolve({ value, ok: true }));
      });
    },
    show: (view) => views.push(view),
    poll: (step) => {
      const entry = { step, stopped: false };
      polls.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
    now: () => clock,
  });
  return {
    flow,
    views,
    requests,
    polls,
    answer: (value: unknown) =>
      (answers.shift() as (v: unknown) => void)(value),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a code answered after the dialog closed is dropped and polls nothing", async () => {
  const h = harness();
  const started = h.flow.start();
  expect(h.views).toEqual([{ kind: "loading" }]);
  h.flow.close();
  h.answer(pairing);
  await started;
  expect(h.views).toEqual([{ kind: "loading" }]);
  expect(h.polls.length).toBe(0);
  expect(h.flow.expiresAt()).toBe(0);
});

test("a newer open wins over the older answer", async () => {
  const h = harness();
  const first = h.flow.start();
  const second = h.flow.start();
  h.answer(pairing);
  await first;
  expect(h.polls.length).toBe(0);
  h.answer(pairing);
  await second;
  expect(h.views.at(-1)).toMatchObject({
    kind: "code",
    manualCode: "ABCD-EFGH",
  });
  expect(h.polls.length).toBe(1);
});

test("the code shown, waiting, paired; closing stops the poll", async () => {
  const h = harness();
  const started = h.flow.start();
  h.answer(pairing);
  await started;
  expect(h.views.at(-1)).toMatchObject({ kind: "code", expiresAt: later });
  const poll = h.polls[0] as { step: () => Promise<void>; stopped: boolean };
  const waiting = poll.step();
  h.answer({ kind: "waiting", expiresAt: later });
  await waiting;
  expect(h.views.at(-1)?.kind).toBe("code");
  const paired = poll.step();
  h.answer({ kind: "paired", devices: [] });
  await paired;
  expect(h.views.at(-1)).toEqual({ kind: "paired", devices: [] });
  expect(poll.stopped).toBe(true);

  const again = harness();
  const open = again.flow.start();
  again.answer(pairing);
  await open;
  const step = again.polls[0] as {
    step: () => Promise<void>;
    stopped: boolean;
  };
  // A poll answered after the dialog closed changes nothing.
  const late = step.step();
  again.flow.close();
  expect(step.stopped).toBe(true);
  again.answer({ kind: "paired", devices: [] });
  await late;
  expect(again.views.at(-1)?.kind).toBe("code");
});

test("expiry ends the code; a refusal says why", async () => {
  const h = harness();
  const started = h.flow.start();
  h.answer(pairing);
  await started;
  h.advance(600_001);
  h.flow.tick();
  expect(h.views.at(-1)).toEqual({ kind: "expired" });
  expect((h.polls[0] as { stopped: boolean }).stopped).toBe(true);
  const refused = h.flow.start();
  h.answer({ kind: "blocked", reason: "too-many-starts" });
  await refused;
  expect(h.views.at(-1)).toEqual({
    kind: "refused",
    tooMany: true,
    until: null,
    overview: null,
  });
  const outstanding = h.flow.start();
  h.answer({ kind: "blocked", reason: "code-outstanding", until: later });
  await outstanding;
  expect(h.views.at(-1)).toEqual({
    kind: "refused",
    tooMany: false,
    until: later,
    overview: null,
  });
  expect(h.requests.filter((path) => path.endsWith("/cancel"))).toEqual([]);
});
