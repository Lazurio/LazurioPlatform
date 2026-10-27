import type { BuddyPersonaShown } from "../buddy/persona-save";
import { buddyPartNode, drawnKey, faceNode } from "./buddy-dialog";
import {
  type BuddyStepFacts,
  buddyNameOf,
  buddySignInRow,
  buddyStateView,
  draftChanged,
  draftOf,
  draftReady,
  introduceScreen,
  type PersonaDraft,
  type PersonaSaveResult,
  saveLine,
  withForm,
  withYourName,
} from "./buddy-view";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// Nastavení → Buddy (decision F65; the wireframe's BuddySettings.tsx,
// prototypes-lazurio #90), only on an Osobní Prostředí with Buddy: what
// Začínáme's "Seznamte se s Buddym" set, changed here.
//
//   Stav               his name and whether he works, waits for his
//                      sign-in or does not run; Přihlášení k ChatGPT with
//                      ⋯ → Přihlásit znovu and Odhlásit (after a confirm)
//                      once he is signed in, Přihlásit before.
//   Jméno a oslovení   his name, Vyká vám / Tyká vám, the person's name with
//                      how he writes it and Opravit; Uložit saves it, and
//                      while it waits for him to be idle one quiet line
//                      says so.
//
// No model, no reason code. Every value is drawn with textContent; the form
// is built again only for another persona, so a field keeps its caret.

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

const icon = (name: string) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("class", "icon");
  node.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  node.append(use);
  return node;
};

export function createBuddyPanel(
  options: Readonly<{
    copy: () => Copy;
    locale: () => "cs" | "en";
    /** Whether the Environment has Buddy; the section shows nothing else. */
    here: () => boolean;
    facts: () => BuddyStepFacts;
    /** His picture (`<origin>/assets/avatar.webp`); null without it. */
    avatar: () => string | null;
    /** A new code, its dialog open on the first screen alone. */
    signIn: () => void;
    cancel: () => void;
    /** The dialog on the code that is on its way. */
    resume: () => void;
    signOut: () => Promise<boolean>;
    save: (draft: PersonaDraft) => Promise<PersonaSaveResult>;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error("Missing Buddy settings");
    return node;
  };
  const groups = [
    ...document.querySelectorAll<HTMLElement>("#section-buddy [data-buddy]"),
  ];
  const notHere = find<HTMLElement>("#buddy-not-here");
  const stateCard = find<HTMLElement>("#buddy-state");
  const form = find<HTMLFormElement>("#buddy-persona");
  const confirm = find<HTMLDialogElement>("#buddy-confirm");
  const confirmTitle = find<HTMLElement>("#buddy-confirm-title");
  const confirmText = find<HTMLElement>("#buddy-confirm-text");
  const confirmStatus = find<HTMLElement>("#buddy-confirm-status");
  const confirmOk = find<HTMLButtonElement>("#buddy-confirm-ok");
  const confirmCancel = find<HTMLButtonElement>("#buddy-confirm-cancel");

  let stateDrawn: string | null = null;
  // The persona the form was built for (with the page's language), and
  // what the person typed since.
  let formFor: string | null = null;
  let formPersona: BuddyPersonaShown | null = null;
  let draft: PersonaDraft = draftOf(null, "cs");
  let fixing = false;
  let saving = false;
  let lastSave: PersonaSaveResult | null = null;
  let closeMenu: (() => void) | null = null;

  const button = (
    label: string,
    action: () => void,
    className = "",
  ): HTMLButtonElement => {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };

  // ---- Stav ----

  /** ⋯ beside the sign-in: Přihlásit znovu, Odhlásit. */
  function menu(copy: Copy): HTMLElement {
    const box = element("div", "tile-menu buddy-menu");
    const toggle = element("button", "tile-menu-button");
    toggle.type = "button";
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", copy.buddyMenuLabel);
    toggle.append(icon("more"));
    const list = element("div", "tile-menu-list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    const close = () => {
      list.hidden = true;
      box.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      if (closeMenu === close) closeMenu = null;
    };
    const item = (label: string, act: () => void, danger = false) => {
      const node = element(
        "button",
        danger ? "tile-menu-item danger" : "tile-menu-item",
        label,
      );
      node.type = "button";
      node.setAttribute("role", "menuitem");
      node.addEventListener("click", () => {
        close();
        toggle.focus();
        act();
      });
      return node;
    };
    list.append(
      item(copy.buddySignInAgain, options.signIn),
      item(copy.buddySignOut, () => askSignOut(), true),
    );
    toggle.addEventListener("click", () => {
      if (!list.hidden) return close();
      closeMenu?.();
      list.hidden = false;
      box.classList.add("is-open");
      toggle.setAttribute("aria-expanded", "true");
      closeMenu = close;
      list.querySelector<HTMLElement>("button")?.focus();
    });
    box.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || list.hidden) return;
      event.preventDefault();
      close();
      toggle.focus();
    });
    box.append(toggle, list);
    return box;
  }

  function drawState(copy: Copy) {
    const facts = options.facts();
    const state = buddyStateView(facts.reading, copy);
    const row = buddySignInRow(facts, copy);
    const name = buddyNameOf(facts.reading);
    const key = drawnKey([state, row, name, options.avatar()]);
    if (key === stateDrawn) return;
    stateDrawn = key;
    closeMenu?.();

    const who = element("div", "row buddy-who");
    const main = element("div", "row-main buddy-who-main");
    const face = faceNode(options.avatar(), name, true);
    const named = element("p", "row-title", name);
    const word = element("p", "buddy-state");
    word.dataset.tone = state.tone;
    const dot = element("span", "buddy-dot");
    dot.setAttribute("aria-hidden", "true");
    word.append(dot, state.word);
    main.append(face, named, word);
    who.append(main);

    const signIn = element("div", "row buddy-sign-in-row");
    const signMain = element("div", "row-main");
    const parts = element("ul", "buddy-parts buddy-parts-plain");
    parts.append(buddyPartNode(row.part, copy));
    const controls = element("div", "row-control");
    switch (row.controls) {
      case "menu":
        controls.append(menu(copy));
        break;
      case "sign-in":
        controls.append(
          button(copy.buddySignInShort, options.signIn, "primary"),
        );
        break;
      case "resume":
        controls.append(
          button(copy.buddyCancel, options.cancel),
          button(copy.buddyContinue, options.resume, "primary"),
        );
        break;
      case "new-code":
        controls.append(button(copy.buddyNewCode, options.signIn, "primary"));
        break;
      case "none":
        break;
    }
    signMain.append(parts, controls);
    signIn.append(signMain);
    stateCard.replaceChildren(who, signIn);
  }

  function askSignOut() {
    const copy = options.copy();
    confirmTitle.textContent = copy.buddySignOutTitle;
    confirmText.textContent = copy.buddySignOutText;
    confirmStatus.textContent = "";
    confirmOk.textContent = copy.buddySignOut;
    confirmCancel.textContent = copy.buddyCancel;
    confirmOk.disabled = false;
    if (typeof confirm.showModal === "function") confirm.showModal();
    else confirm.setAttribute("open", "");
    confirmTitle.focus({ preventScroll: true });
  }
  confirmCancel.addEventListener("click", () => confirm.close());
  confirmOk.addEventListener("click", async () => {
    confirmOk.disabled = true;
    const done = await options.signOut();
    if (done) {
      confirm.close();
      return;
    }
    confirmOk.disabled = false;
    confirmStatus.textContent = options.copy().buddySignOutFailed;
  });

  // ---- Jméno a oslovení ----

  /** The line under the names: the last save, or that a change waits. */
  function statusLine(copy: Copy): string {
    const pending = options.facts().reading?.persona?.pending === true;
    if (lastSave?.kind === "saved")
      return pending ? copy.buddyPending : copy.buddySaved;
    if (lastSave !== null) return saveLine(lastSave, copy) ?? "";
    return pending ? copy.buddyPending : "";
  }

  function buildForm(copy: Copy) {
    const locale = options.locale();
    const row = (label: string, control: HTMLElement, id?: string) => {
      const node = element("div", "row");
      const main = element("div", "row-main buddy-row-main");
      const text = element(
        id === undefined ? "p" : "label",
        "row-title",
        label,
      );
      if (id !== undefined) (text as HTMLLabelElement).htmlFor = id;
      main.append(text, control);
      node.append(main);
      return node;
    };
    const name = element("input", "buddy-input");
    name.id = "buddy-name";
    name.value = draft.buddyName;
    name.maxLength = 60;
    name.autocomplete = "off";
    name.spellcheck = false;

    const segmented = element("div", "buddy-segmented");
    segmented.setAttribute("role", "group");
    segmented.setAttribute("aria-label", copy.buddyAddressRow);
    const choices = (["vy", "ty"] as const).map((value) => {
      const choice = button(
        value === "vy" ? copy.buddyAddressVyLabel : copy.buddyAddressTyLabel,
        () => {
          draft = { ...draft, address: value };
          changed();
        },
      );
      choice.dataset.address = value;
      return choice;
    });
    segmented.append(...choices);

    const you = element("input", "buddy-input");
    you.id = "buddy-you";
    you.value = draft.user.nominative;
    you.maxLength = 60;
    you.autocomplete = "off";
    const forms = element("div", "buddy-forms");
    const youControl = element("div", "buddy-you");
    youControl.append(you, forms);

    const status = element("p", "row-status buddy-line");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const save = element("button", "primary", copy.buddySave);
    save.type = "submit";
    const saveRow = element("div", "row");
    const saveMain = element("div", "row-main buddy-save-row");
    saveMain.append(status, save);
    saveRow.append(saveMain);

    function drawForms() {
      const view = introduceScreen(draft, locale, copy);
      if (fixing && view.fixable) {
        const field = (form: "accusative" | "dative", template: string) => {
          const quote = element("span", "buddy-trace");
          const [before = "", after = ""] = template.split("{name}");
          const input = element("input", "buddy-input buddy-input-word");
          input.value = draft.user[form];
          input.maxLength = 60;
          input.autocomplete = "off";
          input.setAttribute("aria-label", before.trim() || template);
          input.addEventListener("input", () => {
            draft = withForm(draft, form, input.value);
            changed(false);
          });
          quote.append(`„${before}`, input, `${after}“`);
          return quote;
        };
        forms.replaceChildren(
          field("accusative", copy.buddyTraceFor),
          field("dative", copy.buddyTraceSend),
        );
      } else
        forms.replaceChildren(
          ...view.traces.map((trace) =>
            element(
              "span",
              "buddy-trace",
              locale === "cs" ? `„${trace}“` : `“${trace}”`,
            ),
          ),
        );
      if (view.fixable) {
        const fix = button(fixing ? copy.buddyFixDone : copy.buddyFix, () => {
          fixing = !fixing;
          drawForms();
        });
        fix.className = "link-button buddy-fix";
        forms.append(fix);
      }
    }

    /** What follows the draft: the choice, the forms, Uložit. */
    function sync(redrawForms = true) {
      for (const choice of choices)
        choice.setAttribute(
          "aria-pressed",
          String(choice.dataset.address === draft.address),
        );
      if (redrawForms) drawForms();
      drawSave();
    }
    /** The person changed something: the last save's line goes. */
    function changed(redrawForms = true) {
      lastSave = null;
      sync(redrawForms);
    }
    function drawSave() {
      const persona = options.facts().reading?.persona ?? null;
      save.disabled =
        saving ||
        !draftReady(draft, options.locale()) ||
        !draftChanged(draft, persona);
      status.textContent = statusLine(options.copy());
    }
    name.addEventListener("input", () => {
      draft = { ...draft, buddyName: name.value };
      changed(false);
    });
    you.addEventListener("input", () => {
      draft = withYourName(draft, you.value, locale);
      changed(!fixing);
    });
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      saving = true;
      drawSave();
      const result = await options.save(draft);
      saving = false;
      lastSave = result;
      // The form of now (a save that moved the persona built it again).
      drawSaveNow?.();
    };
    form.replaceChildren(
      row(copy.buddyNameRow, name, name.id),
      ...(locale === "cs" ? [row(copy.buddyAddressRow, segmented)] : []),
      row(copy.buddyYouRow, youControl, you.id),
      saveRow,
    );
    sync();
    return drawSave;
  }

  let drawSaveNow: (() => void) | null = null;

  /** The form for the persona of now: built again for another persona or
   * language, keeping what the person typed and has not saved. */
  function drawPersona(copy: Copy) {
    const persona = options.facts().reading?.persona ?? null;
    const id = JSON.stringify([
      persona?.revision ?? null,
      options.locale(),
      copy.buddySave,
    ]);
    if (id === formFor) {
      drawSaveNow?.();
      return;
    }
    const edited =
      formFor !== null &&
      JSON.stringify(draft) !==
        JSON.stringify(draftOf(formPersona, options.locale()));
    const typed = edited ? draft : null;
    formFor = id;
    formPersona = persona;
    draft = typed ?? draftOf(persona, options.locale());
    fixing = false;
    drawSaveNow = buildForm(copy);
  }

  function render() {
    const copy = options.copy();
    const here = options.here();
    notHere.hidden = here;
    for (const group of groups) group.hidden = !here;
    if (!here) return;
    drawState(copy);
    drawPersona(copy);
  }

  document.addEventListener("click", (event) => {
    if (closeMenu === null) return;
    const target = event.target;
    if (target instanceof Node && stateCard.contains(target)) return;
    closeMenu();
  });

  return Object.freeze({ render });
}
