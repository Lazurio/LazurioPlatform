import type { MessageKey } from "./messages";
import { fill } from "./update-view";

// Guide videos (docs/launchpad-development.md "Guide videos"): a short
// silent video that shows a guide's steps, in the page's language, beside the
// steps themselves, which stay its text. One button, "Přehrát video", opens
// the browser's own player in its place and plays it: never before the
// person asks, never with sound (the files carry no audio track), loaded only
// then (`preload="none"`), inline on a phone (`playsinline`), with the
// browser's own controls for the keyboard and a screen reader. Where the
// video is its section's own content (Nastavení → Trezor without a vault),
// the player shows from the start instead, paused at its poster, and plays
// only when the person starts it (`open`). This module is the page's side
// and builds only addresses; guide-video-files.ts embeds the
// files in the executable and serves them, by byte range for Safari.

type Copy = Readonly<Record<MessageKey, string>>;

/** The guide videos the Launchpad carries, each in both languages, as
 * `src/launchpad/videos/<name>-<cs|en>.mp4` (H.264, no audio track, the index
 * first) with its poster `<name>-<cs|en>.webp`: `vault-bitwarden`, the vault
 * in the Bitwarden extension; `vault-overview`, how an Environment's vault
 * works in an Organization (DEV-6631). */
export const guideVideoNames = ["vault-bitwarden", "vault-overview"] as const;
export type GuideVideoName = (typeof guideVideoNames)[number];
export const guideVideoLocales = ["cs", "en"] as const;
export type GuideVideoLocale = (typeof guideVideoLocales)[number];

/** Where the Launchpad serves the files: `/videos/<file>`. */
export const guideVideoPath = "/videos/";

/** The file of a guide video, or of its poster, in one language. */
export function guideVideoFile(
  name: GuideVideoName,
  locale: GuideVideoLocale,
  kind: "video" | "poster",
): string {
  const extension = kind === "video" ? ".mp4" : ".webp";
  return `${name}-${locale}${extension}`;
}

/** What the player shows: the button that opens it, and the browser's own
 * player it opens. */
export type GuideVideoPlayer = Readonly<{
  /** The button: its visible words and its accessible name, which begins
   * with them and names the video. */
  play: Readonly<{ label: string; name: string }>;
  video: Readonly<{
    src: string;
    type: "video/mp4";
    poster: string;
    /** The player's accessible name: the video's title. */
    name: string;
    /** The element whose text the video shows (the steps), or null. */
    describedBy: string | null;
    /** Its attributes, exactly: the browser's controls, inline on a phone,
     * nothing loaded before it plays. Never `autoplay`, `muted` or
     * `loop`. */
    attributes: Readonly<
      Record<"controls" | "playsinline" | "preload", string>
    >;
  }>;
}>;

/** One guide video in the page's language. */
export function guideVideoPlayer(
  input: Readonly<{
    name: GuideVideoName;
    locale: GuideVideoLocale;
    /** The video's title, in the page's language. */
    title: string;
    describedBy?: string | null;
  }>,
  copy: Copy,
): GuideVideoPlayer {
  return {
    play: {
      label: copy.guideVideoPlay,
      name: fill(copy.guideVideoPlayNamed, { title: input.title }),
    },
    video: {
      src: `${guideVideoPath}${guideVideoFile(input.name, input.locale, "video")}`,
      type: "video/mp4",
      poster: `${guideVideoPath}${guideVideoFile(input.name, input.locale, "poster")}`,
      name: input.title,
      describedBy: input.describedBy ?? null,
      attributes: { controls: "", playsinline: "", preload: "none" },
    },
  };
}

/** The player in `slot`: the button, until the person presses it; then the
 * video in its place, focused and playing. With `open`, the video is there
 * from the start instead, paused at its poster, until the person plays it.
 * `render` follows the page's language: the button's words, or, once open, a
 * video in the new language, paused at its poster. */
export function createGuideVideo(
  slot: HTMLElement,
  options: Readonly<{
    name: GuideVideoName;
    title: () => string;
    describedBy?: string;
    copy: () => Copy;
    locale: () => GuideVideoLocale;
    /** The player from the start, where the video is its section's own
     * content; nothing of it loads but its poster until it plays. */
    open?: boolean;
  }>,
): Readonly<{ render(): void }> {
  const player = () =>
    guideVideoPlayer(
      {
        name: options.name,
        locale: options.locale(),
        title: options.title(),
        describedBy: options.describedBy ?? null,
      },
      options.copy(),
    );
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button guide-video-play";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "icon");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-play");
  icon.append(use);
  const label = document.createElement("span");
  button.append(icon, label);
  let open: Readonly<{ video: HTMLVideoElement; src: string }> | null = null;

  function videoOf(shown: GuideVideoPlayer): HTMLVideoElement {
    const video = document.createElement("video");
    video.className = "guide-video-player";
    for (const [key, value] of Object.entries(shown.video.attributes))
      video.setAttribute(key, value);
    video.poster = shown.video.poster;
    video.setAttribute("aria-label", shown.video.name);
    if (shown.video.describedBy !== null)
      video.setAttribute("aria-describedby", shown.video.describedBy);
    // The files are 1920×1080: the page keeps their place before they load.
    video.width = 1920;
    video.height = 1080;
    const source = document.createElement("source");
    source.src = shown.video.src;
    source.type = shown.video.type;
    video.append(source);
    return video;
  }

  button.addEventListener("click", () => {
    const shown = player();
    const video = videoOf(shown);
    slot.replaceChildren(video);
    open = { video, src: shown.video.src };
    video.focus();
    // The person's own press: the browser plays it. Should it refuse, the
    // player's controls are there to start it.
    void video.play().catch(() => undefined);
  });

  function render() {
    const shown = player();
    if (open === null) {
      label.textContent = shown.play.label;
      button.setAttribute("aria-label", shown.play.name);
      if (slot.firstChild !== button) slot.replaceChildren(button);
      return;
    }
    if (open.src === shown.video.src) {
      open.video.setAttribute("aria-label", shown.video.name);
      return;
    }
    // The page's language changed: the video in it, not playing.
    open.video.pause();
    const video = videoOf(shown);
    slot.replaceChildren(video);
    open = { video, src: shown.video.src };
  }

  if (options.open === true) {
    const shown = player();
    const video = videoOf(shown);
    slot.replaceChildren(video);
    open = { video, src: shown.video.src };
  }
  render();
  return Object.freeze({ render });
}
