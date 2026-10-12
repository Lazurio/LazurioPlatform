import {
  type DividerKey,
  defaultLayout,
  layoutKey,
  layoutText,
  parseLayout,
  type StoredLayout,
} from "./layout-view";

// The Launchpad's layout in this browser (Matěj's tuning of the Launchpad's
// panel, 2026-10-12; layout-view.ts decides it): where the person's layout
// is kept, and the divider a panel is dragged by.

/** The person's layout as this browser keeps it; the default where storage
 * cannot be read. */
export function readLayout(): StoredLayout {
  try {
    return parseLayout(localStorage.getItem(layoutKey));
  } catch {
    return defaultLayout;
  }
}

/** Keeps `change` over the layout stored now. A browser that keeps nothing
 * (storage off or full) keeps the layout for this page only. */
export function writeLayout(change: Partial<StoredLayout>): void {
  try {
    localStorage.setItem(layoutKey, layoutText({ ...readLayout(), ...change }));
  } catch {}
}

/** A divider (as T3 Code's and Codex Desktop's): the edge of a panel, a
 * focusable window splitter (WAI-ARIA `separator`, its value the panel's
 * width). The pointer drags it, captured, so that it keeps the pointer over
 * the page and the frames; the arrow keys move it (Shift for bigger steps),
 * Home and End take the panel to its least and greatest width, and a
 * double-click goes back to the default. While it drags, no frame takes the
 * pointer and nothing is selected (`is-resizing` on the root). */
export function attachDivider(
  divider: HTMLElement,
  options: Readonly<{
    /** Which way the panel grows: the right panel as its divider moves
     * left. */
    grows: "left" | "right";
    /** The panel's width now. */
    width: () => number;
    /** The width the pointer asks for while it drags. */
    drag: (width: number) => void;
    /** A key; whether it did anything (layout-view.ts decides what). */
    key: (key: DividerKey) => boolean;
    /** The drag ended: keep what it reached. */
    done: () => void;
    /** A double-click: the default width again, nothing kept. */
    reset: () => void;
  }>,
): void {
  const root = document.documentElement;
  let drag: Readonly<{ pointer: number; x: number; width: number }> | null =
    null;
  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag !== null) return;
    event.preventDefault();
    drag = {
      pointer: event.pointerId,
      x: event.clientX,
      width: options.width(),
    };
    try {
      divider.setPointerCapture(event.pointerId);
    } catch {
      // A pointer no longer down cannot be captured; its drag ends by itself.
    }
    root.classList.add("is-resizing");
    divider.classList.add("is-dragging");
  });
  divider.addEventListener("pointermove", (event) => {
    if (drag === null || event.pointerId !== drag.pointer) return;
    const moved = event.clientX - drag.x;
    options.drag(drag.width + (options.grows === "left" ? -moved : moved));
  });
  const end = (event: PointerEvent) => {
    if (drag === null || event.pointerId !== drag.pointer) return;
    drag = null;
    root.classList.remove("is-resizing");
    divider.classList.remove("is-dragging");
    if (divider.hasPointerCapture(event.pointerId))
      divider.releasePointerCapture(event.pointerId);
    options.done();
  };
  divider.addEventListener("pointerup", end);
  divider.addEventListener("pointercancel", end);
  divider.addEventListener("lostpointercapture", end);
  divider.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing)
      return;
    if (options.key({ key: event.key, shift: event.shiftKey }))
      event.preventDefault();
  });
  divider.addEventListener("dblclick", () => options.reset());
}

/** The divider's value: the panel's width and its range, in whole
 * pixels. */
export function showDividerRange(
  divider: HTMLElement,
  place: Readonly<{ width: number; min: number; max: number }>,
): void {
  divider.setAttribute("aria-valuemin", String(Math.round(place.min)));
  divider.setAttribute("aria-valuemax", String(Math.round(place.max)));
  divider.setAttribute("aria-valuenow", String(Math.round(place.width)));
}
