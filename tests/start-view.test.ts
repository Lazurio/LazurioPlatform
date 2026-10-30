import { expect, test } from "bun:test";
import type { ContentItem, ContentList } from "../src/launchpad/content-client";
import type { ContentFact } from "../src/launchpad/content-view";
import { messages } from "../src/launchpad/messages";
import { pageRoute } from "../src/launchpad/routes";
import {
  optionalRows,
  type StartFacts,
  startCount,
  startView,
} from "../src/launchpad/start-view";
import {
  bitwardenGuide,
  offersBitwarden,
  type VaultPageModel,
  type VaultPagePerson,
} from "../src/launchpad/vault-page-view";
import type { VaultStatus } from "../src/vault/flow";

// Nastavení → Začínáme (root decision 0201 points 1-3; the wireframe's
// `screens/Start.tsx`, prototypes-lazurio 1eefc3d): the three basics checked
// from live facts in the order AI → GitHub → content, GitHub offered only
// after AI, the count, and the optional rows.

const cs = messages("cs");
const en = messages("en");
// The line beneath "Přihlásit kódem" (root decision 0201 point 10, wording
// of 2026-10-22): the setting only for a code ChatGPT's page refuses.
const byCodeHint =
  "Kdyby stránka ChatGPT kód nepřijala, zapněte si přihlášení kódem v nastavení zabezpečení ChatGPT. U pracovního účtu ho povoluje jeho správce.";

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
    intro: "Hotovo 0 ze 3 kroků.",
    done: 0,
    total: 3,
    steps: [
      // Only the title and the two sign-ins (Matěj, 2026-10-16).
      { basic: "ai", mark: "now", title: "Připojit AI", status: null },
      // What GitHub is for; its number says it comes after AI.
      {
        basic: "github",
        mark: "later",
        title: "GitHub",
        status: "Nepřipojeno",
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
    // ChatGPT or Claude, nothing said before them; beneath them ChatGPT by
    // code with the setting it needs (root decision 0201 point 10).
    ai: { kind: "choose", cancel: false, byCode: { hint: byCodeHint } },
    // No Buddy on a work Environment (decision F65).
    buddy: null,
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

test("Připojit AI: only the title and ChatGPT or Claude, in the Environment browser and on a computer alike, and nothing without it (F19's addendum of 2026-10-15, F36's of 2026-10-16)", () => {
  const step = (overrides: Partial<StartFacts>, copy = cs) => {
    const view = startView(facts(overrides), copy);
    return { step: view?.steps[0], ai: view?.ai };
  };
  // With the Environment browser too: no line and no sentence before the
  // choice, in either language (Matěj, 2026-10-16).
  for (const copy of [cs, en])
    expect(step({ aiPlace: "panel" }, copy)).toEqual({
      step: {
        basic: "ai",
        mark: "now",
        title: copy.startAiTitle,
        status: null,
      },
      ai: {
        kind: "choose",
        cancel: false,
        byCode: { hint: copy.startAiByCodeSetting },
      },
    });
  expect(step({ aiPlace: "own" }).ai).toEqual({
    kind: "choose",
    cancel: false,
    byCode: { hint: byCodeHint },
  });
  // An AI that could not be checked is offered too.
  expect(step({ ai: "unknown", aiReading: null, aiPlace: "own" }).ai).toEqual({
    kind: "choose",
    cancel: false,
    byCode: { hint: byCodeHint },
  });
  // Without the Environment browser the step says why and starts nothing.
  expect(step({ aiPlace: "none" })).toEqual({
    step: {
      basic: "ai",
      mark: "now",
      title: "Připojit AI",
      status: "Přihlášení tu teď nejde otevřít.",
    },
    ai: { kind: "none" },
  });
  // Provided by the Organization: done, nothing runs.
  expect(
    step({
      ai: "organization",
      aiPlace: "panel",
      aiReading: {
        state: "organization",
        providers: [{ provider: "codex", state: "provided" }],
      },
    }),
  ).toEqual({
    step: {
      basic: "ai",
      mark: "done",
      title: "Připojit AI",
      status: "Zajišťuje vaše Organizace.",
    },
    ai: { kind: "none" },
  });
  // Still checking: nothing offered yet.
  expect(step({ ai: "loading", aiReading: null }).ai).toEqual({ kind: "none" });
});

test("Připojit AI while signing in: where to finish it, the panel again, Zrušit, and the code of Claude's code page", () => {
  const step = (overrides: Partial<StartFacts>, copy = cs) => {
    const view = startView(facts(overrides), copy);
    return {
      status: view?.steps[0]?.status,
      mark: view?.steps[0]?.mark,
      ai: view?.ai,
    };
  };
  const session = "0123456789abcdef0123456789abcdef";
  expect(
    step({ aiPlace: "panel", aiSignIn: { kind: "starting", tool: "codex" } }),
  ).toEqual({
    status: "Spouštím přihlášení…",
    mark: "now",
    ai: { kind: "signing-in", reopen: null, code: null },
  });
  expect(
    step({
      aiPlace: "panel",
      aiSignIn: {
        kind: "waiting",
        tool: "codex",
        session,
        view: "https://browser.example.lazurio.io/t/0123456789ABCDEF0123456789ABCDEF",
        code: false,
      },
    }),
  ).toEqual({
    status: "Dokončete přihlášení k ChatGPT v prohlížeči vpravo.",
    mark: "now",
    ai: { kind: "signing-in", reopen: { panel: true }, code: null },
  });
  const page = "https://claude.com/cai/oauth/authorize?code=true";
  expect(
    step(
      {
        aiSignIn: {
          kind: "waiting",
          tool: "claude",
          session,
          url: page,
          code: true,
        },
      },
      en,
    ),
  ).toEqual({
    status: "Finish signing in to Claude in your browser window.",
    mark: "now",
    ai: { kind: "signing-in", reopen: { url: page }, code: { note: null } },
  });
  expect(
    step({
      aiSignIn: {
        kind: "waiting",
        tool: "claude",
        session,
        url: page,
        code: true,
        codeNote: "invalid",
      },
    }).ai,
  ).toEqual({
    kind: "signing-in",
    reopen: { url: page },
    code: {
      note: {
        text: "Toto není celý kód. Zkopírujte ho prosím znovu celý.",
        tone: "warn",
      },
    },
  });
  expect(
    step({ aiSignIn: { kind: "finishing", tool: "claude", session } }),
  ).toEqual({
    status: "Přihlášeno k Claude. Dokončuje se…",
    mark: "now",
    ai: { kind: "none" },
  });
});

test("Připojit AI that did not finish, and a connected one: Zkusit znovu, the accounts, another account, and services that did not read it", () => {
  const view = (overrides: Partial<StartFacts>, copy = cs) =>
    startView(facts(overrides), copy);
  for (const [reason, status] of [
    ["failed", "Přihlášení se nepovedlo. Zkuste to prosím znovu."],
    ["expired", "Přihlášení vypršelo. Zkuste to prosím znovu."],
    [
      "browser-unavailable",
      "Prohlížeč Prostředí přihlašovací stránku neotevřel. Zkuste to prosím znovu.",
    ],
    [
      "no-answer",
      "Lazurio na přihlášení neodpovědělo. Zkuste to prosím znovu.",
    ],
  ] as const) {
    const failed = view({
      aiPlace: "panel",
      aiSignIn: { kind: "failed", tool: "codex", reason },
    });
    expect([
      failed?.steps[0]?.mark,
      failed?.steps[0]?.status,
      failed?.ai,
    ]).toEqual(["failed", status, { kind: "retry", tool: "codex" }]);
  }
  const connected = {
    ai: "connected" as const,
    aiReading: {
      state: "connected" as const,
      providers: [
        {
          provider: "codex" as const,
          state: "signed-in" as const,
          method: "chatgpt" as const,
          account: "a@example.com",
        },
        { provider: "claude" as const, state: "signed-out" as const },
      ],
    },
    aiPlace: "panel" as const,
  };
  expect(view(connected)?.steps[0]).toEqual({
    basic: "ai",
    mark: "done",
    title: "Připojit AI",
    status: "Připojeno: ChatGPT, a@example.com",
  });
  expect(view(connected)?.ai).toEqual({ kind: "connected" });
  // "Přihlásit jiný účet": the choice again, with Zrušit.
  expect(view({ ...connected, aiChoosing: true })?.ai).toEqual({
    kind: "choose",
    cancel: true,
    byCode: { hint: byCodeHint },
  });
  // Signing the second one in keeps the step done.
  expect(
    view({ ...connected, aiSignIn: { kind: "starting", tool: "claude" } })
      ?.steps[0]?.mark,
  ).toBe("done");
  // A second sign-in that did not finish: the accounts stay, with why.
  const retried = view({
    ...connected,
    aiSignIn: { kind: "failed", tool: "claude", reason: "expired" },
  });
  expect(retried?.steps[0]).toEqual({
    basic: "ai",
    mark: "done",
    title: "Připojit AI",
    status: "Připojeno: ChatGPT, a@example.com",
    warning: "Přihlášení vypršelo. Zkuste to prosím znovu.",
  });
  expect(retried?.ai).toEqual({ kind: "retry", tool: "claude" });
  // Chat could not turn the provider on: a clear sentence beside the account.
  expect(
    view({
      ...connected,
      aiSignIn: {
        kind: "signed-in",
        tool: "codex",
        services: {
          appServer: { state: "restarted" },
          t3: { state: "driver-mismatch", mismatches: [] },
        },
      },
    })?.steps[0]?.warning,
  ).toBe("Chat nezapnul Codex. Zkontrolujte poskytovatele v Nastavení Chatu.");
  expect(
    view(
      {
        ...connected,
        aiSignIn: {
          kind: "signed-in",
          tool: "codex",
          services: { t3: { state: "failed", reason: "not-running" } },
        },
      },
      en,
    )?.steps[0]?.warning,
  ).toBe("Chat and Codex start using the sign-in a little later.");
  // T3 Code answered without an enabled instance of it (Pablo's review of
  // #441): said as a failure, not as "later".
  expect(
    view({
      ...connected,
      aiSignIn: {
        kind: "signed-in",
        tool: "claude",
        services: {
          t3: { state: "failed", reason: "not-enabled", providers: ["claude"] },
        },
      },
    })?.steps[0]?.warning,
  ).toBe("Chat nezapnul Claude. Zkontrolujte poskytovatele v Nastavení Chatu.");
  // Codex did not say whether the Organization provides the AI: said
  // without the mechanics (F36's addendum of 2026-10-16).
  expect(
    view({
      aiSignIn: { kind: "failed", tool: "codex", reason: "provider-unknown" },
    })?.steps[0]?.status,
  ).toBe("Přihlášení se nespustilo. Zkuste to prosím znovu.");
  // Services that read it, or will by themselves: nothing to say.
  expect(
    view({
      ...connected,
      aiSignIn: {
        kind: "signed-in",
        tool: "codex",
        services: { t3: { state: "not-supported" } },
      },
    })?.steps[0],
  ).not.toHaveProperty("warning");
});

test("Přihlásit kódem (root decision 0201 point 10): ChatGPT's quieter sign-in by code beneath the two, the code and OpenAI's page while it waits, never for Claude, the Organization's AI or a Team Environment", () => {
  const view = (overrides: Partial<StartFacts>, copy = cs) =>
    startView(facts(overrides), copy);
  const session = "0123456789abcdef0123456789abcdef";
  const url = "https://auth.openai.com/codex/device";
  const code = "QX7P-4MZ2K";
  // Beneath the choice, with the setting for a code ChatGPT's page refuses,
  // in both languages.
  expect(en.startAiByCodeSetting).toBe(
    "If the ChatGPT page refuses the code, turn on sign-in with a code in your ChatGPT security settings. For a work account, its admin allows it.",
  );
  for (const copy of [cs, en])
    for (const aiPlace of ["panel", "own"] as const)
      expect(view({ aiPlace }, copy)?.ai).toEqual({
        kind: "choose",
        cancel: false,
        byCode: { hint: copy.startAiByCodeSetting },
      });
  // Starting: the usual line.
  expect(
    view({
      aiPlace: "panel",
      aiSignIn: { kind: "starting", tool: "codex", byCode: true },
    })?.steps[0]?.status,
  ).toBe("Spouštím přihlášení…");
  // While its code waits: what to do, the code and OpenAI's page, Zrušit.
  for (const [copy, status] of [
    [
      cs,
      "Otevřete stránku ChatGPT v kterémkoli prohlížeči, třeba v telefonu, a opište kód. Platí 15 minut.",
    ],
    [
      en,
      "Open the ChatGPT page in any browser, even on your phone, and enter the code. It is valid for 15 minutes.",
    ],
  ] as const) {
    const waiting = view(
      {
        aiPlace: "panel",
        aiSignIn: { kind: "by-code", tool: "codex", session, url, code },
      },
      copy,
    );
    expect(waiting?.steps[0]).toEqual({
      basic: "ai",
      mark: "now",
      title: copy.startAiTitle,
      status,
    });
    expect(waiting?.ai).toEqual({ kind: "by-code", url, code });
  }
  // A sign-in by code that did not finish starts by code again.
  const expired = view({
    aiSignIn: {
      kind: "failed",
      tool: "codex",
      reason: "expired",
      byCode: true,
    },
  });
  expect([expired?.steps[0]?.status, expired?.ai]).toEqual([
    "Přihlášení vypršelo. Zkuste to prosím znovu.",
    { kind: "retry", tool: "codex", byCode: true },
  ]);
  // Never for Claude's sign-in, the Organization's AI, a reading under way,
  // an Environment without its browser, or a Team Environment.
  expect(
    view({
      aiSignIn: {
        kind: "waiting",
        tool: "claude",
        session,
        url: "https://claude.com/cai/oauth/authorize",
        code: true,
      },
    })?.ai,
  ).toEqual({
    kind: "signing-in",
    reopen: { url: "https://claude.com/cai/oauth/authorize" },
    code: { note: null },
  });
  expect(
    view({ aiSignIn: { kind: "failed", tool: "claude", reason: "expired" } })
      ?.ai,
  ).toEqual({ kind: "retry", tool: "claude" });
  expect(
    view({
      ai: "organization",
      aiReading: {
        state: "organization",
        providers: [{ provider: "codex", state: "provided" }],
      },
    })?.ai,
  ).toEqual({ kind: "none" });
  expect(view({ ai: "loading", aiReading: null })?.ai).toEqual({
    kind: "none",
  });
  expect(view({ aiPlace: "none" })?.ai).toEqual({ kind: "none" });
  expect(view({ preset: "hosted-organization-team" })).toBeNull();
});

test("GitHub once AI is there, then the content, then all done", () => {
  const withAi = startView(facts({ ai: "connected" }), cs);
  expect(withAi?.steps[1]).toEqual({
    basic: "github",
    mark: "now",
    title: "GitHub",
    status: "Nepřipojeno",
  });
  expect(withAi?.github).toEqual({ enabled: true });
  expect(withAi?.intro).toBe("Hotovo 1 ze 3 kroků.");
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
  expect(ready?.intro).toBe("Prostředí je připravené.");
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

test("Volitelné: Composio where Tools offer it, SSH and ChatGPT Desktop on a Remote Environment", () => {
  expect(
    optionalRows(
      {
        preset: "hosted-organization-personal",
        composio: "missing",
        sshDevices: 0,
        bitwarden: false,
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
      title: "ChatGPT Desktop",
      text: "Pracujte s tímto Prostředím z ChatGPT Desktopu.",
      status: null,
      action: { label: "Návod", to: "/settings/ssh" },
    },
  ]);
  const connected = optionalRows(
    {
      preset: "hosted-personal",
      composio: "connected",
      sshDevices: 2,
      bitwarden: false,
    },
    cs,
  );
  expect(connected[0]).toMatchObject({ status: "Připojeno", action: null });
  expect(connected[1]?.status).toBe("Nastaveno");
  // This computer: Composio only; nothing where Composio is not offered.
  expect(
    optionalRows(
      {
        preset: "local",
        composio: "missing",
        sshDevices: null,
        bitwarden: false,
      },
      cs,
    ).map((row) => row.id),
  ).toEqual(["composio"]);
  expect(
    optionalRows(
      { preset: "local", composio: "none", sshDevices: null, bitwarden: false },
      cs,
    ),
  ).toEqual([]);
  // SSH not read: no state.
  expect(
    optionalRows(
      {
        preset: "hosted-personal",
        composio: "none",
        sshDevices: null,
        bitwarden: false,
      },
      cs,
    )[0]?.status,
  ).toBeNull();
  // Signed in to Composio, but not in the organization of the Organization's
  // name (the end-to-end test of 2026-10-19: Začínáme said "Připojeno" while
  // Apps → Integrace warned): not done, and its action opens Composio's
  // dialog at the step left (ui.ts).
  for (const [copy, status, label] of [
    [cs, "Nedokončeno", "Dokončit"],
    [en, "Not finished", "Finish"],
  ] as const)
    expect(
      optionalRows(
        {
          preset: "hosted-organization-personal",
          composio: "unfinished",
          sshDevices: 1,
          bitwarden: false,
        },
        copy,
      )[0],
    ).toMatchObject({
      id: "composio",
      status,
      action: { label, to: "composio" },
    });
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

// "Trezor v Bitwardenu" (the wireframe's row of prototypes-lazurio 1eefc3d,
// F53's addendum of 2026-10-16, plan DEV-6665): exactly where Apps → Trezor
// (F53's addendum of 2026-10-18) gives the steps for Bitwarden in Codex
// Desktop and the person's browser, its "Návod" leads there, to their
// section. No state: the extension is on
// the person's computer, where the Environment cannot see it.
test("Volitelné: Trezor v Bitwardenu where the Environment has a vault whose page gives the steps, leading to them", () => {
  const remote = {
    preset: "hosted-organization-personal",
    composio: "none",
    sshDevices: 0,
    bitwarden: true,
  } as const;
  expect(optionalRows(remote, cs)).toEqual([
    {
      id: "ssh",
      title: "SSH z vlastního počítače",
      text: "Terminál a editor ve vašem počítači.",
      status: "Nenastaveno",
      action: { label: "Návod", to: "/settings/ssh" },
    },
    {
      id: "bitwarden",
      title: "Trezor v Bitwardenu",
      text: "Hesla z Trezoru Prostředí i v ChatGPT Desktopu a ve vašem prohlížeči.",
      status: null,
      action: { label: "Návod", to: "/vault", part: "bitwarden" },
    },
    {
      id: "codex",
      title: "ChatGPT Desktop",
      text: "Pracujte s tímto Prostředím z ChatGPT Desktopu.",
      status: null,
      action: { label: "Návod", to: "/settings/ssh" },
    },
  ]);
  expect(optionalRows(remote, en)[1]).toEqual({
    id: "bitwarden",
    title: "Vault in Bitwarden",
    text: "Your Environment vault's passwords in ChatGPT Desktop and your browser too.",
    status: null,
    action: { label: "Guide", to: "/vault", part: "bitwarden" },
  });
  // Its "Návod" opens Trezor's page in the Apps column, not Settings.
  const to = optionalRows(remote, cs)[1]?.action?.to;
  expect(to === undefined ? null : pageRoute(to)).toEqual({ view: "vault" });
  // The row follows the vault as Apps → Trezor reads it (`GET
  // /api/vault`) and, for a Lazurio Vaultwarden, the person's membership
  // answer the page asks too (`offersBitwarden`): exactly where the page
  // gives the steps (Pablo's review of #465).
  const vault = "https://vaultwarden.example.lazurio.io";
  const facts = {
    vault,
    account:
      "vaultwarden-q2wd5oyrbkmfx3czjh7tapi4ul@workspace.example.lazurio.io",
    name: "Pracovní example",
    team: false,
    origin: "own",
  } as const;
  const connected: VaultStatus = {
    kind: "vault-status",
    state: "connected",
    ...facts,
    organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
    collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
    organization: facts.name,
    items: 2,
  };
  const page = (
    status: VaultStatus,
    environment: VaultPageModel["environment"],
  ): VaultPageModel => ({ status, setup: null, environment, name: null });
  const shown = (
    status: VaultStatus,
    environment: VaultPageModel["environment"],
    person: VaultPagePerson | null,
  ) =>
    optionalRows(
      {
        ...remote,
        preset:
          environment === "personal"
            ? "hosted-personal"
            : "hosted-organization-personal",
        bitwarden: offersBitwarden(page(status, environment), person),
      },
      cs,
    ).some((row) => row.id === "bitwarden");
  const member = { kind: "known", state: "member", signIn: false } as const;
  const steps = (
    status: VaultStatus,
    environment: VaultPageModel["environment"],
    person: VaultPagePerson | null,
  ) => bitwardenGuide(page(status, environment), person, cs) !== null;
  // A Lazurio Vaultwarden: once the answer is there, and only where it does
  // not say that only the agents use the vault; the page agrees each time.
  for (const [person, expected] of [
    [member, true],
    [{ kind: "known", state: "no-account", signIn: true }, true],
    [{ kind: "unknown", reason: "no-username" }, true],
    [{ kind: "unknown", reason: "failed" }, true],
    [{ kind: "unknown", reason: "sign-in-not-required" }, false],
    [{ kind: "unknown", reason: "not-managed" }, false],
  ] as const) {
    expect([person, shown(connected, "work", person)]).toEqual([
      person,
      expected,
    ]);
    expect(steps(connected, "work", person)).toBe(expected);
  }
  // Before the answer: not promised yet.
  expect(shown(connected, "work", null)).toBe(false);
  expect(
    shown(
      { kind: "vault-status", state: "not-allowed", ...facts },
      "work",
      member,
    ),
  ).toBe(true);
  // A personal Environment's own Bitwarden needs no answer.
  expect(
    shown(
      {
        kind: "vault-status",
        state: "creating",
        ...facts,
        vault: "https://vault.bitwarden.eu",
        name: "Osobní example",
        region: "eu",
      },
      "personal",
      null,
    ),
  ).toBe(true);
  expect(
    shown(
      { kind: "vault-status", state: "needs-connection" },
      "personal",
      null,
    ),
  ).toBe(false);
  expect(
    shown(
      { kind: "vault-status", state: "unsupported", reason: "no-vault" },
      null,
      null,
    ),
  ).toBe(false);
  // This computer has no vault, so neither the row.
  expect(
    optionalRows(
      { preset: "local", composio: "none", sshDevices: null, bitwarden: false },
      cs,
    ),
  ).toEqual([]);
});

// #515 and #516 (F19's addendum of 2026-10-19): GitHub signed in while SSH
// does not work here is connected badly. The step says so and offers one
// action that finishes it; the content waits for it. A sign-in this page
// holds (its window closed while it ran, or open) shows as running, and
// "Otevřít" shows it again.
test("GitHub connected badly: the step says it does not work and offers to connect again, in both languages", () => {
  const broken = startView(
    facts({ ai: "connected", github: "incomplete", githubLogin: "octocat" }),
    cs,
  );
  expect(broken?.steps[1]).toEqual({
    basic: "github",
    mark: "failed",
    title: "GitHub",
    status: "Připojení nefunguje.",
  });
  expect(broken?.github).toEqual({ enabled: true, kind: "reconnect" });
  expect(broken?.done).toBe(1);
  // Its turn comes after GitHub: the content is not offered.
  expect(broken?.steps[2]?.mark).toBe("later");
  expect(
    startView(facts({ ai: "connected", github: "incomplete" }), en)?.steps[1]
      ?.status,
  ).toBe("The connection does not work.");
  expect(cs.startGithubReconnect).toBe("Připojit znovu");
  expect(en.startGithubReconnect).toBe("Connect again");
  // Before AI it waits for its turn, as a missing GitHub does.
  const early = startView(facts({ github: "incomplete" }), cs);
  expect(early?.steps[1]).toMatchObject({
    mark: "later",
    status: "Připojení nefunguje.",
  });
  expect(early?.github).toEqual({ enabled: false, kind: "reconnect" });
  expect(startCount(facts({ ai: "connected", github: "incomplete" }))).toBe(
    "1/3",
  );
});

test("a GitHub sign-in that runs shows as running, its window closed or not, and opens again", () => {
  for (const github of ["missing", "incomplete"] as const) {
    const waiting = startView(
      facts({ ai: "connected", github, githubFlow: "waiting" }),
      cs,
    );
    expect(waiting?.steps[1]).toEqual({
      basic: "github",
      mark: "now",
      title: "GitHub",
      status: "Čeká na vaše potvrzení.",
    });
    expect(waiting?.github).toEqual({ enabled: true, kind: "open" });
    const finishing = startView(
      facts({ ai: "connected", github, githubFlow: "finishing" }),
      cs,
    );
    expect(finishing?.steps[1]?.status).toBe("Dokončuje se připojení…");
    expect(finishing?.github).toEqual({ enabled: true, kind: "open" });
    // Nothing done yet: it is not counted, and the content waits.
    expect(finishing?.done).toBe(1);
    expect(finishing?.steps[2]?.mark).toBe("later");
  }
  expect(
    startView(
      facts({ ai: "connected", github: "missing", githubFlow: "finishing" }),
      en,
    )?.steps[1]?.status,
  ).toBe("Finishing the connection…");
  expect(
    startView(
      facts({ ai: "connected", github: "missing", githubFlow: "waiting" }),
      en,
    )?.steps[1]?.status,
  ).toBe("Waiting for your confirmation.");
});
