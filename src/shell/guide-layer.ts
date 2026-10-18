import type { GuideActions, GuideLayer, GuideView } from "./guide";
import type { shellMarks } from "./guide-content";
import { guidePlacement, guideWidth, type TourBox } from "./guide-placement";
import { guideLayerCss } from "./guide-styles";

// How the guide is drawn (decision F56): in the shadow root of
// `<lazurio-buddy>`, made only when the guide first shows, so a page that
// takes no part has an empty element. A ring around the element a step
// names, a card placed by the rule the Launchpad's tour uses
// (guide-placement.ts), and the neutral guide's mark, the Lazurio symbol on
// a white disc, travelling from the bubble's corner at the bottom right to
// the card. A step names a mark: the host page's `data-guide`, else one of
// the shell's own elements (`shellMarks`); every visible element with it is
// ringed together, and without one the card stands in the middle. While it
// shows it follows the page every quarter of a second (the element moves,
// the window changes), closes on Escape and when the page's address
// changes, and on leaving gives the focus back to the "?" it came from.
// With less motion it appears in place and every step is a still frame. A
// line only assistive technology hears (`say`) is the answer while the
// page's onboarding tour comes first.

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
/** The mark's home: where Buddy's bubble stands, the bottom right corner. */
const home = () => {
  const { width, height } = area();
  return { x: width - 24 - markSize, y: height - 24 - markSize };
};
const travelMs = 700;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export function createGuideLayer(host: HTMLElement, logo: string): GuideLayer {
  let parts: ReturnType<typeof build> | null = null;
  let view: GuideView | null = null;
  let actions: GuideActions | null = null;
  // The step whose element was scrolled to, and the explanation and stop
  // drawn, so a redraw of the same keeps the focus and the dots.
  let scrolledFor: string | null = null;
  let drawnKey: string | null = null;
  let since = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let leaving: ReturnType<typeof setTimeout> | undefined;
  let still = false;

  function build() {
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(guideLayerCss);
    root.adoptedStyleSheets = [sheet];
    const layer = make("div", "layer");
    layer.hidden = true;
    const ring = make("div", "ring");
    const mark = make("span", "mark");
    mark.setAttribute("aria-hidden", "true");
    const image = make("img", "");
    image.alt = "";
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(logo)}`;
    mark.append(image);
    const card = make("section", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-live", "polite");
    const title = make("span", "title");
    const line = make("p", "line");
    const foot = make("div", "foot");
    const dots = make("span", "dots");
    const invite = make("a", "invite");
    const quit = make("button", "quit");
    quit.type = "button";
    const primary = make("button", "primary");
    primary.type = "button";
    foot.append(dots, invite, quit, primary);
    card.append(title, line, foot);
    layer.append(ring, card, mark);
    // What only assistive technology hears (`say`).
    const status = make("p", "sr-only");
    status.setAttribute("role", "status");
    root.replaceChildren(layer, status);
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
      card,
      title,
      line,
      dots,
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
    const box = anchor();
    const at = guidePlacement({
      anchor: box,
      height: card.offsetHeight,
      viewport,
    });
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
    const x = Math.max(
      4,
      Math.min(at.left - 18, viewport.width - markSize - 4),
    );
    const y = Math.max(
      4,
      Math.min(at.top - 18, viewport.height - markSize - 4),
    );
    if (!mark.dataset.leaving)
      mark.style.transform = `translate(${x}px, ${y}px)`;
  }

  function fill(): boolean {
    if (parts === null || view === null) return false;
    const { card, title, line, dots, invite, quit, primary } = parts;
    const { explanation, stop, words } = view;
    const key = `${explanation.id}:${stop}:${explanation.steps.length}`;
    const moved = key !== drawnKey;
    drawnKey = key;
    const step = explanation.steps[stop];
    card.setAttribute("aria-label", `${words.guideName}: ${explanation.title}`);
    title.textContent = explanation.title;
    if (moved) {
      // A new line for a new step, so it rises in again.
      const fresh = make("p", "line");
      fresh.append(step?.text ?? "");
      if (step?.sub) {
        const sub = make("span", "sub");
        sub.textContent = step.sub;
        fresh.append(sub);
      }
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
    invite.hidden = view.invite === null;
    if (view.invite !== null) {
      invite.href = view.invite;
      invite.textContent = words.guideInvite;
    }
    quit.textContent = words.guideClose;
    primary.textContent =
      stop >= explanation.steps.length - 1 ? words.guideDone : words.guideNext;
    return moved;
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
    const moved = fill();
    if (first) {
      still =
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
        false;
      if (still) layer.dataset.still = "";
      else delete layer.dataset.still;
      since = location.href;
      scrolledFor = null;
      document.addEventListener("keydown", onKey);
      window.addEventListener("resize", onResize);
      timer = setInterval(tick, 250);
      // From the bubble's corner to the card, unless motion is reduced.
      if (layer.hidden && !still) {
        const start = home();
        mark.style.transition = "none";
        mark.style.transform = `translate(${start.x}px, ${start.y}px)`;
        layer.hidden = false;
        void mark.offsetWidth;
        mark.style.removeProperty("transition");
        mark.dataset.travel = "";
        setTimeout(() => delete mark.dataset.travel, travelMs);
      }
      layer.hidden = false;
    }
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
    const active = document.activeElement;
    const invoker = previous?.invoker ?? null;
    card.hidden = true;
    ring.hidden = true;
    if (
      invoker?.isConnected &&
      (active === null || active === document.body || active === host)
    )
      invoker.focus({ preventScroll: true });
    if (still) {
      layer.hidden = true;
      return;
    }
    // Back to the bubble's corner, then gone.
    const end = home();
    mark.dataset.leaving = "";
    mark.style.transform = `translate(${end.x}px, ${end.y}px)`;
    leaving = setTimeout(() => {
      layer.hidden = true;
      delete mark.dataset.leaving;
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
