import {
  firstProgress,
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

type Copy = Readonly<Record<MessageKey, string>>;

// The first-run tour over the real interface (root decision 0188; the
// wireframe's Tour.tsx, prototypes-lazurio 45c92830): a ring around a real
// element and a bubble beside it. The layer lets every click through, so the
// person does each step on the page and learns where it lives; the bubble
// explains in a few words and, where a step needs no click, moves on. It
// steps aside while a dialog (a sign-in) is open, and "Ukončit" puts it
// away. Its progress lives in this browser per Environment (first-run.ts):
// GitHub and the content are read live every time. The rules are pure in
// first-run.ts; this module only draws them.

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
      localStorage.setItem(tourStorageKey(environment), JSON.stringify(value));
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
      case "settings-tools":
        return query('#settings-nav a[data-section="tools"]');
      case "settings-machine":
        return query('#settings-nav a[data-section="machine"]');
      case "tool-gh":
      case "tool-composio": {
        const tool = name.slice("tool-".length);
        return (
          query(`[data-tool="${tool}"][data-control="curated"]`) ??
          query(`[data-tool="${tool}"][data-control="link-ssh"]`) ??
          query(`li[data-tool="${tool}"]`)
        );
      }
      case "prepare":
        return query('[data-tour="prepare"]');
    }
  }

  // Where the ringed element is now, null when it is not on screen.
  function rect(name: TourTarget): DOMRect | null {
    const found = element(name);
    if (found === null) return null;
    const box = found.getBoundingClientRect();
    if (
      box.width === 0 ||
      box.height === 0 ||
      box.right <= 0 ||
      box.bottom <= 0 ||
      box.left >= window.innerWidth ||
      box.top >= window.innerHeight
    )
      return null;
    return box;
  }

  // Beside the element when there is room, else under it; without it, at
  // the bottom right.
  function place() {
    if (target === null) return;
    const box = rect(target);
    const width = Math.min(300, window.innerWidth - 24);
    if (box === null) {
      ring.hidden = true;
      delete bubble.dataset.side;
      Object.assign(bubble.style, {
        left: "",
        top: "",
        right: "24px",
        bottom: "24px",
      });
      return;
    }
    ring.hidden = false;
    Object.assign(ring.style, {
      left: `${box.left - 5}px`,
      top: `${box.top - 5}px`,
      width: `${box.width + 10}px`,
      height: `${box.height + 10}px`,
    });
    const right = box.right + 16 + width < window.innerWidth;
    const height = bubble.offsetHeight || 140;
    const top = right
      ? Math.max(12, Math.min(box.top - 6, window.innerHeight - height - 12))
      : Math.min(box.bottom + 14, window.innerHeight - height - 12);
    const left = right
      ? box.right + 16
      : Math.max(12, Math.min(box.left, window.innerWidth - width - 12));
    bubble.dataset.side = right ? "right" : "below";
    Object.assign(bubble.style, {
      left: `${left}px`,
      top: `${top}px`,
      right: "",
      bottom: "",
    });
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
      options.off() ||
      facts === null ||
      environment === null ||
      // A sign-in, a prompt: the tour steps aside while a dialog is open.
      document.querySelector("dialog[open]") !== null
    )
      return hide();
    const value = read(environment, facts);
    const next = tourStep(facts, value, settingsOf(options.route()));
    if (next === null || value === null) return hide();
    const copy = options.copy();
    const stop = tourStop(next, facts.content, options.apps(), copy);
    // The buttons are drawn again only for another stop or language, so the
    // focus stays on them.
    const drawn = `${next}\n${copy.tourQuit}`;
    const moved = drawn !== drawnFor;
    drawnFor = drawn;
    target = stop.target;
    if (title.textContent !== stop.title) title.textContent = stop.title;
    if (text.textContent !== (stop.text ?? ""))
      text.textContent = stop.text ?? "";
    text.hidden = stop.text === null;
    bubble.setAttribute("aria-label", `${copy.tourLabel}: ${stop.title}`);
    if (moved) {
      const act = (action: "next" | "not-now" | "quit") => () => {
        const current = progress?.value;
        if (current === null || current === undefined) return;
        write(environment, tourAdvance(current, next, action));
        update();
      };
      actions.replaceChildren(
        ...(stop.next === null
          ? []
          : [
              button(
                stop.next === "done" ? copy.tourDone : copy.tourNext,
                "primary",
                act("next"),
              ),
            ]),
        ...(stop.notNow ? [button(copy.tourNotNow, "", act("not-now"))] : []),
        button(copy.tourQuit, "tour-quit", act("quit")),
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

  window.addEventListener("resize", () => place());
  // A dialog opening or closing (a sign-in) moves the tour aside or back at
  // once.
  new MutationObserver(() => update()).observe(document.body, {
    attributes: true,
    attributeFilter: ["open"],
    subtree: true,
  });
  return { update };
}
