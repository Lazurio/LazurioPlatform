import type { Shell } from "./contract";
import {
  acceptNewTabPageMessage,
  type NewTabHostMessage,
  newTabFrameSource,
  newTabHostMessageOf,
  newTabMessage,
} from "./new-tab-protocol";

// `<lazurio-new-tab>` (decision F47 points 1 and 2): Nová karta in the right
// panel of every app of the Environment, which embeds it from
// `/.lazurio/shell.js` as it embeds the rail. In its shadow root it frames
// one page of the Launchpad, `/new-tab` on the origin of the current
// Environment's `apps` (new-tab-protocol.ts), which draws Nová karta and does
// its reads and writes there, same-origin with the Launchpad. The element
// only carries the app's side of the conversation: when the page says it is
// ready, it answers with the app's strip, tools, language and colour roles,
// and again whenever an attribute or the host's theme changes; when the page
// says what the tab became, it dispatches `lazurio-new-tab` with that choice.
// It never navigates the app: the app turns its tab into the choice.
//
// Attributes (interface v1, additive): `strip` (required: without a valid
// one the element frames nothing), `tools` (JSON, `parseNewTabTools`; an
// invalid list is no tools), `focus-address` (presence: the address bar
// takes the keys) and `lang`. The element accepts messages only from its own
// frame's window on the page's origin, and posts only to that origin.
//
// Built by a factory so that it shares the page's shell document with the
// other elements (elements.ts) without importing them.

export type NewTabElementSeams = Readonly<{
  /** The page's own `lazurio.shell.v1` document, or null before it or with
   * nobody signed in. */
  shell: () => Shell | null;
  /** Calls `changed` after every change of the document; returns its
   * removal. */
  listen: (changed: () => void) => () => void;
  /** Reads the document on this origin once, unless the host provides it. */
  request: () => void;
}>;

/** The frame's sandbox: the page keeps its origin, its scripts and its
 * form; the link to another Environment's tab opens a tab of the person's
 * own browser that is not sandboxed; nothing in the frame navigates the
 * app around it. */
export const newTabFrameSandbox =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

const css = `
:host { display: block; position: relative; min-width: 0; min-height: 0; overflow: hidden; }
iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
`;

const frameTitle = { cs: "Nová karta", en: "New tab" } as const;

export function newTabElement(
  seams: NewTabElementSeams,
): CustomElementConstructor {
  return class LazurioNewTab extends HTMLElement {
    static observedAttributes = ["strip", "tools", "focus-address", "lang"];
    private readonly root: ShadowRoot;
    private frame: HTMLIFrameElement | null = null;
    /** The frame's address and its origin, the only one heard. */
    private source: string | null = null;
    private pageOrigin: string | null = null;
    /** The page said it is ready; the host message goes only after that. */
    private ready = false;
    /** The frame took the focus once for `focus-address`. */
    private focused = false;
    /** The host message last sent, as JSON. */
    private sent: string | null = null;
    private unlisten: (() => void) | null = null;
    private observer: MutationObserver | null = null;
    private readonly scheme = window.matchMedia("(prefers-color-scheme: dark)");
    private readonly onMessage = (event: MessageEvent) => this.receive(event);
    private readonly retheme = () => this.send(false);

    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      this.root.adoptedStyleSheets = [sheet];
    }

    connectedCallback() {
      this.unlisten ??= seams.listen(() => this.render());
      seams.request();
      window.addEventListener("message", this.onMessage);
      // The host's theme may change its colour roles on its document (a
      // dark skin, a class or style on <html>): the page follows.
      this.observer ??= new MutationObserver(this.retheme);
      this.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
      this.scheme.addEventListener("change", this.retheme);
      this.render();
    }

    disconnectedCallback() {
      this.unlisten?.();
      this.unlisten = null;
      window.removeEventListener("message", this.onMessage);
      this.observer?.disconnect();
      this.observer = null;
      this.scheme.removeEventListener("change", this.retheme);
      this.frame?.remove();
      this.frame = null;
      this.source = null;
      this.pageOrigin = null;
      this.ready = false;
    }

    attributeChangedCallback(
      name: string,
      before: string | null,
      after: string | null,
    ) {
      if (!this.isConnected) return;
      this.render();
      // `focus-address` set on a page already shown: the frame takes the
      // focus as on its first `ready`, so the address bar gets the keys.
      if (
        name === "focus-address" &&
        before === null &&
        after !== null &&
        this.ready
      ) {
        this.focused = true;
        this.frame?.focus();
      }
      this.send(false);
    }

    /** What the page hears from this element now; null without a strip. */
    private hostMessage(): NewTabHostMessage | null {
      const styles = getComputedStyle(document.documentElement);
      return newTabHostMessageOf({
        strip: this.getAttribute("strip"),
        tools: this.getAttribute("tools"),
        focusAddress: this.hasAttribute("focus-address"),
        lang: this.getAttribute("lang"),
        locale: seams.shell()?.locale ?? "en",
        role: (name) => styles.getPropertyValue(name),
      });
    }

    /** The frame for the current document and strip: built when its
     * address changes, removed when there is none. */
    private render() {
      const message = this.hostMessage();
      const source =
        message === null
          ? null
          : newTabFrameSource(seams.shell(), location.href);
      const href = source?.href ?? null;
      if (href !== null && href === this.source && this.frame !== null) {
        if (message !== null) this.frame.title = frameTitle[message.lang];
        return;
      }
      this.frame?.remove();
      this.frame = null;
      this.ready = false;
      this.sent = null;
      this.focused = false;
      this.source = href;
      this.pageOrigin = source?.origin ?? null;
      if (source === null || message === null) {
        this.root.replaceChildren();
        return;
      }
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", newTabFrameSandbox);
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = frameTitle[message.lang];
      frame.src = source.href;
      this.frame = frame;
      this.root.replaceChildren(frame);
    }

    private receive(event: MessageEvent) {
      const frame = this.frame;
      if (frame === null) return;
      const message = acceptNewTabPageMessage(
        {
          data: event.data,
          origin: event.origin,
          fromFrame:
            event.source !== null && event.source === frame.contentWindow,
        },
        this.pageOrigin,
        this.hostMessage()?.tools ?? [],
      );
      if (message === null) return;
      if (message.type === newTabMessage.ready) {
        // A page loaded (again): it hears everything anew.
        this.ready = true;
        if (this.hasAttribute("focus-address") && !this.focused) {
          this.focused = true;
          frame.focus();
        }
        this.send(true);
        return;
      }
      this.dispatchEvent(
        new CustomEvent("lazurio-new-tab", {
          detail: message.choice,
          bubbles: true,
          composed: true,
        }),
      );
    }

    /** The host message to a ready page: always after its `ready`,
     * otherwise only when it says something new. */
    private send(force: boolean) {
      const frame = this.frame;
      if (!this.ready || frame === null || this.pageOrigin === null) return;
      const message = this.hostMessage();
      if (message === null) return;
      const text = JSON.stringify(message);
      if (!force && text === this.sent) return;
      this.sent = text;
      frame.contentWindow?.postMessage(message, this.pageOrigin);
    }
  };
}
