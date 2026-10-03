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
  folderLimit,
  initialsOf,
  jumpList,
  railModel,
  switchTabs,
} from "../src/shell/view";
import { folderFixture, writeOrganization } from "./fixtures/catalog-folder";
import {
  bindings,
  organizationWithEntry,
  personalWithEntry,
} from "./fixtures/machine-bindings";

// Decision F36: the Lazurio shell's data contract `lazurio.shell.v1`, its
// producer for what this Environment knows today, and the rail and switch
// as the elements draw them. Fixtures use example names only.

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

test("a workstation's document: this computer, every Organization of the Folder, Apps on its own origin, no Chat or Automate", () => {
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
    operator: { initials: null, login: null },
    environments: [
      {
        id: "local",
        label: null,
        kind: "workstation",
        organizations: ["alpha", "beta"],
        apps: { apps: "/", chat: null, automate: null },
      },
    ],
    organizations: [
      {
        slug: "alpha",
        name: "Alpha Example",
        accent: null,
        // The avatar of the bound login, never of the slug.
        avatar: "https://github.com/alpha-forge.png?size=96",
      },
      {
        slug: "beta",
        name: "Beta Example",
        accent: null,
        // No bound login: no avatar, the rail shows initials.
        avatar: null,
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/",
    account: "https://dashboard.lazurio.ai/settings",
  });
  // The rail: this computer is personal, so no folder; Organizations
  // without an Environment in the document have none.
  const rail = railModel(shell, cs);
  expect(rail.personal.map((entry) => [entry.label, entry.active])).toEqual([
    ["Tento počítač", true],
  ]);
  expect(rail.personal[0]?.mark).toEqual({ kind: "icon", icon: "laptop" });
  expect(rail.folders).toEqual([]);
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

test("a hosted work Environment: its Machine name, the assigned operator's initials, the entry's origins, one Organization folder with it active", () => {
  const machine = organizationWithEntry(20000, "workspace.example.lazurio.io");
  const shell = shellDocument({
    preset: "hosted-organization-personal",
    machine,
    locale: "en",
    catalog: catalog(organization("example")),
  });
  const [environment] = shell.environments;
  expect(environment?.kind).toBe("work");
  expect(environment?.label).toBe(machine.name);
  expect(shell.current).toBe(machine.name);
  expect(environment?.apps).toEqual({
    apps: "https://launchpad.workspace.example.lazurio.io/",
    chat: "https://t3code.workspace.example.lazurio.io/",
    automate: null,
  });
  const rail = railModel(shell, en);
  expect(rail.personal).toEqual([]);
  expect(rail.folders).toHaveLength(1);
  expect(rail.folders[0]?.hasActive).toBe(true);
  expect(rail.folders[0]?.items[0]?.sub).toBe(
    "Example Example · work · you are here",
  );
  expect(rail.folders[0]?.initials).toBe("EE");
  expect(switchTabs(shell, en, "apps").map((tab) => tab.href)).toEqual([
    "https://t3code.workspace.example.lazurio.io/",
    "https://launchpad.workspace.example.lazurio.io/",
    null,
  ]);
});

test("a personal Remote Environment carries its owner's initials and belongs to no Organization", () => {
  const machine = personalWithEntry();
  const shell = shellDocument({
    preset: "hosted-personal",
    machine,
    locale: "en",
    catalog: catalog(organization("example")),
  });
  expect(shell.environments[0]?.organizations).toEqual([]);
  expect(shell.operator.login).not.toBeNull();
  expect(shell.operator.initials).toBe(
    initialsOf(shell.operator.login ?? "").slice(0, 2),
  );
  const rail = railModel(shell, en);
  expect(rail.personal[0]?.mark).toEqual({
    kind: "initials",
    text: shell.operator.initials ?? "",
  });
  expect(rail.personal[0]?.sub).toStartWith(`@${shell.operator.login}`);
  expect(rail.folders).toEqual([]);
});

test("a Team Environment names no operator; a template or a duplicate slug is no Organization of the shell", () => {
  const shell = shellDocument({
    preset: "hosted-organization-team",
    machine: bindings.assignedTeam as MachineBinding,
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
  expect(shell.operator).toEqual({ initials: null, login: null });
  expect(shell.environments[0]?.kind).toBe("team");
  expect(shell.organizations.map((entry) => entry.slug)).toEqual(["example"]);
  expect(railModel(shell, en).folders[0]?.items[0]?.mark).toEqual({
    kind: "icon",
    icon: "users",
  });
});

test("the Automated Environment names its responsible operator", () => {
  const shell = shellDocument({
    preset: "hosted-organization-steward",
    machine: bindings.assignedOperator as MachineBinding,
    locale: "en",
    catalog: catalog(organization("example")),
  });
  expect(shell.environments[0]?.kind).toBe("automated");
  expect(shell.operator.login).toBe("example");
  expect(shell.operator.initials).toBe("EX");
});

// A document as the Dashboard will fill it: more Environments, several
// Organizations, the same elements.
const filled = (): Shell => {
  const value = parseShell({
    schema: "lazurio.shell.v1",
    locale: "en",
    current: "work-3",
    operator: { initials: "OP", login: "operator" },
    environments: [
      {
        id: "laptop",
        label: null,
        kind: "workstation",
        organizations: ["north"],
        apps: { apps: "/", chat: null, automate: null },
      },
      {
        id: "personal",
        label: "operator",
        kind: "personal",
        organizations: [],
        apps: {
          apps: "https://launchpad.operator.example.lazurio.io/",
          chat: "https://t3code.operator.example.lazurio.io/",
          automate: null,
        },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `work-${index}`,
        label: `vm-${index}`,
        kind: index === 0 ? "team" : "work",
        organizations: ["north"],
        apps: {
          apps: `https://launchpad.vm-${index}.north.example.lazurio.io/`,
          chat: null,
          automate: null,
        },
      })),
      {
        id: "south-1",
        label: "vm-1",
        kind: "automated",
        organizations: ["South"],
        apps: {
          apps: "https://launchpad.vm-1.south.example.lazurio.io/",
          chat: null,
          automate: "https://mausbot.vm-1.south.example.lazurio.io/",
        },
      },
    ],
    organizations: [
      { slug: "north", name: "North Example", accent: "#0b0eb4", avatar: null },
      {
        slug: "south",
        name: "South Example",
        accent: null,
        avatar: "https://avatars.example.invalid/south.png",
      },
    ],
    dashboard: "https://dashboard.example.invalid/",
    account: "https://dashboard.example.invalid/settings",
    // A member a later producer adds is ignored.
    buddy: { origin: "https://buddy.example.invalid" },
  });
  if (value === null) throw new Error("The fixture is a valid document");
  return value;
};

test("several Organizations: personal first, a folder each, six then +N, the active one always shown, less folds again", () => {
  const shell = filled();
  const rail = railModel(shell, en);
  expect(rail.personal.map((entry) => entry.id)).toEqual([
    "laptop",
    "personal",
  ]);
  expect(rail.folders.map((folder) => folder.organization.slug)).toEqual([
    "north",
    "south",
  ]);
  const [north, south] = rail.folders;
  // Six first, plus the active one further down; two folded behind +N.
  expect(north?.items.map((entry) => entry.id)).toEqual([
    ...Array.from({ length: folderLimit }, (_, index) => `work-${index}`),
  ]);
  expect(north?.hidden).toBe(2);
  expect(north?.items.find((entry) => entry.active)?.id).toBe("work-3");
  expect(north?.items[0]?.accent).toBe("#0b0eb4");
  expect(south?.items[0]?.mark).toEqual({ kind: "icon", icon: "bot" });
  const open = railModel(shell, en, new Set(["north"]));
  expect(open.folders[0]?.items).toHaveLength(8);
  expect(open.folders[0]?.hidden).toBe(0);
  expect(open.folders[0]?.expanded).toBe(true);
  // The jump list: every Environment, the current one first, filtered.
  expect(jumpList(shell, en, "")[0]?.id).toBe("work-3");
  expect(jumpList(shell, en, "")).toHaveLength(11);
  expect(jumpList(shell, en, "south").map((entry) => entry.id)).toEqual([
    "south-1",
  ]);
});

test("the parser refuses what the elements could not draw safely", () => {
  const valid = JSON.parse(JSON.stringify(filled())) as Record<string, unknown>;
  const variant = (change: (value: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    change(copy);
    return parseShell(copy);
  };
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
    variant((value) => {
      const [first] = value.environments as Record<string, unknown>[];
      if (first)
        first.apps = {
          apps: "//other.example.invalid/",
          chat: null,
          automate: null,
        };
    }),
  ).toBeNull();
  expect(
    variant((value) => {
      const [first] = value.environments as Record<string, unknown>[];
      if (first)
        first.apps = {
          apps: "/",
          chat: "https://user:secret@t3.example.invalid/",
          automate: null,
        };
    }),
  ).toBeNull();
  // The accent is a colour, never CSS.
  expect(
    variant((value) => {
      const [first] = value.organizations as Record<string, unknown>[];
      if (first) first.accent = "red; background: url(x)";
    }),
  ).toBeNull();
  // Every Organization an Environment names is listed, each id once.
  expect(
    variant((value) => {
      const [first] = value.environments as Record<string, unknown>[];
      if (first) first.organizations = ["east"];
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
    variant((value) => {
      const [first] = value.environments as Record<string, unknown>[];
      if (first) first.kind = "server";
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
      // No avatar of any slug: every avatar is a bound login's.
      for (const entry of shell.organizations)
        expect(entry.avatar).toBe(
          `https://github.com/${
            read.organizations.find(
              (candidate) => candidate.organization === entry.slug,
            )?.forgeLogin
          }.png?size=96`,
        );
    });
  },
  30_000,
);
