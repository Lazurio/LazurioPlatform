import type { VersionFrame } from "./env-frame";
import { frameCss } from "./frame-styles";

// `<lazurio-frame>` (interface v1, additive): the frame of a page of an
// Environment that is not the person's own (decision 0248's addendum of
// 2026-11-15) and of a Module's app in an Environment (0249's addendum of
// 2026-11-22), drawn by the shell the page loads, as the overlay with Buddy
// (0180). `version`: "staging" or "dev" on a Module's app; absent on any
// other page, which takes 0248's frame alone. `lang` as on the other
// elements. Whose the Environment is comes from the page's shell document
// and the account, never from the page (env-frame.ts). It never takes a
// click and does not move: the frame is a state, seen at once. No events.
//
// Built by a factory, as `<lazurio-environment>` is, so it draws from
// whatever the page knows (elements.ts).

export type FrameElementSeams = Readonly<{
  /** The frame for the element's `version` and `lang` attributes (null
   * where absent); null for none. */
  frame: (version: string | null, lang: string | null) => VersionFrame | null;
  /** Calls `changed` after every change of what the page knows; returns
   * its removal. */
  listen: (changed: () => void) => () => void;
  /** Reads what the page needs, once, unless the host provides it. */
  request: () => void;
}>;

/** What the element draws: the frame's box with its label, or nothing. */
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

export function frameElement(
  seams: FrameElementSeams,
): CustomElementConstructor {
  let sheet: CSSStyleSheet | null = null;
  return class LazurioFrame extends HTMLElement {
    static observedAttributes = ["version", "lang"];
    private readonly root: ShadowRoot;
    private unlisten: (() => void) | null = null;
    private drawn: string | undefined = undefined;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open" });
      if (sheet === null) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(frameCss);
      }
      this.root.adoptedStyleSheets = [sheet];
    }

    connectedCallback() {
      this.unlisten ??= seams.listen(() => this.render());
      seams.request();
      this.render();
    }

    disconnectedCallback() {
      this.unlisten?.();
      this.unlisten = null;
    }

    attributeChangedCallback() {
      if (this.isConnected) this.render();
    }

    private render() {
      const frame = seams.frame(
        this.getAttribute("version"),
        this.getAttribute("lang"),
      );
      const drawn = JSON.stringify(frame);
      if (drawn === this.drawn) return;
      this.drawn = drawn;
      // A screen reader hears whose page it is once, as a note.
      if (frame === null) this.removeAttribute("role");
      else {
        this.setAttribute("role", "note");
        this.setAttribute(
          "aria-label",
          [frame.version, frame.environment].filter(Boolean).join(" · "),
        );
      }
      this.root.replaceChildren(...frameNodes(frame));
    }
  };
}
