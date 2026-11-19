import { expect, test } from "bun:test";
import { assigneeWithoutGithub, presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import {
  launchpadRouting,
  ownSignInIdentity,
  withoutGithubIdentity,
  withoutGithubRouting,
  withoutGithubWork,
} from "../src/folder/render";
import type { ContentItem, ContentList } from "../src/launchpad/content-client";
import { contentFact, contentView } from "../src/launchpad/content-view";
import {
  appsSetupLine,
  autoStartStep,
  basicsDone,
  basicsOf,
  contentBlockedBy,
  idleAutoStart,
  nextBasic,
  shellSetup,
  startDecision,
  type TourFacts,
  tourStep,
} from "../src/launchpad/first-run";
import { startGuide } from "../src/launchpad/guides";
import { messages } from "../src/launchpad/messages";
import { optionalRows, startView } from "../src/launchpad/start-view";
import { heldLine } from "../src/launchpad/tools-view";
import { bindings } from "./fixtures/machine-bindings";

// An Organization Member without a GitHub account (root decisions 0192 and
// 0216, first stage: entry and chat): their work Environment asks for no
// GitHub sign-in and no content, and its agents propose changes in the chat.
// Every check here runs for both kinds of person, so the person with GitHub
// keeps exactly what they had.

const cs = messages("cs");
const subject = "https://auth.example.invalid/realms/workspace/0000-0001";

/** The recorded work Environment of one person by their Lazurio account,
 * with or without the GitHub account the receipt verified. */
function workOf(github: Readonly<{ login: string; id: number }> | null) {
  const base = bindings.organizationEntry;
  if (base.owner.kind !== "organization") throw new Error("Expected work");
  return {
    ...base,
    owner: {
      ...base.owner,
      assignment: {
        kind: "operator" as const,
        account: { username: "example-person", subject, github },
      },
    },
  };
}
const withoutGithub = workOf(null);
const withGithub = workOf({ login: "example-person", id: 4242 });

test("only a work Environment of one person whose account has no GitHub account is without GitHub", () => {
  expect(
    assigneeWithoutGithub("hosted-organization-personal", withoutGithub),
  ).toBe(true);
  // The person with GitHub, by account or by the older GitHub login.
  expect(
    assigneeWithoutGithub("hosted-organization-personal", withGithub),
  ).toBe(false);
  const legacy = {
    ...bindings.organizationEntry,
    owner: {
      kind: "organization",
      organization: "example",
      team: null,
      assignment: { kind: "operator", githubLogin: "example", githubId: 12345 },
    },
  };
  expect(assigneeWithoutGithub("hosted-organization-personal", legacy)).toBe(
    false,
  );
  // No assignment, another preset, a public Environment, no binding.
  expect(
    assigneeWithoutGithub(
      "hosted-organization-personal",
      bindings.organizationEntry,
    ),
  ).toBe(false);
  for (const preset of [
    "local",
    "hosted-personal",
    "hosted-organization-team",
    "hosted-organization-steward",
  ])
    expect(assigneeWithoutGithub(preset, withoutGithub)).toBe(false);
  expect(
    assigneeWithoutGithub("hosted-organization-personal", {
      ...withoutGithub,
      entry: { audience: "public" },
    }),
  ).toBe(false);
  expect(assigneeWithoutGithub("hosted-organization-personal", null)).toBe(
    false,
  );
});

const organization: ContentItem = {
  kind: "organization",
  login: "example",
  name: "Example Company",
  state: "absent",
};
const list: ContentList = { allowed: true, items: [organization] };
const facts = (
  without: boolean,
  ai: TourFacts["ai"] = "organization",
): TourFacts => ({
  preset: "hosted-organization-personal",
  ai,
  // gh is not signed in: the person has no account to sign in with.
  github: "missing",
  content: contentFact(list, null),
  ...(without ? { withoutGithub: true as const } : {}),
});

test("Začínáme has the AI as its only basic without GitHub, and the three basics with it", () => {
  expect(basicsOf(facts(true))).toEqual(["ai"]);
  expect(basicsOf(facts(false))).toEqual(["ai", "github", "content"]);
  // With the Organization's AI it is done; with GitHub, GitHub is next.
  expect(nextBasic(facts(true))).toBeNull();
  expect(basicsDone(facts(true))).toBe(1);
  expect(nextBasic(facts(false))).toBe("github");
  // A missing AI still leads to its step.
  expect(nextBasic(facts(true, "missing"))).toBe("ai");
  expect(nextBasic(facts(true, "loading"))).toBeUndefined();
});

test("Začínáme shows no GitHub step and no content step without GitHub", () => {
  const start = (without: boolean) =>
    startView(
      {
        ...facts(without),
        aiReading: null,
        githubLogin: null,
        list,
      },
      cs,
    );
  const without = start(true);
  if (without === null) throw new Error("Expected Začínáme");
  expect(without.steps.map((step) => step.basic)).toEqual(["ai"]);
  expect(without.github).toBeNull();
  expect(without.total).toBe(1);
  expect(without.done).toBe(1);
  expect(without.intro).toBe(cs.startReady);
  const withIt = start(false);
  if (withIt === null) throw new Error("Expected Začínáme");
  expect(withIt.steps.map((step) => step.basic)).toEqual([
    "ai",
    "github",
    "content",
  ]);
  expect(withIt.github).not.toBeNull();
  expect(withIt.total).toBe(3);
});

test("Apps, the tour, start links and the shell offer no GitHub sign-in and no download without GitHub", () => {
  // Apps: no line at all; with GitHub, "GitHub není připojený.".
  expect(appsSetupLine(facts(true), cs)).toBeNull();
  expect(appsSetupLine(facts(false), cs)?.text).toBe(cs.setupGithub);
  // The tour goes straight to its introduction.
  expect(tourStep(facts(true), { intro: 0 }, null)).toBe("apps");
  expect(tourStep(facts(false), { intro: 0 }, null)).toBe("gear");
  // Start links are dropped; with GitHub its sign-in opens.
  expect(startDecision("sign-in-gh", facts(true))).toBe("drop");
  expect(startDecision("install-content", facts(true))).toBe("drop");
  expect(startDecision("sign-in-gh", facts(false))).toBe("sign-in-gh");
  // Nothing downloads, also after the AI arrives.
  expect(contentBlockedBy(facts(true))).toBe("github");
  const armed = { ...idleAutoStart, ai: false, github: false };
  expect(autoStartStep(armed, facts(true), false).start).toBe(false);
  // The shell's column gets no setup; with GitHub it counts GitHub missing.
  const setup = (without: boolean) =>
    shellSetup({
      preset: "hosted-organization-personal",
      ai: "organization",
      github: "missing",
      list,
      job: null,
      ...(without ? { withoutGithub: true as const } : {}),
    });
  expect(setup(true)).toBeUndefined();
  expect(setup(false)).toMatchObject({ github: "missing", ai: "ready" });
});

test("Toto Prostředí says the content is not downloaded here, never that it starts after GitHub", () => {
  const note = (without: boolean) =>
    contentView(list, null, cs, {
      github: "missing",
      blockedBy: "github",
      withoutGithub: without,
    }).note;
  expect(note(true)).toBe(cs.contentWithoutGithub);
  expect(note(false)).toBe(cs.contentNeedsGithub);
});

test("the guide of Začínáme points at no GitHub step without GitHub", () => {
  const at = (guide: ReturnType<typeof startGuide>) =>
    guide.steps.map((step) => step.at);
  expect(at(startGuide(cs, false, true))).not.toContain("start-github");
  expect(at(startGuide(cs, false, false))).toContain("start-github");
});

const rendered = (machine: typeof withoutGithub, locale: "cs" | "en" = "cs") =>
  renderOutputs({
    preset: "hosted-organization-personal",
    machine,
    profile: presetProfile("hosted-organization-personal", "linux", {
      locale,
    }),
    tools: [],
    toolNotes: {},
  });

test("AGENTS.md without GitHub sends nobody to gh and says what the agent does instead of a pull request", () => {
  for (const locale of ["cs", "en"] as const) {
    const agents = rendered(withoutGithub, locale)["AGENTS.md"];
    expect(agents).toContain(withoutGithubIdentity[locale]);
    expect(agents).toContain(withoutGithubWork[locale]);
    expect(agents).toContain(withoutGithubRouting[locale]);
    expect(agents).not.toContain(ownSignInIdentity[locale]);
    // No sign-in in Tools, no Draft pull request, no right on GitHub to check.
    expect(agents).not.toContain("gh auth status");
    expect(agents).not.toContain("Draft pull request");
    expect(agents).not.toContain("gh api repos/<owner>/<repo>");
    // It promises no content.
    expect(withoutGithubWork[locale]).not.toMatch(/později|later/u);
    expect(withoutGithubRouting[locale]).not.toMatch(/později|later/u);
  }
});

test("AGENTS.md of the person with GitHub keeps the GitHub sign-in, the pull requests and the rights", () => {
  for (const locale of ["cs", "en"] as const) {
    const agents = rendered(withGithub, locale)["AGENTS.md"];
    expect(agents).toContain(ownSignInIdentity[locale]);
    expect(agents).toContain("gh auth status");
    expect(agents).toContain("Draft pull request");
    expect(agents).toContain("gh api repos/<owner>/<repo>");
    expect(agents).not.toContain(withoutGithubWork[locale]);
    expect(agents).not.toContain(withoutGithubRouting[locale]);
    expect(agents).not.toContain(withoutGithubIdentity[locale]);
  }
  // The Launchpad's GitHub line is the person's sign-in unless asked.
  const origin = "https://launchpad.example.lazurio.io";
  const lines = (without?: boolean) =>
    launchpadRouting(
      "hosted-organization-personal",
      origin,
      "own-sign-in",
      without,
    ).map((line) => line.cs);
  expect(lines()).toEqual(lines(false));
  expect(lines(true)).toContain(withoutGithubRouting.cs);
  expect(lines(false).some((line) => line.includes("gh auth status"))).toBe(
    true,
  );
});

test("the manual explains an Environment without GitHub only there", () => {
  const working = (machine: typeof withoutGithub) =>
    rendered(machine)["manual/working-here.md"];
  expect(working(withoutGithub)).toContain("### Prostředí bez účtu GitHub");
  expect(working(withoutGithub)).toContain(withoutGithubWork.cs);
  expect(working(withGithub)).not.toContain("### Prostředí bez účtu GitHub");
  expect(working(withGithub)).not.toContain(withoutGithubWork.cs);
  expect(rendered(withoutGithub)["manual/this-machine.md"]).toContain(
    withoutGithubRouting.cs,
  );
  expect(rendered(withGithub)["manual/this-machine.md"]).not.toContain(
    withoutGithubRouting.cs,
  );
});

test("Composio's held line sends nobody to download the Organization without GitHub", () => {
  const held = { held: "organization-absent" } as const;
  expect(heldLine(held, cs, true)).toBe(cs.toolsComposioHeldWithoutGithub);
  expect(heldLine(held, cs)).toBe(cs.toolsComposioHeld);
  const row = (without: boolean) =>
    optionalRows(
      {
        preset: "hosted-organization-personal",
        composio: "organization-absent",
        sshDevices: null,
        bitwarden: false,
        withoutGithub: without,
      },
      cs,
    ).find((entry) => entry.id === "composio");
  expect(row(true)?.note).toBe(cs.toolsComposioHeldWithoutGithub);
  expect(row(true)?.status).toBe(cs.startComposioUnavailable);
  expect(row(false)?.note).toBe(cs.toolsComposioHeld);
  expect(row(false)?.status).toBe(cs.startComposioWaiting);
  expect(cs.toolsComposioHeldWithoutGithub).not.toContain("Začínáme");
});
