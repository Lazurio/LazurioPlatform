import type { ConnectionsOverview, PairedDevice } from "../connections/pairing";
import { createPairingFlow, type PairingView } from "./connections-flow";
import {
  appCard,
  deviceDetail,
  deviceForm,
  deviceName,
  type MotionStep,
  motionSteps,
  offersRestart,
  offersSignIn,
  offersSsh,
  offersSshWay,
  type PairApp,
  type PairDevice,
  type PairMethod,
  pairApps,
  pairingFoot,
  pairingShape,
  parseConnectionsOverview,
  pathDetail,
  remaining,
  type SshPath,
  sshPaths,
} from "./connections-view";
import type { MachineView } from "./machine-view";
import type { MessageKey } from "./messages";
import { pollWhileVisible } from "./visible-poll";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;
type Step = "device" | "code" | "ssh";

const appNames: Readonly<Record<PairApp, MessageKey>> = {
  chatgpt: "appChatgpt",
  claude: "appClaude",
  t3code: "appT3code",
};

// Settings → Connections (decision F71 and its addendum of 2026-11-11, root
// decision 0215 as amended that day): built by app. Ovládat toto Prostředí
// has one card per app with one sentence on whether it pairs here and
// Spárovat. Spárovat opens the pairing: the device first, then the code,
// with the motion graphic drawn from one template for the app, device and
// way; the one live code is connections-flow.ts's (a QR code for the phone
// app, the short code for ChatGPT Desktop, the time left, a new code once
// it expired, "spárovaný"). Only for a computer, an app that speaks SSH and
// where the handover records a peer that may open SSH into this
// Environment, the quiet "Jiný způsob: SSH" shows the paths in and leads to
// F49's page. The paired devices are one list with the app's mark; below,
// the Environments this one reaches. Every server value is drawn as text;
// the page drops the code when the dialog closes.
export function createConnectionsPanel(
  options: Readonly<{
    get: (path: string) => Answer;
    post: (path: string, body: unknown) => Answer;
    copy: () => Copy;
    locale: () => string;
    /** The recorded preset and Machine binding, null until the profile is
     * read: a computer is offered on an Environment on a server, not on the
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
  const restartConfirm = find<HTMLDivElement>("#phone-restart-confirm");
  const restartYes = find<HTMLButtonElement>("#phone-restart-yes");
  const restartCancel = find<HTMLButtonElement>("#phone-restart-cancel");
  const apps = find<HTMLDivElement>("#connections-apps");
  const devicesGroup = find<HTMLElement>("#phone-devices-group");
  const devicesList = find<HTMLUListElement>("#phone-devices");
  const outGroup = find<HTMLElement>("#ssh-paths");
  const outList = find<HTMLUListElement>("#ssh-paths-out-list");
  const again = find<HTMLButtonElement>("#connections-refresh");
  const dialog = find<HTMLDialogElement>("#phone-dialog");
  const dialogTitle = find<HTMLHeadingElement>("#phone-dialog-title");
  const dialogClose = find<HTMLButtonElement>("#phone-dialog-close");
  const stepDevice = find<HTMLDivElement>("#pair-step-device");
  const where = find<HTMLParagraphElement>("#pair-where");
  const pickPhone = find<HTMLButtonElement>("#pair-phone");
  const pickComputer = find<HTMLButtonElement>("#pair-computer");
  const pairing = find<HTMLDivElement>("#phone-dialog-pairing");
  const motion = find<HTMLDivElement>("#pair-motion");
  const dialogHint = find<HTMLParagraphElement>("#phone-dialog-hint");
  const qrFrame = find<HTMLDivElement>(".phone-qr-frame");
  const qr = find<HTMLImageElement>("#phone-qr");
  const code = find<HTMLElement>("#phone-code");
  const codeRow = find<HTMLDivElement>("#phone-code-row");
  const codeCopy = find<HTMLButtonElement>("#phone-code-copy");
  const countdown = find<HTMLParagraphElement>("#phone-countdown");
  const otherSsh = find<HTMLButtonElement>("#pair-other-ssh");
  const stepSsh = find<HTMLDivElement>("#pair-step-ssh");
  const sshMotion = find<HTMLDivElement>("#pair-ssh-motion");
  const inList = find<HTMLUListElement>("#ssh-paths-in-list");
  const backToCode = find<HTMLButtonElement>("#pair-back-code");
  const done = find<HTMLDivElement>("#phone-dialog-done");
  const dialogPaired = find<HTMLParagraphElement>("#phone-dialog-paired");
  const dialogStatus = find<HTMLParagraphElement>("#phone-dialog-status");
  const back = find<HTMLButtonElement>("#pair-back");
  const newCode = find<HTMLButtonElement>("#phone-new");
  const ok = find<HTMLButtonElement>("#phone-dialog-ok");

  let overview: ConnectionsOverview | null = null;
  let loading = false;
  let busy: "restart" | null = null;
  let note: MessageKey | null = null;
  let confirming: string | null = null;
  let removing: string | null = null;
  let reading = 0;
  // The pairing open now: its app, its device and the step shown.
  let app: PairApp = "chatgpt";
  let device: PairDevice = "phone";
  let step: Step = "device";
  // The code's attempt, apart from the step shown: whether it ended
  // (expired or refused), so Nový kód comes back on the code's step.
  let ended = false;
  // Opened for SSH alone: no code and no device to go back to.
  let sshOnly = false;
  // The countdown of the code shown.
  let tick: ReturnType<typeof setInterval> | null = null;
  const flow = createPairingFlow({
    post: options.post,
    poll: (stepper, ms) => pollWhileVisible(stepper, ms),
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
  /** One of the page's own symbols. */
  const symbol = (name: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  };
  /** A row's icon. */
  const icon = (name: string) => {
    const box = element("span", "connections-row-icon");
    box.setAttribute("aria-hidden", "true");
    box.append(symbol(name));
    return box;
  };
  /** An app's mark: its logo where the page has one, else its letters. */
  const appMark = (which: PairApp, className = "app-mark") => {
    const mark = element("span", className);
    mark.setAttribute("aria-hidden", "true");
    if (which === "chatgpt") mark.append(symbol("openai"));
    else if (which === "claude") mark.append(symbol("claude"));
    else mark.textContent = "T3";
    return mark;
  };
  const environmentHere = () => options.environment();
  const onServer = () => {
    const here = environmentHere();
    return here !== null && here.preset !== "local";
  };
  const sshHere = () => {
    const here = environmentHere();
    return here !== null && offersSsh(here.preset, sshPaths(here.machine));
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
    if (read !== null) overview = read;
    render();
  }

  /** The motion graphic's one template: the device's frame, the app's
   * screen and the steps of this app, device and way in turn. */
  function drawMotion(
    target: HTMLElement,
    copy: Copy,
    steps: readonly MotionStep[] | null,
  ) {
    target.hidden = steps === null;
    if (steps === null) {
      target.replaceChildren();
      delete target.dataset.drawn;
      return;
    }
    // Drawn again only for another combination, so a render of the page
    // never restarts the steps.
    const drawn = [
      app,
      device,
      steps.map((each) => copy[each.text]).join("|"),
    ].join("/");
    if (target.dataset.drawn === drawn) return;
    target.dataset.drawn = drawn;
    const frame = element("div", "phone-motion-device");
    frame.dataset.device = device;
    frame.dataset.app = app;
    const head = element("div", "phone-motion-head");
    head.append(appMark(app, "phone-motion-app"), copy[appNames[app]]);
    const screen = element("div", "phone-motion-screen");
    frame.append(head, screen);
    steps.forEach((each, index) => {
      const shown = element("div", "phone-motion-step");
      shown.dataset.step = String(index + 1);
      const mark = element(
        "span",
        each.mark === "scan"
          ? "phone-motion-icon phone-motion-scan"
          : each.mark === "letters"
            ? "phone-motion-icon phone-motion-codex"
            : "phone-motion-icon",
      );
      if (each.mark === "app") mark.append(appMark(app, "phone-motion-logo"));
      else if (each.mark === "icon" && each.icon)
        mark.append(symbol(each.icon));
      else if (each.mark === "letters") mark.textContent = each.letters ?? "";
      shown.append(
        mark,
        element("span", "phone-motion-label", copy[each.text]),
      );
      screen.append(shown);
    });
    const dots = element("ol", "phone-motion-dots");
    for (const _ of steps) dots.append(element("li"));
    target.replaceChildren(frame, dots);
  }

  function renderApps(copy: Copy) {
    apps.replaceChildren(
      ...pairApps.map((which) => {
        const card = appCard(which, overview, loading, {
          ssh: sshHere(),
          computer: onServer(),
        });
        const node = element("div", "card app-card");
        node.dataset.app = which;
        node.dataset.available = String(card.available);
        const head = element("div", "app-card-head");
        head.append(appMark(which), element("h3", "", copy[appNames[which]]));
        const actions = element("div", "phone-actions");
        // Where no code pairs but SSH comes in, the card leads straight to
        // that way (0215 keeps SSH where pairing is not possible).
        const viaSsh = !card.available && card.sshOnly;
        const pair = button(
          viaSsh ? copy.appSsh : copy.appPair,
          card.available ? "primary" : "",
          () => {
            note = null;
            if (viaSsh) openSsh(which);
            else open(which);
          },
        );
        pair.disabled = (!card.available && !viaSsh) || busy !== null;
        actions.append(pair);
        if (which === "chatgpt" && overview !== null) {
          if (offersSignIn(overview)) {
            const link = element("a", "button", copy.phoneSignIn);
            link.setAttribute("href", "/settings/start");
            link.dataset.route = "";
            actions.append(link);
          }
          if (offersRestart(overview) && restartConfirm.hidden) {
            const restart = button(copy.phoneRestart, "", () => {
              restartConfirm.hidden = false;
              render();
              restartCancel.focus();
            });
            restart.disabled = busy !== null;
            actions.append(restart);
          }
        }
        node.append(head, element("p", "row-desc", copy[card.line]), actions);
        return node;
      }),
    );
  }

  function renderDevices(copy: Copy, devices: readonly PairedDevice[]) {
    devicesGroup.hidden = devices.length === 0;
    const format = new Intl.DateTimeFormat(options.locale(), {
      dateStyle: "medium",
      timeStyle: "short",
    });
    devicesList.replaceChildren(
      ...devices.map((paired) => {
        const item = element("li");
        const form = deviceForm(paired);
        item.dataset.form = form;
        item.append(icon(form === "phone" ? "phone" : "laptop"));
        const main = element("div", "row-copy");
        const title = element("p", "row-title", deviceName(paired));
        // Every device paired here is the ChatGPT app's (Codex's remote
        // control); its mark says so, as a later app's will.
        const badge = element("span", "app-badge");
        badge.append(symbol("openai"), copy.appChatgpt);
        title.append(" ", badge);
        main.append(title);
        const details = [
          deviceDetail(paired),
          paired.lastSeenAt === null
            ? ""
            : copy.phoneLastSeen.replace(
                "{time}",
                format.format(new Date(paired.lastSeenAt)),
              ),
        ].filter((part) => part !== "");
        if (details.length > 0)
          main.append(element("p", "row-desc", details.join(" · ")));
        const actions = element("div", "phone-device-actions");
        if (confirming === paired.clientId) {
          actions.append(
            element(
              "span",
              "row-status",
              (form === "phone"
                ? copy.phoneRemoveQuestion
                : copy.computerRemoveQuestion
              ).replace("{name}", deviceName(paired)),
            ),
            button(copy.phoneCancel, "", () => {
              confirming = null;
              render();
            }),
            button(copy.phoneRemoveYes, "primary", () => {
              void revoke(paired.clientId);
            }),
          );
        } else {
          const remove = button(copy.phoneRemove, "", () => {
            confirming = paired.clientId;
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

  /** Odsud se připojíte do: the Environments and devices this one reaches,
   * as the handover records them; the paths in belong to the pairing's
   * "Jiný způsob: SSH". */
  function renderPaths(copy: Copy) {
    const here = environmentHere();
    const paths =
      here === null || here.preset === "local" ? null : sshPaths(here.machine);
    const outbound = paths?.outbound ?? [];
    outGroup.hidden = outbound.length === 0;
    outList.replaceChildren(...outbound.map((path) => pathRow(path, copy)));
    inList.replaceChildren(
      ...(paths?.inbound ?? []).map((path) => pathRow(path, copy)),
    );
  }

  function render() {
    const copy = options.copy();
    qr.alt = copy.phoneQrAlt;
    again.disabled = loading;
    const message: string | null =
      busy === "restart"
        ? copy.phoneRestarting
        : note !== null
          ? copy[note]
          : null;
    state.textContent = message ?? "";
    state.hidden = message === null;
    state.dataset.kind =
      note === "phoneRemoved" && busy === null ? "info" : "warning";
    renderApps(copy);
    renderDevices(copy, overview?.state === "ready" ? overview.devices : []);
    renderPaths(copy);
    drawStep();
  }

  /** The dialog's step: the device, the code, or the SSH way. */
  function drawStep() {
    const copy = options.copy();
    const name = copy[appNames[app]];
    dialog.dataset.app = app;
    dialog.dataset.way = device;
    dialog.dataset.step = step;
    dialogTitle.textContent = (
      sshOnly ? copy.pairSshTitle : copy.pairTitle
    ).replace("{app}", name);
    where.textContent = copy.pairWhere.replace("{app}", name);
    pickComputer.hidden = !onServer();
    stepDevice.hidden = step !== "device";
    pairing.hidden = step !== "code" || !done.hidden;
    stepSsh.hidden = step !== "ssh";
    back.hidden =
      !onServer() ||
      !pairingFoot({ step, ended, paired: !done.hidden, sshOnly }).back;
    backToCode.hidden = sshOnly;
    otherSsh.hidden = !offersSshWay(app, device, sshHere());
    const foot = pairingFoot({ step, ended, paired: !done.hidden, sshOnly });
    newCode.hidden = !foot.newCode;
    dialogStatus.hidden = !foot.status;
    // Nothing has happened while the device is being chosen: leave, not done.
    ok.textContent = step === "device" ? copy.phoneCancel : copy.phoneDone;
    ok.classList.toggle("primary", step !== "device");
    if (step === "code") {
      const phone = device === "phone";
      dialogHint.textContent = phone ? copy.phoneHint : copy.computerHint;
      dialogPaired.textContent = phone ? copy.phonePaired : copy.computerPaired;
      drawMotion(motion, copy, motionSteps(app, device, "code"));
    }
    if (step === "ssh")
      drawMotion(sshMotion, copy, motionSteps(app, device, "ssh"));
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
        ended = false;
        done.hidden = true;
        delete qrFrame.dataset.expired;
        dialogStatus.textContent = copy.phoneLoading;
        break;
      case "code": {
        stopTick();
        ended = false;
        // A computer pairs only by the short code: without one, the dialog
        // says so instead of asking for it.
        const shape = pairingShape(device, view.manualCode);
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
        // An expired code is no QR code to scan; a new code brings it back.
        qrFrame.hidden = true;
        code.textContent = "";
        countdown.textContent = copy.phoneExpired;
        ended = true;
        break;
      case "paired":
        clearCode();
        ended = false;
        done.hidden = false;
        dialogStatus.textContent = "";
        if (overview !== null)
          overview = Object.freeze({ ...overview, devices: view.devices });
        break;
      case "refused":
        // The step shown stays: a refusal that arrives while the SSH way is
        // open waits on the code's step for Nový kód.
        clearCode();
        ended = true;
        qrFrame.hidden = true;
        codeRow.hidden = true;
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

  /** Spárovat: the device first; on your own computer only a phone pairs,
   * so the pairing starts at the code. */
  function open(which: PairApp) {
    app = which;
    sshOnly = false;
    ended = false;
    step = "device";
    done.hidden = true;
    dialogStatus.textContent = "";
    if (!dialog.open && typeof dialog.showModal === "function")
      dialog.showModal();
    if (onServer()) render();
    else choose("phone");
  }

  /** An app that pairs no code here but reaches it over SSH from a
   * computer: the SSH way alone. */
  function openSsh(which: PairApp) {
    app = which;
    sshOnly = true;
    ended = false;
    device = "computer";
    step = "ssh";
    done.hidden = true;
    dialogStatus.textContent = "";
    if (!dialog.open && typeof dialog.showModal === "function")
      dialog.showModal();
    render();
  }

  /** A device chosen: the code, the default way, from the one live code. */
  function choose(chosen: PairDevice) {
    device = chosen;
    step = "code";
    qrFrame.hidden = chosen !== "phone";
    codeRow.hidden = false;
    dialogHint.hidden = false;
    render();
    void flow.start();
  }

  function way(method: PairMethod) {
    step = method;
    render();
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

  pickPhone.addEventListener("click", () => choose("phone"));
  pickComputer.addEventListener("click", () => choose("computer"));
  otherSsh.addEventListener("click", () => way("ssh"));
  backToCode.addEventListener("click", () => way("code"));
  back.addEventListener("click", () => {
    flow.close();
    clearCode();
    step = "device";
    ended = false;
    dialogStatus.textContent = "";
    render();
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
    step = "device";
    sshOnly = false;
    ended = false;
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
    /** For Začínáme: whether pairing is offered, and how many devices. */
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
