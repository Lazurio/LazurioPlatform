import {
  finishedTourProgress,
  firstProgress,
  freshTourProgress,
  parseTourProgress,
  type TourFacts,
  type TourProgress,
  type TourTarget,
  tourAdvance,
  tourStep,
  tourStop,
  tourStorageKey,
} from "./first-run";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";
import { tourPlacement, tourWidth } from "./tour-placement";

type Copy = Readonly<Record<MessageKey, string>>;

// The first-run tour over the real interface (root decisions 0188 and 0201;
// the wireframe's Tour.tsx, prototypes-lazurio 1eefc3d): a ring around a real
// element and a bubble beside it. The layer lets every click through, so the
// person does each step on the page and learns where it lives; the bubble
// explains in a few words and, where a step needs no click, moves on. While
// a basic is missing it points at the next one on Začínáme; then the
// introduction runs. It steps aside while a dialog (a sign-in) is open.
// "Dokončím později" puts it away for this view only: until the basics
// exist it is back on the next page load, and Začínáme starts the
// introduction again. This browser keeps only where the introduction
// points, per Environment (first-run.ts). The rules are pure in
// first-run.ts, where the bubble stands in tour-placement.ts
// (Lazurio/LazurioPlatform#461); this module only draws them.

export function createTour(
  options: Readonly<{
    copy: () => Copy;
    /** What the rules read, or null while the profile is not loaded. */
    facts: () => TourFacts | null;
    /** The Environment's id, the key of its progress; null until known. */
    environment: () => string | null;
    route: () => PageRoute;
    /** Whether Chat and Automate run on this Environment. */
    apps: () => Readonly<{ chat: boolean; automate: boolean }>;
    /** The shell's column head, whose gear and tabs the tour rings. */
    columnHead: () => HTMLElement | null;
    /** Recovery mode: no tour. */
    off: () => boolean;
  }>,
) {
  const layer = document.createElement("div");
  layer.className = "tour";
  layer.hidden = true;
  const ring = document.createElement("div");
  ring.className = "tour-ring";
  const bubble = document.createElement("div");
  bubble.className = "tour-bubble";
  bubble.setAttribute("role", "dialog");
  bubble.setAttribute("aria-live", "polite");
  const title = document.createElement("h2");
  title.className = "tour-title";
  const text = document.createElement("p");
  text.className = "tour-text";
  const actions = document.createElement("div");
  actions.className = "tour-actions";
  bubble.append(title, text, actions);
  layer.append(ring, bubble);
  document.body.append(layer);

  // The progress of the Environment shown, read once per Environment.
  let progress: { environment: string; value: TourProgress | null } | null =
    null;
  // "Dokončím později": put away for this view (this page load) only.
  let later = false;
  let drawnFor: string | null = null;
  let target: TourTarget | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function read(environment: string, facts: TourFacts): TourProgress | null {
    if (progress?.environment === environment && progress.value !== null)
      return progress.value;
    let stored: TourProgress | null = null;
    try {
      stored = parseTourProgress(
        localStorage.getItem(tourStorageKey(environment)),
      );
    } catch {}
    const value = stored ?? firstProgress(facts);
    if (stored === null && value !== null) write(environment, value);
    progress = { environment, value };
    return value;
  }
  function write(environment: string, value: TourProgress) {
    progress = { environment, value };
    try {
      localStorage.setItem(
        tourStorageKey(environment),
        JSON.stringify({ intro: value.intro }),
      );
    } catch {}
  }

  const settingsOf = (route: PageRoute) =>
    route.view === "settings" ? route.section : null;

  function element(name: TourTarget): Element | null {
    const head = options.columnHead()?.shadowRoot ?? null;
    const query = (selector: string, root: ParentNode | null = document) =>
      root?.querySelector(selector) ?? null;
    switch (name) {
      case "gear":
      case "tab-apps":
      case "tab-chat":
      case "tab-automate":
        return query(`[data-tour="${name}"]`, head);
      case "settings-start":
        return query('#settings-nav a[data-section="start"]');
      case "start-ai":
      case "start-github":
      case "prepare":
        return query(`#section-start [data-tour="${name}"]`);
    }
  }

  // The window's visible area: without a scrollbar, which a classic one
  // (Windows, a Mac with a mouse) takes from the page and would cover the
  // bubble at the window's edge.
  const visible = () => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });

  // Where the ringed element is now, null when it is not on screen.
  function rect(name: TourTarget): DOMRect | null {
    const found = element(name);
    if (found === null) return null;
    const box = found.getBoundingClientRect();
    const area = visible();
    if (
      box.width === 0 ||
      box.height === 0 ||
      box.right <= 0 ||
      box.bottom <= 0 ||
      box.left >= area.width ||
      box.top >= area.height
    )
      return null;
    return box;
  }

  // One rule for every stop (tour-placement.ts): beside the element when
  // there is room, else under, above or left of it, always whole in the
  // window, its arrow at the element; without it, at the bottom right.
  function place() {
    if (target === null) return;
    const box = rect(target);
    const area = visible();
    // The width first: the height the rule needs is the bubble's at it.
    bubble.style.width = `${tourWidth(area.width)}px`;
    const at = tourPlacement({
      anchor: box,
      height: bubble.offsetHeight,
      viewport: area,
    });
    ring.hidden = box === null;
    if (box !== null)
      Object.assign(ring.style, {
        left: `${box.left - 5}px`,
        top: `${box.top - 5}px`,
        width: `${box.width + 10}px`,
        height: `${box.height + 10}px`,
      });
    if (at.side === null) delete bubble.dataset.side;
    else bubble.dataset.side = at.side;
    if (at.arrow === null) bubble.style.removeProperty("--tour-arrow");
    else bubble.style.setProperty("--tour-arrow", `${at.arrow}px`);
    Object.assign(bubble.style, { left: `${at.left}px`, top: `${at.top}px` });
  }

  function hide() {
    layer.hidden = true;
    drawnFor = null;
    target = null;
    clearInterval(timer);
    timer = undefined;
  }

  function button(label: string, className: string, act: () => void) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", act);
    return node;
  }

  /** Draws the stop for what the page shows now, or nothing. */
  function update() {
    const facts = options.facts();
    const environment = options.environment();
    if (
      later ||
      options.off() ||
      facts === null ||
      environment === null ||
      // A sign-in, a prompt: the tour steps aside while a dialog is open.
      document.querySelector("dialog[open]") !== null
    )
      return hide();
    const value = read(environment, facts);
    const next = tourStep(facts, value, settingsOf(options.route()));
    if (next === null) return hide();
    const copy = options.copy();
    const stop = tourStop(next, facts, options.apps(), copy);
    // The buttons are drawn again only for another stop or language, so the
    // focus stays on them.
    const drawn = `${next}\n${copy.tourLater}`;
    const moved = drawn !== drawnFor;
    drawnFor = drawn;
    target = stop.target;
    if (title.textContent !== stop.title) title.textContent = stop.title;
    if (text.textContent !== (stop.text ?? ""))
      text.textContent = stop.text ?? "";
    text.hidden = stop.text === null;
    bubble.setAttribute("aria-label", `${copy.tourLabel}: ${stop.title}`);
    if (moved) {
      const advance = () => {
        write(
          environment,
          tourAdvance(progress?.value ?? freshTourProgress, next),
        );
        update();
      };
      // Nothing is lost (0201 point 2): Začínáme stays in Settings, and
      // the next page load shows the tour again until the basics exist.
      const putAway = () => {
        later = true;
        update();
      };
      actions.replaceChildren(
        ...(stop.next === null
          ? []
          : [
              button(
                stop.next === "done" ? copy.tourDone : copy.tourNext,
                "primary",
                advance,
              ),
            ]),
        ...(stop.later ? [button(copy.tourLater, "tour-later", putAway)] : []),
      );
    }
    // An element that is not on the page now (the action of a preparation
    // that runs, a row not drawn yet): the tour waits for it. One that is
    // there but off screen (the column of a narrow window) keeps the bubble
    // in the corner.
    layer.hidden = element(stop.target) === null;
    if (!layer.hidden) place();
    // The page and its layout change under the tour: keep the ring on it.
    if (timer === undefined) timer = setInterval(update, 250);
  }

  /** Začínáme's "Spustit prohlídku": the introduction from its start, back
   * in this view even after "Dokončím později". */
  function restart() {
    const environment = options.environment();
    if (environment === null) return;
    later = false;
    write(environment, freshTourProgress);
    update();
  }

  /** Whether the introduction was seen to its end here (Začínáme's
   * "Prohlédnuto"); null while the Environment is not known. */
  function toured(): boolean | null {
    const environment = options.environment();
    const facts = options.facts();
    if (environment === null || facts === null) return null;
    const value = read(environment, facts);
    return value === null ? null : value.intro >= finishedTourProgress.intro;
  }

  window.addEventListener("resize", () => place());
  // A dialog opening or closing (a sign-in) moves the tour aside or back at
  // once.
  new MutationObserver(() => update()).observe(document.body, {
    attributes: true,
    attributeFilter: ["open"],
    subtree: true,
  });
  return { update, restart, toured };
}
