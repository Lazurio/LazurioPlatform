// Where a bubble at a ringed element stands: the Launchpad's first-run tour
// (src/launchpad/tour.ts; Lazurio/LazurioPlatform#461 point 2) and the
// guide's card (guide-layer.ts, decision F56) follow one rule, so it lives in
// the shell, which both load. Beside the ringed element when there is
// room, else under it, else above it, else on its left. Along that side it
// starts where the ring starts, or ends where the ring ends when starting
// there would leave the window, and moves only as far as the window needs,
// so a bubble at an element on the right edge of the content stays over the
// content. It is always whole inside the window's visible area, a margin from
// its edges: the area without a scrollbar, so a classic one (Windows, a Mac
// with a mouse) never covers it. It keeps a readable width, 300 px or what a
// narrower window leaves, and its arrow points at the element. Where no side
// has room it takes the side it overflows least and stays in the window all
// the same. Without the element on screen the tour's bubble stands in the
// bottom right corner, without an arrow; the guide's card stands in the
// middle instead, and below 768 px it is a sheet at the window's foot
// (`guidePlacement`). Pure: the callers measure the page and draw.

/** A box in the window's coordinates, as `getBoundingClientRect` gives. */
export type TourBox = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export type TourSide = "right" | "below" | "above" | "left";

export type TourPlacement = Readonly<{
  /** Where it stands from the element; null in the corner. */
  side: TourSide | null;
  left: number;
  top: number;
  width: number;
  /** The middle of the arrow along the bubble's edge that faces the
   * element, from the bubble's left (below, above) or top (right, left);
   * null in the corner. */
  arrow: number | null;
}>;

/** The bubble's width wherever the window allows it. */
const bubbleWidth = 300;
/** The least distance from the window's edges. */
const margin = 12;
/** From the element to the bubble: the ring, its glow and the arrow. */
const gap = 16;
/** How far the ring stands around the element (tour.ts draws it 5 px out,
 * with its line). */
const ring = 6;
/** The arrow keeps clear of the bubble's rounded corners. */
const arrowInset = 20;
/** The corner's distance from the window's edges. */
const corner = 24;

const order: readonly TourSide[] = ["right", "below", "above", "left"];

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, high));

/** The bubble's width in a window `viewportWidth` wide: 300 px, or what a
 * narrower window leaves inside its margins. */
export function tourWidth(viewportWidth: number): number {
  return Math.max(0, Math.min(bubbleWidth, viewportWidth - 2 * margin));
}

/** Where a bubble of `size` starts along one axis: where the ring starts,
 * or so that it ends where the ring ends when starting there would pass
 * `high`; then no further than the window needs. */
function along(start: number, end: number, size: number, high: number): number {
  const from = start - ring;
  return clamp(
    from + size <= high ? from : end + ring - size,
    margin,
    high - size,
  );
}

/** The arrow at the middle of what the element and the bubble share along
 * that edge (toward the element where they share nothing), off the
 * bubble's corners. */
function arrowAt(
  start: number,
  end: number,
  position: number,
  size: number,
): number {
  const shared =
    (Math.max(start, position) + Math.min(end, position + size)) / 2;
  return Math.round(clamp(shared - position, arrowInset, size - arrowInset));
}

export function tourPlacement(
  input: Readonly<{
    /** The ringed element, or null while it is not on screen. */
    anchor: TourBox | null;
    /** The bubble's height at `tourWidth(viewport.width)`. */
    height: number;
    /** The window's visible area: without its scrollbars. */
    viewport: Readonly<{ width: number; height: number }>;
  }>,
): TourPlacement {
  const { anchor, height, viewport } = input;
  const width = tourWidth(viewport.width);
  const right = viewport.width - margin;
  const bottom = viewport.height - margin;
  if (anchor === null)
    return {
      side: null,
      left: Math.round(
        clamp(viewport.width - corner - width, margin, right - width),
      ),
      top: Math.round(
        clamp(viewport.height - corner - height, margin, bottom - height),
      ),
      width,
      arrow: null,
    };
  // Each side: where the bubble stands across it, and by how much it would
  // leave the window there (none: it has room).
  const across: Record<TourSide, number> = {
    right: anchor.right + gap,
    below: anchor.bottom + gap,
    above: anchor.top - gap - height,
    left: anchor.left - gap - width,
  };
  const overflow: Record<TourSide, number> = {
    right: across.right + width - right,
    below: across.below + height - bottom,
    above: margin - across.above,
    left: margin - across.left,
  };
  const side =
    order.find((name) => overflow[name] <= 0) ??
    order.reduce((best, name) =>
      overflow[name] < overflow[best] ? name : best,
    );
  if (side === "right" || side === "left") {
    const left = Math.round(clamp(across[side], margin, right - width));
    const top = Math.round(along(anchor.top, anchor.bottom, height, bottom));
    return {
      side,
      left,
      top,
      width,
      arrow: arrowAt(anchor.top, anchor.bottom, top, height),
    };
  }
  const top = Math.round(clamp(across[side], margin, bottom - height));
  const left = Math.round(along(anchor.left, anchor.right, width, right));
  return {
    side,
    left,
    top,
    width,
    arrow: arrowAt(anchor.left, anchor.right, left, width),
  };
}

/** Below this window width the guide's card is a sheet at the window's foot
 * (the shaping's default for a phone, DEV-6612 3(c)): a narrow window has no
 * room beside an element, and the column it points into is folded away. */
export const guideSheetBelow = 768;

export type GuidePlacement = TourPlacement &
  Readonly<{
    /** A sheet across the window's foot, as wide as the window leaves. */
    sheet: boolean;
  }>;

/** Where the guide's card stands (decision F56): as the tour's bubble beside
 * a ringed element; in the middle of the window without one (the element is
 * missing or hidden, the prototype's fallback); and below `guideSheetBelow`
 * as a sheet at the window's foot, the ring still drawn where the element
 * is. Never an arrow but beside an element. */
export function guidePlacement(
  input: Readonly<{
    anchor: TourBox | null;
    /** The card's height at the width this returns for the same window. */
    height: number;
    viewport: Readonly<{ width: number; height: number }>;
  }>,
): GuidePlacement {
  const { anchor, height, viewport } = input;
  const bottom = viewport.height - margin;
  if (viewport.width < guideSheetBelow)
    return {
      side: null,
      left: margin,
      top: Math.round(Math.max(margin, bottom - height)),
      width: Math.max(0, viewport.width - 2 * margin),
      arrow: null,
      sheet: true,
    };
  if (anchor === null) {
    const width = tourWidth(viewport.width);
    const right = viewport.width - margin;
    return {
      side: null,
      left: Math.round(
        clamp((viewport.width - width) / 2, margin, right - width),
      ),
      top: Math.round(
        clamp((viewport.height - height) / 2, margin, bottom - height),
      ),
      width,
      arrow: null,
      sheet: false,
    };
  }
  return { ...tourPlacement(input), sheet: false };
}

/** The width of the guide's card in a window this wide, before its height is
 * known: the sheet's below `guideSheetBelow`, else the tour's. */
export const guideWidth = (viewportWidth: number): number =>
  viewportWidth < guideSheetBelow
    ? Math.max(0, viewportWidth - 2 * margin)
    : tourWidth(viewportWidth);
