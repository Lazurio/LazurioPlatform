import type { VoiceLocale } from "../folder/voice";
import type { MessageKey } from "./messages";
import {
  type OwnInstructionsDraft,
  ownInstructionsDirty,
  ownInstructionsForm,
  ownInstructionsOutcome,
  parseOwnInstructionsView,
  reconcileOwnInstructions,
  suggestionLink,
  utf8Bytes,
} from "./own-instructions-view";

// Settings → Komunikace agentů → „Vlastní pokyny pro agenty“ (root decision
// 0233, decision F14's addendum of 2026-11-06): the person's own
// instructions for agents, below the voice and built like its form
// (voice-panel.ts): a text, Save, Cancel and Remove, and a reload after a
// change made elsewhere. A save is `POST /api/own-instructions/update`,
// which changes the text and nothing else.
//
// The saved text can change elsewhere while the person writes: an agent runs
// `lazurio folder instructions add`, another tab saves. A reload then puts
// that text into the form next to the person's own, and nothing can be saved
// before the person chooses which one holds („Použít uložené znění“ or
// „Ponechat můj text“). The form never merges the two and never saves by
// itself.
//
// The form is drawn by this panel and is in the page only where the
// Environment has own instructions: on a Team Environment, an Environment
// with automations and a public one nothing of it is there. On a Work
// Environment it says whose the instructions are from its first drawing,
// before anything is saved.

/** The page's place for the form and its words. */
const ids = {
  form: "own-form",
  text: "own-text",
  hint: "own-hint",
  count: "own-count",
  error: "own-error",
  notice: "own-notice",
  conflict: "own-conflict",
  conflictWords: "own-conflict-words",
} as const;

type ProfileView = Readonly<{
  revision: number;
  profile: Readonly<Record<string, string>>;
  ownInstructions?: unknown;
}>;

export function ownInstructionsPanel(options: {
  /** The section the form stands in, after what is already there. */
  host: () => HTMLElement;
  post: (
    path: string,
    body: unknown,
  ) => Promise<{ ok: boolean; value: unknown }>;
  copy: () => Readonly<Record<MessageKey, string>>;
  changed: () => Promise<void>;
}) {
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };
  const button = (type: "submit" | "button", className = "") => {
    const node = make("button", className);
    node.type = type;
    return node;
  };

  const form = make("form", "group");
  form.id = ids.form;
  form.noValidate = true;
  const fields = make("fieldset", "group");
  const legend = make("legend");
  const title = make("h2");
  legend.append(title);
  const card = make("div", "card voice-card");
  const hint = make("p", "row-desc");
  hint.id = ids.hint;
  const label = make("label", "sr-only");
  label.htmlFor = ids.text;
  const text = make("textarea");
  text.id = ids.text;
  text.rows = 8;
  text.spellcheck = true;
  text.setAttribute("autocapitalize", "sentences");
  const count = make("p", "row-status own-count");
  count.id = ids.count;
  // In the page before its text, so a screen reader hears the text arrive.
  const error = make("p", "own-error");
  error.id = ids.error;
  error.setAttribute("role", "status");
  error.setAttribute("aria-live", "polite");
  card.append(hint, label, text, count, error);
  const whose = make("p", "callout");
  whose.id = ids.notice;
  whose.setAttribute("role", "note");
  // The text saved elsewhere and the choice, above the buttons. The block
  // is in the page from the start and empty, so a screen reader hears its
  // words arrive; they are put in once for one conflict, not at each key.
  const conflict = make("div", "callout own-conflict");
  conflict.id = ids.conflict;
  conflict.dataset.kind = "warning";
  conflict.setAttribute("role", "status");
  conflict.setAttribute("aria-live", "polite");
  const conflictWords = make("p");
  conflictWords.id = ids.conflictWords;
  const conflictLabel = make("p", "row-title");
  // Read-only, with its line ends; a long one scrolls, so it takes focus.
  const conflictSaved = make("pre");
  conflictSaved.tabIndex = 0;
  const conflictRemoved = make("p");
  const conflictActions = make("div", "voice-actions");
  const useSaved = button("button");
  const keepMine = button("button");
  conflictActions.append(useSaved, keepMine);
  const actions = make("div", "voice-actions");
  const save = button("submit", "primary");
  const cancel = button("button");
  const remove = button("button", "ghost");
  actions.append(save, cancel, remove);
  fields.append(legend, card, whose, conflict, actions);
  const status = make("p", "row-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const refresh = button("button");
  const suggest = make("div", "own-suggest");
  const suggestLink = make("a", "button");
  suggestLink.target = "_blank";
  suggestLink.rel = "noopener noreferrer";
  const suggestWords = make("span");
  const external = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  external.setAttribute("class", "icon");
  external.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-external");
  external.append(use);
  suggestLink.append(suggestWords, external);
  const suggestHint = make("p", "row-desc");
  const suggestOrganization = make("p", "row-desc");
  const suggestTruncated = make("p", "row-desc");
  suggest.append(
    suggestLink,
    suggestHint,
    suggestOrganization,
    suggestTruncated,
  );
  form.append(fields, status, refresh, suggest);

  let revision: number | null = null;
  let locale: VoiceLocale = "en";
  let active: OwnInstructionsDraft | null = null;
  let mounted = false;
  let busy = false;
  let needsRefresh = false;
  // What the last save or reload said; the page's language then.
  let notice: string | null = null;
  // The text of this page's last successful save: „Poslat Lazuriu jako
  // podnět“ is offered for it, after each save and never by itself.
  let offered: string | null = null;
  // What the conflict block holds now.
  let conflictDrawn: "none" | "text" | "removed" = "none";

  /** Words written only when they differ: a live region reads what is
   * written into it, also the same words again. */
  const say = (node: HTMLElement, words: string) => {
    if (node.textContent !== words) node.textContent = words;
  };
  function renderConflict(
    saved: string | null,
    copy: Readonly<Record<MessageKey, string>>,
  ) {
    const shape = saved === null ? "none" : saved === "" ? "removed" : "text";
    if (saved !== null) {
      say(conflictWords, copy.ownConflict);
      say(conflictLabel, copy.ownConflictSaved);
      say(conflictSaved, saved);
      say(conflictRemoved, copy.ownConflictRemoved);
      say(useSaved, copy.ownConflictUseSaved);
      say(keepMine, copy.ownConflictKeepMine);
    }
    if (shape === conflictDrawn) return;
    conflictDrawn = shape;
    if (shape === "none") conflict.replaceChildren();
    else if (shape === "removed")
      conflict.replaceChildren(conflictWords, conflictRemoved, conflictActions);
    else
      conflict.replaceChildren(
        conflictWords,
        conflictLabel,
        conflictSaved,
        conflictActions,
      );
  }
  /** The saved text into the form: Cancel, and in a conflict the choice of
   * the saved text. */
  function takeSaved() {
    if (!active) return;
    active.text = active.saved.text;
    active.conflict = null;
    notice = needsRefresh ? notice : null;
    render();
  }

  function unmount() {
    if (mounted) form.remove();
    mounted = false;
  }
  function render() {
    const copy = options.copy();
    const view =
      active === null
        ? null
        : ownInstructionsForm(active, { busy, needsRefresh }, locale, copy);
    if (active === null || view === null) {
      unmount();
      return;
    }
    if (text.value !== active.text) text.value = active.text;
    title.textContent = copy.ownTitle;
    label.textContent = copy.ownTitle;
    hint.textContent = copy.ownHint;
    count.textContent = view.count;
    if (view.over) count.dataset.over = "";
    else delete count.dataset.over;
    error.textContent = view.problem ?? "";
    if (view.problem === null) text.removeAttribute("aria-invalid");
    else text.setAttribute("aria-invalid", "true");
    whose.textContent = view.notice ?? "";
    whose.hidden = view.notice === null;
    renderConflict(view.conflict, copy);
    text.setAttribute(
      "aria-describedby",
      [
        ids.hint,
        ...(view.notice === null ? [] : [ids.notice]),
        ids.count,
        ids.error,
        ...(view.conflict === null ? [] : [ids.conflictWords]),
      ].join(" "),
    );
    save.textContent = copy.voiceSave;
    cancel.textContent = copy.voiceCancel;
    remove.textContent = copy.ownRemove;
    refresh.textContent = copy.voiceRefresh;
    fields.disabled = busy;
    save.disabled = !view.save;
    cancel.disabled = !view.cancel;
    remove.disabled = !view.remove;
    status.textContent =
      notice ?? (ownInstructionsDirty(active) ? copy.voiceDirty : "");
    refresh.hidden = !needsRefresh;
    refresh.disabled = busy;
    // Only for the text this page just saved, as it is saved now.
    const sendable =
      offered !== null &&
      offered !== "" &&
      offered === active.saved.text &&
      !ownInstructionsDirty(active);
    suggest.hidden = !sendable;
    if (sendable && offered !== null) {
      const link = suggestionLink(offered);
      suggestLink.href = link.href;
      suggestWords.textContent = copy.ownSuggest;
      suggestHint.textContent = copy.ownSuggestHint;
      suggestOrganization.textContent = copy.ownSuggestOrganization;
      suggestOrganization.hidden = !active.saved.ofOrganization;
      suggestTruncated.textContent = copy.ownSuggestTruncated;
      suggestTruncated.hidden = !link.truncated;
    } else suggestLink.removeAttribute("href");
    if (!mounted) {
      options.host().append(form);
      mounted = true;
    }
  }

  text.addEventListener("input", () => {
    if (!active) return;
    active.text = text.value;
    // Written into the saved text itself: nothing is left to choose.
    if (!ownInstructionsDirty(active)) active.conflict = null;
    notice = needsRefresh ? notice : null;
    render();
  });
  cancel.addEventListener("click", takeSaved);
  // The choice takes its buttons out of the page; the focus goes where the
  // person goes on, not to the top of the page.
  useSaved.addEventListener("click", () => {
    takeSaved();
    text.focus();
  });
  keepMine.addEventListener("click", () => {
    if (!active) return;
    // The draft stays, now against the saved text the person has seen:
    // Save replaces that text, at the revision it was read with.
    active.conflict = null;
    render();
    if (save.disabled) text.focus();
    else save.focus();
  });
  remove.addEventListener("click", () => {
    if (!active) return;
    active.text = "";
    notice = needsRefresh ? notice : null;
    render();
  });
  refresh.addEventListener("click", async () => {
    busy = true;
    render();
    try {
      await options.changed();
      needsRefresh = false;
      notice = null;
    } catch {
      notice = options.copy().voiceFailed;
    } finally {
      busy = false;
      render();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const copy = options.copy();
    if (active === null || revision === null) return;
    const view = ownInstructionsForm(
      active,
      { busy, needsRefresh },
      locale,
      copy,
    );
    if (view === null || !view.save) return;
    const draft = active;
    const submitted = draft.text;
    busy = true;
    render();
    let saved = false;
    try {
      const { ok, value } = await options.post("/api/own-instructions/update", {
        expectedRevision: revision,
        // One representation of "none".
        text: submitted === "" ? null : submitted,
      });
      const outcome = ownInstructionsOutcome(
        ok,
        value,
        submitted === "",
        draft.saved.maxBytes,
        copy,
      );
      needsRefresh = outcome.needsRefresh;
      notice = outcome.notice;
      if (outcome.saved) {
        // The exact submitted text is now saved. A following read failure
        // leaves it visible and asks for a refresh, without retrying the
        // write and without saying that the save failed.
        saved = true;
        draft.saved = {
          ...draft.saved,
          text: submitted,
          bytes: utf8Bytes(submitted),
        };
        offered = submitted;
        await options.changed();
        notice = outcome.notice;
      }
    } catch {
      needsRefresh = true;
      if (!saved) notice = options.copy().voiceFailed;
    } finally {
      busy = false;
      render();
    }
  });

  return {
    /** The profile as it was just read: its revision and what it says of
     * the own instructions. Without them, or where the Environment has
     * none, the form leaves the page with whatever was being written. A
     * text being written whose saved text changed elsewhere is in conflict
     * from here on (`reconcileOwnInstructions`): the revision is the new
     * one, and nothing is sent at it before the person chooses. */
    load(profile: ProfileView) {
      const saved = parseOwnInstructionsView(profile.ownInstructions);
      revision = profile.revision;
      locale = profile.profile.locale === "cs" ? "cs" : "en";
      active =
        saved === null || !saved.allowed
          ? null
          : reconcileOwnInstructions(saved, active ?? undefined);
      notice = null;
      // The current settings are the ones just read.
      needsRefresh = false;
      if (active === null) offered = null;
      render();
    },
    /** The words again, in the page's language and kind. */
    render,
  };
}
