import type { RecoveryCheck } from "../recover/checks";
import type { RecoveryResult } from "../recover/recover";
import type { MessageKey } from "./messages";
import type { StartRefusal } from "./start-check";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the Recovery page and of the Recovery view of
// Settings (docs/recovery.md "The Recovery page"); the DOM lives in
// recovery-panel.ts. The server derives every fact, the same result as
// `lazurio recover --json`; the browser shows it as text, never as markup,
// and sends nothing back.

/** Recovery mode as every refused API route names it: `503 {error:
 * "recovery-mode", check, reason}` (docs/update.md "Recovery mode"). */
export type RecoveryMode = Readonly<{ check: string; reason: string }>;

const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);

/** The answer of any API route, when it says the Launchpad is in Recovery
 * mode; null for every other answer. */
export function recoveryModeAnswer(
  status: number,
  value: unknown,
): RecoveryMode | null {
  if (status !== 503 || typeof value !== "object" || value === null)
    return null;
  const answer = value as Record<string, unknown>;
  return answer.error === "recovery-mode" &&
    id(answer.check) &&
    id(answer.reason)
    ? Object.freeze({ check: answer.check, reason: answer.reason })
    : null;
}

const reasonKeys: Readonly<Record<StartRefusal, MessageKey>> = {
  "folder-state-unreadable": "recoveryReasonFolderStateUnreadable",
  "folder-transaction-pending": "recoveryReasonFolderTransactionPending",
  "folder-lock-unavailable": "recoveryReasonFolderLockUnavailable",
  "hosted-entry-invalid": "recoveryReasonHostedEntryInvalid",
  "asset-missing": "recoveryReasonAssetMissing",
};

export type RecoveryModeView = Readonly<{
  title: string;
  text: string;
  /** Each enumerated id with its label and, for the reason, its words. */
  rows: readonly Readonly<{ label: string; id: string; text: string | null }>[];
}>;

/** The head of the Recovery page: the check and the reason, by id and in
 * words. An unknown reason is named by its id rather than guessed. */
export function recoveryModeView(
  mode: RecoveryMode,
  copy: Copy,
): RecoveryModeView {
  const key = Object.hasOwn(reasonKeys, mode.reason)
    ? reasonKeys[mode.reason as StartRefusal]
    : null;
  return Object.freeze({
    title: copy.recoveryModeTitle,
    text: copy.recoveryModeText,
    rows: Object.freeze([
      { label: copy.recoveryCheckLabel, id: mode.check, text: null },
      {
        label: copy.recoveryReasonLabel,
        id: mode.reason,
        text: key === null ? copy.recoveryReasonUnknown : copy[key],
      },
    ]),
  });
}

/** The result of `GET /api/recovery`, when it has the shape of one. */
export function parseRecovery(value: unknown): RecoveryResult | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as Partial<RecoveryResult>;
  return result.kind === "recovery" &&
    (result.verdict === "healthy" ||
      result.verdict === "broken" ||
      result.verdict === "not-installed") &&
    Array.isArray(result.checks)
    ? (value as RecoveryResult)
    : null;
}

export type RecoveryControl = "copy-prompt" | "copy-gh";

export type RecoveryView = Readonly<{
  verdict: RecoveryResult["verdict"];
  summary: string;
  checks: readonly Readonly<{
    id: string;
    outcome: RecoveryCheck["outcome"];
    /** The outcome in words. */
    state: string;
    /** The code or skip reason and the context, as `lazurio recover`
     * prints them. */
    detail: string;
  }>[];
  /** The tier-1 evidence, without the journal. */
  evidence: string | null;
  /** The toggle's label; null when there is no journal. */
  journalToggle: string | null;
  /** The journal tail, only when the operator asked to see it. */
  journal: string | null;
  prompt: string | null;
  issue:
    | Readonly<{
        kind: "prepared";
        text: string;
        title: string;
        body: string;
        command: string;
        link: string;
        linkLabel: string;
      }>
    | Readonly<{ kind: "refused"; text: string }>
    | null;
  nothingFiled: string | null;
  /** The buttons that copy a prepared text, with their labels. */
  actions: readonly Readonly<{ control: RecoveryControl; label: string }>[];
}>;

const outcomeKeys: Readonly<Record<RecoveryCheck["outcome"], MessageKey>> = {
  ok: "recoveryOutcomeOk",
  failed: "recoveryOutcomeFailed",
  skipped: "recoveryOutcomeSkipped",
};

function checkDetail(check: RecoveryCheck): string {
  const head =
    check.outcome === "failed"
      ? check.code
      : check.outcome === "skipped"
        ? check.reason
        : "";
  const context =
    check.outcome === "skipped"
      ? []
      : Object.entries(check.context).map(
          ([key, value]) => `${key}=${String(value)}`,
        );
  return [head, ...context].filter((part) => part !== "").join(" ");
}

/** What the page shows for one result. The journal (tier 2) is part of the
 * view only when `journal` is true: the operator's explicit toggle. */
export function recoveryView(
  result: RecoveryResult,
  copy: Copy,
  options: Readonly<{ journal: boolean }> = { journal: false },
): RecoveryView {
  const summary =
    result.verdict === "healthy"
      ? copy.recoveryHealthy
      : result.verdict === "broken"
        ? copy.recoveryBroken
        : copy.recoveryNotInstalled;
  const checks = result.checks.map((check) =>
    Object.freeze({
      id: check.rule === null ? check.id : `${check.id} (${check.rule})`,
      outcome: check.outcome,
      state: copy[outcomeKeys[check.outcome]],
      detail: checkDetail(check),
    }),
  );
  const evidence = result.evidence;
  const fields =
    evidence === null
      ? null
      : (({ journal: _, ...rest }) => rest)(
          evidence as Record<string, unknown>,
        );
  const journalText = evidence?.journal ?? null;
  const issue = result.issue;
  const actions: { control: RecoveryControl; label: string }[] = [];
  if (result.prompt !== null)
    actions.push({ control: "copy-prompt", label: copy.recoveryPromptCopy });
  if (issue?.kind === "prepared")
    actions.push({ control: "copy-gh", label: copy.recoveryIssueCopy });
  return Object.freeze({
    verdict: result.verdict,
    summary,
    checks: Object.freeze(checks),
    evidence: fields === null ? null : JSON.stringify(fields, null, 2),
    journalToggle:
      journalText === null
        ? null
        : options.journal
          ? copy.recoveryJournalHide
          : copy.recoveryJournalShow,
    journal: options.journal ? journalText : null,
    prompt: result.prompt,
    issue:
      issue === null
        ? null
        : issue.kind === "prepared"
          ? Object.freeze({
              kind: "prepared" as const,
              text: fill(copy.recoveryIssueText, {
                repository: issue.repository,
              }),
              title: issue.title,
              body: issue.body,
              command: issue.shell,
              link: issue.link,
              linkLabel: issue.bodyInLink
                ? copy.recoveryIssueLink
                : copy.recoveryIssueLinkPaste,
            })
          : Object.freeze({
              kind: "refused" as const,
              text: fill(copy.recoveryIssueRefused, {
                kinds: issue.found.join(", "),
              }),
            }),
    nothingFiled:
      result.verdict === "broken" ? copy.recoveryNothingFiled : null,
    actions: Object.freeze(actions),
  });
}
