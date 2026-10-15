import { expect, test } from "bun:test";
import type { ContentItem } from "../src/launchpad/content-client";
import { type ContentFact, contentFact } from "../src/launchpad/content-view";
import {
  appsSetupLine,
  basicsDone,
  composioFact,
  finishedTourProgress,
  firstProgress,
  freshTourProgress,
  githubFact,
  nextBasic,
  parseTourProgress,
  readFragment,
  resolveOf,
  signsInAsPerson,
  startSection,
  type TourFacts,
  type TourProgress,
  tourAdvance,
  tourIntro,
  tourStep,
  tourStop,
  tourStorageKey,
} from "../src/launchpad/first-run";
import { messages } from "../src/launchpad/messages";

// The first run of an Environment: root decision 0188 as reshaped by 0201
// (points 1-3 and 8), ported from the wireframe's rules (prototypes-lazurio
// 1eefc3d, `setup.test.ts`) onto the Launchpad's facts: the preset, the AI
// as `GET /api/ai` reads it, gh's sign-in as Settings → Nástroje reads it,
// and the content as the content routes answer.

const cs = messages("cs");
const en = messages("en");

const organization: ContentItem = {
  kind: "organization",
  login: "example",
  name: "Example Company",
  state: "absent",
};
const personalspace: ContentItem = {
  kind: "personalspace",
  login: "octocat",
  state: "absent",
  onGitHub: "exists",
};
const missing = (item: ContentItem): ContentFact => ({
  state: "missing",
  item,
});
const failed = (item: ContentItem, code = "clone-failed"): ContentFact => ({
  state: "failed",
  item,
  job: {
    id: "job-1",
    state: "failed",
    steps: [],
    failure: {
      item:
        item.kind === "organization"
          ? { kind: "organization", login: item.login }
          : { kind: "personalspace", login: item.login },
      key: "access",
      code,
      detail: "",
    },
  },
});
const ready: ContentFact = { state: "ready" };

const fresh = (
  preset: string,
  overrides: Partial<TourFacts> = {},
): TourFacts => ({
  preset,
  ai: "missing",
  github: "missing",
  content: missing(preset === "hosted-personal" ? personalspace : organization),
  ...overrides,
});
const P = freshTourProgress;

test("only Environments that sign in to GitHub as their person get the first run", () => {
  expect(signsInAsPerson("hosted-personal")).toBe(true);
  expect(signsInAsPerson("hosted-organization-personal")).toBe(true);
  expect(signsInAsPerson("local")).toBe(true);
  // A Team's Environment acts through the Organization's app, a Steward's
  // (Automated) one as its persona: their basics are the Organization's.
  for (const preset of [
    "hosted-organization-team",
    "hosted-organization-steward",
    "",
    null,
  ]) {
    expect(signsInAsPerson(preset)).toBe(false);
    expect(nextBasic(fresh(preset as string))).toBeNull();
    expect(tourStep(fresh(preset as string), P, null)).toBeNull();
    expect(appsSetupLine(fresh(preset as string), cs)).toBeNull();
  }
});

test("the basics in the order AI → GitHub → content (0201 point 3)", () => {
  const facts = fresh("hosted-organization-personal");
  expect(nextBasic(facts)).toBe("ai");
  expect(basicsDone(facts)).toBe(0);
  // GitHub comes only after AI, even when the content is already missing.
  expect(nextBasic({ ...facts, ai: "connected" })).toBe("github");
  expect(basicsDone({ ...facts, ai: "connected" })).toBe(1);
  // The Organization's AI pool counts as done without the person.
  expect(nextBasic({ ...facts, ai: "organization" })).toBe("github");
  expect(nextBasic({ ...facts, ai: "organization", github: "connected" })).toBe(
    "content",
  );
  expect(
    nextBasic({
      ...facts,
      ai: "connected",
      github: "connected",
      content: failed(organization),
    }),
  ).toBe("content");
  const usable = { ...facts, ai: "connected", github: "connected" } as const;
  expect(nextBasic({ ...usable, content: ready })).toBeNull();
  expect(basicsDone({ ...usable, content: ready })).toBe(3);
  // Nothing to prepare here is done too.
  expect(nextBasic({ ...usable, content: { state: "none" } })).toBeNull();
});

test("a basic not known yet waits; an AI that could not be read holds nothing", () => {
  expect(nextBasic(fresh("local", { ai: "loading" }))).toBeUndefined();
  expect(
    nextBasic(fresh("local", { ai: "connected", github: "unknown" })),
  ).toBeUndefined();
  expect(
    nextBasic(
      fresh("local", {
        ai: "connected",
        github: "connected",
        content: { state: "loading" },
      }),
    ),
  ).toBeUndefined();
  // Unknown is never claimed missing: the next known basic leads.
  expect(nextBasic(fresh("local", { ai: "unknown" }))).toBe("github");
  expect(basicsDone(fresh("local", { ai: "unknown" }))).toBe(0);
});

test("the tour leads gear → Začínáme → the next missing basic there", () => {
  const facts = fresh("hosted-personal");
  expect(tourStep(facts, P, null)).toBe("gear");
  expect(tourStep(facts, P, "general")).toBe("settings-start");
  expect(tourStep(facts, P, "tools")).toBe("settings-start");
  expect(tourStep(facts, P, "start")).toBe("ai");
  const withAi = { ...facts, ai: "connected" } as const;
  expect(tourStep(withAi, P, null)).toBe("gear");
  expect(tourStep(withAi, P, "start")).toBe("github");
  const withGithub = { ...withAi, github: "connected" } as const;
  expect(tourStep(withGithub, P, "machine")).toBe("settings-start");
  expect(tourStep(withGithub, P, "start")).toBe("prepare");
  // A stop points there too: Začínáme says what next.
  const stopped = { ...withGithub, content: failed(personalspace) };
  expect(tourStep(stopped, P, null)).toBe("gear");
  expect(tourStep(stopped, P, "start")).toBe("prepare");
  // The browser's progress does not matter while a basic is missing: a
  // finished introduction, or none stored yet.
  expect(tourStep(facts, finishedTourProgress, null)).toBe("gear");
  expect(tourStep(facts, null, null)).toBe("gear");
});

test("once the basics are there, the introduction runs: Apps, Chat, Automate, the gear", () => {
  const facts = fresh("hosted-organization-personal", {
    ai: "organization",
    github: "connected",
    content: ready,
  });
  expect(tourStep(facts, P, null)).toBe("apps");
  expect(
    tourIntro.map((_, intro) => tourStep(facts, { intro }, "tools")),
  ).toEqual(["apps", "chat", "automate", "settings"]);
  // "Další" moves on; "Hotovo" on the last stop ends it.
  let progress: TourProgress = P;
  for (const step of tourIntro) progress = tourAdvance(progress, step);
  expect(progress).toEqual(finishedTourProgress);
  expect(tourStep(facts, progress, null)).toBeNull();
  // A stop of the basics never moves the introduction.
  expect(tourAdvance(P, "gear")).toEqual(P);
  // Not known yet: nothing.
  expect(tourStep(facts, null, null)).toBeNull();
});

test("the browser keeps only where the introduction points (0201 point 2)", () => {
  expect(tourStorageKey("vm-01.example")).toBe("lazurio.tour:vm-01.example");
  expect(parseTourProgress(JSON.stringify({ intro: 2 }))).toEqual({
    intro: 2,
  });
  // The first run of 0188 stored more: its place stays, done or put away
  // ("Ukončit") counts as seen, and nothing about the basics survives.
  expect(
    parseTourProgress(
      JSON.stringify({ composio: "skipped", intro: 2, done: false }),
    ),
  ).toEqual({ intro: 2 });
  expect(
    parseTourProgress(JSON.stringify({ composio: null, intro: 0, done: true })),
  ).toEqual(finishedTourProgress);
  for (const raw of [
    null,
    "",
    "nonsense",
    "[]",
    JSON.stringify({ intro: 9 }),
    JSON.stringify({ intro: 1.5 }),
    JSON.stringify({ intro: -1 }),
    JSON.stringify({ done: true }),
    JSON.stringify({ intro: 0, done: "yes" }),
  ])
    expect([raw, parseTourProgress(raw)]).toEqual([raw, null]);
  // An old "Ukončit" before GitHub no longer hides the onboarding.
  const quit = parseTourProgress(
    JSON.stringify({ composio: null, intro: 0, done: true }),
  );
  expect(tourStep(fresh("hosted-personal"), quit, null)).toBe("gear");
});

test("an Environment with its basics at first sight needs no introduction", () => {
  const usable = { ai: "connected", github: "connected" } as const;
  expect(firstProgress(fresh("local", { ...usable, content: ready }))).toEqual(
    finishedTourProgress,
  );
  expect(
    firstProgress(fresh("local", { ...usable, content: { state: "none" } })),
  ).toEqual(finishedTourProgress);
  expect(firstProgress(fresh("local"))).toEqual(P);
  expect(firstProgress(fresh("local", usable))).toEqual(P);
  // Not known yet: nothing is decided, nothing stored.
  expect(firstProgress(fresh("local", { ai: "loading" }))).toBeNull();
  expect(
    firstProgress(fresh("local", { ai: "connected", github: "unknown" })),
  ).toBeNull();
  expect(
    firstProgress(fresh("local", { ...usable, content: { state: "loading" } })),
  ).toBeNull();
  expect(firstProgress(fresh("hosted-organization-team"))).toBeNull();
});

test("a content read that fails first never finishes the introduction; after it recovers the tour leads to it", () => {
  // The Steward's review of #180, kept: GET /api/content failed once.
  const unreadable = contentFact(null, null);
  expect(unreadable).toEqual({ state: "unknown" });
  const failedRead = fresh("hosted-personal", {
    ai: "connected",
    github: "connected",
    content: unreadable,
  });
  expect(firstProgress(failedRead)).toBeNull();
  expect(tourStep(failedRead, P, null)).toBeNull();
  expect(tourStep(failedRead, P, "start")).toBeNull();
  expect(appsSetupLine(failedRead, cs)).toBeNull();
  const recovered = {
    ...failedRead,
    content: contentFact(
      { allowed: true, items: [{ ...personalspace, state: "absent" }] },
      null,
    ),
  };
  expect(recovered.content.state).toBe("missing");
  expect(firstProgress(recovered)).toEqual(P);
  expect(tourStep(recovered, P, null)).toBe("gear");
});

test("each stop rings its element and says at most a dozen words, with Dokončím později", () => {
  const apps = { chat: true, automate: false };
  const steps = [
    "gear",
    "settings-start",
    "ai",
    "github",
    "prepare",
    "apps",
    "chat",
    "automate",
    "settings",
  ] as const;
  expect(
    steps.map(
      (step) =>
        tourStop(step, fresh("hosted-organization-personal"), apps, cs).target,
    ),
  ).toEqual([
    "gear",
    "settings-start",
    "start-ai",
    "start-github",
    "prepare",
    "tab-apps",
    "tab-chat",
    "tab-automate",
    "gear",
  ]);
  for (const copy of [cs, en])
    for (const facts of [
      fresh("hosted-organization-personal"),
      fresh("hosted-organization-personal", { ai: "connected" }),
      fresh("hosted-personal", { ai: "connected", github: "connected" }),
      fresh("local", {
        ai: "connected",
        github: "connected",
        content: failed(organization),
      }),
    ])
      for (const step of steps) {
        const stop = tourStop(step, facts, apps, copy);
        const words = `${stop.title} ${stop.text ?? ""}`.trim().split(/\s+/);
        expect([step, words.length <= 12]).toEqual([step, true]);
        // No "click here": the ring shows where.
        expect(`${stop.title} ${stop.text}`).not.toMatch(/klikn|click/i);
        // Every stop can be put away for this view, but the last one, which
        // ends the introduction.
        expect([step, stop.later]).toEqual([step, step !== "settings"]);
      }
});

test("the stops speak the wireframe's words", () => {
  const apps = { chat: true, automate: true };
  const stop = (step: Parameters<typeof tourStop>[0], facts: TourFacts) =>
    tourStop(step, facts, apps, cs);
  const org = fresh("hosted-organization-personal");
  expect(stop("gear", org)).toMatchObject({
    title: "Nejdřív připojte AI",
    text: "Agent vám pak pomůže s dalšími kroky.",
    next: null,
    later: true,
  });
  expect(stop("gear", { ...org, ai: "organization" })).toMatchObject({
    title: "Připojte GitHub",
    text: "Zpřístupní vaše repozitáře.",
  });
  const prepared = { ...org, ai: "connected", github: "connected" } as const;
  expect(stop("gear", prepared).title).toBe("Ještě stáhněte Example Company");
  expect(
    stop("gear", {
      ...prepared,
      preset: "hosted-personal",
      content: missing(personalspace),
    }),
  ).toMatchObject({
    title: "Připravte osobní prostor",
    text: "Místo pro vaše vlastní věci.",
  });
  expect(
    stop("gear", { ...prepared, content: failed(organization) }),
  ).toMatchObject({
    title: "Příprava se nepovedla",
    text: "Podívejte se, co dál.",
  });
  expect(stop("settings-start", org)).toMatchObject({
    title: "Začínáme",
    text: "Všechny kroky na jednom místě.",
  });
  expect(stop("ai", org)).toMatchObject({
    title: "Připojte AI",
    text: "Přihlaste se svým účtem ChatGPT nebo Claude.",
  });
  expect(stop("github", org)).toMatchObject({
    title: "Připojte GitHub",
    text: "Pro přístup k vašim modulům.",
  });
  expect(stop("prepare", prepared)).toMatchObject({
    title: "Stáhněte Example Company",
    text: "Pak tu uvidíte její moduly.",
  });
  expect(
    stop("prepare", { ...prepared, content: failed(organization) }),
  ).toMatchObject({ title: "Příprava se nepovedla", text: "Tady je, co dál." });
  expect(stop("apps", prepared)).toMatchObject({
    text: "Aplikace vašich modulů.",
    next: "next",
  });
  expect(stop("settings", prepared)).toMatchObject({
    title: "Nastavení",
    text: "Začínáme tu najdete kdykoli.",
    next: "done",
    later: false,
  });
  expect(
    tourStop("automate", prepared, { chat: true, automate: false }, cs).text,
  ).toBe("Automatizace tu zatím neběží.");
  expect(cs.tourLater).toBe("Dokončím později");
  expect(en.tourLater).toBe("Finish later");
});

test("where a stopped preparation leads: Chat with AI, the AI step without, the Admin for an unprepared Organization", () => {
  for (const ai of ["connected", "organization", "unknown", "loading"] as const)
    expect(resolveOf({ ai, code: "clone-failed", rootAccess: null })).toBe(
      "chat",
    );
  expect(
    resolveOf({ ai: "missing", code: "clone-failed", rootAccess: null }),
  ).toBe("ai");
  // A member without write access to the root: the Admin prepares it, with
  // or without AI, and while the answer is not known yet.
  for (const code of ["root-not-found", "organization-unreadable"])
    for (const rootAccess of [false, null])
      for (const ai of ["connected", "missing"] as const)
        expect(resolveOf({ ai, code, rootAccess })).toBe("admin");
  // Whoever can write the root fixes it like any other stop.
  expect(
    resolveOf({ ai: "connected", code: "root-not-found", rootAccess: true }),
  ).toBe("chat");
  expect(
    resolveOf({ ai: "missing", code: "root-not-found", rootAccess: true }),
  ).toBe("ai");
});

test("the line in Apps: AI first, then GitHub, then the content, a run, a stop", () => {
  const line = (facts: Parameters<typeof appsSetupLine>[0], copy = cs) =>
    appsSetupLine(facts, copy);
  expect(line(fresh("hosted-organization-personal"))).toEqual({
    tone: "info",
    icon: "sparks",
    text: "AI není připojené.",
    actions: [{ action: "open-start", label: "Připojit AI" }],
  });
  expect(
    line(fresh("hosted-organization-personal", { ai: "organization" })),
  ).toEqual({
    tone: "info",
    icon: "key",
    text: "GitHub není připojený.",
    actions: [{ action: "sign-in-gh", label: "Připojit GitHub" }],
  });
  const prepared = { ai: "connected", github: "connected" } as const;
  expect(line(fresh("hosted-organization-personal", prepared))).toEqual({
    tone: "info",
    icon: "download",
    text: "Example Company tu ještě není.",
    actions: [{ action: "install-content", label: "Stáhnout" }],
  });
  expect(
    line({ ...fresh("hosted-organization-personal", prepared), running: true }),
  ).toEqual({
    tone: "info",
    icon: "download",
    text: "Stahuje se Example Company.",
    actions: [{ action: "open-start", label: "Zobrazit" }],
  });
  expect(line(fresh("hosted-personal", prepared))).toEqual({
    tone: "info",
    icon: "download",
    text: "Osobní prostor tu ještě není.",
    actions: [{ action: "install-content", label: "Připravit" }],
  });
  const stopped = fresh("local", {
    ...prepared,
    content: failed(organization),
  });
  expect(line(stopped)).toEqual({
    tone: "failed",
    icon: "warning",
    text: "Příprava se zastavila.",
    actions: [
      { action: "resolve-in-chat", label: "Vyřešit v Chatu" },
      { action: "install-content", label: "Zkusit znovu" },
    ],
  });
  expect(line({ ...stopped, resolve: "ai" })?.actions).toEqual([
    { action: "open-start", label: "Připojit AI" },
    { action: "install-content", label: "Zkusit znovu" },
  ]);
  expect(line({ ...stopped, resolve: "admin" })).toEqual({
    tone: "failed",
    icon: "warning",
    text: "Example Company ještě není připravená. Připravuje ji Admin.",
    actions: [{ action: "install-content", label: "Zkusit znovu" }],
  });
  // An Organization without a display name is named by its login.
  expect(
    line(
      fresh("local", {
        ...prepared,
        content: missing({
          kind: "organization",
          login: "acme",
          state: "absent",
        }),
      }),
    )?.text,
  ).toBe("acme tu ještě není.");
  expect(line(fresh("hosted-organization-personal"), en)?.text).toBe(
    "AI is not connected.",
  );
  // Nothing to say: usable, nothing known, or nothing to prepare here.
  for (const facts of [
    fresh("local", { ...prepared, content: ready }),
    fresh("local", { ...prepared, content: { state: "none" } }),
    fresh("local", { ...prepared, content: { state: "loading" } }),
    fresh("local", { ai: "connected", github: "unknown" }),
    fresh("local", { ai: "loading" }),
  ])
    expect(line(facts)).toBeNull();
});

// GitHub as Settings → Nástroje reads it: never claimed missing from an
// unknown, unprobed or stale reading, never on a Team Environment.
test("GitHub from the Tools reading of the profile shown", () => {
  const reading = (
    gh: Readonly<{
      installed: boolean;
      signIn?: { state: "signed-in" | "signed-out" | "unknown" };
    }>,
    revision = 1,
    sharedEnvironment = false,
  ) => ({
    revision,
    sharedEnvironment,
    tools: [{ name: "gh", ...gh }],
  });
  expect(
    githubFact(
      reading({ installed: true, signIn: { state: "signed-out" } }),
      1,
    ),
  ).toBe("missing");
  expect(
    githubFact(reading({ installed: true, signIn: { state: "signed-in" } }), 1),
  ).toBe("connected");
  // Not installed: "Připojit" installs it first.
  expect(githubFact(reading({ installed: false }), 1)).toBe("missing");
  for (const [overview, revision] of [
    [reading({ installed: true }), 1],
    [reading({ installed: true, signIn: { state: "unknown" } }), 1],
    [reading({ installed: true, signIn: { state: "signed-out" } }, 1, true), 1],
    // A reading of an older revision (a delayed answer across a preset
    // change) is not this profile's.
    [reading({ installed: true, signIn: { state: "signed-out" } }, 1), 2],
    [reading({ installed: true, signIn: { state: "signed-out" } }), null],
    [null, 1],
    [{ revision: 1, sharedEnvironment: false, tools: [] }, 1],
  ] as const)
    expect(githubFact(overview, revision)).toBe("unknown");
  expect(
    composioFact({
      revision: 1,
      sharedEnvironment: false,
      tools: [
        { name: "composio", installed: true, signIn: { state: "signed-in" } },
      ],
    }),
  ).toBe("connected");
  expect(
    composioFact({
      revision: 1,
      sharedEnvironment: false,
      tools: [{ name: "composio", installed: false }],
    }),
  ).toBe("missing");
  expect(composioFact(null)).toBe("none");
});

test("the first address: the token and a start request apart, both leading to Začínáme", () => {
  expect(readFragment("#abc123")).toEqual({ token: "abc123", start: null });
  expect(readFragment("#lazurio-start=sign-in-gh")).toEqual({
    token: "",
    start: "sign-in-gh",
  });
  expect(readFragment("#abc123&lazurio-start=install-content")).toEqual({
    token: "abc123",
    start: "install-content",
  });
  expect(readFragment("#lazurio-start=format-disk")).toEqual({
    token: "",
    start: null,
  });
  expect(readFragment("#lazurio-start=%E0%A4%A")).toEqual({
    token: "",
    start: null,
  });
  expect(readFragment("")).toEqual({ token: "", start: null });
  // An older shell's link to Nástroje or Tento Environment lands on
  // Začínáme, where the sign-in and the installation are steps now.
  expect(startSection).toEqual({
    "sign-in-gh": "start",
    "install-content": "start",
  });
});
