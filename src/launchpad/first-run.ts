import {
  type PresetName,
  presetNames,
  workspacePreset,
} from "../folder/presets";
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
import type { EntryAudience } from "./public-environment";
import type { SettingsSection } from "./routes";
import type { OrganizationRuleView } from "./tools-view";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// The first run of an Environment: root decision 0188 as reshaped by 0201
// (points 1-3 and 8, plan DEV-6665; the wireframe of
// HumanAndMachine-ai/prototypes-lazurio 1eefc3d, `setup.tsx`,
// `screens/Start.tsx`, `screens/Tour.tsx`). The Environment is usable when it
// has its basics: an AI an agent can work with, GitHub signed in as its
// person (on the Automated Environment as its persona), and its content (the
// Organization, or on the personal Environment the Personalspace).
// Nastavení → Začínáme lists them, in the order AI → GitHub → content, from
// live facts only; nothing about them is stored. Until they exist the
// onboarding shows on every page load: the tour points at the next missing
// basic, Apps says it in one line and the shell's column keeps a quiet
// prompt. "Dokončím později" puts the tour away for this view only. The
// browser keeps only where the introduction after the basics points. It runs
// only where the Environment has the onboarding (`hasOnboarding`). A public
// Environment (root decision 0204, decision F55) has none of it: nobody signs
// in there, so it has no basics, and its tour is the introduction from the
// first visit (`demoOnboarding`). Pure: the DOM is tour.ts, start-panel.ts
// and catalog-panel.ts.

/** The presets whose Environment has the onboarding of root decision 0201:
 * every one whose GitHub is signed in on the Environment itself. A personal
 * Remote Environment, an Organization's work Environment of one person and a
 * workstation sign in as their person. The Automated Environment (the
 * Steward preset, decision F27) is a work Environment of the Organization
 * that its responsible user sets up, signed in as its persona's own account,
 * and has the same onboarding (F27's addendum of 2026-10-30, root decision
 * 0188's addendum of that day). A Team Environment acts through the
 * Organization's Lazurio for GitHub and its hosting prepares it: no
 * Začínáme, tour or line there (0188 point 3). */
export const onboardingPresets = Object.freeze([
  "local",
  "hosted-personal",
  "hosted-organization-personal",
  "hosted-organization-steward",
] as const);

export function hasOnboarding(preset: string | null | undefined): boolean {
  return (onboardingPresets as readonly string[]).includes(preset ?? "");
}

/** Whether the Environment's GitHub is its persona's own account, not the
 * person's (the preset's provider identity `persona-account`: the Steward
 * preset of the Automated Environment, decisions 0169 and F27). Začínáme's
 * GitHub step, its tour stops and the line in Apps say so. */
export function personaGithub(preset: string | null | undefined): boolean {
  return (
    (presetNames as readonly string[]).includes(preset ?? "") &&
    workspacePreset(preset as PresetName).providerIdentity === "persona-account"
  );
}

/** The recorded binding as far as the soft check below reads it: the
 * Organization branch's assignment (src/folder/machine-binding.ts on the
 * server, machine-view.ts `MachineView` in the page). */
type AssignedMachine = Readonly<{
  owner: Readonly<{
    kind: string;
    assignment?: Readonly<{ kind: string; githubLogin?: string }>;
  }>;
}>;

/** The login whose own account does not belong in gh here: on an
 * Environment whose GitHub is its persona's, its responsible user's, as the
 * handover's `owner.assignment` `{kind: "automation"}` names them (decision
 * 0169). Null everywhere else, and where the binding names nobody (a Steward
 * preset chosen explicitly on a work VM without a stated assignment). */
export function responsibleLogin(
  preset: string | null | undefined,
  machine: AssignedMachine | null | undefined,
): string | null {
  if (!personaGithub(preset)) return null;
  const assignment = machine?.owner.assignment;
  return assignment?.kind === "automation" &&
    typeof assignment.githubLogin === "string"
    ? assignment.githubLogin
    : null;
}

/** Whether gh's account is that responsible user's own (GitHub compares
 * logins case-insensitively): the soft check of F27's addendum of
 * 2026-10-30. A renamed login is not caught; any other account passes, since
 * the handover names the user, not the persona. */
export function ownAccount(
  account: string | null | undefined,
  responsible: string | null,
): boolean {
  return (
    responsible !== null &&
    typeof account === "string" &&
    account.toLowerCase() === responsible.toLowerCase()
  );
}

/** Whether GitHub is connected here, by Settings → Nástroje's own reading
 * (the gh row): `unknown` until the reading of the profile now shown has
 * a sign-in, on a shared (Team) Environment, and when gh could not tell.
 * Not installed is `missing`: "Připojit" installs it first. Connected means
 * gh signed in and this Environment reaching GitHub over SSH as that account
 * (decision F19, addendum 2026-10-19, #515): signed in while SSH does not
 * work is `incomplete`, connected badly, which counts as missing (its one
 * action finishes the link); signed in while SSH could not be verified is
 * `unknown`. `own-account`, whatever SSH says: on an Environment whose
 * GitHub is its persona's, gh is signed in as its responsible user's own
 * account (`responsibleLogin`, F27's addendum of 2026-10-30). It counts as
 * missing, and its one action switches the account; it is only this step's
 * state, so no sign-in, tool or route refuses anything by it. */
export type GithubFact =
  | "missing"
  | "incomplete"
  | "own-account"
  | "connected"
  | "unknown";

type ToolsReading =
  | (Pick<ToolsOverview, "revision" | "sharedEnvironment"> &
      Readonly<{
        tools: readonly Pick<ToolOverview, "name" | "installed" | "signIn">[];
      }>)
  | null;

/** `responsible`: the login whose own account does not belong here
 * (`responsibleLogin`), null where any account does. */
export function githubFact(
  overview: ToolsReading,
  currentRevision: number | null,
  responsible: string | null = null,
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
  const signIn = github.signIn;
  if (signIn?.state === "signed-out") return "missing";
  if (signIn?.state !== "signed-in") return "unknown";
  if (ownAccount(signIn.account, responsible)) return "own-account";
  return signIn.ssh?.state === "linked"
    ? "connected"
    : signIn.ssh?.state === "not-linked"
      ? "incomplete"
      : "unknown";
}

/** The GitHub account gh is signed in with, as the same reading names it. */
export function githubAccount(overview: ToolsReading): string | null {
  const github = overview?.tools.find((tool) => tool.name === "gh");
  return github?.signIn?.state === "signed-in"
    ? (github.signIn.account ?? null)
    : null;
}

/** Whether Composio is connected: `none` where Tools do not offer it;
 * `unfinished` where it is signed in, but the organizations' reading says it
 * does not work in the organization of this Environment's Organization's
 * name (missing, there twice, not made current, or the name unreadable;
 * decision F42, note of 2026-10-19), or on a person's own Environment that
 * the account's default organization could not be made current (addendum of
 * 2026-10-26). */
export type ComposioFact = "missing" | "unfinished" | "connected" | "none";

/** `organization` is the rule of the last answer of
 * `/api/tools/composio/organizations` for this sign-in, null until read:
 * then the sign-in says it, as before. */
export function composioFact(
  overview: ToolsReading,
  organization: OrganizationRuleView | null = null,
): ComposioFact {
  const composio = overview?.tools.find((tool) => tool.name === "composio");
  if (composio === undefined) return "none";
  if (composio.signIn?.state !== "signed-in") return "missing";
  return organization === null ||
    organization.kind === "chosen" ||
    ((organization.kind === "named" || organization.kind === "default") &&
      organization.state === "matches")
    ? "connected"
    : "unfinished";
}

/** Začínáme's reading of Composio's organizations for the sign-in of the
 * moment (decision F42, note of 2026-10-19). One read runs at a time; an
 * answer counts only for the sign-in it was read with, and when the sign-in
 * changed while it ran, the reader reads again for the new one, so a sign-in
 * that changes mid-read never keeps "Připojeno" (Pablo's review of #510).
 * `again` reads even when the sign-in already has an answer (Začínáme shown
 * again). */
export function createComposioOrganizationReader(
  options: Readonly<{
    /** Composio's sign-in as the tools' reading names it; null signed out. */
    signIn: () => string | null;
    /** One answer of `/api/tools/composio/organizations`; null unreadable. */
    read: () => Promise<OrganizationRuleView | null>;
    /** An answer was kept: Začínáme draws again. */
    changed: () => void;
  }>,
): Readonly<{
  read: (again: boolean) => Promise<void>;
  rule: () => OrganizationRuleView | null;
}> {
  let last: Readonly<{ signIn: string; rule: OrganizationRuleView }> | null =
    null;
  let reading = false;
  async function read(again: boolean): Promise<void> {
    const signIn = options.signIn();
    if (signIn === null || reading || (!again && last?.signIn === signIn))
      return;
    reading = true;
    let rule: OrganizationRuleView | null = null;
    try {
      rule = await options.read();
    } catch {}
    reading = false;
    last = rule === null ? null : { signIn, rule };
    options.changed();
    // The sign-in changed while this read ran: read for the one of now.
    if (options.signIn() !== signIn) await read(false);
  }
  return {
    read,
    rule: () =>
      last !== null && last.signIn === options.signIn() ? last.rule : null,
  };
}

/** The Environment's AI as the page knows it (`GET /api/ai`, tools/ai.ts):
 * `loading` until the first answer. */
export type AiFact = AiState | "loading";

/** Buddy's basic (decision F65; root decision 0210's night addendum point
 * 10), only where the Environment has him: his own ChatGPT sign-in as
 * Hermes's card says it, and whether the person confirmed his names in
 * "Seznamte se s Buddym". `loading` until `GET /api/buddy` answered. */
export type BuddyFact =
  | "loading"
  | Readonly<{
      signIn: "connected" | "none" | "unknown";
      /** Null where his reading failed: not known either way. */
      confirmed: boolean | null;
    }>;

/** What the first run reads: the preset, and the three basics; `audience`
 * where the recorded entry says the Environment is public (absent
 * elsewhere, as on every Environment before root decision 0204). */
export type TourFacts = Readonly<{
  preset: string | null;
  audience?: EntryAudience | undefined;
  ai: AiFact;
  github: GithubFact;
  content: ContentFact;
  /** Buddy's basic where the Environment has Buddy (an Osobní Prostředí
   * whose entry names his origin); absent everywhere else. */
  buddy?: BuddyFact | undefined;
}>;

/** A public Environment's demo onboarding (root decision 0204's line on
 * 0201, decision F55): no AI, GitHub or vault step, since its visitors sign
 * in to nothing there; Začínáme says what to try, and the tour introduces
 * Apps, Chat and Automate from the first visit. */
export function demoOnboarding(facts: Pick<TourFacts, "audience">): boolean {
  return facts.audience === "public";
}

/** What the demo says of the Environment's AI, from the live AI fact (F55's
 * addendum of 2026-10-20): the Organization's AI where it provides one, a
 * connected AI where a CLI is signed in, and "not connected" only while the
 * AI is missing or not known (`unknown`, or `loading` before the first
 * answer). It never names a model. */
export function demoAi(ai: AiFact): "organization" | "connected" | "none" {
  return ai === "organization" || ai === "connected" ? ai : "none";
}

/** Whether the Environment has the basics of 0201: its preset has the
 * onboarding and it is no public Environment. */
function basicsOnboarding(
  facts: Pick<TourFacts, "preset" | "audience">,
): boolean {
  return hasOnboarding(facts.preset) && !demoOnboarding(facts);
}

/** The basics of 0201 point 1, in their order (point 3). */
export const basics = Object.freeze(["ai", "github", "content"] as const);
/** With Buddy his step comes first (root decision 0210's night addendum
 * point 10): "Seznamte se s Buddym", then the agents' AI. */
export const buddyBasics = Object.freeze([
  "buddy",
  "ai",
  "github",
  "content",
] as const);
export type Basic = (typeof buddyBasics)[number];

/** The basics of this Environment, in their order: four with Buddy, three
 * elsewhere. */
export function basicsOf(facts: Pick<TourFacts, "buddy">): readonly Basic[] {
  return facts.buddy === undefined ? basics : buddyBasics;
}

/** What waits for Buddy's step (the shaping's question Q4, Matěj's to
 * decide; recommended and so set: nothing). His step comes first, so the
 * tour, the line in Apps and the shell's prompt lead to it first, but the
 * agents' AI is offered beside it (`offered`): his sign-in can fail on the
 * account's side (OpenAI may require the sign-in by code to be allowed
 * first), and a hard gate would lock the person out of their agents,
 * GitHub and the Personal Workspace, which Začínáme already avoids for an
 * AI that cannot be read. `after-buddy` would hold the AI step until his
 * step is done, as GitHub waits for the AI. The one place that decides it,
 * with the order in `buddyBasics` and `nextBasic`. */
export const buddyGate: Readonly<{ ai: "offered" | "after-buddy" }> =
  Object.freeze({ ai: "offered" });

/** Whether the AI step waits for Buddy's now, by the gate. */
export function aiHeldByBuddy(
  facts: Pick<TourFacts, "buddy">,
  gate: Readonly<{ ai: "offered" | "after-buddy" }> = buddyGate,
): boolean {
  return (
    gate.ai === "after-buddy" &&
    facts.buddy !== undefined &&
    buddyState(facts.buddy) !== "done"
  );
}

/** Buddy's basic: done only when he is signed in and the person confirmed
 * his names; missing when either is known not to be; not known while it
 * is read, or while his sign-in cannot be read with the names confirmed. */
function buddyState(fact: BuddyFact): "done" | "missing" | "unknown" {
  if (fact === "loading") return "unknown";
  if (fact.signIn === "connected" && fact.confirmed === true) return "done";
  if (fact.signIn === "none" || fact.confirmed === false) return "missing";
  return "unknown";
}

/** What Buddy's step needs next before the person met him (decision F60's
 * addendum of 2026-10-26): `sign-in` until he is signed in, then
 * `introduce`; none once his names are confirmed (a later sign-out
 * included: his own window says that) or while that is not known. */
export function buddyNextOf(
  fact: BuddyFact,
): "sign-in" | "introduce" | undefined {
  if (fact === "loading" || fact.confirmed !== false) return undefined;
  return fact.signIn === "connected" ? "introduce" : "sign-in";
}

/** One basic: done (provided ahead counts), missing, or not known. */
export function basicState(
  facts: TourFacts,
  basic: Basic,
): "done" | "missing" | "unknown" {
  // Without Buddy here his basic is none to do.
  if (basic === "buddy")
    return facts.buddy === undefined ? "done" : buddyState(facts.buddy);
  if (basic === "ai")
    return facts.ai === "organization" || facts.ai === "connected"
      ? "done"
      : facts.ai === "missing"
        ? "missing"
        : "unknown";
  if (basic === "github")
    return facts.github === "connected"
      ? "done"
      : githubMissing(facts.github)
        ? "missing"
        : "unknown";
  const content = facts.content.state;
  return content === "ready" || content === "none"
    ? "done"
    : content === "missing" || content === "failed"
      ? "missing"
      : "unknown";
}

/** GitHub known not to be there as it belongs: signed out or not installed,
 * connected badly (#515), or signed in as the responsible user's own account
 * where the persona's belongs (F27's addendum of 2026-10-30). */
export const githubMissing = (fact: GithubFact): boolean =>
  fact === "missing" || fact === "incomplete" || fact === "own-account";

/** How many basics are done, for "Dokončit nastavení (1 ze 3)", with Buddy
 * "(1 ze 4)". */
export function basicsDone(facts: TourFacts): number {
  return basicsOf(facts).filter((basic) => basicState(facts, basic) === "done")
    .length;
}

/** The first basic still missing, in the order Buddy (where he is) → AI →
 * GitHub → content; null when all are there (or the Environment has no
 * first run); undefined while one that decides it is not known yet. Buddy
 * and the AI before their first answer, an unknown GitHub and an unread
 * content wait; an AI that could not be read (`unknown`) is never claimed
 * missing, so it does not hold the rest, and neither does a Buddy whose
 * sign-in cannot be read once his names are confirmed. */
export function nextBasic(facts: TourFacts): Basic | null | undefined {
  if (!basicsOnboarding(facts)) return null;
  if (facts.buddy !== undefined) {
    if (facts.buddy === "loading") return undefined;
    if (buddyState(facts.buddy) === "missing") return "buddy";
  }
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
  | "buddy"
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
  // A visitor of a public Environment is new to it on every first visit.
  if (demoOnboarding(facts)) return freshTourProgress;
  const next = nextBasic(facts);
  if (!hasOnboarding(facts.preset) || next === undefined) return null;
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
  // A public Environment has no basics: only the introduction.
  if (demoOnboarding(facts))
    return progress === null ? null : (tourIntro[progress.intro] ?? null);
  if (!hasOnboarding(facts.preset)) return null;
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
  | "start-buddy"
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
   * dozen words. Null where the title says enough: the bubble shows no
   * line under it. */
  text: string | null;
  /** The primary button of the bubble: on the introduction's stops. */
  next: "next" | "done" | null;
  /** "Dokončím později": everywhere but the introduction's last stop. */
  later: boolean;
}>;

/** What one stop says (Matěj 2026-10-04): at most ten to twelve words, why
 * it matters and what happens, nothing technical, no "click here" (the ring
 * shows where) and no headings above the title. `apps` names whether Chat
 * and Automate run on this Environment; on a public Environment the Apps
 * stop says the modules are the Organization's and Chat's stop that its AI
 * is not connected. */
export function tourStop(
  step: TourStep,
  facts: Pick<
    TourFacts,
    "preset" | "audience" | "ai" | "github" | "content" | "buddy"
  >,
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
  // The persona's account belongs on its Environment (F27's addendum of
  // 2026-10-30).
  const persona = personaGithub(facts.preset);
  switch (step) {
    case "gear": {
      const next = nextBasic(facts);
      // The title alone, as Začínáme's AI step (Matěj 2026-10-16: "méně je
      // více").
      if (next === "buddy") return stop("gear", copy.tourGearBuddyTitle, null);
      if (next === "ai") return stop("gear", copy.tourGearAiTitle, null);
      if (next === "github")
        return persona
          ? stop(
              "gear",
              copy.tourGearGithubPersonaTitle,
              copy.tourGearGithubPersonaText,
            )
          : stop("gear", copy.tourGearGithubTitle, copy.tourGearGithubText);
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
    case "buddy":
      return stop("start-buddy", copy.tourBuddyTitle, copy.tourBuddyText);
    case "ai":
      return stop("start-ai", copy.tourAiTitle, copy.tourAiText);
    case "github":
      return persona
        ? stop(
            "start-github",
            copy.tourGithubPersonaTitle,
            copy.tourGithubPersonaText,
          )
        : stop("start-github", copy.tourGithubTitle, copy.tourGithubText);
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
      // A visitor's modules are the Organization's, not theirs.
      return stop(
        "tab-apps",
        copy.tourAppsTitle,
        demoOnboarding(facts) ? copy.demoAppsText : copy.tourAppsText,
        "next",
      );
    case "chat":
      return stop(
        "tab-chat",
        copy.tourChatTitle,
        !apps.chat
          ? copy.tourChatMissingText
          : demoOnboarding(facts)
            ? {
                organization: copy.tourChatDemoOrganizationText,
                connected: copy.tourChatDemoConnectedText,
                none: copy.tourChatDemoText,
              }[demoAi(facts.ai)]
            : copy.tourChatText,
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

/** What must come before the content may be installed (root decision 0201
 * point 3), the one rule of every start: the button and "Zkusit znovu" of
 * the content, the line in Apps, a start request in the address, the start
 * after GitHub and the install route itself. Where the Environment has the
 * onboarding (the Automated one included, F27's addendum of 2026-10-30):
 * `ai` while its AI is provably missing (every CLI answered so), `github`
 * while GitHub is not connected, `unknown` while either is not read yet. An
 * AI that could not be checked (`unknown`: a CLI did not answer) does not
 * hold the content back, as it holds nothing else back: a timeout must not
 * lock an Environment out of its content, and a stop then leads to Chat.
 * GitHub connected badly (`incomplete`: signed in, SSH not working, #515)
 * holds it back as a missing one does: the download clones over SSH and
 * would fail. So does the responsible user's own account where the
 * persona's belongs (`own-account`): the content's turn follows the GitHub
 * step, and it would be cloned with that user's rights. Elsewhere (a Team
 * Environment, whose basics are the Organization's) and on a public
 * Environment, whose visitors sign in to nothing, only a known missing
 * GitHub does. Null: it may start. */
export type ContentBlock = "ai" | "github" | "unknown";

export function contentBlockedBy(
  facts: Pick<TourFacts, "preset" | "audience" | "ai" | "github">,
): ContentBlock | null {
  if (!basicsOnboarding(facts))
    return facts.github === "missing" ? "github" : null;
  if (facts.ai === "missing") return "ai";
  if (facts.ai === "loading") return "unknown";
  if (githubMissing(facts.github)) return "github";
  if (facts.github === "unknown") return "unknown";
  return null;
}

/** What this view remembers for the start of the content by itself (root
 * decision 0201 point 3): the last known state of the AI and of GitHub (a
 * reading that cannot tell, such as GitHub's while the profile's revision
 * moves, changes nothing), and whether it saw either arrive. In memory only,
 * for this view: never stored. */
export type AutoStart = Readonly<{
  ai: boolean | null;
  github: boolean | null;
  armed: boolean;
}>;

export const idleAutoStart: AutoStart = Object.freeze({
  ai: null,
  github: null,
  armed: false,
});

/** One step of the start by itself, on every new reading of the facts. Once
 * this view saw GitHub or the AI arrive (from missing to there: what was
 * there already when the page loaded starts nothing), the content starts as
 * soon as both are there, whichever came last: the same rule as every other
 * start (`contentBlockedBy` null) with the content missing. It stays armed
 * while that turn has not come, a fact is not read yet or a run is under
 * way, and ends without a start only where there is nothing to start: the
 * content here, nothing to prepare, or a stop (never after a stop). Only
 * where the Environment has its first run. */
export function autoStartStep(
  state: AutoStart,
  facts: TourFacts,
  running: boolean,
): Readonly<{ state: AutoStart; start: boolean }> {
  const known = (basic: "ai" | "github", before: boolean | null) => {
    const now = basicState(facts, basic);
    return now === "unknown" ? before : now === "done";
  };
  const ai = known("ai", state.ai);
  const github = known("github", state.github);
  const arrived =
    (state.ai === false && ai === true) ||
    (state.github === false && github === true);
  const next = (armed: boolean): AutoStart =>
    Object.freeze({ ai, github, armed });
  if (!basicsOnboarding(facts)) return { state: next(false), start: false };
  const armed = state.armed || arrived;
  if (!armed) return { state: next(false), start: false };
  const content = facts.content.state;
  if (content === "ready" || content === "none" || content === "failed")
    return { state: next(false), start: false };
  if (content !== "missing" || running || contentBlockedBy(facts) !== null)
    return { state: next(true), start: false };
  return { state: next(false), start: true };
}

/** What a start request of the address (`#lazurio-start=…`, from the line
 * in Apps or an older shell's link) does once the page is on Začínáme:
 * `wait` until what decides it is read; `drop` it; `open-ai` drops it and
 * shows the AI step; `sign-in-gh` opens gh's sign-in, which for a signed-in
 * gh whose SSH does not work here is its SSH link (`incomplete`, #515;
 * tools-view `signInMode`); `install` starts the installation. GitHub's
 * sign-in waits for AI as Začínáme offers it, and the installation for its
 * turn (`contentBlockedBy`). The responsible user's own account where the
 * persona's belongs (`own-account`) is dropped: switching it signs that
 * account out, which only the step's own "Přepnout účet" does, never a
 * link. */
export type StartDecision =
  | "wait"
  | "drop"
  | "open-ai"
  | "sign-in-gh"
  | "install"
  | "meet-buddy";

export function startDecision(
  request: StartRequest,
  facts: TourFacts,
): StartDecision {
  if (!basicsOnboarding(facts)) return "drop";
  // Buddy's bubble before the meeting (decision F60's addendum of
  // 2026-10-26): his dialog, where his step stands, only where he is and
  // only until his names are confirmed. A reading that failed opens it too,
  // and the dialog says what it knows. Nothing starts by itself: a sign-in
  // code is asked for in the dialog, never by a link.
  if (request === "meet-buddy") {
    if (facts.buddy === undefined) return "drop";
    if (facts.buddy === "loading") return "wait";
    return facts.buddy.confirmed === true ? "drop" : "meet-buddy";
  }
  if (request === "sign-in-gh") {
    if (facts.github === "unknown" || facts.ai === "loading") return "wait";
    if (facts.ai === "missing") return "open-ai";
    return facts.github === "connected" || facts.github === "own-account"
      ? "drop"
      : "sign-in-gh";
  }
  const content = facts.content.state;
  if (content === "loading" || content === "unknown") return "wait";
  const blocked = contentBlockedBy(facts);
  if (blocked === "unknown") return "wait";
  if (blocked === "ai") return "open-ai";
  if (blocked === "github") return "drop";
  return content === "missing" || content === "failed" ? "install" : "drop";
}

/** Where a stopped preparation leads (0201 points 3 and 8): Chat with the
 * prepared prompt when an agent can work; the AI step when no AI is
 * connected; and for an Organization that is not prepared for this version
 * (`unpreparedCodes`), to someone who cannot write its root repository
 * (`rootAccess` not confirmed, which includes not known yet), only the
 * sentence that its Admin prepares it. An AI not known yet is not claimed
 * missing. On a public Environment, whose visitors connect no AI and fix
 * nothing of the Organization, it is always that sentence (decision F55). */
export function resolveOf(
  input: Readonly<{
    ai: AiFact;
    code: string | null;
    rootAccess: boolean | null;
    audience?: EntryAudience | undefined;
  }>,
): Resolve {
  if (demoOnboarding(input)) return "admin";
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
 * Only where the Environment has the onboarding, and only what is known. On
 * the Automated Environment GitHub's line names the persona's account, and
 * the responsible user's own account leads to Začínáme's step, which
 * switches it (F27's addendum of 2026-10-30), as "Připojit AI" leads to the
 * AI step. */
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
  if (next === "buddy")
    return {
      tone: "info",
      icon: "sparks",
      text: copy.setupBuddy,
      actions: [{ action: "open-start", label: copy.setupBuddyAction }],
    };
  if (next === "ai")
    return {
      tone: "info",
      icon: "sparks",
      text: copy.setupAi,
      actions: [{ action: "open-start", label: copy.setupAiAction }],
    };
  if (next === "github") {
    if (facts.github === "own-account")
      return {
        tone: "info",
        icon: "key",
        text: copy.setupGithubOwnAccount,
        actions: [{ action: "open-start", label: copy.setupGithubSwitch }],
      };
    // Connected badly (#515): it does not work, and it connects again.
    return facts.github === "incomplete"
      ? {
          tone: "info",
          icon: "key",
          text: copy.setupGithubBroken,
          actions: [{ action: "sign-in-gh", label: copy.setupGithubReconnect }],
        }
      : {
          tone: "info",
          icon: "key",
          text: personaGithub(facts.preset)
            ? copy.setupGithubPersona
            : copy.setupGithub,
          actions: [{ action: "sign-in-gh", label: copy.setupGithubAction }],
        };
  }
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
    // Without AI there is nothing to try again before it (0201 point 3).
    return {
      tone: "failed",
      icon: "warning",
      text: copy.setupFailed,
      actions:
        resolve === "ai"
          ? [{ action: "open-start", label: copy.setupAiAction }]
          : [{ action: "resolve-in-chat", label: copy.setupResolve }, retry],
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
 * 0201): undefined where the preset has no onboarding, on a public
 * Environment (decision F55) or while GitHub's state is not known; `ai` only
 * when it is known. GitHub connected badly (#515) and the responsible user's
 * own account where the persona's belongs are `missing` there:
 * `lazurio.shell.v1` knows connected or missing, and the prompt leads to
 * Začínáme, which says the rest. The server's document and the Launchpad
 * page's own column head both draw from it. */
export function shellSetup(
  input: Readonly<{
    preset: string;
    audience?: EntryAudience | undefined;
    ai: AiFact;
    github: GithubFact;
    list: ContentList | null;
    job: ContentJob | null;
    /** Buddy's basic where the Environment has him (decision F65). */
    buddy?: BuddyFact | undefined;
  }>,
): ShellSetup | undefined {
  if (!basicsOnboarding(input) || input.github === "unknown") return undefined;
  const fact = contentFact(input.list, input.job);
  const buddy =
    input.buddy === undefined
      ? undefined
      : { done: "ready", missing: "missing", unknown: "unknown" }[
          buddyState(input.buddy)
        ];
  // What his step needs next, for his bubble before the meeting.
  const buddyNext =
    input.buddy === undefined ? undefined : buddyNextOf(input.buddy);
  const base = {
    ...(buddy === undefined
      ? {}
      : { buddy: buddy as "ready" | "missing" | "unknown" }),
    ...(buddyNext === undefined ? {} : { buddyNext }),
    ...(input.ai === "organization" || input.ai === "connected"
      ? { ai: "ready" as const }
      : input.ai === "missing"
        ? { ai: "missing" as const }
        : {}),
    github: input.github === "connected" ? "connected" : "missing",
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

/** The server's `setup` with Buddy's members from this page's own reading,
 * for while GitHub's state is not known here (decision F60's addendum of
 * 2026-10-26): his bubble on this page follows his meeting at once, and
 * nothing is said about GitHub that the server did not say. */
export function withBuddySetup(
  setup: ShellSetup,
  buddy: BuddyFact,
): ShellSetup {
  const { buddy: _state, buddyNext: _next, ...rest } = setup;
  const state = (
    { done: "ready", missing: "missing", unknown: "unknown" } as const
  )[buddyState(buddy)];
  const next = buddyNextOf(buddy);
  return Object.freeze({
    buddy: state,
    ...(next === undefined ? {} : { buddyNext: next }),
    ...rest,
  });
}

/** What a link asked the Launchpad to start on arrival, in its fragment
 * (`#lazurio-start=sign-in-gh`, `#lazurio-start=install-content`): from the
 * line in Apps, or from an older shell's column head in Chat and Automate;
 * `#lazurio-start=meet-buddy` from Buddy's bubble before the meeting, in any
 * app of his Osobní Prostředí (decision F60's addendum of 2026-10-26). */
export type StartRequest = "sign-in-gh" | "install-content" | "meet-buddy";

export const startParameter = "lazurio-start";

const startRequests: readonly string[] = Object.freeze([
  "sign-in-gh",
  "install-content",
  "meet-buddy",
]);

/** Whether a value names a start request; anything else is ignored. */
export const isStartRequest = (value: unknown): value is StartRequest =>
  typeof value === "string" && startRequests.includes(value);

/** Where a start request leads: Začínáme, where the sign-in, the
 * installation and Buddy's step are steps (0201). A link of an older shell
 * to Nástroje or Toto Prostředí lands there too. */
export const startSection: Readonly<Record<StartRequest, SettingsSection>> = {
  "sign-in-gh": "start",
  "install-content": "start",
  "meet-buddy": "start",
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
      if (isStartRequest(value)) start = value;
      continue;
    }
    if (part !== "") rest.push(part);
  }
  return { token: rest.join("&"), start };
}
