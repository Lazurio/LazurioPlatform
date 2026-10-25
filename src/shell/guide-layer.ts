import type { GuideActions, GuideLayer, GuideView } from "./guide";
import type { shellMarks } from "./guide-content";
import {
  guideBuddyPlacement,
  guideBuddySize,
  guidePlacement,
  guideWidth,
  type TourBox,
} from "./guide-placement";
import { drawStage, type Stage, type StageElement } from "./guide-stage";
import { guideLayerCss } from "./guide-styles";
import { icon } from "./icons";

// How the guide is drawn (decision F56): in the shadow root of
// `<lazurio-buddy>`, made only when the guide first shows (or Buddy's bubble
// draws there first, decision F60), so a page that takes no part has an
// empty element. A ring around the element a step names, a card placed by
// the rule the Launchpad's tour uses (guide-placement.ts), and the neutral
// guide's mark, the Lazurio symbol on a white disc, travelling from the
// bubble's corner at the bottom right to the card.
//
// Where the page shows Buddy's bubble, Buddy presents it himself (decision
// F56's addendum (7) of 2026-10-25, as in the prototype): his picture, which
// his origin serves, 48 × 56 without a disc, leaps out of his launcher, which
// waits empty until he is back (`bubble.away`), and hops to every step. He
// stands 30 px beside the element with his hand pointing at it, and the card
// stands beside him as his speech bubble, its tail toward him
// (`guideBuddyPlacement`); on the sheet below 768 px he stands on its top
// edge. Where his picture does not load, the neutral guide's mark stands in
// his place. The words, the steps and the card's size stay the same.
//
// A step names a mark: the host page's `data-guide`, else one of
// the shell's own elements (`shellMarks`); every visible element with it is
// ringed together, and without one the card stands in the middle. While it
// shows it follows the page every quarter of a second (the element moves,
// the window changes), closes on Escape and when the page's address
// changes, and on leaving gives the focus back to the "?" it came from.
// With less motion it appears in place and every step is a still frame. A
// line only assistive technology hears (`say`) is the answer while the
// page's onboarding tour comes first.
//
// A principle's scene (decision F56's addendum (3) of 2026-10-19) stands in
// the card between the step and its buttons: built once per explanation
// (guide-stage.ts), a step sets its beat, and with less motion each beat is
// its still frame. The card keeps one size through an explanation: every
// step's words stand in one place, only the step's own shown, and the stage
// has one size, so nothing in the card moves as the steps go by.

type ShellMark = (typeof shellMarks)[number];

/** Where the shell's own marks are: an element of the shell and a selector
 * in its shadow root. */
const shellMarkOf: Readonly<
  Record<
    ShellMark,
    Readonly<{ host: "lazurio-column-head" | "lazurio-rail"; selector: string }>
  >
> = {
  gear: { host: "lazurio-column-head", selector: '[data-tour="gear"]' },
  picker: { host: "lazurio-column-head", selector: ".pick" },
  switch: { host: "lazurio-column-head", selector: "nav.switch" },
  "tab-apps": {
    host: "lazurio-column-head",
    selector: '[data-tour="tab-apps"]',
  },
  "tab-chat": {
    host: "lazurio-column-head",
    selector: '[data-tour="tab-chat"]',
  },
  "tab-automate": {
    host: "lazurio-column-head",
    selector: '[data-tour="tab-automate"]',
  },
  rail: { host: "lazurio-rail", selector: ".item.space" },
  "rail-personal": {
    host: "lazurio-rail",
    selector: ".item.space:has(.initials)",
  },
  "rail-organizations": {
    host: "lazurio-rail",
    selector: ".item.space:not(:has(.initials))",
  },
};

/** The elements a mark names on the page now. */
function marked(mark: string): Element[] {
  const inPage = [
    ...document.querySelectorAll(`[data-guide="${CSS.escape(mark)}"]`),
  ];
  if (inPage.length > 0) return inPage;
  const own = Object.hasOwn(shellMarkOf, mark)
    ? shellMarkOf[mark as ShellMark]
    : undefined;
  if (own === undefined) return [];
  return [...document.querySelectorAll(own.host)].flatMap((element) => [
    ...(element.shadowRoot?.querySelectorAll(own.selector) ?? []),
  ]);
}

const area = () => ({
  width: document.documentElement.clientWidth,
  height: document.documentElement.clientHeight,
});

/** Whether an element is drawn at all (not hidden, not invisible). */
const drawnAt = (element: Element): boolean =>
  (
    element as Element & {
      checkVisibility?: (options: Record<string, boolean>) => boolean;
    }
  ).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) !==
  false;

/** The box around every element of `elements` that is on screen; null when
 * none is. */
function boxOf(elements: readonly Element[]): TourBox | null {
  const { width, height } = area();
  const boxes = elements
    .filter(drawnAt)
    .map((element) => element.getBoundingClientRect())
    .filter(
      (box) =>
        box.width > 0 &&
        box.height > 0 &&
        box.right > 0 &&
        box.bottom > 0 &&
        box.left < width &&
        box.top < height,
    );
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

const markSize = 40;
const travelMs = 700;
/** The widest the scene's stage is (its height is 9/16 of it): a sheet
 * below 768 px keeps it at this. */
const stageMost = 360;
/** The card's padding and border on both sides. */
const cardInset = 34;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** Buddy's launcher where the page shows his bubble (decision F60), as the
 * guide's figure needs it. */
export type GuideBubble = Readonly<{
  /** The launcher's centre, where the figure leaves from and returns to;
   * null without it. */
  home: () => Readonly<{ x: number; y: number }> | null;
  /** The figure left the launcher (true) or is back in it (false): the
   * launcher waits empty meanwhile. */
  away: (out: boolean) => void;
}>;

const noBubble: GuideBubble = Object.freeze({
  home: () => null,
  away: () => undefined,
});

export function createGuideLayer(
  host: HTMLElement,
  logo: string,
  bubble: GuideBubble = noBubble,
): GuideLayer {
  const logoUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logo)}`;
  let parts: ReturnType<typeof build> | null = null;
  // The picture the figure shows (null: the neutral mark), set again only
  // when it changes, so a picture that did not load is not asked for at
  // every step.
  let pictured: string | null = null;
  /** Whether Buddy presents (`view.buddy`, kept on the layer through its
   * way back). */
  const presenting = () => parts?.layer.dataset.buddy !== undefined;
  /** The figure's home: Buddy's launcher where the page shows it, else the
   * bottom right corner. */
  const home = () => {
    const { width, height } = presenting()
      ? guideBuddySize
      : { width: markSize, height: markSize };
    const at = bubble.home();
    if (at !== null) return { x: at.x - width / 2, y: at.y - height / 2 };
    const space = area();
    return { x: space.width - 24 - width, y: space.height - 24 - height };
  };
  // The scene on the card's stage, and its beat waiting for the card to
  // stand (motion only).
  let staged: Stage | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let view: GuideView | null = null;
  let actions: GuideActions | null = null;
  // The step whose element was scrolled to, and the explanation and stop
  // drawn, so a redraw of the same keeps the focus and the dots.
  let scrolledFor: string | null = null;
  let drawnKey: string | null = null;
  let since = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let leaving: ReturnType<typeof setTimeout> | undefined;
  let hopping: ReturnType<typeof setTimeout> | undefined;
  let still = false;

  function build() {
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(guideLayerCss);
    // Beside Buddy's bubble where the element draws it (decision F60): its
    // own sheet and parts stay, and the layer stands after them, above.
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    const layer = make("div", "layer");
    layer.hidden = true;
    const ring = make("div", "ring");
    // The figure: the neutral guide's mark, or Buddy with his hand
    // (`point`), shown only while he stands beside an element.
    const mark = make("span", "mark");
    mark.setAttribute("aria-hidden", "true");
    const image = make("img", "");
    image.alt = "";
    image.decoding = "async";
    image.draggable = false;
    image.src = logoUrl;
    // Buddy's picture that does not load (no session at his origin in this
    // browser, a network that does not reach it): the neutral mark stands in
    // his place, as on his launcher.
    image.addEventListener("error", () => {
      if (image.src === logoUrl) return;
      mark.dataset.fallback = "";
      image.src = logoUrl;
    });
    const point = make("span", "point");
    point.append(icon("arrow-left", 18));
    mark.append(image, point);
    const card = make("section", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-live", "polite");
    const title = make("span", "title");
    const line = make("div", "lines");
    // The principle's scene (`view.scene`), decorative.
    const stage = make("div", "stage");
    stage.hidden = true;
    const foot = make("div", "foot");
    const dots = make("span", "dots");
    // The documentation behind the explanation (`docs`), at its last step,
    // in a new tab: a quiet link, as the prototype's card has it. With the
    // invitation to get Buddy it has a row of its own under the buttons,
    // kept through the explanation, so its last step does not grow the card.
    const more = make("div", "more");
    const docs = make("a", "docs");
    docs.target = "_blank";
    docs.rel = "noopener noreferrer";
    const invite = make("a", "invite");
    const quit = make("button", "quit");
    quit.type = "button";
    const primary = make("button", "primary");
    primary.type = "button";
    foot.append(dots, quit, primary);
    more.append(docs, invite);
    card.append(title, line, stage, foot, more);
    layer.append(ring, card, mark);
    // What only assistive technology hears (`say`).
    const status = make("p", "sr-only");
    status.setAttribute("role", "status");
    root.append(layer, status);
    quit.addEventListener("click", () => actions?.close());
    primary.addEventListener("click", () => {
      if (view === null || actions === null) return;
      const last = view.stop >= view.explanation.steps.length - 1;
      if (last) actions.done();
      else actions.step(view.stop + 1);
    });
    return {
      layer,
      ring,
      mark,
      image,
      card,
      title,
      line,
      stage,
      dots,
      more,
      docs,
      invite,
      quit,
      primary,
      status,
    };
  }

  /** The box the card stands at: the step's element, or none. */
  function anchor(): TourBox | null {
    if (view === null) return null;
    const at = view.explanation.steps[view.stop]?.at ?? null;
    if (at === null) return null;
    const elements = marked(at);
    const box = boxOf(elements);
    // An element that exists but lies outside the window is brought into it
    // once per step.
    const key = `${view.explanation.id}:${view.stop}`;
    if (box === null && scrolledFor !== key) {
      scrolledFor = key;
      elements.find(drawnAt)?.scrollIntoView({
        block: "center",
        behavior: still ? "auto" : "smooth",
      });
    }
    return box;
  }

  function place(): void {
    if (parts === null || view === null) return;
    const { ring, mark, card } = parts;
    const viewport = area();
    card.style.width = `${guideWidth(viewport.width)}px`;
    if (!parts.stage.hidden) {
      // As wide as the card leaves, at most `stageMost`; 320 × 180 units.
      const width = Math.max(
        0,
        Math.min(guideWidth(viewport.width) - cardInset, stageMost),
      );
      parts.stage.style.width = `${width}px`;
      parts.stage.style.height = `${Math.round((width * 9) / 16)}px`;
      parts.stage.style.setProperty("--k", String(width / 320));
    }
    const box = anchor();
    const input = { anchor: box, height: card.offsetHeight, viewport };
    // Buddy beside the element and his card beside him; the neutral mark at
    // the corner of a card placed as the tour's bubble.
    const buddy = presenting() ? guideBuddyPlacement(input) : null;
    const at = buddy ?? guidePlacement(input);
    ring.hidden = box === null;
    if (box !== null)
      Object.assign(ring.style, {
        left: `${box.left - 5}px`,
        top: `${box.top - 5}px`,
        width: `${box.right - box.left + 10}px`,
        height: `${box.bottom - box.top + 10}px`,
      });
    if (at.side === null) delete card.dataset.side;
    else card.dataset.side = at.side;
    if (at.sheet) card.dataset.sheet = "";
    else delete card.dataset.sheet;
    if (at.arrow === null) card.style.removeProperty("--guide-arrow");
    else card.style.setProperty("--guide-arrow", `${at.arrow}px`);
    Object.assign(card.style, { left: `${at.left}px`, top: `${at.top}px` });
    // His hand points at the element from the side he stands on.
    if (buddy?.points == null) delete mark.dataset.side;
    else mark.dataset.side = buddy.points;
    const x =
      buddy?.buddy.left ??
      Math.max(4, Math.min(at.left - 18, viewport.width - markSize - 4));
    const y =
      buddy?.buddy.top ??
      Math.max(4, Math.min(at.top - 18, viewport.height - markSize - 4));
    if (!mark.dataset.leaving)
      mark.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** Who presents (`view.buddy`): Buddy with his picture, or the neutral
   * guide's mark. */
  function cast(): void {
    if (parts === null || view === null) return;
    const { layer, mark, image } = parts;
    const picture = view.buddy?.picture ?? null;
    if (picture === null) delete layer.dataset.buddy;
    else layer.dataset.buddy = "";
    if (picture === pictured) return;
    pictured = picture;
    delete mark.dataset.fallback;
    image.src = picture ?? logoUrl;
  }

  /** The figure hops as it travels, from the start again. */
  function hop(): void {
    if (parts === null) return;
    const { mark } = parts;
    clearTimeout(hopping);
    delete mark.dataset.travel;
    void mark.offsetWidth;
    mark.dataset.travel = "";
    hopping = setTimeout(() => delete mark.dataset.travel, travelMs);
  }

  function fill(): boolean {
    if (parts === null || view === null) return false;
    const { card, title, line, dots, more, docs, invite, quit, primary } =
      parts;
    const { explanation, stop, words } = view;
    const key = `${explanation.id}:${stop}:${explanation.steps.length}`;
    const moved = key !== drawnKey;
    drawnKey = key;
    // Named after who presents: Buddy, or the neutral guide.
    card.setAttribute(
      "aria-label",
      `${view.buddy?.name ?? words.guideName}: ${explanation.title}`,
    );
    title.textContent = explanation.title;
    if (moved) {
      // Every step's words in one place, so the card keeps its size; only
      // this step's are shown and heard, new so they rise in again.
      const fresh = make("div", "lines");
      explanation.steps.forEach((each, index) => {
        const said = make("p", "line");
        said.append(each.text);
        if (each.sub) {
          const sub = make("span", "sub");
          sub.textContent = each.sub;
          said.append(sub);
        }
        if (index === stop) said.dataset.now = "";
        else said.setAttribute("aria-hidden", "true");
        fresh.append(said);
      });
      line.replaceWith(fresh);
      parts.line = fresh;
      dots.replaceChildren(
        ...explanation.steps.map((each, index) => {
          const dot = make("button", "");
          dot.type = "button";
          dot.setAttribute("aria-label", each.text);
          if (index === stop) dot.setAttribute("aria-current", "step");
          dot.addEventListener("click", () => actions?.step(index));
          return dot;
        }),
      );
    }
    const last = stop >= explanation.steps.length - 1;
    // The last step's links stand in their row from the first step on,
    // unseen and unreachable until then.
    more.hidden = explanation.docs === null && !explanation.aboutBuddy;
    docs.hidden = explanation.docs === null;
    docs.textContent = words.guideDocs;
    docs.style.visibility = last ? "" : "hidden";
    if (last && explanation.docs !== null) docs.href = explanation.docs;
    else docs.removeAttribute("href");
    invite.hidden = !explanation.aboutBuddy;
    invite.textContent = words.guideInvite;
    invite.style.visibility = view.invite === null ? "hidden" : "";
    if (view.invite !== null) invite.href = view.invite;
    else invite.removeAttribute("href");
    quit.textContent = words.guideClose;
    primary.textContent = last ? words.guideDone : words.guideNext;
    stageScene();
    return moved;
  }

  /** The step's scene on the stage: built when the explanation (or its
   * words) changes, its beat set; nothing on a step without one. A new
   * scene's objects rise in once the card stands, where motion is not
   * reduced. */
  function stageScene(): void {
    if (parts === null || view === null) return;
    const { stage } = parts;
    const scene = view.scene;
    clearTimeout(pending);
    if (scene === null) {
      stage.hidden = true;
      stage.replaceChildren();
      staged = null;
      return;
    }
    stage.hidden = false;
    const current = staged;
    if (current !== null && current.key === scene.key) {
      current.beat(scene.beat);
      return;
    }
    const fresh = drawStage(scene, {
      element: () => document.createElement("span") as unknown as StageElement,
      icon: (name) => icon(name, 12),
      logo: () => {
        const image = document.createElement("img");
        image.alt = "";
        image.src = logoUrl;
        return image;
      },
    });
    staged = fresh;
    stage.replaceChildren(fresh.element as unknown as Node);
    if (still) {
      fresh.beat(scene.beat);
      return;
    }
    // Off stage at their places first, then in, after the card's arrival.
    fresh.enter(scene.beat);
    pending = setTimeout(
      () => {
        if (staged === fresh && view?.scene) fresh.beat(view.scene.beat);
      },
      parts.layer.hidden || parts.card.getAnimations().length > 0 ? 380 : 40,
    );
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || view === null)
      return;
    event.preventDefault();
    actions?.close();
  }
  const onResize = () => place();

  function tick(): void {
    // The page moved on (a link, the host's own routing): the explanation
    // is about the page it started on.
    if (location.href !== since) {
      actions?.close();
      return;
    }
    place();
  }

  function show(): void {
    if (parts === null) return;
    const { layer, mark } = parts;
    const first = layer.hidden || mark.dataset.leaving !== undefined;
    clearTimeout(leaving);
    delete mark.dataset.leaving;
    parts.card.hidden = false;
    if (first) {
      still =
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
        false;
      if (still) layer.dataset.still = "";
      else delete layer.dataset.still;
    }
    cast();
    const moved = fill();
    const fresh = layer.hidden;
    if (first) {
      since = location.href;
      scrolledFor = null;
      document.addEventListener("keydown", onKey);
      window.addEventListener("resize", onResize);
      timer = setInterval(tick, 250);
      // Out of the bubble: its launcher waits empty until the figure is back.
      bubble.away(true);
      // From the bubble's corner to the card, unless motion is reduced.
      if (fresh && !still) {
        const start = home();
        mark.style.transition = "none";
        mark.style.transform = `translate(${start.x}px, ${start.y}px)`;
        layer.hidden = false;
        void mark.offsetWidth;
        mark.style.removeProperty("transition");
      }
      layer.hidden = false;
    }
    // The figure hops as it travels: out of the bubble, and Buddy to every
    // step, as in the prototype.
    if (!still && ((first && fresh) || (moved && presenting()))) hop();
    place();
    if (first || moved) parts.primary.focus({ preventScroll: true });
  }

  function leave(previous: GuideView | null): void {
    if (parts === null) return;
    const { layer, mark, card, ring } = parts;
    if (layer.hidden) return;
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    clearInterval(timer);
    timer = undefined;
    drawnKey = null;
    clearTimeout(pending);
    staged = null;
    parts.stage.replaceChildren();
    parts.stage.hidden = true;
    const active = document.activeElement;
    const invoker = previous?.invoker ?? null;
    card.hidden = true;
    ring.hidden = true;
    delete mark.dataset.side;
    if (
      invoker?.isConnected &&
      (active === null || active === document.body || active === host)
    )
      invoker.focus({ preventScroll: true });
    if (still) {
      layer.hidden = true;
      bubble.away(false);
      return;
    }
    // Back to the bubble's corner, then gone; Buddy hops home.
    const end = home();
    mark.dataset.leaving = "";
    mark.style.transform = `translate(${end.x}px, ${end.y}px)`;
    if (presenting()) hop();
    leaving = setTimeout(() => {
      layer.hidden = true;
      delete mark.dataset.leaving;
      bubble.away(false);
    }, travelMs);
  }

  return Object.freeze({
    draw(next: GuideView | null, given: GuideActions): void {
      actions = given;
      const previous = view;
      view = next;
      if (next === null) {
        leave(previous);
        return;
      }
      parts ??= build();
      show();
    },
    say(text: string): void {
      parts ??= build();
      const { status } = parts;
      // Emptied first, so the same line is heard again.
      status.textContent = "";
      setTimeout(() => {
        status.textContent = text;
      }, 50);
    },
  });
}
