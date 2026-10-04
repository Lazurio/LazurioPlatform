import { expect, test } from "bun:test";
import type { MachineBinding } from "../src/folder/machine-binding";
import { shellDocument } from "../src/launchpad/shell-document";
import {
  type Catalog,
  type CatalogOrganization,
  readFolderCatalog,
} from "../src/organizations/catalog";
import { parseShell, type Shell } from "../src/shell/contract";
import { shellMessages } from "../src/shell/messages";
import {
  environmentHref,
  environmentName,
  environmentWho,
  hereOf,
  initialsOf,
  railSpaces,
  spaceEnvironments,
  switcherSections,
  switchTabs,
} from "../src/shell/view";
import { folderFixture, writeOrganization } from "./fixtures/catalog-folder";
import {
  bindings,
  organizationWithEntry,
  personalWithEntry,
} from "./fixtures/machine-bindings";

// Decision F36 and its addendum of 2026-10-04: the Lazurio shell's data
// contract `lazurio.shell.v1`, its producer for what this Environment knows
// today, and the rail of Organizations, the Environment picker and the
// switch as the elements draw them. Fixtures use example names only.

const organization = (
  slug: string,
  extra: Partial<CatalogOrganization> = {},
): CatalogOrganization => ({
  directory: `${slug}_GEN3`,
  organization: slug,
  displayName: `${slug[0]?.toUpperCase()}${slug.slice(1)} Example`,
  state: "current",
  issues: [],
  executable: true,
  teams: [],
  modules: [],
  repositories: [],
  ...extra,
});
const catalog = (...organizations: CatalogOrganization[]): Catalog => ({
  kind: "catalog",
  organizations,
});
const en = shellMessages("en");
const cs = shellMessages("cs");
const noLast = () => null;

test("a workstation's document: this computer, every Organization of the Folder with its Dashboard, Apps on its own origin", () => {
  const shell = shellDocument({
    preset: "local",
    machine: null,
    locale: "cs",
    // alpha's manifest binds it to another GitHub login than its slug; beta
    // binds none.
    catalog: catalog(
      organization("alpha", { forgeLogin: "alpha-forge" }),
      organization("beta"),
    ),
  });
  expect(shell).toEqual({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: "local",
    operator: { initials: null, login: null, avatar: null },
    environments: [
      {
        id: "local",
        label: null,
        kind: "workstation",
        organizations: ["alpha", "beta"],
        assignee: null,
        apps: { apps: "/", chat: null, automate: null },
      },
    ],
    organizations: [
      {
        slug: "alpha",
        name: "Alpha Example",
        // The avatar of the bound login, never of the slug.
        avatar: "https://github.com/alpha-forge.png?size=96",
        dashboard: "https://dashboard.lazurio.ai/orgs/alpha",
      },
      {
        slug: "beta",
        name: "Beta Example",
        // No bound login: no avatar, the rail shows initials.
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/beta",
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/",
    account: "https://dashboard.lazurio.ai/settings",
    addOrganization: "https://dashboard.lazurio.ai/add-organization",
  });
  const current = shell.environments[0];
  if (current === undefined) throw new Error("The document has one");
  expect(environmentName(current, cs)).toBe("Tento počítač");
  expect(environmentWho(current, cs)).toBe("tento počítač");
  // Named by its computer when the host name is known, never by a hosted
  // machine's name.
  const named = shellDocument({
    preset: "local",
    machine: null,
    locale: "cs",
    catalog: catalog(),
    computer: "Example-MacBook.local",
  });
  expect(named.environments[0]?.label).toBe("Example-MacBook");
  expect(
    shellDocument({
      preset: "local",
      machine: null,
      locale: "cs",
      catalog: catalog(),
      computer: "not a host",
    }).environments[0]?.label,
  ).toBeNull();
  expect(
    shellDocument({
      preset: "hosted-organization-personal",
      machine: organizationWithEntry(),
      locale: "cs",
      catalog: catalog(),
      computer: "Example-MacBook.local",
    }).environments[0]?.label,
  ).toBeNull();
  // On its own the workstation is personal; opened for an Organization it
  // stands in that Organization's space, Apps scoped to it.
  expect(hereOf(shell, null)).toBe("personal");
  expect(hereOf(shell, "BETA")).toBe("beta");
  expect(environmentHref(current, "beta", "apps")).toBe("/o/beta");
  expect(environmentHref(current, "personal", "apps")).toBe("/");
  // The rail: your space, then each Organization; the space a click on
  // Beta leads to is this computer opened for Beta.
  const spaces = railSpaces(shell, cs, {
    here: "beta",
    app: "apps",
    last: noLast,
  });
  expect(
    spaces.map((space) => [space.space, space.href, space.active, space.sub]),
  ).toEqual([
    ["personal", "/", false, "1 Environment"],
    ["alpha", "/o/alpha", false, "1 Environment"],
    ["beta", "/o/beta", true, "1 Environment"],
  ]);
  expect(spaces[1]?.avatar).toBe("https://github.com/alpha-forge.png?size=96");
  expect(spaces[2]?.initials).toBe("BE");
  // The switch: Apps on this origin, the two others disabled with a reason.
  expect(
    switchTabs(shell, cs, "apps").map((tab) => [
      tab.app,
      tab.href,
      tab.active,
      tab.missing,
    ]),
  ).toEqual([
    ["chat", null, false, "Chat na tomto Environmentu neběží"],
    ["apps", "/", true, null],
    ["automate", null, false, "MausBot na tomto Environmentu neběží"],
  ]);
});

test("a hosted work Environment is named by its kind and its person, never by its machine; its Organization's space is the active one", () => {
  const machine = organizationWithEntry(20000, "workspace.example.lazurio.io");
  const shell = shellDocument({
    preset: "hosted-organization-personal",
    machine,
    locale: "en",
    catalog: catalog(organization("example", { forgeLogin: "example" })),
  });
  const [environment] = shell.environments;
  if (environment === undefined) throw new Error("The document has one");
  expect(environment.kind).toBe("work");
  // The machine's name is the id the document keys it by, never a label.
  expect(environment.id).toBe(machine.name);
  expect(environment.label).toBeNull();
  expect(environmentName(environment, cs)).toBe("Pracovní");
  expect(environment.apps).toEqual({
    apps: "https://launchpad.workspace.example.lazurio.io/",
    chat: "https://t3code.workspace.example.lazurio.io/",
    automate: null,
  });
  expect(hereOf(shell, null)).toBe("example");
  const spaces = railSpaces(shell, en, {
    here: "example",
    app: "chat",
    last: noLast,
  });
  // Your personal space has no Environment here: its Dashboard.
  expect(
    spaces.map((space) => [space.space, space.href, space.active]),
  ).toEqual([
    ["personal", "https://dashboard.lazurio.ai/", false],
    // A click stays in the app the rail sits in (Chat).
    ["example", "https://t3code.workspace.example.lazurio.io/", true],
  ]);
  // The picker's list: the Organization's head (its Dashboard), then its
  // Environments, the current one marked.
  const [section] = switcherSections(shell, cs, {
    here: "example",
    all: false,
    app: "apps",
    query: "",
  });
  expect(section?.head?.href).toBe("https://dashboard.lazurio.ai/orgs/example");
  expect(section?.rows.map((row) => [row.name, row.who, row.current])).toEqual([
    ["Pracovní", "pracovní", true],
  ]);
});

test("an assigned work Environment says whose it is; an Automated one is its persona's; a Team one its Team's", () => {
  const work = shellDocument({
    preset: "hosted-organization-personal",
    machine: bindings.assignedOperator as MachineBinding,
    locale: "en",
    catalog: catalog(organization("example")),
  });
  expect(work.environments[0]?.assignee).toBe("example");
  const [assigned] = work.environments;
  if (assigned === undefined) throw new Error("The document has one");
  expect(environmentWho(assigned, cs)).toBe("@example");
  // The Team the binding names, by its display name in the catalog of the
  // Organization that owns the Environment.
  const teams = catalog(
    organization("example", {
      forgeLogin: "example",
      teams: [{ slug: "sample-team", displayName: "Sample" }],
    }),
  );
  const team = shellDocument({
    preset: "hosted-organization-team",
    machine: bindings.assignedTeam as MachineBinding,
    locale: "en",
    catalog: teams,
  });
  expect(team.operator).toEqual({ initials: null, login: null, avatar: null });
  expect(team.environments[0]?.label).toBe("Team Sample");
  expect(team.environments[0]?.assignee).toBeNull();
  const [shared] = team.environments;
  if (shared === undefined) throw new Error("The document has one");
  expect(environmentWho(shared, cs)).toBe("sdílený Teamem");
  const automated = shellDocument({
    preset: "hosted-organization-steward",
    machine: bindings.automated as MachineBinding,
    locale: "en",
    catalog: catalog(
      organization("example", {
        forgeLogin: "example",
        teams: [{ slug: "sample-team", displayName: "Steward" }],
      }),
    ),
  });
  expect(automated.environments[0]?.kind).toBe("automated");
  expect(automated.environments[0]?.label).toBe("Steward");
  expect(automated.operator.login).toBe("example");
  // A Team the catalog does not know: named by its kind.
  const unknown = shellDocument({
    preset: "hosted-organization-team",
    machine: bindings.assignedTeam as MachineBinding,
    locale: "en",
    catalog: catalog(organization("example")),
  });
  expect(unknown.environments[0]?.label).toBeNull();
});

test("a personal Remote Environment carries its owner's initials and photo and belongs to no Organization", () => {
  const shell = shellDocument({
    preset: "hosted-personal",
    machine: personalWithEntry(),
    locale: "en",
    catalog: catalog(organization("example")),
  });
  expect(shell.environments[0]?.organizations).toEqual([]);
  expect(shell.operator.login).toBe("example");
  expect(shell.operator.initials).toBe("EX");
  expect(shell.operator.avatar).toBe("https://github.com/example.png?size=96");
  expect(hereOf(shell, null)).toBe("personal");
  const [personal] = switcherSections(shell, en, {
    here: "personal",
    all: false,
    app: "apps",
    query: "",
  });
  expect(personal?.rows[0]?.glyph).toEqual({ kind: "initials", text: "EX" });
  expect(personal?.rows[0]?.name).toBe("Personal");
});

test("a template or a duplicate slug is no Organization of the shell", () => {
  const shell = shellDocument({
    preset: "local",
    machine: null,
    locale: "en",
    catalog: catalog(
      organization("example"),
      organization("starter", {
        executable: false,
        reason: "template-not-runtime",
      }),
      organization("twin", {
        executable: false,
        reason: "organization-duplicate",
      }),
      organization("broken", { organization: null, displayName: null }),
    ),
  });
  expect(shell.organizations.map((entry) => entry.slug)).toEqual(["example"]);
});

// A document as the Dashboard will fill it: more Environments, several
// Organizations, the same elements.
const filled = (): Shell => {
  const value = parseShell({
    schema: "lazurio.shell.v1",
    locale: "en",
    current: "work-3",
    operator: {
      initials: "OP",
      login: "operator",
      avatar: "https://avatars.example.invalid/operator.png",
    },
    environments: [
      {
        id: "laptop",
        label: null,
        kind: "workstation",
        organizations: ["north"],
        assignee: null,
        apps: { apps: "/", chat: null, automate: null },
      },
      {
        id: "personal",
        label: null,
        kind: "personal",
        organizations: [],
        assignee: null,
        apps: {
          apps: "https://launchpad.operator.example.lazurio.io/",
          chat: "https://t3code.operator.example.lazurio.io/",
          automate: null,
        },
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `work-${index}`,
        label: index === 0 ? "Team North" : null,
        kind: index === 0 ? "team" : "work",
        organizations: ["north"],
        assignee: index === 0 ? null : `person-${index}`,
        apps: {
          apps: `https://launchpad.vm-${index}.north.example.lazurio.io/`,
          chat: null,
          automate: null,
        },
      })),
      {
        id: "south-1",
        label: "Steward",
        kind: "automated",
        organizations: ["South"],
        assignee: null,
        apps: {
          apps: "https://launchpad.vm-1.south.example.lazurio.io/",
          chat: null,
          automate: "https://mausbot.vm-1.south.example.lazurio.io/",
        },
      },
    ],
    organizations: [
      {
        slug: "north",
        name: "North Example",
        avatar: null,
        dashboard: "https://dashboard.example.invalid/orgs/north",
      },
      {
        slug: "south",
        name: "South Example",
        avatar: "https://avatars.example.invalid/south.png",
        dashboard: "https://dashboard.example.invalid/orgs/south",
      },
    ],
    dashboard: "https://dashboard.example.invalid/",
    account: "https://dashboard.example.invalid/settings",
    addOrganization: null,
    // A member a later producer adds is ignored.
    buddy: { origin: "https://buddy.example.invalid" },
  });
  if (value === null) throw new Error("The fixture is a valid document");
  return value;
};

test("several Organizations: a space's Environments, its last one remembered, the picker's list widened to all, filtered", () => {
  const shell = filled();
  expect(hereOf(shell, null)).toBe("north");
  expect(spaceEnvironments(shell, "north").map((entry) => entry.id)).toEqual([
    "work-0",
    "work-1",
    "work-2",
    "work-3",
    "laptop",
  ]);
  expect(spaceEnvironments(shell, "personal").map((entry) => entry.id)).toEqual(
    ["laptop", "personal"],
  );
  // A click on a space: the last Environment this browser was in there,
  // else its first; in Automate an Environment without it opens Apps.
  const spaces = railSpaces(shell, en, {
    here: "north",
    app: "automate",
    last: (space) => (space === "north" ? "work-2" : null),
  });
  expect(spaces.map((space) => [space.space, space.href, space.sub])).toEqual([
    ["personal", "/", "2 Environments"],
    [
      "north",
      "https://launchpad.vm-2.north.example.lazurio.io/",
      "5 Environments · last Work",
    ],
    [
      "south",
      "https://mausbot.vm-1.south.example.lazurio.io/",
      "1 Environment",
    ],
  ]);
  // The list under the picker: this space only.
  const one = switcherSections(shell, en, {
    here: "north",
    all: false,
    app: "apps",
    query: "",
  });
  expect(one.map((section) => section.space)).toEqual(["north"]);
  expect(
    one[0]?.rows.map((row) => [row.id, row.name, row.who, row.current]),
  ).toEqual([
    ["work-0", "Team North", "shared by the Team", false],
    ["work-1", "Work", "@person-1", false],
    ["work-2", "Work", "@person-2", false],
    ["work-3", "Work", "@person-3", true],
    ["laptop", "This computer", "this computer", false],
  ]);
  // "All Organizations" (and ⌘⇧E): every space, each Organization with its
  // head; a query keeps what matches.
  const all = switcherSections(shell, en, {
    here: "north",
    all: true,
    app: "apps",
    query: "",
  });
  expect(all.map((section) => [section.space, section.head !== null])).toEqual([
    ["personal", false],
    ["north", true],
    ["south", true],
  ]);
  const found = switcherSections(shell, en, {
    here: "north",
    all: true,
    app: "apps",
    query: "steward",
  });
  expect(
    found.map((section) => [section.space, section.rows.map((row) => row.id)]),
  ).toEqual([["south", ["south-1"]]]);
  expect(
    switcherSections(shell, en, {
      here: "north",
      all: true,
      app: "apps",
      query: "nothing like that",
    }),
  ).toEqual([]);
});

test("the parser refuses what the elements could not draw safely", () => {
  const valid = JSON.parse(JSON.stringify(filled())) as Record<string, unknown>;
  const variant = (change: (value: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    change(copy);
    return parseShell(copy);
  };
  const first = (value: Record<string, unknown>, key: string) =>
    (value[key] as Record<string, unknown>[])[0] as Record<string, unknown>;
  expect(parseShell(valid)).not.toBeNull();
  expect(variant((value) => (value.schema = "lazurio.shell.v2"))).toBeNull();
  expect(variant((value) => (value.current = "missing"))).toBeNull();
  expect(variant((value) => (value.locale = "de"))).toBeNull();
  // Only https outside the document's own origin; never script or credentials.
  expect(
    variant((value) => (value.dashboard = "javascript:alert(1)")),
  ).toBeNull();
  expect(
    variant((value) => (value.account = "http://dashboard.example.invalid/")),
  ).toBeNull();
  expect(
    variant((value) => (value.addOrganization = "/add-organization")),
  ).toBeNull();
  expect(
    variant((value) => {
      first(value, "environments").apps = {
        apps: "//other.example.invalid/",
        chat: null,
        automate: null,
      };
    }),
  ).toBeNull();
  expect(
    variant((value) => {
      first(value, "environments").apps = {
        apps: "/",
        chat: "https://user:secret@t3.example.invalid/",
        automate: null,
      };
    }),
  ).toBeNull();
  expect(
    variant((value) => {
      first(value, "organizations").dashboard = "javascript:alert(1)";
    }),
  ).toBeNull();
  expect(
    variant((value) => {
      first(value, "environments").assignee = "not a login";
    }),
  ).toBeNull();
  // Every Organization an Environment names is listed, each id once.
  expect(
    variant((value) => {
      first(value, "environments").organizations = ["east"];
    }),
  ).toBeNull();
  expect(
    variant((value) => {
      const environments = value.environments as unknown[];
      environments.push(environments[0]);
    }),
  ).toBeNull();
  expect(
    variant(
      (value) => ((value.operator as Record<string, unknown>).initials = "<b>"),
    ),
  ).toBeNull();
  expect(
    variant(
      (value) =>
        ((value.operator as Record<string, unknown>).avatar = "data:image/png"),
    ),
  ).toBeNull();
  expect(
    variant((value) => {
      first(value, "environments").kind = "server";
    }),
  ).toBeNull();
});

test("initials: first letters of two words, else two letters", () => {
  expect(initialsOf("North Example")).toBe("NE");
  expect(initialsOf("example")).toBe("EX");
  expect(initialsOf("north-example")).toBe("NE");
  expect(initialsOf("Č")).toBe("Č");
});

test.skipIf(process.platform === "win32")(
  "the avatar names the GitHub login the manifest binds, not the slug, read from a real Folder",
  async () => {
    await folderFixture(async (folder) => {
      await writeOrganization(folder, "north_GEN3", {
        slug: "north",
        forge: "north-forge-login",
        state: "current",
        modules: [{ id: "orders" }],
      });
      const read = await readFolderCatalog(folder);
      const north = read.organizations.find(
        (entry) => entry.organization === "north",
      );
      expect(north?.forgeLogin).toBe("north-forge-login");
      const shell = shellDocument({
        preset: "local",
        machine: null,
        locale: "en",
        catalog: read,
      });
      expect(
        shell.organizations.find((entry) => entry.slug === "north")?.avatar,
      ).toBe("https://github.com/north-forge-login.png?size=96");
    });
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "an Organization whose slug is not a GitHub login keeps its place in the rail and the picker, read from a real Folder",
  async () => {
    await folderFixture(async (folder) => {
      // A canonical slug the manifest admits but a login never could
      // (underscore, dot), bound to a different GitHub login.
      await writeOrganization(folder, "alpha_internal_GEN3", {
        slug: "alpha_internal.v2",
        forge: "alpha-forge",
        state: "current",
        modules: [{ id: "orders" }],
      });
      const read = await readFolderCatalog(folder);
      const entry = read.organizations.find(
        (candidate) => candidate.organization === "alpha_internal.v2",
      );
      expect(entry?.executable).toBe(true);
      const shell = shellDocument({
        preset: "local",
        machine: null,
        locale: "en",
        catalog: read,
      });
      const organization = shell.organizations.find(
        (candidate) => candidate.slug === "alpha_internal.v2",
      );
      expect(organization?.avatar).toBe(
        "https://github.com/alpha-forge.png?size=96",
      );
      expect(organization?.dashboard).toBe(
        "https://dashboard.lazurio.ai/orgs/alpha_internal.v2",
      );
      // The workstation holds it, so the picker of its space lists it.
      expect(shell.environments[0]?.organizations).toContain(
        "alpha_internal.v2",
      );
      expect(parseShell(JSON.parse(JSON.stringify(shell)))).not.toBeNull();
    });
  },
  30_000,
);
