import {
  createGuideVideo,
  type GuideVideoLocale,
  type GuideVideoName,
} from "./guide-video";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// A "?" that opens a guide video in place (decision F56's addendum of
// 2026-10-18): Trezor's, where the approved video of how a vault works in
// an Organization (`vault-overview`, DEV-6631, design-system-lazurio#93) is
// true of this Environment (guides.ts `vaultHelp`). The shell's guide draws
// rings and cards, not a video, and a new scene was not to be made, so the
// page plays the video itself, under its heading, with the one line under
// it that the video does not say. The person's press of the "?" starts it;
// with less motion it opens at its poster and plays when the person starts
// it. The "?" again, Escape, or the page moving on closes it, and the focus
// goes back to the "?". The player is guide-video.ts's: the browser's own,
// no sound, nothing loaded before it opens.

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

  const video = () => options.slot.querySelector("video");
  const still = () =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  function open(from: HTMLElement): void {
    invoker = from;
    options.box.hidden = false;
    from.setAttribute("aria-expanded", "true");
    if (player === null)
      player = createGuideVideo(options.slot, {
        name: options.name,
        title: options.title,
        describedBy: options.line,
        copy: options.copy,
        locale: options.locale,
        open: true,
      });
    else player.render();
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
    if (back?.isConnected) back.focus({ preventScroll: true });
  });

  return Object.freeze({
    /** The "?" pressed: opens the video, or closes it again. */
    toggle(from: HTMLElement): void {
      if (options.box.hidden) open(from);
      else {
        close();
        from.focus({ preventScroll: true });
      }
    },
    close,
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
