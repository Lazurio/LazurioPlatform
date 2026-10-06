import { expect, test } from "bun:test";
import { accountCacheKey, accountDocumentPath } from "../src/shell/account";
import {
  parseShell,
  parseShellAccount,
  parseShellSignedOut,
  type Shell,
  type ShellAccount,
  type ShellSignedOut,
  shellSignedOutSchema,
} from "../src/shell/contract";
import { mergeAccount } from "../src/shell/merge";
import { shellMessages } from "../src/shell/messages";
import {
  columnHead,
  railHome,
  railSpaces,
  signedOutRail,
} from "../src/shell/view";
import { accountDocument } from "./fixtures/account-document";
import { observedState } from "./fixtures/shell-state";

// F36's addendum of 2026-10-06: a host page with nobody signed in (the
// Dashboard, signed out) hands the shell `lazurio.shell-signed-out.v1`, a
// document of its own: the language and where sign-in starts. The rail then
// draws the Lazurio logo and the sign-in key, both leading there, and nothing
// of a person; the column head draws nothing. Neither v1 document changes.
// Example names only.

const cs = shellMessages("cs");
const en = shellMessages("en");

// The host's signed-out document, as the Dashboard would emit it: its own
// sign-in start by path.
const signedOutDocument = (extra: Record<string, unknown> = {}) => ({
  schema: "lazurio.shell-signed-out.v1",
  locale: "cs",
  signIn: "/auth/sign-in?return=%2F",
  ...extra,
});

// A host's signed-in document of the same page.
const hostDocument = () => ({
  schema: "lazurio.shell.v1",
  locale: "cs",
  current: null,
  operator: { initials: "A", login: "ada", avatar: null },
  environments: [],
  organizations: [],
  dashboard: "/home",
  account: "/settings/account",
  addOrganization: "/add-organization",
});

// The contract.

test("the signed-out document: the language and where sign-in starts, an https URL or a path on the page's own origin", () => {
  expect(shellSignedOutSchema).toBe("lazurio.shell-signed-out.v1");
  const read = parseShellSignedOut(signedOutDocument());
  expect(read).toEqual({
    schema: "lazurio.shell-signed-out.v1",
    locale: "cs",
    signIn: "/auth/sign-in?return=%2F",
  });
  expect(Object.isFrozen(read)).toBe(true);
  for (const signIn of [
    "/auth/sign-in",
    "/",
    "https://dashboard.lazurio.ai/auth/sign-in?return=%2F",
    "https://dashboard.lazurio.ai/",
  ])
    expect(
      parseShellSignedOut(signedOutDocument({ locale: "en", signIn })),
    ).toEqual({ schema: "lazurio.shell-signed-out.v1", locale: "en", signIn });
  // Members this version does not know are ignored, as in both v1
  // documents; nothing of a person is read from it.
  expect(
    parseShellSignedOut(
      signedOutDocument({
        operator: { initials: "A", login: "ada", avatar: null },
        current: null,
        dashboard: "/home",
        later: { anything: true },
      }),
    ),
  ).toEqual({
    schema: "lazurio.shell-signed-out.v1",
    locale: "cs",
    signIn: "/auth/sign-in?return=%2F",
  });
});

test("the signed-out document is refused without its exact members: another schema, another language, no sign-in, or an address the elements could not lead to safely", () => {
  const { schema: _schema, ...noSchema } = signedOutDocument();
  const { locale: _locale, ...noLocale } = signedOutDocument();
  const { signIn: _signIn, ...noSignIn } = signedOutDocument();
  for (const input of [
    null,
    undefined,
    "lazurio.shell-signed-out.v1",
    [],
    noSchema,
    noLocale,
    noSignIn,
    signedOutDocument({ schema: "lazurio.shell-signed-out.v2" }),
    signedOutDocument({ schema: "lazurio.shell.v1" }),
    signedOutDocument({ locale: "de" }),
    signedOutDocument({ locale: null }),
    // A host without a sign-in provides no signed-out document at all.
    signedOutDocument({ signIn: null }),
    signedOutDocument({ signIn: "" }),
    signedOutDocument({ signIn: { href: "/auth/sign-in" } }),
  ])
    expect(parseShellSignedOut(input)).toBeNull();
  // The rule of the Dashboard's addresses in `lazurio.shell.v1`: https, or a
  // path on the page's own origin; never another origin without https, a
  // protocol-relative or backslashed path, a fragment, space, credentials, a
  // relative path or a script.
  for (const signIn of [
    "http://dashboard.lazurio.ai/auth/sign-in",
    "//evil.example/auth/sign-in",
    "/\\evil.example/auth/sign-in",
    "/auth\\sign-in",
    "/auth/sign-in#return",
    "https://dashboard.lazurio.ai/auth/sign-in#return",
    "/auth/sign in",
    "https://ada:secret@dashboard.lazurio.ai/auth/sign-in",
    "auth/sign-in",
    "javascript:alert(1)",
    `/${"a".repeat(512)}`,
  ])
    expect(parseShellSignedOut(signedOutDocument({ signIn }))).toBeNull();
});

test("each document has its own parser: neither v1 parser takes the signed-out document, and the signed-out parser takes neither v1 document", () => {
  expect(parseShell(signedOutDocument())).toBeNull();
  expect(parseShellAccount(signedOutDocument())).toBeNull();
  expect(parseShell(hostDocument())).not.toBeNull();
  expect(parseShellSignedOut(hostDocument())).toBeNull();
  expect(parseShellSignedOut(accountDocument())).toBeNull();
  // `lazurio.shell.v1` still requires its person: no operator, no document.
  const { operator: _operator, ...nobody } = hostDocument();
  expect(parseShell(nobody)).toBeNull();
  expect(parseShell({ ...hostDocument(), operator: null })).toBeNull();
});

const signedOut = (extra: Record<string, unknown> = {}): ShellSignedOut => {
  const read = parseShellSignedOut(signedOutDocument(extra));
  if (read === null) throw new Error("Expected a valid signed-out document");
  return read;
};
const person = (extra: Record<string, unknown> = {}): Shell => {
  const read = parseShell({ ...hostDocument(), ...extra });
  if (read === null) throw new Error("Expected a valid shell document");
  return read;
};
const account = (): ShellAccount => {
  const read = parseShellAccount(
    accountDocument({
      locale: "cs",
      lastBySpace: { example: { environment: "vm-03.example", app: "chat" } },
    }),
  );
  if (read === null) throw new Error("Expected a valid account document");
  return read;
};

// The rail.

test("the rail signed out is exactly the logo and the key, both leading to where sign-in starts, in the signed-in rail's order", () => {
  for (const [copy, key] of [
    [cs, "Přihlásit Lazurio účtem"],
    [en, "Sign in with your Lazurio account"],
  ] as const) {
    const rail = signedOutRail(signedOut(), copy);
    // The logo first, as in the signed-in rail, keeping its name and label;
    // the key last, where a person's account stands. Nothing else: no
    // search (⌘⇧E), no spaces, no "+" and no account.
    expect(rail).toEqual({
      label: "Lazurio",
      items: [
        {
          kind: "home",
          href: "/auth/sign-in?return=%2F",
          label: "Dashboard",
          sub: copy.dashboardSub,
        },
        {
          kind: "sign-in",
          href: "/auth/sign-in?return=%2F",
          label: key,
          sub: "",
        },
      ],
    });
    expect(Object.isFrozen(rail)).toBe(true);
    expect(rail.items.every((item) => Object.isFrozen(item))).toBe(true);
    // Its name is not the signed-in rail's ("Organizace"): it lists none.
    expect(rail.label).not.toBe(copy.rail);
  }
  // An https sign-in is led to as given.
  const https = "https://dashboard.lazurio.ai/auth/sign-in?return=%2F";
  expect(
    signedOutRail(signedOut({ signIn: https }), en).items.map(
      (item) => item.href,
    ),
  ).toEqual([https, https]);
});

// The state the elements draw from.

test("signed out the column head has nothing to draw, and the elements merge, request, remember and report nothing", async () => {
  const { state, requests, sent, lines, store } = observedState("host");
  const changes: number[] = [];
  state.listen(() => changes.push(changes.length));
  state.requestAccount();
  const document = signedOut();
  state.provideShell(document);
  state.provideAccount(null);
  state.report("apps", null);
  state.report("chat", "personal");
  await new Promise((done) => setTimeout(done, 10));
  // The rail draws the signed-out document; the column head draws only a
  // person's (`drawn`), so nothing, as before any document arrives.
  expect(state.signedOut()).toBe(document);
  expect(state.local()).toBe(document);
  expect(state.drawn()).toBeNull();
  expect(state.lastBySpace().size).toBe(0);
  expect(requests).toEqual([]);
  expect(store.calls).toEqual([]);
  expect(sent).toEqual([]);
  expect(lines).toEqual([]);
  expect(changes.length).toBe(2);
});

test("a host switching between signed out and signed in: a person's document draws the full rail and head, the signed-out one the logo and the key again", () => {
  const { state, store, sent } = observedState("host");
  const out = signedOut();
  state.provideShell(out);
  expect(state.drawn()).toBeNull();
  // The person signs in: the host provides their document and account.
  const page = person();
  const read = account();
  state.provideShell(page);
  state.provideAccount(read);
  expect(state.signedOut()).toBeNull();
  expect(state.local()).toBe(page);
  const drawn = state.drawn();
  if (drawn === null) throw new Error("A person's page is drawn");
  expect(drawn).toEqual(mergeAccount(page, read));
  expect(state.lastBySpace().get("example")).toEqual({
    environment: "vm-03.example",
    app: "chat",
  });
  // The full rail: the logo to the personal Dashboard, the spaces, and the
  // column head on an Organization's Dashboard.
  expect(railHome(drawn, null)).toEqual({ href: "/home", current: true });
  expect(
    railSpaces(drawn, cs, { here: null, app: null, last: () => null }).map(
      (space) => space.space,
    ),
  ).toEqual(["personal", "example", "other-example"]);
  expect(
    columnHead(drawn, cs, { space: "example", active: null, settings: null })
      ?.picker.title,
  ).toBe("Example Works");
  // Signed out again: the logo and the key, nothing of the person, even
  // while the host has not yet taken their account away.
  state.provideShell(out);
  expect(state.signedOut()).toBe(out);
  expect(state.local()).toBe(out);
  expect(state.drawn()).toBeNull();
  expect(state.lastBySpace().size).toBe(0);
  state.provideAccount(null);
  expect(state.drawn()).toBeNull();
  // And back: a person's document is drawn as always.
  state.provideShell(page);
  expect(state.signedOut()).toBeNull();
  expect(state.drawn()).toBe(page);
  // A host's page never remembers or reports, signed in or not.
  expect(store.calls).toEqual([]);
  expect(sent).toEqual([]);
});

test("on a page that reads the account itself, signed out keeps and reports nothing; a person's document then does as before", async () => {
  const { state, requests, sent, store } = observedState("origin");
  let changed = 0;
  const read = new Promise<void>((done) => {
    const stop = state.listen(() => {
      changed += 1;
      // The first change is the signed-out document, the second the
      // account's answer.
      if (changed === 2) {
        stop();
        done();
      }
    });
  });
  state.provideShell(signedOut());
  state.requestAccount();
  await read;
  // The page's one read happens as before, but nothing of it is kept or
  // drawn while nobody is signed in.
  expect(requests).toEqual([accountDocumentPath]);
  expect(store.calls).toEqual([]);
  expect(state.drawn()).toBeNull();
  state.report("apps", "personal");
  expect(sent).toEqual([]);
  // The account's own person's Environment: its document is merged with
  // the answer, which this origin then keeps, and the page reports once.
  state.provideShell(
    person({
      locale: "en",
      current: "ada",
      environments: [
        {
          id: "ada",
          label: null,
          kind: "personal",
          organizations: [],
          assignee: null,
          apps: {
            apps: "https://launchpad.ada.lazurio.io/",
            chat: null,
            automate: null,
          },
        },
      ],
      dashboard: "https://dashboard.lazurio.ai/home",
      account: "https://dashboard.lazurio.ai/settings/account",
      addOrganization: null,
    }),
  );
  expect(state.drawn()?.organizations.map((entry) => entry.slug)).toEqual([
    "example",
    "other-example",
  ]);
  expect(store.calls).toEqual([`set ${accountCacheKey}`]);
  state.report("apps", "personal");
  state.report("chat", "personal");
  expect(sent.map((body) => JSON.parse(body))).toEqual([
    { environment: "ada", app: "apps", organization: null },
  ]);
});
