import { afterEach, expect, test } from "bun:test";
import {
  accountCacheKey,
  accountDocumentPath,
  cachedAccountFor,
  pageAccountJson,
  readAccountJson,
  readShellAccount,
  rememberAccount,
} from "../src/shell/account";
import {
  parseShell,
  parseShellAccount,
  type Shell,
  type ShellAccount,
} from "../src/shell/contract";
import { accountLastBySpace, mergeAccount } from "../src/shell/merge";
import { shellMessages } from "../src/shell/messages";
import {
  environmentName,
  environmentWho,
  railSpaces,
  spaceEnvironments,
  switcherSections,
} from "../src/shell/view";
import { accountDocument } from "./fixtures/account-document";

// Decision F37 and its addendum of 2026-10-04: the shell reads the person's
// account (`lazurio.account.v1`, relayed by the Environment's gateway at
// `/.lazurio/account/environments`) with the parser of `lazurio.shell.v1`,
// and merges it into this Environment's document: the local document wins
// for `current` and its apps, the account adds the person's other spaces and
// Environments. Without the account the rail is exactly F36's. Example names
// only.

const en = shellMessages("en");
const noLast = () => null;

// This Environment's own document: the example Organization's Team
// Environment, its Organization by the manifest's slug (with a capital, as
// a manifest may write it).
const localDocument = (extra: Record<string, unknown> = {}) => ({
  schema: "lazurio.shell.v1",
  locale: "en",
  current: "vm-01.example",
  operator: { initials: null, login: null, avatar: null },
  environments: [
    {
      id: "vm-01.example",
      label: "Sales",
      kind: "team",
      organizations: ["Example"],
      assignee: null,
      apps: {
        apps: "https://launchpad.vm-01.example.lazurio.io/",
        chat: "https://t3code.vm-01.example.lazurio.io/",
        automate: "https://mausbot.vm-01.example.lazurio.io/",
      },
    },
  ],
  organizations: [
    {
      slug: "Example",
      name: "Example Company",
      avatar: "https://github.com/example.png?size=96",
      dashboard: "https://dashboard.lazurio.ai/orgs/example",
    },
  ],
  dashboard: "https://dashboard.lazurio.ai/",
  account: "https://dashboard.lazurio.ai/settings",
  addOrganization: "https://dashboard.lazurio.ai/add-organization",
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
const local = parsed(localDocument());

// The parser.

test("the account document as the Dashboard emits it: the shell's entries, its optional words and the account-only members", () => {
  const read = account({
    last: {
      environment: "vm-03.example",
      app: "chat",
      organization: "example",
    },
    lastBySpace: {
      personal: { environment: "ada", app: "apps" },
      example: { environment: "vm-03.example", app: "chat" },
    },
    favourites: {
      example: [
        { kind: "module", id: "deals" },
        { kind: "repository", id: "firmware" },
      ],
    },
    preferences: { openApps: "same" },
  });
  expect(read.schema).toBe("lazurio.account.v1");
  expect(read.locale).toBe("en");
  expect(read.operator).toEqual({
    initials: "A",
    login: "ada",
    avatar: "https://avatars.githubusercontent.com/u/9301?v=4",
  });
  expect(read.environments.map((entry) => entry.id)).toEqual([
    "ada",
    "vm-01.example",
    "vm-03.example",
  ]);
  // `name` and `who` are kept; `offline: false` is the same as absent.
  expect(read.environments[1]).toEqual({
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
    name: "Team Sales",
    who: "shared by the Team",
  });
  expect(read.organizations.map((entry) => entry.slug)).toEqual([
    "example",
    "other-example",
  ]);
  expect(read.last).toEqual({
    environment: "vm-03.example",
    app: "chat",
    organization: "example",
  });
  expect(read.lastBySpace).toEqual({
    personal: { environment: "ada", app: "apps" },
    example: { environment: "vm-03.example", app: "chat" },
  });
  expect(read.favourites).toEqual({
    example: [
      { kind: "module", id: "deals" },
      { kind: "repository", id: "firmware" },
    ],
  });
  expect(read.preferences).toEqual({ openApps: "same" });
});

test("the account-only members may be absent; `who` may be null; `offline: true` is kept", () => {
  const document = accountDocument();
  const environments = document.environments.map((entry, index) =>
    index === 2 ? { ...entry, who: null, offline: true } : entry,
  );
  const read = parseShellAccount({
    schema: document.schema,
    locale: document.locale,
    operator: document.operator,
    environments,
    organizations: document.organizations,
  });
  expect(read?.last).toBeNull();
  expect(read?.lastBySpace).toEqual({});
  expect(read?.favourites).toEqual({});
  expect(read?.preferences).toEqual({ openApps: "tab" });
  const work = read?.environments[2];
  expect(work?.who).toBeUndefined();
  expect(work?.offline).toBe(true);
  expect(work?.name).toBe("Work");
});

test("members the parser does not know are dropped, as the shell's are", () => {
  const document = accountDocument({
    current: "vm-01.example",
    upcoming: { anything: true },
  });
  const environments = document.environments.map((entry) => ({
    ...entry,
    machine: "vm-01",
  }));
  const read = parseShellAccount({ ...document, environments });
  expect(read).not.toBeNull();
  expect(read && "current" in read).toBe(false);
  expect(read && "upcoming" in read).toBe(false);
  expect(read?.environments.some((entry) => "machine" in entry)).toBe(false);
});

test("an invalid account document is refused as a whole", () => {
  const document = accountDocument();
  const environment = (patch: Record<string, unknown>, index = 1) => ({
    environments: document.environments.map((entry, at) =>
      at === index ? { ...entry, ...patch } : entry,
    ),
  });
  const organization = (patch: Record<string, unknown>) => ({
    organizations: document.organizations.map((entry, at) =>
      at === 0 ? { ...entry, ...patch } : entry,
    ),
  });
  const team = document.environments[1];
  for (const extra of [
    { schema: "lazurio.shell.v1" },
    { schema: undefined },
    { locale: "de" },
    { operator: { initials: "<b>", login: "ada", avatar: null } },
    { operator: { initials: "A", login: "ada" } },
    { environments: "none" },
    { organizations: null },
    // An Apps address over http, with credentials, or a path: another
    // Environment is always an absolute https address.
    environment({
      apps: {
        ...team?.apps,
        apps: "http://launchpad.vm-01.example.lazurio.io/",
      },
    }),
    environment({
      apps: {
        ...team?.apps,
        apps: "https://user:secret@launchpad.vm-01.example.lazurio.io/",
      },
    }),
    environment({ apps: { ...team?.apps, apps: "/" } }),
    environment({ apps: { ...team?.apps, chat: "javascript:alert(1)" } }),
    environment({ kind: "server" }),
    environment({ organizations: ["unknown"] }),
    environment({ assignee: "not a login" }),
    environment({ name: "" }),
    environment({ name: 42 }),
    environment({ name: "x".repeat(129) }),
    environment({ who: 7 }),
    environment({ offline: "no" }),
    { environments: [...document.environments, team] },
    organization({ avatar: "http://example.com/a.png" }),
    organization({ dashboard: null }),
    {
      organizations: [
        ...document.organizations,
        { ...document.organizations[0], slug: "EXAMPLE" },
      ],
    },
    { last: { environment: "vm-09.example", app: "apps", organization: null } },
    { last: { environment: "ada", app: "files", organization: null } },
    { last: { environment: "ada", app: "apps", organization: "unknown" } },
    { last: "ada" },
    { lastBySpace: { unknown: { environment: "ada", app: "apps" } } },
    {
      lastBySpace: { personal: { environment: "vm-09.example", app: "apps" } },
    },
    { lastBySpace: [] },
    { favourites: { unknown: [] } },
    { favourites: { example: [{ kind: "app", id: "deals" }] } },
    { favourites: { example: [{ kind: "module", id: "" }] } },
    { favourites: { example: "deals" } },
    { preferences: { openApps: "window" } },
    { preferences: "same" },
  ])
    expect(parseShellAccount(accountDocument(extra))).toBeNull();
  for (const value of [null, [], "lazurio.account.v1", 42])
    expect(parseShellAccount(value)).toBeNull();
});

test("an Environment's id is its identity by `isEnvironmentId`: the base host of its own Apps address", () => {
  const document = accountDocument();
  const withId = (id: unknown) => ({
    environments: document.environments.map((entry, at) =>
      at === 1 ? { ...entry, id } : entry,
    ),
  });
  // The bare machine name repeats across Organizations: never an id.
  for (const id of [
    "vm-01",
    "VM-01.example",
    "vm-01.example.extra",
    "vm-02.example",
    "",
    "-vm.example",
    42,
  ])
    expect(parseShellAccount(accountDocument(withId(id)))).toBeNull();
  // A personal Remote Environment is its personal DNS slug.
  expect(
    parseShellAccount(
      accountDocument({
        environments: document.environments.map((entry, at) =>
          at === 0 ? { ...entry, id: "ben" } : entry,
        ),
      }),
    ),
  ).toBeNull();
  expect(parseShellAccount(accountDocument())).not.toBeNull();
});

test("one parser for both documents: the shell's entries take the same optional words", () => {
  const environments = localDocument().environments.map((entry) => ({
    ...entry,
    name: "Team Sales 2",
    who: "shared by the Team",
    offline: false,
  }));
  const shell = parseShell(localDocument({ environments }));
  expect(shell?.environments[0]?.name).toBe("Team Sales 2");
  expect(shell?.environments[0]?.who).toBe("shared by the Team");
  expect(
    parseShell(
      localDocument({
        environments: environments.map((entry) => ({ ...entry, who: 1 })),
      }),
    ),
  ).toBeNull();
  // The account document is no shell document, and the other way round.
  expect(parseShell(accountDocument())).toBeNull();
  expect(parseShellAccount(localDocument())).toBeNull();
});

test("the account's words name an Environment first; without them its label or kind does", () => {
  const read = account();
  const [personal, team, work] = read.environments;
  if (!personal || !team || !work) throw new Error("Three Environments");
  expect(environmentName(personal, en)).toBe("Ada personal");
  expect(environmentWho(personal, en)).toBe("only yours");
  expect(environmentName(team, en)).toBe("Team Sales");
  expect(environmentWho(work, en)).toBe("only yours");
  const plain = local.environments[0];
  if (!plain) throw new Error("One Environment");
  expect(environmentName(plain, en)).toBe("Sales");
  expect(environmentWho(plain, en)).toBe(en.who.team);
});

// The merge.

test("without the account the document is exactly the local one", () => {
  expect(mergeAccount(local, null)).toBe(local);
  expect(accountLastBySpace(local, null).size).toBe(0);
});

test("the local document wins for `current` and its apps; the account adds the person's other spaces and Environments", () => {
  // The account's entry of this Environment differs (no Automate): the
  // local one stands, taking only the account's words for it.
  const merged = mergeAccount(local, account());
  expect(merged.current).toBe("vm-01.example");
  expect(merged.environments.map((entry) => entry.id)).toEqual([
    "ada",
    "vm-01.example",
    "vm-03.example",
  ]);
  expect(
    merged.environments.filter((entry) => entry.id === "vm-01.example"),
  ).toHaveLength(1);
  const here = merged.environments[1];
  expect(here?.apps).toBe(local.environments[0]?.apps);
  expect(here?.apps.automate).toBe("https://mausbot.vm-01.example.lazurio.io/");
  expect(here?.label).toBe("Sales");
  expect(here?.organizations).toEqual(["Example"]);
  expect(here?.name).toBe("Team Sales");
  expect(here?.who).toBe("shared by the Team");
  // The account's Environments of the example Organization name the local
  // slug, so they sit in its space.
  expect(merged.environments[2]?.organizations).toEqual(["Example"]);
  expect(merged.environments[0]?.organizations).toEqual([]);
  // The operator is the person signed in at the browser.
  expect(merged.operator).toEqual(account().operator);
  // The rest is the local document's.
  expect(merged.locale).toBe(local.locale);
  expect(merged.dashboard).toBe(local.dashboard);
  expect(merged.account).toBe(local.account);
  expect(merged.addOrganization).toBe(local.addOrganization);
  // Still a valid shell document.
  expect(parseShell(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
});

test("an account entry whose id is `current` is dropped even where the account words it otherwise", () => {
  const document = accountDocument();
  const merged = mergeAccount(
    local,
    account({
      environments: document.environments.map((entry, at) =>
        at === 1
          ? {
              ...entry,
              kind: "team",
              label: "Other",
              organizations: ["other-example"],
              apps: { ...entry.apps, chat: null },
            }
          : entry,
      ),
    }),
  );
  const here = merged.environments.find((entry) => entry.id === merged.current);
  expect(here?.label).toBe("Sales");
  expect(here?.organizations).toEqual(["Example"]);
  expect(here?.apps.chat).toBe("https://t3code.vm-01.example.lazurio.io/");
});

test("Organizations: one per Dashboard slug, the local entry in the account's place, local ones the account lacks after it", () => {
  const withOwn = parsed(
    localDocument({
      organizations: [
        ...localDocument().organizations,
        {
          slug: "Local Only",
          name: "Local Only",
          avatar: null,
          dashboard: "https://dashboard.lazurio.ai/orgs/local-only",
        },
      ],
    }),
  );
  const merged = mergeAccount(withOwn, account());
  expect(merged.organizations.map((entry) => entry.slug)).toEqual([
    "Example",
    "other-example",
    "Local Only",
  ]);
  // The local entry wins: its name and avatar, not the account's.
  expect(merged.organizations[0]).toBe(withOwn.organizations[0]);
  // A local Environment the account does not list comes first.
  const workstation = parsed({
    ...localDocument(),
    current: "local",
    environments: [
      {
        id: "local",
        label: "Example-MacBook",
        kind: "workstation",
        organizations: ["Example"],
        assignee: null,
        apps: { apps: "/", chat: null, automate: null },
      },
    ],
  });
  expect(
    mergeAccount(workstation, account()).environments.map((entry) => entry.id),
  ).toEqual(["local", "ada", "vm-01.example", "vm-03.example"]);
});

test("spaces without an Environment: the rail shows the Organization's avatar, says it has none and leads to its Dashboard", () => {
  const merged = mergeAccount(local, account());
  expect(spaceEnvironments(merged, "other-example")).toEqual([]);
  const spaces = railSpaces(merged, en, {
    here: "Example",
    app: "chat",
    last: noLast,
  });
  expect(
    spaces.map((space) => [space.space, space.title, space.active]),
  ).toEqual([
    ["personal", en.personal, false],
    ["Example", "Example Company", true],
    ["other-example", "Other Example", false],
  ]);
  const other = spaces[2];
  expect(other?.href).toBe("https://dashboard.lazurio.ai/orgs/other-example");
  expect(other?.sub).toBe(en.spaceEmpty);
  expect(other?.avatar).toBe(
    "https://avatars.githubusercontent.com/u/720202?v=4",
  );
  // Your personal space: your initials, your personal Environment, in the
  // same app where it has it, else Apps.
  expect(spaces[0]?.initials).toBe("A");
  expect(spaces[0]?.href).toBe("https://launchpad.ada.lazurio.io/");
  expect(spaces[0]?.sub).toBe("1 Environment");
  // The example Organization now holds two Environments.
  expect(spaces[1]?.sub).toBe("2 Environments");
  // "All Organizations" lists the empty one with its Dashboard head and no
  // row; the elements add "You have no Environment here." under it.
  const sections = switcherSections(merged, en, {
    here: "Example",
    all: true,
    app: "apps",
    query: "",
  });
  expect(
    sections.map((section) => [section.space, section.rows.length]),
  ).toEqual([
    ["personal", 1],
    ["Example", 2],
    ["other-example", 0],
  ]);
  expect(sections[2]?.head?.href).toBe(
    "https://dashboard.lazurio.ai/orgs/other-example",
  );
  // The picker of this space: this Environment checked, the other named by
  // the account's words.
  const [picker] = switcherSections(merged, en, {
    here: "Example",
    all: false,
    app: "chat",
    query: "",
  });
  expect(
    picker?.rows.map((row) => [row.name, row.who, row.current, row.href]),
  ).toEqual([
    [
      "Team Sales",
      "shared by the Team",
      true,
      "https://t3code.vm-01.example.lazurio.io/",
    ],
    ["Work", "only yours", false, "https://t3code.vm-03.example.lazurio.io/"],
  ]);
});

test("without the account the rail and the picker are exactly today's", () => {
  const options = { here: "Example", app: "apps", last: noLast } as const;
  expect(railSpaces(mergeAccount(local, null), en, options)).toEqual(
    railSpaces(local, en, options),
  );
  expect(railSpaces(local, en, options).map((space) => space.space)).toEqual([
    "personal",
    "Example",
  ]);
});

test("the account's last Environment per space, by the merged space's id, only for listed Environments", () => {
  const read = account({
    lastBySpace: {
      personal: { environment: "ada", app: "apps" },
      example: { environment: "vm-03.example", app: "chat" },
    },
  });
  const merged = mergeAccount(local, read);
  expect([...accountLastBySpace(merged, read)]).toEqual([
    ["personal", "ada"],
    ["Example", "vm-03.example"],
  ]);
  // The rail leads there, with its "last" line.
  const last = accountLastBySpace(merged, read);
  const spaces = railSpaces(merged, en, {
    here: "personal",
    app: "chat",
    last: (space) => last.get(space) ?? null,
  });
  expect(spaces[1]?.href).toBe("https://t3code.vm-03.example.lazurio.io/");
  expect(spaces[1]?.sub).toBe("2 Environments · last Work");
});

// An ambiguous Dashboard slug (Pablo's review of #166): two local
// Organizations whose slugs reduce to the same Dashboard slug.
const hosted = (base: string) => ({
  apps: `https://launchpad.${base}.lazurio.io/`,
  chat: `https://t3code.${base}.lazurio.io/`,
  automate: null,
});
const ambiguousLocal = () =>
  parsed(
    localDocument({
      current: "vm-01.example-org",
      environments: [
        {
          id: "vm-01.example-org",
          label: "Sales",
          kind: "team",
          organizations: ["Example Org"],
          assignee: null,
          apps: hosted("vm-01.example-org"),
        },
      ],
      organizations: [
        {
          slug: "Example Org",
          name: "Example Org",
          avatar: null,
          dashboard: "https://dashboard.lazurio.ai/orgs/example-org",
        },
        {
          slug: "example-org",
          name: "Example Org (second)",
          avatar: null,
          dashboard: "https://dashboard.lazurio.ai/orgs/example-org",
        },
      ],
    }),
  );
const ambiguousAccount = () =>
  account({
    environments: [
      accountDocument().environments[0],
      {
        id: "vm-01.example-org",
        kind: "team",
        label: "Sales",
        name: "Team Sales",
        who: "shared by the Team",
        offline: false,
        organizations: ["example-org"],
        assignee: null,
        apps: hosted("vm-01.example-org"),
      },
      {
        id: "vm-02.example-org",
        kind: "team",
        label: "Ops",
        name: "Team Ops",
        who: "shared by the Team",
        offline: false,
        organizations: ["example-org"],
        assignee: null,
        apps: hosted("vm-02.example-org"),
      },
    ],
    organizations: [
      {
        slug: "example-org",
        name: "Example Org",
        avatar: "https://avatars.githubusercontent.com/u/710101?v=4",
        dashboard: "https://dashboard.lazurio.ai/orgs/example-org",
      },
      accountDocument().organizations[1],
    ],
    lastBySpace: {
      "example-org": { environment: "vm-02.example-org", app: "chat" },
    },
    favourites: {},
  });

test("an ambiguous Dashboard slug: the local Organizations stay as they are, the account's of that slug and its Environments are left out", () => {
  const local = ambiguousLocal();
  const read = ambiguousAccount();
  const merged = mergeAccount(local, read);
  // No third space of that slug, no guess between the two local ones; the
  // account's other Organization still comes.
  expect(merged.organizations.map((entry) => entry.slug)).toEqual([
    "other-example",
    "Example Org",
    "example-org",
  ]);
  expect(merged.organizations[1]).toBe(local.organizations[0]);
  expect(merged.organizations[2]).toBe(local.organizations[1]);
  // The account's Environments of that slug are not placed under either
  // local Organization; this Environment stands as its document has it,
  // without the account's words.
  expect(merged.environments.map((entry) => entry.id)).toEqual([
    "vm-01.example-org",
    "ada",
  ]);
  expect(merged.environments[0]).toBe(local.environments[0]);
  expect(spaceEnvironments(merged, "example-org")).toEqual([]);
  expect(
    spaceEnvironments(merged, "Example Org").map((entry) => entry.id),
  ).toEqual(["vm-01.example-org"]);
  // The rail: one space per Organization entry, none twice, and no last
  // Environment from the account for the ambiguous slug.
  const last = accountLastBySpace(merged, read);
  expect(last.size).toBe(0);
  const spaces = railSpaces(merged, en, {
    here: "Example Org",
    app: "apps",
    last: (space) => last.get(space) ?? null,
  });
  expect(spaces.map((space) => space.space)).toEqual([
    "personal",
    "other-example",
    "Example Org",
    "example-org",
  ]);
  expect(new Set(spaces.map((space) => space.space)).size).toBe(spaces.length);
  expect(parseShell(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
});

test("two Organizations of the account that reduce to one Dashboard slug are left out the same way", () => {
  const document = accountDocument();
  const read = account({
    organizations: [
      ...document.organizations,
      {
        slug: "other_example",
        name: "Other Example (second)",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/other-example-2",
      },
    ],
  });
  const merged = mergeAccount(local, read);
  expect(merged.organizations.map((entry) => entry.slug)).toEqual(["Example"]);
});

test("an account-side ambiguous slug never lends its last Environment to the local Organization of that slug (Pablo's case)", () => {
  // A local Organization `Example` with two Environments, vm-01 first; the
  // account has two Organizations reducing to `example` and remembers vm-02
  // there, an id also present locally.
  const localTwo = parsed(
    localDocument({
      environments: [
        ...localDocument().environments,
        {
          id: "vm-02.example",
          label: "Ops",
          kind: "team",
          organizations: ["Example"],
          assignee: null,
          apps: hosted("vm-02.example"),
        },
      ],
    }),
  );
  const document = accountDocument();
  const read = account({
    environments: [
      {
        id: "vm-02.example",
        kind: "team",
        label: "Ops",
        name: "Team Ops",
        who: "shared by the Team",
        offline: false,
        organizations: ["example"],
        assignee: null,
        apps: hosted("vm-02.example"),
      },
    ],
    organizations: [
      document.organizations[0],
      {
        slug: "example!",
        name: "Example (second)",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/example-2",
      },
    ],
    last: {
      environment: "vm-02.example",
      app: "apps",
      organization: "example",
    },
    lastBySpace: { example: { environment: "vm-02.example", app: "apps" } },
    favourites: {},
  });
  const merged = mergeAccount(localTwo, read);
  // Both account Organizations and their Environment are left out; the
  // local ones stand as the local document has them.
  expect(merged.organizations).toEqual(localTwo.organizations);
  expect(merged.environments).toEqual(localTwo.environments);
  // No account last for that space, and the overall `last` is not carried
  // into the merged document at all (nothing in the shell reads it).
  expect(accountLastBySpace(merged, read).size).toBe(0);
  expect("last" in merged).toBe(false);
  // The rail's click falls through to the space's first local Environment.
  const last = accountLastBySpace(merged, read);
  const spaces = railSpaces(merged, en, {
    here: "personal",
    app: "apps",
    last: (space) => last.get(space) ?? null,
  });
  const example = spaces.find((space) => space.space === "Example");
  expect(example?.href).toBe("https://launchpad.vm-01.example.lazurio.io/");
  expect(example?.sub).toBe("2 Environments");
  // A local-side ambiguity is gated the same way, even when its last names
  // a local Environment.
  const localSide = ambiguousLocal();
  const localRead = account({
    environments: [accountDocument().environments[0]],
    organizations: [
      {
        slug: "example-org",
        name: "Example Org",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/example-org",
      },
    ],
    lastBySpace: { "example-org": { environment: "ada", app: "apps" } },
    favourites: {},
  });
  expect(
    accountLastBySpace(mergeAccount(localSide, localRead), localRead).size,
  ).toBe(0);
});

// Mixed languages (Pablo's review of #166): the Dashboard words `name` and
// `who` by the browser's language, the elements speak the profile's.

test("the account in another language: every Environment is named as without the account, in the local language; the structure stays", () => {
  const cs = shellMessages("cs");
  const czech = parsed(localDocument({ locale: "cs" }));
  const read = account({
    lastBySpace: { example: { environment: "vm-03.example", app: "chat" } },
  });
  expect(read.locale).toBe("en");
  const merged = mergeAccount(czech, read);
  expect(merged.locale).toBe("cs");
  for (const entry of merged.environments) {
    expect(entry.name).toBeUndefined();
    expect(entry.who).toBeUndefined();
  }
  const names = merged.environments.map((entry) => [
    entry.id,
    environmentName(entry, cs),
    environmentWho(entry, cs),
  ]);
  expect(names).toEqual([
    ["ada", "Osobní", "jen tvůj"],
    ["vm-01.example", "Sales", "sdílený Teamem"],
    ["vm-03.example", "Pracovní", "@ada"],
  ]);
  // Ids, apps, spaces and the last Environments are the account's as in the
  // same language.
  const same = mergeAccount(local, read);
  expect(merged.environments.map((entry) => [entry.id, entry.apps])).toEqual(
    same.environments.map((entry) => [entry.id, entry.apps]),
  );
  expect(merged.organizations).toEqual(same.organizations);
  expect([...accountLastBySpace(merged, read)]).toEqual([
    ["Example", "vm-03.example"],
  ]);
  // No English word of the account reaches the Czech picker.
  const sections = switcherSections(merged, cs, {
    here: "Example",
    all: true,
    app: "apps",
    query: "",
  });
  const shown = JSON.stringify(
    sections.flatMap((section) =>
      section.rows.map((row) => [row.name, row.who]),
    ),
  );
  expect(shown).not.toContain("shared by the Team");
  expect(shown).not.toContain("only yours");
  expect(shown).not.toContain("Team Sales");
});

test("the account in the local language: its words name the Environments", () => {
  const cs = shellMessages("cs");
  const czech = parsed(localDocument({ locale: "cs" }));
  const document = accountDocument({ locale: "cs" });
  const read = account({
    locale: "cs",
    environments: document.environments.map((entry, at) =>
      at === 1
        ? { ...entry, name: "Obchod", who: "sdílený Teamem" }
        : at === 2
          ? { ...entry, name: "Pracovní 2", who: "jen tvůj" }
          : { ...entry, name: "Osobní Ada", who: "jen tvůj" },
    ),
  });
  const merged = mergeAccount(czech, read);
  expect(
    merged.environments.map((entry) => [
      environmentName(entry, cs),
      environmentWho(entry, cs),
    ]),
  ).toEqual([
    ["Osobní Ada", "jen tvůj"],
    ["Obchod", "sdílený Teamem"],
    ["Pracovní 2", "jen tvůj"],
  ]);
});

// The read: once per page load, the fallback on every failure.

const answer = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("the account is read from the page's own origin, without a token, never following a sign-in", async () => {
  const seen: { path: string; init: RequestInit }[] = [];
  const lines: string[] = [];
  const value = await readAccountJson(
    async (path, init) => {
      seen.push({ path, init });
      return answer(200, accountDocument());
    },
    1_000,
    (line) => lines.push(line),
  );
  expect(parseShellAccount(value)).not.toBeNull();
  expect(lines).toEqual([]);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.path).toBe(accountDocumentPath);
  expect(seen[0]?.path).toBe("/.lazurio/account/environments");
  expect(seen[0]?.init.credentials).toBe("same-origin");
  expect(seen[0]?.init.cache).toBe("no-store");
  expect(seen[0]?.init.redirect).toBe("error");
  expect(new Headers(seen[0]?.init.headers).has("authorization")).toBe(false);
});

test("missing (404), refused (401, 403), failing, not JSON or invalid: no account, one debug line", async () => {
  for (const [response, reason] of [
    [answer(404, { error: "not-found" }), "404"],
    [answer(401, { error: "unauthorized" }), "401"],
    [answer(403, { error: "forbidden" }), "403"],
    [answer(502, "bad gateway"), "502"],
    [answer(200, "<!doctype html><title>Sign in</title>"), "not JSON"],
  ] as const) {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const read = await readShellAccount(
      () => readAccountJson(async () => response, 1_000, log),
      log,
    );
    expect(read).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(reason);
  }
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  expect(
    await readAccountJson(
      async () => {
        throw new TypeError("redirect");
      },
      1_000,
      log,
    ),
  ).toBeNull();
  expect(lines).toEqual([
    "Lazurio shell: no account (unreachable); the rail shows this Environment only.",
  ]);
  // A valid JSON answer that is no account document.
  const invalid: string[] = [];
  expect(
    await readShellAccount(
      async () => accountDocument({ schema: "lazurio.shell.v1" }),
      (line) => invalid.push(line),
    ),
  ).toBeNull();
  expect(invalid).toHaveLength(1);
  expect(
    await readShellAccount(
      async () => accountDocument(),
      () => {
        throw new Error("A valid document logs nothing");
      },
    ),
  ).not.toBeNull();
});

test("a slow account is given up after the timeout", async () => {
  let aborted = false;
  const lines: string[] = [];
  const started = Date.now();
  const value = await readAccountJson(
    (_path, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    50,
    (line) => lines.push(line),
  );
  expect(value).toBeNull();
  expect(aborted).toBe(true);
  expect(lines).toEqual([
    "Lazurio shell: no account (timeout); the rail shows this Environment only.",
  ]);
  expect(Date.now() - started).toBeLessThan(2_000);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("one request per page load: the rail and Apps share the page's answer", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return answer(200, accountDocument());
  }) as unknown as typeof fetch;
  const first = pageAccountJson();
  const second = pageAccountJson();
  expect(second).toBe(first);
  expect(parseShellAccount(await first)).not.toBeNull();
  await pageAccountJson();
  expect(requests).toBe(1);
});

// The remembered account (Matěj 2026-10-05: the rail took seconds to appear):
// only an Environment that belongs to one person keeps one, and only that
// person's; a refusal or no relay removes it, a slow or failed answer keeps
// it, and it holds only the members the parser reads.
const memoryStore = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};
const operatorOf = (login: string | null) => ({
  operator: {
    initials: login === null ? null : login.slice(0, 1).toUpperCase(),
    login,
    avatar: null,
  },
});
const quiet = () => {};

test("an Environment that belongs to one person keeps that person's account, and only theirs", () => {
  const store = memoryStore();
  const ada = account();
  expect(cachedAccountFor("ada", store)).toBeNull();
  rememberAccount(ada, "Ada", store);
  expect(cachedAccountFor("ada", store)).toEqual(ada);
  expect(cachedAccountFor("ADA", store)).toEqual(ada);
  expect(cachedAccountFor("bob", store)).toBeNull();
  expect(cachedAccountFor(null, store)).toBeNull();
  // Someone else's fresh answer on this origin removes it.
  rememberAccount(account(operatorOf("bob")), "ada", store);
  expect(store.values.has(accountCacheKey)).toBe(false);
  // An account that names no login is nobody's.
  rememberAccount(account(operatorOf(null)), "ada", store);
  expect(store.values.has(accountCacheKey)).toBe(false);
});

test("a shared Environment neither keeps nor shows one person's account to the next (two operators)", () => {
  // A Team Environment names no operator (shell-document.ts, `operatorLogin`).
  const store = memoryStore();
  rememberAccount(account(), null, store);
  expect(store.values.has(accountCacheKey)).toBe(false);
  // What an earlier release kept on such an origin is never shown either...
  store.values.set(accountCacheKey, JSON.stringify(accountDocument()));
  expect(cachedAccountFor(null, store)).toBeNull();
  // ...and the next person's fresh answer removes it.
  rememberAccount(account(operatorOf("bob")), null, store);
  expect(store.values.has(accountCacheKey)).toBe(false);
});

test("only the members the parser reads are kept, never anything else the answer carried", () => {
  const store = memoryStore();
  type Doc = Record<string, unknown> & {
    operator: Record<string, unknown>;
    environments: Record<string, unknown>[];
    organizations: Record<string, unknown>[];
  };
  const document = JSON.parse(
    JSON.stringify(
      accountDocument({
        token: "sentinel-top",
        last: {
          environment: "ada",
          app: "apps",
          organization: null,
          token: "sentinel-last",
        },
        lastBySpace: {
          personal: {
            environment: "ada",
            app: "chat",
            token: "sentinel-space",
          },
        },
        favourites: {
          example: [
            { kind: "module", id: "pricebook", token: "sentinel-favourite" },
          ],
        },
        preferences: { openApps: "same", token: "sentinel-preferences" },
      }),
    ),
  ) as Doc;
  document.operator.token = "sentinel-operator";
  const first = document.environments[0] as Record<string, unknown> & {
    apps: Record<string, unknown>;
  };
  first.token = "sentinel-environment";
  first.apps.token = "sentinel-apps";
  (document.organizations[0] as Record<string, unknown>).token =
    "sentinel-organization";
  const read = parseShellAccount(document);
  if (read === null) throw new Error("Expected a valid account document");
  rememberAccount(read, "ada", store);
  const kept = store.values.get(accountCacheKey) ?? "";
  expect(kept).not.toBe("");
  expect(kept).not.toContain("sentinel");
  expect(cachedAccountFor("ada", store)).toEqual(read);
});

test("reading keeps nothing; a refusal or no relay removes the remembered account, a slow or failed answer keeps it", async () => {
  const store = memoryStore();
  await readAccountJson(
    async () => answer(200, accountDocument()),
    1_000,
    quiet,
    store,
  );
  expect(store.values.has(accountCacheKey)).toBe(false);
  rememberAccount(account(), "ada", store);
  for (const failing of [answer(502, "bad gateway"), answer(504, "timeout")]) {
    await readAccountJson(async () => failing, 1_000, quiet, store);
    expect(cachedAccountFor("ada", store)).not.toBeNull();
  }
  await readAccountJson(
    async () => {
      throw new TypeError("network");
    },
    1_000,
    quiet,
    store,
  );
  expect(cachedAccountFor("ada", store)).not.toBeNull();
  for (const status of [401, 403, 404]) {
    rememberAccount(account(), "ada", store);
    await readAccountJson(
      async () => answer(status, { error: "x" }),
      1_000,
      quiet,
      store,
    );
    expect([status, cachedAccountFor("ada", store)]).toEqual([status, null]);
  }
  // A remembered value that no longer parses is dropped.
  store.values.set(accountCacheKey, "{not json");
  expect(cachedAccountFor("ada", store)).toBeNull();
  expect(store.values.has(accountCacheKey)).toBe(false);
});
