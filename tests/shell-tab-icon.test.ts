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
  type IconRenderer,
  iconSourceUrl,
  LAZURIO_TAB_ICON,
  type RenderedIcon,
  tabIconFor,
} from "../src/shell/tab-icon";

// F36's addendum of 2026-10-08: the browser tab of Apps, Chat and Automate
// carries the icon of the Organization the Environment belongs to, else
// Lazurio's symbol; a page that belongs to no Environment keeps its own. The
// icon is the image drawn into PNG, so Safari, which keeps an icon by its URL,
// shows an Organization's new avatar (a GitHub avatar never changes its URL).

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

test("the icon's image is read from GitHub's avatar host at the touch icon's size", () => {
  // The Dashboard's avatar keeps its id and version and gets a size.
  expect(iconSourceUrl("https://avatars.githubusercontent.com/u/1?v=4")).toBe(
    "https://avatars.githubusercontent.com/u/1?v=4&s=180",
  );
  // The Launchpad's own avatar of a login: github.com only redirects, without
  // letting the page read the image, so the avatar host directly.
  expect(iconSourceUrl("https://github.com/example-org.png?size=96")).toBe(
    "https://avatars.githubusercontent.com/example-org?s=180",
  );
  // Anything else as it is, Lazurio's symbol included.
  expect(iconSourceUrl("https://example.com/logo.png")).toBe(
    "https://example.com/logo.png",
  );
  expect(iconSourceUrl(LAZURIO_TAB_ICON)).toBe(LAZURIO_TAB_ICON);
});

type Link = {
  id: string;
  rel: string;
  href: string;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
};

/** A document with the app's own icon links, as the forks have. */
const fakeDocument = () => {
  const links: Link[] = [];
  const make = (id = "", rel = "", href = ""): Link => {
    const link: Link = {
      id,
      rel,
      href,
      attributes: new Map(),
      setAttribute: (name, value) => link.attributes.set(name, value),
      removeAttribute: (name) => link.attributes.delete(name),
      remove: () => {
        const at = links.indexOf(link);
        if (at >= 0) links.splice(at, 1);
      },
    };
    return link;
  };
  links.push(make("", "icon", "/favicon.ico"));
  links.push(make("", "icon", "/favicon-32.png"));
  links.push(make("", "apple-touch-icon", "/apple-touch-icon.png"));
  const doc: IconDocument = {
    querySelectorAll: () => [...links],
    getElementById: (id) => links.find((link) => link.id === id) ?? null,
    createElement: () => make(),
    head: { append: (node) => links.push(node as Link) },
  };
  const shown = () =>
    links.map((link) => [
      link.id,
      link.rel,
      link.href,
      Object.fromEntries(link.attributes),
    ]);
  return { doc, links, shown };
};

/** A renderer that draws each image as the server has it now. */
const drawing = (image: () => string) => {
  const asked: string[] = [];
  const render: IconRenderer = async (source) => {
    asked.push(source);
    const bytes = image();
    return {
      tab: `data:image/png;base64,${bytes}-32`,
      touch: `data:image/png;base64,${bytes}-180`,
    };
  };
  return { render, asked };
};

test("the Organization's avatar shows as PNG in the tab and as the touch icon, in place of the app's own", async () => {
  const { doc, shown } = fakeDocument();
  const { render, asked } = drawing(() => "LOGO");
  await createTabIcon(doc, render)(shellOf("vm-01.example"));
  expect(asked).toEqual([
    "https://avatars.githubusercontent.com/u/1?v=4&s=180",
  ]);
  expect(shown()).toEqual([
    [
      "lazurio-tab-icon",
      "icon",
      "data:image/png;base64,LOGO-32",
      { type: "image/png", sizes: "32x32" },
    ],
    [
      "lazurio-touch-icon",
      "apple-touch-icon",
      "data:image/png;base64,LOGO-180",
      { sizes: "180x180" },
    ],
  ]);
});

test("a new avatar under the same URL gives the tab a new icon on the next page load", async () => {
  // The regression: GitHub keeps an avatar's URL when the Organization
  // uploads its logo, and Safari kept the default avatar it had under that
  // URL. The icon's URL is now the image itself.
  let image = "DEFAULT-AVATAR";
  const { render } = drawing(() => image);
  const before = fakeDocument();
  await createTabIcon(before.doc, render)(shellOf("vm-01.example"));
  image = "UPLOADED-LOGO";
  const after = fakeDocument();
  await createTabIcon(after.doc, render)(shellOf("vm-01.example"));
  const hrefs = (links: Link[]) => links.map((link) => link.href);
  expect(hrefs(before.links)).toEqual([
    "data:image/png;base64,DEFAULT-AVATAR-32",
    "data:image/png;base64,DEFAULT-AVATAR-180",
  ]);
  expect(hrefs(after.links)).toEqual([
    "data:image/png;base64,UPLOADED-LOGO-32",
    "data:image/png;base64,UPLOADED-LOGO-180",
  ]);
});

test("the same icon is not drawn again, and a drawing overtaken by another icon is dropped", async () => {
  const { doc, links } = fakeDocument();
  const asked: string[] = [];
  const pending = new Map<string, (icon: RenderedIcon) => void>();
  const render: IconRenderer = (source) => {
    asked.push(source);
    return new Promise((resolve) => pending.set(source, resolve));
  };
  const apply = createTabIcon(doc, render);
  const first = apply(shellOf("vm-01.example"));
  // Until it is drawn the page keeps its own icons.
  expect(links.map((link) => link.href)).toEqual([
    "/favicon.ico",
    "/favicon-32.png",
    "/apple-touch-icon.png",
  ]);
  void apply(shellOf("vm-01.example"));
  const second = apply(shellOf("vm-01.example", "work", null));
  expect(asked).toEqual([
    "https://avatars.githubusercontent.com/u/1?v=4&s=180",
    LAZURIO_TAB_ICON,
  ]);
  pending.get(LAZURIO_TAB_ICON)?.({
    tab: "data:image/png;base64,LAZURIO-32",
    touch: "data:image/png;base64,LAZURIO-180",
  });
  await second;
  pending.get("https://avatars.githubusercontent.com/u/1?v=4&s=180")?.({
    tab: "data:image/png;base64,LATE-32",
    touch: "data:image/png;base64,LATE-180",
  });
  await first;
  expect(links.map((link) => link.href)).toEqual([
    "data:image/png;base64,LAZURIO-32",
    "data:image/png;base64,LAZURIO-180",
  ]);
  // The Dashboard's document changes nothing.
  await apply(shellOf(null));
  expect(links).toHaveLength(2);
  // Without a document nothing happens.
  await expect(
    createTabIcon(null, render)(shellOf("vm-01.example")),
  ).resolves.toBeUndefined();
});

test("A, then B, then A again: the first A's drawing, finishing last, never replaces the newest", async () => {
  const { doc, links } = fakeDocument();
  const AVATAR = "https://avatars.githubusercontent.com/u/1?v=4&s=180";
  // Every request is its own drawing, settled by hand in any order.
  const requests: { source: string; resolve: (icon: RenderedIcon) => void }[] =
    [];
  const render: IconRenderer = (source) =>
    new Promise((resolve) => requests.push({ source, resolve }));
  const apply = createTabIcon(doc, render);
  const firstA = apply(shellOf("vm-01.example"));
  const b = apply(shellOf("vm-01.example", "work", null));
  const secondA = apply(shellOf("vm-01.example"));
  expect(requests.map((request) => request.source)).toEqual([
    AVATAR,
    LAZURIO_TAB_ICON,
    AVATAR,
  ]);
  const [oldA, lazurio, newA] = requests;
  if (!oldA || !lazurio || !newA) throw new Error("three drawings");
  // The newest A is drawn first: the avatar as the server has it now.
  newA.resolve({
    tab: "data:image/png;base64,NEW-32",
    touch: "data:image/png;base64,NEW-180",
  });
  await secondA;
  // B and then the first A finish late, the first A with the old image.
  lazurio.resolve({
    tab: "data:image/png;base64,LAZURIO-32",
    touch: "data:image/png;base64,LAZURIO-180",
  });
  await b;
  oldA.resolve({
    tab: "data:image/png;base64,OLD-32",
    touch: "data:image/png;base64,OLD-180",
  });
  await firstA;
  expect(links.map((link) => link.href)).toEqual([
    "data:image/png;base64,NEW-32",
    "data:image/png;base64,NEW-180",
  ]);
});

test("an icon that cannot be drawn is linked by its URL, Lazurio's SVG without a touch icon", async () => {
  const failed: IconRenderer = async () => {
    throw new Error("blocked");
  };
  const avatarPage = fakeDocument();
  await createTabIcon(avatarPage.doc, failed)(shellOf("vm-01.example"));
  expect(avatarPage.shown()).toEqual([
    ["lazurio-tab-icon", "icon", avatar, {}],
    ["lazurio-touch-icon", "apple-touch-icon", avatar, { sizes: "180x180" }],
  ]);
  const symbolPage = fakeDocument();
  await createTabIcon(
    symbolPage.doc,
    async () => null,
  )(shellOf("example-person", "personal"));
  expect(symbolPage.shown()).toEqual([
    ["lazurio-tab-icon", "icon", LAZURIO_TAB_ICON, {}],
  ]);
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
