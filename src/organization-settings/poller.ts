import {
  type ApplyOutcome,
  applyOrganizationSettings,
  type DeliveredValues,
} from "./apply";
import {
  type ReportError,
  reportErrors,
  type SettingsItem,
  type SettingsReport,
} from "./contract";
import type { ReportSent, SettingsRead } from "./relay";
import type { AppliedState, SettingsStateStore } from "./state";
import type {
  OrganizationSettingsStatus,
  SettingsSource,
  StatusError,
} from "./status";

export type { ApplyOutcome } from "./apply";

// The Launchpad's convergence on its Organization's settings (root decision
// 0194 points 3 to 5, decision F45). While it runs it asks its source every
// two minutes, at once when its page opens or a person asks again (never
// twice within a short while: a storm of page loads asks once), applies a
// new version itself, and reports. Without an answer the last applied
// version stays: the Folder keeps what it recorded, and the record of the
// version says why nothing new came.
//
// The source is the Dashboard through the Environment's relay (contract C3)
// or, without a relay, the Organization's repository in the Folder; only the
// Dashboard takes reports. A report goes after every apply or change of what
// it says, and at least every ten minutes.

/** One answer of a source. */
export type SourceRead =
  | SettingsRead
  | Readonly<{
      kind: "failed";
      error: "repository_unavailable";
      detail: string;
    }>;

export type SettingsSourceAdapter = Readonly<{
  kind: SettingsSource;
  /** The settings now; `known` is the version applied last, or null. */
  read(known: string | null): Promise<SourceRead>;
  /** Only a source that takes reports (the Dashboard). */
  report?: (report: SettingsReport) => Promise<ReportSent>;
}>;

export const pollerDefaults = Object.freeze({
  /** The first question, just after the Launchpad listens. */
  startupDelayMs: 1_000,
  intervalMs: 120_000,
  /** A page that opens within this long of the last question asks nothing. */
  nudgeGapMs: 15_000,
  reportIntervalMs: 600_000,
});

export type SettingsPollerOptions = Readonly<{
  folder: string;
  source: SettingsSourceAdapter;
  store: SettingsStateStore;
  apply?: (folder: string, delivered: DeliveredValues) => Promise<ApplyOutcome>;
  /** The Lazurio Platform release, as the report names it. */
  platformVersion: string;
  now?: () => Date;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  startupDelayMs?: number;
  intervalMs?: number;
  nudgeGapMs?: number;
  reportIntervalMs?: number;
  /** One line per event: what happened, never a value of a setting. */
  journal?: (entry: Readonly<Record<string, unknown>>) => void;
  /** The Folder was changed: whoever keeps a reading of it reads again. */
  onApplied?: () => void;
}>;

export type SettingsPoller = Readonly<{
  start(): void;
  /** No more questions; waits for a Folder change in progress. */
  stop(): Promise<void>;
  /** Ask now, unless a question went out within the nudge gap; resolves
   * when that question is answered and applied, or after `waitMs`. */
  nudge(waitMs?: number): Promise<void>;
  /** The question in flight, if any. */
  idle(): Promise<void>;
  status(): OrganizationSettingsStatus;
}>;

const significant = (state: AppliedState | null) =>
  state === null ? "" : JSON.stringify({ ...state, checkedAt: null });

/** What a report says, to know when it changed. */
const reported = (report: SettingsReport) =>
  JSON.stringify({ ...report, platformVersion: null });

export function createSettingsPoller(
  options: SettingsPollerOptions,
): SettingsPoller {
  const { folder, source, store } = options;
  const apply = options.apply ?? applyOrganizationSettings;
  const now = options.now ?? (() => new Date());
  const schedule =
    options.setTimeout ??
    ((run: () => void, ms: number) => setTimeout(run, ms));
  const cancel =
    options.clearTimeout ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const startupDelayMs =
    options.startupDelayMs ?? pollerDefaults.startupDelayMs;
  const intervalMs = options.intervalMs ?? pollerDefaults.intervalMs;
  const nudgeGapMs = options.nudgeGapMs ?? pollerDefaults.nudgeGapMs;
  const reportIntervalMs =
    options.reportIntervalMs ?? pollerDefaults.reportIntervalMs;
  const journal = (entry: Readonly<Record<string, unknown>>) =>
    options.journal?.({ scope: "organization-settings", ...entry });

  let phase: "idle" | "running" | "stopped" = "idle";
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let applying: Promise<void> | null = null;
  let lastStartedAt: number | null = null;
  // What this process knows: the record as last read or written, whether the
  // record could not be read, when the source last answered, whether the
  // record's version is applied without a failure in this process, and what
  // the last accepted report said.
  let known: AppliedState | null = null;
  let corrupt = false;
  let answeredAt: string | null = null;
  let converged = false;
  let lastReport: string | null = null;
  let lastReportAt: number | null = null;
  // The error this process last said in its journal: each new one once.
  let journaled: string | null = null;

  const blank = (): AppliedState => ({
    source: source.kind,
    version: null,
    organization: null,
    settings: {},
    unsupported: [],
    appliedAt: null,
    items: [],
    lastError: null,
    checkedAt: null,
  });

  async function applyGuarded(
    delivered: DeliveredValues,
  ): Promise<ApplyOutcome> {
    const work = apply(folder, delivered);
    applying = work.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await work;
    } catch {
      return { items: [], changed: false };
    } finally {
      applying = null;
    }
  }

  /** The record after applying `delivered` at `version`. */
  async function applied(
    state: AppliedState | null,
    version: string,
    organization: AppliedState["organization"],
    delivered: DeliveredValues,
    at: string,
  ): Promise<AppliedState> {
    const outcome = await applyGuarded(delivered);
    if (outcome.changed) options.onApplied?.();
    converged = outcome.items.every((item) => item.outcome !== "failed");
    journal({
      event: "applied",
      source: source.kind,
      version,
      changed: outcome.changed,
      items: outcome.items,
    });
    const same =
      state !== null &&
      state.version === version &&
      JSON.stringify(state.items) === JSON.stringify(outcome.items) &&
      !outcome.changed;
    return {
      source: source.kind,
      version,
      organization,
      settings: delivered.values,
      unsupported: delivered.unsupported,
      appliedAt: same ? state.appliedAt : at,
      items: outcome.items,
      lastError: null,
      checkedAt: at,
    };
  }

  async function read(known: string | null): Promise<SourceRead> {
    try {
      return await source.read(known);
    } catch {
      return source.kind === "dashboard"
        ? { kind: "failed", error: "dashboard_unreachable", detail: "internal" }
        : {
            kind: "failed",
            error: "repository_unavailable",
            detail: "internal",
          };
    }
  }

  async function pollOnce(): Promise<void> {
    lastStartedAt = now().getTime();
    const record = await store
      .read()
      .catch(() => ({ kind: "corrupt" }) as const);
    if (record.kind === "corrupt" && !corrupt)
      journal({ event: "state-unreadable" });
    corrupt = record.kind === "corrupt";
    // A version of another source is no version to ask this one about.
    let state =
      record.kind === "state" && record.state.source === source.kind
        ? record.state
        : null;
    if (state === null) converged = false;
    const answer = await read(state?.version ?? null);
    if (phase === "stopped") return;
    const at = now().toISOString();
    let next: AppliedState;
    let answered = true;
    if (answer.kind === "settings") {
      const delivered = answer.settings;
      next =
        state !== null && state.version === delivered.version && converged
          ? { ...state, lastError: null, checkedAt: at }
          : await applied(
              state,
              delivered.version,
              delivered.organization,
              { values: delivered.values, unsupported: delivered.unsupported },
              at,
            );
    } else if (answer.kind === "not-modified" && state !== null) {
      next = converged
        ? { ...state, lastError: null, checkedAt: at }
        : await applied(
            state,
            state.version ?? answer.version,
            state.organization,
            { values: state.settings, unsupported: state.unsupported },
            at,
          );
    } else if (answer.kind === "invalid") {
      next = {
        ...(state ?? blank()),
        lastError: "settings_invalid",
        checkedAt: at,
      };
    } else {
      answered = false;
      next = {
        ...(state ?? blank()),
        lastError:
          answer.kind === "failed" ? answer.error : "dashboard_unreachable",
      };
    }
    if (answered) answeredAt = at;
    // Why the version stays, said once per reason in this process.
    const kept = next.lastError;
    if (kept !== journaled) {
      if (kept !== null)
        journal({
          event: "kept",
          source: source.kind,
          error: kept,
          ...(answer.kind === "failed"
            ? { detail: answer.detail }
            : answer.kind === "not-modified"
              ? { detail: "answer-invalid" }
              : {}),
        });
      journaled = kept;
    }
    // Written only when something but the time of the answer changed.
    if (significant(next) !== significant(state) || corrupt) {
      try {
        await store.write(next);
        if (answered) corrupt = false;
      } catch {
        journal({ event: "state-unwritable" });
      }
    }
    state = next;
    known = state;
    await report(state);
  }

  async function report(state: AppliedState): Promise<void> {
    if (source.report === undefined || phase === "stopped") return;
    const lastError: ReportError | null = (
      reportErrors as readonly (StatusError | null)[]
    ).includes(state.lastError)
      ? (state.lastError as ReportError)
      : null;
    const body: SettingsReport = {
      version: state.version,
      appliedAt: state.appliedAt,
      lastError,
      items: state.items,
      platformVersion: options.platformVersion,
    };
    const due =
      reported(body) !== lastReport ||
      lastReportAt === null ||
      now().getTime() - lastReportAt >= reportIntervalMs;
    if (!due) return;
    let sent = await source
      .report(body)
      .catch((): ReportSent => ({ kind: "failed", detail: "internal" }));
    // A Dashboard of another release may not know a key this one reports:
    // once more with only what it delivered.
    if (
      sent.kind === "refused" &&
      sent.status === 400 &&
      sent.detail === "invalid_report"
    ) {
      const delivered = new Set(governed(state.settings));
      const narrowed: SettingsItem[] = body.items.filter(
        (item) => item.outcome !== "unsupported" && delivered.has(item.key),
      );
      if (narrowed.length !== body.items.length)
        sent = await source
          .report({ ...body, items: narrowed })
          .catch((): ReportSent => ({ kind: "failed", detail: "internal" }));
    }
    if (sent.kind === "accepted") {
      lastReport = reported(body);
      lastReportAt = now().getTime();
    } else
      journal({
        event: "report",
        outcome: sent.kind,
        detail: sent.detail,
      });
  }

  function plan(ms: number) {
    if (timer !== null) cancel(timer);
    timer = schedule(() => {
      timer = null;
      if (inFlight === null) void run();
    }, ms);
  }

  function run(): Promise<void> {
    const poll = pollOnce()
      .catch(() => journal({ event: "poll-failed" }))
      .finally(() => {
        inFlight = null;
        if (phase === "running") plan(intervalMs);
      });
    inFlight = poll;
    return poll;
  }

  return Object.freeze({
    start() {
      if (phase !== "idle") return;
      phase = "running";
      if (inFlight === null) plan(startupDelayMs);
    },
    async stop() {
      phase = "stopped";
      if (timer !== null) cancel(timer);
      timer = null;
      await applying;
    },
    nudge(waitMs = 0) {
      if (phase === "stopped") return Promise.resolve();
      let poll = inFlight;
      if (poll === null) {
        if (
          lastStartedAt !== null &&
          now().getTime() - lastStartedAt < nudgeGapMs
        )
          return Promise.resolve();
        if (timer !== null) cancel(timer);
        timer = null;
        poll = run();
      }
      if (waitMs <= 0) return Promise.resolve();
      const answered = poll;
      return new Promise<void>((resolve) => {
        const bound = schedule(resolve, waitMs);
        void answered.finally(() => {
          cancel(bound);
          resolve();
        });
      });
    },
    idle: () => inFlight ?? Promise.resolve(),
    status(): OrganizationSettingsStatus {
      return Object.freeze({
        source: source.kind,
        version: known?.version ?? null,
        appliedAt: known?.appliedAt ?? null,
        checkedAt: answeredAt ?? known?.checkedAt ?? null,
        error: corrupt ? "state_unreadable" : (known?.lastError ?? null),
        unapplied: Object.freeze(
          (known?.items ?? [])
            .filter((item) => item.outcome !== "applied")
            .map((item) => item.key),
        ),
      });
    },
  });
}

function governed(values: AppliedState["settings"]): string[] {
  const keys: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      keys.push(path);
      return;
    }
    for (const [key, member] of Object.entries(value))
      walk(member, path === "" ? key : `${path}.${key}`);
  };
  walk(values, "");
  return keys.filter((key) => key !== "");
}
