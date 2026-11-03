import type { ConnectionsOverview, PairedDevice } from "../connections/pairing";
import { createPairingFlow, type PairingView } from "./connections-flow";
import {
  deviceDetail,
  deviceName,
  offersRestart,
  offersSignIn,
  parseConnectionsOverview,
  remaining,
  stateMessage,
} from "./connections-view";
import type { MessageKey } from "./messages";
import { pollWhileVisible } from "./visible-poll";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;

// Settings → Connections (decision F71): Ovládat toto Prostředí with its
// ways by device. Telefon: one sentence, one button, the motion graphic,
// and the dialog with the QR code the ChatGPT app's own scanner reads, the
// short code, the time left, a new code once it expired and "Telefon je
// spárovaný" (the sequence in connections-flow.ts). Počítač: one sentence
// and the way to today's F49 page, where SSH into this Environment exists.
// Every server value is drawn as text; the page drops the code when the
// dialog closes.
export function createConnectionsPanel(
  options: Readonly<{
    get: (path: string) => Answer;
    post: (path: string, body: unknown) => Answer;
    copy: () => Copy;
    locale: () => string;
    /** Whether Počítač is offered: an Environment on a server, not the
     * person's own computer. */
    computer: () => boolean;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing Connections UI");
    return element;
  };
  const state = find<HTMLParagraphElement>("#phone-state");
  const pairButton = find<HTMLButtonElement>("#phone-pair");
  const signIn = find<HTMLAnchorElement>("#phone-sign-in");
  const restartButton = find<HTMLButtonElement>("#phone-restart");
  const restartConfirm = find<HTMLDivElement>("#phone-restart-confirm");
  const restartYes = find<HTMLButtonElement>("#phone-restart-yes");
  const restartCancel = find<HTMLButtonElement>("#phone-restart-cancel");
  const card = find<HTMLDivElement>("#phone-card");
  const computerCard = find<HTMLDivElement>("#computer-card");
  const how = find<HTMLButtonElement>("#phone-how");
  const needs = find<HTMLParagraphElement>("#phone-needs");
  const devicesGroup = find<HTMLElement>("#phone-devices-group");
  const devicesList = find<HTMLUListElement>("#phone-devices");
  const again = find<HTMLButtonElement>("#connections-refresh");
  const dialog = find<HTMLDialogElement>("#phone-dialog");
  const dialogClose = find<HTMLButtonElement>("#phone-dialog-close");
  const pairing = find<HTMLDivElement>("#phone-dialog-pairing");
  const qrFrame = find<HTMLDivElement>(".phone-qr-frame");
  const qr = find<HTMLImageElement>("#phone-qr");
  const code = find<HTMLElement>("#phone-code");
  const codeCopy = find<HTMLButtonElement>("#phone-code-copy");
  const countdown = find<HTMLParagraphElement>("#phone-countdown");
  const done = find<HTMLDivElement>("#phone-dialog-done");
  const dialogStatus = find<HTMLParagraphElement>("#phone-dialog-status");
  const newCode = find<HTMLButtonElement>("#phone-new");
  const ok = find<HTMLButtonElement>("#phone-dialog-ok");

  let overview: ConnectionsOverview | null = null;
  let loading = false;
  let failed = false;
  let busy: "restart" | null = null;
  let note: MessageKey | null = null;
  let confirming: string | null = null;
  let removing: string | null = null;
  let reading = 0;
  // The motion shows until a phone is paired, then folds under "Ukázat
  // postup" (the prototype's rework of 2026-11-03); null follows that rule.
  let showHow: boolean | null = null;
  // The countdown of the code shown.
  let tick: ReturnType<typeof setInterval> | null = null;
  const flow = createPairingFlow({
    post: options.post,
    poll: (step, ms) => pollWhileVisible(step, ms),
    show: (view) => showPairing(view),
  });

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

  async function refresh(): Promise<void> {
    const turn = ++reading;
    loading = true;
    render();
    let read: ConnectionsOverview | null = null;
    try {
      const { value, ok: answered } = await options.get("/api/connections");
      read = answered ? parseConnectionsOverview(value) : null;
    } catch {
      read = null;
    }
    if (turn !== reading) return;
    loading = false;
    failed = read === null;
    if (read !== null) overview = read;
    render();
  }

  function renderDevices(copy: Copy, devices: readonly PairedDevice[]) {
    devicesGroup.hidden = devices.length === 0;
    const format = new Intl.DateTimeFormat(options.locale(), {
      dateStyle: "medium",
      timeStyle: "short",
    });
    devicesList.replaceChildren(
      ...devices.map((device) => {
        const item = element("li");
        const main = element("div", "row-copy");
        main.append(element("p", "row-title", deviceName(device)));
        const details = [
          deviceDetail(device),
          device.lastSeenAt === null
            ? ""
            : copy.phoneLastSeen.replace(
                "{time}",
                format.format(new Date(device.lastSeenAt)),
              ),
        ].filter((part) => part !== "");
        if (details.length > 0)
          main.append(element("p", "row-desc", details.join(" · ")));
        const actions = element("div", "phone-device-actions");
        if (confirming === device.clientId) {
          actions.append(
            element(
              "span",
              "row-status",
              copy.phoneRemoveQuestion.replace("{name}", deviceName(device)),
            ),
            button(copy.phoneCancel, "", () => {
              confirming = null;
              render();
            }),
            button(copy.phoneRemoveYes, "primary", () => {
              void revoke(device.clientId);
            }),
          );
        } else {
          const remove = button(copy.phoneRemove, "", () => {
            confirming = device.clientId;
            render();
          });
          remove.disabled = removing !== null;
          actions.append(remove);
        }
        item.append(main, actions);
        return item;
      }),
    );
  }

  function render() {
    const copy = options.copy();
    computerCard.hidden = !options.computer();
    qr.alt = copy.phoneQrAlt;
    again.disabled = loading;
    const shown = overview;
    const message: string | null =
      busy === "restart"
        ? copy.phoneRestarting
        : note !== null
          ? copy[note]
          : shown === null
            ? loading
              ? copy.phoneLoading
              : failed
                ? copy.phoneFailed
                : null
            : (() => {
                const key = stateMessage(shown);
                return key === null ? null : copy[key];
              })();
    state.textContent = message ?? "";
    state.hidden = message === null;
    state.dataset.kind =
      note === "phoneRemoved" && busy === null ? "info" : "warning";
    const ready = shown?.state === "ready";
    pairButton.hidden = !ready;
    pairButton.disabled = busy !== null;
    pairButton.textContent =
      ready && shown.devices.length > 0
        ? copy.phonePairAnother
        : copy.phonePair;
    const paired = ready && shown.devices.length > 0;
    pairButton.classList.toggle("primary", !paired);
    needs.hidden = !ready || paired;
    how.hidden = !paired;
    // No steps to show where the phone cannot pair here.
    const motion = ready && (showHow ?? !paired);
    how.textContent = motion ? copy.phoneHideHow : copy.phoneHow;
    how.setAttribute("aria-expanded", String(motion));
    if (motion) delete card.dataset.folded;
    else card.dataset.folded = "";
    signIn.hidden = shown === null || !offersSignIn(shown);
    restartButton.hidden =
      shown === null || !offersRestart(shown) || !restartConfirm.hidden;
    restartButton.disabled = busy !== null;
    renderDevices(copy, shown?.devices ?? []);
  }

  function stopTick() {
    if (tick !== null) clearInterval(tick);
    tick = null;
  }

  function showCountdown() {
    const at = flow.expiresAt();
    if (at === 0) return;
    if (Date.now() >= at) {
      flow.tick();
      return;
    }
    countdown.textContent = options
      .copy()
      .phoneCountdown.replace("{time}", remaining(at, Date.now()));
  }

  /** Drops the code from the page. */
  function clearCode() {
    stopTick();
    qr.removeAttribute("src");
    code.textContent = "";
    countdown.textContent = "";
  }

  function showPairing(view: PairingView) {
    const copy = options.copy();
    switch (view.kind) {
      case "loading":
        clearCode();
        pairing.hidden = false;
        done.hidden = true;
        newCode.hidden = true;
        delete qrFrame.dataset.expired;
        dialogStatus.textContent = copy.phoneLoading;
        break;
      case "code":
        stopTick();
        qr.src = view.qrSource;
        code.textContent = view.manualCode ?? "";
        codeCopy.hidden = view.manualCode === null;
        dialogStatus.textContent = "";
        showCountdown();
        tick = setInterval(showCountdown, 1_000);
        break;
      case "expired":
        stopTick();
        qrFrame.dataset.expired = "";
        code.textContent = "";
        countdown.textContent = copy.phoneExpired;
        newCode.hidden = false;
        break;
      case "paired":
        clearCode();
        pairing.hidden = true;
        done.hidden = false;
        newCode.hidden = true;
        dialogStatus.textContent = "";
        if (overview !== null)
          overview = Object.freeze({ ...overview, devices: view.devices });
        break;
      case "refused":
        clearCode();
        pairing.hidden = true;
        newCode.hidden = false;
        dialogStatus.textContent = view.tooMany
          ? copy.phoneTooMany
          : copy.phoneFailed;
        if (view.overview !== null) overview = view.overview;
        break;
    }
    render();
    if (view.kind === "paired") ok.focus();
  }

  function open() {
    if (!dialog.open && typeof dialog.showModal === "function")
      dialog.showModal();
    void flow.start();
  }

  async function revoke(clientId: string) {
    removing = clientId;
    confirming = null;
    note = null;
    render();
    try {
      const { value, ok: answered } = await options.post(
        "/api/connections/revoke",
        { clientId },
      );
      const read = parseConnectionsOverview(
        answered ? value : (value as { overview?: unknown } | null)?.overview,
      );
      if (read !== null) overview = read;
      note = answered ? "phoneRemoved" : "phoneFailed";
    } catch {
      note = "phoneFailed";
    } finally {
      removing = null;
      render();
    }
  }

  async function restart() {
    restartConfirm.hidden = true;
    busy = "restart";
    note = null;
    render();
    try {
      const { value, ok: answered } = await options.post(
        "/api/connections/restart",
        { confirm: true },
      );
      const read = parseConnectionsOverview(
        answered ? value : (value as { overview?: unknown } | null)?.overview,
      );
      if (read !== null) overview = read;
      if (!answered) note = "phoneFailed";
    } catch {
      note = "phoneFailed";
    } finally {
      busy = null;
      render();
    }
  }

  pairButton.addEventListener("click", () => {
    note = null;
    open();
  });
  newCode.addEventListener("click", () => void flow.start());
  const close = () => {
    flow.close();
    clearCode();
    if (dialog.open) dialog.close();
  };
  ok.addEventListener("click", close);
  dialogClose.addEventListener("click", close);
  dialog.addEventListener("close", () => {
    flow.close();
    clearCode();
    void refresh();
  });
  codeCopy.addEventListener("click", () => {
    const text = code.textContent ?? "";
    if (text === "") return;
    void navigator.clipboard.writeText(text).then(
      () => {
        dialogStatus.textContent = options.copy().phoneCopied;
      },
      () => undefined,
    );
  });
  how.addEventListener("click", () => {
    showHow = card.dataset.folded !== undefined;
    render();
  });
  restartButton.addEventListener("click", () => {
    restartConfirm.hidden = false;
    render();
    restartCancel.focus();
  });
  restartCancel.addEventListener("click", () => {
    restartConfirm.hidden = true;
    render();
  });
  restartYes.addEventListener("click", () => void restart());
  again.addEventListener("click", () => {
    note = null;
    void refresh();
  });

  return {
    refresh,
    render,
    get loaded() {
      return overview !== null || loading;
    },
    /** For Začínáme: whether pairing is offered, and how many phones. */
    summary(): Readonly<{ ready: boolean; devices: number }> | null {
      return overview === null
        ? null
        : {
            ready: overview.state === "ready",
            devices: overview.devices.length,
          };
    },
  };
}
