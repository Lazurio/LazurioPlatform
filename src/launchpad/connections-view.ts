import type {
  ConnectionsOverview,
  ConnectionsState,
  PairedDevice,
  PairingPoll,
  PairingStarted,
  RemoteControlReason,
} from "../connections/pairing";
import type { MessageKey } from "./messages";
import { qrImageSource } from "./tools-view";

// Settings → Connections → Telefon přes ChatGPT (decision F71): the answers
// of `/api/connections*` in their exact shapes and the words the page shows
// for them. Pure, so the page's logic is tested without a browser.

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

/** Whether the card sends the person to sign in to ChatGPT. */
export const offersSignIn = (overview: ConnectionsOverview): boolean =>
  overview.state === "no-chatgpt" || overview.state === "organization-ai";

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
