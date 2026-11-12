import type {
  ConnectionsOverview,
  ConnectionsState,
  PairedDevice,
  PairingPoll,
  PairingStarted,
  RemoteControlReason,
} from "../connections/pairing";
import type { MachinePeer, MachineView } from "./machine-view";
import type { MessageKey } from "./messages";
import { qrImageSource } from "./tools-view";

// Settings → Connections (decision F71 and its addendum of 2026-11-11): the
// answers of `/api/connections*` in their exact shapes, the SSH paths the
// handover records and the words the page shows for them. Pure, so the
// page's logic is tested without a browser.

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);

const states: readonly ConnectionsState[] = [
  "ready",
  "no-remote-control",
  "organization-ai",
  "no-chatgpt",
  "team",
];
const reasons: readonly RemoteControlReason[] = [
  "no-daemon",
  "unsupported",
  "connecting",
  "errored",
];

const text = (value: unknown, limit = 120): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, limit) : null;
const time = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

function parseDevice(value: unknown): PairedDevice | null {
  if (!isRecord(value) || typeof value.clientId !== "string") return null;
  return Object.freeze({
    clientId: value.clientId,
    name: text(value.name),
    deviceType: text(value.deviceType),
    platform: text(value.platform),
    model: text(value.model),
    appVersion: text(value.appVersion),
    lastSeenAt: time(value.lastSeenAt),
  });
}

function parseDevices(value: unknown): readonly PairedDevice[] | null {
  if (!Array.isArray(value)) return null;
  const devices: PairedDevice[] = [];
  for (const entry of value) {
    const device = parseDevice(entry);
    if (device === null) return null;
    devices.push(device);
  }
  return Object.freeze(devices);
}

/** `GET /api/connections`, or null when it is not that. */
export function parseConnectionsOverview(
  value: unknown,
): ConnectionsOverview | null {
  if (
    !isRecord(value) ||
    value.kind !== "connections" ||
    !states.includes(value.state as ConnectionsState) ||
    typeof value.restart !== "boolean"
  )
    return null;
  const devices = parseDevices(value.devices);
  if (devices === null) return null;
  const reason = reasons.includes(value.reason as RemoteControlReason)
    ? (value.reason as RemoteControlReason)
    : undefined;
  const serverName = text(value.serverName);
  return Object.freeze({
    kind: "connections",
    state: value.state as ConnectionsState,
    ...(reason === undefined ? {} : { reason }),
    ...(serverName === null ? {} : { serverName }),
    devices,
    restart: value.restart,
  });
}

/** `POST /api/connections/pair` that started, with a QR image the page can
 * show (the exact SVG form `qrSvg` draws), or null. */
export function parsePairing(
  value: unknown,
): (PairingStarted & { qrSource: string }) | null {
  if (
    !isRecord(value) ||
    value.kind !== "pairing" ||
    typeof value.session !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.session) ||
    time(value.expiresAt) === null ||
    typeof value.qrSvg !== "string"
  )
    return null;
  const qrSource = qrImageSource(value.qrSvg);
  if (qrSource === null) return null;
  const manualCode =
    typeof value.manualCode === "string" &&
    /^[A-Za-z0-9-]{2,64}$/.test(value.manualCode)
      ? value.manualCode
      : null;
  return {
    kind: "pairing",
    session: value.session,
    manualCode,
    expiresAt: value.expiresAt as number,
    qrSvg: value.qrSvg,
    qrSource,
  };
}

/** `POST /api/connections/pair/poll`, or null. */
export function parsePoll(value: unknown): PairingPoll | null {
  if (!isRecord(value)) return null;
  if (value.kind === "waiting" && time(value.expiresAt) !== null)
    return { kind: "waiting", expiresAt: value.expiresAt as number };
  if (value.kind === "paired") {
    const devices = parseDevices(value.devices);
    return devices === null ? null : { kind: "paired", devices };
  }
  if (value.kind === "expired" || value.kind === "gone")
    return { kind: value.kind };
  return null;
}

/** When a new code can be made, from a `code-outstanding` refusal. */
export const refusalUntil = (value: unknown): number | null =>
  isRecord(value) && value.kind === "blocked" ? time(value.until) : null;

/** The refusal's reason of a blocked answer, or null. */
export const refusalOf = (value: unknown): string | null =>
  isRecord(value) &&
  value.kind === "blocked" &&
  typeof value.reason === "string"
    ? value.reason
    : null;

/** Minutes and seconds left, `9:05`; `0:00` once past. */
export function remaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the card says instead of offering pairing, or null when it offers
 * it. */
export function stateMessage(overview: ConnectionsOverview): MessageKey | null {
  switch (overview.state) {
    case "ready":
      return null;
    case "no-chatgpt":
      return "phoneStateNoChatgpt";
    case "organization-ai":
      return "phoneStateOrganizationAi";
    case "team":
      return "phoneStateTeam";
    case "no-remote-control":
      return overview.reason === "unsupported"
        ? "phoneStateUnsupported"
        : "phoneStateUnavailable";
  }
}

/** Whether the card offers a restart of Codex. */
export const offersRestart = (overview: ConnectionsOverview): boolean =>
  overview.state === "no-remote-control" &&
  overview.reason !== "unsupported" &&
  overview.restart;

/** Whether the card sends the person to sign in to ChatGPT: only where
 * Codex has no sign-in. On the Organization's AI the phone's route is SSH
 * with a password, not ready yet: the card says so and offers nothing. */
export const offersSignIn = (overview: ConnectionsOverview): boolean =>
  overview.state === "no-chatgpt";

/** A device's name as the page shows it. */
export function deviceName(device: PairedDevice): string {
  return device.name ?? device.model ?? device.platform ?? device.clientId;
}

/** A device's second line: model, platform and the app's version. */
export function deviceDetail(device: PairedDevice): string {
  return [
    device.name !== null ? device.model : null,
    device.platform,
    device.appVersion === null ? null : `ChatGPT ${device.appVersion}`,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

/** A Device's operating system, as people are shown it (root decision 0240):
 * the system, not the form, decides what is possible and how. Ordinary text
 * keeps "computer" and "phone". */
export type DeviceOs = "mac" | "windows" | "linux" | "iphone" | "android";
export const deviceOses: readonly DeviceOs[] = [
  "mac",
  "windows",
  "linux",
  "iphone",
  "android",
];
/** A phone's system: its app scans a QR code, and nothing goes over SSH. */
export const isPhoneOs = (os: DeviceOs): boolean =>
  os === "iphone" || os === "android";
/** The form a system pairs as: a phone by the QR code, a computer by the
 * short code. */
export const formOf = (os: DeviceOs): "phone" | "computer" =>
  isPhoneOs(os) ? "phone" : "computer";
/** The systems offered here: your own computer pairs only a phone, since
 * the computer it would pair is itself. */
export const osesHere = (computer: boolean): readonly DeviceOs[] =>
  computer ? deviceOses : deviceOses.filter(isPhoneOs);

/** The apps a Device operates this Environment with (root decisions 0215
 * and 0240): ChatGPT, Claude, T3 Code and later VS Code; a new app is a new
 * card, never a new page. */
export type PairApp = "chatgpt" | "claude" | "t3code" | "vscode";
export const pairApps: readonly PairApp[] = [
  "chatgpt",
  "claude",
  "t3code",
  "vscode",
];
export type PairMethod = "code" | "ssh";

/** One app's card for a Device's system: whether it pairs here by a code,
 * whether it reaches this Environment over SSH where it does not, and its
 * one sentence. ChatGPT pairs through Codex's remote control (F71), from the
 * ChatGPT app on a phone and from ChatGPT Desktop on Mac and Windows;
 * Claude and VS Code are coming, and T3 Code until its pairing token may
 * reach a native app (Lazurio/LazurioPlatform#934). */
export type AppCard = Readonly<{
  app: PairApp;
  available: boolean;
  sshOnly: boolean;
  line: MessageKey;
}>;

export function appCard(
  app: PairApp,
  os: DeviceOs,
  overview: ConnectionsOverview | null,
  loading: boolean,
  ssh = false,
): AppCard {
  const sshOnly = offersSshWay(app, os, ssh);
  if (app === "claude" || app === "vscode")
    return { app, available: false, sshOnly: false, line: "appComing" };
  if (app === "t3code")
    return {
      app,
      available: false,
      sshOnly,
      line: sshOnly ? "appCodeComing" : "appComing",
    };
  // ChatGPT Desktop runs on Mac and Windows: on Linux nothing pairs by code.
  if (os === "linux")
    return { app, available: false, sshOnly: false, line: "appComing" };
  if (overview === null)
    return {
      app,
      available: false,
      sshOnly: false,
      line: loading ? "phoneLoading" : "phoneFailed",
    };
  const state = stateMessage(overview);
  if (state !== null) return { app, available: false, sshOnly, line: state };
  return {
    app,
    available: true,
    sshOnly: false,
    line: isPhoneOs(os) ? "appChatgptReadyPhone" : "appChatgptReady",
  };
}

/** Whether "Jiný způsob: SSH" is offered: only on Mac, Windows and Linux,
 * only for an app that speaks SSH there (ChatGPT Desktop on Mac and
 * Windows, F49; T3 Code), and only where SSH into this Environment is
 * allowed (`offersSsh`). */
export function offersSshWay(
  app: PairApp,
  os: DeviceOs,
  ssh: boolean,
): boolean {
  if (!ssh || isPhoneOs(os)) return false;
  if (app === "t3code") return true;
  return app === "chatgpt" && os !== "linux";
}

/** One step of the motion graphic's template: what its mark shows (the
 * app's logo, an icon of the page's own symbols, a few letters, a QR code)
 * and its caption. */
export type MotionStep = Readonly<{
  mark: "app" | "icon" | "letters" | "scan";
  icon?: string;
  letters?: string;
  text: MessageKey;
}>;

const done: MotionStep = {
  mark: "icon",
  icon: "check",
  text: "phoneMotionDone",
};

/** The steps of one combination of system, app and way, filled into the one
 * template (the system's frame, the app's screen, five steps in turn), so a
 * guide can draw the same pictures. Null where the combination has no way
 * yet. */
export function motionSteps(
  os: DeviceOs,
  app: PairApp,
  method: PairMethod,
): readonly MotionStep[] | null {
  if (app !== "chatgpt" || os === "linux") return null;
  if (method === "ssh")
    return isPhoneOs(os)
      ? null
      : [
          { mark: "icon", icon: "copy", text: "sshMotionCopy" },
          { mark: "app", text: "computerMotionOpen" },
          { mark: "icon", icon: "bot", text: "sshMotionPaste" },
          { mark: "icon", icon: "plus", text: "sshMotionAdd" },
          done,
        ];
  return isPhoneOs(os)
    ? [
        { mark: "app", text: "phoneMotionOpen" },
        { mark: "letters", letters: "</>", text: "phoneMotionCodex" },
        { mark: "icon", icon: "laptop", text: "phoneMotionAdd" },
        { mark: "scan", text: "phoneMotionScan" },
        done,
      ]
    : [
        { mark: "app", text: "computerMotionOpen" },
        { mark: "icon", icon: "settings", text: "computerMotionConnections" },
        { mark: "icon", icon: "laptop", text: "computerMotionControl" },
        { mark: "letters", letters: "K7QF", text: "computerMotionCode" },
        done,
      ];
}

/** The pairing dialog's foot and status from its state, kept apart from
 * the step shown: Nový kód only on the code's step once the code's attempt
 * ended (expired or refused), whatever step was open when it ended; the
 * code's status line only on that step; Zpět to the apps from the code or
 * the SSH way. */
export function pairingFoot(
  state: Readonly<{
    step: "app" | "code" | "ssh";
    ended: boolean;
    paired: boolean;
    sshOnly: boolean;
  }>,
): Readonly<{ newCode: boolean; status: boolean; back: boolean }> {
  return {
    newCode: state.step === "code" && state.ended && !state.paired,
    status: state.step === "code",
    back: state.step !== "app" && !state.paired,
  };
}

/** What the pairing dialog shows of the one live code for the system that
 * opened it: a phone gets the QR code and, where Codex gave one, the short
 * code; a computer only the short code, so without it the computer cannot
 * pair from this code and the dialog says so instead of asking for it. */
export function pairingShape(
  os: DeviceOs,
  manualCode: string | null,
): Readonly<{ qr: boolean; code: boolean; unavailable: boolean }> {
  const code = manualCode !== null;
  return isPhoneOs(os)
    ? { qr: true, code, unavailable: false }
    : { qr: false, code, unavailable: !code };
}

/** A paired device's system from what Codex reports, or null where it names
 * none we know: the list then shows the form's icon. */
export function deviceOs(device: PairedDevice): DeviceOs | null {
  const platform = device.platform?.toLowerCase() ?? "";
  if (/^android/.test(platform)) return "android";
  if (/^(ios|ipados|iphone)/.test(platform)) return "iphone";
  if (/^(macos|mac|darwin|osx)/.test(platform)) return "mac";
  if (/^(windows|win32|win)/.test(platform)) return "windows";
  if (/^linux/.test(platform)) return "linux";
  return null;
}

/** Whether a paired device is a phone (or a tablet) or a computer. Codex
 * names the form in a free string and only "phone" has been seen (F71), so
 * a phone is that, a mobile form or a phone platform, and anything else,
 * an unknown form included, is a computer. */
export function deviceForm(device: PairedDevice): "phone" | "computer" {
  const type = device.deviceType?.toLowerCase() ?? "";
  const os = deviceOs(device);
  return /phone|mobile|tablet/.test(type) || (os !== null && isPhoneOs(os))
    ? "phone"
    : "computer";
}

/** One SSH path between this Environment and a peer of its tailnet, as the
 * handover records it (F71's addendum of 2026-11-11): the peer's node name,
 * its kind and its Organization. */
export type SshPath = Readonly<{
  name: string;
  kind: MachinePeer["kind"];
  organization: string | null;
}>;

export type SshPaths = Readonly<{
  /** Peers that may open SSH into this Environment. */
  inbound: readonly SshPath[];
  /** Peers this Environment may open SSH into. */
  outbound: readonly SshPath[];
}>;

/** The SSH paths the handover records, each peer once per direction, in
 * the handover's order; null where the handover records no relationships,
 * so nothing is known and nothing is offered. Machines derives them from
 * the tailnet's grants (root decisions 0192 and 0224) and Headscale
 * enforces them; the page only reads them. */
export function sshPaths(
  machine: Pick<MachineView, "relationships"> | null,
): SshPaths | null {
  const peers = machine?.relationships?.peers;
  if (peers === undefined) return null;
  const inbound: SshPath[] = [];
  const outbound: SshPath[] = [];
  const seenIn = new Set<string>();
  const seenOut = new Set<string>();
  for (const peer of peers) {
    if (peer.ssh === null) continue;
    const path: SshPath = Object.freeze({
      name: peer.name,
      kind: peer.kind,
      organization: peer.organization,
    });
    const { direction } = peer.ssh;
    if (
      (direction === "inbound" || direction === "both") &&
      !seenIn.has(peer.name)
    ) {
      seenIn.add(peer.name);
      inbound.push(path);
    }
    if (
      (direction === "outbound" || direction === "both") &&
      !seenOut.has(peer.name)
    ) {
      seenOut.add(peer.name);
      outbound.push(path);
    }
  }
  return Object.freeze({
    inbound: Object.freeze(inbound),
    outbound: Object.freeze(outbound),
  });
}

/** Whether the page offers SSH into this Environment: on a server, and only
 * where the handover records a peer that may open SSH into it (root
 * decision 0215 as amended on 2026-11-11). Without that record SSH is not
 * offered, since the tailnet would refuse it. */
export const offersSsh = (preset: string, paths: SshPaths | null): boolean =>
  preset !== "local" && paths !== null && paths.inbound.length > 0;

const pathKinds: Readonly<Record<string, MessageKey>> = {
  "client-device": "pathDevice",
  "personal-vm": "pathPersonal",
  "workspace-vm": "pathWork",
  "conglomerate-host": "pathServer",
};

/** A path's second line: what the peer is and, for an Organization's
 * Environment, whose. A kind this release does not know shows as recorded. */
export function pathDetail(
  path: SshPath,
  copy: Readonly<Record<MessageKey, string>>,
): string {
  const kind = pathKinds[path.kind];
  return [kind === undefined ? path.kind : copy[kind], path.organization]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}
