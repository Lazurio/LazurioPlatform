import type { Store } from "./account";

// Where Buddy's launcher stands (decision F60's addendum of 2026-11-14): the
// person drags him anywhere on the window, as a pet on the screen, and this
// app remembers it. Pure, so its rules are tested without a DOM
// (buddy-element.ts measures the window and the launcher and draws).
//
// - A move shorter than `buddyDragThreshold` is a click; a drag never clicks.
// - The place keeps the edges he is nearest to, so a narrower or wider window
//   keeps him by the same edge; he never stands nearer than `buddyEdge` to
//   any edge of the window.
// - His corner, where he always stood, is `home`: dropped within
//   `buddySnap` of it, he is back in it, and in it the host's own place
//   (`--lazurio-buddy-right`, `--lazurio-buddy-bottom`, the device's safe
//   area) still places him.
// - Each app remembers its own place: the shell runs on each app's origin,
//   so `localStorage` under `buddyPlaceKey` is that app's. Home is stored as
//   nothing.
// - The panel opens beside him: above or below, where there is more room,
//   aligned with his outer side; where neither has its height, to his left
//   or right where it fits whole.

/** A place away from home: the edges he keeps his distance from. */
export type BuddyPlace =
  | "home"
  | Readonly<{
      h: "left" | "right";
      x: number;
      v: "top" | "bottom";
      y: number;
    }>;

export type BuddyBox = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export const buddyPlaceKey = "lazurio.buddy.place";
/** He never stands nearer to the window's edge. */
export const buddyEdge = 8;
/** Dropped this near his corner, he is back in it. */
export const buddySnap = 40;
/** A move shorter than this is a click. */
export const buddyDragThreshold = 5;
/** One step of the arrows; Shift takes four. */
export const buddyStep = 16;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

type Size = Readonly<{ width: number; height: number }>;
type Viewport = Readonly<{ width: number; height: number }>;

/** The launcher's box at a place, inside the window; `home` is where the
 * launcher stands in its corner, as measured there. */
export function buddyBoxOf(
  place: BuddyPlace,
  size: Size,
  view: Viewport,
  home: BuddyBox,
): BuddyBox {
  if (place === "home") return home;
  const left = place.h === "left" ? place.x : view.width - place.x - size.width;
  const top = place.v === "top" ? place.y : view.height - place.y - size.height;
  return Object.freeze({
    left: clamp(left, buddyEdge, view.width - size.width - buddyEdge),
    top: clamp(top, buddyEdge, view.height - size.height - buddyEdge),
    width: size.width,
    height: size.height,
  });
}

/** The place of a launcher dropped at `left`, `top`: home near his corner
 * (`snap`), else by its nearest edges, inside the window. The arrows' steps
 * do not snap, so a single step leaves the corner; only a step that lands
 * exactly on it is home. */
export function buddyPlaceOf(
  left: number,
  top: number,
  size: Size,
  view: Viewport,
  home: BuddyBox,
  snap = true,
): BuddyPlace {
  const l = clamp(left, buddyEdge, view.width - size.width - buddyEdge);
  const t = clamp(top, buddyEdge, view.height - size.height - buddyEdge);
  if (Math.hypot(l - home.left, t - home.top) <= (snap ? buddySnap : 0))
    return "home";
  const right = view.width - l - size.width;
  const bottom = view.height - t - size.height;
  const onLeft = l + size.width / 2 < view.width / 2;
  const onTop = t + size.height / 2 < view.height / 2;
  return Object.freeze({
    h: onLeft ? "left" : "right",
    x: Math.round(onLeft ? l : right),
    v: onTop ? "top" : "bottom",
    y: Math.round(onTop ? t : bottom),
  });
}

/** The arrows' step from a place. */
export function buddyNudge(
  place: BuddyPlace,
  dx: number,
  dy: number,
  size: Size,
  view: Viewport,
  home: BuddyBox,
): BuddyPlace {
  const box = buddyBoxOf(place, size, view, home);
  return buddyPlaceOf(box.left + dx, box.top + dy, size, view, home, false);
}

/** Where something of `want` stands beside the launcher, `gap` from it;
 * `sideways` lets it stand left or right where above and below are short. */
export function buddyBeside(
  launcher: BuddyBox,
  want: Size,
  gap: number,
  view: Viewport,
  sideways = false,
): BuddyBox {
  const width = Math.min(want.width, view.width - 2 * buddyEdge);
  const above = launcher.top - gap - buddyEdge;
  const below =
    view.height - (launcher.top + launcher.height) - gap - buddyEdge;
  if (sideways && Math.max(above, below) < want.height) {
    const toLeft = launcher.left - gap - buddyEdge;
    const toRight =
      view.width - (launcher.left + launcher.width) - gap - buddyEdge;
    if (Math.max(toLeft, toRight) >= width) {
      const height = Math.min(want.height, view.height - 2 * buddyEdge);
      return Object.freeze({
        left:
          toRight >= toLeft
            ? launcher.left + launcher.width + gap
            : launcher.left - gap - width,
        top: clamp(
          launcher.top + launcher.height - height,
          buddyEdge,
          view.height - height - buddyEdge,
        ),
        width,
        height,
      });
    }
  }
  const down = below > above;
  const height = Math.max(0, Math.min(want.height, down ? below : above));
  const onRight = launcher.left + launcher.width / 2 >= view.width / 2;
  return Object.freeze({
    left: clamp(
      onRight ? launcher.left + launcher.width - width : launcher.left,
      buddyEdge,
      view.width - width - buddyEdge,
    ),
    top: down
      ? launcher.top + launcher.height + gap
      : launcher.top - gap - height,
    width,
    height,
  });
}

/** This app's remembered place; home without one, or where the store
 * cannot be read or holds anything else. */
export function readBuddyPlace(store: Store | null): BuddyPlace {
  try {
    const raw = store?.getItem(buddyPlaceKey);
    if (!raw) return "home";
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return "home";
    const { h, x, v, y } = value as Record<string, unknown>;
    if (
      (h === "left" || h === "right") &&
      (v === "top" || v === "bottom") &&
      typeof x === "number" &&
      Number.isFinite(x) &&
      typeof y === "number" &&
      Number.isFinite(y)
    )
      return Object.freeze({ h, x, v, y });
  } catch {}
  return "home";
}

/** Remembers the place for this app; home removes it. */
export function writeBuddyPlace(store: Store | null, place: BuddyPlace): void {
  try {
    if (place === "home") store?.removeItem(buddyPlaceKey);
    else store?.setItem(buddyPlaceKey, JSON.stringify(place));
  } catch {}
}
