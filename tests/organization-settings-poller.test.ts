import { expect, test } from "bun:test";
import type {
  DeliveredSettings,
  SettingsItem,
  SettingsReport,
} from "../src/organization-settings/contract";
import {
  type ApplyOutcome,
  createSettingsPoller,
  type SettingsPoller,
  type SettingsSourceAdapter,
  type SourceRead,
} from "../src/organization-settings/poller";
import type { ReportSent } from "../src/organization-settings/relay";
import {
  type AppliedState,
  memoryStateStore,
  type SettingsStateStore,
} from "../src/organization-settings/state";
import { commit } from "./fixtures/fake-relay";

// Decision F45, root decision 0194 points 3 to 5: while the Launchpad runs it
// asks for its Organization's settings every two minutes, at once when its
// page opens or a person asks again (never more than once in a short while),
// applies a new version and reports it, reports at least every ten minutes,
// and without an answer stays on the last applied version.

const start = Date.parse("2026-10-09T20:00:00.000Z");
const v1 = commit("1");
const v2 = commit("2");
const key = "integrations.composio.allowed";
const off = { integrations: { composio: { allowed: false } } } as const;
const on = { integrations: { composio: { allowed: true } } } as const;

function fakeClock() {
  let now = start;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => new Date(now),
    elapsed: () => now - start,
    setTimeout: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number);
    },
    pending: () => timers.size,
    /** Moves time on, running every timer that comes due, in order. */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
  };
}

const settings = (
  version: string,
  values: DeliveredSettings["values"],
  unsupported: string[] = [],
): SourceRead => ({
  kind: "settings",
  settings: {
    organization: { githubOrgId: 123, login: "Example" },
    version,
    values,
    unsupported,
  },
});

/** A source that answers from a script; the last answer repeats. */
function scriptedSource(
  answers: SourceRead[],
  reports: ReportSent[] = [{ kind: "accepted" }],
  kind: "dashboard" | "repository" = "dashboard",
) {
  const asked: (string | null)[] = [];
  const sent: SettingsReport[] = [];
  let reportIndex = 0;
  const adapter: SettingsSourceAdapter = {
    kind,
    async read(known) {
      asked.push(known);
      const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
      if (answer === undefined) throw new Error("No scripted answer");
      if (answer.kind === "not-modified" && known === null)
        throw new Error("Not modified needs a version");
      return answer;
    },
    ...(kind === "dashboard"
      ? {
          async report(report: SettingsReport) {
            sent.push(report);
            const answer =
              reports[Math.min(reportIndex, reports.length - 1)] ??
              ({ kind: "accepted" } as const);
            reportIndex += 1;
            return answer;
          },
        }
      : {}),
  };
  return { adapter, asked, sent };
}

function applying(outcomes: ((values: unknown) => ApplyOutcome)[] = []) {
  const calls: unknown[] = [];
  return {
    calls,
    apply: async (_folder: string, delivered: { values: unknown }) => {
      calls.push(delivered.values);
      const outcome = outcomes[calls.length - 1];
      return (
        outcome?.(delivered.values) ?? {
          items: [{ key, outcome: "applied", detail: null } as SettingsItem],
          changed: true,
        }
      );
    },
  };
}

function poller(
  source: SettingsSourceAdapter,
  apply: ReturnType<typeof applying>["apply"],
  clock: ReturnType<typeof fakeClock>,
  store: SettingsStateStore = memoryStateStore(),
  extra: Partial<Parameters<typeof createSettingsPoller>[0]> = {},
): SettingsPoller {
  return createSettingsPoller({
    folder: "/example/Lazurio",
    source,
    store,
    apply,
    platformVersion: "0.1.9",
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    journal: () => {},
    ...extra,
  });
}

async function tick(
  clock: ReturnType<typeof fakeClock>,
  settings: SettingsPoller,
  ms: number,
) {
  clock.advance(ms);
  await settings.idle();
}

test("the first question goes out at start and applies the version at once, then every two minutes", async () => {
  const clock = fakeClock();
  const source = scriptedSource([
    settings(v1, off),
    { kind: "not-modified", version: v1 },
  ]);
  const applied = applying();
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  expect(source.asked).toEqual([null]);
  expect(applied.calls).toEqual([off]);
  expect(settingsPoller.status()).toEqual({
    source: "dashboard",
    version: v1,
    appliedAt: "2026-10-09T20:00:01.000Z",
    checkedAt: "2026-10-09T20:00:01.000Z",
    error: null,
    unapplied: [],
  });
  // Reported right after it applied.
  expect(source.sent).toEqual([
    {
      version: v1,
      appliedAt: "2026-10-09T20:00:01.000Z",
      lastError: null,
      items: [{ key, outcome: "applied", detail: null }],
      platformVersion: "0.1.9",
    },
  ]);
  await tick(clock, settingsPoller, 119_000);
  expect(source.asked).toEqual([null]);
  await tick(clock, settingsPoller, 1_000);
  // Asked with the version it applied; not modified, nothing applied again.
  expect(source.asked).toEqual([null, v1]);
  expect(applied.calls).toEqual([off]);
  expect(source.sent).toHaveLength(1);
  await settingsPoller.stop();
});

test("a report goes at least every ten minutes, and after every apply", async () => {
  const clock = fakeClock();
  const source = scriptedSource([
    settings(v1, off),
    { kind: "not-modified", version: v1 },
    { kind: "not-modified", version: v1 },
    { kind: "not-modified", version: v1 },
    { kind: "not-modified", version: v1 },
    { kind: "not-modified", version: v1 },
    settings(v2, on),
  ]);
  const applied = applying();
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  expect(source.sent).toHaveLength(1);
  // Polls at 2, 4, 6 and 8 minutes report nothing; the one at 10 does.
  for (let poll = 1; poll <= 4; poll += 1)
    await tick(clock, settingsPoller, 120_000);
  expect(source.sent).toHaveLength(1);
  await tick(clock, settingsPoller, 120_000);
  expect(source.sent).toHaveLength(2);
  expect(source.sent[1]?.version).toBe(v1);
  // A new version applies and reports at once.
  await tick(clock, settingsPoller, 120_000);
  expect(applied.calls).toEqual([off, on]);
  expect(source.sent).toHaveLength(3);
  expect(source.sent[2]?.version).toBe(v2);
  await settingsPoller.stop();
});

test("without an answer the last applied version stays, and the error is said and reported", async () => {
  const clock = fakeClock();
  const source = scriptedSource([
    settings(v1, off),
    {
      kind: "failed",
      error: "dashboard_unreachable",
      detail: "status-503",
    },
  ]);
  const applied = applying();
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  await tick(clock, settingsPoller, 120_000);
  expect(applied.calls).toEqual([off]);
  expect(settingsPoller.status()).toMatchObject({
    version: v1,
    appliedAt: "2026-10-09T20:00:01.000Z",
    // The last answer came at the first question.
    checkedAt: "2026-10-09T20:00:01.000Z",
    error: "dashboard_unreachable",
  });
  expect(source.sent.at(-1)).toMatchObject({
    version: v1,
    appliedAt: "2026-10-09T20:00:01.000Z",
    lastError: "dashboard_unreachable",
  });
  // The same error again is not reported again before ten minutes.
  const reports = source.sent.length;
  await tick(clock, settingsPoller, 120_000);
  expect(source.sent).toHaveLength(reports);
  await settingsPoller.stop();
});

test("invalid settings keep the last applied version, reported as settings_invalid", async () => {
  const clock = fakeClock();
  const source = scriptedSource([
    settings(v1, off),
    { kind: "invalid", version: v2 },
  ]);
  const applied = applying();
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  await tick(clock, settingsPoller, 120_000);
  expect(applied.calls).toEqual([off]);
  expect(settingsPoller.status()).toMatchObject({
    version: v1,
    checkedAt: "2026-10-09T20:02:01.000Z",
    error: "settings_invalid",
  });
  expect(source.sent.at(-1)).toMatchObject({
    version: v1,
    lastError: "settings_invalid",
  });
  await settingsPoller.stop();
});

test("after a restart the first answer is applied and reported at once", async () => {
  const clock = fakeClock();
  const recorded: AppliedState = {
    source: "dashboard",
    version: v1,
    organization: { githubOrgId: 123, login: "Example" },
    settings: off,
    unsupported: [],
    appliedAt: "2026-10-09T19:00:00.000Z",
    items: [{ key, outcome: "applied", detail: null }],
    lastError: "dashboard_unreachable",
    checkedAt: "2026-10-09T19:00:00.000Z",
  };
  const store = memoryStateStore(recorded);
  const source = scriptedSource([{ kind: "not-modified", version: v1 }]);
  const applied = applying([
    () => ({
      items: [{ key, outcome: "applied", detail: null }],
      changed: false,
    }),
  ]);
  const settingsPoller = poller(source.adapter, applied.apply, clock, store);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  expect(source.asked).toEqual([v1]);
  // Applied once in this process, from the recorded settings of that version.
  expect(applied.calls).toEqual([off]);
  // Nothing changed with it: it was applied when it was, and the error of
  // before the restart is gone.
  expect(source.sent).toEqual([
    {
      version: v1,
      appliedAt: "2026-10-09T19:00:00.000Z",
      lastError: null,
      items: [{ key, outcome: "applied", detail: null }],
      platformVersion: "0.1.9",
    },
  ]);
  await settingsPoller.stop();
});

test("a page that opens asks at once; a storm of openings asks once", async () => {
  const clock = fakeClock();
  const source = scriptedSource([
    settings(v1, off),
    { kind: "not-modified", version: v1 },
  ]);
  const applied = applying();
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  await tick(clock, settingsPoller, 30_000);
  // Thirty seconds after the last question, ten page loads at once.
  await Promise.all(
    Array.from({ length: 10 }, () => settingsPoller.nudge(1_000)),
  );
  expect(source.asked).toEqual([null, v1]);
  // Within fifteen seconds of a question, opening asks nothing.
  await tick(clock, settingsPoller, 10_000);
  await settingsPoller.nudge(1_000);
  expect(source.asked).toEqual([null, v1]);
  await tick(clock, settingsPoller, 5_000);
  await settingsPoller.nudge(1_000);
  expect(source.asked).toEqual([null, v1, v1]);
  // The cadence restarts from the last question.
  await tick(clock, settingsPoller, 119_000);
  expect(source.asked).toHaveLength(3);
  await tick(clock, settingsPoller, 1_000);
  expect(source.asked).toHaveLength(4);
  await settingsPoller.stop();
});

test("a nudge waits for the answer at most as long as it is told", async () => {
  const clock = fakeClock();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source: SettingsSourceAdapter = {
    kind: "repository",
    async read() {
      await held;
      return settings(v1, off);
    },
  };
  const applied = applying();
  const settingsPoller = poller(source, applied.apply, clock, undefined, {
    // Real time for the wait, so a held answer cannot hold the nudge.
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  const started = Date.now();
  await settingsPoller.nudge(50);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(applied.calls).toEqual([]);
  release();
  await settingsPoller.idle();
  expect(applied.calls).toEqual([off]);
  await settingsPoller.stop();
});

test("an apply that failed is tried again at the next answer, without a new version", async () => {
  const clock = fakeClock();
  const source = scriptedSource([
    settings(v1, off),
    { kind: "not-modified", version: v1 },
    { kind: "not-modified", version: v1 },
  ]);
  const applied = applying([
    () => ({
      items: [{ key, outcome: "failed", detail: "folder-busy" }],
      changed: false,
    }),
  ]);
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  expect(settingsPoller.status().unapplied).toEqual([key]);
  expect(source.sent.at(-1)?.items).toEqual([
    { key, outcome: "failed", detail: "folder-busy" },
  ]);
  await tick(clock, settingsPoller, 120_000);
  expect(applied.calls).toEqual([off, off]);
  expect(settingsPoller.status().unapplied).toEqual([]);
  // Now applied: reported at once.
  expect(source.sent.at(-1)?.items).toEqual([
    { key, outcome: "applied", detail: null },
  ]);
  // Converged: the next not-modified applies nothing.
  await tick(clock, settingsPoller, 120_000);
  expect(applied.calls).toEqual([off, off]);
  await settingsPoller.stop();
});

test("a corrupt record of the last version is said, asked without a version and replaced", async () => {
  const clock = fakeClock();
  let written: AppliedState | null = null;
  const store: SettingsStateStore = {
    read: async () =>
      written === null
        ? { kind: "corrupt" }
        : { kind: "state", state: written },
    write: async (state) => {
      written = state;
    },
  };
  const source = scriptedSource([
    {
      kind: "failed",
      error: "identity_unavailable",
      detail: "environment_identity_unavailable",
    },
    settings(v1, off),
  ]);
  const applied = applying();
  const settingsPoller = poller(source.adapter, applied.apply, clock, store);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  expect(source.asked).toEqual([null]);
  expect(settingsPoller.status()).toMatchObject({
    version: null,
    error: "state_unreadable",
  });
  // Never applied: reported without a version, with the reason.
  expect(source.sent.at(-1)).toMatchObject({
    version: null,
    appliedAt: null,
    lastError: "identity_unavailable",
  });
  await tick(clock, settingsPoller, 120_000);
  expect(source.asked).toEqual([null, null]);
  expect(applied.calls).toEqual([off]);
  expect(settingsPoller.status()).toMatchObject({ version: v1, error: null });
  expect(written).toMatchObject({ version: v1, settings: off });
  await settingsPoller.stop();
});

test("a report the Dashboard refuses as invalid is sent again with only what it delivered", async () => {
  const clock = fakeClock();
  const source = scriptedSource(
    [settings(v1, off, ["future.limit"])],
    [
      { kind: "refused", status: 400, detail: "invalid_report" },
      { kind: "accepted" },
    ],
  );
  const applied = applying([
    () => ({
      items: [
        { key, outcome: "applied", detail: null },
        { key: "future.limit", outcome: "unsupported", detail: null },
      ],
      changed: true,
    }),
  ]);
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  expect(source.sent.map((report) => report.items)).toEqual([
    [
      { key, outcome: "applied", detail: null },
      { key: "future.limit", outcome: "unsupported", detail: null },
    ],
    [{ key, outcome: "applied", detail: null }],
  ]);
  await settingsPoller.stop();
});

test("the Organization's repository as the source reports nothing", async () => {
  const clock = fakeClock();
  const source = scriptedSource([settings(v1, off)], [], "repository");
  const applied = applying();
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  expect(applied.calls).toEqual([off]);
  expect(source.sent).toEqual([]);
  expect(settingsPoller.status().source).toBe("repository");
  // Its unchanged version is not applied again.
  await tick(clock, settingsPoller, 120_000);
  expect(applied.calls).toEqual([off]);
  await settingsPoller.stop();
});

test("a stopped poller asks nothing more", async () => {
  const clock = fakeClock();
  const source = scriptedSource([settings(v1, off)]);
  const applied = applying();
  const settingsPoller = poller(source.adapter, applied.apply, clock);
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  await settingsPoller.stop();
  await tick(clock, settingsPoller, 600_000);
  await settingsPoller.nudge(10);
  expect(source.asked).toEqual([null]);
  expect(clock.pending()).toBe(0);
});

test("the Folder changing calls back, so the Launchpad reads its Integrace again", async () => {
  const clock = fakeClock();
  const source = scriptedSource([settings(v1, off), settings(v2, off)]);
  const applied = applying([
    () => ({
      items: [{ key, outcome: "applied", detail: null }],
      changed: true,
    }),
    () => ({
      items: [{ key, outcome: "applied", detail: null }],
      changed: false,
    }),
  ]);
  let changes = 0;
  const settingsPoller = poller(
    source.adapter,
    applied.apply,
    clock,
    undefined,
    {
      onApplied: () => {
        changes += 1;
      },
    },
  );
  settingsPoller.start();
  await tick(clock, settingsPoller, 1_000);
  await tick(clock, settingsPoller, 120_000);
  expect(changes).toBe(1);
  await settingsPoller.stop();
});
