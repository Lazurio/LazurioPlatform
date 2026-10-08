import { expect, test } from "bun:test";
import {
  parseShell,
  parseShellSignedOut,
  type Shell,
} from "../src/shell/contract";
import { createShellState } from "../src/shell/state";
import {
  createTabIcon,
  type IconDocument,
  LAZURIO_TAB_ICON,
  tabIconFor,
} from "../src/shell/tab-icon";

// F36's addendum of 2026-10-08: the browser tab of Apps, Chat and Automate
// carries the icon of the Organization the Environment belongs to, else
// Lazurio's symbol; a page that belongs to no Environment keeps its own.

const avatar = "https://avatars.githubusercontent.com/u/1?v=4";

const shellOf = (
  current: string | null,
  kind = "work",
  orgAvatar: string | null = avatar,
): Shell => {
  const apps =
    kind === "workstation"
      ? { apps: "/", chat: null, automate: null }
      : {
          apps: `https://launchpad.${current}.lazurio.io/`,
          chat: `https://t3code.${current}.lazurio.io/`,
          automate: null,
        };
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current,
    operator: { initials: "MS", login: "example-person", avatar: null },
    environments:
      current === null
        ? []
        : [
            {
              id: current,
              label: null,
              kind,
              organizations:
                kind === "personal" || kind === "workstation"
                  ? []
                  : ["example"],
              assignee: null,
              apps,
            },
          ],
    organizations: [
      {
        slug: "example",
        name: "Example",
        avatar: orgAvatar,
        dashboard: "https://dashboard.lazurio.ai/orgs/example",
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/home",
    account: "https://dashboard.lazurio.ai/settings/account",
    addOrganization: null,
  });
  if (shell === null) throw new Error("invalid fixture");
  return shell;
};

test("an Organization's Environment carries the Organization's avatar", () => {
  expect(tabIconFor(shellOf("vm-01.example"))).toBe(avatar);
  expect(tabIconFor(shellOf("vm-01.example", "team"))).toBe(avatar);
});

test("Lazurio's symbol without an avatar, on a personal Environment and on a workstation", () => {
  expect(tabIconFor(shellOf("vm-01.example", "work", null))).toBe(
    LAZURIO_TAB_ICON,
  );
  expect(tabIconFor(shellOf("example-person", "personal"))).toBe(
    LAZURIO_TAB_ICON,
  );
  expect(tabIconFor(shellOf("local", "workstation"))).toBe(LAZURIO_TAB_ICON);
  expect(LAZURIO_TAB_ICON.startsWith("data:image/svg+xml")).toBe(true);
});

test("a page that belongs to no Environment keeps its own icon", () => {
  expect(tabIconFor(shellOf(null))).toBeNull();
});

/** A document with the app's own icon links, as the forks have. */
const fakeDocument = () => {
  type Link = { id: string; rel: string; href: string; remove(): void };
  const links: Link[] = [];
  const add = (id: string, href: string) => {
    const link: Link = {
      id,
      rel: "icon",
      href,
      remove: () => links.splice(links.indexOf(link), 1),
    };
    links.push(link);
    return link;
  };
  add("", "/favicon.ico");
  add("", "/favicon-32.png");
  const doc: IconDocument = {
    querySelectorAll: () => [...links],
    getElementById: (id) => links.find((link) => link.id === id) ?? null,
    createElement: () => ({ id: "", rel: "", href: "" }),
    head: {
      append: (node) => {
        const link = node as Link;
        link.remove = () => links.splice(links.indexOf(link), 1);
        links.push(link);
      },
    },
  };
  return { doc, links };
};

test("the shell's icon replaces the app's own icons, follows a change and is not rewritten when the same", () => {
  const { doc, links } = fakeDocument();
  const apply = createTabIcon(doc);
  apply(shellOf("vm-01.example"));
  expect(links.map((link) => [link.id, link.href])).toEqual([
    ["lazurio-tab-icon", avatar],
  ]);
  const icon = links[0];
  if (icon === undefined) throw new Error("no icon");
  apply(shellOf("vm-01.example"));
  expect(links).toEqual([icon]);
  apply(shellOf("vm-01.example", "work", null));
  expect(links.map((link) => link.href)).toEqual([LAZURIO_TAB_ICON]);
  // The Dashboard's document changes nothing.
  apply(shellOf(null));
  expect(links.map((link) => link.href)).toEqual([LAZURIO_TAB_ICON]);
  // Without a document nothing happens.
  expect(() => createTabIcon(null)(shellOf("vm-01.example"))).not.toThrow();
});

test("the shell's state sets the icon with a person's document, never with the signed-out one", () => {
  const asked: (string | null)[] = [];
  const state = createShellState({
    source: () => "origin",
    read: async () => null,
    report: () => undefined,
    store: null,
    log: () => undefined,
    tabIcon: (shell) => asked.push(shell.current),
  });
  const signedOut = parseShellSignedOut({
    schema: "lazurio.shell-signed-out.v1",
    locale: "cs",
    signIn: "https://dashboard.lazurio.ai/sign-in",
  });
  if (signedOut === null) throw new Error("invalid fixture");
  state.provideShell(signedOut);
  expect(asked).toEqual([]);
  state.provideShell(shellOf("vm-01.example"));
  expect(asked).toEqual(["vm-01.example"]);
});
