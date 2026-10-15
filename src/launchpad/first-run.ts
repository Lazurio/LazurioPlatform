import type { ShellSetup } from "../shell/contract";
import type { AiState } from "../tools/ai";
import type { ToolOverview, ToolsOverview } from "../tools/overview";
import type { ContentJob, ContentList } from "./content-client";
import {
  type ContentFact,
  contentFact,
  type Resolve,
  unpreparedCodes,
} from "./content-view";
import type { MessageKey } from "./messages";
import type { SettingsSection } from "./routes";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// The first run of an Environment: root decision 0188 as reshaped by 0201
// (points 1-3 and 8, plan DEV-6665; the wireframe of
// HumanAndMachine-ai/prototypes-lazurio 1eefc3d, `setup.tsx`,
// `screens/Start.tsx`, `screens/Tour.tsx`). The Environment is usable when it
// has its basics: an AI an agent can work with, GitHub signed in as its
// person, and its content (the Organization, or on the personal Environment
// the Personalspace). Nastavení → Začínáme lists them, in the order AI →
// GitHub → content, from live facts only; nothing about them is stored. Until
// they exist the onboarding shows on every page load: the tour points at the
// next missing basic, Apps says it in one line and the shell's column keeps a
// quiet prompt. "Dokončím později" puts the tour away for this view only. The
// browser keeps only where the introduction after the basics points. It runs
// only where the Environment signs in to GitHub as its person. Pure: the DOM
// is tour.ts, start-panel.ts and catalog-panel.ts.

/** The presets whose Environment signs in to GitHub as its person: a
 * personal Remote Environment, an Organization's work Environment of one
 * person, and a workstation. A Team Environment acts through the
 * Organization's Lazurio for GitHub and an Automated one as its persona, and
 * their AI is the Organization's; neither asks the person, so neither gets
 * Začínáme, the tour or the line (0188 point 3). */
export const personPresets = Object.freeze([
  "local",
  "hosted-personal",
  "hosted-organization-personal",
] as const);

export function signsInAsPerson(preset: string | null | undefined): boolean {
  return (personPresets as readonly string[]).includes(preset ?? "");
}

/** Whether GitHub is connected here, by Settings → Nástroje's own reading
 * (the gh row): `unknown` until the reading of the profile now shown has
 * a sign-in, on a shared (Team) Environment, and when gh could not tell.
 * Not installed is `missing`: "Připojit" installs it first. */
export type GithubFact = "missing" | "connected" | "unknown";

type ToolsReading =
  | (Pick<ToolsOverview, "revision" | "sharedEnvironment"> &
      Readonly<{
        tools: readonly Pick<ToolOverview, "name" | "installed" | "signIn">[];
      }>)
  | null;

export function githubFact(
  overview: ToolsReading,
  currentRevision: number | null,
): GithubFact {
  const github = overview?.tools.find((tool) => tool.name === "gh");
  if (
    currentRevision === null ||
    overview === null ||
    overview.revision !== currentRevision ||
    overview.sharedEnvironment !== false ||
    github === undefined
  )
    return "unknown";
  if (!github.installed) return "missing";
  const state = github.signIn?.state;
  return state === "signed-in"
    ? "connected"
    : state === "signed-out"
      ? "missing"
      : "unknown";
}

/** The GitHub account gh is signed in with, as the same reading names it. */
export function githubAccount(overview: ToolsReading): string | null {
  const github = overview?.tools.find((tool) => tool.name === "gh");
  return github?.signIn?.state === "signed-in"
    ? (github.signIn.account ?? null)
    : null;
}

/** Whether Composio is connected: `none` where Tools do not offer it. */
export type ComposioFact = "missing" | "connected" | "none";

export function composioFact(overview: ToolsReading): ComposioFact {
  const composio = overview?.tools.find((tool) => tool.name === "composio");
  if (composio === undefined) return "none";
  return composio.signIn?.state === "signed-in" ? "connected" : "missing";
}

/** The Environment's AI as the page knows it (`GET /api/ai`, tools/ai.ts):
 * `loading` until the first answer. */
export type AiFact = AiState | "loading";

/** What the first run reads: the preset, and the three basics. */
export type TourFacts = Readonly<{
  preset: string | null;
  ai: AiFact;
  github: GithubFact;
  content: ContentFact;
}>;

/** The basics of 0201 point 1, in their order (point 3). */
export const basics = Object.freeze(["ai", "github", "content"] as const);
export type Basic = (typeof basics)[number];

/** One basic: done (provided ahead counts), missing, or not known. */
export function basicState(
  facts: TourFacts,
  basic: Basic,
): "done" | "missing" | "unknown" {
  if (basic === "ai")
    return facts.ai === "organization" || facts.ai === "connected"
      ? "done"
      : facts.ai === "missing"
        ? "missing"
        : "unknown";
  if (basic === "github")
    return facts.github === "connected"
      ? "done"
      : facts.github === "missing"
        ? "missing"
        : "unknown";
  const content = facts.content.state;
  return content === "ready" || content === "none"
    ? "done"
    : content === "missing" || content === "failed"
      ? "missing"
      : "unknown";
}

/** How many basics are done, for "Dokončit nastavení (1 ze 3)". */
export function basicsDone(facts: TourFacts): number {
  return basics.filter((basic) => basicState(facts, basic) === "done").length;
}

/** The first basic still missing, in the order AI → GitHub → content; null
 * when all are there (or the Environment has no first run); undefined while
 * one that decides it is not known yet. The AI before its first answer, an
 * unknown GitHub and an unread content wait; an AI that could not be read
 * (`unknown`) is never claimed missing, so it does not hold the rest. */
export function nextBasic(facts: TourFacts): Basic | null | undefined {
  if (!signsInAsPerson(facts.preset)) return null;
  if (facts.ai === "loading") return undefined;
  if (facts.ai === "missing") return "ai";
  const github = basicState(facts, "github");
  if (github === "unknown") return undefined;
  if (github === "missing") return "github";
  const content = basicState(facts, "content");
  if (content === "unknown") return undefined;
  return content === "missing" ? "content" : null;
}

/** One stop of the tour; each rings a real element. */
export type TourStep =
  | "gear"
  | "settings-start"
  | "ai"
  | "github"
  | "prepare"
  | "apps"
  | "chat"
  | "automate"
  | "settings";

/** After the basics: what is where (Začínáme's "Prohlídka aplikace"). */
export const tourIntro = Object.freeze([
  "apps",
  "chat",
  "automate",
  "settings",
] as const satisfies readonly TourStep[]);

/** What this browser keeps per Environment: only where the introduction
 * after the basics points (0201 point 2). The basics are read live every
 * time, and putting the tour away holds for the current view only. */
export type TourProgress = Readonly<{ intro: number }>;

export const freshTourProgress: TourProgress = Object.freeze({ intro: 0 });
/** The introduction seen to its end, or never needed. */
export const finishedTourProgress: TourProgress = Object.freeze({
  intro: tourIntro.length,
});

/** The storage key of one Environment's progress in this browser. */
export const tourStorageKey = (environment: string): string =>
  `lazurio.tour:${environment}`;

/** Stored progress, read defensively: anything else is none. An entry of
 * the first run of 0188 (`{ composio, intro, done }`) keeps its place in the
 * introduction, a finished or put-away one counts as seen; its other
 * members are dropped at the next write. */
export function parseTourProgress(raw: string | null): TourProgress | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { intro, done } = value as Record<string, unknown>;
  if (
    typeof intro !== "number" ||
    !Number.isInteger(intro) ||
    intro < 0 ||
    intro > tourIntro.length ||
    !(done === undefined || typeof done === "boolean")
  )
    return null;
  return done === true ? finishedTourProgress : Object.freeze({ intro });
}

/** Progress for an Environment seen for the first time in this browser: one
 * that already has its basics needs no introduction, so a workstation's
 * Launchpad, whose loopback origin changes with every start, does not repeat
 * it. Null, so nothing is stored yet, while a basic that decides it is not
 * known (the Steward's review of #180: a failed read must not finish it). */
export function firstProgress(facts: TourFacts): TourProgress | null {
  const next = nextBasic(facts);
  if (!signsInAsPerson(facts.preset) || next === undefined) return null;
  return next === null ? finishedTourProgress : freshTourProgress;
}

/** The stop of the tour where the person is (`settings`: the Settings
 * section shown, null outside Settings), or none. While a basic is missing it
 * leads gear → Začínáme → that basic's step there (0201 points 2 and 3);
 * then the introduction runs wherever the person is. Nothing while a fact it
 * needs is not known yet. Putting it away is the page's, for one view. */
export function tourStep(
  facts: TourFacts,
  progress: TourProgress | null,
  settings: SettingsSection | null,
): TourStep | null {
  if (!signsInAsPerson(facts.preset)) return null;
  const next = nextBasic(facts);
  if (next === undefined) return null;
  if (next !== null) {
    if (settings === "start") return next === "content" ? "prepare" : next;
    return settings !== null ? "settings-start" : "gear";
  }
  if (progress === null) return null;
  return tourIntro[progress.intro] ?? null;
}

/** The progress after "Další" or "Hotovo" on a stop of the introduction. */
export function tourAdvance(
  progress: TourProgress,
  step: TourStep,
): TourProgress {
  const index = (tourIntro as readonly TourStep[]).indexOf(step);
  if (index < 0) return progress;
  return Object.freeze({ intro: Math.max(progress.intro, index + 1) });
}

/** The element a stop rings (`data-tour` in the page or the shell's column
 * head). */
export type TourTarget =
  | "gear"
  | "settings-start"
  | "start-ai"
  | "start-github"
  | "prepare"
  | "tab-apps"
  | "tab-chat"
  | "tab-automate";

export type TourStop = Readonly<{
  target: TourTarget;
  title: string;
  /** Why, in a few plain words; the whole bubble stays within about a
   * dozen words. */
  text: string | null;
  /** The primary button of the bubble: on the introduction's stops. */
  next: "next" | "done" | null;
  /** "Dokončím později": everywhere but the introduction's last stop. */
  later: boolean;
}>;

/** What one stop says (Matěj 2026-10-04): at most ten to twelve words, why
 * it matters and what happens, nothing technical, no "click here" (the ring
 * shows where) and no headings above the title. `apps` names whether Chat
 * and Automate run on this Environment. */
export function tourStop(
  step: TourStep,
  facts: Pick<TourFacts, "preset" | "ai" | "github" | "content">,
  apps: Readonly<{ chat: boolean; automate: boolean }>,
  copy: Copy,
): TourStop {
  const stop = (
    target: TourTarget,
    title: string,
    text: string | null,
    next: TourStop["next"] = null,
  ): TourStop => ({ target, title, text, next, later: next !== "done" });
  const content = facts.content;
  const item =
    content.state === "missing" || content.state === "failed"
      ? content.item
      : null;
  const personal = item?.kind === "personalspace";
  const name =
    item?.kind === "organization"
      ? (item.name ?? item.login)
      : copy.tourOrganization;
  const failed = content.state === "failed";
  switch (step) {
    case "gear": {
      const next = nextBasic(facts);
      if (next === "ai")
        return stop("gear", copy.tourGearAiTitle, copy.tourGearAiText);
      if (next === "github")
        return stop("gear", copy.tourGearGithubTitle, copy.tourGearGithubText);
      if (failed)
        return stop("gear", copy.tourGearFailedTitle, copy.tourGearFailedText);
      return personal
        ? stop("gear", copy.tourPreparePersonalTitle, copy.tourPersonalText)
        : stop(
            "gear",
            fill(copy.tourGearOrganizationTitle, { name }),
            copy.tourOrganizationText,
          );
    }
    case "settings-start":
      return stop("settings-start", copy.tourStartTitle, copy.tourStartText);
    case "ai":
      return stop("start-ai", copy.tourAiTitle, copy.tourAiText);
    case "github":
      return stop("start-github", copy.tourGithubTitle, copy.tourGithubText);
    case "prepare":
      if (failed)
        return stop(
          "prepare",
          copy.tourPrepareFailedTitle,
          copy.tourPrepareFailedText,
        );
      return personal
        ? stop("prepare", copy.tourPreparePersonalTitle, copy.tourPersonalText)
        : stop(
            "prepare",
            fill(copy.tourPrepareOrganizationTitle, { name }),
            copy.tourOrganizationText,
          );
    case "apps":
      return stop("tab-apps", copy.tourAppsTitle, copy.tourAppsText, "next");
    case "chat":
      return stop(
        "tab-chat",
        copy.tourChatTitle,
        apps.chat ? copy.tourChatText : copy.tourChatMissingText,
        "next",
      );
    case "automate":
      return stop(
        "tab-automate",
        copy.tourAutomateTitle,
        apps.automate ? copy.tourAutomateText : copy.tourAutomateMissingText,
        "next",
      );
    case "settings":
      return stop(
        "gear",
        copy.tourSettingsTitle,
        copy.tourSettingsText,
        "done",
      );
  }
}

/** Where a stopped preparation leads (0201 points 3 and 8): Chat with the
 * prepared prompt when an agent can work; the AI step when no AI is
 * connected; and for an Organization that is not prepared for this version
 * (`unpreparedCodes`), to someone who cannot write its root repository
 * (`rootAccess` not confirmed, which includes not known yet), only the
 * sentence that its Admin prepares it. An AI not known yet is not claimed
 * missing. */
export function resolveOf(
  input: Readonly<{
    ai: AiFact;
    code: string | null;
    rootAccess: boolean | null;
  }>,
): Resolve {
  if (
    input.code !== null &&
    unpreparedCodes.includes(input.code) &&
    input.rootAccess !== true
  )
    return "admin";
  return input.ai === "missing" ? "ai" : "chat";
}

/** What a button of the line starts. `open-start`: Settings → Začínáme;
 * `sign-in-gh`: Začínáme with gh's sign-in open; `install-content`:
 * Začínáme with the installation started; `resolve-in-chat`: the prepared
 * prompt handed to Chat. */
export type SetupAction =
  | "open-start"
  | "sign-in-gh"
  | "install-content"
  | "resolve-in-chat";

export type SetupLine = Readonly<{
  tone: "info" | "failed";
  icon: "sparks" | "key" | "download" | "warning";
  text: string;
  actions: readonly Readonly<{ action: SetupAction; label: string }>[];
}>;

/** The line in Apps until the Environment has its basics (the wireframe's
 * `SetupBanner`): the next missing basic in the order AI → GitHub → content,
 * a running preparation, or a stopped one with where it leads (`resolve`).
 * Only where it signs in as its person, and only what is known. */
export function appsSetupLine(
  facts: TourFacts &
    Readonly<{
      /** A content installation runs now. */
      running?: boolean;
      /** Where a stopped preparation leads (`resolveOf`). */
      resolve?: Resolve;
    }>,
  copy: Copy,
): SetupLine | null {
  const next = nextBasic(facts);
  if (next === null || next === undefined) return null;
  if (next === "ai")
    return {
      tone: "info",
      icon: "sparks",
      text: copy.setupAi,
      actions: [{ action: "open-start", label: copy.setupAiAction }],
    };
  if (next === "github")
    return {
      tone: "info",
      icon: "key",
      text: copy.setupGithub,
      actions: [{ action: "sign-in-gh", label: copy.setupGithubAction }],
    };
  const content = facts.content;
  if (content.state === "failed") {
    const resolve = facts.resolve ?? "chat";
    const item = content.item;
    const retry = {
      action: "install-content",
      label: copy.setupRetry,
    } as const;
    if (resolve === "admin")
      return {
        tone: "failed",
        icon: "warning",
        text:
          item?.kind === "organization"
            ? fill(copy.setupUnready, { name: item.name ?? item.login })
            : copy.setupFailed,
        actions: [retry],
      };
    return {
      tone: "failed",
      icon: "warning",
      text: copy.setupFailed,
      actions: [
        resolve === "ai"
          ? { action: "open-start", label: copy.setupAiAction }
          : { action: "resolve-in-chat", label: copy.setupResolve },
        retry,
      ],
    };
  }
  if (content.state !== "missing") return null;
  const item = content.item;
  const name = item.kind === "organization" ? (item.name ?? item.login) : "";
  if (facts.running === true)
    return {
      tone: "info",
      icon: "download",
      text:
        item.kind === "personalspace"
          ? copy.setupPersonalRunning
          : fill(copy.setupOrganizationRunning, { name }),
      actions: [{ action: "open-start", label: copy.setupShow }],
    };
  return item.kind === "personalspace"
    ? {
        tone: "info",
        icon: "download",
        text: copy.setupPersonalMissing,
        actions: [{ action: "install-content", label: copy.setupPrepare }],
      }
    : {
        tone: "info",
        icon: "download",
        text: fill(copy.setupOrganizationMissing, { name }),
        actions: [{ action: "install-content", label: copy.setupDownload }],
      };
}

/** The shell document's `setup` from what is known (root decisions 0188 and
 * 0201): undefined where the preset does not sign in as its person or
 * GitHub's state is not known; `ai` only when it is known. The server's
 * document and the Launchpad page's own column head both draw from it. */
export function shellSetup(
  input: Readonly<{
    preset: string;
    ai: AiFact;
    github: GithubFact;
    list: ContentList | null;
    job: ContentJob | null;
  }>,
): ShellSetup | undefined {
  if (!signsInAsPerson(input.preset) || input.github === "unknown")
    return undefined;
  const fact = contentFact(input.list, input.job);
  const base = {
    ...(input.ai === "organization" || input.ai === "connected"
      ? { ai: "ready" as const }
      : input.ai === "missing"
        ? { ai: "missing" as const }
        : {}),
    github: input.github,
  } as const;
  if (
    fact.state === "none" ||
    fact.state === "loading" ||
    fact.state === "unknown"
  )
    return base;
  if (fact.state === "ready") return { ...base, content: "ready" };
  const item = fact.item;
  const read =
    item === null
      ? undefined
      : item.kind === "organization"
        ? {
            kind: "organization" as const,
            name: item.name ?? item.login,
            login: item.login,
          }
        : { kind: "personalspace" as const, login: item.login };
  return {
    ...base,
    content: fact.state === "failed" ? "failed" : "missing",
    ...(read === undefined ? {} : { item: read }),
  };
}

/** What a link asked the Launchpad to start on arrival, in its fragment
 * (`#lazurio-start=sign-in-gh`, `#lazurio-start=install-content`): from the
 * line in Apps, or from an older shell's column head in Chat and Automate. */
export type StartRequest = "sign-in-gh" | "install-content";

export const startParameter = "lazurio-start";

/** Where a start request leads: Začínáme, where the sign-in and the
 * installation are steps (0201). A link of an older shell to Nástroje or
 * Tento Environment lands there too. */
export const startSection: Readonly<Record<StartRequest, SettingsSection>> = {
  "sign-in-gh": "start",
  "install-content": "start",
};

/** The fragment of the page's first address, taken apart: the start
 * request, and the rest, which locally is the session token
 * (`#<token>`, `#<token>&lazurio-start=…`). */
export function readFragment(hash: string): Readonly<{
  token: string;
  start: StartRequest | null;
}> {
  const parts = hash.replace(/^#/, "").split("&");
  let start: StartRequest | null = null;
  const rest: string[] = [];
  for (const part of parts) {
    if (part.startsWith(`${startParameter}=`)) {
      let value = "";
      try {
        value = decodeURIComponent(part.slice(startParameter.length + 1));
      } catch {}
      if (value === "sign-in-gh" || value === "install-content") start = value;
      continue;
    }
    if (part !== "") rest.push(part);
  }
  return { token: rest.join("&"), start };
}
