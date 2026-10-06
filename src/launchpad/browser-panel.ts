import {
  type BrowserPanelState,
  browserFrame,
  browserPanelView,
  readBrowserView,
} from "./browser-panel-view";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// The right panel's DOM (decision F38's addendum of 2026-10-05): the Browser
// toggle in the head of each page (the Apps home beside Guide, the header of
// Settings and Files, the Marketplace; one shown at a time) and the panel
// after the page in the `.app` row, so the page shrinks. Closed on every
// page load; nothing is remembered. What it shows is browser-panel-view.ts;
// the frame is built anew for every answer and removed when the panel
// closes, so a closed panel streams nothing. Below 1100 px the panel covers
// the window like a sheet and what lies behind it is inert.
export function createBrowserPanel(
  options: Readonly<{
    copy: () => Copy;
    /** The view's origin where the panel is offered, otherwise null
     * (`browserPanelOrigin`). */
    origin: () => string | null;
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
  const body = find<HTMLDivElement>("#browser-body");
  const message = find<HTMLParagraphElement>("#browser-message");
  const reload = find<HTMLButtonElement>("#browser-reload");
  const tab = find<HTMLAnchorElement>("#browser-tab");
  const close = find<HTMLButtonElement>("#browser-close");
  const toggles = [
    ...document.querySelectorAll<HTMLButtonElement>(".browser-toggle"),
  ];
  const behind = ["#rail", "#sidebar", "#nav-toggle", "#page"].map((selector) =>
    find<HTMLElement>(selector),
  );
  const sheet = window.matchMedia("(max-width: 1099px)");

  let open = false;
  let state: BrowserPanelState = { kind: "loading" };
  let frame: HTMLIFrameElement | null = null;
  // Each reading has its number; an answer to an older one, or one that
  // arrives after the panel closed, is dropped.
  let reading = 0;
  // Whether the sheet makes the rest of the page inert now: changed only
  // here, so the column's own sheet keeps its inert page.
  let covering = false;

  // A closed panel is in its first state again, so its link is the
  // hand-over and no address with a token stays in the page.
  function draw() {
    const copy = options.copy();
    const view = browserPanelView(state, copy);
    panel.hidden = !open;
    for (const toggle of toggles)
      toggle.setAttribute("aria-expanded", String(open));
    tab.href = view.tab;
    message.hidden = view.message === null;
    message.textContent = view.message ?? "";
    if (!open || view.frame === null) {
      frame?.remove();
      frame = null;
    } else if (frame === null) {
      frame = document.createElement("iframe");
      frame.className = "browser-frame";
      frame.title = copy.browserFrame;
      for (const [name, value] of Object.entries(browserFrame))
        frame.setAttribute(name, value);
      frame.src = view.frame;
      body.append(frame);
    }
    const cover = open && sheet.matches;
    if (cover !== covering) {
      covering = cover;
      for (const element of behind) element.inert = cover;
    }
  }

  async function load() {
    const origin = options.origin();
    if (!open || origin === null) return;
    reading += 1;
    const mine = reading;
    // The old frame goes first: its token may have rotated.
    state = { kind: "loading" };
    draw();
    const next = await readBrowserView(origin, location.origin);
    if (mine !== reading || !open) return;
    state = next;
    draw();
  }

  function show() {
    if (open || options.origin() === null) return;
    open = true;
    void load();
    heading.focus({ preventScroll: true });
    options.changed();
  }

  function hide(returnFocus: boolean) {
    if (!open) return;
    open = false;
    reading += 1;
    state = { kind: "loading" };
    draw();
    // Back to the toggle of the page shown.
    if (returnFocus)
      toggles.find((toggle) => toggle.offsetParent !== null)?.focus();
    options.changed();
  }

  for (const toggle of toggles)
    toggle.addEventListener("click", () => (open ? hide(false) : show()));
  close.addEventListener("click", () => hide(true));
  reload.addEventListener("click", () => void load());
  // Escape inside the panel closes it, before Settings would take it.
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
      return;
    event.preventDefault();
    hide(true);
  });
  sheet.addEventListener("change", draw);

  function relabel() {
    const copy = options.copy();
    reload.title = copy.browserReload;
    close.title = copy.browserClose;
    if (frame !== null) frame.title = copy.browserFrame;
    draw();
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
  };
}
