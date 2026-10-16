import type {
  ContentItem,
  ContentJob,
  ContentList,
  ContentRef,
  ContentStepState,
} from "./content-client";
import { refersTo } from "./content-client";
import type { ContentBlock } from "./first-run";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

/** Where a stopped preparation leads (first-run.ts `resolveOf`): Chat, the
 * AI step, or the sentence that the Organization's Admin prepares it. */
export type Resolve = "chat" | "ai" | "admin";

/** The failure codes of an Organization that is not prepared for this
 * version of Lazurio yet: its root repository does not declare itself
 * (`lazurio.organization.json`), or its declaration cannot be read. Only
 * someone who can write that repository fixes it (root decision 0201 point
 * 8). */
export const unpreparedCodes: readonly string[] = Object.freeze([
  "root-not-found",
  "organization-unreadable",
]);

type Copy = Readonly<Record<MessageKey, string>>;

// What Settings → Toto Prostředí says about the content of this
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
  personalspace: Object.freeze([
    "find",
    "create",
    "clone",
    "bootstrap",
    "push",
    "check",
  ]),
});

/** The Personalspace's steps that run only where it is created. */
const creationSteps: readonly string[] = ["create", "bootstrap", "push"];

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
    bootstrap: "contentStepBootstrap",
    push: "contentStepPush",
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
    bootstrap: "contentFailedBootstrap",
    push: "contentFailedPush",
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

/** The plain sentence of a step that stopped. An Organization that is not
 * prepared for this version of Lazurio (`code` one of `unpreparedCodes`,
 * root decision 0201 point 8) says so, whichever step found it. */
export function contentFailureSentence(
  kind: ContentItem["kind"],
  key: string,
  copy: Copy,
  code = "",
): string {
  if (kind === "organization" && unpreparedCodes.includes(code))
    return copy.contentFailedUnready;
  const sentence = Object.hasOwn(failureSentences[kind], key)
    ? failureSentences[kind][key]
    : undefined;
  return copy[sentence ?? "contentFailedOther"];
}

/** What follows the stop's sentence, by where it leads (`resolveOf`). */
const resolveSentence: Readonly<Record<Resolve, MessageKey>> = {
  chat: "contentAgentFixes",
  ai: "contentAgentAfterAi",
  admin: "contentAdminPrepares",
};

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
 * Personalspace's "Zakládám", "Nastavuji" and "Ukládám na GitHub" show only
 * where they run: when GitHub has none yet, or when the job does create it.
 * Keys the job names that this page does not know follow in the job's
 * order. */
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
      if (item.kind !== "personalspace" || !creationSteps.includes(key))
        return true;
      const reported = state(key);
      if (reported !== undefined) return reported !== "skipped";
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

/** One row of "Obsah Prostředí". */
export type ContentRow = Readonly<{
  item: ContentItem;
  name: string;
  /** The status line under the name. */
  status: string;
  /** The steps, while it runs or after it stopped here. */
  steps: readonly StepView[] | null;
  /** The stop: one plain sentence, and for "Podrobnosti" the command and
   * the detail; `resolve` where its button leads. */
  failure: Readonly<{
    sentence: string;
    details: string;
    resolve: Resolve;
  }> | null;
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
  /** The note only says that the content's turn comes after AI or GitHub:
   * Začínáme leaves it out, as its numbered steps say the order (F36's
   * addendum of 2026-10-16). */
  turn: boolean;
  /** Whether the stopped installation can be handed to Chat. */
  resolve: boolean;
}>;

/** "Obsah Prostředí": a row per item and the one action. `github` says
 * whether GitHub is connected here (`unknown` does not block); `blockedBy`,
 * where given, what must come first (`contentBlockedBy` in first-run.ts, root
 * decision 0201 point 3), and replaces `github`: the action, a download or
 * "Zkusit znovu", is not offered before its turn, only a sentence why;
 * `modules` counts an Organization's modules once it is here; `resolve`
 * says where a stop leads (Chat when not given). */
export function contentView(
  list: ContentList,
  job: ContentJob | null,
  copy: Copy,
  options: Readonly<{
    github: "missing" | "connected" | "unknown";
    blockedBy?: ContentBlock | null;
    modules?: (login: string) => number | null;
    pluralModules?: (count: number) => string;
    resolve?: Resolve;
  }>,
): ContentView {
  const resolve = options.resolve ?? "chat";
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
            sentence: `${contentFailureSentence(item.kind, fact.job.failure?.key ?? "", copy, fact.job.failure?.code)} ${copy[resolveSentence[resolve]]}`,
            resolve,
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
  const block =
    options.blockedBy !== undefined
      ? options.blockedBy
      : options.github === "missing"
        ? "github"
        : null;
  const notYet =
    block === "ai"
      ? copy.contentNeedsAi
      : block === "github"
        ? copy.contentNeedsGithub
        : null;
  const blockedBy = !list.allowed ? copy.contentNotAllowed : null;
  // Not its turn: no action, only why (nothing while it is not read yet).
  if (!running && missing.length > 0 && block !== null)
    return {
      rows,
      action: null,
      note: notYet,
      turn: notYet !== null,
      resolve: fact.state === "failed",
    };
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
    turn: false,
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
