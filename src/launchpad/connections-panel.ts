import type { ConnectionsOverview, PairedDevice } from "../connections/pairing";
import { createPairingFlow, type PairingView } from "./connections-flow";
import {
  deviceDetail,
  deviceForm,
  deviceName,
  offersRestart,
  offersSignIn,
  offersSsh,
  pairingShape,
  parseConnectionsOverview,
  pathDetail,
  remaining,
  type SshPath,
  sshPaths,
  stateMessage,
} from "./connections-view";
import type { MachineView } from "./machine-view";
import type { MessageKey } from "./messages";
import { pollWhileVisible } from "./visible-poll";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;
type Way = "phone" | "computer";

// Settings → Connections (decision F71 and its addendum of 2026-11-11):
// Ovládat toto Prostředí with its ways by device, both paired by a code
// through the person's ChatGPT account. Telefon and Počítač: one sentence,
// one button, the motion graphic, and one dialog with the one live code:
// the QR code the ChatGPT app's own scanner reads for a phone, the short
// code ChatGPT Desktop takes for a computer, the time left, a new code once
// it expired and "spárovaný" (the sequence in connections-flow.ts). Below,
// only where the handover records a peer that may open SSH into this
// Environment, Přes SSH: the paths the tailnet allows each way and the way
// to F49's page. Every server value is drawn as text; the page drops the
// code when the dialog closes.
export function createConnectionsPanel(
  options: Readonly<{
    get: (path: string) => Answer;
    post: (path: string, body: unknown) => Answer;
    copy: () => Copy;
    locale: () => string;
    /** The recorded preset and Machine binding, null until the profile is
     * read: Počítač is offered on an Environment on a server, not on the
     * person's own computer, and the binding's peers are the SSH paths. */
    environment: () => Readonly<{
      preset: string;
      machine: MachineView | null;
    }> | null;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing Connections UI");
    return element;
  };
  const state = find<HTMLParagraphElement>("#phone-state");
  const signIn = find<HTMLAnchorElement>("#phone-sign-in");
  const restartButton = find<HTMLButtonElement>("#phone-restart");
  const restartConfirm = find<HTMLDivElement>("#phone-restart-confirm");
  const restartYes = find<HTMLButtonElement>("#phone-restart-yes");
  const restartCancel = find<HTMLButtonElement>("#phone-restart-cancel");
  const computerCard = find<HTMLDivElement>("#computer-card");
  const ways: Readonly<
    Record<
      Way,
      Readonly<{
        card: HTMLDivElement;
        pair: HTMLButtonElement;
        how: HTMLButtonElement;
      }>
    >
  > = {
    phone: {
      card: find<HTMLDivElement>("#phone-card"),
      pair: find<HTMLButtonElement>("#phone-pair"),
      how: find<HTMLButtonElement>("#phone-how"),
    },
    computer: {
      card: computerCard,
      pair: find<HTMLButtonElement>("#computer-pair"),
      how: find<HTMLButtonElement>("#computer-how"),
    },
  };
  const needs = find<HTMLParagraphElement>("#phone-needs");
  const devicesGroup = find<HTMLElement>("#phone-devices-group");
  const devicesList = find<HTMLUListElement>("#phone-devices");
  const sshGroup = find<HTMLElement>("#ssh-paths");
  const sshSetUp = find<HTMLAnchorElement>("#ssh-setup");
  const sshIn = find<HTMLElement>("#ssh-paths-in");
  const sshInList = find<HTMLUListElement>("#ssh-paths-in-list");
  const sshOut = find<HTMLElement>("#ssh-paths-out");
  const sshOutList = find<HTMLUListElement>("#ssh-paths-out-list");
  const again = find<HTMLButtonElement>("#connections-refresh");
  const dialog = find<HTMLDialogElement>("#phone-dialog");
  const dialogTitle = find<HTMLHeadingElement>("#phone-dialog-title");
  const dialogHint = find<HTMLParagraphElement>("#phone-dialog-hint");
  const dialogPaired = find<HTMLParagraphElement>("#phone-dialog-paired");
  const dialogClose = find<HTMLButtonElement>("#phone-dialog-close");
  const pairing = find<HTMLDivElement>("#phone-dialog-pairing");
  const qrFrame = find<HTMLDivElement>(".phone-qr-frame");
  const qr = find<HTMLImageElement>("#phone-qr");
  const code = find<HTMLElement>("#phone-code");
  const codeRow = find<HTMLDivElement>("#phone-code-row");
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
  // Each way's motion shows until a device of its form is paired, then
  // folds under "Ukázat postup" (the prototype's rework of 2026-11-03); null
  // follows that rule.
  const showHow: Record<Way, boolean | null> = { phone: null, computer: null };
  // The way whose button opened the dialog: what the dialog shows of the
  // one live code.
  let way: Way = "phone";
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
  /** A row's icon from the page's own symbols. */
  const icon = (name: string) => {
    const box = element("span", "connections-row-icon");
    box.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    box.append(svg);
    return box;
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
        item.dataset.form = deviceForm(device);
        item.append(icon(deviceForm(device) === "phone" ? "phone" : "laptop"));
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
              (deviceForm(device) === "phone"
                ? copy.phoneRemoveQuestion
                : copy.computerRemoveQuestion
              ).replace("{name}", deviceName(device)),
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

  function pathRow(path: SshPath, copy: Copy): HTMLLIElement {
    const item = element("li");
    item.append(icon(path.kind === "client-device" ? "laptop" : "machine"));
    const main = element("div", "row-copy");
    main.append(element("p", "row-title", path.name));
    const detail = pathDetail(path, copy);
    if (detail !== "") main.append(element("p", "row-desc", detail));
    item.append(main);
    return item;
  }

  /** Přes SSH: the recorded paths each way, and the way to F49's page only
   * where SSH into this Environment is allowed. */
  function renderSsh(copy: Copy) {
    const environment = options.environment();
    const paths =
      environment === null || environment.preset === "local"
        ? null
        : sshPaths(environment.machine);
    const inbound = paths?.inbound ?? [];
    const outbound = paths?.outbound ?? [];
    sshGroup.hidden = inbound.length === 0 && outbound.length === 0;
    sshSetUp.hidden = !(
      environment !== null && offersSsh(environment.preset, paths)
    );
    sshIn.hidden = inbound.length === 0;
    sshInList.replaceChildren(...inbound.map((path) => pathRow(path, copy)));
    sshOut.hidden = outbound.length === 0;
    sshOutList.replaceChildren(...outbound.map((path) => pathRow(path, copy)));
  }

  function render() {
    const copy = options.copy();
    const environment = options.environment();
    computerCard.hidden =
      environment === null || environment.preset === "local";
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
    const devices = ready ? shown.devices : [];
    for (const form of ["phone", "computer"] as const) {
      const { card, pair, how } = ways[form];
      const paired = devices.some((device) => deviceForm(device) === form);
      pair.hidden = !ready;
      pair.disabled = busy !== null;
      pair.textContent =
        form === "phone"
          ? paired
            ? copy.phonePairAnother
            : copy.phonePair
          : paired
            ? copy.computerPairAnother
            : copy.computerPair;
      pair.classList.toggle("primary", !paired);
      how.hidden = !paired;
      // No steps to show where nothing can pair here.
      const motion = ready && (showHow[form] ?? !paired);
      how.textContent = motion ? copy.phoneHideHow : copy.phoneHow;
      how.setAttribute("aria-expanded", String(motion));
      if (motion) delete card.dataset.folded;
      else card.dataset.folded = "";
    }
    needs.hidden = !ready || devices.length > 0;
    signIn.hidden = shown === null || !offersSignIn(shown);
    restartButton.hidden =
      shown === null || !offersRestart(shown) || !restartConfirm.hidden;
    restartButton.disabled = busy !== null;
    renderDevices(copy, shown?.devices ?? []);
    renderSsh(copy);
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
      case "code": {
        stopTick();
        // A computer pairs only by the short code: without one, the dialog
        // says so instead of asking for it.
        const shape = pairingShape(way, view.manualCode);
        qrFrame.hidden = !shape.qr;
        qr.src = view.qrSource;
        code.textContent = view.manualCode ?? "";
        codeRow.hidden = !shape.code;
        codeCopy.hidden = !shape.code;
        dialogHint.hidden = shape.unavailable;
        dialogStatus.textContent = shape.unavailable ? copy.computerNoCode : "";
        showCountdown();
        tick = setInterval(showCountdown, 1_000);
        break;
      }
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
        dialogStatus.textContent =
          view.until !== null
            ? copy.phoneOutstanding.replace(
                "{time}",
                new Intl.DateTimeFormat(options.locale(), {
                  timeStyle: "short",
                }).format(new Date(view.until)),
              )
            : view.tooMany
              ? copy.phoneTooMany
              : copy.phoneFailed;
        if (view.overview !== null) overview = view.overview;
        break;
    }
    render();
    if (view.kind === "paired") ok.focus();
  }

  /** The dialog's words for the way that opened it: a phone scans the QR
   * code (or types the short code), a computer types the short code. */
  function drawWay() {
    const copy = options.copy();
    const phone = way === "phone";
    dialog.dataset.way = way;
    dialogTitle.textContent = phone ? copy.phonePair : copy.computerPair;
    dialogHint.textContent = phone ? copy.phoneHint : copy.computerHint;
    dialogPaired.textContent = phone ? copy.phonePaired : copy.computerPaired;
    dialogHint.hidden = false;
    codeRow.hidden = false;
    qrFrame.hidden = !phone;
  }

  function open(opened: Way) {
    way = opened;
    drawWay();
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

  for (const form of ["phone", "computer"] as const) {
    const { card, pair, how } = ways[form];
    pair.addEventListener("click", () => {
      note = null;
      open(form);
    });
    how.addEventListener("click", () => {
      showHow[form] = card.dataset.folded !== undefined;
      render();
    });
  }
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
