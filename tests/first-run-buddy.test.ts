import { expect, test } from "bun:test";
import type { BuddyPersonaShown } from "../src/buddy/persona-save";
import type { BuddyReading } from "../src/launchpad/buddy-view";
import type { ContentItem, ContentList } from "../src/launchpad/content-client";
import type { ContentFact } from "../src/launchpad/content-view";
import {
  aiHeldByBuddy,
  appsSetupLine,
  type BuddyFact,
  basicState,
  basicsDone,
  basicsOf,
  buddyGate,
  contentBlockedBy,
  firstProgress,
  freshTourProgress,
  nextBasic,
  shellSetup,
  type TourFacts,
  tourStep,
  tourStop,
} from "../src/launchpad/first-run";
import { pageGuide } from "../src/launchpad/guides";
import { messages } from "../src/launchpad/messages";
import {
  type StartFacts,
  startCount,
  startView,
} from "../src/launchpad/start-view";
import { parseShellSetup } from "../src/shell/contract";
import { shellMessages } from "../src/shell/messages";
import { columnSetupPrompt } from "../src/shell/view";

// Decision F65 in the first run: on an Osobní Prostředí with Buddy his step
// "Seznamte se s Buddym" is the first of four basics (root decision 0210's
// night addendum point 10), done only when he is signed in and the person
// confirmed his names; elsewhere the basics stay three. The order leads the
// tour, the line in Apps and the shell's prompt to Buddy first, but the
// agents' AI is not locked behind him (the shaping's Q4, `buddyGate`).

const cs = messages("cs");
const en = messages("en");
const personalspace: ContentItem = {
  kind: "personalspace",
  login: "octocat",
  state: "absent",
};
const missing: ContentFact = { state: "missing", item: personalspace };
const list: ContentList = { allowed: true, items: [personalspace] };

const fact = (
  signIn: "connected" | "none" | "unknown",
  confirmed: boolean,
): BuddyFact => ({ signIn, confirmed });

const tour = (overrides: Partial<TourFacts> = {}): TourFacts => ({
  preset: "hosted-personal",
  ai: "missing",
  github: "missing",
  content: missing,
  ...overrides,
});

const persona = (confirmed: boolean): BuddyPersonaShown => ({
  buddyName: "Rex",
  address: "vy",
  user: { nominative: "Bob", accusative: "Boba", dative: "Bobovi" },
  confirmed,
  revision: "b".repeat(64),
  pending: false,
});

test("four basics with Buddy, three elsewhere; the count follows", () => {
  expect(basicsOf(tour())).toEqual(["ai", "github", "content"]);
  expect(basicsOf(tour({ buddy: "loading" }))).toEqual([
    "buddy",
    "ai",
    "github",
    "content",
  ]);
  expect(startCount(tour())).toBe("0/3");
  expect(startCount(tour({ buddy: fact("none", false) }))).toBe("0/4");
  expect(
    startCount(tour({ buddy: fact("connected", true), ai: "connected" })),
  ).toBe("2/4");
  expect(
    basicsDone(
      tour({
        buddy: fact("connected", true),
        ai: "connected",
        github: "connected",
        content: { state: "ready" },
      }),
    ),
  ).toBe(4);
  // Without Buddy here his basic is nothing to do.
  expect(basicState(tour(), "buddy")).toBe("done");
});

test("Buddy's basic is done only when he is signed in and his names are confirmed", () => {
  const state = (buddy: BuddyFact) => basicState(tour({ buddy }), "buddy");
  expect(state(fact("connected", true))).toBe("done");
  expect(state(fact("connected", false))).toBe("missing");
  expect(state(fact("none", true))).toBe("missing");
  expect(state(fact("none", false))).toBe("missing");
  // Not confirmed is known, whatever his sign-in reads.
  expect(state(fact("unknown", false))).toBe("missing");
  // Confirmed while his sign-in cannot be read: not known, no claim; and a
  // reading that failed knows nothing of his names either.
  expect(state(fact("unknown", true))).toBe("unknown");
  expect(state({ signIn: "unknown", confirmed: null })).toBe("unknown");
  expect(
    nextBasic(tour({ buddy: { signIn: "unknown", confirmed: null } })),
  ).toBe("ai");
  expect(state("loading")).toBe("unknown");
});

test("the order: Buddy first, then the AI, GitHub and the content; not known yet waits; a Buddy that cannot be read holds nothing", () => {
  expect(nextBasic(tour({ buddy: fact("none", false) }))).toBe("buddy");
  expect(nextBasic(tour({ buddy: "loading" }))).toBeUndefined();
  expect(nextBasic(tour({ buddy: fact("connected", true) }))).toBe("ai");
  expect(nextBasic(tour({ buddy: fact("unknown", true) }))).toBe("ai");
  expect(
    nextBasic(
      tour({
        buddy: fact("connected", false),
        ai: "connected",
        github: "connected",
        content: { state: "ready" },
      }),
    ),
  ).toBe("buddy");
  expect(nextBasic(tour())).toBe("ai");
  // A work Environment has no Buddy and keeps its three.
  expect(nextBasic(tour({ preset: "hosted-organization-personal" }))).toBe(
    "ai",
  );
  expect(firstProgress(tour({ buddy: "loading" }))).toBeNull();
  expect(firstProgress(tour({ buddy: fact("none", false) }))).toEqual(
    freshTourProgress,
  );
});

test("the agents' AI is not locked behind Buddy: offered beside his step, the content's turn as before; the gate is one place", () => {
  expect(buddyGate).toEqual({ ai: "offered" });
  const facts = tour({ buddy: fact("none", false) });
  expect(aiHeldByBuddy(facts)).toBe(false);
  expect(aiHeldByBuddy(facts, { ai: "after-buddy" })).toBe(true);
  expect(
    aiHeldByBuddy(tour({ buddy: fact("connected", true) }), {
      ai: "after-buddy",
    }),
  ).toBe(false);
  expect(aiHeldByBuddy(tour(), { ai: "after-buddy" })).toBe(false);
  // The content waits for the AI and GitHub, never for Buddy.
  expect(
    contentBlockedBy({ ...facts, ai: "connected", github: "connected" }),
  ).toBeNull();
  const start: StartFacts = {
    ...facts,
    aiReading: { state: "missing", providers: [] },
    githubLogin: null,
    list,
    buddyStep: {
      reading: {
        state: "waits",
        signIn: "none",
        persona: persona(false),
      } satisfies BuddyReading,
      signIn: { kind: "idle" },
      now: 0,
    },
  };
  const view = startView(start, cs);
  expect(view?.steps.map((step) => [step.basic, step.mark])).toEqual([
    ["buddy", "now"],
    ["ai", "now"],
    ["github", "later"],
    ["content", "later"],
  ]);
  // The AI step offers its two sign-ins while Buddy's step is missing.
  expect(view?.ai.kind).toBe("choose");
  expect(view?.intro).toBe("Hotovo 0 ze 4 kroků.");
  expect(view?.total).toBe(4);
  expect(view?.steps[0]?.title).toBe("Seznamte se s Buddym");
  expect(view?.buddy?.action).toBe("sign-in");
  // Without Buddy: three steps, no Buddy view.
  const { buddy: _buddy, buddyStep: _step, ...elsewhere } = start;
  const without = startView(elsewhere, cs);
  expect(without?.steps.map((step) => step.basic)).toEqual([
    "ai",
    "github",
    "content",
  ]);
  expect(without?.buddy).toBeNull();
  expect(without?.intro).toBe("Hotovo 0 ze 3 kroků.");
});

test("the tour and the line in Apps lead to Buddy first; each stop at most a dozen words", () => {
  const facts = tour({ buddy: fact("none", false) });
  expect(tourStep(facts, freshTourProgress, null)).toBe("gear");
  expect(tourStep(facts, freshTourProgress, "start")).toBe("buddy");
  const apps = { chat: true, automate: true };
  expect(tourStop("gear", facts, apps, cs)).toEqual({
    target: "gear",
    title: "Nejdřív se seznamte s Buddym",
    text: null,
    next: null,
    later: true,
  });
  const stop = tourStop("buddy", facts, apps, cs);
  expect(stop).toEqual({
    target: "start-buddy",
    title: "Seznamte se s Buddym",
    text: "Přihlaste ho a řekněte, jak vám má říkat.",
    next: null,
    later: true,
  });
  for (const copy of [cs, en]) {
    const words = tourStop("buddy", facts, apps, copy);
    expect(
      `${words.title} ${words.text ?? ""}`.trim().split(/\s+/).length,
    ).toBeLessThanOrEqual(12);
  }
  expect(appsSetupLine(facts, cs)).toEqual({
    tone: "info",
    icon: "sparks",
    text: "Buddy na vás čeká.",
    actions: [{ action: "open-start", label: "Seznámit se" }],
  });
});

test("the shell's prompt counts four with Buddy: his step in its document, additive in v1", () => {
  const read = {
    preset: "hosted-personal",
    ai: "connected" as const,
    github: "connected" as const,
    list,
    job: null,
  };
  expect(shellSetup({ ...read, buddy: fact("none", false) })).toMatchObject({
    buddy: "missing",
  });
  expect(shellSetup({ ...read, buddy: fact("connected", true) })).toMatchObject(
    { buddy: "ready" },
  );
  expect(shellSetup({ ...read, buddy: fact("unknown", true) })).toMatchObject({
    buddy: "unknown",
  });
  expect(shellSetup(read)).not.toHaveProperty("buddy");
  expect(parseShellSetup({ github: "connected", buddy: "missing" })).toEqual({
    buddy: "missing",
    github: "connected",
  });
  expect(parseShellSetup({ github: "connected", buddy: "later" })).toBe(false);
  const environment = "personal-example";
  const shell = (setup: Record<string, unknown>) =>
    ({
      current: environment,
      environments: [
        {
          id: environment,
          kind: "personal",
          apps: { apps: "/", chat: null, automate: null },
        },
      ],
      setup,
    }) as unknown as Parameters<typeof columnSetupPrompt>[0];
  const prompt = columnSetupPrompt(
    shell({ buddy: "missing", ai: "ready", github: "connected" }),
    shellMessages("cs"),
    "apps",
  );
  expect(prompt).toMatchObject({ done: 2, total: 4 });
  expect(prompt?.text).toBe("Dokončit nastavení (2 ze 4)");
  expect(
    columnSetupPrompt(
      shell({ ai: "missing", github: "connected" }),
      shellMessages("cs"),
      "apps",
    ),
  ).toMatchObject({ done: 1, total: 3 });
});

test("the guide of Začínáme with Buddy has four stops, his step among them; Nastavení → Buddy has its own", () => {
  const facts = {
    kind: "personal" as const,
    locale: "cs" as const,
    composio: null,
    vault: { vault: null, person: null },
    start: "basics" as const,
    tools: null,
  };
  const start = pageGuide(
    { view: "settings", section: "start" },
    { ...facts, buddy: true },
    cs,
  );
  expect(start.help).toBe("settings-start-buddy");
  expect(start.guides[0]?.steps.map((step) => step.at)).toEqual([
    "start-steps",
    "start-buddy",
    "start-ai",
    "start-github",
  ]);
  expect(
    pageGuide({ view: "settings", section: "start" }, facts, cs).help,
  ).toBe("settings-start");
  const buddy = pageGuide(
    { view: "settings", section: "buddy" },
    { ...facts, buddy: true },
    cs,
  );
  expect(buddy.help).toBe("settings-buddy");
  expect(buddy.guides[0]?.steps.map((step) => step.at)).toEqual([
    "buddy-state",
    "buddy-persona",
  ]);
  expect(
    pageGuide({ view: "settings", section: "buddy" }, facts, cs).help,
  ).toBeNull();
});
