import { expect, test } from "bun:test";
import type { Store } from "../src/shell/account";
import {
  type BuddyBox,
  buddyBeside,
  buddyBoxOf,
  buddyEdge,
  buddyNudge,
  buddyPlaceKey,
  buddyPlaceOf,
  buddySnap,
  buddyStep,
  readBuddyPlace,
  writeBuddyPlace,
} from "../src/shell/buddy-place";

// Where Buddy's launcher stands (decision F60's addendum of 2026-11-14): the
// person drags him anywhere, this app remembers it, and his panel opens
// beside him. The prototype of prototypes-lazurio #131.

const size = { width: 58, height: 58 };
const view = { width: 1440, height: 900 };
// His corner as the stylesheet places it: 22 px from the right and bottom.
const home: BuddyBox = { left: 1440 - 22 - 58, top: 900 - 22 - 58, ...size };
const panel = { width: 400, height: 600 };

const memory = (): Store & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};

test("at home he stands where the stylesheet places him, the host's own place included", () => {
  const moved = { ...home, left: home.left - 30 };
  expect(buddyBoxOf("home", size, view, moved)).toBe(moved);
});

test("a dropped launcher keeps the edges it is nearest to, so a resized window keeps him by them", () => {
  expect(buddyPlaceOf(120, 80, size, view, home)).toEqual({
    h: "left",
    x: 120,
    v: "top",
    y: 80,
  });
  const nearRight = buddyPlaceOf(1100, 700, size, view, home);
  expect(nearRight).toEqual({ h: "right", x: 282, v: "bottom", y: 142 });
  // A narrower window: still 282 px from its right edge.
  expect(
    buddyBoxOf(nearRight, size, { width: 1000, height: 900 }, home).left,
  ).toBe(1000 - 282 - 58);
});

test(`dropped within ${buddySnap} px of his corner he is home again; farther he stays where he was put`, () => {
  expect(buddyPlaceOf(home.left - 20, home.top - 20, size, view, home)).toBe(
    "home",
  );
  expect(buddyPlaceOf(home.left - 60, home.top, size, view, home)).not.toBe(
    "home",
  );
});

test("he never leaves the window, however far he is dragged or however small the window becomes", () => {
  const far = buddyPlaceOf(-500, 99999, size, view, home);
  expect(buddyBoxOf(far, size, view, home)).toMatchObject({
    left: buddyEdge,
    top: view.height - size.height - buddyEdge,
  });
  const top = buddyPlaceOf(1300, 40, size, view, home);
  const phone = buddyBoxOf(top, size, { width: 390, height: 700 }, home);
  expect(phone.left).toBeGreaterThanOrEqual(buddyEdge);
  expect(phone.left + size.width).toBeLessThanOrEqual(390 - buddyEdge);
});

test("single arrow steps move him out of his corner and keep moving him; a step back onto it, or Home, is home", () => {
  const left = buddyNudge("home", -buddyStep, 0, size, view, home);
  expect(left).not.toBe("home");
  expect(buddyBoxOf(left, size, view, home).left).toBe(home.left - buddyStep);
  const up = buddyNudge("home", 0, -buddyStep, size, view, home);
  expect(buddyBoxOf(up, size, view, home).top).toBe(home.top - buddyStep);
  const twice = buddyNudge(left, -buddyStep, 0, size, view, home);
  expect(buddyBoxOf(twice, size, view, home).left).toBe(
    home.left - 2 * buddyStep,
  );
  expect(buddyNudge(left, buddyStep, 0, size, view, home)).toBe("home");
  // A drop still snaps within the corner's reach.
  expect(buddyPlaceOf(home.left - buddyStep, home.top, size, view, home)).toBe(
    "home",
  );
});

test("his panel opens beside him on the side with more room, and beside him where above and below are short", () => {
  // Top left: below him, aligned with his left side.
  const topLeft = buddyBoxOf(
    buddyPlaceOf(40, 40, size, view, home),
    size,
    view,
    home,
  );
  expect(buddyBeside(topLeft, panel, 12, view, true)).toEqual({
    left: 40,
    top: 40 + 58 + 12,
    width: 400,
    height: 600,
  });
  // Bottom right: above him, aligned with his right side.
  const corner = buddyBeside(home, panel, 12, view, true);
  expect(corner.left + corner.width).toBe(home.left + home.width);
  expect(corner.top + corner.height).toBe(home.top - 12);
  // The middle of a short window: whole, to his left or right.
  const short = { width: 1440, height: 700 };
  const middle = buddyBoxOf(
    buddyPlaceOf(700, 300, size, short, home),
    size,
    short,
    home,
  );
  const side = buddyBeside(middle, panel, 12, short, true);
  expect(side.height).toBe(600);
  expect(side.left + side.width).toBe(700 - 12);
  // Without `sideways` it shrinks to the room there is, inside the window.
  const shrunk = buddyBeside(middle, panel, 12, short);
  expect(shrunk.top).toBeGreaterThanOrEqual(buddyEdge);
  expect(shrunk.top + shrunk.height).toBeLessThanOrEqual(700 - buddyEdge);
  // A phone: 8 px from both edges.
  const phone = { width: 390, height: 800 };
  const there = buddyBeside(
    { left: 390 - 80, top: 800 - 80, ...size },
    panel,
    12,
    phone,
    true,
  );
  expect(there.left).toBe(buddyEdge);
  expect(there.width).toBe(390 - 2 * buddyEdge);
});

test("this app remembers his place; home is remembered as nothing, and anything unreadable is home", () => {
  const store = memory();
  expect(readBuddyPlace(store)).toBe("home");
  const place = { h: "left", x: 120, v: "top", y: 80 } as const;
  writeBuddyPlace(store, place);
  expect(store.items.get(buddyPlaceKey)).toBe(JSON.stringify(place));
  expect(readBuddyPlace(store)).toEqual(place);
  writeBuddyPlace(store, "home");
  expect(store.items.has(buddyPlaceKey)).toBe(false);
  for (const raw of [
    "not json",
    "null",
    "[]",
    '{"h":"middle","x":1,"v":"top","y":1}',
    '{"h":"left","x":"1","v":"top","y":1}',
    '{"h":"left","x":1e999,"v":"top","y":1}',
  ]) {
    store.items.set(buddyPlaceKey, raw);
    expect(readBuddyPlace(store)).toBe("home");
  }
  // No store, or one that throws: home, and nothing breaks.
  expect(readBuddyPlace(null)).toBe("home");
  const broken: Store = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(readBuddyPlace(broken)).toBe("home");
  writeBuddyPlace(broken, place);
});
