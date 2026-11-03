import { expect, test } from "bun:test";
import { pairingQrPayload } from "../src/connections/pairing";
import {
  deviceDetail,
  deviceName,
  offersRestart,
  offersSignIn,
  parseConnectionsOverview,
  parsePairing,
  parsePoll,
  remaining,
  stateMessage,
} from "../src/launchpad/connections-view";
import { messages } from "../src/launchpad/messages";
import { optionalRows } from "../src/launchpad/start-view";
import { qrMatrix, qrSvg } from "../src/tools/qr";

// The page's side of Telefon přes ChatGPT (decision F71): the answers in
// their exact shapes, the words for each state and Začínáme's row.

const device = {
  clientId: "client-1",
  name: "Pixel",
  deviceType: "phone",
  platform: "android",
  model: "Pixel 10",
  appVersion: "1.2026.293",
  lastSeenAt: 1_762_000_000_000,
};

test("the overview in its exact shape", () => {
  const ready = {
    kind: "connections",
    state: "ready",
    serverName: "alex-work",
    devices: [device],
    restart: false,
  } as const;
  expect(parseConnectionsOverview(ready)).toEqual(ready);
  expect(parseConnectionsOverview({ ...ready, state: "other" })).toBeNull();
  expect(parseConnectionsOverview({ ...ready, devices: [{}] })).toBeNull();
  expect(parseConnectionsOverview({ ...ready, restart: "yes" })).toBeNull();
  expect(
    parseConnectionsOverview({
      kind: "connections",
      state: "no-remote-control",
      reason: "errored",
      devices: [],
      restart: true,
    }),
  ).toMatchObject({ reason: "errored" });
});

test("each state's words, sign-in and restart", () => {
  const cs = messages("cs", "personal");
  const of = (state: string, extra: Record<string, unknown> = {}) => {
    const overview = parseConnectionsOverview({
      kind: "connections",
      state,
      devices: [],
      restart: true,
      ...extra,
    });
    if (overview === null) throw new Error(state);
    return overview;
  };
  expect(stateMessage(of("ready"))).toBeNull();
  expect(cs[stateMessage(of("no-chatgpt")) ?? "phoneTitle"]).toBe(
    "Nejdřív se přihlaste svým účtem ChatGPT.",
  );
  expect(offersSignIn(of("no-chatgpt"))).toBe(true);
  expect(offersSignIn(of("organization-ai"))).toBe(true);
  expect(cs[stateMessage(of("organization-ai")) ?? "phoneTitle"]).toStartWith(
    "Nejdřív se přihlaste svým účtem ChatGPT.",
  );
  expect(stateMessage(of("team"))).toBe("phoneStateTeam");
  expect(offersRestart(of("team"))).toBe(false);
  expect(offersRestart(of("no-remote-control", { reason: "errored" }))).toBe(
    true,
  );
  expect(
    offersRestart(
      of("no-remote-control", { reason: "errored", restart: false }),
    ),
  ).toBe(false);
  expect(
    offersRestart(of("no-remote-control", { reason: "unsupported" })),
  ).toBe(false);
  expect(stateMessage(of("no-remote-control", { reason: "unsupported" }))).toBe(
    "phoneStateUnsupported",
  );
  expect(cs.connectionsTabThis).toBe("Ovládat toto Osobní Prostředí");
  expect(cs.phoneHint).toBe(
    "V aplikaci ChatGPT otevřete Codex → Přidat počítač a naskenujte kód.",
  );
});

test("a pairing answer shows only the QR form the server draws", () => {
  const svg = qrSvg(qrMatrix(pairingQrPayload("1234567890")));
  const answer = {
    kind: "pairing",
    session: "0123456789abcdef0123456789abcdef",
    manualCode: "ABCD-EFGH",
    expiresAt: 1_762_000_600_000,
    qrSvg: svg,
  };
  expect(parsePairing(answer)?.qrSource).toStartWith(
    "data:image/svg+xml;base64,",
  );
  expect(
    parsePairing({ ...answer, qrSvg: "<svg><script>x</script></svg>" }),
  ).toBeNull();
  expect(parsePairing({ ...answer, session: "short" })).toBeNull();
  expect(parsePairing({ ...answer, manualCode: "<b>" })?.manualCode).toBeNull();
});

test("the poll, the time left and a device's lines", () => {
  expect(parsePoll({ kind: "waiting", expiresAt: 5 })).toEqual({
    kind: "waiting",
    expiresAt: 5,
  });
  expect(parsePoll({ kind: "paired", devices: [device] })).toEqual({
    kind: "paired",
    devices: [device],
  });
  expect(parsePoll({ kind: "expired" })).toEqual({ kind: "expired" });
  expect(parsePoll({ kind: "other" })).toBeNull();
  expect(remaining(10 * 60_000, 0)).toBe("10:00");
  expect(remaining(65_000, 0)).toBe("1:05");
  expect(remaining(0, 5_000)).toBe("0:00");
  expect(deviceName(device)).toBe("Pixel");
  expect(deviceDetail(device)).toBe("Pixel 10 · android · ChatGPT 1.2026.293");
  expect(deviceName({ ...device, name: null })).toBe("Pixel 10");
});

test("Začínáme: the phone's row only where pairing is offered", () => {
  const cs = messages("cs", "personal");
  const rows = (phone: { ready: boolean; devices: number } | null) =>
    optionalRows(
      {
        preset: "hosted-personal",
        composio: "none",
        sshDevices: 0,
        bitwarden: false,
        phone,
      },
      cs,
    );
  expect(rows(null).map((row) => row.id)).toEqual(["ssh", "codex"]);
  expect(rows({ ready: false, devices: 0 }).map((row) => row.id)).toEqual([
    "ssh",
    "codex",
  ]);
  const offered = rows({ ready: true, devices: 0 });
  expect(offered.map((row) => row.id)).toEqual(["phone", "ssh", "codex"]);
  expect(offered[0]).toMatchObject({
    title: "Telefon přes ChatGPT",
    status: cs.startNotSet,
    action: { label: "Spárovat telefon", to: "/settings/connections" },
  });
  expect(rows({ ready: true, devices: 1 })[0]?.status).toBe(cs.startSet);
});
