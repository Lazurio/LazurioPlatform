import { currentEnvironment, type Shell } from "./contract";
import {
  type GuideExplanation,
  pageGuideIn,
  parseGuides,
  principleIds,
  principleIn,
} from "./guide-content";
import { type GuideScene, guideScene } from "./guide-scenes";
import type { KindLocale } from "./kind-name";
import type { ShellCopy } from "./messages";

// The guide's engine (decision F56; root decision 0180's addendum of
// 2026-10-18): Buddy, or without him the neutral guide of Lazurio, explains
// a page in place, a ring around the real element and a card beside it, and
// the layer lets every click through. It lives in the shell, so every app
// that loads `/.lazurio/shell.js` (the Launchpad, the Dashboard by its pin,
// the T3 Code and MausBot forks) has one engine and one check of who may ask.
// This module decides what is drawn and when; guide-layer.ts draws it in
// `<lazurio-buddy>`'s shadow root, and elements.ts wires the two to the page.
//
// A page takes part only by asking: it hands over the explanations of the
// page it shows (`provideGuides`, null to withdraw), places `<lazurio-buddy>`
// and marks its "?" with `data-guide-help="<id>"`. Until then the engine
// draws nothing, listens to nothing and keeps nothing of the page: the forks,
// which place `<lazurio-buddy>` and call nothing, are unchanged. A "?" plays
// a principle or an explanation of this page, directly, without a message.
// Where the page shows Buddy's bubble (decision F60, `buddy`), his frame asks
// by id through guide-protocol.ts (buddy-bubble.ts wires the receiver): the
// principles are known on every such page, a fork's too, and the page's own
// explanations where it hands them over; the "?" is listened to only where
// the page hands them over. There Buddy presents every explanation himself
// (decision F56's addendum (7) of 2026-10-25, `GuideView.buddy`): the same
// words and steps, only who says them changes.
//
// Never two tours at once (`attention`): while the page's onboarding tour
// (the Launchpad's Začínáme) wants the person's attention, a "?" plays
// nothing and draws nothing beside the tour's bubble: the tour hears that
// the person asked (and points to its own bubble), and assistive technology
// hears that Začínáme comes first, as Buddy's thread says it in the
// prototype. The tour waits while the guide is out.
//
// A principle plays its scene while it explains (decision F56's addendum (3)
// of 2026-10-19, guide-scenes.ts): one beat a step, keyed by the principle's
// id and the step, drawn in the card. A host's own explanation has none, and
// nothing of it is part of interface v1.

/** The element a "?" is: the guide returns the focus to it. */
export type GuideInvoker = Readonly<{
  readonly isConnected: boolean;
  focus(options?: { preventScroll?: boolean }): void;
  getBoundingClientRect(): Readonly<{
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  }>;
}>;

/** What the layer draws: one step of an explanation. */
export type GuideView = Readonly<{
  explanation: GuideExplanation;
  stop: number;
  /** Where "Založte si Buddyho" leads at the last step of an explanation
   * about Buddy, for a person without Buddy; else null. */
  invite: string | null;
  words: ShellCopy;
  invoker: GuideInvoker | null;
  /** The principle's scene at this step, or null: Trezor and a host's
   * explanation have none. Decorative; the step's text says it. */
  scene: GuideScene | null;
  /** Who presents the step (decision F56's addendum (7) of 2026-10-25):
   * Buddy where the page shows his bubble, with his picture, which his origin
   * serves; null: the neutral guide of Lazurio, its mark and its name. */
  buddy: GuideBuddy | null;
}>;

/** Buddy as the guide draws him: his picture and his name, as his launcher
 * shows them. */
export type GuideBuddy = Readonly<{ picture: string; name: string }>;

/** What the layer's controls do. */
export type GuideActions = Readonly<{
  step(stop: number): void;
  /** "Ukončit", Escape, or the page moving elsewhere. */
  close(): void;
  /** "Rozumím" at the last step. */
  done(): void;
}>;

export type GuideLayer = Readonly<{
  /** Draws a view, or (null) nothing: the layer leaves and the focus goes
   * back to the last view's "?". */
  draw(view: GuideView | null, actions: GuideActions): void;
  /** Says a line to assistive technology only. */
  say(text: string): void;
}>;

/** A `<lazurio-buddy>` element as the engine knows it. */
export type GuideElement = Readonly<{
  /** Its `lang` attribute. */
  getAttribute(name: "lang"): string | null;
}>;

export type GuideEvent = Readonly<{
  type: "started" | "done" | "closed";
  explainer: string;
}>;

export type GuideSeams = Readonly<{
  /** The page's merged shell document, or null. */
  shell: () => Shell | null;
  copy: (locale: KindLocale) => ShellCopy;
  /** Follows changes of the shell's document; returns the unsubscription. */
  follow: (changed: () => void) => () => void;
  /** Listens for the clicks of a "?" (`data-guide-help`) on the page;
   * returns the removal. */
  listenHelp: (
    play: (id: string, invoker: GuideInvoker | null) => boolean,
  ) => () => void;
  /** The layer of an element, made when first asked. */
  layer: (element: GuideElement) => GuideLayer;
  /** Announces `lazurio-guide` on the element. */
  announce: (element: GuideElement, event: GuideEvent) => void;
  /** Buddy where the page shows his bubble (decision F60), null without it:
   * his frame may then ask for the principles though the page hands over
   * nothing, an explanation about Buddy invites nobody to get one, and he
   * presents the guide himself (F56's addendum (7)). */
  buddy?: () => GuideBuddy | null;
}>;

export function createGuide(seams: GuideSeams) {
  // The page's explanations; null while the page takes no part.
  let hosted: readonly GuideExplanation[] | null = null;
  // The `<lazurio-buddy>` elements on the page; the last connected draws.
  const elements: GuideElement[] = [];
  let playing: {
    id: string;
    stop: number;
    invoker: GuideInvoker | null;
    element: GuideElement;
  } | null = null;
  let tourWants = false;
  const attentionListeners = new Set<() => void>();
  const askedListeners = new Set<() => void>();
  // What the engine holds of the page while it takes part.
  let unlistenHelp: (() => void) | null = null;
  let unfollow: (() => void) | null = null;

  const drawer = (): GuideElement | null => elements.at(-1) ?? null;
  const buddy = (): GuideBuddy | null => seams.buddy?.() ?? null;
  const withBuddy = () => buddy() !== null;
  const active = () => (hosted !== null || withBuddy()) && drawer() !== null;

  function locale(element: GuideElement): KindLocale {
    const lang = element.getAttribute("lang");
    if (lang === "cs" || lang === "en") return lang;
    return seams.shell()?.locale ?? "en";
  }
  const kind = () => {
    const shell = seams.shell();
    return shell === null ? null : (currentEnvironment(shell)?.kind ?? null);
  };

  /** The ids a "?" or Buddy's frame may play here. */
  const known = (): readonly string[] =>
    hosted === null && !withBuddy()
      ? []
      : [...principleIds, ...(hosted ?? []).map((guide) => guide.id)];

  function explanation(
    id: string,
    element: GuideElement,
  ): GuideExplanation | null {
    const language = locale(element);
    const principle = principleIn(id, language, kind());
    if (principle !== null) return principle;
    const page = hosted?.find((guide) => guide.id === id);
    return page === undefined ? null : pageGuideIn(page, kind());
  }

  const actions: GuideActions = Object.freeze({
    step(stop: number) {
      if (playing === null) return;
      const found = explanation(playing.id, playing.element);
      if (found === null) {
        end("closed");
        return;
      }
      playing.stop = Math.max(0, Math.min(stop, found.steps.length - 1));
      draw();
    },
    close() {
      if (playing !== null) end("closed");
    },
    done() {
      if (playing !== null) end("done");
    },
  });

  function draw(): void {
    if (playing === null) return;
    const found = explanation(playing.id, playing.element);
    if (found === null) {
      end("closed");
      return;
    }
    const last = playing.stop === found.steps.length - 1;
    const language = locale(playing.element);
    const here = buddy();
    seams.layer(playing.element).draw(
      {
        explanation: found,
        stop: playing.stop,
        // A person without Buddy's bubble on this page is asked to get a
        // Buddy at the end of an explanation about him, where the account
        // lives; a person whose Buddy is here is not.
        invite:
          found.aboutBuddy && last && here === null
            ? (seams.shell()?.dashboard ?? null)
            : null,
        words: seams.copy(language),
        invoker: playing.invoker,
        scene: guideScene(found.id, playing.stop, language, kind()),
        buddy: here,
      },
      actions,
    );
  }

  function end(type: "done" | "closed"): void {
    const was = playing;
    if (was === null) return;
    playing = null;
    seams.layer(was.element).draw(null, actions);
    seams.announce(was.element, { type, explainer: was.id });
    for (const listener of attentionListeners) listener();
  }

  /** Plays `id` from a "?" (`invoker`); true when the click is the guide's:
   * it played, or Začínáme came first. */
  function play(id: string, invoker: GuideInvoker | null): boolean {
    const element = drawer();
    if (!active() || element === null || !known().includes(id)) return false;
    if (playing !== null) return true;
    if (tourWants) {
      seams.layer(element).say(seams.copy(locale(element)).guideBusy);
      for (const listener of askedListeners) listener();
      return true;
    }
    playing = { id, stop: 0, invoker, element };
    draw();
    seams.announce(element, { type: "started", explainer: id });
    for (const listener of attentionListeners) listener();
    return true;
  }

  /** Takes part, or stops, as the page now asks: the "?" is listened to only
   * while the page hands over its explanations and a `<lazurio-buddy>` is on
   * it, and the document followed while it takes part or shows Buddy's
   * bubble. */
  function settle(): void {
    if (hosted !== null && drawer() !== null)
      unlistenHelp ??= seams.listenHelp(play);
    else {
      unlistenHelp?.();
      unlistenHelp = null;
    }
    if (active()) {
      unfollow ??= seams.follow(() => draw());
      return;
    }
    if (playing !== null) end("closed");
    unfollow?.();
    unfollow = null;
  }

  return Object.freeze({
    /** `provideGuides`: the explanations of the page shown now, replacing
     * those before; null (or anything but a list) withdraws. An explanation
     * of the page that plays and is no longer handed over ends: the page
     * moved on. */
    provide(value: unknown): void {
      hosted = parseGuides(value);
      if (
        playing !== null &&
        !principleIds.includes(playing.id) &&
        !known().includes(playing.id)
      )
        end("closed");
      settle();
      draw();
    },
    /** A `<lazurio-buddy>` connected. */
    attach(element: GuideElement): void {
      if (!elements.includes(element)) elements.push(element);
      settle();
    },
    /** A `<lazurio-buddy>` disconnected. An explanation it draws ends as
     * any other does (`end`): its layer is told to draw nothing, so the
     * layer's listeners and timer stop and a reattached element starts a
     * guide afresh. */
    detach(element: GuideElement): void {
      const at = elements.indexOf(element);
      if (at >= 0) elements.splice(at, 1);
      if (playing?.element === element) end("closed");
      settle();
    },
    /** An element's `lang` changed, or whether the page shows Buddy's
     * bubble. */
    changed(): void {
      settle();
      draw();
    },
    play,
    known,
    /** Whether the page takes part: it handed over its explanations and has
     * a `<lazurio-buddy>`. */
    active,
    /** The arbiter of the person's attention with the page's onboarding
     * tour (not part of interface v1: only the Launchpad has one). */
    attention: Object.freeze({
      /** Whether the onboarding tour wants attention now. */
      tour(wants: boolean): void {
        tourWants = wants;
      },
      /** Whether it wants it, as the tour last said (Buddy's frame hears
       * `busy` meanwhile). */
      tourWants: (): boolean => tourWants,
      /** The explanation out now, or null. */
      playing: (): string | null => playing?.id ?? null,
      /** Called as an explanation starts and ends. */
      listen(listener: () => void): () => void {
        attentionListeners.add(listener);
        return () => {
          attentionListeners.delete(listener);
        };
      },
      /** Called when a "?" asked while the tour wants attention: the tour
       * points to its own bubble. */
      asked(listener: () => void): () => void {
        askedListeners.add(listener);
        return () => {
          askedListeners.delete(listener);
        };
      },
    }),
  });
}
