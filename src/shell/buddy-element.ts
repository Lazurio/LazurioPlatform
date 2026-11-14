import type { Store } from "./account";
import type { BuddyBubbleModel } from "./buddy-bubble";
import {
  type BuddyBox,
  type BuddyPlace,
  buddyBeside,
  buddyBoxOf,
  buddyDragThreshold,
  buddyEdge,
  buddyNudge,
  buddyPlaceOf,
  buddyStep,
  readBuddyPlace,
  writeBuddyPlace,
} from "./buddy-place";
import {
  buddyBubbleCss,
  buddyLauncherClearance,
  buddyLauncherOffset,
  buddyLauncherSize,
  buddyPanelSize,
} from "./buddy-styles";
import { icon } from "./icons";

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
// Before the person met Buddy (F60's addendum of 2026-10-26) the launcher
// carries a "1" and the window holds his hello and one action, a real link
// to Začínáme, instead of the frame. While the Launchpad's dialog shows where
// Buddy is, the launcher itself rises over that dialog's top layer as a
// manual popover with a ring around it: inert, as the page behind a modal
// dialog is, so the dialog keeps the focus and its Escape.
//
// The person moves him (F60's addendum of 2026-11-14, buddy-place.ts): a
// drag puts him anywhere on the window, and this app remembers the place; a
// click opens his window as before, and the arrows move him while he has the
// focus, Home back to his corner. Away from his corner he stands at the
// `left` and `top` the place gives, his panel opens beside him, and the page
// no longer keeps the corner free; in it everything is as before. While the
// Launchpad lifts him over its dialog he is not dragged.

/** His window's name for assistive technology: his name, the same in every
 * language, also while the launcher says more. */
const buddyWindowName = "Buddy";

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
 * on the page in its corner, as the rail keeps `--lazurio-rail-width`:
 * written when it appears there and removed when it goes (its bubble gone,
 * its element hidden, or the person moved him away), never in between,
 * since the bubble watches the document's style for the colour scheme. */
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
    /** The launcher's click, and the close button of his window before
     * the meeting. */
    toggle: () => void;
    /** Escape on the host's page while the bubble has the focus, or the
     * full screen's cancel; whether it was the bubble's. */
    escape: () => boolean;
    /** A click on the action of his window before the meeting, a link to
     * Začínáme: the element announces a link on its own origin and closes
     * the window. */
    follow: (href: string, event: MouseEvent) => void;
    /** This app's memory (`localStorage`), where his place is kept; null
     * keeps it for this page only. */
    store: Store | null;
  }>,
): BuddyBubbleView {
  const logoUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(options.logo)}`;
  let parts: ReturnType<typeof build> | null = null;
  let frame: HTMLIFrameElement | null = null;
  let avatar: string | null = null;
  const clearance = launcherClearance(host.ownerDocument.documentElement.style);
  const win = host.ownerDocument.defaultView;
  const size = Object.freeze({
    width: buddyLauncherSize,
    height: buddyLauncherSize,
  });
  // His place in this app, his corner as last measured there, whether the
  // launcher is on the page, the drag under way, and until when a click is
  // the end of a drag rather than the person's.
  let place: BuddyPlace = readBuddyPlace(options.store);
  let home: BuddyBox | null = null;
  let onPage = false;
  let drag: {
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
    lastX: number;
    moved: boolean;
  } | null = null;
  let swallowUntil = 0;

  const view = () => ({
    width: win?.innerWidth ?? 0,
    height: win?.innerHeight ?? 0,
  });
  const boxOf = (element: Element): BuddyBox => {
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  /** His corner as measured there, else as the defaults place it. */
  const homeBox = (): BuddyBox => {
    const { width, height } = view();
    return (
      home ?? {
        left: width - buddyLauncherOffset.right - size.width,
        top: height - buddyLauncherOffset.bottom - size.height,
        ...size,
      }
    );
  };

  /** Puts the launcher at his place, the panel beside him, and the page's
   * clearance only while he is in his corner. */
  function applyPlace(): void {
    clearance(onPage && place === "home");
    if (parts === null) return;
    const { launcher } = parts;
    if (place === "home") {
      for (const side of ["left", "top", "right", "bottom"])
        launcher.style.removeProperty(side);
      delete launcher.dataset.moved;
      if (launcher.getBoundingClientRect().width > 0) home = boxOf(launcher);
    } else {
      const box = buddyBoxOf(place, size, view(), homeBox());
      launcher.style.left = `${box.left}px`;
      launcher.style.top = `${box.top}px`;
      launcher.style.right = "auto";
      launcher.style.bottom = "auto";
      launcher.dataset.moved = "";
    }
    placePanel();
  }

  /** The panel beside him away from his corner; in it, and in full screen,
   * the stylesheet's own place. */
  function placePanel(): void {
    if (parts === null) return;
    const { dialog, launcher } = parts;
    const modal = (() => {
      try {
        return dialog.matches(":modal");
      } catch {
        return false;
      }
    })();
    if ((place === "home" && drag?.moved !== true) || modal || !dialog.open) {
      for (const side of ["left", "top", "right", "bottom", "width", "height"])
        dialog.style.removeProperty(side);
      return;
    }
    const at = buddyBeside(
      boxOf(launcher),
      buddyPanelSize,
      buddyPanelSize.gap,
      view(),
      true,
    );
    dialog.style.left = `${at.left}px`;
    dialog.style.top = `${at.top}px`;
    dialog.style.width = `${at.width}px`;
    dialog.style.height = `${at.height}px`;
    dialog.style.right = "auto";
    dialog.style.bottom = "auto";
  }

  /** He lands where he was put: a short squash, played again each time. */
  function land(figure: HTMLElement): void {
    delete figure.dataset.landed;
    void figure.offsetWidth;
    figure.dataset.landed = "";
  }

  function settle(next: BuddyPlace): void {
    place = next;
    writeBuddyPlace(options.store, place);
    applyPlace();
    if (parts !== null) land(parts.figure);
  }

  function listenMoves(launcher: HTMLButtonElement, figure: HTMLElement) {
    launcher.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || launcher.dataset.spot !== undefined) return;
      const at = boxOf(launcher);
      if (place === "home") home = at;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: at.left,
        top: at.top,
        lastX: event.clientX,
        moved: false,
      };
      // Held from the press on, so a quick flick that leaves him at once
      // still drags him.
      try {
        launcher.setPointerCapture(event.pointerId);
      } catch {}
    });
    launcher.addEventListener("pointermove", (event) => {
      if (drag === null || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < buddyDragThreshold) return;
        drag.moved = true;
        launcher.dataset.drag = "";
        clearance(false);
      }
      // He leans the way he is pulled, a little.
      const tilt = Math.max(
        -14,
        Math.min(14, (event.clientX - drag.lastX) * 1.5),
      );
      drag.lastX = event.clientX;
      const { width, height } = view();
      const left = Math.max(
        buddyEdge,
        Math.min(drag.left + dx, width - size.width - buddyEdge),
      );
      const top = Math.max(
        buddyEdge,
        Math.min(drag.top + dy, height - size.height - buddyEdge),
      );
      launcher.style.left = `${left}px`;
      launcher.style.top = `${top}px`;
      launcher.style.right = "auto";
      launcher.style.bottom = "auto";
      launcher.style.setProperty("--buddy-tilt", `${tilt}deg`);
      placePanel();
    });
    const end = (event: PointerEvent, put: boolean) => {
      const was = drag;
      if (was === null || was.id !== event.pointerId) return;
      drag = null;
      if (!was.moved) return;
      delete launcher.dataset.drag;
      launcher.style.removeProperty("--buddy-tilt");
      // A browser may still click at the end of a drag; that is no click of
      // the person's.
      swallowUntil = performance.now() + 250;
      if (!put) {
        applyPlace();
        return;
      }
      settle(
        buddyPlaceOf(
          was.left + event.clientX - was.x,
          was.top + event.clientY - was.y,
          size,
          view(),
          homeBox(),
        ),
      );
    };
    launcher.addEventListener("pointerup", (event) => end(event, true));
    launcher.addEventListener("pointercancel", (event) => end(event, false));
    launcher.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (launcher.dataset.spot !== undefined) return;
      const step = event.shiftKey ? 4 * buddyStep : buddyStep;
      const moves: Record<string, readonly [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (event.key === "Home") {
        event.preventDefault();
        settle("home");
        return;
      }
      const move = moves[event.key];
      if (move === undefined) return;
      event.preventDefault();
      settle(buddyNudge(place, move[0], move[1], size, view(), homeBox()));
    });
    figure.addEventListener("animationend", (event) => {
      if (event.animationName === "buddy-land") delete figure.dataset.landed;
    });
    win?.addEventListener("resize", () => applyPlace());
  }

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
    // His figure stands free on its ground; it lifts, leans and lands
    // without moving the launcher's box.
    const figure = document.createElement("span");
    figure.className = "figure";
    const picture = document.createElement("img");
    picture.alt = "";
    picture.decoding = "async";
    picture.draggable = false;
    picture.addEventListener("error", () => {
      if (picture.src === logoUrl) return;
      launcher.dataset.fallback = "";
      picture.src = logoUrl;
    });
    // Before the meeting: his "1", which the label says in words.
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.setAttribute("aria-hidden", "true");
    badge.hidden = true;
    figure.append(picture);
    launcher.append(figure, badge);
    launcher.addEventListener("click", () => {
      if (performance.now() < swallowUntil) return;
      options.toggle();
    });
    listenMoves(launcher, figure);
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
    // His window before the meeting: his hello and the one action, drawn
    // here from the model's words, never from the frame.
    const meet = document.createElement("section");
    meet.className = "meet";
    meet.hidden = true;
    const head = document.createElement("div");
    head.className = "meet-head";
    const name = document.createElement("strong");
    name.textContent = "Buddy";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "meet-close";
    close.append(icon("xmark", 18));
    close.addEventListener("click", () => options.toggle());
    head.append(name, close);
    const talk = document.createElement("div");
    talk.className = "meet-talk";
    const face = document.createElement("img");
    face.className = "meet-face";
    face.alt = "";
    face.decoding = "async";
    face.draggable = false;
    face.addEventListener("error", () => {
      if (face.src !== logoUrl) face.src = logoUrl;
    });
    const hello = document.createElement("p");
    hello.className = "meet-line";
    const line = document.createElement("p");
    line.className = "meet-line";
    talk.append(face, hello, line);
    const action = document.createElement("a");
    action.className = "meet-action";
    action.addEventListener("click", (event) =>
      options.follow(action.href, event),
    );
    meet.append(head, talk, action);
    dialog.append(meet);
    bubble.append(dialog, launcher);
    // Before the guide's layer, which plays over the bubble.
    root.prepend(bubble);
    return {
      bubble,
      dialog,
      launcher,
      figure,
      picture,
      badge,
      meet: { section: meet, close, face, hello, line, action },
    };
  }

  /** The launcher over the page's own top layer while the Launchpad's dialog
   * shows where Buddy is: a manual popover, shown after that dialog, so it
   * stands above it; never where the browser has no popovers. */
  function lift(launcher: HTMLButtonElement, on: boolean) {
    const open = (() => {
      try {
        return launcher.matches(":popover-open");
      } catch {
        return false;
      }
    })();
    if (on) {
      launcher.dataset.spot = "";
      if (open || typeof launcher.showPopover !== "function") return;
      launcher.setAttribute("popover", "manual");
      try {
        launcher.showPopover();
      } catch {}
      return;
    }
    delete launcher.dataset.spot;
    if (open)
      try {
        launcher.hidePopover();
      } catch {}
    launcher.removeAttribute("popover");
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
      onPage = launcherOnPage(model, host);
      clearance(onPage && place === "home");
      if (model === null) {
        parts?.bubble.remove();
        parts = null;
        frame = null;
        avatar = null;
        return;
      }
      parts ??= build();
      const { dialog, launcher, picture, badge, meet } = parts;
      if (avatar !== model.launcher.avatar) {
        avatar = model.launcher.avatar;
        delete launcher.dataset.fallback;
        picture.src = avatar;
        meet.face.src = avatar;
      }
      launcher.setAttribute("aria-label", model.launcher.label);
      launcher.setAttribute("aria-expanded", String(model.launcher.expanded));
      if (model.launcher.away) launcher.dataset.away = "";
      else delete launcher.dataset.away;
      badge.hidden = model.launcher.badge === null;
      // Something new waits for the person: he hops now and then.
      if (model.launcher.badge !== null) launcher.dataset.calling = "";
      else delete launcher.dataset.calling;
      badge.textContent = model.launcher.badge ?? "";
      lift(launcher, model.launcher.spot);
      dialog.setAttribute("aria-label", buddyWindowName);
      // Before the meeting: his hello in place of the frame, which stays
      // hidden where it exists.
      meet.section.hidden = model.meeting === null;
      dialog.dataset.meeting = model.meeting === null ? "" : "shown";
      if (model.meeting !== null) {
        meet.hello.textContent = model.meeting.hello;
        meet.line.textContent = model.meeting.line;
        meet.action.textContent = model.meeting.action;
        meet.action.href = model.meeting.href;
        meet.close.setAttribute("aria-label", model.meeting.close);
        meet.close.title = model.meeting.close;
      }
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
      if (drag?.moved !== true) applyPlace();
    },
    frameWindow: () => frame?.contentWindow ?? null,
    focus(target: "launcher" | "frame"): void {
      if (target === "launcher") parts?.launcher.focus({ preventScroll: true });
      else if (parts !== null && !parts.meet.section.hidden)
        parts.meet.action.focus({ preventScroll: true });
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
