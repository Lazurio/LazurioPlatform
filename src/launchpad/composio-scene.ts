import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// The drawing of Composio's dashboard in the sign-in dialog (decision F42,
// addendum (2) of 2026-10-13, note of 2026-10-17): where the person creates
// the organization of their Organization's name, as the design system's
// guide pattern draws a step (a drawing of the real screen, the cursor
// "Vy"/"You" going through it, the places numbered in `--lz-blue-500`, the
// finished state under `prefers-reduced-motion`). Plain elements placed in
// units on a stage that scales with its width; the motion is CSS
// (index.html, `.composio-scene`), so it ends with the dialog. Two light
// screens, never a copy of Composio's screens or its logo: a simplified
// sidebar whose card at the bottom is the person's own (their name and
// current organization), the menu it opens with "Organization" on top, the
// list of organizations that row opens, then the page "Create Org" opens
// (`/create-workspace`), a card centred under the heading "Composio". The
// menu is a step of its own since the end-to-end test of 2026-10-19: the
// drawing went from a card straight to the list.

/** Composio's own words on the screens the drawing shows, in English as its
 * dashboard writes them whatever the page's language: the one place to match
 * against the real screens (the Organization Admin's screenshots of
 * 2026-10-17: the sidebar's list, and the page "Create Org" opens; the
 * end-to-end test's of 2026-10-19: the person's menu). The person and the
 * organizations of the drawn account are fictional; the current one is
 * last. */
export const composioScreen = {
  forYou: "FOR YOU",
  switch: "Switch",
  person: "Jana",
  organization: "Organization",
  logOut: "Log out",
  findOrg: "Find Org...",
  createOrg: "Create Org",
  createOrgNote: "Collaborate with others in a shared workspace",
  heading: "Composio",
  createTitle: "Create Organization",
  createSubtitle: "Set up a new workspace for your team",
  nameLabel: "Organization name",
  namePlaceholder: "my_organization",
  nameHint:
    "Must start with a letter. Only letters, numbers, and underscores allowed.",
  create: "Create organization",
  back: "← Back",
  organizations: ["Acme", "Northwind", "jana_workspace"],
} as const;

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const svgNamespace = "http://www.w3.org/2000/svg";
/** A small drawn glyph: `paths` in a 24-unit box, stroked. */
function glyph(className: string, paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  for (const d of paths) {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}
// Iconoir's nav-arrow-down, its up/down pair, check, search, plus and
// log-out.
const chevronDown = ["M6 9L12 15L18 9"];
const upDown = ["M17 8L12 3L7 8", "M17 16L12 21L7 16"];
const check = ["M5 13L9 17L19 7"];
const search = [
  "M17 17L21 21",
  "M3 11C3 15.4183 6.58172 19 11 19C13.213 19 15.2161 18.1015 16.6644 16.6493C18.1077 15.2022 19 13.2053 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11Z",
];
const plus = ["M6 12H12M18 12H12M12 12V6M12 12V18"];
const logOut = [
  "M12 12H19M19 12L16 15M19 12L16 9",
  "M19 6V5C19 3.89543 18.1046 3 17 3H7C5.89543 3 5 3.89543 5 5V19C5 20.1046 5.89543 21 7 21H17C18.1046 21 19 20.1046 19 19V18",
];

/** The person's cursor of the design system's guide: the orchid arrow with
 * its tag. */
function cursor(copy: Copy): HTMLElement {
  const holder = element("span", "cs-cursor");
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", "cs-arrow");
  svg.setAttribute("viewBox", "0 0 17 18");
  const path = document.createElementNS(svgNamespace, "path");
  path.setAttribute(
    "d",
    "M19.5027 9.96958C20.7073 10.4588 20.6154 12.1941 19.3658 12.5533L13.0605 14.3658L10.1807 20.2606C9.60996 21.4288 7.88499 21.218 7.6124 19.9468L4.67677 6.25646C4.44638 5.18204 5.5121 4.2878 6.53019 4.70126L19.5027 9.96958Z",
  );
  path.setAttribute("transform", "translate(-4.2 -4.2)");
  svg.append(path);
  holder.append(svg, element("span", "cs-you", copy.toolsComposioSceneYou));
  return holder;
}

function avatar(name: string, tone: number): HTMLElement {
  const node = element("span", "cs-avatar", name.charAt(0).toUpperCase());
  node.dataset.tone = String(tone);
  return node;
}

function marker(step: number): HTMLElement {
  const node = element("span", "cs-marker", String(step));
  node.dataset.step = String(step);
  return node;
}

/** The number of the drawing's last place, where the name is typed in: the
 * dialog's name box carries it too. */
export const composioNameStep = 5;

/** What the drawing shows, in words: its places in their order. */
export function composioSceneLabel(copy: Copy, name: string): string {
  return fill(copy.toolsComposioScene, {
    forYou: composioScreen.forYou,
    organization: composioScreen.organization,
    createOrg: composioScreen.createOrg,
    name,
    create: composioScreen.create,
  });
}

/** The drawing; `name` is the name of this Environment's Organization as
 * Composio accepts it (`composioOrganizationName`), the one typed into the
 * field and the only value in it that is not Composio's or fictional, set as
 * text. */
export function composioScene(copy: Copy, name: string): HTMLElement {
  const scene = element("div", "composio-scene");
  scene.setAttribute("role", "img");
  scene.setAttribute("aria-label", composioSceneLabel(copy, name));
  const stage = element("div", "cs-stage");
  stage.setAttribute("aria-hidden", "true");

  const current =
    composioScreen.organizations[composioScreen.organizations.length - 1] ?? "";
  const side = element("div", "cs-side");
  const top = element("div", "cs-top");
  const chip = element("span", "cs-chip", composioScreen.forYou);
  const switcher = element("span", "cs-switch", composioScreen.switch);
  switcher.append(glyph("cs-glyph", chevronDown));
  top.append(element("span", "cs-mark"), chip, switcher);
  const nav = element("div", "cs-nav");
  for (let index = 0; index < 5; index += 1)
    nav.append(element("span", "cs-line"));
  // The person's own card: their name and the organization current now.
  const tone = composioScreen.organizations.length - 1;
  const account = element("div", "cs-org");
  const words = element("span", "cs-org-words");
  words.append(
    element("span", "cs-name", composioScreen.person),
    element("span", "cs-small", current),
  );
  account.append(
    avatar(composioScreen.person, tone),
    words,
    glyph("cs-glyph", upDown),
  );
  side.append(top, nav, account);

  // The menu the card opens: "Organization" with the current one on top,
  // which opens the list, and "Log out".
  const menu = element("div", "cs-menu");
  const menuOrganization = element("div", "cs-menu-org");
  const menuWords = element("span", "cs-org-words");
  menuWords.append(
    element("span", "cs-small", composioScreen.organization),
    element("span", "cs-name", current),
  );
  menuOrganization.append(
    avatar(current, tone),
    menuWords,
    glyph("cs-glyph", upDown),
  );
  const out = element("div", "cs-menu-out");
  out.append(
    glyph("cs-glyph", logOut),
    element("span", "", composioScreen.logOut),
  );
  menu.append(menuOrganization, element("span", "cs-divider"), out);

  const main = element("div", "cs-main");
  for (let index = 0; index < 3; index += 1)
    main.append(element("span", "cs-block"));

  const popover = element("div", "cs-pop");
  const find = element("div", "cs-find");
  find.append(
    glyph("cs-glyph", search),
    element("span", "", composioScreen.findOrg),
  );
  const list = element("div", "cs-list");
  composioScreen.organizations.forEach((entry, index) => {
    const row = element("div", "cs-row");
    row.append(avatar(entry, index), element("span", "cs-name", entry));
    if (entry === current) {
      row.classList.add("is-current");
      row.append(glyph("cs-glyph cs-check", check));
    }
    list.append(row);
  });
  const create = element("div", "cs-create");
  const createTitle = element("span", "cs-create-title");
  createTitle.append(
    glyph("cs-glyph", plus),
    element("span", "", composioScreen.createOrg),
  );
  create.append(
    createTitle,
    element("span", "cs-small", composioScreen.createOrgNote),
  );
  popover.append(find, list, element("span", "cs-divider"), create);

  // The dashboard with the places 1 to 4; "Create Org" opens a page of its
  // own, which takes its place: the card with the field (5) and its button.
  const dashboard = element("div", "cs-dash");
  dashboard.append(
    side,
    main,
    menu,
    popover,
    marker(1),
    marker(2),
    marker(3),
    marker(4),
  );

  const page = element("div", "cs-page");
  const card = element("div", "cs-card");
  const field = element("div", "cs-field");
  field.append(
    element("span", "cs-placeholder", composioScreen.namePlaceholder),
    element("span", "cs-typed", name),
  );
  card.append(
    element("span", "cs-card-title", composioScreen.createTitle),
    element("span", "cs-small cs-card-note", composioScreen.createSubtitle),
    element("span", "cs-label", composioScreen.nameLabel),
    field,
    element("span", "cs-small cs-hint", composioScreen.nameHint),
    element("span", "cs-confirm", composioScreen.create),
    element("span", "cs-small cs-back", composioScreen.back),
  );
  page.append(
    element("span", "cs-heading", composioScreen.heading),
    card,
    marker(composioNameStep),
  );

  stage.append(dashboard, page, cursor(copy));
  scene.append(stage);
  return scene;
}

/** The numbered place of the Organization's name in the dialog, the same
 * number as the field it belongs in on the drawing. */
export function composioStepMarker(step: number): HTMLElement {
  const node = marker(step);
  node.classList.add("cs-marker-inline");
  node.setAttribute("aria-hidden", "true");
  return node;
}
