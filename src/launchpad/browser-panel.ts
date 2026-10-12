import { newTabEventName } from "../shell/new-tab-protocol";
import {
  browserFrame,
  browserHandOverPath,
  closesPanel,
  emptyStrip,
  entryKey,
  holdFailure,
  holdSucceeded,
  panelChoice,
  reduceStrip,
  releaseSucceeded,
  releaseText,
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
import {
  attachDivider,
  readLayout,
  showDividerRange,
  writeLayout,
} from "./layout";
import {
  dragPanel,
  keyPanel,
  type PanelPlace,
  type PanelWish,
  panelWish,
  placePanel,
} from "./layout-view";
import type { MessageKey } from "./messages";
import {
  actionFailure,
  actionNoteMs,
  closeGraceMs,
  fill,
  launchpadStrip,
  type NewTabAnswer,
  newTabCopy,
  noteMs,
  type PendingUndo,
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
// Its strip lists the tabs the Launchpad holds, from Nová karta's overview
// read every 5 s while the panel is open (F47 point 9's addendum of
// 2026-10-12), then its Nová karta entries; "+" adds one, and under the strip
// is the shown entry: one tab's view or Nová karta (`<lazurio-new-tab>`).
// Only the shown entry is mounted, so a Nová karta in the strip reads
// nothing. × on a tab lets go of the Launchpad's hold, with Vrátit; × on a
// Nová karta takes it away; the person's × on the last entry closes the
// panel (Matěj's tuning of 2026-10-12). A tab is shown here only once the
// Launchpad holds it. Closed on every page load; what it shows is
// browser-panel-view.ts. A closed panel mounts no frame, so it streams and
// reads nothing. It slides in and out, and its left edge drags it wider or
// narrower, up to all of the room with the page stepped aside (Matěj
// 2026-10-12; layout-view.ts). Below 1100 px it covers the window like a
// sheet and what lies behind it is inert.
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
  const app = find<HTMLElement>("#app");
  const sidebar = find<HTMLElement>("#sidebar");
  const panel = find<HTMLElement>("#browser-panel");
  const divider = find<HTMLElement>("#browser-divider");
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
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const words = () => newTabCopy(options.locale());

  let open = false;
  /** While the closed panel slides out: it stays drawn, inert, until this
   * timer hides it. */
  let leaving: ReturnType<typeof setTimeout> | undefined;
  /** The width the person dragged the panel to, kept in this browser. */
  let wish: PanelWish | null = readLayout().panel;
  /** Where the open panel is now; null on the sheet and before it opens. */
  let place: PanelPlace | null = null;
  let state: StripState = emptyStrip;
  /** What the body shows: one tab's view, or one Nová karta of the strip. */
  let surface:
    | Readonly<{ kind: "frame"; tab: string; node: HTMLIFrameElement }>
    | Readonly<{ kind: "new"; key: string; node: HTMLElement }>
    | null = null;
  /** The tab whose × let go of the strip's last entry and so closed the
   * panel: Vrátit opens the panel on it again while it stays closed. */
  let closedOn: string | null = null;
  // Whether the sheet makes the rest of the page inert now: changed only
  // here, so the column's own sheet keeps its inert page.
  let covering = false;
  let drawnStrip = "";
  let pending: PendingUndo | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  /** A short message, and what Zkusit znovu does when it can help. */
  let note: Readonly<{ text: string; retry: (() => void) | null }> | null =
    null;
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
    const shownKey = shown === null ? null : entryKey(shown);
    const signature = JSON.stringify([
      entries.map((entry) =>
        entry.kind === "new"
          ? ["new", entry.key]
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
        const key = entryKey(entry);
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
        // Every entry has its ×, a Nová karta too (Matěj 2026-10-12).
        const shut = element("button", "browser-tab-close");
        shut.type = "button";
        shut.dataset.focusKey = `close:${key}`;
        if (entry.kind === "new") {
          shut.setAttribute("aria-label", copy.closeNewTab);
          shut.title = copy.closeNewTab;
          shut.addEventListener("click", () => closeNewTab(entry.key));
        } else {
          // The Launchpad lets go; the tab stays in the Environment and in
          // Přehled while anything still needs it, so no warning.
          shut.setAttribute("aria-label", fill(copy.closeTab, { title }));
          shut.title = copy.closeInLaunchpad;
          shut.addEventListener("click", () => void releaseTab(entry));
        }
        shut.append(svg("x"));
        tab.append(main, shut);
        return tab;
      }),
    );
    // The focus stays where it was; on an entry that went it moves to the
    // entry shown now, so the keyboard stays in the strip.
    if (focused?.startsWith("tab:") || focused?.startsWith("close:"))
      (
        tablist.querySelector<HTMLElement>(
          `[data-focus-key="${CSS.escape(focused)}"]`,
        ) ??
        tablist.querySelector<HTMLElement>(
          ".browser-tab.is-active .browser-tab-main",
        )
      )?.focus({ preventScroll: true });
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
   * recorded origin, or that entry's own Nová karta; nothing while the
   * panel is closed or the strip empty. Only the shown entry is mounted, so
   * the strip's other Nová karta entries cost nothing. The sentence instead
   * of a frame, or null. */
  function drawSurface(shown: StripEntry | null): string | null {
    // Sliding out, the panel keeps what it showed until it is hidden.
    if (leaving !== undefined) return null;
    const origin = options.origin();
    if (!open || origin === null || shown === null) {
      removeSurface();
      return null;
    }
    if (shown.kind === "new") {
      if (surface?.kind === "new" && surface.key === shown.key) {
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
      surface = { kind: "new", key: shown.key, node };
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
    const model = toastModel(pending, note?.text ?? null, words());
    const target = open ? toastSlot : toastRegion;
    (open ? toastRegion : toastSlot).replaceChildren();
    if (model === null) {
      target.replaceChildren();
      return;
    }
    // A message above the line of the tab taken away, each with its own
    // action: Zkusit znovu beside the message, Vrátit beside its line.
    const toast = element("div", "browser-toast");
    const retry = note?.retry ?? null;
    if (model.note !== null) {
      const line = element(
        "div",
        `browser-toast-line${model.text === null ? "" : " is-note"}`,
      );
      line.append(element("span", "", model.note));
      if (retry !== null) {
        const again = element("button", "browser-toast-action", words().retry);
        again.type = "button";
        again.addEventListener("click", () => {
          clearTimeout(noteTimer);
          note = null;
          drawToast();
          retry();
        });
        line.append(again);
      }
      toast.append(line);
    }
    if (model.text !== null) {
      const line = element("div", "browser-toast-line");
      line.append(element("span", "", model.text));
      if (model.undo !== null) {
        const undo = element("button", "browser-toast-action", model.undo);
        undo.type = "button";
        undo.addEventListener("click", () => void restore());
        line.append(undo);
      }
      toast.append(line);
    }
    target.replaceChildren(toast);
  }

  function draw(force = false) {
    panel.hidden = !open && leaving === undefined;
    for (const toggle of toggles)
      toggle.setAttribute("aria-expanded", String(open));
    const shown = shownEntry(state);
    if (open) drawStrip(force);
    const sentence = drawSurface(shown);
    message.hidden = sentence === null;
    message.textContent = sentence ?? "";
    const origin = options.origin();
    const view =
      shown?.kind === "tab" && origin !== null
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

  // ---- Holding, letting go and Vrátit -----------------------------------

  /** Vrátit for `next` until `until` (this browser's clock), or none. */
  function setPending(next: PendingUndo | null, until = 0) {
    clearTimeout(pendingTimer);
    pending = next;
    if (next !== null)
      pendingTimer = setTimeout(
        () => {
          pending = null;
          drawToast();
        },
        Math.max(0, until - Date.now()),
      );
    drawToast();
  }

  /** A short message; with `retry`, Zkusit znovu beside it, and it stays
   * long enough to take it. */
  function say(text: string, retry: (() => void) | null = null) {
    note = { text, retry };
    drawToast();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(
      () => {
        note = null;
        drawToast();
      },
      retry === null ? noteMs : actionNoteMs,
    );
  }

  /** The Launchpad holds a tab (F47 point 4), and only then `held()`; a hold
   * that failed says why, with Zkusit znovu where trying again can help.
   * `gone` says that the tab no longer exists. */
  async function holdThen(tab: string, held: () => void, gone?: string) {
    const answer = await options.transport("POST", "/api/new-tab/hold", {
      tab,
    });
    if (holdSucceeded(answer)) {
      held();
      void poll();
      return;
    }
    const failure = holdFailure(answer, words(), gone);
    say(
      failure.text,
      failure.retry ? () => void holdThen(tab, held, gone) : null,
    );
  }

  /** × on a Nová karta (Matěj 2026-10-12): that entry goes, with nothing
   * to let go of and no Vrátit; on the strip's last entry the panel
   * closes. */
  function closeNewTab(key: string) {
    dispatch({ kind: "close-new-tab", key });
    if (closesPanel(state)) hide(true);
  }

  /** × on a tab lets go of the Launchpad's hold (F47 point 9's addendum of
   * 2026-10-12): the tab goes from the strip at once and stays gone until
   * the release is done and a later overview says so, or comes back when it
   * fails; on the strip's last entry the panel closes. The toast says what
   * happens to the tab, as the overview told, and Vrátit holds it again
   * while the hub's grace (8 s from the request, the earliest the grace can
   * begin) lasts. */
  async function releaseTab(entry: Extract<StripEntry, { kind: "tab" }>) {
    const shown = shownEntry(state);
    const wasShown = shown?.kind === "tab" && shown.id === entry.id;
    const text = releaseText(entry.tab, words());
    dispatch({ kind: "releasing", tab: entry.id });
    if (closesPanel(state)) {
      hide(true);
      closedOn = entry.id;
    }
    const sentAt = Date.now();
    const answer = await options.transport("POST", "/api/new-tab/release", {
      tab: entry.id,
    });
    if (releaseSucceeded(answer)) {
      dispatch({ kind: "released", tab: entry.id });
      // An answer later than the grace says what happened, without Vrátit.
      const until = sentAt + closeGraceMs;
      if (until > Date.now())
        setPending({ tab: entry.id, text, shown: wasShown }, until);
      else say(text);
    } else {
      dispatch({ kind: "release-failed", tab: entry.id });
      say(actionFailure(answer, words().releaseFailed, words()));
    }
    void poll();
  }

  /** Vrátit: the Launchpad holds the tab again, shown again where it was
   * shown when released. When its × closed the panel and the panel stayed
   * closed, Vrátit opens it on the tab: it undoes the × whole. */
  async function restore() {
    const released = pending;
    if (released === null) return;
    setPending(null);
    await holdThen(
      released.tab,
      () => {
        const reopen = !open && closedOn === released.tab;
        dispatch({
          kind: "held-again",
          tab: released.tab,
          show: released.shown && (open || reopen),
        });
        if (reopen) show();
      },
      words().restoreFailed,
    );
  }

  // ---- What the frames say -------------------------------------------------

  // Nová karta's choice: a page it opened, which the Launchpad already holds
  // (its open), shows in the panel; a tab chosen in its Přehled shows once
  // the Launchpad holds it too. The Nová karta it was made in goes from the
  // strip: the one shown when the choice came, whatever is shown once the
  // hold is done. The Launchpad has no tools.
  body.addEventListener(newTabEventName, (event) => {
    const choice = panelChoice((event as CustomEvent<unknown>).detail);
    if (choice === null) return;
    const from = surface?.kind === "new" ? surface.key : null;
    const chosen = () => dispatch({ kind: "chosen", tab: choice.tab, from });
    if (choice.kind === "tab") void holdThen(choice.tab, chosen);
    else {
      chosen();
      void poll();
    }
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
    // A page's new tab viewed here shows once the Launchpad holds it (F47
    // point 4); until then the view that opened it stays.
    if (said.kind === "new-tab")
      void holdThen(said.tab, () =>
        dispatch({ kind: "show", tab: said.tab, url: said.url }),
      );
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

  // ---- Opening and closing the panel -----------------------------------------

  // The Browser toggle slides the panel in and out (Matěj 2026-10-12): it
  // slides in by its stylesheet's animation whenever it is shown again, and
  // out for as long below, before it is hidden and drops its frame. With
  // reduced motion it just appears and goes.
  const motionMs = 200;

  function slideOut() {
    if (reducedMotion.matches) return;
    panel.classList.add("is-leaving");
    panel.inert = true;
    leaving = setTimeout(() => {
      stopSliding();
      draw();
    }, motionMs);
  }

  /** The panel shows again while it slides out, or has gone. */
  function stopSliding() {
    clearTimeout(leaving);
    leaving = undefined;
    panel.classList.remove("is-leaving");
    panel.inert = false;
  }

  // Its left edge drags the panel wider or narrower (Matěj 2026-10-12), up
  // to all of the room right of the rail and the column, the page then
  // stepped aside (`data-browser="wide"`); layout-view.ts decides where it
  // goes, and this browser keeps the person's width.

  /** The room the page and the panel share. */
  const room = () => app.clientWidth - sidebar.offsetWidth;
  let placed = "";

  /** Places the open panel beside the page, or over all of the room. A
   * closing panel gives the page back at once and keeps its width while it
   * slides out; the sheet below 1100 px is placed by its stylesheet. */
  function relayout() {
    if (!open || sheet.matches) {
      place = null;
      placed = "";
      delete app.dataset.browser;
      return;
    }
    place = placePanel(room(), wish);
    const key = `${place.mode} ${place.width} ${place.max}`;
    if (key === placed) return;
    placed = key;
    panel.style.setProperty("--browser-panel-width", `${place.width}px`);
    app.dataset.browser = place.mode;
    showDividerRange(divider, place);
  }

  /** Keeps where the person left the panel, in this browser. */
  function keep() {
    if (place === null) return;
    wish = panelWish(place);
    writeLayout({ panel: wish });
  }

  attachDivider(divider, {
    grows: "left",
    width: () => place?.width ?? 0,
    drag: (width) => {
      wish = dragPanel(room(), width);
      relayout();
    },
    key: (key) => {
      const next = place === null ? null : keyPanel(place, key);
      if (next === null) return false;
      wish = next;
      relayout();
      keep();
      return true;
    },
    done: keep,
    reset: () => {
      wish = null;
      writeLayout({ panel: null });
      relayout();
    },
  });
  // The room changes with the window, and with the column hidden, shown or
  // dragged.
  window.addEventListener("resize", () => relayout());
  new ResizeObserver(() => relayout()).observe(sidebar);

  function show() {
    if (open || options.origin() === null) return;
    stopSliding();
    open = true;
    closedOn = null;
    relayout();
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
    stopSliding();
    open = true;
    closedOn = null;
    relayout();
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
    relayout();
    clearTimeout(pollTimer);
    pollTimer = undefined;
    // A hidden strip loses its scroll: the next opening draws it anew, with
    // the shown entry in view.
    drawnStrip = "";
    slideOut();
    draw();
    // Back to the toggle of the page shown.
    if (returnFocus)
      toggles.find((toggle) => toggle.offsetParent !== null)?.focus();
    options.changed();
  }

  for (const toggle of toggles)
    toggle.addEventListener("click", () => (open ? hide(false) : show()));
  close.addEventListener("click", () => hide(true));
  // "+" always adds a Nová karta and shows it, as Chrome does; the one shown
  // before stays in the strip as it was (Matěj 2026-10-12).
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
  sheet.addEventListener("change", () => {
    relayout();
    draw();
  });

  function relabel() {
    const copy = options.copy();
    const own = words();
    divider.setAttribute("aria-label", copy.browserWidth);
    divider.title = copy.dividerHint;
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
