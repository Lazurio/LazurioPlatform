import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { messages } from "../src/launchpad/messages";
import {
  bitwardenGuide,
  bitwardenTarget,
  connectionFilled,
  connectionRefusalText,
  parseVaultMembership,
  parseVaultPage,
  type VaultPageModel,
  type VaultPagePerson,
  vaultPageLinks,
  vaultPageView,
} from "../src/launchpad/vault-page-view";
import type { VaultStatus } from "../src/vault/flow";

// Settings → Vault, Nastavení → Trezor (root decision 0198 point 5): the
// page's pure part, on answers of the server's shapes. Its HTTP behaviour
// is tests/launchpad-vault-page.test.ts.

const cs = messages("cs");
const en = messages("en");
const vault = "https://vaultwarden.example.lazurio.io";
const organizationId = "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b";
const collectionId = "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d";
const facts = {
  vault,
  account: "vaultwarden-ndbrmzvjpwxtt3q7m2e4fihgsa@example.lazurio.io",
  name: "Example Osobní example",
  team: false,
  origin: "own",
} as const;
const connected = (
  items: number | null = 12,
): Extract<VaultStatus, { state: "connected" }> => ({
  kind: "vault-status",
  state: "connected",
  ...facts,
  organizationId,
  collectionId,
  organization: facts.name,
  items,
});
const model = (
  status: VaultStatus,
  fields: Partial<VaultPageModel> = {},
): VaultPageModel => ({
  status,
  setup: null,
  environment: "personal",
  ...fields,
});
const member = { kind: "known", state: "member", signIn: false } as const;
const labels = (view: ReturnType<typeof vaultPageView>) =>
  view.actions.map((action) => [action.control, action.label, action.href]);

test("the page's answers are read only in their exact form", () => {
  const page = { kind: "vault-page", status: connected(), setup: null };
  expect(parseVaultPage({ ...page, environment: "work" })).toEqual({
    status: connected(),
    setup: null,
    environment: "work",
  });
  for (const refused of [
    null,
    [],
    { ...page, environment: "elsewhere" },
    { ...page, environment: "work", setup: "download" },
    { ...page, environment: "work", status: { kind: "vault-status" } },
    { ...page, environment: "work", kind: "vault-status" },
  ])
    expect(parseVaultPage(refused)).toBeNull();
  expect(
    parseVaultMembership({ kind: "vault-member", state: "no-account" }),
  ).toEqual({ kind: "known", state: "no-account", signIn: false });
  expect(
    parseVaultMembership({
      kind: "vault-member",
      state: "awaiting-password",
      signIn: true,
    }),
  ).toEqual({ kind: "known", state: "awaiting-password", signIn: true });
  expect(
    parseVaultMembership({ kind: "vault-member-unknown", reason: "busy" }),
  ).toEqual({ kind: "unknown", reason: "busy" });
  expect(
    parseVaultMembership({
      kind: "vault-member-unknown",
      reason: "no-username",
    }),
  ).toEqual({ kind: "unknown", reason: "no-username" });
  for (const refused of [
    { kind: "vault-member", state: "owner" },
    { kind: "vault-member", state: "member", signIn: "yes" },
    { kind: "vault-member-unknown", reason: "elsewhere" },
    { kind: "vault-member-unknown" },
    "member",
  ])
    expect(parseVaultMembership(refused)).toBeNull();
});

test("the links lead into the network's vault by the vault's exact ids, and nowhere else", () => {
  expect(vaultPageLinks(connected())).toEqual({
    add: `${vault}/#/vault?organizationId=${organizationId}&collectionId=${collectionId}`,
    open: `${vault}/#/vault?organizationId=${organizationId}`,
    account: `${vault}/#/login`,
  });
  // A 0197 pilot opens its collection in the person's organization.
  expect(vaultPageLinks({ ...connected(), origin: "pilot-0197" })).toEqual({
    add: null,
    open: `${vault}/#/vault?organizationId=${organizationId}&collectionId=${collectionId}`,
    account: `${vault}/#/login`,
  });
  // Not connected: only the sign-in; not https or not a bare origin: none.
  expect(
    vaultPageLinks({
      kind: "vault-status",
      state: "not-set-up",
      ...facts,
      next: "install",
    }),
  ).toEqual({ add: null, open: null, account: `${vault}/#/login` });
  for (const origin of [
    "http://vaultwarden.example.lazurio.io",
    `${vault}/path`,
    `${vault}:8443`,
    "https://user@vaultwarden.example.lazurio.io",
  ])
    expect(vaultPageLinks({ ...connected(), vault: origin })).toEqual({
      add: null,
      open: null,
      account: null,
    });
  expect(
    vaultPageLinks({
      kind: "vault-status",
      state: "unsupported",
      reason: "workstation",
    }),
  ).toEqual({ add: null, open: null, account: null });
});

test("a member adds and opens; without an account only the sign-in, and only where the vault takes it", () => {
  const view = vaultPageView(model(connected()), member, cs);
  expect(view).toMatchObject({
    rule: true,
    note: null,
    row: { title: facts.name, line: "12 položek", tone: "ok" },
    hint: null,
  });
  expect(labels(view)).toEqual([
    [
      "add",
      "Přidat položku",
      `${vault}/#/vault?organizationId=${organizationId}&collectionId=${collectionId}`,
    ],
    [
      "open",
      "Otevřít trezor",
      `${vault}/#/vault?organizationId=${organizationId}`,
    ],
  ]);
  expect(view.actions.map((action) => action.primary)).toEqual([false, true]);
  for (const state of ["no-account", "awaiting-password"] as const) {
    expect(
      labels(
        vaultPageView(
          model(connected()),
          { kind: "known", state, signIn: true },
          cs,
        ),
      ),
    ).toEqual([["account", "Vytvořit účet v trezoru", `${vault}/#/login`]]);
    expect(
      vaultPageView(
        model(connected()),
        { kind: "known", state, signIn: false },
        cs,
      ).actions,
    ).toEqual([]);
  }
  // Not known (nobody named, the vault busy or away): the vault opens.
  for (const reason of ["no-identity", "busy", "unreachable"] as const) {
    const unknown = vaultPageView(
      model(connected()),
      { kind: "unknown", reason },
      cs,
    );
    expect(labels(unknown).map(([control]) => control)).toEqual(["open"]);
    expect(unknown.hint).toBeNull();
  }
  // Asked, not answered yet: no action.
  expect(vaultPageView(model(connected()), null, cs).actions).toEqual([]);
});

test("a person whose sign-in carried no Lazurio username: the vault opens, and one line says why they are not added and asks them to sign in again", () => {
  const unnamed = { kind: "unknown", reason: "no-username" } as const;
  const view = vaultPageView(model(connected()), unnamed, cs);
  expect(labels(view)).toEqual([
    [
      "open",
      "Otevřít trezor",
      `${vault}/#/vault?organizationId=${organizationId}`,
    ],
  ]);
  expect(view.hint).toBe(
    "Vaše přihlášení zatím neobsahuje uživatelské jméno v Lazuriu, proto vás toto Prostředí nemůže přidat do svého trezoru. Přihlaste se prosím znovu.",
  );
  expect(vaultPageView(model(connected()), unnamed, en).hint).toBe(
    "Your sign-in does not include your Lazurio username yet, so this Environment cannot add you to its vault. Please sign in again.",
  );
  // A Team or Automated Environment says only that its agents use the
  // vault, whoever the person is.
  expect(
    vaultPageView(model(connected(), { environment: "team" }), unnamed, cs)
      .hint,
  ).toBe("Trezor tohoto Prostředí používají jen jeho agenti.");
});

test("the vault's state: the items in Czech plural, the creation, no answer, and the links kept while it does not answer", () => {
  const line = (status: VaultStatus, locale = cs) =>
    vaultPageView(model(status), member, locale).row?.line;
  expect(line(connected(1))).toBe("1 položka");
  expect(line(connected(3))).toBe("3 položky");
  expect(line(connected(0))).toBe("0 položek");
  expect(line(connected(1), en)).toBe("1 item");
  expect(line(connected(7), en)).toBe("7 items");
  expect(line(connected(null))).toBe("Připojeno");
  const creating = vaultPageView(
    model(
      { kind: "vault-status", state: "not-set-up", ...facts, next: "vault" },
      {
        setup: "vault",
      },
    ),
    null,
    cs,
  );
  expect(creating.row).toMatchObject({
    line: "Zakládání trezoru…",
    tone: "busy",
  });
  expect(creating.actions).toEqual([]);
  // A creation not confirmed yet, with no setup running: the same words,
  // and no way in until it is the vault's.
  const unresolved = vaultPageView(
    model({ kind: "vault-status", state: "creating", ...facts }),
    member,
    cs,
  );
  expect(unresolved.row).toMatchObject({
    line: "Zakládání trezoru…",
    tone: "busy",
  });
  expect(unresolved.actions).toEqual([]);
  expect(
    parseVaultPage({
      kind: "vault-page",
      status: { kind: "vault-status", state: "creating", ...facts },
      setup: null,
      environment: "work",
    })?.status.state,
  ).toBe("creating");
  // The vault's own answer is newer than the recorded state; while it does
  // not answer, the recorded ids still lead into it.
  const away = vaultPageView(model(connected()), member, cs, {
    kind: "vault-status",
    state: "unreachable",
    ...facts,
    reason: "timeout",
  });
  expect(away.row).toMatchObject({ line: "Neodpovídá", tone: "warn" });
  expect(labels(away).map(([control]) => control)).toEqual(["add", "open"]);
  // A vault that is gone has no way in.
  const gone = vaultPageView(model(connected()), member, cs, {
    kind: "vault-status",
    state: "revoked",
    ...facts,
  });
  expect(gone.row?.line).toBe("Trezor byl odebrán");
  expect(gone.actions).toEqual([]);
});

test("this computer and an Environment without a vault say so in one line; a 0197 pilot opens its collection; a Team or Automated Environment only its agents use", () => {
  expect(
    vaultPageView(
      model(
        { kind: "vault-status", state: "unsupported", reason: "workstation" },
        { environment: null },
      ),
      null,
      cs,
    ),
  ).toEqual({
    rule: false,
    note: "Trezor na tomto počítači není.",
    row: null,
    actions: [],
    hint: null,
    guide: false,
    connect: false,
    disconnect: false,
  });
  expect(
    vaultPageView(
      model(
        { kind: "vault-status", state: "unsupported", reason: "no-vault" },
        { environment: null },
      ),
      null,
      cs,
    ).note,
  ).toBe("Toto Prostředí zatím trezor nemá.");
  const pilot = vaultPageView(
    model({
      ...connected(4),
      name: null,
      origin: "pilot-0197",
      organization: "Example Organization",
    }),
    { kind: "unknown", reason: "no-vault" },
    cs,
  );
  expect(pilot.row).toMatchObject({
    title: "Example Organization",
    line: "4 položky",
  });
  expect(labels(pilot)).toEqual([
    [
      "open",
      "Otevřít trezor",
      `${vault}/#/vault?organizationId=${organizationId}&collectionId=${collectionId}`,
    ],
  ]);
  for (const environment of ["team", "automated"] as const) {
    const view = vaultPageView(
      model(connected(), { environment }),
      { kind: "unknown", reason: "not-managed" },
      cs,
    );
    expect(view.actions).toEqual([]);
    expect(view.hint).toBe(
      "Trezor tohoto Prostředí používají jen jeho agenti.",
    );
  }
  // A network whose vault does not require the Lazurio sign-in of people
  // yet: nobody is added there, so only the agents use the vault.
  const ungated = vaultPageView(
    model(connected()),
    { kind: "unknown", reason: "sign-in-not-required" },
    cs,
  );
  expect(ungated.actions).toEqual([]);
  expect(ungated.hint).toBe(
    "Trezor tohoto Prostředí používají jen jeho agenti.",
  );
  expect(
    parseVaultMembership({
      kind: "vault-member-unknown",
      reason: "sign-in-not-required",
    }),
  ).toEqual({ kind: "unknown", reason: "sign-in-not-required" });
  // The rule, in both languages.
  expect(cs.vaultPageRule).toBe(
    "Kdo má přístup do Prostředí, má všechna jeho hesla.",
  );
  expect(en.vaultPageRule).toBe(
    "Whoever has access to the Environment has all of its passwords.",
  );
});

test("a ready own vault says how it is used: tell the agent in Chat, the value is asked for here; a pilot, a vault not ready and a page not read yet do not", () => {
  // Every reader of a connected own vault sees the way to use it, also before
  // they are added (DEV-6631 task 947: the page did not say what to do).
  for (const person of [
    member,
    { kind: "unknown", reason: "sign-in-not-required" } as const,
    null,
  ]) {
    const view = vaultPageView(model(connected(0)), person, cs);
    expect(view.guide).toBe(true);
  }
  expect(
    vaultPageView(model(connected(), { environment: "team" }), null, cs).guide,
  ).toBe(true);
  expect(cs.vaultPageGuide).toContain("Chatu");
  expect(en.vaultPageGuideChat).toBe("Open Chat");
  // A 0197 pilot takes no requests; a vault being created or not answering
  // cannot save one yet; nothing is shown before the page is read.
  const pilot = { ...connected(), origin: "pilot-0197", name: null } as const;
  expect(vaultPageView(model(pilot), member, cs).guide).toBe(false);
  expect(
    vaultPageView(
      model({ kind: "vault-status", state: "creating", ...facts }),
      null,
      cs,
    ).guide,
  ).toBe(false);
  expect(
    vaultPageView(model(connected()), member, cs, {
      kind: "vault-status",
      state: "unreachable",
      ...facts,
    } as VaultStatus).guide,
  ).toBe(false);
  // Connected but not ready yet: the setup still signing in (the row says
  // the vault is being created), or the session locked until a refresh.
  for (const phase of ["install", "account", "vault", "sign-in"] as const) {
    const creating = vaultPageView(
      model(connected(), { setup: phase }),
      member,
      cs,
    );
    expect(creating.row?.line).toBe(cs.vaultPageCreating);
    expect(creating.guide).toBe(false);
  }
  expect(
    vaultPageView(
      model({ ...connected(null), organization: null, locked: true }),
      member,
      cs,
    ).guide,
  ).toBe(false);
  expect(vaultPageView(null, null, cs).guide).toBe(false);
  expect(
    vaultPageView(
      model({
        kind: "vault-status",
        state: "unsupported",
        reason: "workstation",
      }),
      null,
      cs,
    ).guide,
  ).toBe(false);
});

// A personal Environment's own Bitwarden (root decision 0203 point 7): the
// form while its person has not connected it, then the row, the person's
// state in one line and "Odpojit Bitwarden".
test("a personal Environment waiting for its person shows the form; connected, the person's state in one line and the way out", () => {
  const waiting = vaultPageView(
    model({ kind: "vault-status", state: "needs-connection" }),
    { kind: "unknown", reason: "not-connected" },
    cs,
  );
  expect(waiting).toMatchObject({
    rule: false,
    note: null,
    row: null,
    actions: [],
    connect: true,
    disconnect: false,
  });
  const bitwarden = {
    ...connected(3),
    vault: "https://vault.bitwarden.eu",
    account: "agents.example+lazurio@example.com",
    name: "Osobní example",
    organization: "Osobní example",
    region: "eu",
  } as const;
  const known = (state: "invitation-pending" | "accepted" | "revoked") =>
    ({ kind: "known", state, signIn: false }) as const;
  const view = (
    person: Parameters<typeof vaultPageView>[1],
    status: VaultStatus = bitwarden,
  ) => vaultPageView(model(status), person, cs);
  expect(view(known("invitation-pending"))).toMatchObject({
    connect: false,
    disconnect: true,
    actions: [],
    hint: "Bitwarden vám e-mailem poslal pozvánku do trezoru. Po jejím přijetí vás toto Prostředí potvrdí.",
  });
  expect(view(known("accepted")).hint).toBe(cs.vaultPageInvitationAccepted);
  expect(view(known("revoked"))).toMatchObject({
    actions: [],
    hint: "Přístup do trezoru vám byl v Bitwardenu odebrán.",
  });
  const joined = view(member);
  expect(labels(joined)).toEqual([
    [
      "add",
      "Přidat položku",
      `https://vault.bitwarden.eu/#/vault?organizationId=${organizationId}&collectionId=${collectionId}`,
    ],
    [
      "open",
      "Otevřít trezor",
      `https://vault.bitwarden.eu/#/vault?organizationId=${organizationId}`,
    ],
  ]);
  expect(joined).toMatchObject({
    disconnect: true,
    guide: true,
    row: { title: "Osobní example", line: "3 položky" },
  });
  // Not known (busy, no answer): the vault opens.
  expect(labels(view({ kind: "unknown", reason: "unreachable" }))).toEqual([
    [
      "open",
      "Otevřít trezor",
      `https://vault.bitwarden.eu/#/vault?organizationId=${organizationId}`,
    ],
  ]);
  // A failure the person resolves says what to do; the way out stays.
  const {
    organizationId: _,
    collectionId: __,
    organization: ___,
    items: ____,
    ...facts_
  } = bitwarden;
  for (const [reason, hint] of [
    ["free-organization-limit", cs.vaultPageFreeLimit],
    ["account-missing", cs.vaultPageAccountMissing],
  ] as const)
    expect(
      view(null, {
        ...facts_,
        state: "failed",
        stage: reason === "account-missing" ? "account" : "vault",
        reason,
        fallback: "agent",
      }),
    ).toMatchObject({ hint, disconnect: true, actions: [] });
  // A vault Bitwarden no longer accepts (deleted there, a rotated API key):
  // disconnect and connect again.
  expect(view(member, { ...facts_, state: "revoked" })).toMatchObject({
    hint: "Bitwarden tento trezor nebo klíč API účtu agentů už nepřijímá. Odpojte Bitwarden a připojte ho znovu; smazaný trezor Prostředí založí znovu.",
    disconnect: true,
    actions: [],
  });
  // While a setup runs, nothing but its step; no disconnect.
  expect(
    vaultPageView(model(bitwarden, { setup: "vault" }), member, cs),
  ).toMatchObject({ disconnect: false, actions: [] });
  // A connection that does not read: one line and the way out.
  expect(
    vaultPageView(
      model({
        kind: "vault-status",
        state: "unsupported",
        reason: "connection-unreadable",
      }),
      null,
      en,
    ),
  ).toMatchObject({
    rule: false,
    note: "The connection of your Bitwarden cannot be read. Disconnect it and connect it again.",
    disconnect: true,
    connect: false,
  });
  // A Lazurio Vaultwarden's vault has no way out: it is the network's.
  expect(vaultPageView(model(connected()), member, cs).disconnect).toBe(false);
});

test("the connection form's refusals say what the person can do, in both languages; it is sent only filled in", () => {
  expect(connectionRefusalText("wrong-password", cs)).toBe(
    "Hlavní heslo neodpovídá účtu agentů.",
  );
  expect(connectionRefusalText("owns-organization", en)).toBe(
    "The agents' account already owns or manages another organization. Please create a new agents' account.",
  );
  for (const reason of [
    "region-invalid",
    "client-id-invalid",
    "client-secret-invalid",
    "password-invalid",
    "email-invalid",
    "invalid-credentials",
    "same-account",
    "unsupported-kdf",
    "unsupported-keys",
    "rate-limited",
    "unreachable",
    "busy",
    "setting-up",
    "connected",
    "not-offered",
    "pilot-0197",
    "not-connected",
    "failed",
  ])
    for (const copy of [cs, en])
      expect([reason, typeof connectionRefusalText(reason, copy)]).toEqual([
        reason,
        "string",
      ]);
  expect(connectionRefusalText("something-else", cs)).toBeNull();
  expect(connectionRefusalText(undefined, cs)).toBeNull();
  const filled = {
    region: "eu",
    clientId: "user.x",
    clientSecret: "s",
    masterPassword: " ",
    email: "e",
  };
  expect(connectionFilled({ ...filled, masterPassword: "p" })).toBe(true);
  expect(connectionFilled(filled)).toBe(false);
  expect(connectionFilled({ ...filled, masterPassword: "p", email: "" })).toBe(
    false,
  );
});

test("every text of the Trezor page's markup is a message of both languages", () => {
  const html = readFileSync(
    new URL("../src/launchpad/index.html", import.meta.url),
    "utf8",
  );
  const section = html.slice(
    html.indexOf('<section id="section-vault"'),
    html.indexOf("<!-- SSH from your devices"),
  );
  const keys = [...section.matchAll(/data-message="([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
  expect(keys).toContain("vaultConnectStep2");
  for (const key of keys)
    for (const copy of [cs, en])
      expect([key, typeof (copy as Record<string, unknown>)[key]]).toEqual([
        key,
        "string",
      ]);
});

// Bitwarden in Codex Desktop and the person's own browser (F53's addendum of
// 2026-10-16, plan DEV-6665): the steps under "V Codex Desktopu a ve vašem
// prohlížeči" on Nastavení → Trezor, for an Organization's Lazurio
// Vaultwarden (root decision 0203 point 1) and a personal Environment's own
// Bitwarden (point 7), and where there are none. Začínáme's row "Trezor v
// Bitwardenu" follows `bitwardenTarget` (tests/start-view.test.ts).
const work = (
  status: VaultStatus = connected(),
  fields: Partial<VaultPageModel> = {},
) => model(status, { environment: "work", ...fields });
const own = (region: "eu" | "us") =>
  ({
    ...connected(3),
    vault: `https://vault.bitwarden.${region === "eu" ? "eu" : "com"}`,
    account: "agents.example+lazurio@example.com",
    name: "Osobní example",
    organization: "Osobní example",
    region,
  }) as const;
const known = (
  state: "no-account" | "awaiting-password",
  signIn: boolean,
): VaultPagePerson => ({ kind: "known", state, signIn });

test("an Organization's vault: the extension in Codex Desktop and the browser, the vault's address to copy, the Lazurio sign-in and the network", () => {
  expect(bitwardenTarget(work())).toEqual({ kind: "server", server: vault });
  expect(bitwardenGuide(work(), member, cs)).toEqual({
    kind: "server",
    first: null,
    steps: [
      {
        text: "V Codex Desktopu otevřete Nastavení → Prohlížeč → Rozšíření a přidejte Bitwarden. Do svého prohlížeče ho přidejte z obchodu s rozšířeními.",
        value: null,
      },
      {
        text: "V rozšíření zvolte „vlastní server“ a jako URL serveru zadejte:",
        value: vault,
      },
      {
        text: "Jako e-mailovou adresu zadejte své uživatelské jméno v Lazuriu s koncovkou @account.lazurio.ai a zvolte „Použít jednotné přihlášení“.",
        value: null,
      },
      {
        text: "Přihlaste se přes Lazurio a trezor odemkněte svým hlavním heslem.",
        value: null,
      },
    ],
    note: "Počítač musí být připojený k síti Organizace.",
  });
  expect(bitwardenGuide(work(), member, en)).toEqual({
    kind: "server",
    first: null,
    steps: [
      {
        text: "In Codex Desktop, open Settings → Browser → Extensions and add Bitwarden. In your own browser, add it from its extension store.",
        value: null,
      },
      {
        text: "In the extension, choose “self-hosted” and enter this as the Server URL:",
        value: vault,
      },
      {
        text: "As the email address, enter your Lazurio username followed by @account.lazurio.ai and choose “Use single sign-on”.",
        value: null,
      },
      {
        text: "Sign in with Lazurio and unlock the vault with your master password.",
        value: null,
      },
    ],
    note: "The computer must be connected to the Organization's network.",
  });
  // The person's account is the network vault's, whatever state this
  // Environment's own vault is in: the address is always the vault's own.
  const {
    organizationId: _,
    collectionId: __,
    organization: ___,
    items: ____,
    ...network
  } = connected();
  for (const status of [
    { ...network, state: "not-set-up", next: "account" },
    { ...network, state: "creating" },
    { ...network, state: "not-allowed" },
    { ...network, state: "revoked" },
    { ...network, state: "unreachable", reason: "unreachable" },
    {
      ...network,
      state: "failed",
      stage: "vault",
      reason: "organization-refused",
      fallback: "agent",
    },
  ] as const) {
    expect(bitwardenTarget(work(status))).toEqual({
      kind: "server",
      server: vault,
    });
    expect(bitwardenGuide(work(status), null, cs)?.steps[1]?.value).toBe(vault);
  }
  // While a setup runs, and on a personal Environment on the network's
  // vault, or a 0197 pilot's, the same steps.
  expect(bitwardenTarget(work(connected(), { setup: "sign-in" }))).toEqual({
    kind: "server",
    server: vault,
  });
  expect(bitwardenTarget(model(connected()))).toEqual({
    kind: "server",
    server: vault,
  });
  expect(
    bitwardenTarget(work({ ...connected(), origin: "pilot-0197", name: null })),
  ).toEqual({ kind: "server", server: vault });
});

test("a person without an account in the vault is first pointed to Vytvořit účet v trezoru, exactly where the page offers it", () => {
  for (const state of ["no-account", "awaiting-password"] as const) {
    const person = known(state, true);
    const page = vaultPageView(work(), person, cs);
    expect(page.actions.map((action) => action.control)).toEqual(["account"]);
    const guide = bitwardenGuide(work(), person, cs, page);
    expect(guide?.first).toBe(
      "Účet v trezoru ještě nemáte: nejdřív si ho vytvořte tlačítkem „Vytvořit účet v trezoru“.",
    );
    // It names the page's own button.
    expect(guide?.first).toContain(`„${cs.vaultPageCreateAccount}“`);
    expect(
      bitwardenGuide(work(), person, en, vaultPageView(work(), person, en))
        ?.first,
    ).toBe(
      `You have no account in the vault yet: first create one with “${en.vaultPageCreateAccount}”.`,
    );
    // A vault that does not take the Lazurio sign-in offers no button: no
    // line pointing to one.
    const refused = known(state, false);
    expect(
      bitwardenGuide(work(), refused, cs, vaultPageView(work(), refused, cs))
        ?.first,
    ).toBeNull();
  }
  // A member, and a page that offers no button (a setup running).
  expect(
    bitwardenGuide(work(), member, cs, vaultPageView(work(), member, cs))
      ?.first,
  ).toBeNull();
  const creating = work(connected(), { setup: "vault" });
  const person = known("no-account", true);
  expect(
    bitwardenGuide(creating, person, cs, vaultPageView(creating, person, cs))
      ?.first,
  ).toBeNull();
});

test("a personal Environment's own Bitwarden: its service by the region, the person's own account, nothing to copy", () => {
  for (const [region, service] of [
    ["eu", "bitwarden.eu"],
    ["us", "bitwarden.com"],
  ] as const) {
    const personal = model(own(region));
    expect(bitwardenTarget(personal)).toEqual({ kind: "cloud", service });
    expect(bitwardenGuide(personal, member, cs)).toEqual({
      kind: "cloud",
      first: null,
      steps: [
        {
          text: "V Codex Desktopu otevřete Nastavení → Prohlížeč → Rozšíření a přidejte Bitwarden. Do svého prohlížeče ho přidejte z obchodu s rozšířeními.",
          value: null,
        },
        {
          text: `V rozšíření zvolte ${service} a přihlaste se svým vlastním účtem Bitwardenu.`,
          value: null,
        },
      ],
      note: null,
    });
    expect(bitwardenGuide(personal, null, en)?.steps[1]).toEqual({
      text: `In the extension, choose ${service} and sign in with your own Bitwarden account.`,
      value: null,
    });
  }
  // Whatever the vault's state and the person's: the account is theirs.
  const invited = {
    kind: "known",
    state: "invitation-pending",
    signIn: false,
  } as const;
  expect(bitwardenGuide(model(own("eu")), invited, cs)?.kind).toBe("cloud");
  const { organizationId: _, collectionId: __, ...rest } = own("eu");
  expect(
    bitwardenTarget(
      model({
        ...rest,
        state: "failed",
        stage: "vault",
        reason: "free-organization-limit",
        fallback: "agent",
      }),
    ),
  ).toEqual({ kind: "cloud", service: "bitwarden.eu" });
});

test("no steps where the person has no vault to add here: this computer, no vault yet, a personal Environment's Bitwarden not connected, a Team or Automated Environment, a vault only its agents use", () => {
  expect(bitwardenTarget(null)).toBeNull();
  expect(bitwardenGuide(null, null, cs)).toBeNull();
  for (const status of [
    { kind: "vault-status", state: "unsupported", reason: "workstation" },
    { kind: "vault-status", state: "unsupported", reason: "no-vault" },
    {
      kind: "vault-status",
      state: "unsupported",
      reason: "connection-unreadable",
    },
    { kind: "vault-status", state: "needs-connection" },
  ] as const) {
    const page = model(status, {
      environment: status.state === "needs-connection" ? "personal" : null,
    });
    expect(bitwardenTarget(page)).toBeNull();
    expect(bitwardenGuide(page, null, cs)).toBeNull();
  }
  for (const environment of ["team", "automated"] as const) {
    expect(bitwardenTarget(work(connected(), { environment }))).toBeNull();
    expect(
      bitwardenGuide(work(connected(), { environment }), member, cs),
    ).toBeNull();
  }
  // Where the page says that only the agents use the vault, it gives no
  // steps either.
  for (const reason of ["not-managed", "sign-in-not-required"] as const)
    expect(bitwardenGuide(work(), { kind: "unknown", reason }, cs)).toBeNull();
  // Anyone else, also before the page knows the person: the steps.
  for (const person of [
    null,
    { kind: "unknown", reason: "no-username" },
    { kind: "unknown", reason: "no-identity" },
    { kind: "unknown", reason: "busy" },
    { kind: "known", state: "revoked", signIn: false },
  ] as const)
    expect(bitwardenGuide(work(), person, cs)?.kind).toBe("server");
});
