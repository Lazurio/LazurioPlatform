import type { ServerWebSocket } from "bun";
import { type BrokerTransport, runBroker, socketAnswers } from "./broker";
import {
  appendAudit,
  clearUpdating,
  computerIdPattern,
  isComputerOs,
  isUpdating,
  markUpdating,
  readRecord,
  socketPath,
  updateRecord,
  updatingMs,
  writeTools,
} from "./state";

// The computer's session over HTTPS on contract v3 (Agent Desktop's channel,
// HumanAndMachine-ai/Auth docs/device-channel-entry.md, "The Launchpad"):
// `GET /.lazurio/computers/attach` with a WebSocket upgrade, the one route
// the Environment's gateway passes without a browser session. The gateway
// admits only an approved device of the Assigned User, its helper redeems
// the one-time hand-over at Lazurio Auth and passes a session proof with the
// upgrade; the Launchpad checks that proof itself (`verifyGatewayProof`,
// `./session-check`):
//
// 1. a query string is 400, no proof 401, a check that cannot be made 503,
//    a proof not confirmed 403, each before the upgrade;
// 2. after the upgrade the first message is `{type: "ready", v: 3}`, or
//    `{type: "denied", v: 3, reason: "already-attached"}` and the close;
// 3. after `ready` each text message is one JSON-RPC message, and the broker
//    serves it (`./broker`);
// 4. the session ends with `{type: "denied", v: 3, reason: "expired"}`
//    exactly at the deadline of its last confirmed check, and when a recheck
//    is anything but a confirmation of the same person and device. The
//    recheck runs from `ready` on, at half the time left to the deadline and
//    within 60 seconds at the latest.
//
// A computer's first attach creates its record (`./state`) and its MCP server
// in Executor; a later one duplicates nothing. Its removal (`lazurio computer
// remove`) deletes the record, and the broker's next check ends the open
// session. Without `verifyGatewayProof` the route answers 404: contract v1
// (the challenge, the computer's signature, the registry of its keys) is
// gone.
//
// The connection stays alive with a WebSocket ping every 15 s and ends after
// 45 s without an answer. Attempts are limited per address (the gateway's
// `X-Forwarded-For` when it comes from loopback) and in all.

export const attachPath = "/.lazurio/computers/attach";

/** The longest wait for the next recheck of a session's proof (the
 * contract's "at least every 60 seconds"). */
export const recheckMaxMs = 60_000;

export type AttachHost = Readonly<{
  home: string;
  uid: number | undefined;
  version: string;
  /** Contract v3: the Environment's gateway proved the computer and its
   * person before the upgrade and passed a proof of the session with it.
   * This checks that proof server to server, never by a forwarded header
   * (decision F16), and answers whose session it is, or why not. Without it
   * no session is admitted at all. */
  verifyGatewayProof?: (request: Request) => Promise<GatewayProof>;
  /** Executor at a computer's first attach: adds its MCP server (its slug,
   * or why not) and takes a server out again. Absent: none is added. */
  servers?: Readonly<{
    register: (
      input: Readonly<{ deviceId: string; name: string }>,
    ) => Promise<string | "executor-unavailable" | "executor-failed">;
    unregister: (slug: string) => Promise<boolean>;
  }>;
  now?: () => number;
  /** Runs `run` once `ms` have passed by `now`; the answer cancels it. */
  setTimer?: (run: () => void, ms: number) => () => void;
  journal?: (entry: Readonly<Record<string, string>>) => void;
  /** Test seams. */
  pingMs?: number;
  silentMs?: number;
  /** How often the broker asks whether the computer's record still
   * exists. */
  checkMs?: number;
  attemptsPerMinute?: number;
  attemptsInAllPerMinute?: number;
  /** Whether a broker already answers at a device's socket. */
  socketAnswers?: (path: string, timeoutMs: number) => Promise<boolean>;
}>;

export type AttachData = {
  computerAttach: true;
  address: string;
  state: "checking" | "ready" | "closed";
  /** The identity the gateway's proof named. */
  identity: AttachIdentity;
  device: string;
  listeners: ((message: string) => void)[];
  closeReason: string | null;
  resolveClosed: ((reason: string) => void) | null;
  lastHeard: number;
  /** Cancels every timer of the session. */
  cancels: (() => void)[];
};

type AttachSocket = ServerWebSocket<AttachData>;

/** Whose a session is once the gateway's proof is checked: the computer's
 * id, its name as the person sees it, until when the proof was last
 * confirmed (epoch ms) and whether it is still confirmed. */
export type AttachIdentity = Readonly<{
  device: string;
  name: string;
  /** The session's deadline: the last confirmation's, moved by each
   * confirmation. The session ends there even when no check has answered. */
  deadline: () => number;
  /** Checks the proof again; `false` ends the session. */
  stillAllowed: () => Promise<boolean>;
}>;

/** The answer to a gateway's proof of a computer's session: its identity,
 * or the reason it is refused before the upgrade. */
export type GatewayProof =
  | Readonly<{ ok: true; identity: AttachIdentity }>
  | Readonly<{ ok: false; status: 401 | 403; reason: string }>;

/** What the server can do with a request: the part of Bun's server this
 * needs. */
export type UpgradeServer = Readonly<{
  upgrade: (
    request: Request,
    options: { data: AttachData; headers?: HeadersInit },
  ) => boolean;
}>;

const upgradeConnection = /(^|,)\s*upgrade\s*(,|$)/i;
const loopback = (address: string | null) =>
  address === "127.0.0.1" ||
  address === "::1" ||
  address === "::ffff:127.0.0.1";

const realTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, Math.max(0, ms));
  return () => clearTimeout(timer);
};

export function createComputerAttach(host: AttachHost) {
  const now = host.now ?? Date.now;
  const setTimer = host.setTimer ?? realTimer;
  const pingMs = host.pingMs ?? 15_000;
  const silentMs = host.silentMs ?? 45_000;
  const perAddress = host.attemptsPerMinute ?? 6;
  const inAll = host.attemptsInAllPerMinute ?? 60;
  const journal = (entry: Record<string, string>) =>
    host.journal?.({ scope: "computers", ...entry });
  // The computers with a session in this process.
  const active = new Set<string>();
  // Executor's server being added, per computer, so that two attaches never
  // add two.
  const adding = new Map<string, Promise<void>>();
  // Attempts in the last minute, per address and in all.
  const attempts = new Map<string, number[]>();
  let allAttempts: number[] = [];

  const limited = (address: string): boolean => {
    const since = now() - 60_000;
    allAttempts = allAttempts.filter((at) => at > since);
    const mine = (attempts.get(address) ?? []).filter((at) => at > since);
    if (mine.length >= perAddress || allAttempts.length >= inAll) {
      attempts.set(address, mine);
      return true;
    }
    mine.push(now());
    allAttempts.push(now());
    attempts.set(address, mine);
    if (attempts.size > 1024)
      for (const [key, list] of attempts)
        if (list.every((at) => at <= since)) attempts.delete(key);
    return false;
  };

  const send = (ws: AttachSocket, message: unknown) => {
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  };

  const cancelTimers = (ws: AttachSocket) => {
    for (const cancel of ws.data.cancels.splice(0)) cancel();
  };

  const end = (ws: AttachSocket, reason: string) => {
    if (ws.data.closeReason === null) ws.data.closeReason = reason;
    cancelTimers(ws);
    ws.data.resolveClosed?.(ws.data.closeReason);
    ws.data.resolveClosed = null;
  };

  const deny = (ws: AttachSocket, reason: string) => {
    if (ws.data.state === "closed") return;
    journal({
      operation: "attach",
      outcome: "denied",
      reason,
      device: ws.data.device,
    });
    send(ws, { type: "denied", v: 3, reason });
    ws.data.state = "closed";
    if (ws.data.closeReason === null) ws.data.closeReason = reason;
    try {
      ws.close(1008, reason);
    } catch {}
  };

  /** The end of a session whose proof is no longer confirmed, or whose
   * deadline passed: `denied`/`expired`, and the same reason on the
   * close. */
  const expire = (ws: AttachSocket, why: string) => {
    if (ws.data.state !== "ready") return;
    deny(ws, "expired");
    end(ws, why);
  };

  /** The session's timers on contract v3, from `ready` on: the close at
   * exactly the deadline, and the recheck at half the time left (within
   * `recheckMaxMs`). Each confirmation moves both from the new deadline. */
  function watchDeadline(ws: AttachSocket, allowed: () => Promise<boolean>) {
    const { identity } = ws.data;
    let cancelClose: () => void = () => undefined;
    let cancelCheck: () => void = () => undefined;
    ws.data.cancels.push(
      () => cancelClose(),
      () => cancelCheck(),
    );
    const schedule = () => {
      cancelClose();
      cancelCheck();
      if (ws.data.state !== "ready") return;
      const left = identity.deadline() - now();
      cancelClose = setTimer(() => {
        if (now() >= identity.deadline()) expire(ws, "expired");
        else schedule();
      }, left);
      cancelCheck = setTimer(
        () => {
          void allowed().then(
            (still) => {
              if (ws.data.state !== "ready") return;
              if (still) schedule();
              else expire(ws, "expired");
            },
            () => expire(ws, "expired"),
          );
        },
        Math.min(Math.max(0, Math.floor(left / 2)), recheckMaxMs),
      );
    };
    schedule();
  }

  /** The record of a computer at its attach: created at the first one,
   * named by its device id; a record that exists stays as it is. */
  const ensureRecord = (device: string) =>
    updateRecord(
      host.home,
      host.uid,
      device,
      (current) =>
        current ?? { deviceId: device, name: device, os: null, executor: null },
    );

  /** Its MCP server in Executor, once: a server added while the computer
   * was removed is taken out again. */
  function ensureServer(device: string, name: string): Promise<void> {
    const servers = host.servers;
    if (servers === undefined) return Promise.resolve();
    const running = adding.get(device);
    if (running !== undefined) return running;
    const work = (async () => {
      const current = await readRecord(host.home, device);
      if (current === null || current.executor !== null) return;
      const slug = await servers.register({ deviceId: device, name });
      if (slug === "executor-unavailable" || slug === "executor-failed") {
        journal({ operation: "executor", outcome: slug, device });
        return;
      }
      let kept = false;
      await updateRecord(host.home, host.uid, device, (record) => {
        if (record === null || record.executor !== null) return undefined;
        kept = true;
        return { ...record, executor: slug };
      });
      if (!kept) await servers.unregister(slug).catch(() => false);
      journal({
        operation: "executor",
        outcome: kept ? "added" : "taken-out",
        device,
      });
    })()
      .catch(() => undefined)
      .finally(() => adding.delete(device));
    adding.set(device, work);
    return work;
  }

  /** Starts the session of a computer whose identity the gateway's proof
   * named: refuses a second session of the same device, creates its record
   * at the first attach, answers `ready` and hands the connection to the
   * broker. */
  async function startSession(ws: AttachSocket) {
    const { identity, device } = ws.data;
    // The device is reserved before anything is awaited, so two sessions
    // that open at once never both pass (review of #1036); every way out
    // before the broker starts releases it.
    if (active.has(device)) {
      deny(ws, "already-attached");
      return;
    }
    active.add(device);
    let record: Awaited<ReturnType<typeof ensureRecord>>["after"];
    try {
      const answers = await (host.socketAnswers ?? socketAnswers)(
        socketPath(host.home, device),
        500,
      );
      if (answers) {
        active.delete(device);
        deny(ws, "already-attached");
        return;
      }
      if (ws.data.state !== "checking") {
        active.delete(device); // closed meanwhile
        return;
      }
      record = (await ensureRecord(device)).after;
    } catch (error) {
      active.delete(device);
      throw error;
    }
    if (ws.data.state !== "checking" || record === null) {
      active.delete(device);
      if (ws.data.state === "checking") deny(ws, "internal-error");
      return;
    }
    // The proof may have run out while the start waited for the socket or
    // the record's lock: such a session is never ready (review of #1050).
    if (now() >= identity.deadline()) {
      active.delete(device);
      deny(ws, "expired");
      return;
    }
    ws.data.state = "ready";
    journal({ operation: "attach", outcome: "ready", device });
    // The session is served while its record exists: a removal ends it at
    // the broker's next check, and every recheck of the proof asks it too.
    const recorded = async () => (await readRecord(host.home, device)) !== null;
    watchDeadline(
      ws,
      async () => (await recorded()) && (await identity.stillAllowed()),
    );
    void ensureServer(device, record.name);
    const closed = new Promise<string>((resolve) => {
      ws.data.resolveClosed = resolve;
    });
    const transport: BrokerTransport = {
      send: (line) => {
        if (ws.data.state !== "ready") return;
        // Past the proof's deadline nothing reaches the computer, even before
        // the deadline's timer has run.
        if (now() >= identity.deadline()) {
          expire(ws, "expired");
          return;
        }
        try {
          ws.send(line);
        } catch {}
      },
      onMessage: (listener) => {
        ws.data.listeners.push(listener);
      },
      closed,
      close: (reason) => {
        // The broker's check found the record gone ("removed"): the computer
        // hears `denied`/`expired` as for any other end of its session.
        if (reason === "removed" && ws.data.state === "ready") {
          expire(ws, reason);
          return;
        }
        if (ws.data.state !== "closed") {
          ws.data.state = "closed";
          if (ws.data.closeReason === null) ws.data.closeReason = reason;
          try {
            ws.close(1000, reason.slice(0, 100));
          } catch {}
        }
        end(ws, reason);
      },
    };
    send(ws, { type: "ready", v: 3 });
    void runBroker({
      home: host.home,
      uid: host.uid,
      device,
      name: record.name,
      version: host.version,
      transport,
      stderr: () => undefined,
      audit: (line) =>
        appendAudit(host.home, host.uid, {
          ts: new Date(now()).toISOString(),
          device,
          ...line,
        }),
      saveTools: (tools) => writeTools(host.home, host.uid, device, tools),
      stillAllowed: recorded,
      // The system as the computer's `initialize` names it, into a record
      // that still exists; a removed one is never brought back.
      connected: async (app) => {
        const os = isComputerOs(app.system) ? app.system : null;
        if (os === null) return;
        await updateRecord(host.home, host.uid, device, (current) =>
          current === null || current.os === os
            ? undefined
            : { ...current, os },
        );
      },
      ...(host.checkMs === undefined ? {} : { checkMs: host.checkMs }),
      updating: {
        mark: () =>
          markUpdating(host.home, host.uid, device, now() + updatingMs),
        clear: () => clearUpdating(host.home, device),
        active: () => isUpdating(host.home, device),
      },
    })
      .catch(() => undefined)
      .finally(() => {
        active.delete(device);
        transport.close("broker-ended");
      });
  }

  return Object.freeze({
    handles: (path: string) => path === attachPath,

    /** Upgrades a request to the computer's session, or answers why not.
     * `peer` is the TCP peer's address; behind the gateway (loopback) the
     * client's address is the last entry of `X-Forwarded-For`. */
    upgrade(
      request: Request,
      server: UpgradeServer,
      peer: string | null,
    ): Response | undefined | Promise<Response | undefined> {
      const headers = { "Cache-Control": "no-store" };
      const verifyGatewayProof = host.verifyGatewayProof;
      // No session is admitted without the gateway's proof: contract v1 is
      // gone, so is everything it answered.
      if (verifyGatewayProof === undefined)
        return new Response(null, { status: 404, headers });
      if (request.method !== "GET")
        return new Response(null, {
          status: 405,
          headers: { ...headers, Allow: "GET" },
        });
      if (
        !upgradeConnection.test(request.headers.get("connection") ?? "") ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      )
        return new Response(null, { status: 426, headers });
      // Contract v3 names the computer by the gateway's proof only; the
      // `?device=` of contract v1 is refused.
      if (new URL(request.url).search !== "")
        return new Response(null, { status: 400, headers });
      const forwarded = request.headers
        .get("x-forwarded-for")
        ?.split(",")
        .at(-1)
        ?.trim();
      const address =
        loopback(peer) && forwarded ? forwarded : (peer ?? "unknown");
      if (limited(address)) {
        journal({ operation: "attach", outcome: "limited" });
        return new Response(null, {
          status: 429,
          headers: { ...headers, "Retry-After": "60" },
        });
      }
      return (async () => {
        let proof: GatewayProof;
        try {
          proof = await verifyGatewayProof(request);
        } catch {
          // The check could not be made: nothing is admitted, and the
          // computer may try again.
          journal({
            operation: "attach",
            outcome: "denied",
            reason: "proof-unavailable",
          });
          return new Response(null, { status: 503, headers });
        }
        if (!proof.ok) {
          journal({
            operation: "attach",
            outcome: "denied",
            reason: proof.reason,
          });
          return new Response(null, { status: proof.status, headers });
        }
        if (!computerIdPattern.test(proof.identity.device)) {
          journal({
            operation: "attach",
            outcome: "denied",
            reason: "invalid-device",
          });
          return new Response(null, { status: 403, headers });
        }
        const data: AttachData = {
          computerAttach: true,
          address,
          state: "checking",
          identity: proof.identity,
          device: proof.identity.device,
          listeners: [],
          closeReason: null,
          resolveClosed: null,
          lastHeard: now(),
          cancels: [],
        };
        return server.upgrade(request, { data })
          ? undefined
          : new Response(null, { status: 400, headers });
      })();
    },

    websocket: {
      open(ws: AttachSocket) {
        const ping = setInterval(() => {
          if (now() - ws.data.lastHeard > silentMs) {
            ws.data.closeReason = "computer-silent";
            ws.data.state = "closed";
            try {
              ws.close(1001, "computer-silent");
            } catch {}
            end(ws, "computer-silent");
            return;
          }
          try {
            ws.ping();
          } catch {}
        }, pingMs);
        ws.data.cancels.push(() => clearInterval(ping));
        startSession(ws).catch(() => {
          if (ws.data.state === "checking") deny(ws, "internal-error");
        });
      },
      message(ws: AttachSocket, message: string | Buffer) {
        ws.data.lastHeard = now();
        if (typeof message !== "string") return;
        if (ws.data.state !== "ready") return;
        // Past the proof's deadline nothing reaches the broker either.
        if (now() >= ws.data.identity.deadline()) {
          expire(ws, "expired");
          return;
        }
        for (const listener of ws.data.listeners) listener(message);
      },
      pong(ws: AttachSocket) {
        ws.data.lastHeard = now();
      },
      close(ws: AttachSocket) {
        if (ws.data.state !== "closed") ws.data.state = "closed";
        end(ws, ws.data.closeReason ?? "session-closed");
      },
    },
  });
}

export type ComputerAttach = ReturnType<typeof createComputerAttach>;
