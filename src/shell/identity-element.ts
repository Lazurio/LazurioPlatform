import { icon } from "./icons";
import { environmentCss } from "./identity-styles";
import {
  type EnvironmentIdentity,
  type IdentityLook,
  identityText,
} from "./view";

// The one drawing of how the shell names an Environment (F39's addendum of
// 2026-10-12): the glyph and the words of an identity (`drawIdentity`),
// which the column head's picker draws, and `<lazurio-environment>`, which
// draws them on one line wherever an app or the Environment browser's view
// names an Environment. Matěj asked that the switcher and the view's bar
// never name one Environment two ways; they now share this drawing and the
// identity of `environmentIdentity` (view.ts).
//
// `<lazurio-environment>` (interface v1, additive): `environment`, the
// Environment's id (F37's addendum of 2026-10-04: its base host,
// `<machine>.<org>` or a personal DNS slug); absent, the page's own
// Environment. `lang` as on the other elements. It draws that Environment's
// identity as the page knows it and redraws when that changes; until the
// page knows it (no document yet, the person's account not read yet, an
// Environment the account does not list) it shows its own children, so a
// host may put a plain label inside it. No events.
//
// Built by a factory, as Nová karta's element is, so that it draws from
// whatever the page knows: the shell's merged state in an app (elements.ts),
// the identity its server and the app around it gave in the Environment
// browser's view (src/browser/people/client.ts).

const span = (className: string, text?: string): HTMLSpanElement => {
  const node = document.createElement("span");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** An Organization's avatar, or its initials when there is none or it does
 * not load. */
export function organizationMark(
  avatar: string | null,
  initials: string,
): HTMLSpanElement {
  const mark = span("org-mark");
  const fallback = () => mark.replaceChildren(initials);
  if (avatar === null) fallback();
  else {
    const image = document.createElement("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.src = avatar;
    image.addEventListener("error", fallback, { once: true });
    mark.append(image);
  }
  return mark;
}

/** The glyph (`.identity-glyph`) and the words (`.identity-text`: the name
 * `.identity-name` and who it is for `.identity-who`) of what a head names.
 * Each surface lays them out with its own styles (styles.ts). */
export function drawIdentity(
  look: IdentityLook,
): readonly [HTMLSpanElement, HTMLSpanElement] {
  const glyph = span("identity-glyph");
  const mark = look.glyph;
  if (mark.kind === "avatar")
    glyph.append(organizationMark(mark.avatar, mark.initials));
  else if (mark.kind === "initials") glyph.append(span("initials", mark.text));
  else glyph.append(icon(mark.icon, 18));
  const text = span("identity-text");
  text.append(span("identity-name", look.name));
  if (look.who !== "") text.append(span("identity-who", look.who));
  return [glyph, text];
}

export type EnvironmentElementSeams = Readonly<{
  /** The identity to draw for the element's `environment`, `lang` and
   * `space` attributes (null where absent); null while the page does not
   * know it. */
  identity: (
    environment: string | null,
    lang: string | null,
    space: string | null,
  ) => EnvironmentIdentity | null;
  /** Calls `changed` after every change of what the page knows; returns
   * its removal. */
  listen: (changed: () => void) => () => void;
  /** Reads what the page needs, once, unless the host provides it. */
  request: () => void;
}>;

export function environmentElement(
  seams: EnvironmentElementSeams,
): CustomElementConstructor {
  // One stylesheet for every instance: a host may name several Environments.
  let sheet: CSSStyleSheet | null = null;
  return class LazurioEnvironment extends HTMLElement {
    static observedAttributes = ["environment", "lang", "space"];
    private readonly root: ShadowRoot;
    private unlisten: (() => void) | null = null;
    /** The identity drawn, as JSON; null: the element's own children;
     * undefined: nothing drawn yet. Redrawn only when it changes, so the
     * avatar is not loaded again on every change of the page's state. */
    private drawn: string | null | undefined = undefined;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open" });
      if (sheet === null) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(environmentCss);
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
      const identity = seams.identity(
        this.getAttribute("environment"),
        this.getAttribute("lang"),
        this.getAttribute("space"),
      );
      const drawn = identity === null ? null : JSON.stringify(identity);
      if (drawn === this.drawn) return;
      this.drawn = drawn;
      if (identity === null) {
        this.root.replaceChildren(document.createElement("slot"));
        return;
      }
      const box = span("identity");
      box.title = identityText(identity);
      box.append(...drawIdentity(identity));
      this.root.replaceChildren(box);
    }
  };
}
