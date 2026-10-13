import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";
import {
  fieldList,
  isFilled,
  itemLine,
  needTitle,
  parseRequestView,
  parseWaitingRequests,
  type RequestView,
  refusalText,
  requestHref,
} from "./vault-requests-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;

// The agents' secret requests in Nastavení → Trezor (root decision 0198
// point 9 (c), decision F53; the wireframe's screens/SecretRequest.tsx and
// the section of EnvVault.tsx):
//
// - "Žádosti agentů" (`#vault-requests`): what the agents wait for, each
//   with "Zadat", which opens its page; nothing when nothing waits;
// - a request's own page (`#vault-request`, `/settings/vault/requests/<id>`):
//   what the agent needs as its title, why and where, one input per field
//   (a password input for a secret one), "Uložit do trezoru" and
//   "Odmítnout".
//
// Any person admitted to the Environment answers; no account in the vault is
// needed. A value goes from its input to the one request that saves it and
// nowhere else: never to browser storage, the address or a log, and the
// inputs are emptied once it is saved. Every server value is drawn as text.
export function createVaultRequestsPanel(
  options: Readonly<{
    get: (path: string) => Answer;
    post: (path: string, body: unknown) => Answer;
    copy: () => Copy;
  }>,
) {
  // The places the Trezor page holds: found when shown, so they may come
  // with the page's own markup.
  const slot = (id: string) => document.getElementById(id);
  let route: PageRoute | null = null;
  let waiting: RequestView[] | null = null;
  let request: RequestView | null = null;
  // Why the page has no request to show, or what happened to the last save.
  let problem: string | null = null;
  let note: string | null = null;
  let saving = false;
  let reading = 0;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    content?: string,
  ) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (content !== undefined) created.textContent = content;
    return created;
  };

  const showing = () =>
    route !== null &&
    route.view === "settings" &&
    route.section === "vault" &&
    route.request !== undefined
      ? route.request
      : null;

  /** The requests that wait, for the section. */
  async function readWaiting(): Promise<void> {
    const turn = ++reading;
    let read: RequestView[] | null = null;
    try {
      const { value, ok } = await options.get("/api/vault/requests");
      read = ok ? parseWaitingRequests(value) : null;
    } catch {
      read = null;
    }
    if (turn !== reading) return;
    waiting = read;
    render();
  }

  /** One request, for its page. */
  async function readRequest(id: string): Promise<void> {
    const turn = ++reading;
    let read: RequestView | null = null;
    let reason: string | null = null;
    try {
      const { value, ok } = await options.get(
        `/api/vault/requests/${encodeURIComponent(id)}`,
      );
      read = ok ? parseRequestView(value) : null;
      if (read === null)
        reason =
          refusalText((value as { reason?: unknown } | null)?.reason, copy()) ??
          copy().vaultRequestLoadFailed;
    } catch {
      reason = copy().vaultRequestLoadFailed;
    }
    if (turn !== reading || showing() !== id) return;
    request = read;
    problem = reason;
    render();
  }

  const copy = () => options.copy();

  function sectionOf(requests: readonly RequestView[]): HTMLElement {
    const text = copy();
    const group = element("section", "group vault-requests");
    group.setAttribute("aria-labelledby", "vault-requests-heading");
    const head = element("div", "group-head");
    const title = element("h2", "", text.vaultRequestsTitle);
    title.id = "vault-requests-heading";
    title.append(
      " ",
      element("span", "badge vault-requests-count", String(requests.length)),
    );
    head.append(title);
    const list = element("ul", "card");
    for (const entry of requests) {
      const row = element("li", "row");
      const main = element("div", "row-main");
      const words = element("div", "row-copy");
      words.append(
        element("p", "row-title", needTitle(entry.need)),
        element("p", "row-desc", fieldList(entry.fields, text)),
      );
      const control = element("div", "row-control");
      const answer = element("a", "button primary", text.vaultRequestAnswer);
      answer.href = requestHref(entry);
      answer.dataset.route = "";
      control.append(answer);
      main.append(words, control);
      row.append(main);
      list.append(row);
    }
    group.append(head, list);
    return group;
  }

  /** The inputs of the form now shown, emptied; nothing typed stays. */
  function forget(container: HTMLElement) {
    for (const input of container.querySelectorAll("input")) input.value = "";
  }

  function pageOf(shown: RequestView): HTMLElement {
    const text = copy();
    const group = element("section", "group vault-request");
    group.setAttribute("aria-labelledby", "vault-request-heading");
    const head = element("div", "group-head vault-request-head");
    const label = element("p", "group-note", text.vaultRequestTitle);
    const title = element("h2", "", needTitle(shown.need));
    title.id = "vault-request-heading";
    head.append(
      label,
      title,
      element("p", "vault-request-why", shown.why),
      element("p", "vault-request-where", shown.where),
    );
    group.append(head);
    if (shown.state !== "pending") {
      const done = element(
        "p",
        "callout vault-request-state",
        shown.state === "saved"
          ? text.vaultRequestSaved
          : text.vaultRequestDeclined,
      );
      done.dataset.state = shown.state;
      done.setAttribute("role", "status");
      group.append(done);
      return group;
    }
    const form = element("form", "card vault-request-form");
    form.noValidate = true;
    form.autocomplete = "off";
    const inputs = new Map<string, HTMLInputElement>();
    shown.fields.forEach((field, index) => {
      const row = element("div", "row");
      const box = element("div", "vault-request-field");
      const id = `vault-request-field-${index}`;
      const name = element("label", "row-title", field.name);
      name.htmlFor = id;
      const input = element("input");
      input.id = id;
      input.type = field.secret ? "password" : "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "off");
      input.maxLength = 10_000;
      inputs.set(field.name, input);
      const value = element("span", "vault-request-value");
      value.append(input);
      if (field.secret) {
        const reveal = element("button", "ghost", text.vaultRequestShow);
        reveal.type = "button";
        reveal.setAttribute("aria-pressed", "false");
        reveal.setAttribute("aria-controls", id);
        reveal.addEventListener("click", () => {
          const shownNow = input.type === "password";
          input.type = shownNow ? "text" : "password";
          reveal.textContent = shownNow
            ? copy().vaultRequestHide
            : copy().vaultRequestShow;
          reveal.setAttribute("aria-pressed", String(shownNow));
        });
        value.append(reveal);
      }
      box.append(name, value);
      row.append(box);
      form.append(row);
    });
    const actions = element("div", "row");
    const main = element("div", "row-main");
    const words = element("div", "row-copy");
    const error = element("p", "vault-request-error", note ?? "");
    error.setAttribute("role", "alert");
    words.append(element("p", "row-desc", itemLine(shown, text)), error);
    const control = element("div", "row-control");
    const save = element(
      "button",
      "primary",
      saving ? text.vaultRequestSaving : text.vaultRequestSave,
    );
    save.type = "submit";
    const decline = element("button", "", text.vaultRequestDecline);
    decline.type = "button";
    const values = () =>
      new Map([...inputs].map(([name, input]) => [name, input.value]));
    const enable = () => {
      save.disabled = saving || !isFilled(shown, values());
      decline.disabled = saving;
    };
    enable();
    form.addEventListener("input", enable);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (saving || !isFilled(shown, values())) return;
      void answer(shown, "save", form, Object.fromEntries(values()));
    });
    decline.addEventListener("click", () => {
      if (!saving) void answer(shown, "decline", form);
    });
    control.append(save, decline);
    main.append(words, control);
    actions.append(main);
    form.append(actions);
    group.append(form);
    return group;
  }

  /** Uložit do trezoru or Odmítnout. The values go into this one request
   * and are dropped with the form once it is answered. */
  async function answer(
    shown: RequestView,
    action: "save" | "decline",
    form: HTMLFormElement,
    values?: Record<string, string>,
  ): Promise<void> {
    saving = true;
    note = null;
    render(form);
    let result: RequestView | null = null;
    let reason: unknown = null;
    try {
      const { value, ok } = await options.post(
        `/api/vault/requests/${encodeURIComponent(shown.id)}/${action}`,
        action === "save" ? { values } : {},
      );
      result = ok ? parseRequestView(value) : null;
      if (!ok) reason = (value as { reason?: unknown } | null)?.reason;
    } catch {
      reason = "failed";
    }
    saving = false;
    if (showing() !== shown.id) {
      forget(form);
      return;
    }
    if (result !== null) {
      forget(form);
      request = result;
      render();
      return;
    }
    const said = refusalText(reason, copy());
    if (said === null) {
      // Answered meanwhile (by another person): its state is read again.
      forget(form);
      await readRequest(shown.id);
      return;
    }
    note = said;
    render(form);
  }

  /** Draws what the route shows. `kept` is the form being answered: only
   * its controls and the line under them change, so what is typed stays
   * while it saves and after a refusal. */
  function render(kept?: HTMLFormElement) {
    const section = slot("vault-requests");
    const page = slot("vault-request");
    const onVault =
      route !== null && route.view === "settings" && route.section === "vault";
    const id = showing();
    if (section !== null) {
      const list = onVault && id === null ? (waiting ?? []) : [];
      section.hidden = list.length === 0;
      section.replaceChildren(...(list.length === 0 ? [] : [sectionOf(list)]));
    }
    if (page === null) return;
    page.hidden = id === null;
    if (kept !== undefined && id !== null && page.contains(kept)) {
      const save = kept.querySelector<HTMLButtonElement>("button[type=submit]");
      if (save !== null)
        save.textContent = saving
          ? copy().vaultRequestSaving
          : copy().vaultRequestSave;
      const error = kept.querySelector<HTMLElement>(".vault-request-error");
      if (error !== null) error.textContent = note ?? "";
      // The form's own rule enables its controls again.
      kept.dispatchEvent(new Event("input"));
      return;
    }
    forget(page);
    if (id === null) {
      page.replaceChildren();
      return;
    }
    if (request === null || request.id !== id) {
      page.replaceChildren(
        ...(problem === null ? [] : [element("p", "callout", problem)]),
      );
      return;
    }
    page.replaceChildren(pageOf(request));
  }

  return Object.freeze({
    /** The route now shown: Trezor reads what waits, a request's page reads
     * that request; anything else leaves both empty. */
    show(next: PageRoute) {
      route = next;
      if (next.view !== "settings" || next.section !== "vault") {
        reading++;
        request = null;
        problem = null;
        note = null;
        render();
        return;
      }
      if (next.request === undefined) {
        request = null;
        problem = null;
        note = null;
        render();
        void readWaiting();
        return;
      }
      if (request?.id !== next.request) {
        request = null;
        problem = null;
        note = null;
      }
      render();
      void readRequest(next.request);
    },
    /** The page's language changed. */
    relabel() {
      if (!saving) render();
    },
  });
}
