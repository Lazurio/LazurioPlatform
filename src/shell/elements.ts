import { pageAccountJson } from "./account";
import {
  parseShell,
  type Shell,
  type ShellAccount,
  type ShellSignedOut,
} from "./contract";
import { installShellFonts } from "./fonts";
import { icon } from "./icons";
import { appOf, keptVisit, reportLast } from "./last";
import { fillShell, type ShellCopy, shellMessages } from "./messages";
import { accountSourceOf, createShellState } from "./state";
import { columnHeadCss, railCss, railWidth } from "./styles";
import { vendorText } from "./vendor-text" with { type: "macro" };
import {
  type ColumnSetupLine,
  columnHead,
  hereOf,
  initialsOf,
  railHome,
  railSpaces,
  type ShellApp,
  type SwitcherKind,
  type SwitcherSection,
  type SwitchTab,
  shellApps,
  signedOutRail,
  switcherKey,
  switcherList,
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
// `<html data-lazurio-shell="host">` so nothing is fetched twice. Alongside
// it the elements draw the person's account merged in (merge.ts, F37): this
// Environment as its document says, and the other spaces and Environments
// of the person signed in at the browser. By default they read the account
// on their own origin once (`/.lazurio/account/environments`, account.ts);
// a host that has it marks `<html data-lazurio-account="host">` and calls
// `provideAccount`, and then nothing is read, remembered or reported
// (state.ts, F36's addendum of 2026-10-05). Until there is an account, and
// whenever there is none, they draw the document alone. A host's page with
// nobody signed in provides `lazurio.shell-signed-out.v1` instead, with the
// same `provideShell` (F36's addendum of 2026-10-06): the rail then draws the
// logo and the sign-in key, and the column head nothing.
//
// Attributes: `app` on the rail (`chat`, `apps`, `automate`: a click on a
// space stays in that app), `space` on both (the space you are in, when the
// host knows it better than the document: a workstation opened for one
// Organization; on a page that is no Environment's, the Organization whose
// Dashboard it is), `active` (`chat`, `apps`, `automate` or `settings`) and
// `settings` (the Settings address) on the head.
//
// Events, both cancelable and composed, so a host can take a click over:
// `lazurio-navigate` (detail `{ href }`) for a link on the document's own
// origin, and `lazurio-app` (detail `{ app, href }`) for a switch tab.
// Without a listener that cancels them, the links simply navigate.

const logo = vendorText("symbol-color.svg");

// The page's document, the person's account and the two merged (what the
// elements draw), shared by every element of the page.
const state = createShellState({
  source: () =>
    accountSourceOf(document.documentElement.dataset.lazurioAccount),
  read: pageAccountJson,
  report: reportLast,
});
let requested = false;

/** Gives the elements the page's own document, which replaces the one
 * before; they redraw. `lazurio.shell.v1` (`parseShell`) is drawn merged with
 * the person's account once there is one; on a host's page with nobody signed
 * in, `lazurio.shell-signed-out.v1` (`parseShellSignedOut`) is drawn as the
 * logo and the sign-in key, and the column head draws nothing. */
export function provideShell(shell: Shell | ShellSignedOut): void {
  state.provideShell(shell);
}

/** Gives the elements the person's account on a host's page (`<html
 * data-lazurio-account="host">`): the document `parseShellAccount` read, or
 * null for none. They redraw; nothing is requested, remembered or
 * reported. */
export function provideAccount(account: ShellAccount | null): void {
  state.provideAccount(account);
}

function requestShell(): void {
  state.requestAccount();
  if (
    requested ||
    state.local() !== null ||
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
// the rail returns there. Only Environment ids of the document are kept,
// and nothing from a page that is no Environment's (`keptVisit`).
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

/** The Lazurio logo on a white disc, so it reads the same in every app's
 * colours. */
function logoDisc(): HTMLSpanElement {
  const disc = element("span", "disc");
  const image = element("img");
  image.alt = "";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logo)}`;
  disc.append(image);
  return disc;
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
  private unlisten: (() => void) | null = null;
  constructor(css: string) {
    super();
    this.root = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    this.root.adoptedStyleSheets = [sheet];
  }
  connectedCallback() {
    this.unlisten ??= state.listen(() => this.render());
    requestShell();
    this.render();
  }
  disconnectedCallback() {
    this.unlisten?.();
    this.unlisten = null;
  }
  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }
  /** The words in the `lang` attribute's language, else the document's. */
  protected copy(shell: Readonly<{ locale: Shell["locale"] }>): ShellCopy {
    const lang = this.getAttribute("lang");
    return shellMessages(lang === "cs" || lang === "en" ? lang : shell.locale);
  }
  /** The space you are in; null on the personal Dashboard. */
  protected here(shell: Shell): string | null {
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

/** Where you are in a list: the check, and its word ("tady jsi") for screen
 * readers only (design-system-lazurio#62). */
function checkMark(word: string): HTMLSpanElement {
  const mark = element("span", "switcher-check");
  mark.append(icon("check", 14), element("span", "sr-only", word));
  return mark;
}

/** The list of Environments, as a popover under the picker (the space you
 * are in, widened by "Všechny Organizace") or as the ⌘⇧E dialog (every
 * space), drawn from `switcherList` (F36's addendum of 2026-10-06): one line
 * per Environment, a search field only where the list has one, the keys of
 * `switcherKey`. With the field the focus stays in it and the cursor marks
 * the entry Enter opens; without it (the picker of a handful of
 * Environments) the focus itself is the cursor: it lands on the current
 * Environment, else the first, and moves with the arrows, Home, End and the
 * pointer. */
class Switcher {
  readonly box = element("div", "switcher-box");
  private readonly search = element("label", "switcher-search");
  private readonly input = element("input");
  private readonly list = element("div", "switcher-list");
  private readonly foot = element("div", "switcher-foot");
  private query = "";
  private widened = false;
  private cursor = 0;
  private links: HTMLAnchorElement[] = [];
  private widen: HTMLButtonElement | null = null;
  constructor(
    private readonly host: ShellElement,
    private readonly shell: Shell,
    private readonly copy: ShellCopy,
    private readonly options: {
      kind: SwitcherKind;
      here: string | null;
      app: ShellApp;
      close: () => void;
    },
  ) {
    this.input.type = "search";
    this.input.setAttribute("aria-label", copy.switcher);
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.fill();
    });
    this.search.append(
      icon("search", 16),
      this.input,
      element("span", "kbd", "⌘⇧E"),
    );
    this.box.setAttribute("role", "dialog");
    this.box.setAttribute("aria-label", copy.switcher);
    // Focused only when the list offers nothing else to focus.
    this.box.tabIndex = -1;
    this.box.addEventListener("keydown", (event) => this.key(event));
    this.box.append(this.list, this.foot);
    this.fill();
  }
  /** Where the focus lands when the list is shown or widened: the search
   * field where there is one, else the entry under the cursor, else
   * "Všechny Organizace"; the entry under the cursor is scrolled into
   * view. */
  focus() {
    this.mark();
    if (this.field()) this.input.focus();
    else (this.links[this.cursor] ?? this.widen ?? this.box).focus();
  }
  private field(): boolean {
    return this.search.parentNode === this.box;
  }
  private key(event: KeyboardEvent) {
    // A key with a modifier is the browser's or the host's (⌘⇧E itself).
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    const action = switcherKey(event.key, {
      cursor: this.cursor,
      count: this.links.length,
      focus:
        target === this.input
          ? "field"
          : target instanceof HTMLAnchorElement && this.links.includes(target)
            ? "entry"
            : "other",
    });
    if (action === null) return;
    event.preventDefault();
    if (action.kind === "close") this.options.close();
    else if (action.kind === "open") this.links[this.cursor]?.click();
    else {
      this.cursor = action.cursor;
      this.mark();
      // On an entry the focus moves with the cursor.
      if (target !== this.input) this.links[this.cursor]?.focus();
    }
  }
  private mark() {
    for (const [index, link] of this.links.entries())
      link.classList.toggle("is-cursor", index === this.cursor);
    this.links[this.cursor]?.scrollIntoView({ block: "nearest" });
  }
  /** Draws the list afresh, the cursor on its start (`switcherList`). */
  private fill(): void {
    const list = switcherList(this.shell, this.copy, {
      kind: this.options.kind,
      here: this.options.here,
      widened: this.widened,
      app: this.options.app,
      query: this.query,
    });
    // The search field only where the list has one.
    if (list.search === null) this.search.remove();
    else {
      this.input.placeholder = list.search;
      if (!this.field()) this.box.prepend(this.search);
    }
    this.links = [];
    this.list.replaceChildren(
      ...list.sections.map((section) => this.section(section)),
    );
    if (list.nothing !== null)
      this.list.append(element("p", "switcher-empty", list.nothing));
    this.cursor = Math.min(list.start, Math.max(0, this.links.length - 1));
    this.mark();
    const foot: Node[] = [];
    this.widen = null;
    if (list.widen !== null) {
      const widen = element("button", "switcher-widen");
      widen.type = "button";
      widen.append(icon("globe", 14), list.widen);
      widen.addEventListener("click", () => {
        this.widened = true;
        this.fill();
        this.focus();
      });
      this.widen = widen;
      foot.push(widen);
    }
    for (const { key, word } of list.hints) {
      const span = element("span");
      span.append(element("span", "kbd", key), ` ${word}`);
      foot.push(span);
    }
    this.foot.replaceChildren(...foot);
    this.foot.hidden = foot.length === 0;
  }
  private track(link: HTMLAnchorElement) {
    const at = this.links.length;
    this.links.push(link);
    link.addEventListener("mouseenter", () => {
      this.cursor = at;
      this.mark();
      // Without the field the focus is the cursor, so Enter opens what the
      // pointer marks.
      if (!this.field()) link.focus({ preventScroll: true });
    });
    link.addEventListener("focus", () => {
      if (this.cursor === at) return;
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
      const { organization, href, current } = section.head;
      const head = this.track(this.host.link(href, "switcher-head"));
      const meta = element("span", "switcher-head-meta");
      // On the Organization's Dashboard its head is where you are.
      if (current) {
        head.setAttribute("aria-current", "page");
        meta.append(checkMark(copy.here));
      } else meta.textContent = copy.organizationDashboard;
      head.append(
        organizationMark(organization.avatar, initialsOf(organization.name)),
        element("span", "switcher-head-name", organization.name),
        meta,
      );
      group.append(head);
    }
    if (section.title !== null)
      group.append(element("div", "switcher-title", section.title));
    for (const row of section.rows) {
      const link = this.track(this.host.link(row.href, "switcher-row"));
      if (row.current) link.setAttribute("aria-current", "page");
      const glyph = element("span", "switcher-glyph");
      if (row.glyph.kind === "initials") glyph.textContent = row.glyph.text;
      else glyph.append(icon(row.glyph.icon, 16));
      const text = element("span", "switcher-copy");
      text.append(
        element("span", "switcher-name", row.name),
        element("span", "switcher-who", row.who),
      );
      link.append(glyph, text);
      if (row.current) link.append(checkMark(copy.here));
      group.append(link);
    }
    if (section.empty !== null)
      group.append(element("p", "switcher-empty", section.empty));
    return group;
  }
}

// One rail at a time answers ⌘⇧E / Ctrl+Shift+E: the last one connected.
// The keys are taken only when the jump opens: with nobody signed in, or
// before the document arrives, there is none, and they stay the browser's.
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
    if (jumpTarget.openJump()) event.preventDefault();
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

  /** Opens the jump to any Environment (⌘⇧E); false when there is none to
   * open: before the document arrives, and with nobody signed in. */
  openJump(): boolean {
    const shell = state.drawn();
    if (shell === null || this.jump === null) return false;
    const dialog = this.jump;
    const switcher = new Switcher(this, shell, this.copy(shell), {
      kind: "jump",
      here: this.here(shell),
      app: this.stayIn(shell) ?? "apps",
      close: () => dialog.close(),
    });
    dialog.replaceChildren(switcher.box);
    if (!dialog.open) dialog.showModal();
    switcher.focus();
    return true;
  }

  /** The app a click stays in: the rail's own (`app`) on an Environment's
   * page; none on a page that is no Environment's (F36's addendum of
   * 2026-10-05), where a space opens the app its last visit was in. */
  private stayIn(shell: Shell): ShellApp | null {
    return shell.current === null ? null : this.app();
  }

  private withTip<T extends HTMLElement>(node: T, title: string, sub: string) {
    node.dataset.tip = title;
    node.dataset.tipSub = sub;
    return node;
  }

  /** The rail's own label: at once, beside the item under the pointer or
   * the focus, two lines. Appended as the last child of `nav`. */
  private labelled(nav: HTMLElement): void {
    const tip = element("div", "tip");
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    tip.append(element("strong"), element("span"));
    this.tip = tip;
    nav.append(tip);
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
  }

  /** The rail with nobody signed in (`signedOutRail`, F36's addendum of
   * 2026-10-06): the logo and the sign-in key, links in the signed-in rail's
   * order, labelled as its items are. A path on the page's own origin
   * announces `lazurio-navigate`, as every link on it does. */
  private renderSignedOut(signedOut: ShellSignedOut) {
    const rail = signedOutRail(signedOut, this.copy(signedOut));
    const nav = element("nav");
    nav.setAttribute("aria-label", rail.label);
    for (const item of rail.items) {
      const link = this.withTip(
        this.link(item.href, `item ${item.kind}`),
        item.label,
        item.sub,
      );
      link.setAttribute("aria-label", item.label);
      link.append(item.kind === "home" ? logoDisc() : icon("key", 20));
      nav.append(link);
    }
    this.labelled(nav);
    // No jump without a person.
    this.jump = null;
    this.root.replaceChildren(nav);
  }

  protected render() {
    const signedOut = state.signedOut();
    if (signedOut !== null) {
      this.renderSignedOut(signedOut);
      return;
    }
    const shell = state.drawn();
    if (shell === null) {
      this.root.replaceChildren();
      return;
    }
    const copy = this.copy(shell);
    const here = this.here(shell);
    // This browser's memory of the space's last Environment; nothing from a
    // page that is no Environment's.
    const kept = keptVisit(shell, here);
    if (kept !== null) remember(kept.space, kept.environment);
    // The last Environment used (S8, last.ts): a host that names its app,
    // never a host that provides the account (state.ts) or a page that is
    // no Environment's (last.ts).
    state.report(appOf(this.getAttribute("app")), here);
    const app = this.stayIn(shell);
    const accountLast = state.lastBySpace();
    const last = lastBySpace();
    const spaces = railSpaces(shell, copy, {
      here,
      app,
      last:
        app === null
          ? // A page that is no Environment's: the account's last visit,
            // in its app; this origin keeps none.
            (space) => accountLast.get(space) ?? null
          : // Where you were last in each other space: the account's
            // memory (every Environment is its own origin, so this
            // browser's memory on this origin knows little else), else
            // this browser's; in the space you are in, this Environment.
            (space) => {
              const browser = last[space];
              return (
                (space === here ? null : accountLast.get(space)?.environment) ??
                (typeof browser === "string" ? browser : null)
              );
            },
    });
    const nav = element("nav");
    nav.setAttribute("aria-label", copy.rail);

    // The logo: the personal Dashboard, the page you are on when you are on
    // it (F36's addendum of 2026-10-05). A host's own path announces
    // `lazurio-navigate`, as every link on the page's origin does.
    const dashboard = railHome(shell, this.getAttribute("space"));
    const home = this.withTip(
      this.link(dashboard.href, "item home"),
      copy.dashboard,
      copy.dashboardSub,
    );
    home.setAttribute("aria-label", copy.dashboard);
    if (dashboard.current) home.setAttribute("aria-current", "page");
    home.append(logoDisc());

    const search = this.withTip(
      element("button", "item search"),
      copy.jump,
      copy.jumpShortcut,
    );
    search.type = "button";
    search.setAttribute("aria-label", copy.jump);
    search.setAttribute("aria-keyshortcuts", "Meta+Shift+E Control+Shift+E");
    search.append(icon("search", 16));
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
        else mark.append(icon("user", 16));
        link.append(mark);
      } else link.append(organizationMark(space.avatar, space.initials ?? ""));
      scroll.append(link);
    });
    if (shell.addOrganization !== null) {
      const add = this.withTip(
        this.link(shell.addOrganization, "item add"),
        copy.addOrganization,
        "",
      );
      add.setAttribute("aria-label", copy.addOrganization);
      add.append(icon("plus", 16));
      scroll.append(add);
    }

    const account = this.withTip(
      this.link(shell.account, "item account"),
      copy.account,
      copy.accountSub,
    );
    account.setAttribute("aria-label", copy.account);
    const photo = () => {
      const mark = element("span", "avatar");
      if (shell.operator.initials !== null)
        mark.textContent = shell.operator.initials;
      else mark.append(icon("user", 16));
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

    const jump = element("dialog", "switcher-dialog");
    jump.addEventListener("click", (event) => {
      if (event.target === jump) jump.close();
    });
    this.jump = jump;

    nav.append(home, search, element("div", "divider"), scroll, account);
    this.labelled(nav);
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

  /** Opens the list of this space's Environments under the picker, in the
   * top layer (a popover): the host's sidebar may clip or stack over its
   * children, the top layer is above both. A click outside or Escape closes
   * it (light dismiss). On an Organization's Dashboard the list is that
   * Organization's Environments, none of them current; the list never leads
   * to the Dashboard itself (F36's addendum of 2026-10-06). */
  private toggle(picker: HTMLButtonElement, shell: Shell, here: string) {
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
      kind: "picker",
      here,
      app: this.activeApp() ?? "apps",
      close,
    });
    const rect = picker.getBoundingClientRect();
    const box = switcher.box;
    box.classList.add("switcher-popover");
    box.popover = "auto";
    box.style.top = `${rect.bottom + 6}px`;
    box.style.left = `${rect.left}px`;
    // As wide as the picker, at least 280 px (the wireframe's compact
    // picker), never past the window.
    box.style.width = `${Math.min(Math.max(rect.width, 280), window.innerWidth - rect.left - 8)}px`;
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
    const shell = state.drawn();
    if (shell === null) {
      this.root.replaceChildren();
      return;
    }
    const copy = this.copy(shell);
    const model = columnHead(shell, copy, {
      space: this.getAttribute("space"),
      active: this.getAttribute("active"),
      settings: this.getAttribute("settings"),
    });
    // Nothing on the personal Dashboard (F36's addendum of 2026-10-05).
    if (model === null) {
      this.root.replaceChildren();
      return;
    }
    // The last Environment used (S8, last.ts): Chat, Apps or Automate.
    state.report(appOf(this.getAttribute("active")), model.here);
    const name = model.picker.title;

    const picker = element("button", "pick");
    picker.type = "button";
    picker.setAttribute("aria-haspopup", "dialog");
    picker.setAttribute("aria-expanded", "false");
    picker.setAttribute("aria-label", fillShell(copy.pick, { name }));
    const glyph = element("span", "pick-glyph");
    const look = model.picker.glyph;
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
      element("span", "pick-who", model.picker.who),
    );
    picker.append(glyph, text, icon("chevron-down", 14));
    picker.addEventListener("click", () =>
      this.toggle(picker, shell, model.here),
    );

    // The Settings of exactly what the picker names: the Environment's, or
    // on an Organization's Dashboard the Organization's.
    const gear = this.link(model.gear.href, "gear");
    // The first-run tour rings the gear and the tabs (root decision 0188).
    gear.dataset.tour = "gear";
    gear.setAttribute("aria-label", model.gear.label);
    gear.title = model.gear.label;
    if (model.gear.current) gear.setAttribute("aria-current", "page");
    gear.append(icon("settings", 18));

    const row = element("div", "row");
    row.append(picker, gear);
    const head = element("div", "head");
    head.append(row);
    // No switch on an Organization's Dashboard.
    if (model.tabs !== null) head.append(this.appSwitch(model.tabs, copy));
    if (model.setup !== null)
      head.append(setupLine(model.setup, copy.setupLabel));
    this.root.replaceChildren(head);
  }

  /** The switch Chat · Apps · Automate. */
  private appSwitch(tabs: readonly SwitchTab[], copy: ShellCopy): HTMLElement {
    const nav = element("nav", "switch");
    nav.setAttribute("aria-label", copy.switchLabel);
    nav.append(
      ...tabs.map((tab) => {
        const glyph = icon(tab.app, 16);
        const label = element("span", "", tab.label);
        if (tab.href === null) {
          const disabled = element("span", "tab");
          disabled.dataset.tour = `tab-${tab.app}`;
          disabled.setAttribute("aria-disabled", "true");
          disabled.title = tab.missing ?? "";
          disabled.append(glyph, label);
          return disabled;
        }
        const href = tab.href;
        const anchor = element("a", "tab");
        anchor.href = href;
        anchor.dataset.app = tab.app;
        anchor.dataset.tour = `tab-${tab.app}`;
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
    return nav;
  }
}

/** The line under the switch in Chat and Automate until the Environment is
 * usable (root decision 0188): an icon, one sentence and its buttons. A link
 * on this page's own origin that differs only in its fragment loads the page
 * again, so the app reads it as it starts (Chat takes a prepared prompt's
 * link only then). */
function setupLine(line: ColumnSetupLine, label: string): HTMLElement {
  const box = element("div", "setup");
  box.dataset.tone = line.tone;
  box.setAttribute("role", "status");
  box.setAttribute("aria-label", label);
  const text = element("span", "setup-text", line.text);
  const links = element("span", "setup-links");
  for (const link of line.links) {
    const anchor = element("a", "setup-link", link.label);
    anchor.href = link.href;
    anchor.addEventListener("click", (event) => {
      if (!plainClick(event)) return;
      const target = new URL(link.href, location.href);
      if (
        target.origin !== location.origin ||
        target.pathname !== location.pathname ||
        target.search !== location.search
      )
        return;
      event.preventDefault();
      location.hash = target.hash;
      location.reload();
    });
    links.append(anchor);
  }
  box.append(icon(line.icon, 16), text, links);
  return box;
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
