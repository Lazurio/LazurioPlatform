import { expect, test } from "bun:test";
import {
  choosePath,
  companyAppOf,
  isOneClick,
  type PathApp,
  type Rules,
} from "../src/integrations/path";

// The path rule of root decision 0162's addendum of 2026-10-09 (decision
// F42), every branch of the approved wireframe's `choosePath`: a connected
// tool wins, a connected path stays, přímo where just as easy, Composio where
// allowed, then what is missing and who acts.

const ORG: Rules = { scope: "organization", composio: true, companyApps: [] };
const PERSONAL: Rules = { scope: "personal", composio: true, companyApps: [] };

const notion: PathApp = {
  id: "notion",
  direct: { auth: "dcr" },
  composio: true,
};
const deepwiki: PathApp = {
  id: "deepwiki",
  direct: { auth: "none" },
  composio: false,
};
const cimd: PathApp = {
  id: "example",
  direct: { auth: "cimd" },
  composio: true,
};
const gmail: PathApp = {
  id: "gmail",
  direct: { auth: "company-app:google" },
  composio: true,
  tool: "gogcli",
};
const outlook: PathApp = {
  id: "outlook",
  direct: { auth: "company-app:microsoft" },
  composio: true,
};
const slack: PathApp = {
  id: "slack",
  direct: { auth: "needs-app" },
  composio: true,
};
const github: PathApp = {
  id: "github",
  direct: { auth: "needs-app" },
  composio: true,
  tool: "gh",
};
const salesforce: PathApp = { id: "salesforce", composio: true };
const whatsapp: PathApp = { id: "whatsapp", composio: false, tool: "wacli" };
const companyOnly: PathApp = {
  id: "box",
  direct: { auth: "needs-app" },
  composio: false,
};
const nothing: PathApp = { id: "nothing", composio: false };

test("which direct paths connect in one click, and which need a company app", () => {
  expect([notion, deepwiki, cimd].map(isOneClick)).toEqual([true, true, true]);
  expect([gmail, outlook, slack, salesforce].map(isOneClick)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(companyAppOf(gmail)).toBe("google");
  expect(companyAppOf(outlook)).toBe("microsoft");
  // An official MCP server that needs the company's own app for itself.
  expect(companyAppOf(slack)).toBe("slack");
  expect(companyAppOf(notion)).toBeNull();
  expect(companyAppOf(salesforce)).toBeNull();
});

test("directly where it is just as easy: one click, whatever Composio and the scope", () => {
  for (const app of [notion, deepwiki, cimd])
    for (const rules of [
      ORG,
      PERSONAL,
      { ...ORG, composio: false },
      { ...PERSONAL, composio: false },
    ])
      expect(choosePath({ app, rules, signedIn: false, admin: false })).toEqual(
        { path: "direct" },
      );
});

test("a company app: directly once it is set up, else through Composio where allowed", () => {
  const google: Rules = { ...ORG, companyApps: ["google"] };
  expect(
    choosePath({ app: gmail, rules: google, signedIn: false, admin: false }),
  ).toEqual({ path: "direct" });
  // Google's app does not open Microsoft's.
  expect(
    choosePath({ app: outlook, rules: google, signedIn: true, admin: false }),
  ).toEqual({ path: "composio", signIn: false });
  // Not set up: Composio, signing the person's account in first where needed.
  expect(
    choosePath({ app: gmail, rules: ORG, signedIn: true, admin: false }),
  ).toEqual({ path: "composio", signIn: false });
  expect(
    choosePath({ app: gmail, rules: ORG, signedIn: false, admin: false }),
  ).toEqual({ path: "composio", signIn: true });
  // The same for an official MCP server that needs the company's own app.
  expect(
    choosePath({ app: slack, rules: ORG, signedIn: true, admin: false }).path,
  ).toBe("composio");
  expect(
    choosePath({
      app: slack,
      rules: { ...ORG, companyApps: ["slack"] },
      signedIn: true,
      admin: false,
    }),
  ).toEqual({ path: "direct" });
});

test("without Composio the company app comes first: the Admin sets it up, anyone else asks", () => {
  const off: Rules = { ...ORG, composio: false };
  expect(
    choosePath({ app: gmail, rules: off, signedIn: true, admin: true }),
  ).toEqual({
    path: null,
    missing: "company-app",
    provider: "google",
    action: "set-up",
  });
  expect(
    choosePath({ app: outlook, rules: off, signedIn: true, admin: false }),
  ).toEqual({
    path: null,
    missing: "company-app",
    provider: "microsoft",
    action: "ask-admin",
  });
  expect(
    choosePath({ app: slack, rules: off, signedIn: true, admin: false }),
  ).toEqual({
    path: null,
    missing: "company-app",
    provider: "slack",
    action: "ask-admin",
  });
  // An app only Composio connects: the Admin allows Composio, anyone else asks.
  expect(
    choosePath({ app: salesforce, rules: off, signedIn: true, admin: true }),
  ).toEqual({ path: null, missing: "composio", action: "allow" });
  expect(
    choosePath({ app: salesforce, rules: off, signedIn: true, admin: false }),
  ).toEqual({ path: null, missing: "composio", action: "ask-admin" });
});

test("on a personal Environment there is no company app, and the person decides", () => {
  expect(
    choosePath({
      app: outlook,
      rules: PERSONAL,
      signedIn: false,
      admin: false,
    }),
  ).toEqual({ path: "composio", signIn: true });
  const off: Rules = { ...PERSONAL, composio: false };
  // The person decides there, whatever their role in an Organization.
  expect(
    choosePath({ app: outlook, rules: off, signedIn: true, admin: false }),
  ).toEqual({ path: null, missing: "composio", action: "allow" });
  // A company app does not count on a personal Environment, even listed.
  expect(
    choosePath({
      app: outlook,
      rules: { ...off, companyApps: [] },
      signedIn: true,
      admin: true,
    }).path,
  ).toBeNull();
  // An app with no path at all here says so.
  expect(
    choosePath({ app: companyOnly, rules: off, signedIn: true, admin: false }),
  ).toEqual({ path: null, missing: "path" });
  expect(
    choosePath({ app: nothing, rules: PERSONAL, signedIn: true, admin: true }),
  ).toEqual({ path: null, missing: "path" });
});

test("a connected tool for the app wins and its card offers no other path", () => {
  expect(
    choosePath({
      app: github,
      rules: { ...ORG, companyApps: ["github"] },
      signedIn: true,
      admin: true,
      tools: ["gh"],
    }),
  ).toEqual({ path: "tool", tool: "gh" });
  // It wins over accounts connected another way before.
  expect(
    choosePath({
      app: gmail,
      rules: PERSONAL,
      signedIn: true,
      admin: false,
      tools: ["gogcli"],
      connected: ["composio", "direct"],
    }),
  ).toEqual({ path: "tool", tool: "gogcli" });
  // Another app's tool changes nothing.
  expect(
    choosePath({
      app: gmail,
      rules: PERSONAL,
      signedIn: true,
      admin: false,
      tools: ["gh"],
    }),
  ).toEqual({ path: "composio", signIn: false });
});

test("an app only its tool connects: through it once connected, else the card leads to Tools", () => {
  expect(
    choosePath({
      app: whatsapp,
      rules: ORG,
      signedIn: true,
      admin: true,
      tools: ["wacli"],
    }),
  ).toEqual({ path: "tool", tool: "wacli" });
  expect(
    choosePath({ app: whatsapp, rules: ORG, signedIn: true, admin: true }),
  ).toEqual({ path: null, missing: "tool", tool: "wacli" });
  expect(
    choosePath({
      app: whatsapp,
      rules: { ...PERSONAL, composio: false },
      signedIn: false,
      admin: false,
    }),
  ).toEqual({ path: null, missing: "tool", tool: "wacli" });
});

test("one app, one path: what is connected keeps its way, přímo before an older Composio one", () => {
  // Notion goes directly in one click, but connected through Composio it stays there.
  expect(
    choosePath({
      app: notion,
      rules: PERSONAL,
      signedIn: true,
      admin: false,
      connected: ["composio"],
    }),
  ).toEqual({ path: "composio", signIn: false });
  // Both from older times: přímo wins.
  expect(
    choosePath({
      app: notion,
      rules: PERSONAL,
      signedIn: true,
      admin: false,
      connected: ["composio", "direct"],
    }),
  ).toEqual({ path: "direct" });
  // A direct account whose company app is gone keeps no way of its own.
  expect(
    choosePath({
      app: gmail,
      rules: ORG,
      signedIn: true,
      admin: false,
      connected: ["direct"],
    }),
  ).toEqual({ path: "composio", signIn: false });
  // A Composio account where Composio is no longer allowed keeps nothing either.
  expect(
    choosePath({
      app: salesforce,
      rules: { ...ORG, composio: false },
      signedIn: true,
      admin: false,
      connected: ["composio"],
    }),
  ).toEqual({ path: null, missing: "composio", action: "ask-admin" });
});

// Where the Environment has no Executor at all (Lazurio installs it on Remote
// Environments, decision F44), nothing is direct: an app goes the way that
// connects here instead of a dead end.
test("without Executor in the Environment nothing is direct, and an app goes the way that connects here", () => {
  const without: Rules = { ...ORG, direct: false };
  expect(
    choosePath({ app: notion, rules: without, signedIn: true, admin: false }),
  ).toEqual({ path: "composio", signIn: false });
  expect(
    choosePath({
      app: notion,
      rules: without,
      signedIn: true,
      admin: false,
      connected: ["direct"],
    }),
  ).toEqual({ path: "composio", signIn: false });
  expect(
    choosePath({
      app: deepwiki,
      rules: { ...PERSONAL, direct: false },
      signedIn: true,
      admin: true,
    }),
  ).toEqual({ path: null, missing: "path" });
  // `direct` left out means the Environment has Executor.
  expect(
    choosePath({ app: notion, rules: ORG, signedIn: true, admin: false }),
  ).toEqual({ path: "direct" });
});
