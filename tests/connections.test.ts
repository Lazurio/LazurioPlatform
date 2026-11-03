import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexTrustedText,
  codexTrustMarker,
  convergeCodexTrust,
} from "../src/connections/codex-trust";
import {
  ControlSocketError,
  openControlSocket,
} from "../src/connections/control-socket";
import { fileLedger, pairingLedgerPath } from "../src/connections/ledger";
import {
  type ConnectionsHost,
  createConnections,
  maxStarts,
  type PairingLedger,
  type PairingLedgerStore,
  pairingQrPayload,
} from "../src/connections/pairing";
import { createConnectionsRoutes } from "../src/launchpad/connections-routes";
import type { AiReading } from "../src/tools/ai";
import { qrMatrix, qrSvg } from "../src/tools/qr";

// Settings → Connections → Telefon přes ChatGPT (decision F71) against a fake
// Codex daemon: a WebSocket on a Unix socket that answers the JSON-RPC
// methods of remote control as Codex 0.166.0 does. The codes it makes are
// fakes; no phone and no real Codex are involved.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

const code =
  "123456789012345678901234567890123456789012345678901234567890123456789012345678".slice(
    0,
    78,
  );
const manual = "ABCD-EFGH";

type Daemon = {
  status: "disabled" | "connecting" | "connected" | "errored";
  connectOnEnable: boolean;
  remoteControl: boolean;
  claimed: boolean;
  devices: Json[];
  calls: { method: string; params: unknown }[];
  errorMessages: boolean;
  loseAnswer: boolean;
  /** The life Codex names for a code, in seconds; null names none. */
  lifeSeconds: number | null;
};

/** A ledger in memory, as a file would keep it across a restart: writes
 * from the `failFrom`-th (1-based) fail, and `hold` makes the next write
 * wait until it is released. */
function memoryLedger(failFrom = Number.POSITIVE_INFINITY) {
  let kept: unknown = null;
  let count = 0;
  let held: Promise<void> | null = null;
  const writes: PairingLedger[] = [];
  const store: PairingLedgerStore = {
    read: async () => (kept === null ? null : structuredClone(kept)),
    write: async (ledger) => {
      count += 1;
      if (count >= failFrom) throw new Error("disk full");
      const waiting = held;
      held = null;
      if (waiting !== null) await waiting;
      writes.push(ledger);
      kept = structuredClone(ledger);
    },
  };
  return {
    store,
    writes,
    kept: () => kept as PairingLedger | null,
    set: (value: unknown) => {
      kept = value;
    },
    /** The next write waits; answers its release. */
    hold: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

async function fakeDaemon(parent: string) {
  const path = join(parent, "control.sock");
  const daemon: Daemon = {
    status: "connected",
    connectOnEnable: true,
    remoteControl: true,
    claimed: false,
    devices: [
      {
        clientId: "client-1",
        displayName: "Pixel",
        deviceType: "phone",
        platform: "android",
        deviceModel: "Pixel 10",
        appVersion: "1.2026.293",
        lastSeenAt: 1_762_000_000,
      },
    ],
    calls: [],
    errorMessages: false,
    loseAnswer: false,
    lifeSeconds: 600,
  };
  let pairings = 0;
  const server = Bun.serve({
    unix: path,
    fetch(request, s) {
      if (s.upgrade(request)) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data)) as {
          id?: number;
          method: string;
          params?: Json;
        };
        if (message.id === undefined) return;
        daemon.calls.push({ method: message.method, params: message.params });
        const reply = (result: unknown): void => {
          socket.send(JSON.stringify({ id: message.id, result }));
        };
        const fail = (codeNumber: number, text: string): void => {
          socket.send(
            JSON.stringify({
              id: message.id,
              error: { code: codeNumber, message: text },
            }),
          );
        };
        const status = () => ({
          status: daemon.status,
          serverName: "alex-work",
          installationId: "installation",
          environmentId: daemon.status === "connected" ? "env-1" : null,
        });
        if (message.method === "initialize") return reply({});
        if (
          !daemon.remoteControl &&
          message.method.startsWith("remoteControl/")
        )
          return fail(-32600, `unknown variant ${message.method}`);
        switch (message.method) {
          case "remoteControl/status/read":
            return reply(status());
          case "remoteControl/enable":
            if (daemon.connectOnEnable) daemon.status = "connected";
            else daemon.status = "connecting";
            return reply(status());
          case "remoteControl/pairing/start":
            pairings += 1;
            // The code is made, but its answer never arrives.
            if (daemon.loseAnswer) return socket.close();
            return reply({
              pairingCode: code,
              manualPairingCode: manual,
              environmentId: "env-1",
              ...(daemon.lifeSeconds === null
                ? {}
                : {
                    expiresAt:
                      Math.floor(Date.now() / 1000) + daemon.lifeSeconds,
                  }),
            });
          case "remoteControl/pairing/status":
            if (daemon.errorMessages)
              return fail(
                -32000,
                `pairing ${message.params?.pairingCode} failed`,
              );
            if (daemon.claimed && message.params?.pairingCode === code) {
              daemon.devices = [
                {
                  clientId: "client-2",
                  displayName: "iPhone",
                  platform: "ios",
                  lastSeenAt: Date.now(),
                },
                ...daemon.devices,
              ];
              daemon.claimed = false;
              return reply({ claimed: true });
            }
            return reply({ claimed: false });
          case "remoteControl/client/list":
            return reply({ data: daemon.devices, nextCursor: null });
          case "remoteControl/client/revoke":
            daemon.devices = daemon.devices.filter(
              (device) => device.clientId !== message.params?.clientId,
            );
            return reply({});
          default:
            return fail(-32601, "method not found");
        }
      },
    },
  });
  return {
    path,
    daemon,
    pairings: () => pairings,
    stop: () => server.stop(true),
  };
}

const signedIn: AiReading = {
  state: "connected",
  providers: [
    {
      provider: "codex",
      state: "signed-in",
      method: "chatgpt",
      account: "alex@example.com",
    },
  ],
};

async function setup(
  options: Partial<{
    kind: string | null;
    ai: AiReading;
    restartable: boolean;
    socket: string;
    ledger: PairingLedgerStore;
  }> = {},
) {
  const parent = await mkdtemp(join(tmpdir(), "connections-"));
  const fake = await fakeDaemon(parent);
  const journal: Json[] = [];
  let clock = Date.now();
  const restarts: number[] = [];
  const trusts: number[] = [];
  const host: ConnectionsHost = {
    kind: async () => (options.kind === undefined ? "personal" : options.kind),
    ai: async () => options.ai ?? signedIn,
    connect: () =>
      openControlSocket(options.socket ?? fake.path, { timeoutMs: 2_000 }),
    restartable: async () => options.restartable ?? true,
    restart: async () => {
      restarts.push(clock);
      fake.daemon.status = "connected";
      return { state: "restarted" };
    },
    trust: async () => {
      trusts.push(clock);
      return { kind: "unchanged" };
    },
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    now: () => clock,
    wait: async () => undefined,
  };
  const make = () =>
    createConnections(host, {
      journal: (entry) => journal.push({ ...entry }),
    });
  const connections = make();
  return {
    ...fake,
    connections,
    /** Another Launchpad process over the same daemon and ledger. */
    restarted: make,
    journal,
    restarts,
    trusts,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    async close() {
      fake.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** No code, QR payload or session anywhere in what was journaled. */
function expectNoSecrets(texts: unknown[], session?: string) {
  const all = JSON.stringify(texts);
  expect(all).not.toContain(code);
  expect(all).not.toContain(manual);
  expect(all).not.toContain("pairing_code");
  if (session !== undefined) expect(all).not.toContain(session);
}

test.skipIf(!posix)(
  "ready: the state and the paired devices, never a code",
  async () => {
    const s = await setup();
    try {
      const overview = await s.connections.overview();
      expect(overview).toEqual({
        kind: "connections",
        state: "ready",
        serverName: "alex-work",
        devices: [
          {
            clientId: "client-1",
            name: "Pixel",
            deviceType: "phone",
            platform: "android",
            model: "Pixel 10",
            appVersion: "1.2026.293",
            lastSeenAt: 1_762_000_000_000,
          },
        ],
        restart: true,
      });
      expect(s.pairings()).toBe(0);
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "who cannot pair: Team, Organization AI, no ChatGPT sign-in",
  async () => {
    for (const [options, state] of [
      [{ kind: "team" }, "team"],
      [
        {
          ai: {
            state: "organization",
            providers: [{ provider: "codex", state: "provided" }],
          },
        },
        "organization-ai",
      ],
      [
        {
          ai: {
            state: "missing",
            providers: [{ provider: "codex", state: "signed-out" }],
          },
        },
        "no-chatgpt",
      ],
      [
        {
          ai: {
            state: "connected",
            providers: [
              { provider: "codex", state: "signed-in", method: "api-key" },
            ],
          },
        },
        "no-chatgpt",
      ],
    ] as const) {
      const s = await setup(options as Parameters<typeof setup>[0]);
      try {
        expect(await s.connections.overview()).toEqual({
          kind: "connections",
          state,
          devices: [],
          restart: false,
        });
        expect(await s.connections.start()).toEqual({
          kind: "blocked",
          reason: state,
        });
        expect(s.pairings()).toBe(0);
      } finally {
        await s.close();
      }
    }
  },
);

test.skipIf(!posix)(
  "no daemon, an older Codex, remote control still connecting",
  async () => {
    const none = await setup({ socket: "/nonexistent/control.sock" });
    try {
      expect(await none.connections.overview()).toMatchObject({
        state: "no-remote-control",
        reason: "no-daemon",
      });
    } finally {
      await none.close();
    }
    const old = await setup();
    try {
      old.daemon.remoteControl = false;
      expect(await old.connections.overview()).toMatchObject({
        state: "no-remote-control",
        reason: "unsupported",
      });
      // A restart does not teach an older Codex the methods.
      expect(await old.connections.restart()).toMatchObject({
        kind: "blocked",
        reason: "restart-not-needed",
      });
    } finally {
      await old.close();
    }
    const slow = await setup();
    try {
      slow.daemon.status = "connecting";
      expect(await slow.connections.overview()).toMatchObject({
        state: "no-remote-control",
        reason: "connecting",
        restart: true,
      });
      expect(await slow.connections.start()).toMatchObject({
        kind: "blocked",
        reason: "no-remote-control",
      });
    } finally {
      await slow.close();
    }
  },
);

test.skipIf(!posix)(
  "a pairing: QR of the verified URL, the short code, waiting, paired",
  async () => {
    const s = await setup();
    try {
      const started = await s.connections.start();
      if (started.kind !== "pairing") throw new Error("not started");
      expect(started.manualCode).toBe(manual);
      expect(started.session).toMatch(/^[0-9a-f]{32}$/);
      expect(started.qrSvg).toBe(
        qrSvg(qrMatrix(`https://chatgpt.com/codex/pair?pairing_code=${code}`)),
      );
      expect(pairingQrPayload(code)).toBe(
        `https://chatgpt.com/codex/pair?pairing_code=${code}`,
      );
      expect(s.trusts.length).toBe(1);
      expect(
        s.daemon.calls.find(
          (call) => call.method === "remoteControl/pairing/start",
        )?.params,
      ).toEqual({ manualCode: true });
      expect(await s.connections.poll(started.session)).toEqual({
        kind: "waiting",
        expiresAt: started.expiresAt,
      });
      s.daemon.claimed = true;
      const paired = await s.connections.poll(started.session);
      expect(paired.kind).toBe("paired");
      if (paired.kind === "paired")
        expect(paired.devices.map((device) => device.clientId)).toEqual([
          "client-2",
          "client-1",
        ]);
      // The code is gone once taken.
      expect(await s.connections.poll(started.session)).toEqual({
        kind: "gone",
      });
      expect(
        s.journal.map((line) => `${line.operation}:${line.outcome}`),
      ).toEqual(["pair-started:ok", "pair:paired"]);
      expect(s.journal[1]).toMatchObject({
        scope: "connections",
        platform: "ios",
      });
      expectNoSecrets(
        [s.journal, await s.connections.overview()],
        started.session,
      );
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "remote control off: the first pairing turns it on, persisted",
  async () => {
    const s = await setup();
    try {
      s.daemon.status = "disabled";
      expect(await s.connections.overview()).toMatchObject({
        state: "ready",
        devices: [],
      });
      const started = await s.connections.start();
      expect(started.kind).toBe("pairing");
      expect(
        s.daemon.calls.find((call) => call.method === "remoteControl/enable")
          ?.params,
      ).toEqual({});
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "one live code: shown again until it expires or a phone takes it, and the start limit",
  async () => {
    const s = await setup();
    try {
      const first = await s.connections.start();
      const again = await s.connections.start();
      if (first.kind !== "pairing" || again.kind !== "pairing")
        throw new Error("not started");
      // Codex cannot end a code: the same one comes back, no second is made.
      expect(again).toEqual(first);
      expect(s.pairings()).toBe(1);
      expect(await s.connections.poll(first.session)).toMatchObject({
        kind: "waiting",
      });
      s.advance(11 * 60_000);
      expect(await s.connections.poll(first.session)).toEqual({
        kind: "expired",
      });
      expect(s.connections.pending()).toBe(false);
      const third = await s.connections.start();
      if (third.kind !== "pairing") throw new Error("not started");
      expect(third.session).not.toBe(first.session);
      expect(s.pairings()).toBe(2);
      // A code a phone took, seen at the next start, makes room for one more.
      s.daemon.claimed = true;
      const fourth = await s.connections.start();
      if (fourth.kind !== "pairing") throw new Error("not started");
      expect(fourth.session).not.toBe(third.session);
      expect(await s.connections.poll(third.session)).toEqual({ kind: "gone" });
      // Five codes in ten minutes, then a refusal until the window moves.
      while (s.pairings() < maxStarts + 1) {
        s.daemon.claimed = true;
        expect((await s.connections.start()).kind).toBe("pairing");
      }
      s.daemon.claimed = true;
      expect(await s.connections.start()).toEqual({
        kind: "blocked",
        reason: "too-many-starts",
      });
      s.advance(10 * 60_000 + 1);
      expect((await s.connections.start()).kind).toBe("pairing");
      expectNoSecrets([s.journal], third.session);
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "concurrent starts share one: one code at Codex, the limit holds",
  async () => {
    const s = await setup();
    const burst = () =>
      Promise.all(Array.from({ length: 8 }, () => s.connections.start()));
    try {
      const all = await burst();
      expect(s.pairings()).toBe(1);
      expect(
        new Set(
          all.map((answer) =>
            answer.kind === "pairing" ? answer.session : answer.kind,
          ),
        ).size,
      ).toBe(1);
      // Bursts after a phone took each code: one new code each.
      while (s.pairings() < maxStarts) {
        s.daemon.claimed = true;
        await burst();
      }
      expect(s.pairings()).toBe(maxStarts);
      s.daemon.claimed = true;
      const refused = await burst();
      expect(
        refused.every(
          (answer) =>
            answer.kind === "blocked" && answer.reason === "too-many-starts",
        ),
      ).toBe(true);
      expect(s.pairings()).toBe(maxStarts);
      expect(s.connections.pending()).toBe(false);
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "a restart of the Launchpad: the live code and the limit survive, no code is written",
  async () => {
    const ledger = memoryLedger();
    const s = await setup({ ledger: ledger.store });
    try {
      const first = await s.connections.start();
      if (first.kind !== "pairing") throw new Error("not started");
      // Written before Codex was asked, then with the code's own end.
      expect(ledger.writes.length).toBe(2);
      expect(ledger.writes.at(-1)?.outstandingUntil).toBe(first.expiresAt);
      expectNoSecrets([ledger.writes], first.session);
      // A new process holds no code, so it makes none while the old may live.
      const after = s.restarted();
      expect(await after.start()).toEqual({
        kind: "blocked",
        reason: "code-outstanding",
        until: first.expiresAt,
      });
      expect(s.pairings()).toBe(1);
      s.advance(first.expiresAt - Date.now() + 60_000);
      expect((await after.start()).kind).toBe("pairing");
      expect(s.pairings()).toBe(2);
      // The limit counts the starts the ledger kept, whichever process.
      const at = s.now();
      ledger.set({
        version: 1,
        starts: Array.from({ length: maxStarts }, () => at),
        outstandingUntil: null,
      });
      expect(await s.restarted().start()).toEqual({
        kind: "blocked",
        reason: "too-many-starts",
      });
      expect(s.pairings()).toBe(2);
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "an answer lost after Codex was asked: nothing was shown, the start counts",
  async () => {
    const ledger = memoryLedger();
    const s = await setup({ ledger: ledger.store });
    try {
      s.daemon.loseAnswer = true;
      expect(await s.connections.start()).toMatchObject({
        kind: "blocked",
        reason: "no-remote-control",
      });
      expect(s.pairings()).toBe(1);
      // Counted before Codex was asked; no code reached a page, none is live.
      expect(ledger.kept()).toEqual({
        version: 1,
        starts: [s.now()],
        outstandingUntil: null,
      });
      expect(s.journal.map((line) => line.outcome)).toContain("no-answer");
      s.daemon.loseAnswer = false;
      expect((await s.connections.start()).kind).toBe("pairing");
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "a code is shown only once the ledger holds its end, for every life Lazurio accepts",
  async () => {
    // An hour, the longest life shown: the write of its end fails.
    const failing = memoryLedger(2);
    const s = await setup({ ledger: failing.store });
    try {
      s.daemon.lifeSeconds = 60 * 60;
      expect(await s.connections.start()).toEqual({
        kind: "blocked",
        reason: "storage-failed",
      });
      expect(s.connections.pending()).toBe(false);
      expect(s.journal.map((line) => line.outcome)).toContain("not-shown");
    } finally {
      await s.close();
    }
    // The same hour written: a restart 16 minutes later makes no second code.
    const ledger = memoryLedger();
    const t = await setup({ ledger: ledger.store });
    try {
      t.daemon.lifeSeconds = 60 * 60;
      const first = await t.connections.start();
      if (first.kind !== "pairing") throw new Error("not started");
      expect(ledger.kept()?.outstandingUntil).toBe(first.expiresAt);
      t.advance(16 * 60_000);
      expect(await t.restarted().start()).toEqual({
        kind: "blocked",
        reason: "code-outstanding",
        until: first.expiresAt,
      });
      expect(t.pairings()).toBe(1);
      // A life longer than an hour is never shown.
      const u = t.restarted();
      t.advance(60 * 60_000);
      // Two hours from the test's clock (the fake names real time).
      t.daemon.lifeSeconds =
        Math.ceil((t.now() - Date.now()) / 1000) + 2 * 60 * 60;
      expect(await u.start()).toMatchObject({
        kind: "blocked",
        reason: "no-remote-control",
      });
      expect(ledger.kept()?.outstandingUntil).toBeNull();
    } finally {
      await t.close();
    }
  },
);

test.skipIf(!posix)(
  "a code without a named end: its hour holds past the handle's ten minutes, by poll, start and restart",
  async () => {
    const ledger = memoryLedger();
    const s = await setup({ ledger: ledger.store });
    try {
      s.daemon.lifeSeconds = null;
      const first = await s.connections.start();
      if (first.kind !== "pairing") throw new Error("not started");
      const hour = s.now() + 60 * 60_000;
      expect(first.expiresAt).toBe(s.now() + 10 * 60_000);
      expect(ledger.kept()?.outstandingUntil).toBe(hour);
      s.advance(11 * 60_000);
      // The poll's path: the handle ends, the hour stays.
      expect(await s.connections.poll(first.session)).toEqual({
        kind: "expired",
      });
      expect(ledger.kept()?.outstandingUntil).toBe(hour);
      expect(await s.connections.start()).toEqual({
        kind: "blocked",
        reason: "code-outstanding",
        until: hour,
      });
      expect(await s.restarted().start()).toEqual({
        kind: "blocked",
        reason: "code-outstanding",
        until: hour,
      });
      expect(s.pairings()).toBe(1);
      s.advance(50 * 60_000);
      const second = await s.connections.start();
      if (second.kind !== "pairing") throw new Error("not started");
      expect(s.pairings()).toBe(2);
      // The start's path, with no poll: past the handle, the hour stays.
      s.advance(11 * 60_000);
      expect(await s.connections.start()).toMatchObject({
        kind: "blocked",
        reason: "code-outstanding",
      });
      expect(s.pairings()).toBe(2);
      // Only a phone taking the code ends its hour early.
      s.advance(50 * 60_000);
      const third = await s.connections.start();
      if (third.kind !== "pairing") throw new Error("not started");
      s.daemon.claimed = true;
      expect((await s.connections.poll(third.session)).kind).toBe("paired");
      expect(ledger.kept()?.outstandingUntil).toBeNull();
      expect((await s.connections.start()).kind).toBe("pairing");
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "a poll, a start and a restart overlapping: an older write never replaces a newer one",
  async () => {
    const ledger = memoryLedger();
    const s = await setup({ ledger: ledger.store });
    try {
      const first = await s.connections.start();
      if (first.kind !== "pairing") throw new Error("not started");
      // The phone takes the code; the poll's cleared ledger is slow to write.
      s.daemon.claimed = true;
      const release = ledger.hold();
      const polled = s.connections.poll(first.session);
      const started = s.connections.start();
      await Bun.sleep(50);
      // The start waits for the poll: Codex was not asked again yet.
      expect(s.pairings()).toBe(1);
      release();
      expect((await polled).kind).toBe("paired");
      const second = await started;
      if (second.kind !== "pairing") throw new Error("not started");
      expect(s.pairings()).toBe(2);
      // The ledger keeps the second code's end, so a restart makes no third.
      expect(ledger.kept()?.outstandingUntil).toBe(second.expiresAt);
      expect(await s.restarted().start()).toEqual({
        kind: "blocked",
        reason: "code-outstanding",
        until: second.expiresAt,
      });
      expect(s.pairings()).toBe(2);
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "a ledger that cannot be read counts as a live code; one that cannot be written asks Codex nothing",
  async () => {
    const broken = memoryLedger();
    broken.set({ version: 1, starts: "x", outstandingUntil: null });
    const s = await setup({ ledger: broken.store });
    try {
      expect(await s.connections.start()).toMatchObject({
        kind: "blocked",
        reason: "code-outstanding",
      });
      expect(s.pairings()).toBe(0);
    } finally {
      await s.close();
    }
    const full = memoryLedger(1);
    const t = await setup({ ledger: full.store });
    try {
      expect(await t.connections.start()).toEqual({
        kind: "blocked",
        reason: "storage-failed",
      });
      expect(t.pairings()).toBe(0);
    } finally {
      await t.close();
    }
  },
);

test.skipIf(!posix)("the ledger file: 0600, whole, never a code", async () => {
  const parent = await mkdtemp(join(tmpdir(), "connections-ledger-"));
  try {
    expect(pairingLedgerPath("/home/alex", {})).toBe(
      "/home/alex/.local/state/lazurio/connections/pairing.json",
    );
    expect(pairingLedgerPath("/home/alex", { XDG_STATE_HOME: "rel" })).toBe(
      "/home/alex/.local/state/lazurio/connections/pairing.json",
    );
    const path = pairingLedgerPath(parent, { XDG_STATE_HOME: parent });
    const store = fileLedger(path);
    expect(await store.read()).toBeNull();
    const ledger: PairingLedger = {
      version: 1,
      starts: [1_762_000_000_000],
      outstandingUntil: 1_762_000_600_000,
    };
    await store.write(ledger);
    expect(await store.read()).toEqual(ledger);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, "{not json");
    expect(await store.read()).toBe("unreadable");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test.skipIf(!posix)(
  "Codex's error naming the code never reaches an answer or an error",
  async () => {
    const s = await setup();
    try {
      const started = await s.connections.start();
      if (started.kind !== "pairing") throw new Error("not started");
      s.daemon.errorMessages = true;
      expect(await s.connections.poll(started.session)).toEqual({
        kind: "waiting",
        expiresAt: started.expiresAt,
      });
      const rpc = await openControlSocket(s.path, { timeoutMs: 2_000 });
      let caught: unknown;
      try {
        await rpc.call("remoteControl/pairing/status", { pairingCode: code });
      } catch (error) {
        caught = error;
      } finally {
        rpc.close();
      }
      expect(caught).toBeInstanceOf(ControlSocketError);
      expect(String(caught)).not.toContain(code);
      expect(JSON.stringify(caught)).not.toContain(code);
      expect((caught as Error).stack ?? "").not.toContain(code);
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "removing access: only a listed device, then the list without it",
  async () => {
    const s = await setup();
    try {
      expect(await s.connections.revoke("client-9")).toMatchObject({
        kind: "blocked",
        reason: "unknown-device",
      });
      expect(await s.connections.revoke("client-1")).toMatchObject({
        kind: "connections",
        devices: [],
      });
      expect(
        s.daemon.calls.find(
          (call) => call.method === "remoteControl/client/revoke",
        )?.params,
      ).toEqual({ environmentId: "env-1", clientId: "client-1" });
      expect(s.journal.at(-1)).toEqual({
        scope: "connections",
        operation: "revoke",
        outcome: "revoked",
        platform: "android",
      });
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "restart: only when remote control is not usable and the unit is Lazurio's",
  async () => {
    const ready = await setup();
    try {
      expect(await ready.connections.restart()).toMatchObject({
        kind: "blocked",
        reason: "restart-not-needed",
      });
      expect(ready.restarts.length).toBe(0);
    } finally {
      await ready.close();
    }
    const foreign = await setup({ restartable: false });
    try {
      foreign.daemon.status = "errored";
      expect(await foreign.connections.restart()).toMatchObject({
        kind: "blocked",
        reason: "restart-not-managed",
      });
      expect(foreign.restarts.length).toBe(0);
    } finally {
      await foreign.close();
    }
    const errored = await setup();
    try {
      errored.daemon.status = "errored";
      expect(await errored.connections.restart()).toMatchObject({
        kind: "connections",
        state: "ready",
      });
      expect(errored.restarts.length).toBe(1);
    } finally {
      await errored.close();
    }
  },
);

test.skipIf(!posix)(
  "routes: JSON POST, exact fields, confirmation, no-store, no code in GET",
  async () => {
    const s = await setup();
    try {
      const routes = createConnectionsRoutes({
        connections: () => s.connections,
        headers: { "Cache-Control": "no-store" },
      });
      const base = "http://127.0.0.1";
      const call = (path: string, init: RequestInit = {}) =>
        routes.handle(
          new Request(`${base}${path}`, init),
          new URL(`${base}${path}`),
        );
      const post = (path: string, body: unknown, type = "application/json") =>
        call(path, {
          method: "POST",
          headers: { "content-type": type },
          body: JSON.stringify(body),
        });
      expect(routes.handles("/api/connections")).toBe(true);
      expect(routes.handles("/api/connections/pair/poll")).toBe(true);
      expect(routes.handles("/api/connectionsx")).toBe(false);
      const read = await call("/api/connections");
      expect(read.status).toBe(200);
      expect(read.headers.get("cache-control")).toBe("no-store");
      expect((await call("/api/connections/pair")).status).toBe(405);
      expect(
        (await post("/api/connections/pair", {}, "text/plain")).status,
      ).toBe(415);
      expect((await post("/api/connections/pair", { extra: 1 })).status).toBe(
        400,
      );
      expect((await call("/api/connections?x=1")).status).toBe(400);
      const pair = await post("/api/connections/pair", {});
      expect(pair.status).toBe(200);
      expect(pair.headers.get("cache-control")).toBe("no-store");
      const started = (await pair.json()) as Json;
      expect(started.kind).toBe("pairing");
      expect(
        (await post("/api/connections/pair/poll", { session: "x" })).status,
      ).toBe(400);
      expect(
        await (
          await post("/api/connections/pair/poll", { session: started.session })
        ).json(),
      ).toMatchObject({ kind: "waiting" });
      expect(
        (await post("/api/connections/restart", { confirm: false })).status,
      ).toBe(400);
      expect(
        (await post("/api/connections/revoke", { clientId: "a b" })).status,
      ).toBe(400);
      expect(
        (await post("/api/connections/revoke", { clientId: "nope" })).status,
      ).toBe(404);
      const again = await (await call("/api/connections")).text();
      expect(again).not.toContain(code);
      expect(again).not.toContain(manual);
      expect(again).not.toContain(String(started.session));
      // No cancel: Codex cannot end a code, so the same one is answered.
      expect(
        (
          await post("/api/connections/pair/cancel", {
            session: started.session,
          })
        ).status,
      ).toBe(404);
      expect(
        ((await (await post("/api/connections/pair", {})).json()) as Json)
          .session,
      ).toBe(started.session);
    } finally {
      await s.close();
    }
  },
);

test("trust: the Folder and the home added once, the person's entries kept", async () => {
  const folder = "/home/alex/Lazurio";
  const home = "/home/alex";
  const added = codexTrustedText("", [folder, home]);
  expect(added).toBe(
    `[projects."${folder}"] ${codexTrustMarker}\ntrust_level = "trusted" ${codexTrustMarker}\n\n[projects."${home}"] ${codexTrustMarker}\ntrust_level = "trusted" ${codexTrustMarker}\n`,
  );
  expect(codexTrustedText(added ?? "", [folder, home])).toBe(added);
  const own = `model = "gpt-5"\n\n[projects."${home}"]\ntrust_level = "untrusted"\n`;
  const kept = codexTrustedText(own, [folder, home]) ?? "";
  expect(kept.startsWith(own)).toBe(true);
  expect(kept).toContain(`[projects."${folder}"]`);
  expect(kept.match(/projects\."\/home\/alex"\]/g)?.length).toBe(1);
  expect(Bun.TOML.parse(kept)).toMatchObject({
    projects: {
      [home]: { trust_level: "untrusted" },
      [folder]: { trust_level: "trusted" },
    },
  });
  expect(codexTrustedText('projects = "x"\n', [folder])).toBeNull();
  expect(codexTrustedText("not = = toml", [folder])).toBeNull();
  expect(codexTrustedText("", ['/home/a"b'])).toContain(
    '[projects."/home/a\\"b"]',
  );
});

test.skipIf(!posix)(
  "trust: written atomically with the old mode; a link is refused",
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "codex-trust-"));
    try {
      expect(await convergeCodexTrust(parent, ["/srv/folder"])).toEqual({
        kind: "changed",
      });
      expect(await readFile(join(parent, "config.toml"), "utf8")).toContain(
        '[projects."/srv/folder"]',
      );
      expect(await convergeCodexTrust(parent, ["/srv/folder"])).toEqual({
        kind: "unchanged",
      });
      const linked = await mkdtemp(join(tmpdir(), "codex-trust-link-"));
      await writeFile(join(linked, "real.toml"), "");
      await symlink(join(linked, "real.toml"), join(linked, "config.toml"));
      expect(await convergeCodexTrust(linked, ["/srv/folder"])).toEqual({
        kind: "refused",
        reason: "config-not-regular",
      });
      await rm(linked, { recursive: true, force: true });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
