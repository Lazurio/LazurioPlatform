import { currentEnvironment, parseShell, type Shell } from "./contract";
import { installShellFonts } from "./fonts";
import { icon } from "./icons";
import { appOf, reportLast } from "./last";
import { fillShell, type ShellCopy, shellMessages } from "./messages";
import { columnHeadCss, railCss, railWidth } from "./styles";
import { vendorText } from "./vendor-text" with { type: "macro" };
import {
  environmentGlyph,
  environmentName,
  environmentWho,
  hereOf,
  initialsOf,
  railSpaces,
  type ShellApp,
  type SwitcherSection,
  shellApps,
  switcherSections,
  switchTabs,
} from "./view";

// The Lazurio shell as framework-free custom elements (decision F36,
// addendum of 2026-10-04): `<lazurio-rail>` (level 1: the logo to the
// Dashboard, the jump to an Environment, your personal space, one avatar per
// Organization, the account) and `<lazurio-column-head>` (the head of an
// app's left column: the Environment picker with the gear of this
// Environment's Settings beside it, then the switch Chat · Apps · Automate).
// Each draws into its own shadow root, so neither the host's styles nor these
// leak across. The panel below the head stays the app's own.
// `<lazurio-buddy>` is reserved for Buddy's bubble (decision 0180) and not
// defined here.
//
// Data: the `lazurio.shell.v1` document. A host that has it calls
// `provideShell`; otherwise the elements read `/.lazurio/shell.json` on
// their own origin once (the forks). A host that provides it marks
// `<html data-lazurio-shell="host">` so nothing is fetched twice.
//
// Attributes: `app` on the rail (`chat`, `apps`, `automate`: a click on a
// space stays in that app), `space` on both (the space you are in, when the
// host knows it better than the document: a workstation opened for one
// Organization), `active` (`chat`, `apps`, `automate` or `settings`) and
// `settings` (the Settings address) on the head.
//
// Events, both cancelable and composed, so a host can take a click over:
// `lazurio-navigate` (detail `{ href }`) for a link on the document's own
// origin, and `lazurio-app` (detail `{ app, href }`) for a switch tab.
// Without a listener that cancels them, the links simply navigate.

const logo = vendorText("symbol-color.svg");

let current: Shell | null = null;
const listeners = new Set<() => void>();
let requested = false;

/** Gives the elements their document; they redraw. */
export function provideShell(shell: Shell): void {
  current = shell;
  for (const listener of listeners) listener();
}

function requestShell(): void {
  if (
    requested ||
    current !== null ||
    document.documentElement.dataset.lazurioShell === "host"
  )
    return;
  requested = true;
  fetch("/.lazurio/shell.json", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((value: unknown) => {
      const shell = parseShell(value);
      if (shell !== null) provideShell(shell);
    })
    .catch(() => undefined);
}

// Where you last were in each space, in this browser: a click on a space in
// the rail returns there. Only Environment ids of the document are kept.
const lastKey = "lazurio.shell.last";
function lastBySpace(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(lastKey) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}
function remember(space: string, environment: string) {
  try {
    const last = lastBySpace();
    if (last[space] === environment) return;
    localStorage.setItem(
      lastKey,
      JSON.stringify({ ...last, [space]: environment }),
    );
  } catch {}
}

const sameOrigin = (href: string) =>
  href.startsWith("/") && !href.startsWith("//");

const plainClick = (event: MouseEvent) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An Organization's avatar, or its initials when there is none or it does
 * not load. */
function organizationMark(
  avatar: string | null,
  initials: string,
): HTMLSpanElement {
  const mark = element("span", "org-mark");
  const fallback = () => mark.replaceChildren(initials);
  if (avatar === null) fallback();
  else {
    const image = element("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.src = avatar;
    image.addEventListener("error", fallback, { once: true });
    mark.append(image);
  }
  return mark;
}

abstract class ShellElement extends HTMLElement {
  protected readonly root: ShadowRoot;
  private readonly redraw = () => this.render();
  constructor(css: string) {
    super();
    this.root = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    this.root.adoptedStyleSheets = [sheet];
  }
  connectedCallback() {
    listeners.add(this.redraw);
    requestShell();
    this.render();
  }
  disconnectedCallback() {
    listeners.delete(this.redraw);
  }
  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }
  protected copy(shell: Shell): ShellCopy {
    const lang = this.getAttribute("lang");
    return shellMessages(lang === "cs" || lang === "en" ? lang : shell.locale);
  }
  protected here(shell: Shell): string {
    return hereOf(shell, this.getAttribute("space"));
  }
  protected app(): ShellApp {
    const app = this.getAttribute("app");
    return (shellApps as readonly string[]).includes(app ?? "")
      ? (app as ShellApp)
      : "apps";
  }
  /** A link the host may take over: same-origin links announce
   * `lazurio-navigate` before they navigate. */
  link(href: string, className: string): HTMLAnchorElement {
    const anchor = element("a", className);
    anchor.href = href;
    if (sameOrigin(href))
      anchor.addEventListener("click", (event) => {
        if (!plainClick(event)) return;
        const announced = this.dispatchEvent(
          new CustomEvent("lazurio-navigate", {
            detail: { href },
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
        if (!announced) event.preventDefault();
      });
    return anchor;
  }
  protected abstract render(): void;
}

/** The list of Environments, as a popover under the picker (one space,
 * widened by "Všechny Organizace") or as the ⌘⇧E dialog (every space). */
class Switcher {
  readonly box = element("div", "switcher-box");
  private readonly input = element("input");
  private readonly list = element("div", "switcher-list");
  private readonly foot = element("div", "switcher-foot");
  private query = "";
  private cursor = 0;
  private links: HTMLAnchorElement[] = [];
  constructor(
    private readonly host: ShellElement,
    private readonly shell: Shell,
    private readonly copy: ShellCopy,
    private readonly options: {
      here: string;
      app: ShellApp;
      all: boolean;
      popover: boolean;
      close: () => void;
    },
  ) {
    const search = element("label", "switcher-search");
    this.input.type = "search";
    this.input.setAttribute("aria-label", copy.switcher);
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.cursor = 0;
      this.fill();
    });
    this.input.addEventListener("keydown", (event) => this.key(event));
    search.append(
      icon("search", 16),
      this.input,
      element("span", "kbd", "⌘⇧E"),
    );
    this.box.setAttribute("role", "dialog");
    this.box.setAttribute("aria-label", copy.switcher);
    this.box.append(search, this.list, this.foot);
    this.fill();
  }
  focus() {
    this.input.focus();
  }
  private key(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.options.close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = this.links.length;
      if (count === 0) return;
      this.cursor =
        (this.cursor + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      this.mark();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.links[this.cursor]?.click();
    }
  }
  private mark() {
    for (const [index, link] of this.links.entries())
      link.classList.toggle("is-cursor", index === this.cursor);
    this.links[this.cursor]?.scrollIntoView({ block: "nearest" });
  }
  private fill() {
    const copy = this.copy;
    const options = this.options;
    const sections = switcherSections(this.shell, copy, {
      here: options.here,
      all: options.all,
      app: options.app,
      query: this.query,
    });
    const scope = sections[0]?.title ?? copy.personal;
    this.input.placeholder = options.all
      ? copy.searchAll
      : fillShell(copy.searchIn, { name: scope });
    this.links = [];
    this.list.replaceChildren(
      ...sections.map((section) => this.section(section)),
    );
    if (this.links.length === 0 && (options.all || this.query.trim() !== ""))
      this.list.append(element("p", "switcher-empty", copy.nothing));
    this.cursor = Math.min(this.cursor, Math.max(0, this.links.length - 1));
    this.mark();
    const hints: Node[] = [];
    if (!options.all) {
      const widen = element("button", "switcher-widen");
      widen.type = "button";
      widen.append(icon("globe", 14), copy.widen);
      widen.addEventListener("click", () => {
        options.all = true;
        this.cursor = 0;
        this.fill();
        this.input.focus();
      });
      hints.push(widen);
    }
    const hint = (key: string, word: string) => {
      const span = element("span");
      span.append(element("span", "kbd", key), ` ${word}`);
      return span;
    };
    hints.push(hint("↑↓", copy.choose), hint("Enter", copy.go));
    if (!options.popover) hints.push(hint("Esc", copy.close));
    this.foot.replaceChildren(...hints);
  }
  private track(link: HTMLAnchorElement) {
    const at = this.links.length;
    this.links.push(link);
    link.addEventListener("mouseenter", () => {
      this.cursor = at;
      this.mark();
    });
    link.addEventListener("click", () => this.options.close());
    return link;
  }
  private section(section: SwitcherSection): HTMLElement {
    const copy = this.copy;
    const group = element("div", "switcher-group");
    if (section.head !== null) {
      const { organization, href } = section.head;
      const head = this.track(this.host.link(href, "switcher-head"));
      head.append(
        organizationMark(organization.avatar, initialsOf(organization.name)),
        element("span", "", organization.name),
        element("span", "switcher-head-meta", copy.organizationDashboard),
      );
      group.append(head);
    } else group.append(element("div", "switcher-title", section.title));
    for (const row of section.rows) {
      const link = this.track(this.host.link(row.href, "switcher-row"));
      if (row.current) link.setAttribute("aria-current", "page");
      const glyph = element("span", "switcher-glyph");
      if (row.glyph.kind === "initials") glyph.textContent = row.glyph.text;
      else glyph.append(icon(row.glyph.icon, 16));
      link.append(
        glyph,
        element("span", "switcher-name", row.name),
        element("span", "switcher-who", row.who),
      );
      if (row.current) {
        const here = element("span", "switcher-here");
        here.append(icon("check", 14), copy.here);
        link.append(here);
      }
      group.append(link);
    }
    if (
      section.head !== null &&
      section.rows.length === 0 &&
      this.query.trim() === ""
    )
      group.append(element("p", "switcher-empty", copy.noEnvironment));
    return group;
  }
}

// One rail at a time answers ⌘⇧E / Ctrl+Shift+E: the last one connected.
let jumpTarget: LazurioRail | null = null;
let shortcutInstalled = false;
function installShortcut() {
  if (shortcutInstalled) return;
  shortcutInstalled = true;
  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      !event.shiftKey ||
      event.altKey ||
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== "e"
    )
      return;
    if (jumpTarget === null || !jumpTarget.isConnected) return;
    event.preventDefault();
    jumpTarget.openJump();
  });
}

export class LazurioRail extends ShellElement {
  static observedAttributes = ["app", "space", "lang"];
  private tip: HTMLDivElement | null = null;
  private jump: HTMLDialogElement | null = null;
  constructor() {
    super(railCss);
  }
  override connectedCallback() {
    document.documentElement.style.setProperty(
      "--lazurio-rail-width",
      railWidth,
    );
    jumpTarget = this;
    installShortcut();
    super.connectedCallback();
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    if (jumpTarget === this) jumpTarget = null;
  }

  /** Opens the jump to any Environment (⌘⇧E). */
  openJump() {
    const shell = current;
    if (shell === null || this.jump === null) return;
    const dialog = this.jump;
    const switcher = new Switcher(this, shell, this.copy(shell), {
      here: this.here(shell),
      app: this.app(),
      all: true,
      popover: false,
      close: () => dialog.close(),
    });
    dialog.replaceChildren(switcher.box);
    if (!dialog.open) dialog.showModal();
    switcher.focus();
  }

  private withTip<T extends HTMLElement>(node: T, title: string, sub: string) {
    node.dataset.tip = title;
    node.dataset.tipSub = sub;
    return node;
  }

  protected render() {
    const shell = current;
    if (shell === null) {
      this.root.replaceChildren();
      return;
    }
    const copy = this.copy(shell);
    const here = this.here(shell);
    remember(here, shell.current);
    // The last Environment used (S8, last.ts): a host that names its app.
    reportLast(shell, appOf(this.getAttribute("app")), here);
    const last = lastBySpace();
    const spaces = railSpaces(shell, copy, {
      here,
      app: this.app(),
      last: (space) => last[space] ?? null,
    });
    const nav = element("nav");
    nav.setAttribute("aria-label", copy.rail);

    const home = this.withTip(
      element("a", "item home"),
      copy.dashboard,
      copy.dashboardSub,
    );
    home.href = shell.dashboard;
    home.setAttribute("aria-label", copy.dashboard);
    const image = element("img");
    image.alt = "";
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logo)}`;
    home.append(image);

    const search = this.withTip(
      element("button", "item search"),
      copy.jump,
      copy.jumpShortcut,
    );
    search.type = "button";
    search.setAttribute("aria-label", copy.jump);
    search.setAttribute("aria-keyshortcuts", "Meta+Shift+E Control+Shift+E");
    search.append(icon("search", 18));
    search.addEventListener("click", () => this.openJump());

    const scroll = element("div", "scroll");
    spaces.forEach((space, index) => {
      if (index === 1) scroll.append(element("div", "divider"));
      const link = this.withTip(
        this.link(space.href, "item space"),
        space.title,
        space.sub,
      );
      link.setAttribute("aria-label", space.title);
      if (space.active) link.setAttribute("aria-current", "true");
      if (index === 0) {
        const mark = element("span", "initials");
        if (space.initials !== null) mark.textContent = space.initials;
        else mark.append(icon("user", 18));
        link.append(mark);
      } else link.append(organizationMark(space.avatar, space.initials ?? ""));
      scroll.append(link);
    });
    if (shell.addOrganization !== null) {
      const add = this.withTip(
        element("a", "item add"),
        copy.addOrganization,
        "",
      );
      add.href = shell.addOrganization;
      add.setAttribute("aria-label", copy.addOrganization);
      add.append(icon("plus", 18));
      scroll.append(add);
    }

    const account = this.withTip(
      element("a", "item account"),
      copy.account,
      copy.accountSub,
    );
    account.href = shell.account;
    account.setAttribute("aria-label", copy.account);
    const photo = () => {
      const mark = element("span", "avatar");
      if (shell.operator.initials !== null)
        mark.textContent = shell.operator.initials;
      else mark.append(icon("user", 18));
      return mark;
    };
    if (shell.operator.avatar !== null) {
      const picture = element("img", "avatar");
      picture.alt = "";
      picture.referrerPolicy = "no-referrer";
      picture.src = shell.operator.avatar;
      picture.addEventListener("error", () => picture.replaceWith(photo()), {
        once: true,
      });
      account.append(picture);
    } else account.append(photo());

    // The rail's own label: at once, beside the item, two lines.
    const tip = element("div", "tip");
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    tip.append(element("strong"), element("span"));
    this.tip = tip;

    const jump = element("dialog", "switcher-dialog");
    jump.addEventListener("click", (event) => {
      if (event.target === jump) jump.close();
    });
    this.jump = jump;

    nav.append(home, search, element("div", "divider"), scroll, account, tip);
    const show = (event: Event) => {
      const target = event
        .composedPath()
        .find(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node.dataset.tip !== undefined,
        );
      if (!target || !this.tip) return;
      const [title, sub] = [...this.tip.children] as HTMLElement[];
      if (title) title.textContent = target.dataset.tip ?? "";
      if (sub) sub.textContent = target.dataset.tipSub ?? "";
      const rect = target.getBoundingClientRect();
      this.tip.style.left = `${rect.right + 10}px`;
      this.tip.style.top = `${rect.top + rect.height / 2}px`;
      this.tip.hidden = false;
    };
    const hide = () => {
      if (this.tip) this.tip.hidden = true;
    };
    nav.addEventListener("pointerover", show);
    nav.addEventListener("focusin", show);
    nav.addEventListener("pointerleave", hide);
    nav.addEventListener("focusout", hide);
    nav.addEventListener("click", hide);
    this.root.replaceChildren(nav, jump);
  }
}

export class LazurioColumnHead extends ShellElement {
  static observedAttributes = ["active", "settings", "space", "lang"];
  private open: { close: () => void } | null = null;
  constructor() {
    super(columnHeadCss);
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.scheme.removeEventListener("change", this.retone);
    this.open?.close();
  }

  private settingsHref(shell: Shell): string {
    const own = this.getAttribute("settings");
    if (own) return own;
    const apps = currentEnvironment(shell).apps.apps;
    if (sameOrigin(apps)) return "/settings";
    return new URL("settings", apps).href;
  }

  /** Opens the list of this space's Environments under the picker. */
  /** Opens the list of this space's Environments under the picker, in the
   * top layer (a popover): the host's sidebar may clip or stack over its
   * children, the top layer is above both. A click outside or Escape closes
   * it (light dismiss). */
  private toggle(picker: HTMLButtonElement, shell: Shell) {
    if (this.open !== null) {
      this.open.close();
      return;
    }
    const copy = this.copy(shell);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (switcher.box.matches(":popover-open")) switcher.box.hidePopover();
      switcher.box.remove();
      picker.setAttribute("aria-expanded", "false");
      this.open = null;
    };
    const switcher = new Switcher(this, shell, copy, {
      here: this.here(shell),
      app: this.activeApp() ?? "apps",
      all: false,
      popover: true,
      close,
    });
    const rect = picker.getBoundingClientRect();
    const box = switcher.box;
    box.classList.add("switcher-popover");
    box.popover = "auto";
    box.style.top = `${rect.bottom + 6}px`;
    box.style.left = `${rect.left}px`;
    box.style.width = `${Math.min(Math.max(rect.width, 400), window.innerWidth - rect.left - 8)}px`;
    box.addEventListener("toggle", (event) => {
      if ((event as ToggleEvent).newState === "closed") {
        close();
        if (document.activeElement === this || this.root.activeElement === null)
          picker.focus();
      }
    });
    this.root.append(box);
    box.showPopover();
    picker.setAttribute("aria-expanded", "true");
    this.open = { close };
    switcher.focus();
  }

  // The host's tone (the forks have light and dark skins): the custom
  // property `--lazurio-host-tone: dark | light` wins; otherwise the
  // luminance of the nearest ancestor with an opaque background decides.
  // Read on connect and when the colour scheme changes.
  private readonly scheme = window.matchMedia("(prefers-color-scheme: dark)");
  private readonly retone = () => this.tone();
  override connectedCallback() {
    super.connectedCallback();
    this.tone();
    this.scheme.addEventListener("change", this.retone);
  }
  private tone() {
    const declared = getComputedStyle(this)
      .getPropertyValue("--lazurio-host-tone")
      .trim();
    const dark =
      declared === "dark" || declared === "light"
        ? declared === "dark"
        : hostIsDark(this);
    if ((this.dataset.hostTone === "dark") !== dark)
      this.dataset.hostTone = dark ? "dark" : "light";
  }

  private activeApp(): ShellApp | null {
    const active = this.getAttribute("active");
    return (shellApps as readonly string[]).includes(active ?? "")
      ? (active as ShellApp)
      : null;
  }

  protected render() {
    this.open?.close();
    const shell = current;
    if (shell === null) {
      this.root.replaceChildren();
      return;
    }
    const copy = this.copy(shell);
    const here = this.here(shell);
    // The last Environment used (S8, last.ts): Chat, Apps or Automate.
    reportLast(shell, appOf(this.getAttribute("active")), here);
    const environment = currentEnvironment(shell);
    const name = environmentName(environment, copy);

    const picker = element("button", "pick");
    picker.type = "button";
    picker.setAttribute("aria-haspopup", "dialog");
    picker.setAttribute("aria-expanded", "false");
    picker.setAttribute("aria-label", fillShell(copy.pick, { name }));
    const glyph = element("span", "pick-glyph");
    const look = environmentGlyph(shell, environment, here);
    if (look.kind === "avatar")
      glyph.append(
        organizationMark(
          look.organization.avatar,
          initialsOf(look.organization.name),
        ),
      );
    else if (look.kind === "initials")
      glyph.append(element("span", "initials", look.text));
    else glyph.append(icon(look.icon, 18));
    const text = element("span", "pick-text");
    text.append(
      element("span", "pick-title", name),
      element("span", "pick-who", environmentWho(environment, copy)),
    );
    picker.append(glyph, text, icon("chevron-down", 14));
    picker.addEventListener("click", () => this.toggle(picker, shell));

    const gear = this.link(this.settingsHref(shell), "gear");
    gear.setAttribute("aria-label", copy.settings);
    gear.title = copy.settings;
    if (this.getAttribute("active") === "settings")
      gear.setAttribute("aria-current", "page");
    gear.append(icon("settings", 18));

    const row = element("div", "row");
    row.append(picker, gear);

    const tabs = switchTabs(shell, copy, this.activeApp());
    const nav = element("nav", "switch");
    nav.setAttribute("aria-label", copy.switchLabel);
    nav.append(
      ...tabs.map((tab) => {
        const glyph = icon(tab.app, 16);
        const label = element("span", "", tab.label);
        if (tab.href === null) {
          const disabled = element("span", "tab");
          disabled.setAttribute("aria-disabled", "true");
          disabled.title = tab.missing ?? "";
          disabled.append(glyph, label);
          return disabled;
        }
        const href = tab.href;
        const anchor = element("a", "tab");
        anchor.href = href;
        anchor.dataset.app = tab.app;
        if (tab.active) anchor.setAttribute("aria-current", "page");
        anchor.addEventListener("click", (event) => {
          if (!plainClick(event)) return;
          const announced = this.dispatchEvent(
            new CustomEvent("lazurio-app", {
              detail: { app: tab.app, href },
              bubbles: true,
              composed: true,
              cancelable: true,
            }),
          );
          if (!announced) event.preventDefault();
        });
        anchor.append(glyph, label);
        return anchor;
      }),
    );
    const head = element("div", "head");
    head.append(row, nav);
    this.root.replaceChildren(head);
  }
}

/** Whether the nearest ancestor with an opaque background is dark (its
 * relative luminance below 0.4); none found is light. */
export function hostIsDark(start: Element): boolean {
  let node: Element | null = start.parentElement;
  while (node !== null) {
    const rgb = /rgba?\(([^)]+)\)/.exec(getComputedStyle(node).backgroundColor);
    const parts =
      rgb?.[1]
        ?.split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number) ?? [];
    const [r = 0, g = 0, b = 0, alpha = 1] = parts;
    if (parts.length >= 3 && alpha >= 0.9) return luminance(r, g, b) < 0.4;
    node = node.parentElement;
  }
  return false;
}

/** The relative luminance of an sRGB colour (WCAG). */
export function luminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Defines the elements (once) and declares the brand fonts in the document. */
export function defineShellElements(): void {
  installShellFonts(document);
  if (!customElements.get("lazurio-rail"))
    customElements.define("lazurio-rail", LazurioRail);
  if (!customElements.get("lazurio-column-head"))
    customElements.define("lazurio-column-head", LazurioColumnHead);
}
