import { randomBytes } from "node:crypto";
import type { AiReading } from "../tools/ai";
import { qrMatrix, qrSvg } from "../tools/qr";
import type { CodexAppServerRestart } from "../update/codex-app-server";
import { type ControlRpc, ControlSocketError } from "./control-socket";

// Settings → Connections → Telefon přes ChatGPT (decision F71, root decision
// 0215): the person pairs the ChatGPT app on their phone with this
// Environment's Codex through the remote control of the Codex app-server
// daemon (F29). Nobody types a command.
//
// The code (`pairingCode`, `manualPairingCode`), the QR payload and the
// session handle exist only in this process's memory, under one pending
// pairing; they are answered to the admitted page that asked for them and
// never written to a log, the journal, a file or an error. The journal names
// only what happened (`pair-started`, `paired`, `expired`, `shown-again`,
// `revoked`, …) and a device's platform.
//
// Codex (0.166) cannot end a code it gave: the codes live at ChatGPT until
// a phone takes them or they expire, and the protocol has no method that
// withdraws one. So Lazurio never has two live codes: while the code pending
// is valid, every Spárovat telefon answers that same code again, closing the
// dialog ends nothing, and a new code is asked for only once the old one has
// expired or a phone took it. Starts are serialized: requests that arrive
// while one start runs share its answer, so the one live code and the limit
// of `maxStarts` in `startWindowMs` hold under concurrency.
//
// Exposure is about codes that left Lazurio: only a code shown to a page can
// be scanned or typed by a phone. A code Codex made whose answer never
// reached Lazurio (a timeout, a closed socket, an answer that does not parse)
// was seen by nobody, and nobody can present it.
//
// The ledger (`ConnectionsHost.ledger`, a file under the person's state
// directory) carries the rule across a restart of the Launchpad, without any
// code: the times of the starts and until when a code that was shown may be
// valid (`outstandingUntil`). A code reaches a page only after the ledger
// holds its end; when that write fails, or the process stops before it, the
// code is never shown. The start is written before Codex is asked, so the
// limit counts it. A process that holds no code (after a restart) makes none
// while `outstandingUntil` lies ahead: it answers `code-outstanding` with the
// time a new code can be made. A ledger that cannot be read counts as a code
// shown now with the longest life Lazurio accepts.
//
// Every change of this state and every ledger write runs in one queue
// (`exclusive`): a start, a poll that settles a code and a restart's reading
// never interleave, so an older write never replaces a newer one.

/** What the Connections page can offer here:
 * - `ready`: pairing works (remote control is connected, or off and turned
 *   on by the first pairing);
 * - `no-remote-control`: the daemon's remote control is not usable now
 *   (`reason`);
 * - `organization-ai`: Codex runs on AI the Organization provides, without
 *   the person's own ChatGPT sign-in;
 * - `no-chatgpt`: Codex is not signed in with a ChatGPT account;
 * - `team`: a Team Environment has no pairing. */
export type ConnectionsState =
  | "ready"
  | "no-remote-control"
  | "organization-ai"
  | "no-chatgpt"
  | "team";

/** Why remote control is not usable: no daemon or socket, a Codex without
 * the methods, still connecting, or failed. */
export type RemoteControlReason =
  | "no-daemon"
  | "unsupported"
  | "connecting"
  | "errored";

export type PairedDevice = Readonly<{
  clientId: string;
  name: string | null;
  deviceType: string | null;
  platform: string | null;
  model: string | null;
  appVersion: string | null;
  /** Milliseconds since the epoch. */
  lastSeenAt: number | null;
}>;

export type ConnectionsOverview = Readonly<{
  kind: "connections";
  state: ConnectionsState;
  reason?: RemoteControlReason;
  /** The name the ChatGPT app shows for this Environment's Codex. */
  serverName?: string;
  devices: readonly PairedDevice[];
  /** Whether the page may offer a restart of Codex (Lazurio's own unit). */
  restart: boolean;
}>;

export type PairingStarted = Readonly<{
  kind: "pairing";
  session: string;
  manualCode: string | null;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  qrSvg: string;
}>;

export type PairingPoll =
  | Readonly<{ kind: "waiting"; expiresAt: number }>
  | Readonly<{ kind: "paired"; devices: readonly PairedDevice[] }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "gone" }>;

export type ConnectionsRefusal =
  | "team"
  | "organization-ai"
  | "no-chatgpt"
  | "no-remote-control"
  | "too-many-starts"
  | "code-outstanding"
  | "storage-failed"
  | "unknown-device"
  | "restart-not-needed"
  | "restart-not-managed"
  | "restart-failed";

export type Blocked = Readonly<{
  kind: "blocked";
  reason: ConnectionsRefusal;
  /** `code-outstanding`: when a new code can be made (ms since the epoch). */
  until?: number;
  overview?: ConnectionsOverview;
}>;

/** What survives a restart of the Launchpad: never a code. */
export type PairingLedger = Readonly<{
  version: 1;
  /** Starts in the window, ms since the epoch. */
  starts: readonly number[];
  /** Until when a code Lazurio made may be valid at ChatGPT; null: none. */
  outstandingUntil: number | null;
}>;

/** The ledger's store: `read` answers null when there is none yet and
 * throws when it cannot be read; `write` replaces it whole. */
export type PairingLedgerStore = Readonly<{
  read: () => Promise<unknown>;
  write: (ledger: PairingLedger) => Promise<void>;
}>;

export type ConnectionsHost = Readonly<{
  /** The Environment's kind as its page names it; `team` refuses. */
  kind: () => Promise<string | null>;
  /** The Environment's AI (Codex's sign-in). */
  ai: () => Promise<AiReading>;
  /** A new conversation with the daemon's control socket. */
  connect: () => Promise<ControlRpc>;
  /** Whether Codex's daemon runs under Lazurio's own unit. */
  restartable: () => Promise<boolean>;
  /** The one restart, after the person confirmed it. */
  restart: () => Promise<CodexAppServerRestart>;
  /** Trust of the Folder and the home for chats started from the phone
   * (#720); never a reason to refuse pairing. */
  trust: () => Promise<unknown>;
  /** The ledger across restarts; without one, it lives in this process. */
  ledger?: PairingLedgerStore;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}>;

/** What the ChatGPT app's own scanner (Codex → add a computer) accepts,
 * verified with a phone on 2026-11-03 (Android, ChatGPT 1.2026.293). */
export const pairingQrPayload = (pairingCode: string) =>
  `https://chatgpt.com/codex/pair?pairing_code=${encodeURIComponent(pairingCode)}`;

/** A pairing's life when Codex names none we can trust. */
const defaultLifeMs = 10 * 60_000;
/** The longest life of a code Codex names that Lazurio shows (Codex 0.166
 * gives about 10 minutes); a ledger that cannot be read counts as a code
 * shown now with this life. A code named longer is not shown. */
export const longestLifeMs = 60 * 60_000;
/** At most this many new codes in `startWindowMs`. */
export const maxStarts = 5;
export const startWindowMs = 10 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A bounded one-line label from Codex, or null. */
function label(value: unknown, limit = 80): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
  return clean === "" ? null : clean.slice(0, limit);
}

const clientIdPattern = /^[A-Za-z0-9._:-]{1,200}$/;
export const isClientId = (value: unknown): value is string =>
  typeof value === "string" && clientIdPattern.test(value);
const sessionPattern = /^[0-9a-f]{32}$/;
export const isSession = (value: unknown): value is string =>
  typeof value === "string" && sessionPattern.test(value);

/** Codex's time, seconds or milliseconds, as milliseconds. */
const millis = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value > 1e11
      ? value
      : value * 1000
    : null;

export function parseDevices(result: unknown): readonly PairedDevice[] {
  if (!isRecord(result) || !Array.isArray(result.data)) return [];
  const devices: PairedDevice[] = [];
  for (const entry of result.data.slice(0, 50)) {
    if (!isRecord(entry) || !isClientId(entry.clientId)) continue;
    devices.push(
      Object.freeze({
        clientId: entry.clientId,
        name: label(entry.displayName),
        deviceType: label(entry.deviceType, 40),
        platform: label(entry.platform, 40),
        model: label(entry.deviceModel),
        appVersion: label(entry.appVersion, 40),
        lastSeenAt: millis(entry.lastSeenAt),
      }),
    );
  }
  return Object.freeze(devices);
}

type Status = Readonly<{
  status: "disabled" | "connecting" | "connected" | "errored";
  serverName: string | null;
  environmentId: string | null;
}>;

function parseStatus(result: unknown): Status | null {
  if (!isRecord(result)) return null;
  const status = result.status;
  if (
    status !== "disabled" &&
    status !== "connecting" &&
    status !== "connected" &&
    status !== "errored"
  )
    return null;
  return {
    status,
    serverName: label(result.serverName),
    environmentId:
      typeof result.environmentId === "string" &&
      clientIdPattern.test(result.environmentId)
        ? result.environmentId
        : null,
  };
}

type Pending = {
  session: string;
  code: string;
  manualCode: string | null;
  expiresAt: number;
  known: ReadonlySet<string>;
};

export function createConnections(
  host: ConnectionsHost,
  options: Readonly<{
    journal?: (entry: Readonly<Record<string, string>>) => void;
  }> = {},
) {
  const now = host.now ?? Date.now;
  const wait =
    host.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const journal = (entry: Record<string, string>) =>
    options.journal?.({ scope: "connections", ...entry });
  let pending: Pending | null = null;
  let starts: number[] = [];
  let outstandingUntil: number | null = null;
  let loaded: Promise<void> | null = null;
  const store = host.ledger;
  // The start that runs now; a request meanwhile shares its answer.
  let starting: Promise<PairingStarted | Blocked> | null = null;
  // The one queue of every change of the pairing state and its ledger.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  }

  async function withSocket<T>(use: (rpc: ControlRpc) => Promise<T>) {
    const rpc = await host.connect();
    try {
      return await use(rpc);
    } finally {
      rpc.close();
    }
  }

  const ledgerTime = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;

  /** The ledger once per process; unreadable counts as a code live now. */
  function load(): Promise<void> {
    loaded ??= (async () => {
      if (store === undefined) return;
      let value: unknown;
      try {
        value = await store.read();
      } catch {
        outstandingUntil = now() + longestLifeMs;
        journal({ operation: "ledger", outcome: "unreadable" });
        return;
      }
      if (value === null) return;
      if (
        !isRecord(value) ||
        value.version !== 1 ||
        !Array.isArray(value.starts) ||
        !value.starts.every(ledgerTime) ||
        !(value.outstandingUntil === null || ledgerTime(value.outstandingUntil))
      ) {
        outstandingUntil = now() + longestLifeMs;
        journal({ operation: "ledger", outcome: "unreadable" });
        return;
      }
      starts = (value.starts as number[])
        .slice(-maxStarts)
        .sort((a, b) => a - b);
      outstandingUntil = value.outstandingUntil as number | null;
    })();
    return loaded;
  }

  /** Writes the ledger; false when it could not be written. */
  async function save(): Promise<boolean> {
    if (store === undefined) return true;
    try {
      await store.write(
        Object.freeze({
          version: 1,
          starts: [...starts],
          outstandingUntil,
        }),
      );
      return true;
    } catch {
      journal({ operation: "ledger", outcome: "write-failed" });
      return false;
    }
  }

  /** The code Lazurio held is over. Only a phone taking it ends the
   * ledger's bound early; at the handle's own end the bound stays until it
   * runs out (it is longer where Codex named no end). */
  async function settle(taken: boolean) {
    pending = null;
    if (taken || (outstandingUntil !== null && now() >= outstandingUntil))
      outstandingUntil = null;
    await save();
  }

  const readStatus = async (rpc: ControlRpc) =>
    parseStatus(await rpc.call("remoteControl/status/read"));

  const listDevices = async (rpc: ControlRpc, environmentId: string | null) =>
    environmentId === null
      ? []
      : parseDevices(
          await rpc.call("remoteControl/client/list", {
            environmentId,
            limit: 50,
            order: "desc",
          }),
        );

  /** Who may pair here at all, before Codex is asked. */
  async function gate(): Promise<
    "team" | "organization-ai" | "no-chatgpt" | null
  > {
    if ((await host.kind().catch(() => null)) === "team") return "team";
    const reading = await host
      .ai()
      .catch((): AiReading => ({ state: "unknown", providers: [] }));
    const codex = reading.providers.find((entry) => entry.provider === "codex");
    if (codex?.state === "provided") return "organization-ai";
    if (
      codex?.state === "signed-out" ||
      (codex?.state === "signed-in" && codex.method === "api-key")
    )
      return "no-chatgpt";
    return null;
  }

  const unusable = (
    reason: RemoteControlReason,
    restart: boolean,
    serverName?: string | null,
  ): ConnectionsOverview =>
    Object.freeze({
      kind: "connections",
      state: "no-remote-control",
      reason,
      ...(serverName ? { serverName } : {}),
      devices: [],
      restart,
    });

  const failureReason = (error: unknown): RemoteControlReason =>
    error instanceof ControlSocketError
      ? error.reason === "no-socket" || error.reason === "no-answer"
        ? "no-daemon"
        : "unsupported"
      : "no-daemon";

  async function overview(): Promise<ConnectionsOverview> {
    const blocked = await gate();
    if (blocked !== null)
      return Object.freeze({
        kind: "connections",
        state: blocked,
        devices: [],
        restart: false,
      });
    const restart = await host.restartable().catch(() => false);
    try {
      return await withSocket(async (rpc) => {
        const status = await readStatus(rpc);
        if (status === null) return unusable("unsupported", restart);
        if (status.status === "connecting" || status.status === "errored")
          return unusable(status.status, restart, status.serverName);
        const devices =
          status.status === "connected"
            ? await listDevices(rpc, status.environmentId).catch(() => [])
            : [];
        return Object.freeze({
          kind: "connections",
          state: "ready",
          ...(status.serverName ? { serverName: status.serverName } : {}),
          devices,
          restart,
        });
      });
    } catch (error) {
      return unusable(failureReason(error), restart);
    }
  }

  /** Remote control connected, turned on (persisted) when it was off;
   * waits a few seconds for the connection. */
  async function connected(rpc: ControlRpc): Promise<Status | null> {
    let status = await readStatus(rpc);
    if (status === null) return null;
    if (status.status === "disabled") {
      await rpc.call("remoteControl/enable", {});
      journal({ operation: "remote-control-enabled", outcome: "requested" });
    }
    for (let turn = 0; turn < 16 && status?.status !== "connected"; turn++) {
      await wait(500);
      status = await readStatus(rpc);
    }
    return status;
  }

  const shown = (current: Pending): PairingStarted =>
    Object.freeze({
      kind: "pairing",
      session: current.session,
      manualCode: current.manualCode,
      expiresAt: current.expiresAt,
      qrSvg: qrSvg(qrMatrix(pairingQrPayload(current.code))),
    });

  /** Whether a phone has taken the code; null when Codex did not answer. */
  async function claimed(current: Pending): Promise<boolean | null> {
    try {
      return await withSocket(async (rpc) => {
        const answer = await rpc.call("remoteControl/pairing/status", {
          pairingCode: current.code,
        });
        return isRecord(answer) && answer.claimed === true;
      });
    } catch {
      return null;
    }
  }

  /** Spárovat telefon: the code still valid, or a new one. One at a time. */
  function start(): Promise<PairingStarted | Blocked> {
    if (starting === null)
      starting = exclusive(begin).finally(() => {
        starting = null;
      });
    return starting;
  }

  async function begin(): Promise<PairingStarted | Blocked> {
    const blocked = await gate();
    if (blocked !== null) return { kind: "blocked", reason: blocked };
    await load();
    const at = now();
    const current = pending;
    if (current !== null && at < current.expiresAt) {
      // Still valid at ChatGPT: shown again, unless a phone took it.
      if ((await claimed(current)) !== true) {
        journal({ operation: "pair", outcome: "shown-again" });
        return shown(current);
      }
      journal({ operation: "pair", outcome: "paired" });
      await settle(true);
    } else if (current !== null) {
      journal({ operation: "pair", outcome: "expired" });
      await settle(false);
    }
    // A code Lazurio no longer holds (made before a restart, or its answer
    // lost) may still be valid: no second one until it has run out.
    if (outstandingUntil !== null && at < outstandingUntil)
      return {
        kind: "blocked",
        reason: "code-outstanding",
        until: outstandingUntil,
      };
    outstandingUntil = null;
    while (starts.length > 0 && at - (starts[0] as number) > startWindowMs)
      starts.shift();
    if (starts.length >= maxStarts)
      return { kind: "blocked", reason: "too-many-starts" };
    await host.trust().catch(() => undefined);
    let answer: Readonly<{ result: unknown; known: ReadonlySet<string> }>;
    try {
      const reached = await withSocket(async (rpc) => {
        const status = await connected(rpc);
        if (status?.status !== "connected") return null;
        const known = new Set(
          (await listDevices(rpc, status.environmentId).catch(() => [])).map(
            (device) => device.clientId,
          ),
        );
        // The start counts before Codex is asked, across restarts.
        starts.push(at);
        if (!(await save())) {
          starts.pop();
          return "storage-failed" as const;
        }
        return {
          result: await rpc.call("remoteControl/pairing/start", {
            manualCode: true,
          }),
          known,
        };
      });
      if (reached === "storage-failed")
        return { kind: "blocked", reason: "storage-failed" };
      if (reached === null)
        return {
          kind: "blocked",
          reason: "no-remote-control",
          overview: await overview(),
        };
      answer = reached;
    } catch {
      // Lost before or after Codex made a code: none reached a page.
      journal({ operation: "pair-started", outcome: "no-answer" });
      return {
        kind: "blocked",
        reason: "no-remote-control",
        overview: await overview(),
      };
    }
    const result = answer.result;
    if (
      !isRecord(result) ||
      typeof result.pairingCode !== "string" ||
      !/^[A-Za-z0-9_-]{8,512}$/.test(result.pairingCode)
    ) {
      journal({ operation: "pair-started", outcome: "invalid-answer" });
      return {
        kind: "blocked",
        reason: "no-remote-control",
        overview: await overview(),
      };
    }
    const manualCode =
      typeof result.manualPairingCode === "string" &&
      /^[A-Za-z0-9]{2,12}(?:-[A-Za-z0-9]{2,12}){0,3}$/.test(
        result.manualPairingCode,
      )
        ? result.manualPairingCode
        : null;
    const named = millis(result.expiresAt);
    if (named !== null && named - at > longestLifeMs) {
      // A life longer than Lazurio covers: the code is not shown.
      journal({ operation: "pair-started", outcome: "too-long" });
      return {
        kind: "blocked",
        reason: "no-remote-control",
        overview: await overview(),
      };
    }
    const expiresAt = named !== null && named > at ? named : at + defaultLifeMs;
    // The ledger holds the code's end before any page sees the code; a code
    // Codex names no end for is covered for the longest life.
    outstandingUntil = named !== null ? expiresAt : at + longestLifeMs;
    if (!(await save())) {
      outstandingUntil = null;
      journal({ operation: "pair-started", outcome: "not-shown" });
      return { kind: "blocked", reason: "storage-failed" };
    }
    pending = {
      session: randomBytes(16).toString("hex"),
      code: result.pairingCode,
      manualCode,
      expiresAt,
      known: answer.known,
    };
    journal({ operation: "pair-started", outcome: "ok" });
    return shown(pending);
  }

  /** The page's poll, in the queue: it may settle the code. */
  function poll(session: string): Promise<PairingPoll> {
    return exclusive(() => pollNow(session));
  }

  async function pollNow(session: string): Promise<PairingPoll> {
    const current = pending;
    if (current === null || current.session !== session)
      return { kind: "gone" };
    if (now() >= current.expiresAt) {
      journal({ operation: "pair", outcome: "expired" });
      await settle(false);
      return { kind: "expired" };
    }
    const taken = await claimed(current);
    // Taken through another start while Codex was asked.
    if (pending !== current) return { kind: "gone" };
    // Not answered now (null): the page asks again.
    if (taken !== true)
      return { kind: "waiting", expiresAt: current.expiresAt };
    await settle(true);
    let devices: readonly PairedDevice[] = [];
    try {
      devices = await withSocket(async (rpc) => {
        const status = await readStatus(rpc);
        return listDevices(rpc, status?.environmentId ?? null);
      });
    } catch {}
    const fresh = devices.find((device) => !current.known.has(device.clientId));
    journal({
      operation: "pair",
      outcome: "paired",
      ...(fresh?.platform ? { platform: fresh.platform } : {}),
    });
    return { kind: "paired", devices };
  }

  async function revoke(
    clientId: string,
  ): Promise<ConnectionsOverview | Blocked> {
    const blocked = await gate();
    if (blocked !== null) return { kind: "blocked", reason: blocked };
    let platform: string | null = null;
    const done = await withSocket(async (rpc) => {
      const status = await readStatus(rpc);
      if (status?.status !== "connected" || status.environmentId === null)
        return "no-remote-control" as const;
      const device = (await listDevices(rpc, status.environmentId)).find(
        (entry) => entry.clientId === clientId,
      );
      if (device === undefined) return "unknown-device" as const;
      platform = device.platform;
      await rpc.call("remoteControl/client/revoke", {
        environmentId: status.environmentId,
        clientId,
      });
      return "revoked" as const;
    }).catch(() => "no-remote-control" as const);
    if (done !== "revoked") {
      journal({ operation: "revoke", outcome: "refused", reason: done });
      return { kind: "blocked", reason: done, overview: await overview() };
    }
    journal({
      operation: "revoke",
      outcome: "revoked",
      ...(platform ? { platform } : {}),
    });
    return overview();
  }

  /** The restart the person confirmed: only where remote control is not
   * usable and Codex runs under Lazurio's unit. Running chats end. */
  async function restart(): Promise<ConnectionsOverview | Blocked> {
    const before = await overview();
    if (before.state !== "no-remote-control" || before.reason === "unsupported")
      return {
        kind: "blocked",
        reason: "restart-not-needed",
        overview: before,
      };
    if (!before.restart)
      return {
        kind: "blocked",
        reason: "restart-not-managed",
        overview: before,
      };
    // The code pending stays: a restart does not end it at ChatGPT.
    const result = await host
      .restart()
      .catch((): CodexAppServerRestart => ({ state: "failed" }));
    journal({ operation: "restart", outcome: result.state });
    if (result.state !== "restarted")
      return {
        kind: "blocked",
        reason:
          result.state === "not-managed"
            ? "restart-not-managed"
            : "restart-failed",
        overview: await overview(),
      };
    // The daemon starts again: its socket answers after a few seconds, and
    // remote control is a persisted preference of the daemon.
    for (let turn = 0; turn < 20; turn++) {
      await wait(1_000);
      try {
        const status = await withSocket((rpc) => connected(rpc));
        if (status?.status === "connected") break;
      } catch {}
    }
    return overview();
  }

  return Object.freeze({
    overview,
    start,
    poll,
    revoke,
    restart,
    /** Whether a pairing is pending (tests). */
    pending: () => pending !== null,
  });
}

export type Connections = ReturnType<typeof createConnections>;
