import { describe, expect, test } from "bun:test";
import {
  columnDefaultWidth,
  columnMaxWidth,
  columnMinWidth,
  defaultLayout,
  defaultPanelWidth,
  dragPanel,
  keyColumn,
  keyPanel,
  layoutKey,
  layoutText,
  pageMinWidth,
  panelMinWidth,
  panelWish,
  parseLayout,
  placeColumn,
  placePanel,
} from "../src/launchpad/layout-view";

// The Launchpad's layout in this browser (Matěj's tuning of the Launchpad's
// panel, 2026-10-12): the right panel dragged wider or narrower by its left
// edge, up to all of the room right of the rail and the column, the page
// then stepped aside (the wireframe's "Celá šířka"); the left column hidden
// or dragged wider or narrower by its right edge; what the person chose kept
// under one key and read defensively. The DOM (layout.ts, browser-panel.ts)
// only draws this.

// The room right of the rail and a 264 px column in a window 1800 px wide,
// and the widest panel that leaves the page its narrowest width.
const room = 1800 - 64 - 1 - 264;
const side = room - pageMinWidth;

describe("the right panel's width", () => {
  test("by default half of the room, 360–960 px, and never so wide that the page steps aside", () => {
    expect([panelMinWidth, pageMinWidth]).toEqual([360, 400]);
    expect(defaultPanelWidth(room)).toBe(736);
    expect(placePanel(room, null)).toEqual({
      mode: "side",
      width: 736,
      min: 360,
      max: room,
    });
    expect(placePanel(3000, null).width).toBe(960);
    expect(placePanel(700 + pageMinWidth, null).width).toBe(550);
    // Just above the sheet (a window of 1100 px): the page keeps its 400 px.
    expect(placePanel(771, null)).toEqual({
      mode: "side",
      width: 371,
      min: 360,
      max: 771,
    });
  });

  test("the person's width, within what leaves the page its narrowest width; all of the room when they took it, or when the room fits no page beside the panel", () => {
    expect(placePanel(room, 600)).toMatchObject({ mode: "side", width: 600 });
    expect(placePanel(room, 100)).toMatchObject({ mode: "side", width: 360 });
    expect(placePanel(room, 5000)).toMatchObject({ mode: "side", width: side });
    expect(placePanel(room, "wide")).toEqual({
      mode: "wide",
      width: room,
      min: 360,
      max: room,
    });
    // A wide column in a small window: no room for both.
    expect(placePanel(700, 500)).toEqual({
      mode: "wide",
      width: 700,
      min: 360,
      max: 700,
    });
    // Measured rooms come in fractions; widths are whole pixels.
    expect(placePanel(room + 0.6, "wide").width).toBe(room);
    expect(placePanel(room + 0.6, 600.4).width).toBe(600);
  });

  test("dragged past half of the page's narrowest width, the page steps aside and the panel takes the room; dragged back past it, the page returns at its narrowest", () => {
    expect(dragPanel(room, 900)).toBe(900);
    expect(dragPanel(room, 900.6)).toBe(901);
    // Between the page's narrowest width and half of it the panel holds.
    const holding = dragPanel(room, room - 250);
    expect(holding).toBe(room - 250);
    expect(placePanel(room, holding)).toMatchObject({
      mode: "side",
      width: side,
    });
    expect(dragPanel(room, room - pageMinWidth / 2 + 1)).toBe("wide");
    expect(dragPanel(room, room + 40)).toBe("wide");
    // Back from all of the room: the page needs half its width to return.
    expect(dragPanel(room, room - 150)).toBe("wide");
    expect(placePanel(room, dragPanel(room, room - 210))).toMatchObject({
      mode: "side",
      width: side,
    });
    // What is kept is where the panel went.
    expect(panelWish(placePanel(room, room - 250))).toBe(side);
    expect(panelWish(placePanel(room, "wide"))).toBe("wide");
  });

  test("the divider's keys: the arrows move it 24 px, 96 with Shift; ← from the widest beside the page takes the room and → gives the page back; Home and End go to the least and the greatest width", () => {
    const at = (width: number) => placePanel(room, width);
    const key = (name: string, shift = false) => ({ key: name, shift });
    expect(keyPanel(at(700), key("ArrowLeft"))).toBe(724);
    expect(keyPanel(at(700), key("ArrowLeft", true))).toBe(796);
    expect(keyPanel(at(700), key("ArrowRight"))).toBe(676);
    expect(keyPanel(at(side - 10), key("ArrowLeft"))).toBe(side);
    expect(keyPanel(at(side), key("ArrowLeft"))).toBe("wide");
    const wide = placePanel(room, "wide");
    expect(keyPanel(wide, key("ArrowLeft"))).toBe("wide");
    expect(keyPanel(wide, key("ArrowRight"))).toBe(side);
    // Narrower than the least is the least.
    expect(
      placePanel(room, keyPanel(at(370), key("ArrowRight", true)) ?? 0),
    ).toMatchObject({ width: 360 });
    expect(keyPanel(at(700), key("Home"))).toBe(360);
    expect(keyPanel(at(700), key("End"))).toBe("wide");
    for (const other of ["Enter", "ArrowUp", "a", "Escape"])
      expect(keyPanel(at(700), key(other))).toBeNull();
  });
});

describe("the left column's width", () => {
  test("264 px by default, the person's width within 208–480 px, and never so wide that the page beside it has less than its narrowest width", () => {
    expect([columnMinWidth, columnDefaultWidth, columnMaxWidth]).toEqual([
      208, 264, 480,
    ]);
    // The app right of the rail in a window 1800 px wide.
    const app = 1800 - 64 - 1;
    expect(placeColumn(app, null)).toEqual({ width: 264, min: 208, max: 480 });
    expect(placeColumn(app, 320)).toMatchObject({ width: 320 });
    expect(placeColumn(app, 320.6)).toMatchObject({ width: 321 });
    expect(placeColumn(app, 100)).toMatchObject({ width: 208 });
    expect(placeColumn(app, 900)).toMatchObject({ width: 480 });
    // A window of 800 px leaves the page its 400 px.
    expect(placeColumn(800 - 65, 480)).toEqual({
      width: 335,
      min: 208,
      max: 335,
    });
    // Narrower still, the column keeps its least width.
    expect(placeColumn(500, null)).toEqual({ width: 208, min: 208, max: 208 });
  });

  test("its divider's keys: → widens it by 24 px, 96 with Shift, ← narrows it; Home and End go to the least and the greatest width", () => {
    const at = placeColumn(1735, 300);
    const key = (name: string, shift = false) => ({ key: name, shift });
    expect(keyColumn(at, key("ArrowRight"))).toBe(324);
    expect(keyColumn(at, key("ArrowRight", true))).toBe(396);
    expect(keyColumn(at, key("ArrowLeft"))).toBe(276);
    expect(keyColumn(at, key("Home"))).toBe(208);
    expect(keyColumn(at, key("End"))).toBe(480);
    // Past either end, placing it holds it in range.
    expect(
      placeColumn(1735, keyColumn(placeColumn(1735, 470), key("ArrowRight"))),
    ).toMatchObject({ width: 480 });
    for (const other of ["Enter", "ArrowDown", "Escape"])
      expect(keyColumn(at, key(other))).toBeNull();
  });
});

describe("the stored layout", () => {
  test("one key in this browser, read defensively: anything else is the default, and a wrong field is its own default alone", () => {
    expect(layoutKey).toBe("lazurio.layout");
    expect(defaultLayout).toEqual({
      panel: null,
      column: null,
      columnHidden: false,
    });
    expect(parseLayout(null)).toEqual(defaultLayout);
    for (const raw of ["", "{", "null", "[720]", '"wide"', "42", "true"])
      expect(parseLayout(raw)).toEqual(defaultLayout);
    expect(parseLayout('{"panel":720}')).toEqual({
      ...defaultLayout,
      panel: 720,
    });
    expect(parseLayout('{"panel":720.4}').panel).toBe(720);
    expect(parseLayout('{"panel":"wide"}').panel).toBe("wide");
    for (const panel of ['"720"', "0", "-5", "1e9", '"WIDE"', "null", "{}"])
      expect(parseLayout(`{"panel":${panel}}`).panel).toBeNull();
    expect(
      parseLayout('{"panel":"wide","column":300,"columnHidden":true}'),
    ).toEqual({ panel: "wide", column: 300, columnHidden: true });
    for (const column of ['"300"', "-1", "1e9", '"wide"', "true"])
      expect(parseLayout(`{"column":${column}}`).column).toBeNull();
    for (const hidden of ['"true"', "1", "null", "false"])
      expect(parseLayout(`{"columnHidden":${hidden}}`).columnHidden).toBe(
        false,
      );
    // A wrong field takes nothing else with it, and nothing else is read.
    expect(
      parseLayout('{"panel":"x","column":300,"columnHidden":true,"theme":1}'),
    ).toEqual({ panel: null, column: 300, columnHidden: true });
  });

  test("what is written reads back the same", () => {
    for (const layout of [
      defaultLayout,
      { panel: 720, column: null, columnHidden: false },
      { panel: "wide" as const, column: 320, columnHidden: true },
    ])
      expect(parseLayout(layoutText(layout))).toEqual(layout);
  });
});
