import {
  createGuideVideo,
  type GuideVideoLocale,
  type GuideVideoName,
} from "./guide-video";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// A guide video in place, under its page's heading (decision F56's addenda
// of 2026-10-18 and (4) of 2026-10-19): Trezor's, where the approved video
// of how a vault works in an Organization (`vault-overview`, DEV-6631,
// design-system-lazurio#93) is true of this Environment (guides.ts
// `vaultHelp`). The shell's guide draws rings and cards, not a video, so the
// page shows the video itself, with the one line under it that the video
// does not say. It is the first thing the page shows: it stands open as the
// page opens, at its poster, playing nothing and moving no focus, and the
// person starts it. The "?" closes it and opens it again (and then plays
// it; with less motion it waits at its poster); Escape closes it. Closed by
// the person, it stays closed until the page moves on, and the next visit
// opens it again. The player is guide-video.ts's: the browser's own, no
// sound, nothing but its poster loaded before it plays.

/** Where the box stands, kept per visit of a page. */
export type HelpVideoVisit = Readonly<{
  /** The page the box was last drawn on, null before the first drawing. */
  page: string | null;
  /** Whether the person closed it on that page. */
  closed: boolean;
}>;

/** One drawing of the page: whether the box stands open, and the visit it
 * leaves. It opens where the video applies (its words are true of this
 * Environment); a new page starts a new visit, and within one the person's
 * closing holds. */
export function helpVideoDrawing(
  visit: HelpVideoVisit,
  now: Readonly<{ page: string; applies: boolean }>,
): Readonly<{ open: boolean; visit: HelpVideoVisit }> {
  const closed = visit.page === now.page && visit.closed;
  return {
    open: now.applies && !closed,
    visit: { page: now.page, closed },
  };
}

export function createHelpVideo(
  options: Readonly<{
    /** What opens: the player's slot and the line, hidden until then. */
    box: HTMLElement;
    slot: HTMLElement;
    /** The id of the line the video is described by. */
    line: string;
    name: GuideVideoName;
    title: () => string;
    copy: () => Copy;
    locale: () => GuideVideoLocale;
  }>,
) {
  let player: Readonly<{ render(): void }> | null = null;
  let invoker: HTMLElement | null = null;
  let visit: HelpVideoVisit = { page: null, closed: false };

  const video = () => options.slot.querySelector("video");
  const still = () =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  // The box open at the video's start, nothing playing and the focus where
  // it was: at its poster the first time, at its first frame on a later
  // visit once it played.
  function show(from: HTMLElement): void {
    invoker = from;
    from.setAttribute("aria-expanded", "true");
    if (!options.box.hidden) return;
    options.box.hidden = false;
    if (player === null)
      player = createGuideVideo(options.slot, {
        name: options.name,
        title: options.title,
        describedBy: options.line,
        copy: options.copy,
        locale: options.locale,
        open: true,
      });
    else {
      player.render();
      const shown = video();
      if (shown !== null && shown.currentTime > 0) shown.currentTime = 0;
    }
  }

  // The person's "?": the box open, and the video playing from its start.
  function open(from: HTMLElement): void {
    show(from);
    const shown = video();
    if (shown === null) return;
    shown.currentTime = 0;
    shown.focus({ preventScroll: true });
    options.box.scrollIntoView({ block: "nearest" });
    // The person's own press: the browser plays it. Should it refuse, the
    // player's controls are there to start it.
    if (!still()) void shown.play().catch(() => undefined);
  }

  function close(): void {
    if (options.box.hidden) return;
    video()?.pause();
    const within = options.box.contains(document.activeElement);
    options.box.hidden = true;
    invoker?.setAttribute("aria-expanded", "false");
    if (within && invoker?.isConnected) invoker.focus({ preventScroll: true });
  }

  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      options.box.hidden ||
      document.querySelector("dialog[open]") !== null
    )
      return;
    event.preventDefault();
    const back = invoker;
    close();
    visit = { ...visit, closed: true };
    if (back?.isConnected) back.focus({ preventScroll: true });
  });

  return Object.freeze({
    /** The "?" pressed: opens the video and plays it, or closes it again. */
    toggle(from: HTMLElement): void {
      if (options.box.hidden) {
        open(from);
        visit = { ...visit, closed: false };
      } else {
        close();
        visit = { ...visit, closed: true };
        from.focus({ preventScroll: true });
      }
    },
    /** The page drawn: `from` is the "?" where the video is true of it,
     * null where it is not (the box closes); `page` names the page, so a
     * new visit opens it again. */
    draw(from: HTMLElement | null, page: string): void {
      const drawn = helpVideoDrawing(visit, { page, applies: from !== null });
      visit = drawn.visit;
      if (from !== null && drawn.open) show(from);
      else close();
    },
    /** Whether it is open now. */
    get open(): boolean {
      return !options.box.hidden;
    },
    /** The page's language changed: a video in it, paused. */
    render(): void {
      player?.render();
    },
  });
}
