import { expect, test } from "bun:test";
import type { ContentItem } from "../src/launchpad/content-client";
import { type ContentFact, contentFact } from "../src/launchpad/content-view";
import {
  appsSetupLine,
  autoStartStep,
  basicsDone,
  composioFact,
  contentBlockedBy,
  createComposioOrganizationReader,
  finishedTourProgress,
  firstProgress,
  freshTourProgress,
  githubFact,
  idleAutoStart,
  nextBasic,
  parseTourProgress,
  readFragment,
  resolveOf,
  shellSetup,
  signsInAsPerson,
  startDecision,
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
  // The gear's AI stop is its title alone in both languages, as Začínáme's
  // AI step (Matěj 2026-10-16): no line under it.
  expect(stop("gear", org)).toEqual({
    target: "gear",
    title: "Nejdřív připojte AI",
    text: null,
    next: null,
    later: true,
  });
  expect(tourStop("gear", org, apps, en)).toEqual({
    target: "gear",
    title: "First connect AI",
    text: null,
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
  ).toBe("Automatizace tu neběží.");
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
  // Without AI there is no "Zkusit znovu" before it (Pablo's review of
  // #436).
  expect(line({ ...stopped, resolve: "ai" })?.actions).toEqual([
    { action: "open-start", label: "Připojit AI" },
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
// unknown, unprobed or stale reading, never on a Team Environment; and done
// only when this Environment reaches GitHub over SSH as the signed-in
// account (#515, F19's addendum of 2026-10-19).
test("GitHub from the Tools reading of the profile shown", () => {
  const reading = (
    gh: Readonly<{
      installed: boolean;
      signIn?: {
        state: "signed-in" | "signed-out" | "unknown";
        ssh?: { state: "linked" | "not-linked" | "unknown" };
      };
    }>,
    revision = 1,
    sharedEnvironment = false,
  ) => ({
    revision,
    sharedEnvironment,
    tools: [{ name: "gh", ...gh }],
  });
  const ghSignedIn = (ssh?: "linked" | "not-linked" | "unknown") =>
    reading({
      installed: true,
      signIn: {
        state: "signed-in",
        ...(ssh === undefined ? {} : { ssh: { state: ssh } }),
      },
    });
  expect(
    githubFact(
      reading({ installed: true, signIn: { state: "signed-out" } }),
      1,
    ),
  ).toBe("missing");
  expect(githubFact(ghSignedIn("linked"), 1)).toBe("connected");
  // Signed in, but SSH does not work as the account: connected badly, which
  // counts as missing.
  expect(githubFact(ghSignedIn("not-linked"), 1)).toBe("incomplete");
  // Whether SSH works could not be read: not known, never connected.
  expect(githubFact(ghSignedIn("unknown"), 1)).toBe("unknown");
  expect(githubFact(ghSignedIn(), 1)).toBe("unknown");
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
  // Signed in, and what the organizations' reading says of the organization
  // of this Environment's Organization's name (the end-to-end test of
  // 2026-10-19): done only where it is the one Composio works in, or where
  // the person chooses; not read yet, the sign-in says it.
  const signedIn = {
    revision: 1,
    sharedEnvironment: false,
    tools: [
      { name: "composio", installed: true, signIn: { state: "signed-in" } },
    ],
  } as const;
  const named = (state: "matches" | "missing" | "ambiguous" | "elsewhere") =>
    ({ kind: "named", name: "Lazurio Example Organization", state }) as const;
  expect(composioFact(signedIn, named("matches"))).toBe("connected");
  expect(composioFact(signedIn, { kind: "chosen", personal: true })).toBe(
    "connected",
  );
  expect(composioFact(signedIn, null)).toBe("connected");
  for (const state of ["missing", "ambiguous", "elsewhere"] as const)
    expect(composioFact(signedIn, named(state))).toBe("unfinished");
  expect(composioFact(signedIn, { kind: "unverified" })).toBe("unfinished");
  // A person's own Environment: done where the account's default
  // organization is the current one (addendum of 2026-10-26).
  expect(
    composioFact(signedIn, {
      kind: "default",
      name: "jana_workspace",
      state: "matches",
    }),
  ).toBe("connected");
  expect(
    composioFact(signedIn, {
      kind: "default",
      name: "jana_workspace",
      state: "elsewhere",
    }),
  ).toBe("unfinished");
  // Signed out, the organization does not matter.
  expect(
    composioFact(
      {
        revision: 1,
        sharedEnvironment: false,
        tools: [{ name: "composio", installed: true }],
      },
      named("missing"),
    ),
  ).toBe("missing");
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

test("the content's turn: after AI and GitHub, waiting while they are not read, never blocked by an AI that could not be checked", () => {
  const person = (ai: TourFacts["ai"], github: TourFacts["github"]) =>
    contentBlockedBy({ preset: "hosted-organization-personal", ai, github });
  // Pablo's review of #436: GitHub connected and AI provably missing.
  expect(person("missing", "connected")).toBe("ai");
  expect(person("missing", "missing")).toBe("ai");
  expect(person("connected", "missing")).toBe("github");
  expect(person("organization", "missing")).toBe("github");
  expect(person("loading", "connected")).toBe("unknown");
  expect(person("connected", "unknown")).toBe("unknown");
  for (const ai of ["connected", "organization", "unknown"] as const)
    expect(person(ai, "connected")).toBeNull();
  // A Team or an Automated Environment: only a known missing GitHub.
  for (const preset of [
    "hosted-organization-team",
    "hosted-organization-steward",
  ]) {
    expect(contentBlockedBy({ preset, ai: "missing", github: "unknown" })).toBe(
      null,
    );
    expect(contentBlockedBy({ preset, ai: "missing", github: "missing" })).toBe(
      "github",
    );
  }
});

test("a start request of the address keeps the order: an older #lazurio-start=install-content starts nothing before AI", () => {
  const work = (overrides: Partial<TourFacts>) =>
    fresh("hosted-organization-personal", overrides);
  const stopped = failed(organization);
  // AI provably missing, GitHub connected: no install, the AI step instead,
  // for a missing and for a stopped content alike.
  for (const content of [missing(organization), stopped])
    expect(
      startDecision(
        "install-content",
        work({ ai: "missing", github: "connected", content }),
      ),
    ).toBe("open-ai");
  // Its turn: it starts.
  for (const ai of ["connected", "organization", "unknown"] as const)
    expect(
      startDecision("install-content", work({ ai, github: "connected" })),
    ).toBe("install");
  expect(
    startDecision(
      "install-content",
      work({ ai: "connected", github: "connected", content: stopped }),
    ),
  ).toBe("install");
  // Not its turn yet or nothing to do: dropped; not read yet: it waits.
  expect(startDecision("install-content", work({ ai: "connected" }))).toBe(
    "drop",
  );
  expect(
    startDecision(
      "install-content",
      work({ ai: "connected", github: "connected", content: ready }),
    ),
  ).toBe("drop");
  for (const facts of [
    work({ ai: "loading", github: "connected" }),
    work({ ai: "connected", github: "unknown" }),
    work({
      ai: "connected",
      github: "connected",
      content: { state: "loading" },
    }),
  ])
    expect(startDecision("install-content", facts)).toBe("wait");
  // GitHub's sign-in waits for AI as Začínáme offers it.
  expect(startDecision("sign-in-gh", work({ ai: "missing" }))).toBe("open-ai");
  expect(startDecision("sign-in-gh", work({ ai: "connected" }))).toBe(
    "sign-in-gh",
  );
  expect(
    startDecision("sign-in-gh", work({ ai: "connected", github: "connected" })),
  ).toBe("drop");
  expect(startDecision("sign-in-gh", work({ ai: "loading" }))).toBe("wait");
  // No first run here: dropped.
  expect(
    startDecision("install-content", fresh("hosted-organization-team")),
  ).toBe("drop");
});

// The start of the content by itself (root decision 0201 point 3; Pablo's
// re-review of #436 at 61765074): a view reads the facts again and again;
// each reading is one step. `run` feeds the readings in order and says at
// which of them the content started.
const run = (
  readings: readonly (
    | TourFacts
    | Readonly<{ facts: TourFacts; running: boolean }>
  )[],
): number[] => {
  let state = idleAutoStart;
  const starts: number[] = [];
  readings.forEach((reading, index) => {
    const { facts, running } =
      "facts" in reading ? reading : { facts: reading, running: false };
    const step = autoStartStep(state, facts, running);
    state = step.state;
    if (step.start) starts.push(index);
  });
  return starts;
};

test("the content starts by itself once GitHub and AI are both there, whichever came last: GitHub, then AI", () => {
  const work = (overrides: Partial<TourFacts>) =>
    fresh("hosted-organization-personal", overrides);
  expect(
    run([
      // The page loads: nothing read yet, then AI and GitHub missing.
      work({ ai: "loading", github: "unknown", content: { state: "loading" } }),
      work({ ai: "missing", github: "missing" }),
      // GitHub connects first (in Nástroje): no start, AI is missing.
      work({ ai: "missing", github: "connected" }),
      // The content is read again; still no AI.
      work({ ai: "missing", github: "connected" }),
      // AI arrives: the content starts, once.
      work({ ai: "connected", github: "connected" }),
      // The run, and its end.
      {
        facts: work({ ai: "connected", github: "connected" }),
        running: true,
      },
      work({ ai: "connected", github: "connected", content: ready }),
    ]),
  ).toEqual([4]);
});

test("the content starts by itself once GitHub and AI are both there, whichever came last: AI, then GitHub", () => {
  const work = (overrides: Partial<TourFacts>) =>
    fresh("hosted-personal", overrides);
  expect(
    run([
      work({ ai: "missing", github: "missing" }),
      // AI arrives first: no start, GitHub is missing.
      work({ ai: "connected", github: "missing" }),
      work({ ai: "connected", github: "missing" }),
      // GitHub arrives: the content starts, once.
      work({ ai: "connected", github: "connected" }),
      work({ ai: "connected", github: "connected" }),
    ]),
  ).toEqual([3]);
  // The Organization's AI pool arriving counts as AI.
  expect(
    run([
      work({ ai: "missing", github: "connected" }),
      work({ ai: "organization", github: "connected" }),
    ]),
  ).toEqual([1]);
});

test("the start by itself: a reading that cannot tell changes nothing, what was there at load starts nothing", () => {
  const work = (overrides: Partial<TourFacts>) =>
    fresh("hosted-organization-personal", overrides);
  // GitHub's reading passes through unknown (the profile's revision moved
  // during the sign-in): it still arrived.
  expect(
    run([
      work({ ai: "connected", github: "missing" }),
      work({ ai: "connected", github: "unknown" }),
      work({ ai: "connected", github: "connected" }),
    ]),
  ).toEqual([2]);
  // So does an AI read between a timeout and its answer: an unknown AI is
  // no arrival, its answer is.
  expect(
    run([
      work({ ai: "missing", github: "connected" }),
      work({ ai: "unknown", github: "connected" }),
      work({ ai: "connected", github: "connected" }),
    ]),
  ).toEqual([2]);
  // Both there when the page loaded: nothing starts by itself; the button
  // does it.
  expect(
    run([
      work({ ai: "loading", github: "unknown" }),
      work({ ai: "connected", github: "connected" }),
      work({ ai: "connected", github: "connected" }),
    ]),
  ).toEqual([]);
  // GitHub arrives while AI could not be checked: it does not hold the
  // content back (the same rule as every start).
  expect(
    run([
      work({ ai: "unknown", github: "missing" }),
      work({ ai: "unknown", github: "connected" }),
    ]),
  ).toEqual([1]);
});

test("the start by itself never comes after a stop, never during a run, never before the content is read, and only with a first run", () => {
  const work = (overrides: Partial<TourFacts>) =>
    fresh("hosted-organization-personal", overrides);
  const stopped = failed(organization);
  // A stop ends it without a start, and a later arrival does not retry.
  expect(
    run([
      work({ ai: "missing", github: "missing", content: stopped }),
      work({ ai: "missing", github: "connected", content: stopped }),
      work({ ai: "connected", github: "connected", content: stopped }),
    ]),
  ).toEqual([]);
  // A run under way (started elsewhere): it waits for its end.
  expect(
    run([
      work({ ai: "missing", github: "connected" }),
      { facts: work({ ai: "connected", github: "connected" }), running: true },
      work({ ai: "connected", github: "connected", content: ready }),
    ]),
  ).toEqual([]);
  // The content not read yet: it waits, then starts.
  expect(
    run([
      work({
        ai: "missing",
        github: "connected",
        content: { state: "unknown" },
      }),
      work({
        ai: "connected",
        github: "connected",
        content: { state: "unknown" },
      }),
      work({ ai: "connected", github: "connected" }),
    ]),
  ).toEqual([2]);
  // AI leaves again before GitHub arrives: it waits for AI again.
  expect(
    run([
      work({ ai: "missing", github: "missing" }),
      work({ ai: "connected", github: "missing" }),
      work({ ai: "missing", github: "missing" }),
      work({ ai: "missing", github: "connected" }),
      work({ ai: "connected", github: "connected" }),
    ]),
  ).toEqual([4]);
  // Without a first run (a Team or an Automated Environment): never.
  for (const preset of [
    "hosted-organization-team",
    "hosted-organization-steward",
  ])
    expect(
      run([
        fresh(preset, { ai: "missing", github: "missing" }),
        fresh(preset, { ai: "connected", github: "connected" }),
      ]),
    ).toEqual([]);
  // One rule: it starts only where every other start may.
  for (const ai of ["missing", "loading", "unknown", "connected"] as const)
    for (const github of ["missing", "unknown", "connected"] as const) {
      const facts = work({ ai, github });
      const step = autoStartStep(
        { ai: false, github: false, armed: true },
        facts,
        false,
      );
      expect([ai, github, step.start]).toEqual([
        ai,
        github,
        contentBlockedBy(facts) === null,
      ]);
    }
});

test("Začínáme's organizations reading follows a Composio sign-in that changes mid-read (Pablo's review of #510)", async () => {
  // Sign-in A's read is in flight when the tools report sign-in B: B's
  // request is not dropped. A's answer never counts for B, and once A's
  // read settles the reader reads again for B.
  const missing = { kind: "named", name: "Example", state: "missing" } as const;
  const matches = { kind: "named", name: "Example", state: "matches" } as const;
  let signIn: string | null = "A";
  const pending: ((rule: typeof missing | typeof matches) => void)[] = [];
  const asked: (string | null)[] = [];
  let drawn = 0;
  const reader = createComposioOrganizationReader({
    signIn: () => signIn,
    read: () =>
      new Promise((resolve) => {
        asked.push(signIn);
        pending.push(resolve);
      }),
    changed: () => {
      drawn += 1;
    },
  });
  const first = reader.read(true);
  signIn = "B";
  // The tools' reading for B arrives while A's read runs.
  await reader.read(false);
  expect(asked).toEqual(["A"]);
  pending.shift()?.(matches);
  await Promise.resolve();
  await Promise.resolve();
  // A's answer is A's: B has no answer yet, and B is being read.
  expect(reader.rule()).toBeNull();
  expect(asked).toEqual(["A", "B"]);
  pending.shift()?.(missing);
  await first;
  expect(reader.rule()).toEqual(missing);
  expect(drawn).toBe(2);
  // Unchanged sign-in, no new read unless asked again.
  await reader.read(false);
  expect(asked).toEqual(["A", "B"]);
  // A failed read keeps nothing.
  const again = reader.read(true);
  pending.shift()?.(Promise.reject(new Error("down")) as never);
  await again;
  expect(asked).toEqual(["A", "B", "B"]);
  expect(reader.rule()).toBeNull();
  // Signed out: nothing is read and nothing counts.
  signIn = null;
  await reader.read(true);
  expect(asked).toEqual(["A", "B", "B"]);
  expect(reader.rule()).toBeNull();
});

// #515 (F19's addendum of 2026-10-19): gh signed in while this Environment
// does not reach GitHub over SSH as that account is GitHub connected badly.
// It counts as missing everywhere the first run looks: the count, the next
// basic, the content's turn, the start by itself, a start request and the
// shell's prompt. Its one action finishes the link.
test("GitHub connected badly counts as missing: no basic done, no content before it, its start opens the link", () => {
  const work = (overrides: Partial<TourFacts>) =>
    fresh("hosted-organization-personal", overrides);
  const broken = work({ ai: "connected", github: "incomplete" });
  expect(basicsDone(broken)).toBe(1);
  expect(nextBasic(broken)).toBe("github");
  expect(tourStep(broken, P, "start")).toBe("github");
  // The content waits for it, whichever way a start comes.
  expect(contentBlockedBy(broken)).toBe("github");
  expect(startDecision("install-content", broken)).toBe("drop");
  // A start request of GitHub's sign-in opens it (the sign-in of a signed-in
  // gh whose SSH does not work is its SSH link, tools-view `signInMode`).
  expect(startDecision("sign-in-gh", broken)).toBe("sign-in-gh");
  expect(startDecision("sign-in-gh", work({ github: "incomplete" }))).toBe(
    "open-ai",
  );
  // The line in Apps says it does not work and offers to connect again.
  expect(appsSetupLine(broken, cs)).toEqual({
    tone: "info",
    icon: "key",
    text: "Připojení GitHubu nefunguje.",
    actions: [{ action: "sign-in-gh", label: "Připojit znovu" }],
  });
  expect(appsSetupLine(broken, en)).toEqual({
    tone: "info",
    icon: "key",
    text: "The GitHub connection does not work.",
    actions: [{ action: "sign-in-gh", label: "Connect again" }],
  });
  // The shell's prompt counts it as missing.
  expect(
    shellSetup({
      preset: "hosted-organization-personal",
      ai: "connected",
      github: "incomplete",
      list: { allowed: true, items: [organization] },
      job: null,
    }),
  ).toMatchObject({ ai: "ready", github: "missing", content: "missing" });
  // On a Team or an Automated Environment, whose GitHub is the
  // Organization's or the persona's, only a known missing GitHub holds the
  // content back, as before.
  for (const preset of [
    "hosted-organization-team",
    "hosted-organization-steward",
  ])
    expect(
      contentBlockedBy({ preset, ai: "connected", github: "incomplete" }),
    ).toBeNull();
});

test("the content never starts by itself when GitHub arrives without SSH; it starts once the link works", () => {
  const work = (overrides: Partial<TourFacts>) =>
    fresh("hosted-organization-personal", overrides);
  expect(
    run([
      work({ ai: "connected", github: "missing" }),
      // The code was confirmed, the SSH key was not linked (the dialog was
      // closed, the proof failed): GitHub is there only by its sign-in.
      work({ ai: "connected", github: "incomplete" }),
      work({ ai: "connected", github: "incomplete" }),
      // "Připojit znovu" linked it: now the content starts, once.
      work({ ai: "connected", github: "connected" }),
      work({ ai: "connected", github: "connected" }),
    ]),
  ).toEqual([3]);
  // A broken link at load starts nothing either, until it works.
  expect(
    run([
      work({ ai: "loading", github: "unknown" }),
      work({ ai: "connected", github: "incomplete" }),
      work({ ai: "connected", github: "connected" }),
    ]),
  ).toEqual([2]);
});
