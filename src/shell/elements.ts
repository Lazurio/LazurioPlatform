import { parseShell, type Shell } from "./contract";
import { installShellFonts } from "./fonts";
import { icon } from "./icons";
import { type ShellCopy, shellMessages } from "./messages";
import { columnHeadCss, railCss, railWidth } from "./styles";
import { vendorText } from "./vendor-text" with { type: "macro" };
import {
  jumpList,
  moreText,
  type RailFolder,
  type RailItem,
  railModel,
  type ShellApp,
  shellApps,
  switchTabs,
} from "./view";

// The Lazurio shell as framework-free custom elements (decision F36):
// `<lazurio-rail>` (level 1: the logo to the Dashboard, the jump to an
// Environment, the personal Environments, the Organization folders, the
// gear and the account) and `<lazurio-column-head active="apps">` (the switch
// Chat · Apps · Automate at the top of an app's left column). Each draws into
// its own shadow root, so neither the host's styles nor these leak across.
// `<lazurio-buddy>` is reserved for Buddy's bubble (decision 0180) and not
// defined here.
//
// Data: the `lazurio.shell.v1` document. A host that has it calls
// `provideShell`; otherwise the elements read `/.lazurio/shell.json` on
// their own origin once (the forks). A host that provides it marks
// `<html data-lazurio-shell="host">` so nothing is fetched twice.
//
// Events, both cancelable and composed, so a host can take a click over:
// `lazurio-navigate` (detail `{ href }`) for a link on the document's own
// origin (the gear, the Apps tab, the current Environment), and
// `lazurio-app` (detail `{ app, href }`) for a switch tab. Without a
// listener that cancels them, the links simply navigate.

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
  /** A link the host may take over: same-origin links announce
   * `lazurio-navigate` before they navigate. */
  protected link(href: string, className: string): HTMLAnchorElement {
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
  static observedAttributes = ["settings", "lang"];
  private readonly expanded = new Set<string>();
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

  /** Opens the jump list of Environments (⌘⇧E). */
  openJump() {
    if (current === null || this.jump === null) return;
    if (!this.jump.open) this.jump.showModal();
    const input = this.jump.querySelector("input");
    if (input) {
      input.value = "";
      this.fillJump("");
      input.focus();
    }
  }

  private fillJump(query: string) {
    if (current === null || this.jump === null) return;
    const copy = this.copy(current);
    const list = this.jump.querySelector("ul");
    const empty = this.jump.querySelector<HTMLElement>(".jump-empty");
    if (!list || !empty) return;
    const entries = jumpList(current, copy, query);
    list.replaceChildren(
      ...entries.map((entry) => {
        const item = element("li");
        const anchor = this.link(entry.href, "");
        if (entry.active) anchor.setAttribute("aria-current", "page");
        anchor.append(
          element("strong", "", entry.label),
          element("span", "", entry.sub),
        );
        anchor.addEventListener("click", () => this.jump?.close());
        item.append(anchor);
        return item;
      }),
    );
    empty.hidden = entries.length > 0;
  }

  private settingsHref(shell: Shell): string {
    const own = this.getAttribute("settings");
    if (own) return own;
    const apps = shell.environments.find((entry) => entry.id === shell.current)
      ?.apps.apps;
    if (apps === undefined || sameOrigin(apps)) return "/settings";
    return new URL("settings", apps).href;
  }

  private withTip<T extends HTMLElement>(node: T, title: string, sub: string) {
    node.dataset.tip = title;
    node.dataset.tipSub = sub;
    return node;
  }

  private envItem(entry: RailItem): HTMLAnchorElement {
    const anchor = this.withTip(
      this.link(entry.href, "item env"),
      entry.label,
      entry.sub,
    );
    anchor.setAttribute("aria-label", entry.label);
    if (entry.active) anchor.setAttribute("aria-current", "page");
    if (entry.accent !== null)
      anchor.style.setProperty("--env-accent", entry.accent);
    anchor.append(
      entry.mark.kind === "initials"
        ? element("span", "initials", entry.mark.text)
        : icon(entry.mark.icon, 20),
    );
    return anchor;
  }

  private folder(entry: RailFolder, copy: ShellCopy): HTMLDivElement {
    const box = element("div", `folder${entry.hasActive ? " has-active" : ""}`);
    box.style.setProperty(
      "--env-accent",
      entry.organization.accent ?? "var(--lz-accent-strong)",
    );
    const head = this.withTip(
      element("span", "folder-head"),
      entry.organization.name,
      copy.organizationSub,
    );
    const mark = element("span", "mark");
    const fallback = () => mark.replaceChildren(entry.initials);
    if (entry.organization.avatar !== null) {
      const image = element("img");
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.src = entry.organization.avatar;
      image.addEventListener("error", fallback, { once: true });
      mark.append(image);
    } else fallback();
    head.append(mark, element("span", "sr-only", entry.organization.name));
    box.append(head, ...entry.items.map((item) => this.envItem(item)));
    if (entry.hidden > 0 || entry.expanded) {
      const words = moreText(copy, entry);
      const more = this.withTip(
        element("button", "more", words.text),
        words.label,
        "",
      );
      more.type = "button";
      more.setAttribute("aria-label", words.label);
      more.setAttribute("aria-expanded", String(entry.expanded));
      more.addEventListener("click", () => {
        if (entry.expanded) this.expanded.delete(entry.organization.slug);
        else this.expanded.add(entry.organization.slug);
        this.render();
      });
      box.append(more);
    }
    return box;
  }

  protected render() {
    const shell = current;
    if (shell === null) {
      this.root.replaceChildren();
      return;
    }
    const copy = this.copy(shell);
    const model = railModel(shell, copy, this.expanded);
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
      element("button", "item utility search"),
      copy.jump,
      copy.jumpShortcut,
    );
    search.type = "button";
    search.setAttribute("aria-label", copy.jump);
    search.setAttribute("aria-keyshortcuts", "Meta+Shift+E Control+Shift+E");
    search.append(icon("search", 18));
    search.addEventListener("click", () => this.openJump());

    const scroll = element("div", "scroll");
    scroll.append(...model.personal.map((entry) => this.envItem(entry)));
    if (model.personal.length > 0 && model.folders.length > 0)
      scroll.append(element("div", "divider"));
    scroll.append(...model.folders.map((entry) => this.folder(entry, copy)));

    const gear = this.withTip(
      this.link(this.settingsHref(shell), "item utility"),
      copy.settings,
      copy.settingsSub,
    );
    gear.setAttribute("aria-label", copy.settings);
    gear.append(icon("settings", 20));

    const account = this.withTip(
      element("a", "item account"),
      copy.account,
      copy.accountSub,
    );
    account.href = shell.account;
    account.setAttribute("aria-label", copy.account);
    const avatar = element("span", "avatar");
    if (shell.operator.initials !== null)
      avatar.textContent = shell.operator.initials;
    else avatar.append(icon("user", 18));
    account.append(avatar);

    // The rail's own label: at once, beside the item, two lines.
    const tip = element("div", "tip");
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    tip.append(element("strong"), element("span"));
    this.tip = tip;

    const jump = element("dialog");
    jump.setAttribute("aria-label", copy.jumpTitle);
    const head = element("label", "jump-head");
    const input = element("input");
    input.type = "search";
    input.placeholder = copy.jumpTitle;
    input.setAttribute("aria-label", copy.jumpTitle);
    input.addEventListener("input", () => this.fillJump(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      jump.querySelector<HTMLAnchorElement>("ul a")?.click();
    });
    head.append(icon("search", 16), input);
    jump.append(
      head,
      element("ul", "jump-list"),
      element("p", "jump-empty", copy.jumpEmpty),
    );
    jump.addEventListener("click", (event) => {
      if (event.target === jump) jump.close();
    });
    this.jump = jump;

    nav.append(
      home,
      search,
      element("div", "divider"),
      scroll,
      gear,
      account,
      tip,
    );
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
  static observedAttributes = ["active", "lang"];
  constructor() {
    super(columnHeadCss);
  }
  protected render() {
    const shell = current;
    if (shell === null) {
      this.root.replaceChildren();
      return;
    }
    const copy = this.copy(shell);
    const active = this.getAttribute("active");
    const tabs = switchTabs(
      shell,
      copy,
      (shellApps as readonly string[]).includes(active ?? "")
        ? (active as ShellApp)
        : null,
    );
    const nav = element("nav");
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
    this.root.replaceChildren(nav);
  }
}

/** Defines the elements (once) and declares the brand fonts in the document. */
export function defineShellElements(): void {
  installShellFonts(document);
  if (!customElements.get("lazurio-rail"))
    customElements.define("lazurio-rail", LazurioRail);
  if (!customElements.get("lazurio-column-head"))
    customElements.define("lazurio-column-head", LazurioColumnHead);
}
