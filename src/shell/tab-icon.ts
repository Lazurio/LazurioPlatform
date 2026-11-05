import type { Shell } from "./contract";
import { vendorText } from "./vendor-text" with { type: "macro" };

// The browser tab's icon on a page that shows the shell (F36's addendum of
// 2026-10-08): Apps, Chat and Automate of an Environment carry the icon of
// the Organization the Environment belongs to, so a person with several tabs
// sees at once whose Environment each is. A personal Environment, a
// workstation and an Organization without an avatar carry Lazurio's symbol.
// A page that belongs to no Environment (the Dashboard's) keeps its own icon.
// The shell sets it from the person's document, the same in all three apps,
// and replaces the app's own icon links so the browser shows this one.
//
// The icon is the avatar's image drawn into PNG, not the avatar's URL. A
// GitHub avatar keeps one URL for good (`…/u/<id>?v=4`), whatever image the
// Organization uploads, and Safari keeps a tab's icon by its URL for weeks
// without asking again: an Organization that uploaded its logo after its
// Environment was first opened still showed GitHub's generated default
// avatar there. A PNG `data:` URL changes exactly when the image does, and
// Safari takes it as a tab icon (32 px) and as the touch icon of its
// Favourites and the Dock (180 px), which an SVG or the avatar's JPEG is not
// everywhere.

/** Lazurio's symbol, inline: no request, the same on every origin. */
export const LAZURIO_TAB_ICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  vendorText("symbol-color.svg"),
)}`;

/** The tab icon's edge in pixels (`<link rel="icon" sizes>`). */
export const TAB_ICON_SIZE = 32;
/** The touch icon's edge in pixels (`<link rel="apple-touch-icon" sizes>`),
 * as Safari asks for it on a Mac, an iPhone and an iPad. */
export const TOUCH_ICON_SIZE = 180;

/** The icon of a person's document: the current Environment's Organization
 * by its avatar, else Lazurio's symbol; null on a page that belongs to no
 * Environment. */
export function tabIconFor(shell: Shell): string | null {
  if (shell.current === null) return null;
  const environment = shell.environments.find(
    (entry) => entry.id === shell.current,
  );
  if (environment === undefined) return null;
  const owner =
    environment.kind === "personal" || environment.kind === "workstation"
      ? undefined
      : environment.organizations[0];
  const avatar =
    owner === undefined
      ? null
      : (shell.organizations.find((entry) => entry.slug === owner)?.avatar ??
        null);
  return avatar ?? LAZURIO_TAB_ICON;
}

/** Where the page reads the icon's image from: a GitHub avatar straight from
 * `avatars.githubusercontent.com` at the touch icon's size, because that
 * host lets a page of any origin read the image and `github.com/<login>.png`
 * only redirects there without letting it; any other URL as it is. */
export function iconSourceUrl(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== "https:") return href;
  if (url.hostname === "github.com") {
    const login = /^\/([A-Za-z0-9-]{1,39})\.png$/.exec(url.pathname)?.[1];
    return login === undefined
      ? href
      : `https://avatars.githubusercontent.com/${login}?s=${TOUCH_ICON_SIZE}`;
  }
  if (url.hostname === "avatars.githubusercontent.com") {
    url.searchParams.delete("size");
    url.searchParams.set("s", String(TOUCH_ICON_SIZE));
    return url.href;
  }
  return href;
}

/** An icon drawn into PNG `data:` URLs at the tab's and the touch icon's
 * size. */
export type RenderedIcon = Readonly<{ tab: string; touch: string }>;

/** Draws the image at a URL into a `RenderedIcon`; null (or a rejection)
 * when it cannot, and the icon then links the URL itself. */
export type IconRenderer = (source: string) => Promise<RenderedIcon | null>;

/** The part of a link element the tab icon sets. */
export type IconLink = {
  id: string;
  rel: string;
  href: string;
  setAttribute(name: "type" | "sizes", value: string): void;
  removeAttribute(name: "type" | "sizes"): void;
  remove(): void;
};

/** The part of a document the tab icon touches. */
export type IconDocument = {
  querySelectorAll(selector: string): Iterable<{ id: string; remove(): void }>;
  getElementById(id: string): IconLink | null;
  createElement(tag: "link"): IconLink;
  readonly head: { append(node: unknown): void };
};

const ICON_ID = "lazurio-tab-icon";
const TOUCH_ID = "lazurio-touch-icon";

/** Every icon link an app may carry of its own: the tab's (`icon`, also in
 * `shortcut icon`) and the touch icons Safari prefers for its Favourites. */
const APP_ICONS =
  'link[rel~="icon"], link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]';

type Shown = Readonly<{
  tab: string;
  /** `type` and `sizes` of the tab's link: only a drawn PNG has them. */
  png: boolean;
  /** The touch icon's URL; null: none (Safari draws no SVG there). */
  touch: string | null;
}>;

/** Sets the tab icon from each person's document: draws the icon's image
 * into PNG and links that; until it is drawn the page keeps the icon it has,
 * and when it cannot be drawn the icon links the image's URL as before. A
 * new document with the same icon changes nothing; a drawing that finishes
 * after another icon was asked for is dropped. Without a document (a test,
 * a worker) it does nothing. */
export function createTabIcon(
  doc: IconDocument | null,
  render: IconRenderer = renderIcon,
) {
  let wanted: string | null = null;
  // Each drawing's own number: only the newest request may show its
  // result, so in A → B → A the first A's drawing, finishing last, never
  // lands over the second A's, even under the same URL whose image may
  // have changed in between.
  let latest = 0;
  const show = (icon: Shown) => {
    if (doc === null) return;
    for (const link of doc.querySelectorAll(APP_ICONS))
      if (link.id !== ICON_ID && link.id !== TOUCH_ID) link.remove();
    const tab = linkOf(doc, ICON_ID, "icon");
    tab.href = icon.tab;
    if (icon.png) {
      tab.setAttribute("type", "image/png");
      tab.setAttribute("sizes", `${TAB_ICON_SIZE}x${TAB_ICON_SIZE}`);
    } else {
      tab.removeAttribute("type");
      tab.removeAttribute("sizes");
    }
    if (icon.touch === null) {
      doc.getElementById(TOUCH_ID)?.remove();
      return;
    }
    const touch = linkOf(doc, TOUCH_ID, "apple-touch-icon");
    touch.href = icon.touch;
    touch.setAttribute("sizes", `${TOUCH_ICON_SIZE}x${TOUCH_ICON_SIZE}`);
  };
  return (shell: Shell): Promise<void> => {
    if (doc === null) return Promise.resolve();
    const href = tabIconFor(shell);
    if (href === null || href === wanted) return Promise.resolve();
    wanted = href;
    const request = ++latest;
    const linked: Shown = {
      tab: href,
      png: false,
      touch: href.startsWith("data:image/svg+xml") ? null : href,
    };
    return render(iconSourceUrl(href)).then(
      (drawn) => {
        if (request !== latest) return;
        show(
          drawn === null
            ? linked
            : { tab: drawn.tab, png: true, touch: drawn.touch },
        );
      },
      () => {
        if (request === latest) show(linked);
      },
    );
  };
}

/** The link with `id`, appended to the head with `rel` when it is not
 * there yet. */
function linkOf(doc: IconDocument, id: string, rel: string): IconLink {
  const existing = doc.getElementById(id);
  if (existing !== null) return existing;
  const link = doc.createElement("link");
  link.id = id;
  link.rel = rel;
  doc.head.append(link);
  return link;
}

/** Draws the image at `source` in the page: asked again of its server each
 * time (`no-cache`, a conditional request), so a new avatar shows on the
 * next page load, read without credentials and cut to a centred square. */
export async function renderIcon(source: string): Promise<RenderedIcon | null> {
  if (typeof document === "undefined") return null;
  const response = await fetch(source, {
    cache: "no-cache",
    credentials: "omit",
    mode: "cors",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) return null;
  // The image from its own blob: the canvas stays readable whatever origin
  // the bytes came from, and an SVG draws as well as a JPEG or a PNG.
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      tab: drawPng(image, TAB_ICON_SIZE),
      touch: drawPng(image, TOUCH_ICON_SIZE),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawPng(image: HTMLImageElement, size: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context");
  context.imageSmoothingQuality = "high";
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width > 0 && height > 0) {
    const side = Math.min(width, height);
    context.drawImage(
      image,
      (width - side) / 2,
      (height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
  } else context.drawImage(image, 0, 0, size, size);
  return canvas.toDataURL("image/png");
}

/** This page's tab icon, used by the shell's state. */
export const applyTabIcon = createTabIcon(
  typeof document === "undefined"
    ? null
    : (document as unknown as IconDocument),
);
