import type { BuddyBubbleModel } from "./buddy-bubble";
import { buddyBubbleCss, buddyLauncherClearance } from "./buddy-styles";

// How Buddy's bubble is drawn (decision F60): in `<lazurio-buddy>`'s own
// shadow root, made only when the page's document first names Buddy's origin
// (buddy-bubble.ts decides what, this draws it). The launcher is a button
// (`aria-expanded`, `aria-controls` the window) with Buddy's picture, which
// his origin serves; where it does not load (no session at the Osobní
// Prostředí in this browser, a network that does not reach it) the launcher
// shows the neutral guide's mark. The window is one `<dialog>` that holds the
// frame from its first open for as long as the origin stays: shown beside
// the page as the panel (`show`), as a modal over it in full screen
// (`showModal`, so the page behind is inert and Escape asks to return), and
// closed with the frame kept alive inside (a frame moved to another parent
// would load again). Full screen covers the whole window, so the way back
// is Escape or the frame's own control. The guide's layer stands after the
// bubble in the same shadow root (guide-layer.ts); while Buddy is out of the
// launcher presenting an explanation, the launcher waits empty (`data-away`,
// decision F56's addendum (7) of 2026-10-25). While the launcher is
// drawn the page keeps its corner free: `--lazurio-buddy-clearance` on the
// document says how wide it is (decision F60's addendum of 2026-10-25).

/** The property on the document that says how wide the launcher's corner
 * is, for a page whose controls reach it. */
export const buddyClearanceProperty = "--lazurio-buddy-clearance";

/** Whether the launcher is on the page: drawn, and its element not hidden
 * by the host (the standard `hidden`, interface v1), which the element's
 * styles honour with `display: none`. */
export const launcherOnPage = (
  model: BuddyBubbleModel | null,
  host: Readonly<{ hidden: boolean | string }>,
): boolean => model !== null && !host.hidden;

/** Keeps `--lazurio-buddy-clearance` on the document while the launcher is
 * on the page, as the rail keeps `--lazurio-rail-width`: written when the
 * launcher appears and removed when it goes (its bubble gone, or its element
 * hidden), never in between, since the bubble watches the document's style
 * for the colour scheme. */
export function launcherClearance(
  style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">,
): (drawn: boolean) => void {
  let kept = false;
  return (drawn) => {
    if (drawn === kept) return;
    kept = drawn;
    if (drawn)
      style.setProperty(buddyClearanceProperty, buddyLauncherClearance);
    else style.removeProperty(buddyClearanceProperty);
  };
}

export type BuddyBubbleView = Readonly<{
  /** Draws the model; null removes the bubble (the shadow root stays, as
   * the guide's). */
  draw(model: BuddyBubbleModel | null): void;
  /** The frame's window; null before the frame is made. */
  frameWindow(): Window | null;
  /** Moves the focus to the launcher or into the frame. */
  focus(target: "launcher" | "frame"): void;
  /** The launcher's centre on the screen, where the guide's figure starts
   * and ends; null without it. */
  home(): Readonly<{ x: number; y: number }> | null;
}>;

export function createBuddyBubbleView(
  host: HTMLElement,
  options: Readonly<{
    /** The Lazurio symbol (SVG text), the launcher's mark without Buddy's
     * picture. */
    logo: string;
    /** The launcher's click. */
    toggle: () => void;
    /** Escape on the host's page while the bubble has the focus, or the
     * full screen's cancel; whether it was the bubble's. */
    escape: () => boolean;
  }>,
): BuddyBubbleView {
  const logoUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(options.logo)}`;
  let parts: ReturnType<typeof build> | null = null;
  let frame: HTMLIFrameElement | null = null;
  let avatar: string | null = null;
  const clearance = launcherClearance(host.ownerDocument.documentElement.style);

  function build() {
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(buddyBubbleCss);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const dialog = document.createElement("dialog");
    dialog.className = "window";
    dialog.id = "lazurio-buddy-window";
    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "launcher";
    launcher.setAttribute("aria-haspopup", "dialog");
    launcher.setAttribute("aria-controls", dialog.id);
    launcher.setAttribute("aria-expanded", "false");
    const picture = document.createElement("img");
    picture.alt = "";
    picture.decoding = "async";
    picture.draggable = false;
    picture.addEventListener("error", () => {
      if (picture.src === logoUrl) return;
      launcher.dataset.fallback = "";
      picture.src = logoUrl;
    });
    launcher.append(picture);
    launcher.addEventListener("click", () => options.toggle());
    bubble.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (options.escape()) event.preventDefault();
    });
    // Full screen's Escape: the dialog would close; the bubble decides,
    // after the browser's own step, which closes it anyway when it does not
    // let the page keep it (a second Escape without an interaction).
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      setTimeout(() => options.escape(), 0);
    });
    bubble.append(dialog, launcher);
    // Before the guide's layer, which plays over the bubble.
    root.prepend(bubble);
    return { bubble, dialog, launcher, picture };
  }

  function layout(dialog: HTMLDialogElement, next: BuddyBubbleModel["layout"]) {
    const modal = dialog.matches(":modal");
    try {
      if (next === "closed") {
        if (dialog.open) dialog.close();
      } else if (next === "panel") {
        if (modal) dialog.close();
        if (!dialog.open) dialog.show();
      } else {
        if (dialog.open && !modal) dialog.close();
        if (!dialog.open) dialog.showModal();
      }
    } catch {
      // A dialog of a page that is going away: nothing to draw.
    }
    dialog.dataset.layout = next;
  }

  return Object.freeze({
    draw(model: BuddyBubbleModel | null): void {
      clearance(launcherOnPage(model, host));
      if (model === null) {
        parts?.bubble.remove();
        parts = null;
        frame = null;
        avatar = null;
        return;
      }
      parts ??= build();
      const { dialog, launcher, picture } = parts;
      if (avatar !== model.launcher.avatar) {
        avatar = model.launcher.avatar;
        delete launcher.dataset.fallback;
        picture.src = avatar;
      }
      launcher.setAttribute("aria-label", model.launcher.label);
      launcher.setAttribute("aria-expanded", String(model.launcher.expanded));
      if (model.launcher.away) launcher.dataset.away = "";
      else delete launcher.dataset.away;
      dialog.setAttribute("aria-label", model.launcher.label);
      if (model.frame === null) {
        frame?.remove();
        frame = null;
      } else if (frame === null) {
        // Made once, with exactly these attributes, and never moved.
        const made = document.createElement("iframe");
        made.title = model.frame.title;
        made.setAttribute("sandbox", model.frame.sandbox);
        made.setAttribute("referrerpolicy", model.frame.referrerpolicy);
        made.setAttribute("allow", model.frame.allow);
        made.src = model.frame.src;
        dialog.append(made);
        frame = made;
      }
      layout(dialog, model.layout);
    },
    frameWindow: () => frame?.contentWindow ?? null,
    focus(target: "launcher" | "frame"): void {
      if (target === "launcher") parts?.launcher.focus({ preventScroll: true });
      else frame?.focus({ preventScroll: true });
    },
    home() {
      if (parts === null) return null;
      const box = parts.launcher.getBoundingClientRect();
      return box.width === 0
        ? null
        : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    },
  });
}
