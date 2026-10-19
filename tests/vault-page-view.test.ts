import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { messages } from "../src/launchpad/messages";
import {
  bitwardenGuide,
  bitwardenReveal,
  bitwardenTarget,
  connectionFilled,
  connectionPictures,
  connectionRefusalText,
  disconnectedLine,
  inviteRefusalText,
  offersBitwarden,
  parseVaultMembership,
  parseVaultPage,
  signUpLinks,
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
  name: null,
  ...fields,
});
const member = { kind: "known", state: "member", signIn: false } as const;
const labels = (view: ReturnType<typeof vaultPageView>) =>
  view.actions.map((action) => [action.control, action.label, action.href]);

test("the page's answers are read only in their exact form", () => {
  const page = { kind: "vault-page", status: connected(), setup: null };
  expect(parseVaultPage({ ...page, environment: "work", name: null })).toEqual({
    status: connected(),
    setup: null,
    environment: "work",
    name: null,
  });
  // The name the vault of a personal Environment's own Bitwarden gets.
  const waiting = {
    kind: "vault-page",
    status: { kind: "vault-status", state: "needs-connection" },
    setup: null,
    environment: "personal",
  };
  expect(parseVaultPage({ ...waiting, name: "Osobní example" })).toEqual({
    status: { kind: "vault-status", state: "needs-connection" },
    setup: null,
    environment: "personal",
    name: "Osobní example",
  });
  for (const refused of [
    null,
    [],
    { ...page, environment: "elsewhere" },
    { ...page, environment: "work", setup: "download" },
    { ...page, environment: "work", status: { kind: "vault-status" } },
    { ...page, environment: "work", kind: "vault-status" },
    { ...waiting, name: "" },
    { ...waiting, name: "x".repeat(51) },
    { ...waiting, name: "Osobní\nexample" },
    { ...waiting, name: 7 },
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
    parseVaultMembership({ kind: "vault-member", state: "not-invited" }),
  ).toEqual({ kind: "known", state: "not-invited", signIn: false });
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

test("this computer says so in one line; a 0197 pilot opens its collection; a Team or Automated Environment only its agents use", () => {
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
    note: "Trezor na tomto počítači není.",
    row: null,
    actions: [],
    hint: null,
    guide: false,
    connect: null,
    invite: false,
    disconnect: false,
  });
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
  // The rule is the "?"'s now (decision F56's addendum of 2026-10-18,
  // tests/launchpad-guide.test.ts), not a sentence of the page.
  expect(Object.hasOwn(cs, "vaultPageRule")).toBe(false);
  expect(Object.hasOwn(en, "vaultPageRule")).toBe(false);
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

// A personal Environment's own Bitwarden (root decision 0203 point 7; F53's
// amendment of 2026-10-16, (2)): the section that connects it while its
// person has not, then the row, one line that it is connected with the
// invitation the person may ask for, the person's state in one line and the
// way out.
test("a personal Environment waiting for its person shows the section with the vault it gets; connected, the invitation, the person's state in one line and the way out", () => {
  const waiting = vaultPageView(
    model(
      { kind: "vault-status", state: "needs-connection" },
      { name: "Osobní example" },
    ),
    { kind: "unknown", reason: "not-connected" },
    cs,
  );
  expect(waiting).toMatchObject({
    note: null,
    row: null,
    actions: [],
    connect: { vault: "Osobní example" },
    invite: false,
    disconnect: false,
  });
  // A page without the name (never this server's): the vault's own word.
  expect(
    vaultPageView(
      model({ kind: "vault-status", state: "needs-connection" }),
      null,
      en,
    ).connect,
  ).toEqual({ vault: "Vault" });
  const bitwarden = {
    ...connected(3),
    vault: "https://vault.bitwarden.eu",
    account: "agents.example+lazurio@example.com",
    name: "Osobní example",
    organization: "Osobní example",
    region: "eu",
  } as const;
  const known = (
    state: "not-invited" | "invitation-pending" | "accepted" | "revoked",
  ) => ({ kind: "known", state, signIn: false }) as const;
  const view = (
    person: Parameters<typeof vaultPageView>[1],
    status: VaultStatus = bitwarden,
    copy = cs,
  ) => vaultPageView(model(status), person, copy);
  // Connected, nobody invited yet: one line, and the invitation.
  expect(view(known("not-invited"))).toEqual({
    note: null,
    row: { title: "Osobní example", line: "3 položky", tone: "ok" },
    actions: [],
    hint: "Váš Bitwarden je připojený.",
    guide: true,
    connect: null,
    invite: true,
    disconnect: true,
  });
  expect(view(known("not-invited"), bitwarden, en).hint).toBe(
    "Your Bitwarden is connected.",
  );
  expect(view(known("invitation-pending"))).toMatchObject({
    connect: null,
    invite: false,
    disconnect: true,
    actions: [],
    hint: "Přijměte pozvánku, kterou vám Bitwarden poslal e-mailem.",
  });
  expect(view(known("invitation-pending"), bitwarden, en).hint).toBe(
    "Accept the invitation Bitwarden e-mailed you.",
  );
  expect(view(known("accepted"))).toMatchObject({
    invite: false,
    hint: "Pozvánka je přijatá, dokončí se při vaší příští návštěvě.",
  });
  expect(view(known("revoked"))).toMatchObject({
    actions: [],
    invite: false,
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
    invite: false,
    hint: null,
    row: { title: "Osobní example", line: "3 položky" },
  });
  // The person's answer not there yet: nothing to open before it says they
  // are a member; not known (busy, no answer): the vault opens.
  expect(view(null)).toMatchObject({
    actions: [],
    invite: false,
    hint: null,
    disconnect: true,
  });
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
    [
      "free-organization-limit",
      "Účet pro agenty se už používá jinde, odpojte ho a připojte nový.",
    ],
    [
      "account-missing",
      "Účet pro agenty tu chybí, odpojte Bitwarden a připojte ho znovu.",
    ],
  ] as const)
    expect(
      view(known("not-invited"), {
        ...facts_,
        state: "failed",
        stage: reason === "account-missing" ? "account" : "vault",
        reason,
        fallback: "agent",
      }),
    ).toMatchObject({ hint, disconnect: true, actions: [], invite: false });
  // A vault Bitwarden no longer accepts (deleted there, a rotated API key):
  // disconnect and connect again.
  expect(view(member, { ...facts_, state: "revoked" })).toMatchObject({
    hint: "Bitwarden už trezor nepřijímá, odpojte ho a připojte znovu.",
    disconnect: true,
    actions: [],
  });
  // While a setup runs, nothing but its step; no invitation, no disconnect.
  expect(
    vaultPageView(
      model(bitwarden, { setup: "vault" }),
      known("not-invited"),
      cs,
    ),
  ).toMatchObject({ disconnect: false, invite: false, actions: [] });
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
    note: "Your Bitwarden's connection cannot be read; disconnect it and connect it again.",
    disconnect: true,
    connect: null,
    invite: false,
  });
  // A Lazurio Vaultwarden's vault has no way out and no invitation: it is
  // the network's, and its people are added by the gateway's answer.
  expect(vaultPageView(model(connected()), member, cs)).toMatchObject({
    disconnect: false,
    invite: false,
  });
});

// After "Odpojit Bitwarden" (the browser acceptance of #468): the section
// that connects it comes back, and one line says that the vault and its
// passwords stay in the person's Bitwarden. The panel keeps that a
// disconnect succeeded in this page and forgets it when the person connects
// again; a page loaded anew never knew it.
test("after a disconnect, one line says that the vault and its passwords stay in the person's Bitwarden, only while the section that connects it shows", () => {
  const waiting = vaultPageView(
    model(
      { kind: "vault-status", state: "needs-connection" },
      { name: "Osobní example" },
    ),
    null,
    cs,
  );
  expect(disconnectedLine(waiting, true, cs)).toBe(
    "Trezor i hesla zůstaly ve vašem Bitwardenu.",
  );
  expect(disconnectedLine(waiting, true, en)).toBe(
    "Your vault and its passwords stay in your Bitwarden.",
  );
  // No disconnect in this page (loaded anew, or connecting again): none.
  expect(disconnectedLine(waiting, false, cs)).toBeNull();
  // Anything but the section that connects it: none (connected again, a
  // Lazurio Vaultwarden, the page not read yet).
  const bitwarden = {
    ...connected(0),
    vault: "https://vault.bitwarden.eu",
    account: "agents.example+lazurio@example.com",
    name: "Osobní example",
    organization: "Osobní example",
    region: "eu",
  } as const;
  for (const view of [
    vaultPageView(model(bitwarden), member, cs),
    vaultPageView(model(connected()), member, cs),
    vaultPageView(null, null, cs),
  ])
    expect(disconnectedLine(view, true, cs)).toBeNull();
});

// The section's words (F53's amendment of 2026-10-16, (2), after the
// Organization Admin's review: less text, pictures): a title, the picture
// and one line, two steps with one line each, the fields and one button;
// refusals that say what to do next (the next test). Word for word in both
// languages.
test("the connection's words: the title, the picture of the vault, one line, two steps, the fields and the button, in both languages", () => {
  const words = (copy: typeof cs) => [
    copy.vaultConnectTitle,
    copy.vaultConnectLead,
    copy.vaultConnectYours,
    copy.vaultConnectAgents,
    copy.vaultConnectAgentsWhere,
    copy.vaultConnectSignUp,
    copy.vaultConnectApiKey,
    copy.vaultConnectClientId,
    copy.vaultConnectClientSecret,
    copy.vaultConnectPassword,
    copy.vaultConnectSubmit,
    copy.vaultConnectSubmitting,
    copy.vaultConnectKept,
  ];
  expect(words(cs)).toEqual([
    "Hesla pro agenty ve vašem Bitwardenu",
    "Agenti dostanou vlastní účet a do toho vašeho nevidí.",
    "Váš Bitwarden",
    "Agenti",
    "v tomto Prostředí",
    "Založte účet pro agenty. Jako e-mail použijte třeba ten svůj s +agenti: jana+agenti@gmail.com",
    "V novém účtu otevřete Nastavení → Zabezpečení → Klíče → Zobrazit klíč API a oba údaje zkopírujte sem.",
    "client_id",
    "client_secret",
    "Hlavní heslo účtu pro agenty",
    "Připojit",
    "Připojuje se…",
    "Údaje zůstanou jen v tomto Prostředí.",
  ]);
  expect(words(en)).toEqual([
    "Your agents' passwords in your Bitwarden",
    "Your agents get their own account and can't see into yours.",
    "Your Bitwarden",
    "Agents",
    "in this Environment",
    "Create an account for your agents. For its e-mail, you can use your own with +agents: jana+agents@gmail.com",
    "In the new account, open Settings → Security → Keys → View API key and copy both values here.",
    "client_id",
    "client_secret",
    "Master password of the agents' account",
    "Connect",
    "Connecting…",
    "These details stay only in this Environment.",
  ]);
  // The picture: the vault by the name it gets, and Bitwarden's screens.
  expect(connectionPictures("Osobní jana", cs)).toEqual({
    label:
      "Trezor Osobní jana mezi vaším Bitwardenem a agenty v tomto Prostředí",
    steps: [
      {
        name: "signup",
        alt: "Bitwarden: pole „E-mailová adresa“ nového účtu",
      },
      {
        name: "api-key",
        alt: "Bitwarden: okno „Klíč API“ s client_id a client_secret",
      },
    ],
  });
  expect(connectionPictures("Osobní jana", en)).toEqual({
    label:
      "The vault Osobní jana between your Bitwarden and the agents in this Environment",
    steps: [
      {
        name: "signup",
        alt: "Bitwarden: the “Email address” field of a new account",
      },
      {
        name: "api-key",
        alt: "Bitwarden: the “API Key” window with client_id and client_secret",
      },
    ],
  });
  // Step 1 opens bitwarden.eu's own sign-up; bitwarden.com on request.
  expect(signUpLinks("eu", cs)).toEqual({
    open: {
      label: "Otevřít bitwarden.eu",
      href: "https://vault.bitwarden.eu/#/signup",
    },
    other: { label: "Používáte bitwarden.com?", region: "us" },
  });
  expect(signUpLinks("us", en)).toEqual({
    open: {
      label: "Open bitwarden.com",
      href: "https://vault.bitwarden.com/#/signup",
    },
    other: { label: "Using bitwarden.eu?", region: "eu" },
  });
  // The invitation: one question, one address, one button.
  expect([
    cs.vaultInviteTitle,
    cs.vaultInviteEmail,
    cs.vaultInviteSubmit,
    cs.vaultInviteSubmitting,
    cs.vaultDisconnectNote,
  ]).toEqual([
    "Chcete hesla agentů vidět i ve svém Bitwardenu?",
    "Váš e-mail v Bitwardenu",
    "Pozvat mě",
    "Posílá se…",
    "Trezor i hesla v Bitwardenu zůstanou.",
  ]);
  expect([
    en.vaultInviteTitle,
    en.vaultInviteEmail,
    en.vaultInviteSubmit,
    en.vaultInviteSubmitting,
    en.vaultDisconnectNote,
  ]).toEqual([
    "Want to see your agents' passwords in your own Bitwarden too?",
    "Your Bitwarden e-mail",
    "Invite me",
    "Sending…",
    "The vault and its passwords stay in Bitwarden.",
  ]);
  // No mechanics in any of the section's words: no organization, no plan,
  // no region, no "Free".
  const section = [
    ...words(cs),
    ...words(en),
    cs.vaultInviteTitle,
    en.vaultInviteTitle,
    cs.vaultDisconnectNote,
    en.vaultDisconnectNote,
    cs.vaultDisconnected,
    en.vaultDisconnected,
  ].join("\n");
  for (const word of [
    /organi[sz]a/i,
    /\bfree\b/i,
    /bezplatn/i,
    /oblast/i,
    /region/i,
  ])
    expect([word.source, word.test(section)]).toEqual([word.source, false]);
});

test("the connection's and the invitation's refusals say what to do next in one sentence, a wrong master password also which values to paste again, in both languages; the form is sent only filled in", () => {
  const connecting = [
    [
      "client-id-invalid",
      "Zkopírujte celé client_id.",
      "Copy the whole client_id.",
    ],
    [
      "client-secret-invalid",
      "Zkopírujte celé client_secret.",
      "Copy the whole client_secret.",
    ],
    [
      "password-invalid",
      "Zadejte hlavní heslo účtu pro agenty.",
      "Enter the master password of the agents' account.",
    ],
    [
      "invalid-credentials",
      "Bitwarden tento klíč API nepřijal, zkopírujte ho znovu.",
      "Bitwarden did not accept this API key; copy it again.",
    ],
    [
      "account-refused",
      "Bitwarden tento účet nepřijal, zkontrolujte ho v Bitwardenu.",
      "Bitwarden did not accept this account; check it in Bitwarden.",
    ],
    [
      "wrong-password",
      "Toto není hlavní heslo účtu pro agenty. Vložte znovu client_secret a heslo.",
      "That is not the agents' account master password. Paste the client_secret and the password again.",
    ],
    [
      "owns-organization",
      "Tento účet se už používá jinde, založte pro agenty nový.",
      "This account is used elsewhere already; create a new one for your agents.",
    ],
    [
      "unsupported-keys",
      "Tento účet nejde připojit, založte pro agenty nový.",
      "This account cannot be connected; create a new one for your agents.",
    ],
    [
      "unreachable",
      "Bitwarden teď neodpovídá, zkuste to za chvíli.",
      "Bitwarden is not responding; try again in a moment.",
    ],
    [
      "connected",
      "Váš Bitwarden už je připojený.",
      "Your Bitwarden is connected already.",
    ],
    [
      "failed",
      "Připojení se nepodařilo, zkuste to znovu.",
      "Connecting did not work; try again.",
    ],
  ] as const;
  for (const [reason, czech, english] of connecting)
    expect([
      reason,
      connectionRefusalText(reason, cs),
      connectionRefusalText(reason, en),
    ]).toEqual([reason, czech, english]);
  for (const reason of [
    "unsupported-kdf",
    "rate-limited",
    "busy",
    "setting-up",
    "not-offered",
    "pilot-0197",
    "not-connected",
  ])
    for (const copy of [cs, en])
      expect([reason, typeof connectionRefusalText(reason, copy)]).toEqual([
        reason,
        "string",
      ]);
  const inviting = [
    [
      "email-invalid",
      "Zadejte e-mail svého účtu v Bitwardenu.",
      "Enter the e-mail of your Bitwarden account.",
    ],
    [
      "same-account",
      "To je účet pro agenty, zadejte e-mail toho svého.",
      "That is the agents' account; enter the e-mail of your own.",
    ],
    [
      "invited",
      "Pozvánka už odešla na jiný e-mail.",
      "An invitation went to another e-mail already.",
    ],
    [
      "not-connected",
      "Trezor ještě není hotový, zkuste to za chvíli.",
      "The vault is not ready yet; try again in a moment.",
    ],
    [
      "failed",
      "Pozvánka neodešla, zkuste to znovu.",
      "The invitation did not go out; try again.",
    ],
  ] as const;
  for (const [reason, czech, english] of inviting)
    expect([
      reason,
      inviteRefusalText(reason, cs),
      inviteRefusalText(reason, en),
    ]).toEqual([reason, czech, english]);
  for (const reason of [
    "setting-up",
    "busy",
    "unreachable",
    "rate-limited",
    "not-offered",
    "pilot-0197",
  ])
    for (const copy of [cs, en])
      expect([reason, typeof inviteRefusalText(reason, copy)]).toEqual([
        reason,
        "string",
      ]);
  // Every refusal is one sentence, but a wrong master password: the form
  // empties the client_secret and the password as they are sent, so its
  // second sentence says to paste both again ("Připojit" waits for every
  // field; the browser acceptance of #468).
  for (const [reason, czech, english] of [...connecting, ...inviting])
    for (const text of [czech, english])
      expect([
        text,
        text.split(/[.?!](?:\s|$)/).filter(Boolean).length,
      ]).toEqual([text, reason === "wrong-password" ? 2 : 1]);
  for (const unknown of ["something-else", undefined, "region-invalid"]) {
    expect(connectionRefusalText(unknown, cs)).toBeNull();
    expect(inviteRefusalText(unknown, cs)).toBeNull();
  }
  const filled = { clientId: "user.x", clientSecret: "s", masterPassword: " " };
  expect(connectionFilled({ ...filled, masterPassword: "p" })).toBe(true);
  expect(connectionFilled(filled)).toBe(false);
  expect(
    connectionFilled({ ...filled, masterPassword: "p", clientId: "" }),
  ).toBe(false);
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
  expect(keys).toContain("vaultConnectApiKey");
  expect(keys).toContain("vaultInviteTitle");
  for (const key of keys)
    for (const copy of [cs, en])
      expect([key, typeof (copy as Record<string, unknown>)[key]]).toEqual([
        key,
        "string",
      ]);
});

// The two pictures of the extension's own screens (F53's addendum of
// 2026-10-16): each step that names one finds it in the page once per
// language, and the file is the small 2x WebP of the size the page declares.
// How the steps look is checked in a browser (root decision 0178).
test("every picture a step names is in the page once per language, a small 2x WebP of the declared size", () => {
  const html = readFileSync(
    new URL("../src/launchpad/index.html", import.meta.url),
    "utf8",
  );
  const block = html.slice(
    html.indexOf('<div id="vault-bitwarden-pictures" hidden>'),
    html.indexOf("</div>", html.indexOf('<div id="vault-bitwarden-pictures"')),
  );
  const pictures = [...block.matchAll(/<img ([^>]*)>/g)].map(
    (match) =>
      new Map(
        [...(match[1] as string).matchAll(/([a-z-]+)="([^"]*)"/g)].map(
          (pair) => [pair[1] as string, pair[2] as string],
        ),
      ),
  );
  const named = (
    bitwardenGuide(
      model(connected(), { environment: "work" }),
      { ...member, address: "jana@account.lazurio.ai" },
      cs,
    )?.steps ?? []
  ).flatMap((step) => (step.picture === null ? [] : [step.picture.name]));
  expect(named).toEqual(["server", "email"]);
  expect(pictures).toHaveLength(named.length * 2);
  for (const name of named)
    for (const locale of ["cs", "en"]) {
      const found = pictures.filter(
        (picture) =>
          picture.get("data-picture") === name &&
          picture.get("data-locale") === locale,
      );
      expect(found).toHaveLength(1);
      const [picture] = found as [Map<string, string>];
      expect(picture.get("src")).toBe(
        `./images/bitwarden-${name}-${locale}.webp`,
      );
      expect(picture.get("alt")).toBe("");
      const file = readFileSync(
        new URL(
          `../src/launchpad/images/bitwarden-${name}-${locale}.webp`,
          import.meta.url,
        ),
      );
      expect(file.length).toBeLessThan(64 * 1024);
      // RIFF, WEBP and the extended header, whose canvas is twice the
      // declared size.
      expect(file.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(file.subarray(8, 16).toString("latin1")).toBe("WEBPVP8X");
      expect([file.readUIntLE(24, 3) + 1, file.readUIntLE(27, 3) + 1]).toEqual([
        2 * Number(picture.get("width")),
        2 * Number(picture.get("height")),
      ]);
    }
});

// The guide video's slot (guide-video.ts): empty and collapsed under the
// section's line, above the steps, in the component's shape, until the video
// `vault-personal-bitwarden` exists and the panel mounts it (#452).
test("the connection's section keeps an empty guide-video slot under its line, above the steps", () => {
  const html = readFileSync(
    new URL("../src/launchpad/index.html", import.meta.url),
    "utf8",
  );
  const section = html.slice(
    html.indexOf('<section class="group" id="vault-connect"'),
    html.indexOf("</section>", html.indexOf('id="vault-connect"')),
  );
  expect(section).toContain(
    '<div class="guide-video" id="vault-connect-video"></div>',
  );
  const order = [
    'data-message="vaultConnectLead"',
    'id="vault-connect-video"',
    'id="vault-connect-form"',
  ].map((marker) => section.indexOf(marker));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).toContain("#vault-connect-video:empty { display: none; }");
});

// Bitwarden's own screens of the connection's two steps (F53's amendment of
// 2026-10-16, (2)): each in the page once per language, the small 2x WebP of
// the size the page declares; how the steps look is checked in a browser
// (root decision 0178).
test("every picture the connection's steps show is in the page once per language, a small 2x WebP of the declared size", () => {
  const html = readFileSync(
    new URL("../src/launchpad/index.html", import.meta.url),
    "utf8",
  );
  const start = html.indexOf('<div id="vault-connect-pictures" hidden>');
  expect(start).toBeGreaterThan(0);
  const block = html.slice(start, html.indexOf("</div>", start));
  const pictures = [...block.matchAll(/<img ([^>]*)>/g)].map(
    (match) =>
      new Map(
        [...(match[1] as string).matchAll(/([a-z-]+)="([^"]*)"/g)].map(
          (pair) => [pair[1] as string, pair[2] as string],
        ),
      ),
  );
  // The slots of the steps, in the section's markup, name the same pictures.
  const section = html.slice(
    html.indexOf('<section class="group" id="vault-connect"'),
    start,
  );
  const slots = [...section.matchAll(/data-shot="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const named = connectionPictures("Osobní example", cs).steps.map(
    (step) => step.name,
  );
  expect(named).toEqual(["signup", "api-key"]);
  expect(slots).toEqual(named);
  expect(pictures).toHaveLength(named.length * 2);
  for (const name of named)
    for (const locale of ["cs", "en"]) {
      const found = pictures.filter(
        (picture) =>
          picture.get("data-picture") === name &&
          picture.get("data-locale") === locale,
      );
      expect(found).toHaveLength(1);
      const [picture] = found as [Map<string, string>];
      expect(picture.get("src")).toBe(
        `./images/bitwarden-${name}-${locale}.webp`,
      );
      expect(picture.get("alt")).toBe("");
      expect(picture.get("loading")).toBe("lazy");
      const file = readFileSync(
        new URL(
          `../src/launchpad/images/bitwarden-${name}-${locale}.webp`,
          import.meta.url,
        ),
      );
      expect(file.length).toBeLessThan(64 * 1024);
      // RIFF, WEBP and the extended header, whose canvas is twice the
      // declared size.
      expect(file.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(file.subarray(8, 16).toString("latin1")).toBe("WEBPVP8X");
      expect([file.readUIntLE(24, 3) + 1, file.readUIntLE(27, 3) + 1]).toEqual([
        2 * Number(picture.get("width")),
        2 * Number(picture.get("height")),
      ]);
    }
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

test("an Organization's vault: the extension from the Chrome Web Store, the vault's address and the person's own to paste where the extension's own screens show, the Lazurio sign-in and the network", () => {
  expect(bitwardenTarget(work())).toEqual({ kind: "server", server: vault });
  const store = {
    label: "Bitwarden v Chrome Web Store",
    href: "https://chromewebstore.google.com/detail/bitwarden-password-manager/nngceckbapebfimnlniiiahkandclblb",
  };
  const jana = { ...member, address: "jana@account.lazurio.ai" };
  expect(bitwardenGuide(work(), jana, cs)).toEqual({
    kind: "server",
    first: null,
    steps: [
      {
        text: "Otevřete rozšíření Bitwarden v Chrome Web Store a klikněte na „Přidat do Chromu“. V Codex Desktopu to udělejte v jeho prohlížeči, rozšíření pak najdete v Nastavení → Prohlížeč → Rozšíření.",
        value: null,
        missing: null,
        link: store,
        picture: null,
      },
      {
        text: "Dole u „Přistupujete na“ zvolte „vlastní server“. Do pole „URL serveru“ vložte tuto adresu a klikněte na „Uložit“:",
        value: vault,
        missing: null,
        link: null,
        picture: {
          name: "server",
          alt: "Bitwarden: „Přistupujete na“ s volbou „vlastní server“ a pole „URL serveru“",
        },
      },
      {
        text: "Do pole „E-mailová adresa“ vložte svou adresu a klikněte na „Použít jednotné přihlášení“:",
        value: "jana@account.lazurio.ai",
        missing: null,
        link: null,
        picture: {
          name: "email",
          alt: "Bitwarden: pole „E-mailová adresa“ a tlačítko „Použít jednotné přihlášení“",
        },
      },
      {
        text: "Přihlaste se přes Lazurio a trezor odemkněte hlavním heslem.",
        value: null,
        missing: null,
        link: null,
        picture: null,
      },
    ],
    note: "Počítač musí být připojený k síti Organizace.",
  });
  expect(bitwardenGuide(work(), jana, en)).toEqual({
    kind: "server",
    first: null,
    steps: [
      {
        text: "Open the Bitwarden extension in the Chrome Web Store and click “Add to Chrome”. In Codex Desktop, do this in its browser; the extension then appears in Settings → Browser → Extensions.",
        value: null,
        missing: null,
        link: { ...store, label: "Bitwarden in the Chrome Web Store" },
        picture: null,
      },
      {
        text: "At the bottom, next to “Accessing”, choose “self-hosted”. Paste this address into the “Server URL” field and click “Save”:",
        value: vault,
        missing: null,
        link: null,
        picture: {
          name: "server",
          alt: "Bitwarden: “Accessing” with “self-hosted” chosen, and the “Server URL” field",
        },
      },
      {
        text: "Paste your address into the “Email address” field and click “Use single sign-on”:",
        value: "jana@account.lazurio.ai",
        missing: null,
        link: null,
        picture: {
          name: "email",
          alt: "Bitwarden: the “Email address” field and “Use single sign-on”",
        },
      },
      {
        text: "Sign in with Lazurio and unlock the vault with your master password.",
        value: null,
        missing: null,
        link: null,
        picture: null,
      },
    ],
    note: "The computer must be connected to the Organization's network.",
  });
  // Until the answer carries the address, the same step and screen, and in
  // place of the address one line (Pablo's review of 8de1d1b): loading while
  // the page waits for the answer (opened directly, the page draws the steps
  // before it), after signing in again where the sign-in carried no Lazurio
  // username, and otherwise not loaded, with the page's own refresh button.
  const third = (person: VaultPagePerson | null, copy = cs) =>
    bitwardenGuide(work(), person, copy)?.steps[2];
  expect(third(null)).toEqual({
    text: "Do pole „E-mailová adresa“ vložte svou adresu a klikněte na „Použít jednotné přihlášení“:",
    value: null,
    missing: "Načítá se vaše adresa…",
    link: null,
    picture: {
      name: "email",
      alt: "Bitwarden: pole „E-mailová adresa“ a tlačítko „Použít jednotné přihlášení“",
    },
  });
  expect(third(null, en)?.missing).toBe("Loading your address…");
  expect(third({ kind: "unknown", reason: "no-username" })?.missing).toBe(
    "Svou adresu tu uvidíte, až se znovu přihlásíte.",
  );
  expect(third({ kind: "unknown", reason: "no-username" }, en)?.missing).toBe(
    "You will see your address here once you sign in again.",
  );
  for (const person of [
    { kind: "unknown", reason: "failed" },
    { kind: "unknown", reason: "busy" },
    { kind: "unknown", reason: "unreachable" },
    { kind: "unknown", reason: "no-identity" },
    member,
  ] as const) {
    expect([person, third(person)?.missing]).toEqual([
      person,
      "Vaši adresu se nepodařilo načíst. Zkuste „Obnovit stav“.",
    ]);
    expect(third(person, en)?.missing).toBe(
      "Your address could not be loaded. Try “Refresh status”.",
    );
    expect(third(person)?.value).toBeNull();
  }
  // It names the page's own refresh button.
  expect(third(null, cs)?.text).toBe(cs.vaultBitwardenAddress);
  expect(third({ kind: "unknown", reason: "failed" })?.missing).toBe(
    cs.vaultBitwardenAddressFailed.replace("{refresh}", cs.toolsRefresh),
  );
  expect(cs.vaultBitwardenAddressFailed).toContain("„{refresh}“");
  // Step 1 says that it is the Bitwarden extension from the Chrome Web
  // Store, by the store's own button (Matěj, 2026-10-16), and where Codex
  // Desktop then lists it.
  for (const [copy, words] of [
    [
      cs,
      [
        "rozšíření Bitwarden v Chrome Web Store",
        "„Přidat do Chromu“",
        "Nastavení → Prohlížeč → Rozšíření",
      ],
    ],
    [
      en,
      [
        "Bitwarden extension in the Chrome Web Store",
        "“Add to Chrome”",
        "Settings → Browser → Extensions",
      ],
    ],
  ] as const)
    for (const word of words) expect(copy.vaultBitwardenAdd).toContain(word);
  // The extension's own words, as its version 2026.10.0 shows them.
  for (const label of [
    "„Přistupujete na“",
    "„vlastní server“",
    "„URL serveru“",
    "„Uložit“",
  ])
    expect(cs.vaultBitwardenServer).toContain(label);
  for (const label of ["„E-mailová adresa“", "„Použít jednotné přihlášení“"])
    expect(cs.vaultBitwardenAddress).toContain(label);
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

test("a personal Environment's own Bitwarden: the extension, its service by the region, the person's own account, nothing to copy", () => {
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
          text: "Otevřete rozšíření Bitwarden v Chrome Web Store a klikněte na „Přidat do Chromu“. V Codex Desktopu to udělejte v jeho prohlížeči, rozšíření pak najdete v Nastavení → Prohlížeč → Rozšíření.",
          value: null,
          missing: null,
          link: {
            label: "Bitwarden v Chrome Web Store",
            href: "https://chromewebstore.google.com/detail/bitwarden-password-manager/nngceckbapebfimnlniiiahkandclblb",
          },
          picture: null,
        },
        {
          text: `Dole u „Přistupujete na“ zvolte „${service}“ a přihlaste se svým vlastním účtem Bitwardenu.`,
          value: null,
          missing: null,
          link: null,
          picture: null,
        },
      ],
      note: null,
    });
    expect(bitwardenGuide(personal, null, en)?.steps[1]).toEqual({
      text: `At the bottom, next to “Accessing”, choose “${service}” and log in with your own Bitwarden account.`,
      value: null,
      missing: null,
      link: null,
      picture: null,
    });
    // An address in the answer is never offered there: the person signs in
    // with their own Bitwarden account.
    expect(
      JSON.stringify(
        bitwardenGuide(
          personal,
          { ...member, address: "jana@account.lazurio.ai" },
          cs,
        ),
      ),
    ).not.toContain("account.lazurio.ai");
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

// Matěj's review of the preview of 97eab50: a person is never asked to
// compose "username + @account.lazurio.ai". In no state of the page does a
// step's sentence or line name the address's domain: the address is only
// ever the value to copy.
test("no step asks the person to compose their address, whatever the answer", () => {
  const people: (VaultPagePerson | null)[] = [
    null,
    ...[
      "no-identity",
      "no-username",
      "no-vault",
      "not-connected",
      "busy",
      "unreachable",
      "failed",
    ].map((reason) => ({ kind: "unknown", reason }) as VaultPagePerson),
    ...(
      [
        "member",
        "no-account",
        "awaiting-password",
        "invitation-pending",
        "accepted",
        "revoked",
      ] as const
    ).flatMap((state) => [
      { kind: "known", state, signIn: true } as VaultPagePerson,
      {
        kind: "known",
        state,
        signIn: false,
        address: "jana@account.lazurio.ai",
      } as VaultPagePerson,
    ]),
  ];
  const models = [
    work(),
    model(connected()),
    work({ ...connected(), origin: "pilot-0197", name: null }),
    model(own("eu")),
  ];
  let checked = 0;
  for (const copy of [cs, en])
    for (const page of models)
      for (const person of people)
        for (const step of bitwardenGuide(page, person, copy)?.steps ?? []) {
          checked += 1;
          for (const words of [step.text, step.missing ?? ""])
            expect([words, words.includes("account.lazurio.ai")]).toEqual([
              words,
              false,
            ]);
        }
  expect(checked).toBeGreaterThan(100);
});

// An Environment without a vault (DEV-6631, F53's addendum of 2026-10-17):
// one line says why it has none, in place of the vault. A public
// Organization's Environment has none on purpose (`no-tailnet`); any other's
// is not set up yet and its Organization's Admin sets it up (`no-vault`).
// How a vault works in an Organization is the approved video the page's "?"
// plays in place (decision F56's addendum of 2026-10-18,
// tests/launchpad-guide.test.ts), no longer a section of the page.
test("an Environment without a vault says why: none on purpose in a public Organization, set up by the Organization's Admin anywhere else", () => {
  const unsupported = (
    reason: Extract<VaultStatus, { state: "unsupported" }>["reason"],
  ) =>
    model(
      { kind: "vault-status", state: "unsupported", reason },
      { environment: null },
    );
  const nothingElse = {
    row: null,
    actions: [],
    hint: null,
    guide: false,
    connect: null,
    invite: false,
    disconnect: false,
  };
  for (const [copy, none, notSetUp] of [
    [
      cs,
      "Tato Organizace je veřejná ukázka a skutečná hesla do ní nepatří, proto v ní trezor záměrně není. Všechno ostatní funguje jako ve skutečné Organizaci.",
      "Trezor tohoto Prostředí není nastavený. Nastaví ho Admin Organizace a pak ho najdete tady.",
    ],
    [
      en,
      "This Organization is a public demo and real passwords do not belong in it, so it has no vault on purpose. Everything else works as in a real Organization.",
      "This Environment's vault is not set up. The Organization's Admin sets it up, and then you will find it here.",
    ],
  ] as const) {
    expect(vaultPageView(unsupported("no-tailnet"), null, copy)).toEqual({
      ...nothingElse,
      note: none,
    });
    expect(vaultPageView(unsupported("no-vault"), null, copy)).toEqual({
      ...nothingElse,
      note: notSetUp,
    });
  }
  // The video's title, its accessible name, in both languages; its
  // sentences are gone from the page and the words.
  expect([cs.vaultExplainerTitle, en.vaultExplainerTitle]).toEqual([
    "Jak trezor funguje",
    "How the vault works",
  ]);
  expect(Object.hasOwn(cs, "vaultExplainerText")).toBe(false);
});

test("no steps where the person has no vault to add here: this computer, no vault yet, a personal Environment's Bitwarden not connected, a Team or Automated Environment, a vault only its agents use", () => {
  expect(bitwardenTarget(null)).toBeNull();
  expect(bitwardenGuide(null, null, cs)).toBeNull();
  for (const status of [
    { kind: "vault-status", state: "unsupported", reason: "workstation" },
    { kind: "vault-status", state: "unsupported", reason: "no-vault" },
    { kind: "vault-status", state: "unsupported", reason: "no-tailnet" },
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

// Pablo's review of #465: Začínáme's row promises exactly the steps the page
// gives, and a pending "Návod" reveals them only once it is certain they show.
test("the row and the steps follow one rule: the vault, and for a Lazurio Vaultwarden the person's answer", () => {
  const agentsOnly = [
    { kind: "unknown", reason: "sign-in-not-required" },
    { kind: "unknown", reason: "not-managed" },
  ] as const;
  for (const person of agentsOnly) {
    expect(bitwardenTarget(work(), person)).toBeNull();
    expect(offersBitwarden(work(), person)).toBe(false);
    expect(bitwardenGuide(work(), person, cs)).toBeNull();
    // A connected work vault whose network does not require the Lazurio
    // sign-in yet: the page says that only its agents use it.
    expect(vaultPageView(work(), person, cs).hint).toBe(cs.vaultPageAgentsOnly);
  }
  for (const person of [
    member,
    known("no-account", true),
    { kind: "unknown", reason: "no-username" },
    { kind: "unknown", reason: "busy" },
  ] as const) {
    expect(bitwardenTarget(work(), person)).toEqual({
      kind: "server",
      server: vault,
    });
    expect(offersBitwarden(work(), person)).toBe(true);
    expect(bitwardenGuide(work(), person, cs)?.kind).toBe("server");
  }
  // Not answered yet: the page may show the steps, the row waits.
  expect(bitwardenGuide(work(), null, cs)?.kind).toBe("server");
  expect(offersBitwarden(work(), null)).toBe(false);
  // A personal Environment's own Bitwarden needs no answer.
  expect(offersBitwarden(model(own("eu")), null)).toBe(true);
  expect(offersBitwarden(null, member)).toBe(false);
  expect(
    offersBitwarden(
      model({ kind: "vault-status", state: "needs-connection" }),
      null,
    ),
  ).toBe(false);
});

test("a pending Návod waits for the answer that decides whether the steps show, reveals them only then, and is forgotten once the page is left", () => {
  const at = (
    fields: Partial<Parameters<typeof bitwardenReveal>[0]>,
  ): ReturnType<typeof bitwardenReveal> =>
    bitwardenReveal({
      shown: true,
      loading: false,
      model: null,
      person: null,
      steps: false,
      ...fields,
    });
  // Opened before the page is read: wait; a read that failed forgets it.
  expect(at({ loading: true })).toBe("wait");
  expect(at({ loading: false })).toBe("forget");
  // A Lazurio Vaultwarden read, the person not answered yet: the steps are
  // drawn, but an answer could still hide them, so it waits.
  const read = { model: work(), steps: true };
  expect(at(read)).toBe("wait");
  // The answer: a member reveals; only the agents use the vault forgets
  // (the steps are hidden by then).
  expect(at({ ...read, person: member })).toBe("reveal");
  expect(at({ ...read, person: known("no-account", true) })).toBe("reveal");
  expect(
    at({
      model: work(),
      person: { kind: "unknown", reason: "sign-in-not-required" },
      steps: false,
    }),
  ).toBe("forget");
  // No answer from the membership (the page then says failed): reveals.
  expect(at({ ...read, person: { kind: "unknown", reason: "failed" } })).toBe(
    "reveal",
  );
  // A personal Environment's own Bitwarden needs no answer.
  expect(at({ model: model(own("eu")), steps: true })).toBe("reveal");
  // No vault to add here (a Team Environment, waiting for the person's
  // Bitwarden): forgotten without waiting.
  expect(at({ model: work(connected(), { environment: "team" }) })).toBe(
    "forget",
  );
  expect(
    at({ model: model({ kind: "vault-status", state: "needs-connection" }) }),
  ).toBe("forget");
  // The page left at any point: forgotten, whatever comes later.
  for (const fields of [
    { loading: true },
    read,
    { ...read, person: member },
  ] as const)
    expect(at({ ...fields, shown: false })).toBe("forget");
});

// The membership answer's `address` (F53's addendum of 2026-10-16, after
// Matěj's review of #465): the admitted person's own address in a Lazurio
// Vaultwarden, optional, accepted only in its exact form.
test("the membership answer's own address is read only in its exact form", () => {
  expect(
    parseVaultMembership({
      kind: "vault-member",
      state: "member",
      address: "jana@account.lazurio.ai",
    }),
  ).toEqual({
    kind: "known",
    state: "member",
    signIn: false,
    address: "jana@account.lazurio.ai",
  });
  expect(
    parseVaultMembership({
      kind: "vault-member-unknown",
      reason: "no-username",
    }),
  ).toEqual({ kind: "unknown", reason: "no-username" });
  expect(
    parseVaultMembership({
      kind: "vault-member",
      state: "no-account",
      signIn: true,
      address: "jana-novak2@account.lazurio.ai",
    }),
  ).toMatchObject({ address: "jana-novak2@account.lazurio.ai" });
  for (const address of [
    "jana@lazurio.ai",
    "Jana@account.lazurio.ai",
    "ja@account.lazurio.ai",
    "jana@account.lazurio.ai.example",
    "jana--novak@account.lazurio.ai",
    "-jana@account.lazurio.ai",
    `${"a".repeat(40)}@account.lazurio.ai`,
    "jana@account.lazurio.ai ",
    "",
    42,
    null,
  ])
    expect([
      address,
      parseVaultMembership({ kind: "vault-member", state: "member", address }),
    ]).toEqual([address, null]);
});
