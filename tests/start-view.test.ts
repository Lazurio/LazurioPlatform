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
import {
  bitwardenTarget,
  type VaultPageModel,
} from "../src/launchpad/vault-page-view";
import type { VaultStatus } from "../src/vault/flow";

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
    // ChatGPT or Claude; on a computer of one's own no sentence before them.
    ai: { kind: "choose", before: null, cancel: false },
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

test("Připojit AI: ChatGPT or Claude, the sentence before them in the Environment browser, and nothing without it (F19's addendum of 2026-10-15)", () => {
  const step = (overrides: Partial<StartFacts>, copy = cs) => {
    const view = startView(facts(overrides), copy);
    return { step: view?.steps[0], ai: view?.ai };
  };
  // A Remote Environment with its Environment browser: the passwords of the
  // person's own computer do not reach it, said once before the choice.
  expect(step({ aiPlace: "panel" })).toEqual({
    step: {
      basic: "ai",
      mark: "now",
      title: "Připojit AI",
      status: "Agent vám pak pomůže s dalšími kroky.",
    },
    ai: {
      kind: "choose",
      before:
        "Připravte si heslo k ChatGPT nebo Claude (případně ke Googlu) a telefon, protože správce hesel ani passkey z počítače tu nefungují.",
      cancel: false,
    },
  });
  expect(step({ aiPlace: "panel" }, en).ai).toEqual({
    kind: "choose",
    before:
      "Have your ChatGPT or Claude password (or your Google one) and your phone ready: your computer's password manager and passkeys do not work here.",
    cancel: false,
  });
  // An AI that could not be checked is offered too.
  expect(step({ ai: "unknown", aiReading: null, aiPlace: "own" }).ai).toEqual({
    kind: "choose",
    before: null,
    cancel: false,
  });
  // Without the Environment browser the step says why and starts nothing.
  expect(step({ aiPlace: "none" })).toEqual({
    step: {
      basic: "ai",
      mark: "now",
      title: "Připojit AI",
      status:
        "Přihlášení se otevírá v prohlížeči Prostředí. Ten tu zatím není, doplní ho aktualizace Prostředí.",
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
    status: "Přihlášeno k Claude. Chat a Codex teď přihlášení načítají…",
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
    before:
      "Připravte si heslo k ChatGPT nebo Claude (případně ke Googlu) a telefon, protože správce hesel ani passkey z počítače tu nefungují.",
    cancel: true,
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
  ).toBe(
    "Chat nezapnul Codex, protože se tak u něj jmenuje jiný poskytovatel. Zkontrolujte poskytovatele v Nastavení Chatu.",
  );
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
  // Codex did not say whether the Organization provides the AI.
  expect(
    view({
      aiSignIn: { kind: "failed", tool: "codex", reason: "provider-unknown" },
    })?.steps[0]?.status,
  ).toBe(
    "Codex neřekl, jestli tu AI zajišťuje vaše Organizace, a proto se nic nespustilo. Zkuste to prosím znovu.",
  );
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
      title: "Codex Desktop",
      text: "Pracujte s tímto Prostředím z aplikace Codex.",
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
// F53's addendum of 2026-10-16, plan DEV-6665): where Nastavení → Trezor
// gives the steps for Bitwarden in Codex Desktop and the person's browser,
// its "Návod" leads there, to their section. No state: the extension is on
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
      text: "Hesla z Trezoru Prostředí i v Codex Desktopu a ve vašem prohlížeči.",
      status: null,
      action: { label: "Návod", to: "/settings/vault", part: "bitwarden" },
    },
    {
      id: "codex",
      title: "Codex Desktop",
      text: "Pracujte s tímto Prostředím z aplikace Codex.",
      status: null,
      action: { label: "Návod", to: "/settings/ssh" },
    },
  ]);
  expect(optionalRows(remote, en)[1]).toEqual({
    id: "bitwarden",
    title: "Vault in Bitwarden",
    text: "Your Environment vault's passwords in Codex Desktop and your browser too.",
    status: null,
    action: { label: "Guide", to: "/settings/vault", part: "bitwarden" },
  });
  // The row follows the vault as Nastavení → Trezor reads it (`GET
  // /api/vault`): shown with an Organization's vault or a personal
  // Environment's own Bitwarden, hidden without one.
  const vault = "https://vaultwarden.example.lazurio.io";
  const facts = {
    vault,
    account:
      "vaultwarden-q2wd5oyrbkmfx3czjh7tapi4ul@workspace.example.lazurio.io",
    name: "Pracovní example",
    team: false,
    origin: "own",
  } as const;
  const page = (
    status: VaultStatus,
    environment: VaultPageModel["environment"],
  ): VaultPageModel => ({ status, setup: null, environment });
  const shown = (
    status: VaultStatus,
    environment: VaultPageModel["environment"],
  ) =>
    optionalRows(
      {
        ...remote,
        preset:
          environment === "personal"
            ? "hosted-personal"
            : "hosted-organization-personal",
        bitwarden: bitwardenTarget(page(status, environment)) !== null,
      },
      cs,
    ).some((row) => row.id === "bitwarden");
  expect(
    shown(
      {
        kind: "vault-status",
        state: "connected",
        ...facts,
        organizationId: "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b",
        collectionId: "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d",
        organization: facts.name,
        items: 2,
      },
      "work",
    ),
  ).toBe(true);
  expect(
    shown({ kind: "vault-status", state: "not-allowed", ...facts }, "work"),
  ).toBe(true);
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
    ),
  ).toBe(true);
  expect(
    shown({ kind: "vault-status", state: "needs-connection" }, "personal"),
  ).toBe(false);
  expect(
    shown(
      { kind: "vault-status", state: "unsupported", reason: "no-vault" },
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
