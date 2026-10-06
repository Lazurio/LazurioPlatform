import { expect, test } from "bun:test";
import {
  parseShell,
  parseShellAccount,
  parseShellSignedOut,
  shellSignedOutSchema,
} from "../src/shell/contract";
import { accountDocument } from "./fixtures/account-document";

// F36's addendum of 2026-10-06: a host page with nobody signed in (the
// Dashboard, signed out) hands the shell `lazurio.shell-signed-out.v1`, a
// document of its own: the language and where sign-in starts. Neither v1
// document changes. Example names only.

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
