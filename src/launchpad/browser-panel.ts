import { newTabEventName } from "../shell/new-tab-protocol";
import {
  browserFrame,
  browserHandOverPath,
  emptyStrip,
  panelChoice,
  reduceStrip,
  type StripEntry,
  type StripEvent,
  type StripState,
  shownEntry,
  stripEntries,
  stripEveryMs,
  stripTabs,
  tabViewAddress,
  viewMessage,
  viewTabOf,
} from "./browser-panel-view";
import type { MessageKey } from "./messages";
import {
  actionFailure,
  closeGraceMs,
  closeWarning,
  fill,
  launchpadStrip,
  type NewTabAnswer,
  newTabCopy,
  noteMs,
  type PendingClose,
  parseOverview,
  toastModel,
} from "./new-tab-view";

type Copy = Readonly<Record<MessageKey, string>>;

/** One request of the panel to this Launchpad, with the page's credential:
 * its status and JSON body (null when it has none); status 0 when no
 * answer came. */
export type PanelTransport = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<NewTabAnswer>;

// The right panel's DOM (decision F38's addendum of 2026-10-05, decision F47
// point 9): the Browser toggle in the head of each page (the Apps home beside
// Guide, the header of Settings and Files, the Marketplace; one shown at a
// time) and the panel after the page in the `.app` row, so the page shrinks.
// Its strip lists every tab of the Environment from Nová karta's overview,
// read every 5 s while the panel is open; "+" shows Nová karta; under the
// strip is one tab's view or Nová karta (`<lazurio-new-tab>`). Closed on every
// page load; what it shows is browser-panel-view.ts. A closed panel mounts no
// frame, so it streams and reads nothing. Below 1100 px it covers the window
// like a sheet and what lies behind it is inert.
export function createBrowserPanel(
  options: Readonly<{
    copy: () => Copy;
    locale: () => "cs" | "en";
    /** The view's origin where the panel is offered, otherwise null
     * (`browserPanelOrigin`). */
    origin: () => string | null;
    transport: PanelTransport;
    /** Called after the panel opened or closed. */
    changed: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing browser panel UI");
    return element;
  };
  const panel = find<HTMLElement>("#browser-panel");
  const heading = find<HTMLHeadingElement>("#browser-title");
  const tablist = find<HTMLDivElement>("#browser-tablist");
  const newButton = find<HTMLButtonElement>("#browser-new");
  const body = find<HTMLDivElement>("#browser-body");
  const message = find<HTMLParagraphElement>("#browser-message");
  const reload = find<HTMLButtonElement>("#browser-reload");
  const tabLink = find<HTMLAnchorElement>("#browser-tab");
  const close = find<HTMLButtonElement>("#browser-close");
  const toastSlot = find<HTMLDivElement>("#browser-toast-slot");
  const toastRegion = find<HTMLDivElement>("#browser-toast-region");
  const toggles = [
    ...document.querySelectorAll<HTMLButtonElement>(".browser-toggle"),
  ];
  const behind = ["#rail", "#sidebar", "#nav-toggle", "#page"].map((selector) =>
    find<HTMLElement>(selector),
  );
  const sheet = window.matchMedia("(max-width: 1099px)");
  const words = () => newTabCopy(options.locale());

  let open = false;
  let state: StripState = emptyStrip;
  /** What the body shows: one tab's view, or Nová karta of a generation. */
  let surface:
    | Readonly<{ kind: "frame"; tab: string; node: HTMLIFrameElement }>
    | Readonly<{ kind: "new"; generation: number; node: HTMLElement }>
    | null = null;
  // Whether the sheet makes the rest of the page inert now: changed only
  // here, so the column's own sheet keeps its inert page.
  let covering = false;
  let drawnStrip = "";
  let warning: HTMLElement | null = null;
  let pending: PendingClose | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let note: string | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  function dispatch(event: StripEvent) {
    state = reduceStrip(state, event);
    draw();
  }

  const svg = (name: string) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", "icon");
    node.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    node.append(use);
    return node;
  };

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

  /** A tab's icon: its favicon, or a globe; a dot while an agent works. */
  function favicon(entry: StripEntry): HTMLSpanElement {
    const box = element("span", "browser-favicon");
    if (entry.kind === "tab" && entry.favicon !== null) {
      const image = element("img");
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.src = entry.favicon;
      image.addEventListener("error", () => image.replaceWith(svg("globe")), {
        once: true,
      });
      box.append(image);
    } else box.append(svg("globe"));
    if (entry.kind === "tab" && entry.working) {
      const dot = element("span", "browser-agent");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", words().statusWorking);
      box.append(dot);
    }
    return box;
  }

  const entryTitle = (entry: StripEntry) =>
    entry.kind === "new"
      ? words().pageTitle
      : entry.title.trim() || entry.url || words().tabLoading;

  function drawStrip(force: boolean) {
    const entries = stripEntries(state);
    const shown = shownEntry(state);
    const shownKey = shown.kind === "new" ? "new" : shown.id;
    const signature = JSON.stringify([
      entries.map((entry) =>
        entry.kind === "new"
          ? ["new", entry.closable]
          : [entry.id, entryTitle(entry), entry.favicon, entry.working],
      ),
      shownKey,
      options.locale(),
    ]);
    if (!force && signature === drawnStrip) return;
    drawnStrip = signature;
    const focused =
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.dataset.focusKey ?? null)
        : null;
    const copy = words();
    tablist.replaceChildren(
      ...entries.map((entry) => {
        const key = entry.kind === "new" ? "new" : entry.id;
        const active = key === shownKey;
        const title = entryTitle(entry);
        const tab = element("div", `browser-tab${active ? " is-active" : ""}`);
        const main = element("button", "browser-tab-main");
        main.type = "button";
        main.setAttribute("role", "tab");
        main.setAttribute("aria-selected", String(active));
        main.setAttribute("aria-controls", "browser-body");
        main.dataset.focusKey = `tab:${key}`;
        main.title =
          entry.kind === "new"
            ? copy.newTabTitle
            : entry.working
              ? fill(copy.tabWorking, { title })
              : title;
        main.append(
          favicon(entry),
          element("span", "browser-tab-title", title),
        );
        main.addEventListener("click", () =>
          dispatch({ kind: "select", entry: key }),
        );
        tab.append(main);
        if (entry.kind === "tab" || entry.closable) {
          const shut = element("button", "browser-tab-close");
          shut.type = "button";
          shut.dataset.focusKey = `close:${key}`;
          if (entry.kind === "new") {
            shut.setAttribute("aria-label", copy.closeNewTab);
            shut.title = copy.closeNewTab;
            shut.addEventListener("click", () =>
              dispatch({ kind: "close-new-tab" }),
            );
          } else {
            shut.setAttribute("aria-label", fill(copy.closeTab, { title }));
            shut.title = entry.working
              ? copy.closeTabEveryoneAgent
              : copy.closeTabEveryone;
            shut.addEventListener("click", () => askClose(entry, shut));
          }
          shut.append(svg("x"));
          tab.append(shut);
        }
        return tab;
      }),
    );
    if (focused !== null)
      tablist
        .querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)
        ?.focus({ preventScroll: true });
    // The shown entry stays in view when the strip is full: chosen now, or
    // pushed aside by tabs an overview listed after it. Only the strip
    // scrolls, never the page around it.
    const active = tablist.querySelector(".browser-tab.is-active");
    if (active !== null) {
      const list = tablist.getBoundingClientRect();
      const shownBox = active.getBoundingClientRect();
      if (shownBox.left < list.left)
        tablist.scrollLeft -= list.left - shownBox.left;
      else if (shownBox.right > list.right)
        tablist.scrollLeft += shownBox.right - list.right;
    }
  }

  function removeSurface() {
    surface?.node.remove();
    surface = null;
  }

  /** The body for the shown entry: the tab's view in a frame on exactly the
   * recorded origin, or Nová karta; nothing while the panel is closed. The
   * sentence instead of a frame, or null. */
  function drawSurface(shown: StripEntry): string | null {
    const origin = options.origin();
    if (!open || origin === null) {
      removeSurface();
      return null;
    }
    if (shown.kind === "new") {
      if (surface?.kind === "new" && surface.generation === state.generation) {
        surface.node.setAttribute("lang", options.locale());
        return null;
      }
      removeSurface();
      const node = document.createElement("lazurio-new-tab");
      node.className = "browser-new-tab";
      node.setAttribute("strip", launchpadStrip);
      node.setAttribute("focus-address", "");
      node.setAttribute("lang", options.locale());
      body.append(node);
      surface = { kind: "new", generation: state.generation, node };
      return null;
    }
    const address = tabViewAddress(origin, shown.id, location.origin);
    if (address === null) {
      removeSurface();
      return options.copy().browserFailed;
    }
    if (surface?.kind === "frame" && surface.tab === shown.id) return null;
    removeSurface();
    const frame = document.createElement("iframe");
    frame.className = "browser-frame";
    frame.title = options.copy().browserFrame;
    for (const [name, value] of Object.entries(browserFrame))
      frame.setAttribute(name, value);
    frame.src = address;
    body.append(frame);
    surface = { kind: "frame", tab: shown.id, node: frame };
    return null;
  }

  function drawToast() {
    const model = toastModel(pending, note, words());
    const target = open ? toastSlot : toastRegion;
    (open ? toastRegion : toastSlot).replaceChildren();
    if (model === null) {
      target.replaceChildren();
      return;
    }
    const toast = element("div", "browser-toast");
    const text = element("span");
    if (model.note !== null) {
      if (model.text === null) text.textContent = model.note;
      else text.append(element("span", "browser-toast-note", model.note));
    }
    if (model.text !== null) text.append(model.text);
    toast.append(text);
    if (model.undo !== null) {
      const undo = element("button", "browser-toast-undo", model.undo);
      undo.type = "button";
      undo.addEventListener("click", () => void restore());
      toast.append(undo);
    }
    target.replaceChildren(toast);
  }

  function draw(force = false) {
    panel.hidden = !open;
    for (const toggle of toggles)
      toggle.setAttribute("aria-expanded", String(open));
    const shown = shownEntry(state);
    if (open) drawStrip(force);
    const sentence = drawSurface(shown);
    message.hidden = sentence === null;
    message.textContent = sentence ?? "";
    const origin = options.origin();
    const view =
      shown.kind === "tab" && origin !== null
        ? tabViewAddress(origin, shown.id, location.origin)
        : null;
    // The tab's view in a new tab of this browser, where the gateway can
    // sign in again; with Nová karta, the hand-over.
    tabLink.href = view ?? browserHandOverPath;
    drawToast();
    const cover = open && sheet.matches;
    if (cover !== covering) {
      covering = cover;
      for (const node of behind) node.inert = cover;
    }
  }

  // ---- Reading the strip --------------------------------------------------

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let pollAgain = false;

  /** One reading of the overview, then the next in 5 s while the panel is
   * open and the page visible. */
  async function poll(): Promise<void> {
    clearTimeout(pollTimer);
    pollTimer = undefined;
    if (!open || document.visibilityState !== "visible") return;
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    state = reduceStrip(state, { kind: "requested" });
    const request = state.requests;
    let tabs: ReturnType<typeof stripTabs> = null;
    try {
      const answer = await options.transport("GET", "/api/new-tab/overview");
      tabs = stripTabs(
        answer.status === 200 ? parseOverview(answer.value) : null,
      );
    } catch {}
    polling = false;
    dispatch({ kind: "listed", request, tabs });
    if (pollAgain) {
      pollAgain = false;
      void poll();
      return;
    }
    if (open && document.visibilityState === "visible")
      pollTimer = setTimeout(() => void poll(), stripEveryMs);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (open) void poll();
    } else {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  });

  // ---- Closing for everyone and Vrátit -------------------------------------

  /** The warning before closing a tab an agent works in, over the panel:
   * focus on keeping it, Escape keeps it, the focus returns to ×. */
  function warn(
    entry: Extract<StripEntry, { kind: "tab" }>,
    confirm: () => void,
    back: HTMLElement,
  ) {
    if (entry.tab === null) return;
    warning?.remove();
    const copy = words();
    const text = closeWarning(entry.tab, copy);
    const scrim = element("div", "browser-scrim");
    const box = element("div", "browser-confirm");
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "browser-confirm-title");
    box.setAttribute("aria-describedby", "browser-confirm-text");
    const title = element("strong", "browser-confirm-title", text.title);
    title.id = "browser-confirm-title";
    const sentence = element("p", "browser-confirm-text", text.text);
    sentence.id = "browser-confirm-text";
    const keep = element("button", "", text.keep);
    keep.type = "button";
    const shut = element("button", "destructive", text.close);
    shut.type = "button";
    const actions = element("div", "browser-confirm-actions");
    actions.append(keep, shut);
    box.append(title, sentence, actions);
    scrim.append(box);
    const done = (closeIt: boolean) => {
      scrim.remove();
      if (warning === scrim) warning = null;
      // Back to the same ×, also when a reading drew the strip anew
      // meanwhile; the panel's heading when it is gone.
      const key = back.dataset.focusKey;
      const again =
        back.isConnected || key === undefined
          ? back
          : tablist.querySelector<HTMLElement>(
              `[data-focus-key="${CSS.escape(key)}"]`,
            );
      if (again?.isConnected === true) again.focus({ preventScroll: true });
      else heading.focus({ preventScroll: true });
      if (closeIt) confirm();
    };
    keep.addEventListener("click", () => done(false));
    shut.addEventListener("click", () => done(true));
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        done(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        (document.activeElement === keep ? shut : keep).focus();
      }
    });
    scrim.addEventListener("click", (event) => {
      if (event.target === scrim) done(false);
    });
    warning = scrim;
    panel.append(scrim);
    keep.focus();
  }

  function askClose(
    entry: Extract<StripEntry, { kind: "tab" }>,
    back: HTMLElement,
  ) {
    if (entry.working) warn(entry, () => void closeTab(entry), back);
    else void closeTab(entry);
  }

  function setPending(next: PendingClose | null) {
    clearTimeout(pendingTimer);
    pending = next;
    if (next !== null)
      pendingTimer = setTimeout(() => {
        pending = null;
        drawToast();
      }, closeGraceMs);
    drawToast();
  }

  function say(text: string) {
    note = text;
    drawToast();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note = null;
      drawToast();
    }, noteMs);
  }

  /** × in the strip closes the tab for everyone (F47 points 6 and 9): it
   * goes from the strip at once, and Vrátit brings it back for 8 s. */
  async function closeTab(entry: Extract<StripEntry, { kind: "tab" }>) {
    const shown = shownEntry(state);
    const wasShown = shown.kind === "tab" && shown.id === entry.id;
    dispatch({ kind: "closing", tab: entry.id });
    const answer = await options.transport("POST", "/api/new-tab/close", {
      tab: entry.id,
    });
    if (answer.status === 202)
      setPending({ tab: entry.id, agent: entry.working, shown: wasShown });
    else if (answer.status !== 404) {
      dispatch({ kind: "close-failed", tab: entry.id });
      say(actionFailure(answer, words().closeFailed, words()));
    }
    void poll();
  }

  async function restore() {
    const closed = pending;
    if (closed === null) return;
    setPending(null);
    const answer = await options.transport("POST", "/api/new-tab/restore", {
      tab: closed.tab,
    });
    if (answer.status === 200)
      dispatch({
        kind: "restored",
        tab: closed.tab,
        show: closed.shown && open,
      });
    else say(actionFailure(answer, words().restoreFailed, words()));
    void poll();
  }

  // ---- What the frames say -------------------------------------------------

  // Nová karta's choice: a page it opened (held for the Launchpad by its
  // open) or a tab it chose shows in the panel. The Launchpad has no tools.
  body.addEventListener(newTabEventName, (event) => {
    const tab = panelChoice((event as CustomEvent<unknown>).detail);
    if (tab === null) return;
    dispatch({ kind: "chosen", tab });
    void poll();
  });

  // A view's messages, only from the shown view's own frame and origin.
  window.addEventListener("message", (event) => {
    if (!open || surface?.kind !== "frame") return;
    const frame = surface.node;
    const said = viewMessage(
      {
        data: event.data,
        origin: event.origin,
        fromFrame:
          event.source !== null && event.source === frame.contentWindow,
      },
      options.origin(),
    );
    if (said === null) return;
    if (said.kind === "new-tab") void holdAndShow(said.tab, said.url);
    else if (said.kind === "closed") {
      dispatch({ kind: "ended", tab: said.tab });
      void poll();
    } else
      dispatch({
        kind: "info",
        tab: said.tab,
        title: said.title,
        url: said.url,
      });
  });

  /** A page's new tab viewed here: the Launchpad holds it (F47 point 4),
   * then shows it; the frame views it either way. */
  async function holdAndShow(tab: string, url: string) {
    await options.transport("POST", "/api/new-tab/hold", { tab });
    dispatch({ kind: "show", tab, url });
    void poll();
  }

  // ---- Opening and closing the panel -----------------------------------------

  function show() {
    if (open || options.origin() === null) return;
    open = true;
    dispatch({ kind: "opened" });
    void poll();
    heading.focus({ preventScroll: true });
    options.changed();
  }

  /** Opens the panel on one tab of the view: a direct sign-in of an
   * Integrace the server opened in the Environment browser (decision F42).
   * Only an https address of a tab on exactly the recorded origin, as any
   * view; false when it is not one or no panel is offered. */
  function showView(view: string): boolean {
    const origin = options.origin();
    if (origin === null) return false;
    const tab = viewTabOf(view, origin);
    if (tab === null || tabViewAddress(origin, tab, location.origin) === null)
      return false;
    const opening = !open;
    open = true;
    dispatch({ kind: "show", tab });
    void poll();
    if (opening) {
      heading.focus({ preventScroll: true });
      options.changed();
    }
    return true;
  }

  function hide(returnFocus: boolean) {
    if (!open) return;
    open = false;
    clearTimeout(pollTimer);
    pollTimer = undefined;
    warning?.remove();
    warning = null;
    // A hidden strip loses its scroll: the next opening draws it anew, with
    // the shown entry in view.
    drawnStrip = "";
    draw();
    // Back to the toggle of the page shown.
    if (returnFocus)
      toggles.find((toggle) => toggle.offsetParent !== null)?.focus();
    options.changed();
  }

  for (const toggle of toggles)
    toggle.addEventListener("click", () => (open ? hide(false) : show()));
  close.addEventListener("click", () => hide(true));
  newButton.addEventListener("click", () => dispatch({ kind: "new-tab" }));
  reload.addEventListener("click", () => {
    // The shown view or Nová karta loads again, and the strip is read.
    removeSurface();
    draw();
    void poll();
  });
  // Escape inside the panel closes it, before Settings would take it.
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
      return;
    event.preventDefault();
    hide(true);
  });
  sheet.addEventListener("change", () => draw());

  function relabel() {
    const copy = options.copy();
    const own = words();
    reload.title = copy.browserReload;
    close.title = copy.browserClose;
    tabLink.title = copy.browserOpenTab;
    newButton.title = own.newTabTitle;
    newButton.setAttribute("aria-label", own.pageTitle);
    tablist.setAttribute("aria-label", own.stripLabel);
    if (surface?.kind === "frame") surface.node.title = copy.browserFrame;
    draw(true);
  }
  relabel();

  return {
    /** The entry was read or Recovery mode began: the toggle shows only
     * where the panel is offered, and the panel closes where it is not. */
    render() {
      const offered = options.origin() !== null;
      for (const toggle of toggles) toggle.hidden = !offered;
      if (!offered) hide(false);
    },
    /** The language changed. */
    relabel,
    /** Whether the panel is open now. */
    isOpen: () => open,
    showView,
  };
}
