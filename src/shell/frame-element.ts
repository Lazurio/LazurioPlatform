import type { VersionFrame } from "./env-frame";
import { frameCss } from "./frame-styles";

// The frame that `<lazurio-buddy>` draws (decision 0248's addendum of
// 2026-11-15 and 0249's of 2026-11-22): one element carries Buddy and the
// frame, as the overlay of 0180 does, so whoever delivers Buddy to a page
// (the Environment's gateway for STAGING, the module kit's development
// server for DEV, the application host's gateway for PROD, where nothing is
// framed) delivers the frame with him and nothing else decides it. Whether
// and which frame is drawn is the pure rule of env-frame.ts, from the page's
// shell document and the account, never from the page.
//
// The frame lives in a layer of its own on the document, not inside the
// element: the element may be hidden (its launcher, F60's addendum of
// 2026-10-25), the frame never is. It never takes a click and does not move.

/** What the layer draws: the frame's box with its label, or nothing. */
export function frameNodes(frame: VersionFrame | null): HTMLElement[] {
  if (frame === null) return [];
  const box = document.createElement("div");
  box.className = "frame";
  box.dataset.tone = frame.tone;
  if (frame.dashed) box.dataset.dashed = "";
  const label = document.createElement("span");
  label.className = "label";
  if (frame.version !== null) {
    const version = document.createElement("span");
    version.className = "version";
    version.textContent = frame.version;
    label.append(version);
  }
  if (frame.environment !== null) {
    const environment = document.createElement("span");
    environment.className = "environment";
    environment.textContent = frame.environment;
    label.append(environment);
  }
  box.append(label);
  return [box];
}

/** The one frame layer of a document: drawn again only when the frame
 * changes, removed when nothing is framed. */
export function createFrameLayer(target: Document) {
  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let drawn: string | undefined;
  return {
    draw(frame: VersionFrame | null): void {
      const key = JSON.stringify(frame);
      if (key === drawn) return;
      drawn = key;
      if (frame === null) {
        host?.remove();
        host = null;
        root = null;
        return;
      }
      if (host === null || root === null) {
        host = target.createElement("div");
        host.dataset.lazurioFrame = "";
        root = host.attachShadow({ mode: "open" });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(frameCss);
        root.adoptedStyleSheets = [sheet];
        target.documentElement.append(host);
      }
      // A screen reader hears whose page it is once, as a note.
      host.setAttribute("role", "note");
      host.setAttribute(
        "aria-label",
        [frame.version, frame.environment].filter(Boolean).join(" · "),
      );
      root.replaceChildren(...frameNodes(frame));
    },
  };
}
