import { expect, test } from "bun:test";
import { parseShell, type Shell } from "../src/shell/contract";
import { shellMessages } from "../src/shell/messages";
import { hostTokens, railWidth } from "../src/shell/styles";
import {
  type SwitcherKind,
  switcherKey,
  switcherList,
} from "../src/shell/view";

// F36's addendum of 2026-10-06: the rail and the Environment picker as Anička
// revised them in the shell wireframe (prototypes-lazurio #11, #14, #15,
// #17) and the design system (design-system-lazurio #57, #58, #59, #62). The
// list under the picker is one line per Environment of the space you are in,
// without the Organization's head and with a search field only past seven
// Environments; its foot holds only "Všechny Organizace". The jump to any
// Environment (⌘⇧E) keeps the Organization's heads and the key hints. The
// keys work with or without the field. Example names only.

const cs = shellMessages("cs");
const en = shellMessages("en");

const hosted = (
  machine: string,
  slug: string,
  kind: "team" | "work" | "automated",
  name: string,
) => ({
  id: `${machine}.${slug}`,
  label: null,
  kind,
  organizations: [slug],
  assignee: null,
  name,
  apps: {
    apps: `https://launchpad.${machine}.${slug}.lazurio.io/`,
    chat: `https://t3code.${machine}.${slug}.lazurio.io/`,
    automate: null,
  },
});

/** An Environment's page in the Organization `orbit`, which holds `count`
 * Environments, the current one the third (the first of fewer); `acme`
 * holds one and `empty` none. */
function document(count: number, extra: Record<string, unknown> = {}): Shell {
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: count >= 3 ? "vm-03.orbit" : "vm-01.orbit",
    operator: { initials: "AB", login: "example", avatar: null },
    environments: [
      {
        id: "example",
        label: null,
        kind: "personal",
        organizations: [],
        assignee: null,
        apps: {
          apps: "https://launchpad.example.lazurio.io/",
          chat: null,
          automate: null,
        },
      },
      ...Array.from({ length: count }, (_, at) =>
        hosted(
          `vm-${String(at + 1).padStart(2, "0")}`,
          "orbit",
          at === 0 ? "team" : "work",
          at === 0 ? "Team Orbit" : `Pracovní ${at + 1}`,
        ),
      ),
      hosted("vm-01", "acme", "automated", "Steward"),
    ],
    organizations: [
      {
        slug: "orbit",
        name: "Orbit Example",
        avatar: null,
        dashboard: "https://dashboard.example.invalid/orgs/orbit",
      },
      {
        slug: "acme",
        name: "Acme Example",
        avatar: null,
        dashboard: "https://dashboard.example.invalid/orgs/acme",
      },
      {
        slug: "empty",
        name: "Empty Example",
        avatar: null,
        dashboard: "https://dashboard.example.invalid/orgs/empty",
      },
    ],
    dashboard: "https://dashboard.example.invalid/home",
    account: "https://dashboard.example.invalid/settings/account",
    addOrganization: null,
    ...extra,
  });
  if (shell === null) throw new Error("The fixture is a valid document");
  return shell;
}

const list = (
  shell: Shell,
  kind: SwitcherKind,
  options: Partial<{
    here: string | null;
    widened: boolean;
    query: string;
    locale: "cs" | "en";
  }> = {},
) =>
  switcherList(shell, options.locale === "en" ? en : cs, {
    kind,
    here: options.here === undefined ? "orbit" : options.here,
    widened: options.widened ?? false,
    app: "apps",
    query: options.query ?? "",
  });

test("the picker lists the space's Environments one line each, without the Organization's head or a title, the current one marked", () => {
  const picker = list(document(5), "picker");
  expect(picker.sections).toHaveLength(1);
  const [section] = picker.sections;
  expect([section?.space, section?.title, section?.head]).toEqual([
    "orbit",
    null,
    null,
  ]);
  expect(
    section?.rows.map((row) => [row.name, row.who, row.glyph, row.current]),
  ).toEqual([
    ["Team Orbit", "sdílený Teamem", { kind: "icon", icon: "users" }, false],
    ["Pracovní 2", "pracovní", { kind: "icon", icon: "user" }, false],
    ["Pracovní 3", "pracovní", { kind: "icon", icon: "user" }, true],
    ["Pracovní 4", "pracovní", { kind: "icon", icon: "user" }, false],
    ["Pracovní 5", "pracovní", { kind: "icon", icon: "user" }, false],
  ]);
  // No Environment and no line leads to the Organization's Dashboard.
  expect(
    section?.rows.some((row) => row.href.startsWith("https://dashboard.")),
  ).toBe(false);
  expect([section?.empty, picker.nothing]).toEqual([null, null]);
  // The cursor starts on the current Environment.
  expect(picker.start).toBe(2);
});

test("the picker has a search field only past seven Environments in its space", () => {
  for (const count of [1, 5, 7])
    expect([count, list(document(count), "picker").search]).toEqual([
      count,
      null,
    ]);
  expect(list(document(8), "picker").search).toBe("Hledat v Orbit Example…");
  expect(list(document(12), "picker", { locale: "en" }).search).toBe(
    "Search in Orbit Example…",
  );
  // Other spaces do not count: the personal space holds one.
  expect(list(document(12), "picker", { here: "personal" }).search).toBeNull();
  // Past seven the cursor still starts on the current Environment, until a
  // search starts it on the first match.
  expect(list(document(8), "picker").start).toBe(2);
  const searched = list(document(8), "picker", { query: "pracovní" });
  expect(searched.start).toBe(0);
  expect(searched.sections[0]?.rows.map((row) => row.name)).toEqual([
    "Pracovní 2",
    "Pracovní 3",
    "Pracovní 4",
    "Pracovní 5",
    "Pracovní 6",
    "Pracovní 7",
    "Pracovní 8",
  ]);
});

test("the picker's foot holds only Všechny Organizace; widened, the search field and the groups by space appear, still without heads, and no foot", () => {
  const picker = list(document(5), "picker");
  expect([picker.widen, picker.hints]).toEqual(["Všechny Organizace", []]);
  const widened = list(document(5), "picker", { widened: true });
  expect(widened.search).toBe("Environment nebo Organizace…");
  expect([widened.widen, widened.hints]).toEqual([null, []]);
  // Every space with Environments, each under its name; the empty
  // Organization has nothing to pick and no head to show.
  expect(
    widened.sections.map((section) => [
      section.space,
      section.title,
      section.head,
      section.rows.length,
    ]),
  ).toEqual([
    ["personal", "Osobní", null, 1],
    ["orbit", "Orbit Example", null, 5],
    ["acme", "Acme Example", null, 1],
  ]);
  // Widened, the cursor starts on the first entry.
  expect(widened.start).toBe(0);
});

test("the jump to any Environment keeps the Organization's heads, the search field and the key hints", () => {
  const jump = list(document(5), "jump");
  expect(jump.search).toBe("Environment nebo Organizace…");
  expect(jump.widen).toBeNull();
  expect(jump.hints).toEqual([
    { key: "↑↓", word: "vybrat" },
    { key: "Enter", word: "přejít" },
    { key: "Esc", word: "zavřít" },
  ]);
  expect(
    jump.sections.map((section) => [
      section.space,
      section.title,
      section.head === null
        ? null
        : [section.head.organization.name, section.head.href],
      section.rows.length,
      section.empty,
    ]),
  ).toEqual([
    ["personal", "Osobní", null, 1, null],
    [
      "orbit",
      null,
      ["Orbit Example", "https://dashboard.example.invalid/orgs/orbit"],
      5,
      null,
    ],
    [
      "acme",
      null,
      ["Acme Example", "https://dashboard.example.invalid/orgs/acme"],
      1,
      null,
    ],
    [
      "empty",
      null,
      ["Empty Example", "https://dashboard.example.invalid/orgs/empty"],
      0,
      "Tady nemáš žádný Environment.",
    ],
  ]);
  // The rows are the picker's one-line rows; the current one marked.
  expect(jump.sections[1]?.rows).toEqual(
    list(document(5), "picker").sections[0]?.rows ?? [],
  );
  expect(jump.start).toBe(0);
  // A head that does not match a search goes; its Environments that match
  // stay under the Organization's name.
  const found = list(document(5), "jump", { query: "steward" });
  expect(
    found.sections.map((section) => [
      section.space,
      section.title,
      section.head,
      section.rows.map((row) => row.name),
    ]),
  ).toEqual([["acme", "Acme Example", null, ["Steward"]]]);
});

test("an Organization's Dashboard without an Environment: the picker says so and offers Všechny Organizace", () => {
  const shell = document(5, { current: null });
  const picker = list(shell, "picker", { here: "empty" });
  expect(
    picker.sections.map((section) => [
      section.space,
      section.head,
      section.rows,
      section.empty,
    ]),
  ).toEqual([["empty", null, [], "Tady nemáš žádný Environment."]]);
  expect([picker.search, picker.nothing, picker.widen, picker.start]).toEqual([
    null,
    null,
    "Všechny Organizace",
    0,
  ]);
  // On the Dashboard of an Organization with Environments none is current
  // and the cursor starts on the first.
  const orbit = list(shell, "picker");
  expect(orbit.sections[0]?.rows.some((row) => row.current)).toBe(false);
  expect(orbit.start).toBe(0);
});

test("the keys work without the search field: arrows wrap, Home and End, Enter opens, Escape closes", () => {
  const entry = (cursor: number) =>
    ({ cursor, count: 5, focus: "entry" }) as const;
  expect(switcherKey("ArrowDown", entry(2))).toEqual({
    kind: "move",
    cursor: 3,
  });
  expect(switcherKey("ArrowUp", entry(2))).toEqual({ kind: "move", cursor: 1 });
  expect(switcherKey("ArrowDown", entry(4))).toEqual({
    kind: "move",
    cursor: 0,
  });
  expect(switcherKey("ArrowUp", entry(0))).toEqual({ kind: "move", cursor: 4 });
  expect(switcherKey("Home", entry(3))).toEqual({ kind: "move", cursor: 0 });
  expect(switcherKey("End", entry(1))).toEqual({ kind: "move", cursor: 4 });
  expect(switcherKey("Enter", entry(3))).toEqual({ kind: "open" });
  expect(switcherKey("Escape", entry(3))).toEqual({ kind: "close" });
  // Typing and Tab are not the list's.
  for (const key of ["a", "Tab", " ", "PageDown"])
    expect([key, switcherKey(key, entry(1))]).toEqual([key, null]);
  // A cursor past the list (it shrank) moves from its last entry.
  expect(switcherKey("ArrowDown", { ...entry(9), count: 3 })).toEqual({
    kind: "move",
    cursor: 0,
  });
});

test("in the search field Home and End move the caret; on another control only Escape is the list's", () => {
  const field = (cursor: number) =>
    ({ cursor, count: 5, focus: "field" }) as const;
  expect(switcherKey("ArrowDown", field(0))).toEqual({
    kind: "move",
    cursor: 1,
  });
  expect(switcherKey("Enter", field(0))).toEqual({ kind: "open" });
  expect(switcherKey("Home", field(3))).toBeNull();
  expect(switcherKey("End", field(3))).toBeNull();
  // "Všechny Organizace" keeps Enter, Space and the arrows.
  const other = { cursor: 0, count: 5, focus: "other" } as const;
  for (const key of ["Enter", " ", "ArrowDown", "Home"])
    expect([key, switcherKey(key, other)]).toEqual([key, null]);
  expect(switcherKey("Escape", other)).toEqual({ kind: "close" });
  // An empty list has nothing to move to or open, and still closes.
  const empty = { cursor: 0, count: 0, focus: "field" } as const;
  for (const key of ["ArrowDown", "ArrowUp", "Enter"])
    expect([key, switcherKey(key, empty)]).toEqual([key, null]);
  expect(switcherKey("Escape", empty)).toEqual({ kind: "close" });
});

test("the rail is one step of the design system's grid: 64 px, the width it sets as --lazurio-rail-width", () => {
  const step = /--lz-grid-step:\s*([^;]+);/.exec(hostTokens)?.[1]?.trim();
  expect(step).toBe("64px");
  expect(railWidth).toBe(step ?? "");
});
