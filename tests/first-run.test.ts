import { expect, test } from "bun:test";
import type { ContentItem } from "../src/launchpad/content-client";
import { type ContentFact, contentFact } from "../src/launchpad/content-view";
import {
  appsSetupLine,
  composioFact,
  firstProgress,
  freshTourProgress,
  githubFact,
  parseTourProgress,
  readFragment,
  signsInAsPerson,
  type TourFacts,
  type TourProgress,
  tourAdvance,
  tourIntro,
  tourStep,
  tourStop,
  tourStorageKey,
} from "../src/launchpad/first-run";
import { messages } from "../src/launchpad/messages";

// The first run of an Environment (root decision 0188), ported from the
// wireframe's rules (prototypes-lazurio 45c92830, `setup.test.ts`) onto the
// Launchpad's facts: the preset, gh's sign-in as Settings → Nástroje reads
// it, Composio, and the content as the content routes answer.

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
const failed = (item: ContentItem): ContentFact => ({
  state: "failed",
  item,
  job: { id: "job-1", state: "failed", steps: [] },
});
const ready: ContentFact = { state: "ready" };

const fresh = (
  preset: string,
  overrides: Partial<TourFacts> = {},
): TourFacts => ({
  preset,
  github: "missing",
  composio: "missing",
  content: missing(preset === "hosted-personal" ? personalspace : organization),
  ...overrides,
});
const P = freshTourProgress;

test("only Environments that sign in to GitHub as their person get the tour", () => {
  expect(signsInAsPerson("hosted-personal")).toBe(true);
  expect(signsInAsPerson("hosted-organization-personal")).toBe(true);
  expect(signsInAsPerson("local")).toBe(true);
  // A Team's Environment acts through the Organization's app, a Steward's
  // (Automated) one as its persona.
  for (const preset of [
    "hosted-organization-team",
    "hosted-organization-steward",
    "",
    null,
  ]) {
    expect(signsInAsPerson(preset)).toBe(false);
    expect(tourStep(fresh(preset as string), P, null)).toBeNull();
    expect(appsSetupLine(fresh(preset as string), cs)).toBeNull();
  }
});

test("without GitHub the tour leads through Settings: gear, Tools, gh", () => {
  const facts = fresh("hosted-personal");
  expect(tourStep(facts, P, null)).toBe("gear");
  expect(tourStep(facts, P, "general")).toBe("settings-tools");
  expect(tourStep(facts, P, "machine")).toBe("settings-tools");
  expect(tourStep(facts, P, "tools")).toBe("github");
});

test("with GitHub the content comes next, in Settings → Tento Environment", () => {
  const facts = fresh("hosted-organization-personal", { github: "connected" });
  // Composio is offered in Tools and never blocks the content.
  expect(tourStep(facts, P, "tools")).toBe("composio");
  expect(tourStep(facts, P, null)).toBe("gear-prepare");
  expect(tourStep(facts, P, "general")).toBe("settings-environment");
  expect(tourStep(facts, P, "machine")).toBe("prepare");
  // Put off ("Teď ne"), Composio is not offered again.
  const skipped = tourAdvance(P, "composio", "not-now");
  expect(skipped.composio).toBe("skipped");
  expect(tourStep(facts, skipped, "tools")).toBe("settings-environment");
  // Connected or not offered here, neither.
  expect(tourStep({ ...facts, composio: "connected" }, P, "tools")).toBe(
    "settings-environment",
  );
  expect(tourStep({ ...facts, composio: "none" }, P, "tools")).toBe(
    "settings-environment",
  );
  // A failed preparation still points there; outside Settings the line and
  // Chat have it.
  const stopped = { ...facts, content: failed(organization) };
  expect(tourStep(stopped, P, "machine")).toBe("prepare");
  expect(tourStep(stopped, P, null)).toBeNull();
});

test("once prepared, the introduction runs: Apps, Chat, Automate, the gear", () => {
  const facts = fresh("hosted-organization-personal", {
    github: "connected",
    composio: "connected",
    content: ready,
  });
  expect(tourStep(facts, P, null)).toBe("apps");
  expect(
    tourIntro.map((_, intro) => tourStep(facts, { ...P, intro }, "tools")),
  ).toEqual(["apps", "chat", "automate", "settings"]);
  // "Další" moves on; "Hotovo" on the last stop ends the tour.
  let progress: TourProgress = P;
  for (const step of tourIntro) progress = tourAdvance(progress, step, "next");
  expect(progress).toEqual({ composio: null, intro: 4, done: true });
  expect(tourStep(facts, progress, null)).toBeNull();
  // Nothing to prepare here (no content routes) is like prepared.
  expect(tourStep({ ...facts, content: { state: "none" } }, P, null)).toBe(
    "apps",
  );
});

test("put away early: no tour, though GitHub is still missing; the line stays", () => {
  const facts = fresh("hosted-personal");
  const quit = tourAdvance(P, "gear", "quit");
  expect(quit.done).toBe(true);
  expect(tourStep(facts, quit, null)).toBeNull();
  expect(appsSetupLine(facts, cs)?.text).toBe(
    "GitHub není připojený. Bez něj tu nic nefunguje.",
  );
});

test("the tour waits while a fact it needs is not known", () => {
  expect(
    tourStep(fresh("hosted-personal", { github: "unknown" }), P, null),
  ).toBeNull();
  expect(
    tourStep(
      fresh("hosted-personal", {
        github: "connected",
        content: { state: "loading" },
      }),
      P,
      "machine",
    ),
  ).toBeNull();
  expect(tourStep(fresh("hosted-personal"), null, null)).toBeNull();
});

test("an Environment usable at first sight starts with the tour done", () => {
  expect(
    firstProgress(fresh("local", { github: "connected", content: ready })),
  ).toEqual({ ...P, done: true });
  expect(
    firstProgress(
      fresh("local", { github: "connected", content: { state: "none" } }),
    ),
  ).toEqual({ ...P, done: true });
  expect(firstProgress(fresh("local"))).toEqual(P);
  expect(firstProgress(fresh("local", { github: "connected" }))).toEqual(P);
  // Not known yet: nothing is decided, nothing stored.
  expect(firstProgress(fresh("local", { github: "unknown" }))).toBeNull();
  expect(
    firstProgress(
      fresh("local", { github: "connected", content: { state: "loading" } }),
    ),
  ).toBeNull();
  expect(firstProgress(fresh("hosted-organization-team"))).toBeNull();
});

test("a content read that fails first never finishes the tour; after it recovers the tour starts", () => {
  // The Steward's review of #180: GitHub connected, GET /api/content failed
  // once on the first visit.
  const unreadable = contentFact(null, null);
  expect(unreadable).toEqual({ state: "unknown" });
  const failedRead = fresh("hosted-personal", {
    github: "connected",
    content: unreadable,
  });
  // Nothing is decided or stored, and the tour waits.
  expect(firstProgress(failedRead)).toBeNull();
  expect(tourStep(failedRead, P, null)).toBeNull();
  expect(tourStep(failedRead, P, "machine")).toBeNull();
  // The route recovers and reports the Personalspace absent: a fresh tour
  // leads to it.
  const recovered = fresh("hosted-personal", {
    github: "connected",
    content: contentFact(
      {
        allowed: true,
        items: [{ ...personalspace, state: "absent" }],
      },
      null,
    ),
  });
  expect(recovered.content.state).toBe("missing");
  expect(firstProgress(recovered)).toEqual(P);
  expect(tourStep(recovered, firstProgress(recovered), null)).toBe(
    "gear-prepare",
  );
  // Without GitHub the tour starts whatever the content read says.
  const signedOut = fresh("hosted-personal", { content: unreadable });
  expect(firstProgress(signedOut)).toEqual(P);
  expect(tourStep(signedOut, P, null)).toBe("gear");
  // The line says nothing it does not know.
  expect(appsSetupLine(failedRead, cs)).toBeNull();
});

test("stored progress keeps well-formed entries only, per Environment", () => {
  expect(tourStorageKey("vm-01.example")).toBe("lazurio.tour:vm-01.example");
  expect(
    parseTourProgress(
      JSON.stringify({ composio: "skipped", intro: 2, done: false }),
    ),
  ).toEqual({ composio: "skipped", intro: 2, done: false });
  for (const raw of [
    null,
    "",
    "nonsense",
    "[]",
    JSON.stringify({ composio: "maybe", intro: 0, done: false }),
    JSON.stringify({ composio: null, intro: 9, done: false }),
    JSON.stringify({ composio: null, intro: 1.5, done: false }),
    JSON.stringify({ composio: null, intro: 0 }),
  ])
    expect([raw, parseTourProgress(raw)]).toEqual([raw, null]);
});

test("each stop rings its element and says at most a dozen words", () => {
  const apps = { chat: true, automate: false };
  const steps = [
    "gear",
    "settings-tools",
    "github",
    "composio",
    "gear-prepare",
    "settings-environment",
    "prepare",
    "apps",
    "chat",
    "automate",
    "settings",
  ] as const;
  const targets = steps.map(
    (step) => tourStop(step, missing(organization), apps, cs).target,
  );
  expect(targets).toEqual([
    "gear",
    "settings-tools",
    "tool-gh",
    "tool-composio",
    "gear",
    "settings-machine",
    "prepare",
    "tab-apps",
    "tab-chat",
    "tab-automate",
    "gear",
  ]);
  for (const copy of [cs, en])
    for (const content of [
      missing(organization),
      missing(personalspace),
      failed(personalspace),
    ])
      for (const step of steps) {
        const stop = tourStop(step, content, apps, copy);
        const words = `${stop.title} ${stop.text ?? ""}`.trim().split(/\s+/);
        expect([step, words.length <= 12]).toEqual([step, true]);
        // No "click here": the ring shows where.
        expect(`${stop.title} ${stop.text}`).not.toMatch(/klikni|click/i);
      }
});

test("the stops speak the wireframe's words", () => {
  const apps = { chat: true, automate: true };
  const stop = (step: Parameters<typeof tourStop>[0], content: ContentFact) =>
    tourStop(step, content, apps, cs);
  expect(stop("gear", missing(organization))).toMatchObject({
    title: "Nejdřív připoj GitHub",
    text: "Bez něj tu nic nefunguje.",
  });
  expect(stop("github", missing(organization))).toMatchObject({
    title: "Připoj GitHub",
    text: "Uvidíš své moduly a agenti budou pracovat za tebe.",
  });
  expect(stop("composio", missing(organization))).toMatchObject({
    title: "Připoj své aplikace",
    text: "Pošta, kalendář, Slack. Klidně až později.",
    notNow: true,
  });
  expect(stop("gear-prepare", missing(organization)).title).toBe(
    "Ještě stáhni Example Company",
  );
  expect(stop("gear-prepare", missing(personalspace))).toMatchObject({
    title: "Ještě připrav osobní prostor",
    text: "Místo pro tvé vlastní věci.",
  });
  expect(stop("prepare", missing(organization))).toMatchObject({
    title: "Stáhni Example Company",
    text: "Pak tu uvidíš její moduly.",
  });
  expect(stop("prepare", failed(organization))).toMatchObject({
    title: "Něco se nepovedlo",
    text: "Zkus to znovu, nebo to vyřeší agent v Chatu.",
  });
  expect(stop("settings", ready)).toMatchObject({
    title: "Nastavení je vždycky tady",
    text: null,
    next: "done",
  });
  expect(stop("apps", ready).next).toBe("next");
  expect(
    tourStop("automate", ready, { chat: true, automate: false }, cs).text,
  ).toBe("Co se má dít samo. Tady zatím neběží.");
  expect(stop("automate", ready).text).toBe(
    "Tady nastavíš, co se má dít samo.",
  );
});

test("the line in Apps: GitHub first, then the content, then a stop", () => {
  const line = (facts: TourFacts, copy = cs) => appsSetupLine(facts, copy);
  expect(line(fresh("hosted-organization-personal"))).toEqual({
    tone: "info",
    icon: "key",
    text: "GitHub není připojený. Bez něj tu nic nefunguje.",
    actions: [{ action: "sign-in-gh", label: "Připojit GitHub" }],
  });
  expect(
    line(fresh("hosted-organization-personal", { github: "connected" })),
  ).toEqual({
    tone: "info",
    icon: "download",
    text: "Example Company tu ještě není.",
    actions: [{ action: "install-content", label: "Stáhnout" }],
  });
  expect(line(fresh("hosted-personal", { github: "connected" }))).toEqual({
    tone: "info",
    icon: "download",
    text: "Osobní prostor tu ještě není.",
    actions: [{ action: "install-content", label: "Připravit" }],
  });
  expect(
    line(
      fresh("local", { github: "connected", content: failed(organization) }),
    ),
  ).toEqual({
    tone: "failed",
    icon: "warning",
    text: "Příprava se zastavila.",
    actions: [
      { action: "resolve-in-chat", label: "Vyřešit v Chatu" },
      { action: "install-content", label: "Zkusit znovu" },
    ],
  });
  // An Organization without a display name is named by its login.
  expect(
    line(
      fresh("local", {
        github: "connected",
        content: missing({
          kind: "organization",
          login: "acme",
          state: "absent",
        }),
      }),
    )?.text,
  ).toBe("acme tu ještě není.");
  expect(line(fresh("hosted-organization-personal"), en)?.text).toBe(
    "GitHub is not connected. Nothing works here without it.",
  );
  // Nothing to say: usable, nothing known, or nothing to prepare here.
  for (const facts of [
    fresh("local", { github: "connected", content: ready }),
    fresh("local", { github: "connected", content: { state: "none" } }),
    fresh("local", { github: "connected", content: { state: "loading" } }),
    fresh("local", { github: "unknown" }),
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

test("the first address: the token and a start request apart", () => {
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
});
