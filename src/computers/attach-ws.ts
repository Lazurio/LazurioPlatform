import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { type BrokerTransport, runBroker, socketAnswers } from "./broker";
import { rawEd25519, registryEntry } from "./registry";
import {
  appendAudit,
  clearUpdating,
  computerIdPattern,
  isUpdating,
  markUpdating,
  socketPath,
  updatingMs,
  writeTools,
} from "./state";

// The computer's session over HTTPS (contract v1 section 2, decision F75's
// addendum of 2026-11-13): `GET /.lazurio/computers/attach` with a
// WebSocket upgrade, the one route the Environment's gateway passes without
// a browser session. The computer proves who it is here, not the gateway:
//
// 1. the server sends `{type: "challenge", v: 1, environment, nonce, ts}`;
// 2. the computer answers `{type: "auth", v: 1, device, signature}`, its
//    ed25519 signature of `lazurio-computer-attach-v1\n<environment>\n
//    <nonce>\n<ts>` with the key the pairing recorded;
// 3. the server checks the signature against the registry, the challenge's
//    age (60 s), that the nonce is used once, that the computer is still
//    paired and that it has no other session; then `{type: "ready"}`, or
//    `{type: "denied", reason}` and the connection closes;
// 4. after `ready` each text message is one JSON-RPC message, and the same
//    broker as ever serves it (`./broker`).
//
// The connection stays alive with a WebSocket ping every 15 s and ends after
// 45 s without an answer. Attempts are limited per address (the gateway's
// `X-Forwarded-For` when it comes from loopback) and in all.

export const attachPath = "/.lazurio/computers/attach";
export const attachSignatureLabel = "lazurio-computer-attach-v1";

export type AttachHost = Readonly<{
  home: string;
  uid: number | undefined;
  /** This Environment's id, the challenge's `environment`. */
  environmentId: () => string;
  version: string;
  /** Contract v3 (Agent Desktop, variant B of HumanAndMachine-ai/Machines#936):
   * the Environment's gateway proved the computer and its person before the
   * upgrade and passed a proof of the session with it. This checks that
   * proof server to server, never by a forwarded header (decision F16), and
   * answers whose session it is, or why not. When it is set, a session is
   * admitted only by it: no challenge, no registry. When it is not, the
   * session follows contract v1 as before. */
  verifyGatewayProof?: (request: Request) => Promise<GatewayProof>;
  now?: () => number;
  journal?: (entry: Readonly<Record<string, string>>) => void;
  /** Test seams. */
  pingMs?: number;
  silentMs?: number;
  authMs?: number;
  checkMs?: number;
  attemptsPerMinute?: number;
  attemptsInAllPerMinute?: number;
}>;

export type AttachData = {
  computerAttach: true;
  address: string;
  queryDevice: string | null;
  environment: string;
  nonce: string;
  ts: number;
  state: "challenge" | "checking" | "ready" | "closed";
  /** The contract the session follows: 1 (the computer's signature) or 3
   * (the gateway's proof). */
  contract: 1 | 3;
  /** Contract v3: the identity the gateway's proof named. */
  identity: AttachIdentity | null;
  device: string | null;
  listeners: ((message: string) => void)[];
  closeReason: string | null;
  resolveClosed: ((reason: string) => void) | null;
  lastHeard: number;
  timers: ReturnType<typeof setInterval>[];
};

type AttachSocket = ServerWebSocket<AttachData>;

/** Who a session belongs to once proved: the computer's id, its name as the
 * person sees it, and whether it may still be served (asked while the
 * session lasts; `false` ends it). */
export type AttachIdentity = Readonly<{
  device: string;
  name: string;
  stillAllowed: () => Promise<boolean>;
}>;

/** The answer to a gateway's proof of a computer's session (contract v3):
 * its identity, or the reason it is refused before the upgrade. */
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

/** The bytes a computer signs for one challenge. */
export function attachMessage(
  environment: string,
  nonce: string,
  ts: number,
): Buffer {
  return Buffer.from(
    `${attachSignatureLabel}\n${environment}\n${nonce}\n${ts}`,
    "utf8",
  );
}

/** Whether `signature` (base64url) is the ed25519 signature of `message` by
 * `publicKey` (`ssh-ed25519 <base64>`). */
export function verifyAttach(
  publicKey: string,
  message: Buffer,
  signature: unknown,
): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature))
    return false;
  const raw = rawEd25519(publicKey);
  if (raw === null) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    return verify(null, message, key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function createComputerAttach(host: AttachHost) {
  const now = host.now ?? Date.now;
  const pingMs = host.pingMs ?? 15_000;
  const silentMs = host.silentMs ?? 45_000;
  const authMs = host.authMs ?? 10_000;
  const perAddress = host.attemptsPerMinute ?? 6;
  const inAll = host.attemptsInAllPerMinute ?? 60;
  const journal = (entry: Record<string, string>) =>
    host.journal?.({ scope: "computers", ...entry });
  // The computers with a session in this process.
  const active = new Set<string>();
  // Nonces already answered, until their challenge expires.
  const usedNonces = new Map<string, number>();
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

  const deny = (ws: AttachSocket, reason: string) => {
    journal({
      operation: "attach",
      outcome: "denied",
      reason,
      ...(ws.data.device === null ? {} : { device: ws.data.device }),
    });
    send(
      ws,
      ws.data.contract === 3
        ? { type: "denied", v: 3, reason }
        : { type: "denied", reason },
    );
    ws.data.state = "closed";
    try {
      ws.close(1008, reason);
    } catch {}
  };

  const end = (ws: AttachSocket, reason: string) => {
    if (ws.data.closeReason === null) ws.data.closeReason = reason;
    for (const timer of ws.data.timers) clearInterval(timer);
    ws.data.timers = [];
    ws.data.resolveClosed?.(ws.data.closeReason);
    ws.data.resolveClosed = null;
  };

  async function authenticate(ws: AttachSocket, text: string) {
    ws.data.state = "checking";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      deny(ws, "invalid-message");
      return;
    }
    // Every JSON value parses, `null` too: only an object is a message
    // (review of #943, where `null` ended the Launchpad).
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      deny(ws, "invalid-message");
      return;
    }
    const message = parsed as Record<string, unknown>;
    const device = message.device;
    if (
      message.type !== "auth" ||
      message.v !== 1 ||
      typeof device !== "string" ||
      !computerIdPattern.test(device)
    ) {
      deny(ws, "invalid-message");
      return;
    }
    ws.data.device = device;
    if (ws.data.queryDevice !== null && ws.data.queryDevice !== device) {
      deny(ws, "device-mismatch");
      return;
    }
    if (now() - ws.data.ts > 60_000) {
      deny(ws, "challenge-expired");
      return;
    }
    if (usedNonces.has(ws.data.nonce)) {
      deny(ws, "nonce-used");
      return;
    }
    usedNonces.set(ws.data.nonce, ws.data.ts + 60_000);
    for (const [nonce, until] of usedNonces)
      if (until < now()) usedNonces.delete(nonce);
    const entry = await registryEntry(host.home, host.uid, device);
    if (entry === null) {
      deny(ws, "not-paired");
      return;
    }
    if (
      !verifyAttach(
        entry.publicKey,
        attachMessage(ws.data.environment, ws.data.nonce, ws.data.ts),
        message.signature,
      )
    ) {
      deny(ws, "bad-signature");
      return;
    }
    await startSession(ws, {
      device,
      name: entry.name,
      // The session belongs to the key it proved: a computer removed and
      // paired again under the same id with another key ends it (review
      // of #943).
      stillAllowed: async () =>
        (await registryEntry(host.home, host.uid, device))?.fingerprint ===
        entry.fingerprint,
    });
  }

  /** Starts the session of a computer whose identity is proved: refuses a
   * second session of the same device, answers `ready` and hands the
   * connection to the broker. How the identity was proved is the caller's:
   * the computer's signature against the registry (contract v1) or the
   * gateway's proof (contract v3). */
  async function startSession(ws: AttachSocket, identity: AttachIdentity) {
    const { device } = identity;
    ws.data.device = device;
    if (
      active.has(device) ||
      (await socketAnswers(socketPath(host.home, device), 500))
    ) {
      deny(ws, "already-attached");
      return;
    }
    if (ws.data.state !== "checking") return; // closed meanwhile
    active.add(device);
    ws.data.state = "ready";
    journal({ operation: "attach", outcome: "ready", device });
    const closed = new Promise<string>((resolve) => {
      ws.data.resolveClosed = resolve;
    });
    const transport: BrokerTransport = {
      send: (line) => {
        try {
          ws.send(line);
        } catch {}
      },
      onMessage: (listener) => {
        ws.data.listeners.push(listener);
      },
      closed,
      close: (reason) => {
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
    send(
      ws,
      ws.data.contract === 3 ? { type: "ready", v: 3 } : { type: "ready" },
    );
    void runBroker({
      home: host.home,
      uid: host.uid,
      device,
      name: identity.name,
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
      stillAllowed: identity.stillAllowed,
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

  /** A new attempt's state. */
  const sessionData = (
    address: string,
    queryDevice: string | null,
  ): AttachData => ({
    computerAttach: true,
    address,
    queryDevice,
    environment: host.environmentId(),
    nonce: randomBytes(32).toString("base64url"),
    ts: now(),
    state: "challenge",
    contract: 1,
    identity: null,
    device: null,
    listeners: [],
    closeReason: null,
    resolveClosed: null,
    lastHeard: now(),
    timers: [],
  });

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
      const url = new URL(request.url);
      const names = [...url.searchParams.keys()];
      const queryDevice = url.searchParams.get("device");
      if (
        names.some((name) => name !== "device") ||
        names.length > 1 ||
        (queryDevice !== null && !computerIdPattern.test(queryDevice)) ||
        // Contract v3 names the computer by the gateway's proof only.
        (host.verifyGatewayProof !== undefined && names.length > 0)
      )
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
      const verifyGatewayProof = host.verifyGatewayProof;
      if (verifyGatewayProof !== undefined)
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
            ...sessionData(address, null),
            contract: 3,
            identity: proof.identity,
            state: "checking",
          };
          return server.upgrade(request, { data })
            ? undefined
            : new Response(null, { status: 400, headers });
        })();
      const data: AttachData = sessionData(address, queryDevice);
      return server.upgrade(request, { data })
        ? undefined
        : new Response(null, { status: 400, headers });
    },

    websocket: {
      open(ws: AttachSocket) {
        const ping = setInterval(() => {
          if (now() - ws.data.lastHeard > silentMs) {
            ws.data.closeReason = "computer-silent";
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
        ws.data.timers.push(ping);
        if (ws.data.contract === 3) {
          const identity = ws.data.identity;
          if (identity === null) {
            deny(ws, "internal-error");
            return;
          }
          startSession(ws, identity).catch(() => {
            if (ws.data.state === "checking") deny(ws, "internal-error");
          });
          return;
        }
        send(ws, {
          type: "challenge",
          v: 1,
          environment: ws.data.environment,
          nonce: ws.data.nonce,
          ts: ws.data.ts,
        });
        const auth = setTimeout(() => {
          if (ws.data.state === "challenge") deny(ws, "auth-timeout");
        }, authMs);
        ws.data.timers.push(auth as unknown as ReturnType<typeof setInterval>);
      },
      message(ws: AttachSocket, message: string | Buffer) {
        ws.data.lastHeard = now();
        if (typeof message !== "string") return;
        if (ws.data.state === "challenge") {
          // Nothing an unauthenticated attempt causes may reach the process:
          // a failure denies the attempt (review of #943).
          authenticate(ws, message).catch(() => {
            if (ws.data.state === "challenge" || ws.data.state === "checking")
              deny(ws, "internal-error");
          });
          return;
        }
        if (ws.data.state !== "ready") return;
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
