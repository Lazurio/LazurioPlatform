import { expect, test } from "bun:test";
import { shellDocument } from "../src/launchpad/shell-document";
import { accountCacheKey, accountDocumentPath } from "../src/shell/account";
import {
  parseShell,
  parseShellAccount,
  type Shell,
  type ShellAccount,
} from "../src/shell/contract";
import { createLastReport, keptVisit, lastVisit } from "../src/shell/last";
import { accountLastBySpace, mergeAccount } from "../src/shell/merge";
import { shellMessages } from "../src/shell/messages";
import { accountSourceOf } from "../src/shell/state";
import {
  columnHead,
  columnSetupLine,
  environmentGlyph,
  environmentName,
  environmentSettingsHref,
  environmentWho,
  hereOf,
  initialsOf,
  organizationSettingsHref,
  pageOf,
  railHome,
  railSpaces,
  switcherList,
  switchTabs,
} from "../src/shell/view";
import { accountDocument } from "./fixtures/account-document";
import { organizationWithEntry } from "./fixtures/machine-bindings";
import { observedState as observed } from "./fixtures/shell-state";

// F36's addendum of 2026-10-05: a host page that is no Environment's (the
// Dashboard) hosts the shell. Its `lazurio.shell.v1` has `current: null`
// and may name its own pages by path; the host provides the person's
// account itself (`<html data-lazurio-account="host">`), so the elements
// read, remember and report nothing; the `space` attribute says whose
// Dashboard the page is. Environment pages are drawn as before. Example
// names only.

const cs = shellMessages("cs");
const en = shellMessages("en");

// The host's own document, as the Dashboard emits it: the person signed in,
// no Environments or Organizations of its own (the account brings them),
// and its own pages by path.
const hostDocument = (extra: Record<string, unknown> = {}) => ({
  schema: "lazurio.shell.v1",
  locale: "en",
  current: null,
  operator: {
    initials: "A",
    login: "ada",
    avatar: "https://avatars.githubusercontent.com/u/9301?v=4",
  },
  environments: [],
  organizations: [],
  dashboard: "/home",
  account: "/settings/account",
  addOrganization: "/add-organization",
  ...extra,
});

const parsed = (value: unknown): Shell => {
  const shell = parseShell(value);
  if (shell === null) throw new Error("Expected a valid shell document");
  return shell;
};
const account = (extra: Record<string, unknown> = {}): ShellAccount => {
  const read = parseShellAccount(accountDocument(extra));
  if (read === null) throw new Error("Expected a valid account document");
  return read;
};
// The account remembers where the person was in the example Organization:
// Chat of the work Environment.
const visited = () =>
  account({
    lastBySpace: { example: { environment: "vm-03.example", app: "chat" } },
  });
// A Dashboard page: the host's document with the person's account merged.
const dashboardPage = (read: ShellAccount = visited()) =>
  mergeAccount(parsed(hostDocument()), read);

// An Environment's page: the example Organization's Team Environment.
const environmentDocument = (extra: Record<string, unknown> = {}) => ({
  schema: "lazurio.shell.v1",
  locale: "en",
  current: "vm-01.example",
  operator: { initials: "A", login: "ada", avatar: null },
  environments: [
    {
      id: "vm-01.example",
      label: "Sales",
      kind: "team",
      organizations: ["example"],
      assignee: null,
      apps: {
        apps: "https://launchpad.vm-01.example.lazurio.io/",
        chat: "https://t3code.vm-01.example.lazurio.io/",
        automate: null,
      },
    },
  ],
  organizations: [
    {
      slug: "example",
      name: "Example Works",
      avatar: null,
      dashboard: "https://dashboard.lazurio.ai/orgs/example",
    },
  ],
  dashboard: "https://dashboard.lazurio.ai/",
  account: "https://dashboard.lazurio.ai/settings",
  addOrganization: "https://dashboard.lazurio.ai/add-organization",
  ...extra,
});

// The contract.

test("a page that is no Environment's: `current: null` is a document with or without Environments; a missing `current` is not", () => {
  const empty = parseShell(hostDocument());
  expect(empty?.current).toBeNull();
  expect(empty?.environments).toEqual([]);
  // With Environments of its own, none of them current.
  const own = environmentDocument().environments;
  const withEnvironments = parseShell(
    hostDocument({
      environments: own,
      organizations: environmentDocument().organizations,
    }),
  );
  expect(withEnvironments?.current).toBeNull();
  expect(withEnvironments?.environments.map((entry) => entry.id)).toEqual([
    "vm-01.example",
  ]);
  // Explicit null only: absent, undefined, empty or another type is no
  // document.
  const { current: _current, ...missing } = hostDocument();
  expect(parseShell(missing)).toBeNull();
  for (const current of [undefined, "", 0, false, "vm-09.example"])
    expect(parseShell(hostDocument({ current }))).toBeNull();
  // What the current Environment lacks needs a current Environment.
  expect(parseShell(hostDocument({ setup: { github: "missing" } }))).toBeNull();
  expect(parseShell(hostDocument({ setup: null }))).toBeNull();
  // A Launchpad's own document always names its Environment.
  const hosted = shellDocument({
    preset: "hosted-organization-personal",
    machine: organizationWithEntry(20000, "vm-01.example.lazurio.io"),
    locale: "en",
    catalog: { kind: "catalog", organizations: [] },
  });
  expect(hosted.current).toBe("vm-01.example");
});

test("a host document may address its Dashboard pages by path; the account document may not; `//` and `#` never", () => {
  const withPaths = parsed(
    hostDocument({
      organizations: [
        {
          slug: "acme",
          name: "Acme Example",
          avatar: null,
          dashboard: "/orgs/acme",
        },
      ],
    }),
  );
  expect(withPaths.dashboard).toBe("/home");
  expect(withPaths.account).toBe("/settings/account");
  expect(withPaths.addOrganization).toBe("/add-organization");
  expect(withPaths.organizations[0]?.dashboard).toBe("/orgs/acme");
  // https stays valid, also beside paths, and in an Environment's document.
  expect(
    parseShell(hostDocument({ dashboard: "https://dashboard.lazurio.ai/" })),
  ).not.toBeNull();
  expect(
    parseShell(environmentDocument({ addOrganization: "/add-organization" })),
  ).not.toBeNull();
  // Never another origin without https, a fragment, space or a backslash.
  const organizationAt = (dashboard: string) => ({
    organizations: [{ slug: "acme", name: "Acme", avatar: null, dashboard }],
  });
  for (const address of [
    "//evil.example/",
    "/orgs/acme#settings",
    "/orgs/ acme",
    "/orgs\\acme",
    "orgs/acme",
    "http://dashboard.example.invalid/",
    "javascript:alert(1)",
  ]) {
    expect(parseShell(hostDocument({ dashboard: address }))).toBeNull();
    expect(parseShell(hostDocument({ account: address }))).toBeNull();
    expect(parseShell(hostDocument({ addOrganization: address }))).toBeNull();
    expect(parseShell(hostDocument(organizationAt(address)))).toBeNull();
  }
  // The account crosses origins: its Organization pages are https only.
  const document = accountDocument();
  expect(
    parseShellAccount({
      ...document,
      organizations: document.organizations.map((entry, index) =>
        index === 1 ? { ...entry, dashboard: "/orgs/other-example" } : entry,
      ),
    }),
  ).toBeNull();
  expect(parseShellAccount(document)).not.toBeNull();
});

test("the merge keeps a host's page a page that is no Environment's, with its own addresses", () => {
  const read = visited();
  const merged = mergeAccount(parsed(hostDocument()), read);
  expect(merged.current).toBeNull();
  expect(merged.dashboard).toBe("/home");
  expect(merged.environments.map((entry) => entry.id)).toEqual([
    "ada",
    "vm-01.example",
    "vm-03.example",
  ]);
  expect(merged.organizations.map((entry) => entry.slug)).toEqual([
    "example",
    "other-example",
  ]);
  expect(merged.operator).toEqual(read.operator);
  // Still a valid document of the same shape.
  expect(parseShell(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
});

// Where the page is.

test("on a Dashboard page the space is the Organization the host names; anything else is the personal Dashboard", () => {
  const shell = dashboardPage();
  const [example] = shell.organizations;
  if (example === undefined) throw new Error("The account's Organization");
  expect(pageOf(shell, "example")).toEqual({
    kind: "organization",
    organization: example,
  });
  // In the document's spelling, whatever case the host used.
  expect(hereOf(shell, "EXAMPLE")).toBe("example");
  for (const space of [null, "personal", "unknown", ""]) {
    expect(pageOf(shell, space)).toEqual({ kind: "dashboard" });
    expect(hereOf(shell, space)).toBeNull();
  }
  // Before the account brings the Organizations, the host's own document
  // lists none: the personal Dashboard.
  expect(pageOf(parsed(hostDocument()), "example").kind).toBe("dashboard");
  // An Environment's page stays in a space, as before.
  const environment = parsed(environmentDocument());
  const [team] = environment.environments;
  if (team === undefined) throw new Error("One Environment");
  expect(pageOf(environment, null)).toEqual({
    kind: "environment",
    environment: team,
    space: "example",
  });
  expect(hereOf(environment, "personal")).toBe("personal");
});

test("the rail on the personal Dashboard rings no space and marks the logo; on an Organization's Dashboard it rings that Organization", () => {
  const shell = dashboardPage();
  const rail = (space: string | null) =>
    railSpaces(shell, en, {
      here: hereOf(shell, space),
      app: null,
      last: () => null,
    }).map((entry) => [entry.space, entry.active]);
  expect(railHome(shell, "personal")).toEqual({ href: "/home", current: true });
  expect(railHome(shell, null).current).toBe(true);
  expect(rail("personal")).toEqual([
    ["personal", false],
    ["example", false],
    ["other-example", false],
  ]);
  expect(railHome(shell, "example").current).toBe(false);
  expect(rail("example")).toEqual([
    ["personal", false],
    ["example", true],
    ["other-example", false],
  ]);
  // On an Environment's page the logo is never the page you are on.
  expect(railHome(parsed(environmentDocument()), null)).toEqual({
    href: "https://dashboard.lazurio.ai/",
    current: false,
  });
});

test("from a Dashboard page a space leads to the account's last Environment there in the recorded app, else its first Environment's Apps, else its Dashboard", () => {
  const read = account({
    lastBySpace: {
      example: { environment: "vm-03.example", app: "chat" },
    },
  });
  const shell = dashboardPage(read);
  const last = accountLastBySpace(shell, read);
  const spaces = railSpaces(shell, en, {
    here: hereOf(shell, "example"),
    app: null,
    last: (space) => last.get(space) ?? null,
  });
  expect(spaces.map((space) => [space.space, space.href, space.sub])).toEqual([
    // No visit: the first Environment, in Apps.
    ["personal", "https://launchpad.ada.lazurio.io/", "1 Environment"],
    // The visit, in the app it recorded.
    [
      "example",
      "https://t3code.vm-03.example.lazurio.io/",
      "2 Environments · last Work",
    ],
    // No Environment: its Dashboard.
    [
      "other-example",
      "https://dashboard.lazurio.ai/orgs/other-example",
      en.spaceEmpty,
    ],
  ]);
  // A recorded app the Environment does not run opens its Apps; a visit of
  // an Environment the space does not hold is no visit, and the first one
  // opens in Apps.
  const elsewhere = account({
    lastBySpace: {
      personal: { environment: "ada", app: "automate" },
      example: { environment: "ada", app: "chat" },
    },
  });
  const other = dashboardPage(elsewhere);
  const visits = accountLastBySpace(other, elsewhere);
  expect(
    railSpaces(other, en, {
      here: null,
      app: null,
      last: (space) => visits.get(space) ?? null,
    }).map((space) => [space.space, space.href]),
  ).toEqual([
    ["personal", "https://launchpad.ada.lazurio.io/"],
    ["example", "https://launchpad.vm-01.example.lazurio.io/"],
    ["other-example", "https://dashboard.lazurio.ai/orgs/other-example"],
  ]);
  // On an Environment's page the rail's own app still decides.
  const environment = mergeAccount(parsed(environmentDocument()), read);
  const there = accountLastBySpace(environment, read);
  expect(
    railSpaces(environment, en, {
      here: "personal",
      app: "apps",
      last: (space) => there.get(space) ?? null,
    })[1]?.href,
  ).toBe("https://launchpad.vm-03.example.lazurio.io/");
});

// The column head.

test("the column head names the Organization on its Dashboard: its avatar, name, line, the gear to its Settings and no switch, in both languages", () => {
  const shell = dashboardPage();
  const [example, other] = shell.organizations;
  if (example === undefined || other === undefined)
    throw new Error("Two Organizations");
  const czech = columnHead(shell, cs, {
    space: "example",
    active: null,
    settings: null,
  });
  expect(czech).toEqual({
    here: "example",
    picker: {
      glyph: { kind: "avatar", organization: example },
      title: "Example Works",
      who: "Dashboard Organizace",
    },
    gear: {
      href: "https://dashboard.lazurio.ai/orgs/example/settings",
      label: "Nastavení Organizace",
      current: false,
    },
    tabs: null,
    setup: null,
  });
  const english = columnHead(shell, en, {
    space: "Other-Example",
    active: "settings",
    settings: "/orgs/other-example/settings/people",
  });
  expect(english?.picker.title).toBe("Other Example");
  expect(english?.picker.who).toBe("Organization Dashboard");
  expect(english?.gear).toEqual({
    href: "/orgs/other-example/settings/people",
    label: "Organization Settings",
    current: true,
  });
  expect(english?.tabs).toBeNull();
  // Without an avatar the mark is the Organization's initials.
  const plain = columnHead(
    mergeAccount(
      parsed(hostDocument()),
      account({
        organizations: [
          { ...accountDocument().organizations[0], avatar: null },
          accountDocument().organizations[1],
        ],
      }),
    ),
    en,
    { space: "example", active: null, settings: null },
  );
  const glyph = plain?.picker.glyph;
  if (glyph?.kind !== "avatar") throw new Error("The Organization's mark");
  expect(glyph.organization.avatar).toBeNull();
  expect(initialsOf(glyph.organization.name)).toBe("EW");
  // An empty attribute is none; a page on the host's origin stays a path.
  const host = parsed(
    hostDocument({
      organizations: [
        { slug: "acme", name: "Acme", avatar: null, dashboard: "/orgs/acme" },
      ],
    }),
  );
  expect(
    columnHead(host, en, { space: "acme", active: null, settings: "" })?.gear
      .href,
  ).toBe("/orgs/acme/settings");
});

test("the column head is nothing on the personal Dashboard", () => {
  const shell = dashboardPage();
  for (const space of [null, "personal", "unknown"])
    for (const copy of [cs, en])
      expect(
        columnHead(shell, copy, { space, active: "settings", settings: null }),
      ).toBeNull();
});

test("the Settings beside a picker: an Organization's under its page, an Environment's under its Launchpad", () => {
  expect(
    organizationSettingsHref("https://dashboard.lazurio.ai/orgs/example"),
  ).toBe("https://dashboard.lazurio.ai/orgs/example/settings");
  expect(
    organizationSettingsHref("https://dashboard.lazurio.ai/orgs/example/"),
  ).toBe("https://dashboard.lazurio.ai/orgs/example/settings");
  expect(organizationSettingsHref("/orgs/acme")).toBe("/orgs/acme/settings");
  const [hosted] = parsed(environmentDocument()).environments;
  if (hosted === undefined) throw new Error("One Environment");
  expect(environmentSettingsHref(hosted)).toBe(
    "https://launchpad.vm-01.example.lazurio.io/settings",
  );
  expect(
    environmentSettingsHref({
      ...hosted,
      apps: { apps: "/", chat: null, automate: null },
    }),
  ).toBe("/settings");
});

test("the picker's list on an Organization's Dashboard lists its Environments, none current and no head; the jump marks the Organization's head as where you are", () => {
  const shell = dashboardPage();
  // F36's addendum of 2026-10-06: the picker picks Environments only; the
  // Organization's Dashboard is its name in the page's head.
  const picker = switcherList(shell, cs, {
    kind: "picker",
    here: hereOf(shell, "example"),
    widened: false,
    app: "apps",
    query: "",
  });
  const [section] = picker.sections;
  expect(picker.sections).toHaveLength(1);
  expect(section?.head).toBeNull();
  expect(section?.rows.map((row) => [row.id, row.current, row.href])).toEqual([
    ["vm-01.example", false, "https://launchpad.vm-01.example.lazurio.io/"],
    ["vm-03.example", false, "https://launchpad.vm-03.example.lazurio.io/"],
  ]);
  // Nothing current: the cursor starts on the first Environment.
  expect(picker.start).toBe(0);
  // ⌘⇧E: only that Organization's head is where you are.
  const jump = switcherList(shell, cs, {
    kind: "jump",
    here: "example",
    widened: false,
    app: "apps",
    query: "",
  });
  expect(
    jump.sections.map((entry) => [
      entry.space,
      entry.head?.current ?? null,
      entry.rows.some((row) => row.current),
    ]),
  ).toEqual([
    ["personal", null, false],
    ["example", true, false],
    ["other-example", false, false],
  ]);
  expect(jump.sections[1]?.head?.href).toBe(
    "https://dashboard.lazurio.ai/orgs/example",
  );
  // "Všechny Organizace" widens the picker to every space, still without a
  // head.
  const widened = switcherList(shell, cs, {
    kind: "picker",
    here: "example",
    widened: true,
    app: "apps",
    query: "",
  });
  expect(widened.sections.map((entry) => entry.head)).toEqual(
    widened.sections.map(() => null),
  );
  // The personal Dashboard: nothing is where you are.
  const personal = switcherList(shell, cs, {
    kind: "jump",
    here: null,
    widened: false,
    app: "apps",
    query: "",
  });
  expect(
    personal.sections.some(
      (entry) =>
        entry.head?.current === true || entry.rows.some((row) => row.current),
    ),
  ).toBe(false);
  // An Environment's page marks its Environment, never a head, and the
  // picker's cursor starts there.
  const environment = switcherList(parsed(environmentDocument()), cs, {
    kind: "picker",
    here: "example",
    widened: false,
    app: "apps",
    query: "",
  });
  expect(environment.sections[0]?.head).toBeNull();
  expect(environment.sections[0]?.rows.map((row) => row.current)).toEqual([
    true,
  ]);
  expect(environment.start).toBe(0);
});

// Nothing reported or remembered.

test("nothing is reported or remembered from a page that is no Environment's", async () => {
  const shell = dashboardPage();
  expect(lastVisit(shell, "apps", "example")).toBeNull();
  expect(keptVisit(shell, "example")).toBeNull();
  expect(keptVisit(shell, null)).toBeNull();
  const sent: string[] = [];
  const report = createLastReport(async (body) => {
    sent.push(body);
  });
  for (const app of ["apps", "chat", "automate"] as const)
    report(shell, app, "example");
  expect(sent).toEqual([]);
  // The reporter is not used up by such a page: an Environment's page of
  // the same load still reports once.
  const environment = parsed(environmentDocument());
  report(environment, "apps", "example");
  report(environment, "chat", "example");
  expect(sent.map((body) => JSON.parse(body))).toEqual([
    { environment: "vm-01.example", app: "apps", organization: "example" },
  ]);
  // This browser keeps the space and the Environment of an Environment's
  // page, as before.
  expect(keptVisit(environment, "example")).toEqual({
    space: "example",
    environment: "vm-01.example",
  });
  // The switch and the setup line have nothing to show there.
  expect(switchTabs(shell, cs, "apps")).toEqual([]);
  expect(columnSetupLine(shell, cs, "chat")).toBeNull();
});

// Who provides the account.

test("the account's source is the document's marker: the host only for exactly `host`", () => {
  expect(accountSourceOf("host")).toBe("host");
  for (const marker of [undefined, null, "", "HOST", "origin", "true"])
    expect(accountSourceOf(marker)).toBe("origin");
});

test("a host that provides the account: no request for it, no remembered account read or written, no report of the last Environment", async () => {
  const { state, requests, sent, lines, store, asked } = observed("host");
  const changes: number[] = [];
  state.listen(() => changes.push(changes.length));
  state.requestAccount();
  // An Environment's page in host mode too: the host owns the account.
  state.provideShell(parsed(environmentDocument()));
  const read = visited();
  state.provideAccount(read);
  state.report("apps", "example");
  state.report("chat", "example");
  await new Promise((done) => setTimeout(done, 10));
  expect(requests).toEqual([]);
  expect(store.calls).toEqual([]);
  expect(sent).toEqual([]);
  expect(lines).toEqual([]);
  // The provided account is what the elements draw, merged as always.
  expect(state.drawn()).toEqual(
    mergeAccount(parsed(environmentDocument()), read),
  );
  expect(state.lastBySpace().get("example")).toEqual({
    environment: "vm-03.example",
    app: "chat",
  });
  expect(changes.length).toBe(2);
  // None is none: the host's own document alone.
  const host = parsed(hostDocument());
  state.provideShell(host);
  state.provideAccount(null);
  expect(state.drawn()).toBe(host);
  expect(store.calls).toEqual([]);
  // The marker is read once per page.
  expect(asked()).toBe(1);
});

test("without the marker the elements read, remember and report on their own origin as before, and a provided account is ignored with one debug line", async () => {
  const { state, requests, sent, lines, store } = observed("origin");
  // The person's own personal Remote Environment: it keeps her account.
  const personal = parsed({
    ...environmentDocument(),
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
    organizations: [],
  });
  const answered = new Promise<void>((done) => {
    const stop = state.listen(() => {
      if (state.drawn()?.organizations.length === 2) {
        stop();
        done();
      }
    });
  });
  state.provideShell(personal);
  state.requestAccount();
  state.requestAccount();
  await answered;
  expect(requests).toEqual([accountDocumentPath]);
  expect(store.calls).toEqual([
    `get ${accountCacheKey}`,
    `set ${accountCacheKey}`,
  ]);
  state.report("apps", "personal");
  state.report("chat", "personal");
  expect(sent.map((body) => JSON.parse(body))).toEqual([
    { environment: "ada", app: "apps", organization: null },
  ]);
  const before = state.drawn();
  state.provideAccount(account({ lastBySpace: {} }));
  expect(state.drawn()).toBe(before);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('data-lazurio-account="host"');
});

// Environment pages are unchanged.

test("on an Environment's page the column head is the picker, the gear, the switch and the setup line as before", () => {
  const work = shellDocument({
    preset: "hosted-organization-personal",
    machine: organizationWithEntry(20000, "vm-01.example.lazurio.io"),
    locale: "cs",
    catalog: {
      kind: "catalog",
      organizations: [
        {
          directory: "example_GEN3",
          organization: "example",
          displayName: "Example Works",
          forgeLogin: "example",
          state: "current",
          issues: [],
          executable: true,
          teams: [],
          modules: [],
          repositories: [],
        },
      ],
    },
    setup: { github: "missing" },
  });
  const workstation = shellDocument({
    preset: "local",
    machine: null,
    locale: "en",
    catalog: { kind: "catalog", organizations: [] },
  });
  for (const shell of [work, workstation]) {
    for (const copy of [cs, en])
      for (const active of [null, "chat", "apps", "automate", "settings"])
        for (const settings of [null, "/settings/general"]) {
          const environment = shell.environments[0];
          if (environment === undefined) throw new Error("One Environment");
          const here = hereOf(shell, null);
          if (here === null) throw new Error("An Environment's space");
          const app =
            active === "chat" || active === "apps" || active === "automate"
              ? active
              : null;
          expect(
            columnHead(shell, copy, { space: null, active, settings }),
          ).toEqual({
            here,
            picker: {
              glyph: environmentGlyph(shell, environment, here),
              title: environmentName(environment, copy),
              who: environmentWho(environment, copy),
            },
            gear: {
              // The attribute, else the Launchpad's Settings, as the gear
              // always led.
              href:
                settings ??
                (environment.apps.apps === "/"
                  ? "/settings"
                  : `${environment.apps.apps}settings`),
              label: copy.settings,
              current: active === "settings",
            },
            tabs: switchTabs(shell, copy, app),
            setup: columnSetupLine(shell, copy, app),
          });
        }
  }
  // The setup line still shows in Chat.
  expect(
    columnHead(work, cs, { space: null, active: "chat", settings: null })?.setup
      ?.text,
  ).toBe(cs.setupGithub);
  // And the switch keeps its three tabs.
  expect(
    columnHead(workstation, en, {
      space: null,
      active: "apps",
      settings: null,
    })?.tabs?.map((tab) => [tab.app, tab.href, tab.active]),
  ).toEqual([
    ["chat", null, false],
    ["apps", "/", true],
    ["automate", null, false],
  ]);
});
