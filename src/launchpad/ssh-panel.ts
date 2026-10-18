import type { SshAccessOverview } from "../ssh-access/access";
import type { ComputerAnswer } from "../ssh-access/host";
import type { ListedKey } from "../ssh-access/keys";
import type { MessageKey } from "./messages";
import {
  addRefusal,
  keyGroups,
  keyView,
  missingTexts,
  parseComputer,
  parseSshOverview,
  problemText,
  removeRefusal,
  sshPrompt,
} from "./ssh-view";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;

// Settings → SSH from your devices (decision F49): the devices whose keys
// sign in to this Environment, the form that adds one, the settings a
// computer writes and the prompt for the person's own agent. Every server
// value is drawn as text. The blocks an agent reads (`data-ssh-block`:
// `prompt`, `config`, `known-hosts`) are each one `<pre>` whose text is
// exactly what is written to the computer.
export function createSshPanel(
  options: Readonly<{
    /** `GET /api/ssh` with the page's credential. */
    get: (path: string) => Answer;
    post: (path: string, body: unknown) => Answer;
    copy: () => Copy;
    /** The login of the Lazurio account signed in at this page, when the
     * page knows it: a label of who added a key, never evidence (F49). */
    addedBy: () => Promise<string | null>;
    /** This page's origin: the prompt names its own Settings page. */
    origin: () => string;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing SSH UI");
    return element;
  };
  const status = find<HTMLParagraphElement>("#ssh-status");
  const unsupported = find<HTMLParagraphElement>("#ssh-unsupported");
  const prompt = find<HTMLPreElement>("#ssh-prompt");
  const promptMissing = find<HTMLParagraphElement>("#ssh-prompt-missing");
  const promptCopy = find<HTMLButtonElement>("#ssh-prompt-copy");
  const problem = find<HTMLParagraphElement>("#ssh-problem");
  const devices = find<HTMLUListElement>("#ssh-devices");
  const outsideGroup = find<HTMLElement>("#ssh-outside-group");
  const outside = find<HTMLUListElement>("#ssh-outside");
  const form = find<HTMLFormElement>("#ssh-add");
  const device = find<HTMLInputElement>("#ssh-device");
  const publicKey = find<HTMLTextAreaElement>("#ssh-key");
  const deviceError = find<HTMLParagraphElement>("#ssh-device-error");
  const keyError = find<HTMLParagraphElement>("#ssh-key-error");
  const formError = find<HTMLParagraphElement>("#ssh-add-error");
  const added = find<HTMLParagraphElement>("#ssh-added");
  const submit = find<HTMLButtonElement>("#ssh-add-submit");
  const ready = find<HTMLDivElement>("#ssh-computer-ready");
  const config = find<HTMLPreElement>("#ssh-config");
  const knownHosts = find<HTMLPreElement>("#ssh-known-hosts");
  const missing = find<HTMLDivElement>("#ssh-computer-missing");
  const again = find<HTMLButtonElement>("#ssh-refresh");

  let overview: SshAccessOverview | null = null;
  let loading = false;
  let failed = false;
  let adding = false;
  // The device just added (its name) or found already present, said above
  // the settings for the computer.
  let addedNote: string | null = null;
  // The key whose removal waits for its confirmation, and the one under way.
  let confirming: string | null = null;
  let removing: string | null = null;
  let removeNote: Readonly<{ fingerprint: string; text: string }> | null = null;
  let removedNote: string | null = null;
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
  const button = (label: string, className: string, action: () => void) => {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };

  /** Reads the keys and the settings again. */
  async function refresh(): Promise<void> {
    const turn = ++reading;
    loading = true;
    render();
    let read: SshAccessOverview | null = null;
    try {
      const { value, ok } = await options.get("/api/ssh");
      read = ok ? parseSshOverview(value) : null;
    } catch {
      read = null;
    }
    if (turn !== reading) return;
    loading = false;
    failed = read === null;
    if (read !== null) overview = read;
    render();
  }

  function renderPrompt(copy: Copy, computer: ComputerAnswer | null) {
    const settings = computer?.state === "ready" ? computer : null;
    prompt.textContent =
      settings === null
        ? ""
        : sshPrompt(
            {
              url: `${options.origin()}/settings/ssh`,
              alias: settings.alias,
              keyPath: settings.keyPath,
              ...(settings.codex ? { desktopLink: settings.codex.url } : {}),
            },
            copy,
          );
    prompt.hidden = settings === null;
    promptCopy.hidden = settings === null;
    promptMissing.hidden = settings !== null || overview === null;
    promptMissing.textContent = copy.sshPromptUnavailable;
  }

  function keyRow(key: ListedKey, copy: Copy): HTMLLIElement {
    const view = keyView(key, copy);
    const row = element("li", "row");
    const main = element("div", "row-main");
    const words = element("div", "row-copy");
    words.append(element("p", "row-title", view.title));
    for (const fact of view.facts)
      words.append(element("p", "row-desc ssh-fact", fact));
    if (view.fingerprint !== null) row.dataset.fingerprint = view.fingerprint;
    const control = element("div", "row-control");
    const fingerprint = view.fingerprint;
    if (view.removable && fingerprint !== null) {
      if (confirming === fingerprint) {
        words.append(
          element(
            "p",
            "row-status",
            fill(copy.sshRemoveConfirm, { device: view.title }),
          ),
        );
        const yes = button(copy.sshRemoveYes, "destructive", () => {
          void remove(fingerprint);
        });
        yes.disabled = removing !== null;
        const no = button(copy.sshRemoveCancel, "", () => {
          confirming = null;
          render();
        });
        no.disabled = removing !== null;
        control.append(yes, no);
      } else {
        const ask = button(copy.sshRemove, "destructive", () => {
          confirming = fingerprint;
          removeNote = null;
          render();
        });
        ask.disabled = removing !== null;
        ask.setAttribute(
          "aria-label",
          fill(copy.sshRemoveNamed, { device: view.title }),
        );
        control.append(ask);
      }
      if (removeNote?.fingerprint === fingerprint) {
        const note = element("p", "ssh-error", removeNote.text);
        note.setAttribute("role", "alert");
        words.append(note);
      }
    }
    main.append(words, control);
    row.append(main);
    return row;
  }

  function renderKeys(copy: Copy) {
    const keys = overview?.keys ?? null;
    const refused = overview?.problem ?? null;
    problem.hidden = refused === null;
    problem.textContent = refused === null ? "" : problemText(refused, copy);
    if (keys === null) {
      devices.replaceChildren();
      devices.hidden = true;
      outsideGroup.hidden = true;
      return;
    }
    const groups = keyGroups(keys);
    devices.hidden = false;
    devices.replaceChildren(
      ...(removedNote === null
        ? []
        : [element("li", "row row-status ssh-note", removedNote)]),
      ...(groups.devices.length === 0
        ? [element("li", "row row-desc", copy.sshDevicesNone)]
        : groups.devices.map((key) => keyRow(key, copy))),
    );
    outsideGroup.hidden = groups.outside.length === 0;
    outside.replaceChildren(...groups.outside.map((key) => keyRow(key, copy)));
  }

  function renderComputer(copy: Copy) {
    const computer = overview?.computer ?? null;
    const settings = computer?.state === "ready" ? computer : null;
    ready.hidden = settings === null;
    config.textContent = settings?.config ?? "";
    knownHosts.textContent = settings?.knownHosts ?? "";
    const desktop = find<HTMLAnchorElement>("#ssh-codex");
    desktop.hidden = settings?.codex === undefined;
    if (settings?.codex) desktop.href = settings.codex.url;
    else desktop.removeAttribute("href");
    find<HTMLElement>("#ssh-project-path").textContent =
      settings?.codex?.projectPath ?? "";
    missing.hidden = computer === null || computer.state === "ready";
    if (computer === null || computer.state === "ready")
      missing.replaceChildren();
    else {
      const list = element("ul", "ssh-missing");
      list.append(
        ...missingTexts(computer.missing, copy).map((line) =>
          element("li", "", line),
        ),
      );
      missing.replaceChildren(element("p", "", copy.sshComputerMissing), list);
    }
    added.hidden = addedNote === null;
    added.textContent = addedNote ?? "";
  }

  function render() {
    const copy = options.copy();
    again.disabled = loading;
    status.textContent = loading
      ? copy.sshLoading
      : failed
        ? copy.sshLoadFailed
        : "";
    unsupported.hidden = overview === null || overview.supported;
    form.hidden = overview !== null && !overview.supported;
    submit.disabled = adding || overview === null || !overview.supported;
    submit.textContent = adding ? copy.sshAdding : copy.sshAdd;
    renderPrompt(copy, overview?.computer ?? null);
    renderKeys(copy);
    renderComputer(copy);
  }

  function clearErrors() {
    for (const node of [deviceError, keyError, formError])
      node.textContent = "";
    device.removeAttribute("aria-invalid");
    publicKey.removeAttribute("aria-invalid");
  }

  async function add() {
    if (adding) return;
    const copy = options.copy();
    clearErrors();
    addedNote = null;
    removedNote = null;
    adding = true;
    render();
    try {
      const login = await options.addedBy().catch(() => null);
      const { value, ok } = await options.post("/api/ssh/add", {
        device: device.value,
        publicKey: publicKey.value,
        ...(login === null ? {} : { addedBy: login }),
      });
      const answer = value as Record<string, unknown> | null;
      if (ok && answer?.kind === "ssh-key-added") {
        const computer = parseComputer(answer.computer);
        const key = answer.key as ListedKey | undefined;
        const name =
          key?.origin === "launchpad" ? key.device : device.value.trim();
        addedNote =
          answer.outcome === "already-present"
            ? copy.sshAlreadyPresent
            : fill(copy.sshAdded, { device: name });
        publicKey.value = "";
        if (computer !== null && overview !== null)
          overview = { ...overview, computer };
        await refresh();
        added.scrollIntoView({ block: "nearest" });
        return;
      }
      const refusal = addRefusal(answer?.reason, copy);
      const target =
        refusal.field === "device"
          ? deviceError
          : refusal.field === "publicKey"
            ? keyError
            : formError;
      target.textContent = refusal.text;
      if (refusal.field === "device")
        device.setAttribute("aria-invalid", "true");
      if (refusal.field === "publicKey")
        publicKey.setAttribute("aria-invalid", "true");
    } catch {
      formError.textContent = copy.sshAddFailed;
    } finally {
      adding = false;
      render();
    }
  }

  async function remove(fingerprint: string) {
    if (removing !== null) return;
    const copy = options.copy();
    removing = fingerprint;
    removeNote = null;
    removedNote = null;
    render();
    try {
      const { value, ok } = await options.post("/api/ssh/remove", {
        fingerprint,
      });
      const answer = value as Record<string, unknown> | null;
      if (ok && answer?.kind === "ssh-key-removed") {
        const key = answer.key as ListedKey | undefined;
        const name = key?.origin === "launchpad" ? key.device : fingerprint;
        removedNote = fill(
          answer.stillAllowed === true
            ? copy.sshRemovedStillAllowed
            : copy.sshRemoved,
          { device: name },
        );
        confirming = null;
        removing = null;
        await refresh();
        return;
      }
      removeNote = { fingerprint, text: removeRefusal(answer?.reason, copy) };
    } catch {
      removeNote = { fingerprint, text: copy.sshRemoveFailed };
    } finally {
      removing = null;
      render();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void add();
  });
  again.addEventListener("click", () => {
    addedNote = null;
    removedNote = null;
    void refresh();
  });
  // Every copy button copies its block's exact text and says so beside it.
  for (const action of document.querySelectorAll<HTMLButtonElement>(
    "#section-ssh [data-copy]",
  )) {
    action.addEventListener("click", () => {
      const source = document.getElementById(action.dataset.copy ?? "");
      const said =
        action.parentElement?.querySelector<HTMLElement>("[data-copy-status]");
      const copy = options.copy();
      if (source === null) return;
      void navigator.clipboard?.writeText(source.textContent ?? "").then(
        () => {
          if (said) said.textContent = copy.sshCopied;
        },
        () => {
          // The text stays selectable: select it for the keyboard.
          const range = document.createRange();
          range.selectNodeContents(source);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          if (said) said.textContent = copy.toolsCopyFailed;
        },
      );
    });
  }

  return Object.freeze({
    refresh,
    render,
    /** Whether the section was read once. */
    get loaded() {
      return overview !== null || loading;
    },
  });
}
