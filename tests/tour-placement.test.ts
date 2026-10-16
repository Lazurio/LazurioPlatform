import { expect, test } from "bun:test";
import {
  type TourBox,
  type TourPlacement,
  tourPlacement,
  tourWidth,
} from "../src/launchpad/tour-placement";

// Lazurio/LazurioPlatform#461 point 2: on a laptop, the bubble of the tour
// that rings "Zkusit znovu" at the right edge of the content column ran past
// the column, covered the page and was cut by the window's edge; in a short
// window it covered the very button it pointed at. One rule places every
// bubble (tour-placement.ts): beside the ringed element when there is room,
// else under it, above it or on its left, along the element; always inside
// the window's visible area (without its scrollbar), a margin from its edges,
// at a readable width, with its arrow at the element. The boxes below are the
// page's own, read in Chrome from the hosted preview: the button at the right
// edge of Začínáme, Začínáme in the Settings column and the column head's
// gear.

const box = (
  left: number,
  top: number,
  right: number,
  bottom: number,
): TourBox => ({ left, top, right, bottom });

type Area = Readonly<{ width: number; height: number }>;

// A bubble with a title, one line and "Dokončím později"; and with two lines.
const heights = [110, 132] as const;
const margin = 12;
const gap = 16;
// The ring stands about 6 px around the element.
const ringOf = (anchor: TourBox): TourBox =>
  box(anchor.left - 6, anchor.top - 6, anchor.right + 6, anchor.bottom + 6);

const edges = (at: TourPlacement, height: number) => ({
  left: at.left,
  top: at.top,
  right: at.left + at.width,
  bottom: at.top + height,
});

/** The whole bubble in the window's visible area, a margin from its edges. */
function inside(at: TourPlacement, height: number, area: Area): boolean {
  const bubble = edges(at, height);
  return (
    bubble.left >= margin &&
    bubble.top >= margin &&
    bubble.right <= area.width - margin &&
    bubble.bottom <= area.height - margin
  );
}

/** Whether the bubble leaves the ring, and so the element, uncovered. */
function clear(at: TourPlacement, height: number, anchor: TourBox): boolean {
  const bubble = edges(at, height);
  const ring = ringOf(anchor);
  return (
    bubble.right <= ring.left ||
    bubble.left >= ring.right ||
    bubble.bottom <= ring.top ||
    bubble.top >= ring.bottom
  );
}

/** Where the arrow points, on the bubble's edge that faces the element. */
function arrowPoint(at: TourPlacement): number {
  if (at.arrow === null) throw new Error("A bubble at an element has an arrow");
  return at.side === "below" || at.side === "above"
    ? at.left + at.arrow
    : at.top + at.arrow;
}

/** The arrow points at the element: within its ring along that edge. */
function pointsAt(at: TourPlacement, anchor: TourBox): boolean {
  const point = arrowPoint(at);
  const ring = ringOf(anchor);
  return at.side === "below" || at.side === "above"
    ? point >= ring.left && point <= ring.right
    : point >= ring.top && point <= ring.bottom;
}

test("the bubble at the right edge of the content column stands under it, within the column, at 1440, 1280, 1024 and 800 px", () => {
  // "Zkusit znovu" as Chrome lays Začínáme out at each size, and the right
  // edge of the content column beside it.
  const cases = [
    {
      area: { width: 1440, height: 900 },
      button: box(1191, 350, 1292, 380),
      column: 1309,
    },
    {
      area: { width: 1280, height: 800 },
      button: box(1111, 350, 1212, 380),
      column: 1229,
    },
    {
      area: { width: 1024, height: 700 },
      button: box(882, 350, 983, 380),
      column: 1000,
    },
    {
      area: { width: 800, height: 600 },
      button: box(658, 388, 759, 418),
      column: 776,
    },
  ] as const;
  for (const { area, button, column } of cases)
    for (const height of heights) {
      const at = tourPlacement({ anchor: button, height, viewport: area });
      expect(at.side).toBe("below");
      expect(at.width).toBe(300);
      expect(inside(at, height, area)).toBe(true);
      expect(clear(at, height, button)).toBe(true);
      expect(pointsAt(at, button)).toBe(true);
      // It ends where the ring ends, inside the content column.
      expect(at.left + at.width).toBe(button.right + 6);
      expect(at.left + at.width).toBeLessThanOrEqual(column);
      expect(at.top).toBe(button.bottom + gap);
    }
  // At 1280 × 800, exactly.
  expect(
    tourPlacement({
      anchor: box(1111, 350, 1212, 380),
      height: 110,
      viewport: { width: 1280, height: 800 },
    }),
  ).toEqual({ side: "below", left: 918, top: 396, width: 300, arrow: 244 });
});

test("a classic scrollbar never covers the bubble: the visible area is the window less the scrollbar", () => {
  // The same page at 1280 × 800 with a 15 px scrollbar (Windows, or a Mac
  // with a mouse): the page, and the element, are 15 px narrower.
  const area = { width: 1265, height: 800 };
  const button = box(1103, 350, 1204, 380);
  const at = tourPlacement({ anchor: button, height: 110, viewport: area });
  expect(inside(at, 110, area)).toBe(true);
  expect(at.left + at.width).toBeLessThanOrEqual(1265 - margin);
  expect(pointsAt(at, button)).toBe(true);
});

test("in a short window the bubble stands above the element and never covers it", () => {
  for (const { area, button } of [
    { area: { width: 1280, height: 460 }, button: box(1111, 350, 1212, 380) },
    { area: { width: 1024, height: 430 }, button: box(882, 350, 983, 380) },
    { area: { width: 800, height: 440 }, button: box(658, 388, 759, 418) },
  ])
    for (const height of heights) {
      const at = tourPlacement({ anchor: button, height, viewport: area });
      expect(at.side).toBe("above");
      expect(inside(at, height, area)).toBe(true);
      expect(clear(at, height, button)).toBe(true);
      expect(pointsAt(at, button)).toBe(true);
      expect(at.top + height).toBe(button.top - gap);
    }
  // An element at the window's bottom right corner, flush with both edges.
  for (const area of [
    { width: 1280, height: 800 },
    { width: 1024, height: 700 },
    { width: 800, height: 600 },
  ]) {
    const corner = box(
      area.width - 101,
      area.height - 30,
      area.width,
      area.height,
    );
    const at = tourPlacement({ anchor: corner, height: 110, viewport: area });
    expect(at.side).toBe("above");
    expect(inside(at, 110, area)).toBe(true);
    expect(clear(at, 110, corner)).toBe(true);
    expect(pointsAt(at, corner)).toBe(true);
  }
});

test("beside the element when there is room: Začínáme in the Settings column and the gear, as before", () => {
  const area = { width: 1280, height: 800 };
  expect(
    tourPlacement({
      anchor: box(75, 207, 318, 241),
      height: 110,
      viewport: area,
    }),
  ).toEqual({ side: "right", left: 334, top: 201, width: 300, arrow: 23 });
  // The gear at the top: the bubble stays a margin from the window's top.
  expect(
    tourPlacement({
      anchor: box(270, 16, 318, 64),
      height: 110,
      viewport: area,
    }),
  ).toEqual({ side: "right", left: 334, top: 12, width: 300, arrow: 28 });
});

test("a step across the content column: under it, from where its ring starts", () => {
  const area = { width: 1280, height: 800 };
  const step = box(373, 157, 1221, 231);
  const at = tourPlacement({ anchor: step, height: 110, viewport: area });
  expect(at.side).toBe("below");
  expect(at.left).toBe(367);
  expect(at.top).toBe(247);
  expect(pointsAt(at, step)).toBe(true);
});

test("on its left when there is no room beside, under or above it", () => {
  const area = { width: 1280, height: 300 };
  const tall = box(1100, 40, 1201, 260);
  const at = tourPlacement({ anchor: tall, height: 110, viewport: area });
  expect(at).toEqual({
    side: "left",
    left: 784,
    top: 34,
    width: 300,
    arrow: 58,
  });
  expect(clear(at, 110, tall)).toBe(true);
  expect(pointsAt(at, tall)).toBe(true);
});

test("a readable width: 300 px, or what a narrower window leaves", () => {
  expect(tourWidth(1280)).toBe(300);
  expect(tourWidth(800)).toBe(300);
  expect(tourWidth(360)).toBe(300);
  expect(tourWidth(324)).toBe(300);
  expect(tourWidth(320)).toBe(296);
  expect(tourWidth(10)).toBe(0);
  const narrow = { width: 320, height: 568 };
  const at = tourPlacement({
    anchor: box(200, 300, 300, 330),
    height: 132,
    viewport: narrow,
  });
  expect(at.width).toBe(296);
  expect(inside(at, 132, narrow)).toBe(true);
});

test("without the element on screen, the bottom right corner, without an arrow", () => {
  for (const area of [
    { width: 1280, height: 800 },
    { width: 800, height: 600 },
  ]) {
    const at = tourPlacement({ anchor: null, height: 110, viewport: area });
    expect(at.side).toBeNull();
    expect(at.arrow).toBeNull();
    expect(inside(at, 110, area)).toBe(true);
    expect(at.left + at.width).toBe(area.width - 24);
    expect(at.top + 110).toBe(area.height - 24);
  }
  // A phone-wide window: the margin wins over the corner's inset.
  const phone = { width: 320, height: 568 };
  const at = tourPlacement({ anchor: null, height: 132, viewport: phone });
  expect(inside(at, 132, phone)).toBe(true);
});

test("where no side has room, the bubble still stays whole in the window", () => {
  const area = { width: 420, height: 260 };
  const big = box(20, 20, 400, 240);
  for (const height of heights) {
    const at = tourPlacement({ anchor: big, height, viewport: area });
    expect(at.side).not.toBeNull();
    expect(inside(at, height, area)).toBe(true);
  }
});

test("one rule everywhere: across the window, inside it, off the element and pointing at it whenever a side has room", () => {
  const areas: Area[] = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1265, height: 800 },
    { width: 1024, height: 700 },
    { width: 800, height: 600 },
  ];
  for (const area of areas) {
    const sizes = [
      [101, 30], // a button
      [243, 34], // an item of the Settings column
      [48, 48], // the gear
      [area.width - 420, 74], // a step across the content column
    ] as const;
    for (const [w, h] of sizes) {
      const xs = [
        0,
        margin,
        (area.width - w) / 2,
        area.width - w - margin,
        area.width - w,
      ];
      const ys = [
        0,
        margin,
        (area.height - h) / 2,
        area.height - h - margin,
        area.height - h,
      ];
      for (const x of xs)
        for (const y of ys)
          for (const height of heights) {
            const anchor = box(x, y, x + w, y + h);
            const at = tourPlacement({ anchor, height, viewport: area });
            expect(at.width).toBe(tourWidth(area.width));
            expect(inside(at, height, area)).toBe(true);
            const room = {
              right: anchor.right + gap + at.width <= area.width - margin,
              below: anchor.bottom + gap + height <= area.height - margin,
              above: anchor.top - gap - height >= margin,
              left: anchor.left - gap - at.width >= margin,
            };
            // Beside it when there is room, else under, above, on its left.
            const first = (["right", "below", "above", "left"] as const).find(
              (side) => room[side],
            );
            if (first === undefined) continue;
            expect(at.side).toBe(first);
            expect(clear(at, height, anchor)).toBe(true);
            expect(pointsAt(at, anchor)).toBe(true);
          }
    }
  }
});
