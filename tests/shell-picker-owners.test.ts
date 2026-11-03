import { expect, test } from "bun:test";
import {
  parseShell,
  parseShellAccount,
  type Shell,
} from "../src/shell/contract";
import {
  parseEnvironmentGlyph,
  parseEnvironmentIdentity,
} from "../src/shell/identity-protocol";
import { mergeAccount } from "../src/shell/merge";
import { shellMessages } from "../src/shell/messages";
import {
  columnHead,
  environmentGroup,
  environmentIdentity,
  environmentOwner,
  type SwitcherKind,
  switcherList,
} from "../src/shell/view";

// F36's addendum of 2026-11-03, approved by the Owner: in the switcher the
// main word of a row is whose the Environment is. A work Environment
// assigned to a person shows that person (their GitHub photo, their name,
// their whole @login); an Organization's Environments stand under the
// headings People, Teams and Organization, which carry the kind. Example
// names only.

const cs = shellMessages("cs");
const en = shellMessages("en");
const avatar = "https://avatars.githubusercontent.com/u/4242?v=4";

const apps = (base: string) => ({
  apps: `https://launchpad.${base}.lazurio.io/`,
  chat: `https://t3code.${base}.lazurio.io/`,
  automate: null,
});

type Entry = Record<string, unknown>;
const work = (id: string, assignee: string | null, extra: Entry = {}) => ({
  id,
  label: null,
  kind: "work",
  organizations: ["acme"],
  assignee,
  apps: apps(id),
  ...extra,
});

// Ada's view of the Acme Organization: a colleague's work Environment
// listed before her own, a Team's, the Organization's server services and an
// Automated persona's, and her personal Environment.
const environments = (extra: Readonly<Record<string, Entry>> = {}) => [
  work("vm-02.acme", "petr", {
    assigneeName: "Petr Novák",
    ...extra["vm-02.acme"],
  }),
  {
    id: "vm-03.acme",
    label: "Team Sales",
    kind: "team",
    organizations: ["acme"],
    assignee: null,
    apps: apps("vm-03.acme"),
    ...extra["vm-03.acme"],
  },
  work("vm-01.acme", "ada", {
    assigneeName: "Ada Lovelace",
    ...extra["vm-01.acme"],
  }),
  work("services-01.acme", null, {
    label: "Služby serveru",
    who: "pro Ownery a Adminy",
    ...extra["services-01.acme"],
  }),
  {
    id: "vm-04.acme",
    label: "Steward",
    kind: "automated",
    organizations: ["acme"],
    assignee: null,
    apps: apps("vm-04.acme"),
    ...extra["vm-04.acme"],
  },
  {
    id: "ada",
    label: null,
    kind: "personal",
    organizations: [],
    assignee: null,
    apps: apps("ada"),
  },
];

const acme = (
  extra: Readonly<Record<string, unknown>> = {},
  entries: Readonly<Record<string, Entry>> = {},
): Shell => {
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: "vm-01.acme",
    operator: { initials: "AL", login: "ada", avatar: null },
    environments: environments(entries),
    organizations: [
      {
        slug: "acme",
        name: "Acme Works",
        avatar,
        dashboard: "https://dashboard.lazurio.ai/orgs/acme",
      },
      {
        slug: "orbit",
        name: "Orbit Example",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/orbit",
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/home",
    account: "https://dashboard.lazurio.ai/settings/account",
    addOrganization: null,
    ...extra,
  });
  if (shell === null) throw new Error("The fixture is a shell document");
  return shell;
};

const list = (
  shell: Shell,
  kind: SwitcherKind,
  options: Partial<{
    here: string;
    widened: boolean;
    query: string;
    locale: "cs" | "en";
  }> = {},
) =>
  switcherList(shell, options.locale === "en" ? en : cs, {
    kind,
    here: options.here ?? "acme",
    widened: options.widened ?? false,
    app: "apps",
    query: options.query ?? "",
  });

const photo = (login: string, name: string, initials: string) => ({
  kind: "person" as const,
  name,
  avatar: `https://github.com/${login}.png?size=96`,
  initials,
});

test("the person's name is an additive member of both documents, only beside an assignee", () => {
  const shell = acme();
  expect(shell.environments[0]?.assigneeName).toBe("Petr Novák");
  // Absent: v1 as before.
  const without = acme({}, { "vm-02.acme": { assigneeName: undefined } });
  expect(without.environments[0]?.assigneeName).toBeUndefined();
  // A value the elements could not draw is left out, never the Environment
  // or the document.
  for (const bad of [null, "", 42, "x".repeat(129), "line\nbreak"]) {
    const read = acme({}, { "vm-02.acme": { assigneeName: bad } });
    expect(read.environments).toHaveLength(6);
    expect(read.environments[0]?.assigneeName).toBeUndefined();
  }
  // Without an assignee there is nobody to name.
  const services = acme({}, { "services-01.acme": { assigneeName: "Nobody" } });
  expect(
    services.environments.find((entry) => entry.id === "services-01.acme")
      ?.assigneeName,
  ).toBeUndefined();
  // The account's parser is the same.
  const account = parseShellAccount({
    schema: "lazurio.account.v1",
    locale: "cs",
    operator: { initials: "AL", login: "ada", avatar: null },
    environments: [work("vm-05.acme", "eva", { assigneeName: "Eva Malá" })],
    organizations: [
      {
        slug: "acme",
        name: "Acme Works",
        avatar,
        dashboard: "https://dashboard.lazurio.ai/orgs/acme",
      },
    ],
  });
  expect(account?.environments[0]?.assigneeName).toBe("Eva Malá");
});

test("the merge takes the person's name from the account like a name, only for the same assignee and in any language", () => {
  const local = acme({}, { "vm-01.acme": { assigneeName: undefined } });
  const account = (locale: "cs" | "en", assignee: string) =>
    parseShellAccount({
      schema: "lazurio.account.v1",
      locale,
      operator: { initials: "AL", login: "ada", avatar: null },
      environments: [
        work("vm-01.acme", assignee, {
          assigneeName: "Ada Lovelace",
          name: "Pracovní",
        }),
      ],
      organizations: [
        {
          slug: "acme",
          name: "Acme Works",
          avatar,
          dashboard: "https://dashboard.lazurio.ai/orgs/acme",
        },
      ],
    });
  const own = (shell: Shell) =>
    shell.environments.find((entry) => entry.id === "vm-01.acme");
  expect(own(mergeAccount(local, account("cs", "ADA")))?.assigneeName).toBe(
    "Ada Lovelace",
  );
  // A name is in no language: kept where the account's words are not.
  const english = own(mergeAccount(local, account("en", "ada")));
  expect([english?.name, english?.assigneeName]).toEqual([
    undefined,
    "Ada Lovelace",
  ]);
  // The local document says whom it is assigned to.
  expect(
    own(mergeAccount(local, account("cs", "petr")))?.assigneeName,
  ).toBeUndefined();
});

test("whose an Environment is: a person's work Environment by the person, a name of its own over theirs, never a default kind name", () => {
  const entry = (extra: Entry) => {
    const found = acme({}, { "vm-02.acme": extra }).environments[0];
    if (found === undefined) throw new Error("listed");
    return environmentOwner(found);
  };
  expect(entry({})).toEqual({
    login: "petr",
    name: "Petr Novák",
    ownName: null,
  });
  // The Dashboard's default names, in either language, and a name that
  // restates the login or the person's name are no name of its own.
  for (const name of ["Pracovní", "Work", "pracovni", "petr", "Petr Novák"])
    expect(entry({ name })?.ownName).toBeNull();
  // An Admin's rename or the person's own label is.
  expect(entry({ name: "Obchodní stanice" })?.ownName).toBe("Obchodní stanice");
  // Nobody's: a Team's, the server services, an Automated persona's.
  const shell = acme();
  for (const id of ["vm-03.acme", "services-01.acme", "vm-04.acme", "ada"]) {
    const found = shell.environments.find((item) => item.id === id);
    if (found === undefined) throw new Error("listed");
    expect([id, environmentOwner(found)]).toEqual([id, null]);
  }
});

test("the picker: People (yours first), Teams, Organization, each in the document's order, a person by their photo, name and whole login", () => {
  const picker = list(acme(), "picker");
  const [section] = picker.sections;
  expect(
    section?.groups.map((group) => [
      group.kind,
      group.title,
      group.rows.map((row) => [row.name, row.who, row.glyph, row.current]),
    ]),
  ).toEqual([
    [
      "people",
      "Lidé",
      [
        ["Ada Lovelace", "@ada", photo("ada", "Ada Lovelace", "AL"), true],
        ["Petr Novák", "@petr", photo("petr", "Petr Novák", "PN"), false],
      ],
    ],
    [
      "teams",
      "Týmy",
      [
        [
          "Team Sales",
          "Týmové Prostředí",
          { kind: "icon", icon: "users" },
          false,
        ],
      ],
    ],
    [
      "organization",
      "Organizace",
      [
        // Whom it is for, as the Dashboard words it.
        [
          "Služby serveru",
          "pro Ownery a Adminy",
          { kind: "icon", icon: "building" },
          false,
        ],
        ["Steward", "Pracovní", { kind: "icon", icon: "bot" }, false],
      ],
    ],
  ]);
  // The rows in the order of their groups; the cursor starts on yours.
  expect(section?.rows.map((row) => row.id)).toEqual([
    "vm-01.acme",
    "vm-02.acme",
    "vm-03.acme",
    "services-01.acme",
    "vm-04.acme",
  ]);
  expect(picker.start).toBe(0);
  // On the Team's page the cursor starts there, after the people.
  expect(list(acme({ current: "vm-03.acme" }), "picker").start).toBe(2);
  // In English.
  const english = list(acme(), "picker", { locale: "en" }).sections[0];
  expect(english?.groups.map((group) => group.title)).toEqual([
    "People",
    "Teams",
    "Organization",
  ]);
  expect(english?.rows[2]?.who).toBe("Team Environment");
});

test("under a person's name never 'assigned to @login'; a name of its own shows the person and the login under it", () => {
  const shell = acme(
    {},
    {
      "vm-02.acme": {
        name: "Obchodní stanice",
        who: "přiřazeno @petr",
        offline: true,
      },
    },
  );
  const petr = list(shell, "picker").sections[0]?.rows.find(
    (row) => row.id === "vm-02.acme",
  );
  expect([petr?.name, petr?.who]).toEqual([
    "Obchodní stanice",
    "Petr Novák · @petr · offline",
  ]);
  // Without the person's name, their login alone, not twice.
  const bare = acme({}, { "vm-02.acme": { assigneeName: undefined } });
  const row = list(bare, "picker").sections[0]?.rows.find(
    (entry) => entry.id === "vm-02.acme",
  );
  expect([row?.name, row?.who, row?.glyph]).toEqual([
    "petr",
    "",
    photo("petr", "petr", "PE"),
  ]);
});

test("an empty group is not shown; your personal space has no headings", () => {
  const people = acme({
    current: "vm-01.acme",
  });
  const onlyPeople = {
    ...people,
    environments: people.environments.filter(
      (entry) => entry.kind === "work" && entry.assignee !== null,
    ),
  };
  expect(
    list(onlyPeople, "picker").sections[0]?.groups.map((group) => group.kind),
  ).toEqual(["people"]);
  const personal = list(acme({ current: "ada" }), "picker", {
    here: "personal",
  });
  expect(
    personal.sections[0]?.groups.map((group) => [
      group.kind,
      group.title,
      group.rows.map((row) => row.id),
    ]),
  ).toEqual([[null, null, ["ada"]]]);
});

test("the jump and the widened picker list each Organization's Environments under the same headings", () => {
  for (const [kind, widened] of [
    ["jump", false],
    ["picker", true],
  ] as const) {
    const sections = list(acme(), kind, { widened }).sections;
    expect(
      sections.map((section) => [
        section.space,
        section.groups.map((group) => group.title),
      ]),
    ).toEqual([
      ["personal", [null]],
      ["acme", ["Lidé", "Týmy", "Organizace"]],
      // The jump keeps an Organization without an Environment under its
      // head, with no heading of its own.
      ...(kind === "jump" ? [["orbit", []]] : []),
    ]);
  }
});

test("a search finds a person by their name or login, and a heading by its word", () => {
  const ids = (query: string) =>
    list(acme(), "picker", { query }).sections.flatMap((section) =>
      section.groups.map((group) => [
        group.kind,
        group.rows.map((row) => row.id),
      ]),
    );
  expect(ids("novák")).toEqual([["people", ["vm-02.acme"]]]);
  expect(ids("PETR")).toEqual([["people", ["vm-02.acme"]]]);
  expect(ids("týmy")).toEqual([["teams", ["vm-03.acme"]]]);
  expect(ids("služby")).toEqual([["organization", ["services-01.acme"]]]);
  // A search starts the cursor on the first match.
  expect(list(acme(), "picker", { query: "petr" }).start).toBe(0);
});

test("the column head: the person's photo and name over 'Pracovní Prostředí'; every other Environment its name and kind", () => {
  const head = (shell: Shell) =>
    columnHead(shell, cs, { space: null, active: "apps", settings: null })
      ?.picker;
  expect(head(acme())).toEqual({
    id: "vm-01.acme",
    name: "Ada Lovelace",
    who: "Pracovní Prostředí",
    glyph: photo("ada", "Ada Lovelace", "AL"),
  });
  expect(head(acme({ current: "services-01.acme" }))).toEqual({
    id: "services-01.acme",
    name: "Služby serveru",
    who: "Pracovní Prostředí",
    glyph: {
      kind: "avatar",
      organization: "Acme Works",
      avatar,
      initials: "AW",
    },
  });
  expect(head(acme({ current: "vm-03.acme" }))?.who).toBe("Týmové Prostředí");
  // One identity everywhere: the head, `<lazurio-environment>` and the
  // Environment browser's bar.
  expect(head(acme())).toEqual(
    environmentIdentity(acme(), "vm-01.acme", cs) ?? undefined,
  );
});

test("the groups follow the kind, not the name", () => {
  const shell = acme();
  expect(
    shell.environments.map((entry) => [entry.id, environmentGroup(entry)]),
  ).toEqual([
    ["vm-02.acme", "people"],
    ["vm-03.acme", "teams"],
    ["vm-01.acme", "people"],
    ["services-01.acme", "organization"],
    ["vm-04.acme", "organization"],
    ["ada", "organization"],
  ]);
});

test("a person's photo and the Organization's building cross to the Environment browser's view and read back as themselves", () => {
  const identity = environmentIdentity(acme(), "vm-01.acme", cs);
  expect(
    parseEnvironmentIdentity(JSON.parse(JSON.stringify(identity))),
  ).toEqual(identity);
  expect(parseEnvironmentGlyph({ kind: "icon", icon: "building" })).toEqual({
    kind: "icon",
    icon: "building",
  });
  // Only an https photo, display words and short initials.
  for (const glyph of [
    { ...photo("ada", "Ada", "AL"), avatar: "javascript:alert(1)" },
    { ...photo("ada", "Ada", "AL"), avatar: "http://github.com/ada.png" },
    { ...photo("ada", "", "AL") },
    { ...photo("ada", "Ada", "TOO-MANY-LETTERS") },
  ])
    expect(parseEnvironmentGlyph(glyph)).toBeNull();
  expect(
    parseEnvironmentGlyph({ ...photo("ada", "Ada", "A"), avatar: null }),
  ).not.toBeNull();
});
