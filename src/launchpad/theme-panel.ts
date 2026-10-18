import type { ShellTheme } from "../shell/contract";
import type { MessageKey } from "./messages";
import {
  parseThemeAnswer,
  previewColours,
  type ThemeChoiceView,
  type ThemeView,
  themeOfChoice,
} from "./theme-view";

// Settings → Obecné → Téma Prostředí (root decision 0208 points 1, 2 and 6):
// a card per theme the Environment may take, read from `GET /api/theme`, and
// a choice that applies at once: `POST /api/theme/set` at the revision shown,
// then the page declares the theme as Apps shows it, before anything else is
// read, and the shell remembers it for the page's other tabs. Chat and
// Automate follow when they are shown again. Whoever can open Settings may
// change it, on a Team Environment every member; a public Environment shows
// no group, its theme is fixed (the server refuses the change there too).

export function createThemePanel(
  options: Readonly<{
    get: (path: string) => Promise<{ ok: boolean; value: unknown }>;
    post: (
      path: string,
      body: unknown,
    ) => Promise<{ ok: boolean; value: unknown }>;
    copy: () => Readonly<Record<MessageKey, string>>;
    /** Declares `theme` in the page at once, as the shell document will name
     * it. */
    apply: (theme: ShellTheme) => void;
    /** Whether the theme is fixed here: a public Environment's. */
    fixed: () => boolean;
    /** Whether the Environment is a Team's, whose members share it. */
    shared: () => boolean;
  }>,
) {
  function element<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing theme control: ${id}`);
    return node as T;
  }
  const group = element<HTMLElement>("theme-group");
  const list = element<HTMLDivElement>("theme-choices");
  const shared = element<HTMLParagraphElement>("theme-shared");
  const status = element<HTMLParagraphElement>("theme-status");
  let view: ThemeView | null = null;
  // The theme being chosen, while its change is asked: shown chosen, and no
  // other change starts meanwhile.
  let pending: string | null = null;
  let notice: MessageKey | null = null;
  let reading: Promise<void> | null = null;
  // The cards as drawn, by theme id, and what they were drawn from.
  let inputs = new Map<string, HTMLInputElement>();
  let drawnChoices = "";

  const span = (className = "", text?: string) => {
    const node = document.createElement("span");
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function icon(name: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${name}`);
    svg.append(use);
    return svg;
  }

  /** One small window of the app in one appearance's colours. */
  function preview(values: ThemeChoiceView["light"]): HTMLSpanElement {
    const box = span("theme-preview");
    for (const [name, value] of Object.entries(previewColours(values)))
      box.style.setProperty(name, value);
    const side = span("theme-preview-side");
    side.append(span(), span(), span());
    const actions = span("theme-preview-actions");
    actions.append(span("theme-preview-button"), span("theme-preview-accent"));
    const main = span("theme-preview-main");
    main.append(
      span("theme-preview-title"),
      span("theme-preview-text"),
      actions,
    );
    box.append(side, main);
    return box;
  }

  function card(choice: ThemeChoiceView): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = "theme-card";
    label.dataset.theme = choice.id;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "environment-theme";
    input.value = choice.id;
    input.addEventListener("change", () => {
      if (input.checked) void choose(choice.id);
    });
    inputs.set(choice.id, input);
    const previews = span("theme-previews");
    previews.setAttribute("aria-hidden", "true");
    if (choice.dark === undefined) previews.dataset.lightOnly = "";
    previews.append(
      preview(choice.light),
      ...(choice.dark === undefined ? [] : [preview(choice.dark)]),
    );
    const name = span("theme-card-name");
    name.append(span("", choice.label), icon("i-check"));
    label.append(input, previews, name);
    return label;
  }

  function render(): void {
    if (options.fixed() || view === null) {
      group.hidden = true;
      return;
    }
    const current = view;
    // The cards again only when the themes themselves changed, so the focus
    // stays on the one chosen.
    const choices = JSON.stringify(current.choices);
    if (choices !== drawnChoices) {
      drawnChoices = choices;
      inputs = new Map();
      list.replaceChildren(...current.choices.map(card));
    }
    // Never disabled: a radio that loses its focus would lose the keyboard's
    // place in the group.
    for (const [id, input] of inputs)
      input.checked = id === (pending ?? current.theme);
    list.setAttribute("aria-busy", String(pending !== null));
    shared.hidden = !options.shared();
    const text = notice === null ? "" : options.copy()[notice];
    if (status.textContent !== text) status.textContent = text;
    group.hidden = false;
  }

  /** The theme of the record shown, declared in the page. */
  function applyShown(): void {
    const current = view;
    if (current === null) return;
    const choice = current.choices.find((entry) => entry.id === current.theme);
    if (choice !== undefined)
      options.apply(themeOfChoice(choice, current.revision));
  }

  async function choose(id: string): Promise<void> {
    const before = view;
    if (before === null) return;
    // One change at a time: a click meanwhile is undone.
    if (pending !== null) {
      render();
      return;
    }
    if (id === before.theme) return;
    pending = id;
    notice = null;
    render();
    try {
      const { ok, value } = await options.post("/api/theme/set", {
        theme: id,
        revision: before.revision,
      });
      const answer = ok ? parseThemeAnswer(value) : null;
      const stale =
        !ok &&
        typeof value === "object" &&
        value !== null &&
        (value as { reason?: unknown }).reason === "theme-changed"
          ? parseThemeAnswer((value as { current?: unknown }).current)
          : null;
      if (answer !== null) view = answer;
      else if (stale !== null) {
        // Changed elsewhere since it was read: the current one is shown and
        // declared, and nothing of this click is applied.
        view = stale;
        notice = "themeStale";
      } else notice = "themeFailed";
      if (answer !== null || stale !== null) applyShown();
    } catch {
      notice = "themeFailed";
    } finally {
      pending = null;
      render();
    }
  }

  /** Reads the record and the themes; nothing on a public Environment. */
  function read(): Promise<void> {
    if (options.fixed()) {
      render();
      return Promise.resolve();
    }
    reading ??= (async () => {
      try {
        const { ok, value } = await options.get("/api/theme");
        const answer = ok ? parseThemeAnswer(value) : null;
        if (answer !== null) view = answer;
      } catch {
        // The group stays as it was; the theme itself is the shell's.
      } finally {
        reading = null;
        render();
      }
    })();
    return reading;
  }

  return Object.freeze({
    /** The first reading, as the page starts. */
    load: read,
    /** The language or the Environment's kind changed. */
    render,
    /** The theme the page's shell document names now: read again when it
     * is another than the one shown (a change by `lazurio theme` or in
     * another tab). */
    follow(theme: ShellTheme | undefined): void {
      if (view === null || theme === undefined || pending !== null) return;
      if (theme.id === view.theme && theme.revision === view.revision) return;
      notice = null;
      void read();
    },
  });
}
