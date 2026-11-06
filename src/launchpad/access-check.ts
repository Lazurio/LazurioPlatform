import type { SyncRun } from "../content/sync";
import type { Catalog } from "../organizations/catalog";
import { moduleName } from "./apps-view";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// "Zkontrolovat přístupy" (decision F36's addendum of 2026-11-05): an
// Organization's synchronization run now instead of within the hour, so that
// a person who was just given a module sees it at once. The route answers
// which modules this run brought, what the page says is here; pure, shared by
// the Launchpad and the page.

/** Why a check did not finish: a run under way holds the content lock
 * (`busy`), GitHub did not answer (`github`) or refused the Organization
 * (`denied`), its root has work of its own (`blocked`), this Environment runs
 * no check (`not-here`), or anything else (`failed`). */
export type AccessCheckReason =
  | "busy"
  | "github"
  | "denied"
  | "blocked"
  | "not-here"
  | "failed";

/** The answer of `POST /api/organizations/<org>/sync`. `added`: the modules
 * this run cloned, by their path in the Organization. */
export type AccessCheckAnswer =
  | Readonly<{
      kind: "access-check";
      state: "checked";
      added: readonly string[];
    }>
  | Readonly<{
      kind: "access-check";
      state: "failed";
      reason: AccessCheckReason;
    }>;

export const accessCheckFailed = (
  reason: AccessCheckReason,
): AccessCheckAnswer => ({ kind: "access-check", state: "failed", reason });

/** What one Organization's run answers. A root that did not end on its
 * published commit stops the Organization (`syncContent`), so nothing was
 * checked; a module GitHub did not answer for leaves the check unfinished
 * unless the run brought something. Without access a module stays quietly
 * absent: that is the plain answer, nothing new. A checkout that keeps its own
 * work (`blocked`) says nothing about access. */
export function accessCheckAnswer(run: SyncRun): AccessCheckAnswer {
  if (run.kind === "busy") return accessCheckFailed("busy");
  if (run.kind === "not-allowed") return accessCheckFailed("not-here");
  const root = run.entries.find((entry) => entry.kind === "root");
  if (root === undefined) return accessCheckFailed("failed");
  if (root.result !== "current" && root.result !== "fast-forwarded")
    return accessCheckFailed(
      root.result === "unavailable"
        ? "github"
        : root.result === "denied"
          ? "denied"
          : root.result === "blocked"
            ? "blocked"
            : "failed",
    );
  const added = run.entries
    .filter((entry) => entry.kind === "module")
    .filter((entry) => entry.result === "materialized")
    .map((entry) => entry.path);
  return added.length === 0 &&
    run.entries.some((entry) => entry.result === "unavailable")
    ? accessCheckFailed("github")
    : { kind: "access-check", state: "checked", added };
}

const reasons: readonly AccessCheckReason[] = [
  "busy",
  "github",
  "denied",
  "blocked",
  "not-here",
  "failed",
];

/** The route's answer, or null for anything else. */
export function parseAccessCheck(value: unknown): AccessCheckAnswer | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as {
    kind?: unknown;
    state?: unknown;
    added?: unknown;
    reason?: unknown;
  };
  if (answer.kind !== "access-check") return null;
  if (answer.state === "failed")
    return reasons.includes(answer.reason as AccessCheckReason)
      ? accessCheckFailed(answer.reason as AccessCheckReason)
      : null;
  return answer.state === "checked" &&
    Array.isArray(answer.added) &&
    answer.added.every((path) => typeof path === "string")
    ? { kind: "access-check", state: "checked", added: answer.added }
    : null;
}

/** The modules a person sees of the Organization bound to `login`, name by
 * path: those here (a declared one not cloned yet is `absent`) and the guests
 * this Environment can read. */
export function shownModules(
  catalog: Catalog | null,
  login: string,
): ReadonlyMap<string, string> {
  const key = login.toLowerCase();
  const organization = catalog?.organizations.find(
    (entry) => entry.forgeLogin?.toLowerCase() === key,
  );
  return new Map([
    ...(organization?.modules ?? [])
      .filter((module) => module.absent !== true)
      .map((module): [string, string] => [module.path, moduleName(module)]),
    ...(organization?.guests ?? [])
      .filter((guest) => guest.checkedOut && guest.revoked !== true)
      .map((guest): [string, string] => [guest.path, guest.module]),
  ]);
}

/** What is new for the person: what this run brought, and whatever else
 * shows now that did not before, such as a module the hourly run brought
 * while the page stayed open. */
export function addedNames(
  added: readonly string[],
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly string[] {
  const names = new Map(
    added.map((path) => [
      path,
      after.get(path) ?? (path.split("/").at(-1) as string),
    ]),
  );
  for (const [path, name] of after)
    if (!before.has(path)) names.set(path, name);
  return [...names.values()];
}

/** The line under the head, in its tone. */
export type AccessLine = Readonly<{
  text: string;
  tone: "quiet" | "success" | "warning";
}>;

const reasonKeys: Readonly<Record<AccessCheckReason, MessageKey>> = {
  busy: "accessReasonBusy",
  github: "accessReasonGithub",
  denied: "accessReasonDenied",
  blocked: "accessReasonBlocked",
  "not-here": "accessReasonHere",
  failed: "accessReasonFailed",
};

/** What the page says once a check ended; null: no readable answer. */
export function accessLine(
  answer: AccessCheckAnswer | null,
  names: readonly string[],
  copy: Copy,
): AccessLine {
  if (answer === null || answer.state === "failed")
    return {
      text: copy.accessFailed.replace(
        "{reason}",
        copy[reasonKeys[answer?.reason ?? "failed"]],
      ),
      tone: "warning",
    };
  if (names.length === 0) return { text: copy.accessNothing, tone: "quiet" };
  return {
    text: (names.length === 1
      ? copy.accessAddedOne
      : copy.accessAddedMany
    ).replace("{names}", () => names.join(", ")),
    tone: "success",
  };
}
