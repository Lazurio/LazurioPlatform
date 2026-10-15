import type { ContentClient, ContentJob, ContentList } from "./content-client";
import {
  type ContentFact,
  type ContentRow,
  contentFact,
  contentView,
  type Resolve,
  type StepView,
} from "./content-view";
import type { GithubFact } from "./first-run";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// "Obsah Environmentu" in Settings → Tento Environment (root decision 0188;
// the wireframe's Prepare.tsx, prototypes-lazurio 45c92830), drawn also as
// the third step of Začínáme (root decision 0201): what lives in this
// Environment, its Organization or the person's Personalspace, and its
// preparation by the same Lazurio CLI as `lazurio organization install` and
// `lazurio personalspace install`, through the content routes. While it
// runs the steps say in plain words what happens; when one stops, one plain
// sentence, the technical detail under "Podrobnosti" and where it leads:
// "Vyřešit v Chatu" when an agent can work, "Připojit AI" while no AI is
// connected, and for an Organization not prepared for this version, to
// someone who cannot write its root, only that its Admin prepares it.
// The content core decides availability, including the persona's own GitHub
// account on an Automated Environment. A Team's brokered content stays with
// its hosting. Every value from the server is drawn with textContent.

export function createContentPanel(
  options: Readonly<{
    client: ContentClient;
    copy: () => Copy;
    /** GitHub's sign-in here, as Settings → Nástroje reads it. */
    github: () => GithubFact;
    /** An Organization's module count once it is here, by its login. */
    modules: (login: string) => number | null;
    /** "5 modulů": the count in the page's language. */
    pluralModules: (count: number) => string;
    /** The content or its preparation changed: the line, the tour and the
     * catalog follow. */
    changed: () => void;
    /** Where a stop leads (first-run.ts `resolveOf`). */
    resolveKind: () => Resolve;
    /** "Vyřešit v Chatu". */
    resolve: () => void;
    /** "Připojit AI": the AI step of Začínáme. */
    connectAi: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing content UI");
    return element;
  };
  const group = find<HTMLElement>("#content-group");
  // Where it is drawn: Tento Environment's group, and Začínáme's third step
  // (`bare`: a single item's name is the step's title already).
  const places = [
    { box: find<HTMLDivElement>("#content-list"), bare: false },
    { box: find<HTMLDivElement>("#start-content"), bare: true },
  ];
  let list: ContentList | null | "loading" = "loading";
  let job: ContentJob | null = null;
  let following: string | null = null;
  let starting = false;
  // A sentence about the last action (refused, could not start, lost).
  let message: string | null = null;
  let focusAction = false;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svg = (name: string) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", "icon");
    node.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    node.append(use);
    return node;
  };
  const details = (summary: string, text: string) => {
    const fold = element("details", "technical");
    fold.append(element("summary", "", summary), element("pre", "", text));
    return fold;
  };

  function steps(views: readonly StepView[], copy: Copy): HTMLElement {
    const marks = {
      done: "toolsStepDone",
      running: "toolsStepCurrent",
      failed: "toolsStepFailed",
      next: "toolsStepTodo",
    } as const;
    const list = element("ol", "content-steps");
    for (const step of views) {
      const item = element("li", "content-step");
      item.dataset.mark = step.mark;
      const mark = element("span", "content-mark");
      mark.setAttribute("aria-hidden", "true");
      if (step.mark === "done") mark.append(svg("check"));
      else if (step.mark === "failed") mark.append(svg("x"));
      else if (step.mark === "running") mark.append(element("span", "spinner"));
      const label = element("span", "", step.label);
      const name = element(
        "span",
        "sr-only",
        copy[marks[step.mark]].replace("{step}", step.label),
      );
      label.setAttribute("aria-hidden", "true");
      item.append(mark, label, name);
      if (step.mark === "running") item.setAttribute("aria-current", "step");
      list.append(item);
    }
    return list;
  }

  function row(
    view: ContentRow,
    copy: Copy,
    action: HTMLElement | null,
    note: string | null,
    named: boolean,
  ): HTMLElement {
    const node = element("div", "content-row");
    const head = element("div", "content-head");
    const text = element("div", "content-text");
    const status = element("div", "content-status", view.status);
    status.dataset.state = view.item.state;
    if (named) text.append(element("div", "content-name", view.name));
    text.append(status);
    head.append(text);
    if (action !== null) head.append(action);
    node.append(head);
    if (note !== null) node.append(element("p", "content-note", note));
    if (view.steps !== null) node.append(steps(view.steps, copy));
    if (view.failure !== null) {
      const failure = element("div", "content-failure");
      // The tour rings the stop on Začínáme (0201).
      failure.dataset.tour = "prepare";
      const actions = element("p", "tool-actions");
      const lead = view.failure.resolve;
      if (lead !== "admin") {
        const resolve = element(
          "button",
          "primary",
          lead === "chat" ? copy.setupResolve : copy.setupAiAction,
        );
        resolve.type = "button";
        resolve.dataset.contentResolve = lead;
        resolve.addEventListener("click", () =>
          lead === "chat" ? options.resolve() : options.connectAi(),
        );
        actions.append(resolve);
      }
      failure.append(
        element("p", "", view.failure.sentence),
        details(copy.contentDetails, view.failure.details),
        ...(actions.childElementCount > 0 ? [actions] : []),
      );
      node.append(failure);
    }
    if (view.reason !== null)
      node.append(details(copy.contentDetails, view.reason));
    return node;
  }

  function render() {
    const copy = options.copy();
    const read = list;
    const empty =
      read === "loading" ||
      read === null ||
      !read.allowed ||
      read.items.length === 0;
    group.hidden = empty;
    if (empty) {
      for (const place of places) place.box.replaceChildren();
      return;
    }
    const view = contentView(read, job, copy, {
      github: options.github(),
      modules: options.modules,
      pluralModules: options.pluralModules,
      resolve: options.resolveKind(),
    });
    for (const place of places) {
      let button: HTMLButtonElement | null = null;
      if (view.action !== null) {
        button = element("button", "primary", view.action.label);
        button.type = "button";
        button.dataset.tour = "prepare";
        button.dataset.contentAction = "";
        button.disabled = view.action.disabled || starting;
        button.addEventListener("click", () => void start());
      }
      const named = !(place.bare && view.rows.length === 1);
      const nodes = view.rows.map((entry, index) =>
        row(
          entry,
          copy,
          index === 0 ? button : null,
          index === 0 ? view.note : null,
          named,
        ),
      );
      const said = element("p", "content-note", message ?? "");
      said.setAttribute("role", "status");
      said.setAttribute("aria-live", "polite");
      said.hidden = message === null;
      place.box.replaceChildren(...nodes, said);
      // The focus goes back to the action of the place that is shown.
      if (
        focusAction &&
        button !== null &&
        !button.disabled &&
        place.box.closest("[hidden]") === null
      ) {
        button.focus();
        focusAction = false;
      }
    }
    focusAction = false;
  }

  // Reads a job until it ends; the list is read again once it has.
  async function follow(id: string) {
    if (following === id) return;
    following = id;
    const last = await options.client.follow(
      id,
      (seen) => {
        if (following !== id) return;
        job = seen;
        render();
        options.changed();
      },
      { stopped: () => following !== id },
    );
    if (following !== id) return;
    following = null;
    if (last === null) message = options.copy().contentLost;
    await refresh({ restore: false });
  }

  /** Starts the installation of everything missing, or follows the one
   * already running. */
  async function start() {
    if (starting || following !== null) return;
    const copy = options.copy();
    starting = true;
    message = null;
    render();
    const answer = await options.client.install();
    starting = false;
    if (answer.kind === "started" || answer.kind === "running") {
      job = null;
      render();
      options.changed();
      void follow(answer.job);
      return;
    }
    message =
      answer.kind === "refused" ? copy.contentRefused : copy.contentStartFailed;
    focusAction = true;
    render();
    options.changed();
  }

  /** Reads what lives here again; on the first read also the newest
   * installation of this Launchpad, whichever browser or tab started it, so
   * a reload, another tab or another device shows the same run or stop. */
  async function refresh(
    request: Readonly<{ restore?: boolean }> = {},
  ): Promise<void> {
    const read = await options.client.list();
    list = read;
    if (request.restore !== false && following === null) {
      const last = await options.client.latest();
      if (last !== null) {
        job = last;
        if (last.state === "running") void follow(last.id);
      }
    }
    render();
    options.changed();
  }

  return {
    refresh,
    start,
    render,
    /** Whether an installation runs now (started here or elsewhere). */
    running: (): boolean => starting || following !== null,
    /** Where the content stands, for the line and the tour. */
    fact(): ContentFact {
      return contentFact(list, job);
    },
    list: (): ContentList | null => (list === "loading" ? null : list),
    job: (): ContentJob | null => job,
  };
}
