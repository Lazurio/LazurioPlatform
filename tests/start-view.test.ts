import { expect, test } from "bun:test";
import type { ContentItem, ContentList } from "../src/launchpad/content-client";
import type { ContentFact } from "../src/launchpad/content-view";
import { messages } from "../src/launchpad/messages";
import {
  optionalRows,
  type StartFacts,
  startCount,
  startView,
} from "../src/launchpad/start-view";

// Nastavení → Začínáme (root decision 0201 points 1-3; the wireframe's
// `screens/Start.tsx`, prototypes-lazurio 1eefc3d): the three basics checked
// from live facts in the order AI → GitHub → content, GitHub offered only
// after AI, the count, and the optional rows.

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
};
const listOf = (...items: ContentItem[]): ContentList => ({
  allowed: true,
  items,
});
const missing = (item: ContentItem): ContentFact => ({
  state: "missing",
  item,
});

const facts = (overrides: Partial<StartFacts> = {}): StartFacts => ({
  preset: "hosted-organization-personal",
  ai: "missing",
  aiReading: { state: "missing", providers: [] },
  github: "missing",
  githubLogin: null,
  content: missing(organization),
  list: listOf(organization),
  ...overrides,
});

test("a new work Environment: AI now, GitHub after it, the content after GitHub", () => {
  const view = startView(facts(), cs);
  expect(view).toEqual({
    intro: "Hotovo 0 ze 3 kroků. Stav se ověřuje přímo v Prostředí.",
    done: 0,
    total: 3,
    steps: [
      {
        basic: "ai",
        mark: "now",
        title: "Připojit AI",
        status: "Agent vám pak pomůže s dalšími kroky.",
      },
      {
        basic: "github",
        mark: "later",
        title: "GitHub",
        status: "Nabídne se po připojení AI.",
      },
      {
        basic: "content",
        mark: "later",
        title: "Stáhnout Example Company",
        status: null,
      },
    ],
    // "Připojit" is there, disabled until an agent can help.
    github: { enabled: false },
  });
});

test("the AI step from the CLIs: the Organization's, the person's accounts, or not known", () => {
  const ai = (overrides: Partial<StartFacts>) =>
    startView(facts(overrides), cs)?.steps[0];
  expect(
    ai({
      ai: "organization",
      aiReading: {
        state: "organization",
        providers: [{ provider: "codex", state: "provided" }],
      },
    }),
  ).toEqual({
    basic: "ai",
    mark: "done",
    title: "Připojit AI",
    status: "Zajišťuje vaše Organizace.",
  });
  expect(
    ai({
      ai: "connected",
      aiReading: {
        state: "connected",
        providers: [
          {
            provider: "codex",
            state: "signed-in",
            method: "chatgpt",
            account: "a@example.com",
          },
          { provider: "claude", state: "signed-in", account: "b@example.com" },
        ],
      },
    })?.status,
  ).toBe("Připojeno: ChatGPT, a@example.com; Claude, b@example.com");
  expect(
    startView(
      facts({
        ai: "connected",
        aiReading: {
          state: "connected",
          providers: [
            { provider: "codex", state: "signed-in", method: "api-key" },
          ],
        },
      }),
      en,
    )?.steps[0]?.status,
  ).toBe("Connected: OpenAI API key");
  expect(ai({ ai: "unknown", aiReading: null })?.status).toBe(
    "Nepodařilo se ověřit, jestli tu AI funguje.",
  );
  expect(ai({ ai: "loading", aiReading: null })?.status).toBe("Ověřuji…");
  // An AI that could not be read does not hold GitHub back.
  expect(
    startView(facts({ ai: "unknown", aiReading: null }), cs)?.github,
  ).toEqual({ enabled: true });
});

test("GitHub once AI is there, then the content, then all done", () => {
  const withAi = startView(facts({ ai: "connected" }), cs);
  expect(withAi?.steps[1]).toEqual({
    basic: "github",
    mark: "now",
    title: "GitHub",
    status: "Zpřístupní vaše repozitáře a moduly.",
  });
  expect(withAi?.github).toEqual({ enabled: true });
  expect(withAi?.intro).toBe(
    "Hotovo 1 ze 3 kroků. Stav se ověřuje přímo v Prostředí.",
  );
  const withGithub = startView(
    facts({ ai: "connected", github: "connected", githubLogin: "octocat" }),
    cs,
  );
  expect(withGithub?.steps[1]).toMatchObject({
    mark: "done",
    status: "Připojeno jako @octocat",
  });
  expect(withGithub?.github).toBeNull();
  expect(withGithub?.steps[2]).toMatchObject({ mark: "now" });
  const stopped = startView(
    facts({
      ai: "connected",
      github: "connected",
      content: {
        state: "failed",
        item: organization,
        job: { id: "job-1", state: "failed", steps: [] },
      },
    }),
    cs,
  );
  expect(stopped?.steps[2]?.mark).toBe("failed");
  const ready = startView(
    facts({
      ai: "organization",
      github: "connected",
      content: { state: "ready" },
    }),
    cs,
  );
  expect(ready?.done).toBe(3);
  expect(ready?.intro).toBe(
    "Prostředí je připravené. Sem se můžete kdykoli vrátit.",
  );
  expect(ready?.steps.map((step) => step.mark)).toEqual([
    "done",
    "done",
    "done",
  ]);
  // GitHub not read yet: it says it is checking, and offers nothing.
  expect(
    startView(facts({ ai: "connected", github: "unknown" }), cs)?.steps[1],
  ).toMatchObject({ mark: "later", status: "Ověřuji…" });
});

test("the content step's title names what lives here", () => {
  const title = (list: ContentList | null, preset = "local") =>
    startView(facts({ preset, list }), cs)?.steps[2]?.title;
  expect(title(listOf(organization))).toBe("Stáhnout Example Company");
  expect(title(listOf(personalspace), "hosted-personal")).toBe(
    "Připravit osobní prostor",
  );
  expect(title(listOf(organization, personalspace))).toBe(
    "Stáhnout Organizace a osobní prostor",
  );
  expect(title(null)).toBe("Obsah Prostředí");
  expect(
    startView(facts({ content: { state: "none" }, list: null }), en)?.steps[2],
  ).toMatchObject({
    mark: "done",
    status: "There is nothing to download here.",
  });
});

test("a Team or an Automated Environment has no Začínáme; the count shows only while a basic is missing", () => {
  for (const preset of [
    "hosted-organization-team",
    "hosted-organization-steward",
  ]) {
    expect(startView(facts({ preset }), cs)).toBeNull();
    expect(startCount(facts({ preset }))).toBeNull();
  }
  expect(startCount(facts())).toBe("0/3");
  expect(startCount(facts({ ai: "connected" }))).toBe("1/3");
  expect(
    startCount(
      facts({
        ai: "connected",
        github: "connected",
        content: { state: "ready" },
      }),
    ),
  ).toBeNull();
  // Not known is not missing.
  expect(
    startCount(
      facts({
        ai: "unknown",
        github: "connected",
        content: { state: "ready" },
      }),
    ),
  ).toBeNull();
});

test("Volitelné: Composio where Tools offer it, SSH and Codex Desktop on a Remote Environment", () => {
  expect(
    optionalRows(
      {
        preset: "hosted-organization-personal",
        composio: "missing",
        sshDevices: 0,
      },
      cs,
    ),
  ).toEqual([
    {
      id: "composio",
      title: "Composio",
      text: "Pošta, kalendář a další aplikace pro agenty.",
      status: "Nepřipojeno",
      action: { label: "Připojit", to: "composio" },
    },
    {
      id: "ssh",
      title: "SSH z vlastního počítače",
      text: "Terminál a editor ve vašem počítači.",
      status: "Nenastaveno",
      action: { label: "Návod", to: "/settings/ssh" },
    },
    {
      id: "codex",
      title: "Codex Desktop",
      text: "Pracujte s tímto Prostředím z aplikace Codex.",
      status: null,
      action: { label: "Návod", to: "/settings/ssh" },
    },
  ]);
  const connected = optionalRows(
    { preset: "hosted-personal", composio: "connected", sshDevices: 2 },
    cs,
  );
  expect(connected[0]).toMatchObject({ status: "Připojeno", action: null });
  expect(connected[1]?.status).toBe("Nastaveno");
  // This computer: Composio only; nothing where Composio is not offered.
  expect(
    optionalRows(
      { preset: "local", composio: "missing", sshDevices: null },
      cs,
    ).map((row) => row.id),
  ).toEqual(["composio"]);
  expect(
    optionalRows({ preset: "local", composio: "none", sshDevices: null }, cs),
  ).toEqual([]);
  // SSH not read: no state.
  expect(
    optionalRows(
      { preset: "hosted-personal", composio: "none", sshDevices: null },
      cs,
    )[0]?.status,
  ).toBeNull();
});

test("the content step waits for AI even with GitHub connected (Pablo's review of #436)", () => {
  expect(
    startView(facts({ ai: "missing", github: "connected" }), cs)?.steps[2]
      ?.mark,
  ).toBe("later");
  expect(
    startView(facts({ ai: "connected", github: "connected" }), cs)?.steps[2]
      ?.mark,
  ).toBe("now");
  // An AI that could not be checked does not hold it back.
  expect(
    startView(
      facts({ ai: "unknown", aiReading: null, github: "connected" }),
      cs,
    )?.steps[2]?.mark,
  ).toBe("now");
});
