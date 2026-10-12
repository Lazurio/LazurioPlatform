// The Launchpad's layout in this browser (Matěj's tuning of the Launchpad's
// panel, 2026-10-12): the right panel dragged wider or narrower by its left
// edge, as T3 Code's and Codex Desktop's panels are, and the left column
// hidden and shown, and dragged wider or narrower by its right edge, as T3
// Code's sidebar is. The panel can take all of the room right of the rail
// and the column: dragged past half of the page's narrowest width, the page
// steps aside and the panel takes the room, as in the wireframe's "Celá
// šířka" (prototypes-lazurio `placePanel`, mode "wide"). With the column
// hidden too, the browser fills the window but the rail. What the person
// chose stays in this browser under one key, read defensively, as the
// favourites and the tour's progress do: it is their view, never the
// Folder's, which a Team Environment shares. Pure: layout.ts and
// browser-panel.ts only draw this and ask.

/** The storage key of the person's layout. */
export const layoutKey = "lazurio.layout";

/** The narrowest right panel, and the narrowest page beside it (the
 * wireframe's PANEL_MIN and CONTENT_MIN). */
export const panelMinWidth = 360;
export const pageMinWidth = 400;

/** The left column: T3 Code's narrowest sidebar, which the shell's column
 * head is drawn for, four grid modules by default (Anna 2026-10-11, was
 * 264 px), and the widest that still leaves its navigation a column. */
export const columnMinWidth = 208;
export const columnDefaultWidth = 256;
export const columnMaxWidth = 480;

/** The right panel's width as the person left it: pixels, or all of the
 * room. */
export type PanelWish = number | "wide";

export type StoredLayout = Readonly<{
  /** The right panel's width the person chose; null for the default. */
  panel: PanelWish | null;
  /** The left column's width the person chose; null for the default. */
  column: number | null;
  /** The person hid the left column. */
  columnHidden: boolean;
}>;

export const defaultLayout: StoredLayout = Object.freeze({
  panel: null,
  column: null,
  columnHidden: false,
});

/** A stored width: whole pixels within reason, else none. */
const storedWidth = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 1 &&
  value <= 10_000
    ? Math.round(value)
    : null;

/** The stored layout, read defensively: what is not a layout is the
 * default, and a field that is not what it should be is its default
 * alone. */
export function parseLayout(raw: string | null): StoredLayout {
  if (raw === null) return defaultLayout;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaultLayout;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return defaultLayout;
  const { panel, column, columnHidden } = value as Record<string, unknown>;
  return {
    panel: panel === "wide" ? "wide" : storedWidth(panel),
    column: storedWidth(column),
    columnHidden: columnHidden === true,
  };
}

/** The layout as it is stored. */
export const layoutText = (layout: StoredLayout): string =>
  JSON.stringify(layout);

// ---- The right panel --------------------------------------------------------

/** Where the right panel goes, and its divider's range (`min`–`max`):
 * `side`, `width` wide beside a page of at least `pageMinWidth`; `wide`,
 * all of the room with the page stepped aside. */
export type PanelPlace = Readonly<{
  mode: "side" | "wide";
  width: number;
  min: number;
  max: number;
}>;

/** The panel's default: half of the room, 360–960 px, as it was before it
 * could be dragged. */
export const defaultPanelWidth = (room: number): number =>
  Math.round(Math.min(960, Math.max(panelMinWidth, room / 2)));

/** The panel in `room` pixels (the room right of the rail and the column,
 * which it shares with the page), as the person wished: all of it when
 * they took it, else their width (or the default) within what leaves the
 * page its narrowest width. With no room for both, the panel takes it
 * all. */
export function placePanel(room: number, wish: PanelWish | null): PanelPlace {
  const max = Math.max(panelMinWidth, Math.floor(room));
  const side = max - pageMinWidth;
  if (wish === "wide" || side < panelMinWidth)
    return { mode: "wide", width: max, min: panelMinWidth, max };
  const width = Math.round(
    Math.min(side, Math.max(panelMinWidth, wish ?? defaultPanelWidth(max))),
  );
  return { mode: "side", width, min: panelMinWidth, max };
}

/** The wish the pointer makes, dragging the divider to `width` in `room`:
 * the page steps aside once less than half of its narrowest width would be
 * left, and comes back past that when dragged back; short of it the width,
 * which `placePanel` holds where the page keeps its narrowest width. */
export const dragPanel = (room: number, width: number): PanelWish =>
  room - width < pageMinWidth / 2 ? "wide" : Math.round(width);

/** What to keep of a placed panel: all of the room, or its width. */
export const panelWish = (place: PanelPlace): PanelWish =>
  place.mode === "wide" ? "wide" : place.width;

/** A key on a divider: the arrows move it 24 px, 96 with Shift; Home and
 * End take the panel to its least and its greatest width (WAI-ARIA's
 * window splitter). */
export type DividerKey = Readonly<{ key: string; shift: boolean }>;

const stepOf = (key: DividerKey): number => (key.shift ? 96 : 24);

/** The wish a key on the panel's divider makes; null for any other key.
 * The arrows move the divider, so ← widens the panel. From the widest
 * panel beside the page ← takes all of the room, and from there → gives
 * the page its narrowest width again. */
export function keyPanel(place: PanelPlace, key: DividerKey): PanelWish | null {
  const side = place.max - pageMinWidth;
  switch (key.key) {
    case "ArrowLeft":
      return place.mode === "wide" || place.width >= side
        ? "wide"
        : Math.min(side, place.width + stepOf(key));
    case "ArrowRight":
      return place.mode === "wide" ? side : place.width - stepOf(key);
    case "Home":
      return place.min;
    case "End":
      return "wide";
    default:
      return null;
  }
}

// ---- The left column --------------------------------------------------------

/** The left column's width and its divider's range. */
export type ColumnPlace = Readonly<{ width: number; min: number; max: number }>;

/** The column in an app `appWidth` pixels wide (all right of the rail), as
 * the person wished, or 256 px: 208–480 px, and never so wide that the page
 * beside it has less than its narrowest width. */
export function placeColumn(
  appWidth: number,
  wish: number | null,
): ColumnPlace {
  const max = Math.max(
    columnMinWidth,
    Math.min(columnMaxWidth, Math.floor(appWidth) - pageMinWidth),
  );
  const width = Math.round(
    Math.min(max, Math.max(columnMinWidth, wish ?? columnDefaultWidth)),
  );
  return { width, min: columnMinWidth, max };
}

/** The width a key on the column's divider asks for (`placeColumn` holds
 * it in range); null for any other key. The arrows move the divider, so →
 * widens the column. */
export function keyColumn(place: ColumnPlace, key: DividerKey): number | null {
  switch (key.key) {
    case "ArrowRight":
      return place.width + stepOf(key);
    case "ArrowLeft":
      return place.width - stepOf(key);
    case "Home":
      return place.min;
    case "End":
      return place.max;
    default:
      return null;
  }
}
