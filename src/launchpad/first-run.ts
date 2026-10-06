import type { ToolOverview, ToolsOverview } from "../tools/overview";
import type { ContentFact } from "./content-view";
import type { MessageKey } from "./messages";
import type { SettingsSection } from "./routes";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// The first run of an Environment (root decision 0188, the wireframe of
// HumanAndMachine-ai/prototypes-lazurio 45c92830, `setup.tsx`): a tour of
// the real interface and a line until the Environment is usable. The tour
// rings the gear, leads to Settings → Nástroje and "Připojit" at gh, offers
// Composio, leads to Tento Environment where the content is downloaded or
// prepared, then shows Apps, Chat, Automate and where Settings always are.
// It runs only where the Environment signs in to GitHub as its person. Until
// GitHub and the content are there, Apps (and, through the shell document,
// Chat and Automate) say in one line what is missing. Pure: the DOM is
// tour.ts and catalog-panel.ts.

/** The presets whose Environment signs in to GitHub as its person: a
 * personal Remote Environment, an Organization's work Environment of one
 * person, and a workstation. A Team Environment acts through the
 * Organization's Lazurio for GitHub and an Automated one as its persona;
 * neither asks the person, so neither gets the tour or the line. */
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

/** Whether Composio is connected: `none` where Tools do not offer it. */
export type ComposioFact = "missing" | "connected" | "none";

export function composioFact(overview: ToolsReading): ComposioFact {
  const composio = overview?.tools.find((tool) => tool.name === "composio");
  if (composio === undefined) return "none";
  return composio.signIn?.state === "signed-in" ? "connected" : "missing";
}

/** One stop of the tour; each rings a real element. */
export type TourStep =
  | "gear"
  | "settings-tools"
  | "github"
  | "composio"
  | "gear-prepare"
  | "settings-environment"
  | "prepare"
  | "apps"
  | "chat"
  | "automate"
  | "settings";

/** After the sign-ins and the content: what is where. */
export const tourIntro = Object.freeze([
  "apps",
  "chat",
  "automate",
  "settings",
] as const satisfies readonly TourStep[]);

/** What the tour remembers per Environment: Composio put off ("Teď ne"),
 * the position in the introduction, and whether it is done or put away
 * ("Ukončit"). GitHub and the content are never remembered: they are read
 * live every time. */
export type TourProgress = Readonly<{
  composio: "skipped" | null;
  intro: number;
  done: boolean;
}>;

export const freshTourProgress: TourProgress = Object.freeze({
  composio: null,
  intro: 0,
  done: false,
});

/** The storage key of one Environment's progress in this browser. */
export const tourStorageKey = (environment: string): string =>
  `lazurio.tour:${environment}`;

/** Stored progress, read defensively: anything else is none. */
export function parseTourProgress(raw: string | null): TourProgress | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { composio, intro, done } = value as Record<string, unknown>;
  if (
    !(composio === null || composio === "skipped") ||
    typeof intro !== "number" ||
    !Number.isInteger(intro) ||
    intro < 0 ||
    intro > tourIntro.length ||
    typeof done !== "boolean"
  )
    return null;
  return Object.freeze({ composio, intro, done });
}

export type TourFacts = Readonly<{
  preset: string | null;
  github: GithubFact;
  composio: ComposioFact;
  content: ContentFact;
}>;

/** Progress for an Environment seen for the first time: one that is
 * already usable (GitHub connected, its content here or nothing to prepare)
 * needs no tour, so it starts done; a workstation's Launchpad, whose
 * loopback origin changes with every start, does not repeat it then. Without
 * GitHub it is not usable whatever the content. Null, so nothing is stored
 * yet, while a fact that decides it is not known: GitHub's state, or the
 * content still loading or unreadable (the Steward's review of #180: a failed
 * read must not finish the tour for good). */
export function firstProgress(facts: TourFacts): TourProgress | null {
  if (!signsInAsPerson(facts.preset)) return null;
  if (facts.github === "unknown") return null;
  if (facts.github === "missing") return freshTourProgress;
  const content = facts.content.state;
  if (content === "loading" || content === "unknown") return null;
  return content === "ready" || content === "none"
    ? Object.freeze({ ...freshTourProgress, done: true })
    : freshTourProgress;
}

/** The stop of the tour where the person is (`settings`: the Settings
 * section shown, null outside Settings), or none. Without GitHub it leads
 * gear → Settings → Nástroje → gh; Composio is offered in Nástroje and never
 * blocks; then the content, in Tento Environment; then the introduction
 * wherever the person is. A stopped preparation belongs to the line and
 * Chat: the tour waits for it in Settings. Nothing while a fact it needs is
 * not known yet. */
export function tourStep(
  facts: TourFacts,
  progress: TourProgress | null,
  settings: SettingsSection | null,
): TourStep | null {
  if (!signsInAsPerson(facts.preset) || progress === null || progress.done)
    return null;
  if (facts.github === "unknown") return null;
  if (facts.github === "missing")
    return settings === "tools"
      ? "github"
      : settings !== null
        ? "settings-tools"
        : "gear";
  if (
    facts.composio === "missing" &&
    progress.composio !== "skipped" &&
    settings === "tools"
  )
    return "composio";
  const content = facts.content;
  if (content.state === "loading" || content.state === "unknown") return null;
  if (content.state === "failed" && settings === null) return null;
  if (content.state === "missing" || content.state === "failed")
    return settings === "machine"
      ? "prepare"
      : settings !== null
        ? "settings-environment"
        : "gear-prepare";
  return tourIntro[progress.intro] ?? null;
}

/** The progress after a click in the bubble. */
export function tourAdvance(
  progress: TourProgress,
  step: TourStep,
  action: "next" | "not-now" | "quit",
): TourProgress {
  if (action === "quit") return Object.freeze({ ...progress, done: true });
  if (action === "not-now")
    return Object.freeze({ ...progress, composio: "skipped" });
  const index = (tourIntro as readonly TourStep[]).indexOf(step);
  if (index < 0) return progress;
  const intro = index + 1;
  return Object.freeze({
    ...progress,
    intro,
    done: intro >= tourIntro.length,
  });
}

/** The element a stop rings (`data-tour` in the page or the shell's column
 * head). */
export type TourTarget =
  | "gear"
  | "settings-tools"
  | "settings-machine"
  | "tool-gh"
  | "tool-composio"
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
  /** The buttons of the bubble besides "Ukončit". */
  next: "next" | "done" | null;
  notNow: boolean;
}>;

/** What one stop says (Matěj 2026-10-04): at most ten to twelve words, why
 * it matters and what happens, nothing technical, no "click here" (the ring
 * shows where) and no headings above the title. `apps` names whether Chat
 * and Automate run on this Environment. */
export function tourStop(
  step: TourStep,
  content: ContentFact,
  apps: Readonly<{ chat: boolean; automate: boolean }>,
  copy: Copy,
): TourStop {
  const stop = (
    target: TourTarget,
    title: string,
    text: string | null = null,
    extra: Partial<Pick<TourStop, "next" | "notNow">> = {},
  ): TourStop => ({
    target,
    title,
    text,
    next: extra.next ?? null,
    notNow: extra.notNow ?? false,
  });
  const item =
    content.state === "missing"
      ? content.item
      : content.state === "failed"
        ? content.item
        : null;
  const personal = item?.kind === "personalspace";
  const name =
    item?.kind === "organization"
      ? (item.name ?? item.login)
      : copy.tourOrganization;
  switch (step) {
    case "gear":
      return stop("gear", copy.tourGearTitle, copy.tourGearText);
    case "settings-tools":
      return stop("settings-tools", copy.tourSettingsToolsTitle);
    case "github":
      return stop("tool-gh", copy.tourGithubTitle, copy.tourGithubText);
    case "composio":
      return stop(
        "tool-composio",
        copy.tourComposioTitle,
        copy.tourComposioText,
        {
          notNow: true,
        },
      );
    case "gear-prepare":
      return personal
        ? stop("gear", copy.tourGearPersonalTitle, copy.tourPersonalText)
        : stop(
            "gear",
            fill(copy.tourGearOrganizationTitle, { name }),
            copy.tourOrganizationText,
          );
    case "settings-environment":
      return stop("settings-machine", copy.tourSettingsEnvironmentTitle);
    case "prepare":
      if (content.state === "failed")
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
      return stop("tab-apps", copy.tourAppsTitle, copy.tourAppsText, {
        next: "next",
      });
    case "chat":
      return stop(
        "tab-chat",
        copy.tourChatTitle,
        apps.chat ? copy.tourChatText : copy.tourChatMissingText,
        { next: "next" },
      );
    case "automate":
      return stop(
        "tab-automate",
        copy.tourAutomateTitle,
        apps.automate ? copy.tourAutomateText : copy.tourAutomateMissingText,
        { next: "next" },
      );
    case "settings":
      return stop("gear", copy.tourSettingsTitle, null, { next: "done" });
  }
}

/** What a button of the line starts. `sign-in-gh`: Settings → Nástroje with
 * gh's sign-in open; `install-content`: Settings → Tento Environment with
 * the installation started; `resolve-in-chat`: the prepared prompt handed
 * to Chat. */
export type SetupAction = "sign-in-gh" | "install-content" | "resolve-in-chat";

export type SetupLine = Readonly<{
  tone: "info" | "failed";
  icon: "key" | "download" | "warning";
  text: string;
  actions: readonly Readonly<{ action: SetupAction; label: string }>[];
}>;

/** The line in Apps until the Environment is usable (the wireframe's
 * `SetupBanner`): without GitHub nothing works; with it, its content is
 * missing or its preparation stopped. Only where it signs in as its person,
 * and only what is known: an unknown GitHub says nothing. */
export function appsSetupLine(
  facts: Pick<TourFacts, "preset" | "github" | "content">,
  copy: Copy,
): SetupLine | null {
  if (!signsInAsPerson(facts.preset)) return null;
  if (facts.github === "missing")
    return {
      tone: "info",
      icon: "key",
      text: copy.setupGithub,
      actions: [{ action: "sign-in-gh", label: copy.setupGithubAction }],
    };
  if (facts.github !== "connected") return null;
  const content = facts.content;
  if (content.state === "failed")
    return {
      tone: "failed",
      icon: "warning",
      text: copy.setupFailed,
      actions: [
        { action: "resolve-in-chat", label: copy.setupResolve },
        { action: "install-content", label: copy.setupRetry },
      ],
    };
  if (content.state !== "missing") return null;
  const item = content.item;
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
        text: fill(copy.setupOrganizationMissing, {
          name: item.name ?? item.login,
        }),
        actions: [{ action: "install-content", label: copy.setupDownload }],
      };
}

/** What a link asked the Launchpad to start on arrival, in its fragment
 * (`#lazurio-start=sign-in-gh`, `#lazurio-start=install-content`): from the
 * line in Apps, or from the shell's column head in Chat and Automate. */
export type StartRequest = "sign-in-gh" | "install-content";

export const startParameter = "lazurio-start";

/** Where a start request leads: the Settings section it starts in. */
export const startSection: Readonly<Record<StartRequest, SettingsSection>> = {
  "sign-in-gh": "tools",
  "install-content": "machine",
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
