import type {
  ContentItem,
  ContentJob,
  ContentList,
  ContentRef,
  ContentStepState,
} from "./content-client";
import { refersTo } from "./content-client";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// What Settings → Tento Environment says about the content of this
// Environment (the wireframe's Prepare.tsx, prototypes-lazurio 45c92830):
// what lives here, the steps of its preparation in plain words while it
// runs, and when a step stops one plain sentence, the technical detail
// folded under "Podrobnosti" and "Vyřešit v Chatu". Pure: the DOM is
// content-panel.ts. Every string returned is text, never markup.

/** The steps of each kind, in their order (the content routes' keys). */
export const contentStepKeys = Object.freeze({
  organization: Object.freeze([
    "access",
    "root",
    "modules",
    "preparation",
    "check",
  ]),
  personalspace: Object.freeze(["find", "create", "clone", "check"]),
});

const stepLabels: Readonly<
  Record<ContentItem["kind"], Readonly<Record<string, MessageKey>>>
> = {
  organization: {
    access: "contentStepAccess",
    root: "contentStepRoot",
    modules: "contentStepModules",
    preparation: "contentStepPreparation",
    check: "contentStepCheck",
  },
  personalspace: {
    find: "contentStepFind",
    create: "contentStepCreate",
    clone: "contentStepClone",
    check: "contentStepCheck",
  },
};

const failureSentences: Readonly<
  Record<ContentItem["kind"], Readonly<Record<string, MessageKey>>>
> = {
  organization: {
    access: "contentFailedAccess",
    root: "contentFailedRoot",
    modules: "contentFailedModules",
    preparation: "contentFailedPreparation",
    check: "contentFailedCheck",
  },
  personalspace: {
    find: "contentFailedFind",
    create: "contentFailedCreate",
    clone: "contentFailedClone",
    check: "contentFailedCheck",
  },
};

/** One step in the person's words ("Ověřuji přístup", "Stahuji"); a key
 * this page does not know reads "Připravuji". */
export function contentStepLabel(
  kind: ContentItem["kind"],
  key: string,
  copy: Copy,
): string {
  const label = Object.hasOwn(stepLabels[kind], key)
    ? stepLabels[kind][key]
    : undefined;
  return copy[label ?? "contentStepOther"];
}

/** The plain sentence of a step that stopped. */
export function contentFailureSentence(
  kind: ContentItem["kind"],
  key: string,
  copy: Copy,
): string {
  const sentence = Object.hasOwn(failureSentences[kind], key)
    ? failureSentences[kind][key]
    : undefined;
  return copy[sentence ?? "contentFailedOther"];
}

/** The command the Launchpad runs for an item, as the prompt and
 * "Podrobnosti" name it. */
export function contentCommand(item: ContentRef): string {
  return item.kind === "personalspace"
    ? "lazurio personalspace install"
    : `lazurio organization install ${item.login}`;
}

/** An item's name: the Organization's display name, else its login; the
 * Personalspace is "Osobní prostor". */
export function contentName(item: ContentItem, copy: Copy): string {
  return item.kind === "personalspace"
    ? copy.contentPersonalspace
    : (item.name ?? item.login);
}

export type StepMark = "done" | "running" | "failed" | "next";

export type StepView = Readonly<{ key: string; label: string; mark: StepMark }>;

/** The steps of one item while it is prepared or after it stopped: the
 * known sequence of its kind with each step's state from the job, steps the
 * job skipped left out, the ones not reached yet "next". The
 * Personalspace's "Zakládám" shows only where it runs: when GitHub has none
 * yet, or when the job does create it. Keys the job names that this page
 * does not know follow in the job's order. */
export function contentSteps(
  item: ContentItem,
  job: ContentJob | null,
  copy: Copy,
): readonly StepView[] {
  const steps = (job?.steps ?? []).filter((step) => refersTo(step.item, item));
  // The last word on a step wins: a step may be reported more than once.
  const state = (key: string): ContentStepState | undefined =>
    [...steps].reverse().find((step) => step.key === key)?.state;
  const known: readonly string[] = contentStepKeys[item.kind];
  const keys = [
    ...known.filter((key) => {
      if (item.kind !== "personalspace" || key !== "create") return true;
      const create = state("create");
      return create === undefined
        ? item.onGitHub === "missing"
        : create !== "skipped";
    }),
    ...steps
      .map((step) => step.key)
      .filter(
        (key, index, all) => !known.includes(key) && all.indexOf(key) === index,
      ),
  ];
  return keys.flatMap((key): StepView[] => {
    const current = state(key);
    if (current === "skipped") return [];
    const mark: StepMark =
      current === "done"
        ? "done"
        : current === "failed"
          ? "failed"
          : current === "running"
            ? "running"
            : "next";
    return [{ key, label: contentStepLabel(item.kind, key, copy), mark }];
  });
}

/** Where the content stands, for the banner, the tour and the shell:
 * `loading` until the first answer; `unknown` when the answer could not be
 * read (a failed request or another shape), which says nothing about the
 * content; `none` where there is nothing to prepare here (not allowed, no
 * items); `failed` while the last installation stopped at an item that is
 * still not here; `missing` with the first item that is not here; `ready`
 * otherwise. */
export type ContentFact =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "unknown" }>
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "ready" }>
  | Readonly<{ state: "missing"; item: ContentItem }>
  | Readonly<{ state: "failed"; item: ContentItem | null; job: ContentJob }>;

export function contentFact(
  list: ContentList | null | "loading",
  job: ContentJob | null,
): ContentFact {
  if (list === "loading") return { state: "loading" };
  // Unreadable is not "nothing to prepare" (the Steward's review of #180).
  if (list === null) return { state: "unknown" };
  if (!list.allowed || list.items.length === 0) return { state: "none" };
  const missing = list.items.filter((item) => item.state !== "present");
  if (job?.state === "failed") {
    const failure = job.failure;
    const stopped =
      failure === undefined
        ? (missing[0] ?? null)
        : (list.items.find((item) => refersTo(failure.item, item)) ?? null);
    if (stopped === null ? missing.length > 0 : stopped.state !== "present")
      return { state: "failed", item: stopped, job };
  }
  const [first] = missing;
  return first === undefined
    ? { state: "ready" }
    : { state: "missing", item: first };
}

/** One row of "Obsah Environmentu". */
export type ContentRow = Readonly<{
  item: ContentItem;
  name: string;
  /** The status line under the name. */
  status: string;
  /** The steps, while it runs or after it stopped here. */
  steps: readonly StepView[] | null;
  /** The stop: one plain sentence, and for "Podrobnosti" the command and
   * the detail. */
  failure: Readonly<{ sentence: string; details: string }> | null;
  /** Why an item cannot be prepared now, for "Podrobnosti". */
  reason: string | null;
}>;

export type ContentView = Readonly<{
  rows: readonly ContentRow[];
  /** The one action of the group, on its first row: download or prepare
   * what is missing, or try again; null while it runs or when all is here. */
  action: Readonly<{ label: string; disabled: boolean }> | null;
  /** A sentence under the action: why it cannot be used now. */
  note: string | null;
  /** Whether the stopped installation can be handed to Chat. */
  resolve: boolean;
}>;

/** "Obsah Environmentu": a row per item and the one action. `github` says
 * whether GitHub is connected here (`unknown` does not block); `modules`
 * counts an Organization's modules once it is here. */
export function contentView(
  list: ContentList,
  job: ContentJob | null,
  copy: Copy,
  options: Readonly<{
    github: "missing" | "connected" | "unknown";
    modules?: (login: string) => number | null;
    pluralModules?: (count: number) => string;
  }>,
): ContentView {
  const running = job?.state === "running";
  const fact = contentFact(list, job);
  const failedItem = fact.state === "failed" ? fact.item : null;
  const reached = new Set(
    (job?.steps ?? []).flatMap((step) =>
      list.items.filter((item) => refersTo(step.item, item)),
    ),
  );
  const rows = list.items.map((item): ContentRow => {
    const name = contentName(item, copy);
    const stoppedHere = fact.state === "failed" && failedItem === item;
    const present = item.state === "present";
    const count =
      present && item.kind === "organization"
        ? (options.modules?.(item.login) ?? null)
        : null;
    const status = present
      ? count === null || options.pluralModules === undefined
        ? copy.contentPresent
        : `${copy.contentPresent} · ${options.pluralModules(count)}`
      : running
        ? reached.has(item)
          ? copy.contentRunning
          : copy.contentWaiting
        : stoppedHere
          ? copy.contentStopped
          : item.state === "blocked"
            ? copy.contentBlocked
            : copy.contentAbsent;
    const showSteps =
      !present && job !== null && (running ? reached.has(item) : stoppedHere);
    const failure =
      stoppedHere && fact.state === "failed"
        ? {
            sentence: `${contentFailureSentence(item.kind, fact.job.failure?.key ?? "", copy)} ${copy.contentAgentFixes}`,
            details: [
              contentCommand(item),
              ...(fact.job.failure === undefined
                ? []
                : [
                    fact.job.failure.detail,
                    fact.job.failure.code === ""
                      ? ""
                      : `(${fact.job.failure.code})`,
                  ]),
            ]
              .filter((part) => part !== "")
              .join("\n"),
          }
        : null;
    return {
      item,
      name,
      status,
      steps: showSteps ? contentSteps(item, job, copy) : null,
      failure,
      reason:
        item.state === "blocked" && failure === null
          ? (item.reason ?? null)
          : null,
    };
  });
  const missing = list.items.filter((item) => item.state !== "present");
  const blockedBy =
    options.github === "missing"
      ? copy.contentNeedsGithub
      : !list.allowed
        ? copy.contentNotAllowed
        : null;
  const action =
    running || missing.length === 0
      ? null
      : {
          label:
            fact.state === "failed"
              ? copy.setupRetry
              : missing.length > 1
                ? copy.contentDownloadAll
                : missing[0]?.kind === "personalspace"
                  ? copy.setupPrepare
                  : copy.setupDownload,
          disabled: blockedBy !== null,
        };
  return {
    rows,
    action,
    note: action === null ? null : blockedBy,
    resolve: fact.state === "failed",
  };
}

/** The item a stopped installation is about, as the prompt names it. */
export type PrepareTarget =
  | Readonly<{ kind: "organization"; name: string; login: string }>
  | Readonly<{ kind: "personalspace" }>;

/** The prepared prompt of "Vyřešit v Chatu" (the wireframe's
 * `preparePrompt`, Matěj 2026-10-04): find the cause, fix it here, finish
 * with the same command as the Launchpad, verify with `lazurio doctor` and
 * the modules' tests, report, and ask before any change outside this
 * Environment. With the step that stopped and its detail when they are
 * known. */
export function preparePrompt(
  target: PrepareTarget,
  failure: Readonly<{ step: string; detail: string }> | null,
  copy: Copy,
): string {
  const what =
    target.kind === "personalspace"
      ? copy.preparePromptWhatPersonal
      : fill(copy.preparePromptWhatOrganization, {
          name: target.name,
          login: target.login,
        });
  const command = contentCommand(
    target.kind === "personalspace"
      ? { kind: "personalspace", login: null }
      : { kind: "organization", login: target.login },
  );
  const head =
    failure === null
      ? [fill(copy.preparePromptStopped, { what })]
      : [
          fill(copy.preparePromptStoppedAt, { what, step: failure.step }),
          ...(failure.detail === "" ? [] : [failure.detail]),
        ];
  return [...head, "", fill(copy.preparePromptBody, { command })].join("\n");
}

/** The prompt's target and failure from a stopped job and the list: the
 * failed item (an Organization by its name and login), the step that
 * stopped in plain words and its detail. Null without a stop to resolve. */
export function prepareContext(
  list: ContentList | null,
  job: ContentJob | null,
  copy: Copy,
): Readonly<{
  target: PrepareTarget;
  failure: Readonly<{ step: string; detail: string }> | null;
  /** The login the prompt link names (`lazurio-org`): the Organization's,
   * or the person's for the Personalspace; null when none is known. */
  login: string | null;
}> | null {
  if (job?.state !== "failed") return null;
  const failure = job.failure;
  const ref = failure?.item ?? null;
  const item =
    ref === null || list === null
      ? null
      : (list.items.find((entry) => refersTo(ref, entry)) ?? null);
  const kind = ref?.kind ?? item?.kind;
  if (kind === undefined) return null;
  const step =
    failure === undefined
      ? null
      : {
          step: contentStepLabel(kind, failure.key, copy),
          detail: failure.detail,
        };
  if (kind === "personalspace") {
    const login =
      (ref?.kind === "personalspace" ? ref.login : null) ??
      (item?.kind === "personalspace" ? item.login : null);
    return { target: { kind: "personalspace" }, failure: step, login };
  }
  const login =
    ref?.kind === "organization"
      ? ref.login
      : item?.kind === "organization"
        ? item.login
        : null;
  if (login === null) return null;
  const name = item?.kind === "organization" ? (item.name ?? login) : login;
  return {
    target: { kind: "organization", name, login },
    failure: step,
    login,
  };
}
