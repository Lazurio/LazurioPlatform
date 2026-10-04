import type { ContentClient, ContentJob, ContentList } from "./content-client";
import {
  type ContentFact,
  type ContentRow,
  contentFact,
  contentView,
  type StepView,
} from "./content-view";
import type { GithubFact } from "./first-run";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// "Obsah Environmentu" in Settings → Tento Environment (root decision 0188;
// the wireframe's Prepare.tsx, prototypes-lazurio 45c92830): what lives in
// this Environment, its Organization or the person's Personalspace, and its
// preparation by the same Lazurio CLI as `lazurio organization install` and
// `lazurio personalspace install`, through the content routes. While it
// runs the steps say in plain words what happens; when one stops, one plain
// sentence, the technical detail under "Podrobnosti" and "Vyřešit v Chatu".
// Only where the Environment signs in as its person (a Team or an Automated
// Environment is prepared by its hosting) and only where the content routes
// answer. Every value from the server is drawn with textContent.

/** Where this page keeps the id of the last installation, per Environment,
 * so that a reload during a run or after a stop still shows it. */
export const contentJobKey = (environment: string): string =>
  `lazurio.content-job:${environment}`;

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
    /** The Environment's id, for the stored job; null until known. */
    environment: () => string | null;
    /** The content or its preparation changed: the line, the tour and the
     * catalog follow. */
    changed: () => void;
    /** "Vyřešit v Chatu". */
    resolve: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing content UI");
    return element;
  };
  const group = find<HTMLElement>("#content-group");
  const box = find<HTMLDivElement>("#content-list");
  // Null until the profile says whether the Environment signs in as its
  // person.
  let visible: boolean | null = null;
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

  function storeJob(id: string | null) {
    const environment = options.environment();
    if (environment === null) return;
    try {
      if (id === null) localStorage.removeItem(contentJobKey(environment));
      else localStorage.setItem(contentJobKey(environment), id);
    } catch {}
  }
  function storedJob(): string | null {
    const environment = options.environment();
    if (environment === null) return null;
    try {
      return localStorage.getItem(contentJobKey(environment));
    } catch {
      return null;
    }
  }

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
  ): HTMLElement {
    const node = element("div", "content-row");
    const head = element("div", "content-head");
    const text = element("div", "content-text");
    const status = element("div", "content-status", view.status);
    status.dataset.state = view.item.state;
    text.append(element("div", "content-name", view.name), status);
    head.append(text);
    if (action !== null) head.append(action);
    node.append(head);
    if (note !== null) node.append(element("p", "content-note", note));
    if (view.steps !== null) node.append(steps(view.steps, copy));
    if (view.failure !== null) {
      const failure = element("div", "content-failure");
      const resolve = element("button", "primary", copy.setupResolve);
      resolve.type = "button";
      resolve.dataset.contentResolve = "";
      resolve.addEventListener("click", () => options.resolve());
      const actions = element("p", "tool-actions");
      actions.append(resolve);
      failure.append(
        element("p", "", view.failure.sentence),
        details(copy.contentDetails, view.failure.details),
        actions,
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
    group.hidden = visible !== true || read === "loading" || read === null;
    if (group.hidden || read === "loading" || read === null) {
      box.replaceChildren();
      return;
    }
    const view = contentView(read, job, copy, {
      github: options.github(),
      modules: options.modules,
      pluralModules: options.pluralModules,
    });
    if (read.items.length === 0) {
      group.hidden = true;
      box.replaceChildren();
      return;
    }
    let button: HTMLButtonElement | null = null;
    if (view.action !== null) {
      button = element("button", "primary", view.action.label);
      button.type = "button";
      button.dataset.tour = "prepare";
      button.dataset.contentAction = "";
      button.disabled = view.action.disabled || starting;
      button.addEventListener("click", () => void start());
    }
    const nodes = view.rows.map((entry, index) =>
      row(
        entry,
        copy,
        index === 0 ? button : null,
        index === 0 ? view.note : null,
      ),
    );
    const said = element("p", "content-note", message ?? "");
    said.setAttribute("role", "status");
    said.setAttribute("aria-live", "polite");
    said.hidden = message === null;
    box.replaceChildren(...nodes, said);
    if (focusAction && button !== null && !button.disabled) {
      button.focus();
      focusAction = false;
    }
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
    else if (last.state === "succeeded") storeJob(null);
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
      storeJob(answer.job);
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

  /** Reads what lives here again; on the first read also the last
   * installation this page started, when it is still known. */
  async function refresh(
    request: Readonly<{ restore?: boolean }> = {},
  ): Promise<void> {
    const read = await options.client.list();
    list = read;
    if (request.restore !== false && following === null) {
      const id = storedJob();
      const last = id === null ? null : await options.client.job(id);
      if (id !== null && last === null) storeJob(null);
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
    /** Shown only where the Environment signs in as its person. */
    show(value: boolean) {
      visible = value;
      render();
    },
    /** Where the content stands, for the line and the tour. */
    fact(): ContentFact {
      if (visible === null) return { state: "loading" };
      if (!visible) return { state: "none" };
      return contentFact(list, job);
    },
    list: (): ContentList | null => (list === "loading" ? null : list),
    job: (): ContentJob | null => job,
  };
}
