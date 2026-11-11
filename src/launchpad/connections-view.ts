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

/** What the pairing dialog shows of the one live code for the way that
 * opened it: a phone gets the QR code and, where Codex gave one, the short
 * code; a computer only the short code, so without it the computer cannot
 * pair from this code and the dialog says so instead of asking for it. */
export function pairingShape(
  way: "phone" | "computer",
  manualCode: string | null,
): Readonly<{ qr: boolean; code: boolean; unavailable: boolean }> {
  const code = manualCode !== null;
  return way === "phone"
    ? { qr: true, code, unavailable: false }
    : { qr: false, code, unavailable: !code };
}

/** Whether a paired device is a phone (or a tablet) or a computer. Codex
 * names the form in a free string and only "phone" has been seen (F71), so
 * a phone is that, a mobile form or a phone platform, and anything else,
 * an unknown form included, is a computer. */
export function deviceForm(device: PairedDevice): "phone" | "computer" {
  const type = device.deviceType?.toLowerCase() ?? "";
  const platform = device.platform?.toLowerCase() ?? "";
  return /phone|mobile|tablet/.test(type) ||
    /^(android|ios|ipados)$/.test(platform)
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
