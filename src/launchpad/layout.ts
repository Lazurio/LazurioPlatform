import {
  type ColumnPlace,
  type DividerKey,
  defaultLayout,
  keyColumn,
  layoutKey,
  layoutText,
  parseLayout,
  placeColumn,
  type StoredLayout,
} from "./layout-view";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// The Launchpad's layout in this browser (Matěj's tuning of the Launchpad's
// panel, 2026-10-12; layout-view.ts decides it): where the person's layout
// is kept, the divider a panel is dragged by, and the left column hidden,
// shown and dragged. The right panel places itself (browser-panel.ts).

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
     * left, the column as its divider moves right. */
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

/** The left column on a screen 768 px wide or wider (Matěj's tuning of
 * 2026-10-12, as T3 Code's sidebar): the toggle at the start of each page's
 * head (`.column-toggle`; while the page steps aside for the right panel,
 * the one in the panel's strip) hides and shows it, the rail staying, and
 * its right edge drags it wider or narrower. Both stay in this browser.
 * Below 768 px the column is the sheet of shell.ts and none of this shows.
 * The right panel follows the room it leaves. */
export function createColumn(options: Readonly<{ copy: () => Copy }>) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing column UI");
    return element;
  };
  const app = find<HTMLElement>("#app");
  const divider = find<HTMLElement>("#column-divider");
  const toggles = [
    ...document.querySelectorAll<HTMLButtonElement>(".column-toggle"),
  ];
  let layout = readLayout();
  let place: ColumnPlace = placeColumn(app.clientWidth, layout.column);
  let placed = "";

  function draw() {
    place = placeColumn(app.clientWidth, layout.column);
    const key = `${layout.columnHidden} ${place.width} ${place.max}`;
    if (key === placed) return;
    placed = key;
    if (layout.columnHidden) app.dataset.column = "hidden";
    else delete app.dataset.column;
    app.style.setProperty("--column-width", `${place.width}px`);
    showDividerRange(divider, place);
    relabel();
  }

  function relabel() {
    const copy = options.copy();
    const label = layout.columnHidden ? copy.columnShow : copy.columnHide;
    for (const toggle of toggles) {
      toggle.setAttribute("aria-expanded", String(!layout.columnHidden));
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
    }
    divider.setAttribute("aria-label", copy.columnWidth);
    divider.title = copy.dividerHint;
  }

  /** Keeps the column's width where the person left it. */
  function keep() {
    layout = { ...layout, column: place.width };
    writeLayout({ column: place.width });
  }

  for (const toggle of toggles)
    toggle.addEventListener("click", () => {
      layout = { ...layout, columnHidden: !layout.columnHidden };
      writeLayout({ columnHidden: layout.columnHidden });
      draw();
    });
  attachDivider(divider, {
    grows: "right",
    width: () => place.width,
    drag: (width) => {
      layout = { ...layout, column: width };
      draw();
    },
    key: (key) => {
      const next = keyColumn(place, key);
      if (next === null) return false;
      layout = { ...layout, column: next };
      draw();
      keep();
      return true;
    },
    done: keep,
    reset: () => {
      layout = { ...layout, column: null };
      writeLayout({ column: null });
      draw();
    },
  });
  // The column's greatest width follows the window's.
  window.addEventListener("resize", () => draw());
  draw();

  return {
    /** The language changed. */
    relabel,
  };
}
