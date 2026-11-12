import { expect, test } from "bun:test";
import { pairingQrPayload } from "../src/connections/pairing";
import {
  appCard,
  deviceDetail,
  deviceForm,
  deviceName,
  deviceOs,
  deviceOses,
  formOf,
  isPhoneOs,
  motionSteps,
  offersRestart,
  offersSignIn,
  offersSsh,
  offersSshWay,
  osesHere,
  pairApps,
  pairingFoot,
  pairingShape,
  parseConnectionsOverview,
  parsePairing,
  parsePoll,
  pathDetail,
  remaining,
  sshPaths,
  stateMessage,
} from "../src/launchpad/connections-view";
import type { MachinePeer } from "../src/launchpad/machine-view";
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
  // The Organization's AI: the phone's route there is coming, no sign-in.
  expect(offersSignIn(of("organization-ai"))).toBe(false);
  expect(cs[stateMessage(of("organization-ai")) ?? "phoneTitle"]).toBe(
    "Na AI Organizace nejde, potřebuje váš vlastní účet ChatGPT.",
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
  expect(cs.connectionsControl).toBe("Ovládat toto Osobní Prostředí");
  expect(cs.computerLead).toBe(
    "Chaty tohoto Osobního Prostředí ovládáte z ChatGPT Desktopu.",
  );
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
  // A computer pairs by code too, so ChatGPT Desktop over SSH steps back.
  expect(offered.map((row) => row.id)).toEqual(["phone", "ssh"]);
  expect(offered[0]).toMatchObject({
    title: "Telefon a počítač přes ChatGPT",
    status: cs.startNotSet,
    action: { label: "Spárovat", to: "/settings/connections" },
  });
  expect(rows({ ready: true, devices: 1 })[0]?.status).toBe(cs.startSet);
});

// Settings → Connections, F71's addendum of 2026-11-11: a phone and a
// computer both pair by code; SSH is offered only where the handover
// records a peer that may open it, with the paths each way.

const peer = (
  name: string,
  kind: string,
  direction: "inbound" | "outbound" | "both" | null,
  organization: string | null = null,
): MachinePeer => ({
  name,
  kind,
  zone: null,
  organization,
  ssh:
    direction === null
      ? null
      : { host: `${name}.tailnet.example`, user: null, direction },
  https: [],
});

test("the SSH paths each way, as the handover records them", () => {
  const machine = {
    relationships: {
      zone: "work",
      peers: [
        peer("alex-laptop", "client-device", "inbound"),
        peer("alex-personal-vm", "personal-vm", "inbound"),
        peer("example-sales-vm", "workspace-vm", "outbound", "example"),
        peer("alex-desktop", "client-device", "both"),
        peer("alex-phone", "client-device", null),
        peer("alex-laptop", "client-device", "inbound"),
      ],
    },
  };
  const paths = sshPaths(machine);
  expect(paths?.inbound.map((path) => path.name)).toEqual([
    "alex-laptop",
    "alex-personal-vm",
    "alex-desktop",
  ]);
  expect(paths?.outbound.map((path) => path.name)).toEqual([
    "example-sales-vm",
    "alex-desktop",
  ]);
  // Nothing recorded is nothing known; an empty list is known to be empty.
  expect(sshPaths({})).toBeNull();
  expect(sshPaths(null)).toBeNull();
  expect(sshPaths({ relationships: { zone: "work", peers: [] } })).toEqual({
    inbound: [],
    outbound: [],
  });
});

test("SSH is offered only where a peer may open it into a server", () => {
  const into = sshPaths({
    relationships: {
      zone: "personal",
      peers: [peer("alex-laptop", "client-device", "inbound")],
    },
  });
  const outOnly = sshPaths({
    relationships: {
      zone: "personal",
      peers: [peer("example-sales-vm", "workspace-vm", "outbound", "example")],
    },
  });
  expect(offersSsh("hosted-personal", into)).toBe(true);
  expect(offersSsh("hosted-personal", outOnly)).toBe(false);
  expect(offersSsh("hosted-organization-personal", null)).toBe(false);
  expect(offersSsh("local", into)).toBe(false);
});

test("a path's line names its kind and Organization in both languages", () => {
  const cs = messages("cs", "work");
  const en = messages("en", "work");
  const work = {
    name: "example-sales-vm",
    kind: "workspace-vm",
    organization: "example",
  };
  expect(pathDetail(work, cs)).toBe("Pracovní Prostředí · example");
  expect(pathDetail(work, en)).toBe("Work Environment · example");
  expect(
    pathDetail(
      { name: "alex-laptop", kind: "client-device", organization: null },
      cs,
    ),
  ).toBe("Zařízení");
  expect(
    pathDetail({ name: "x", kind: "future-kind", organization: null }, en),
  ).toBe("future-kind");
});

test("Začínáme: SSH and ChatGPT Desktop over it only where SSH is allowed", () => {
  const cs = messages("cs", "work");
  const rows = (ssh: boolean | undefined, ready: boolean) =>
    optionalRows(
      {
        preset: "hosted-organization-personal",
        composio: "none",
        sshDevices: 0,
        bitwarden: false,
        phone: { ready, devices: 0 },
        ssh,
      },
      cs,
    ).map((row) => row.id);
  expect(rows(false, true)).toEqual(["phone"]);
  expect(rows(false, false)).toEqual([]);
  expect(rows(true, false)).toEqual(["ssh", "codex"]);
  expect(rows(undefined, false)).toEqual(["ssh", "codex"]);
});

// Root decision 0240 and F71's addendum of 2026-11-11: a Device first, by its
// operating system, then the app, then the way.

test("a Device by its system: five systems, phones by the QR code, yours pairs a phone", () => {
  expect(deviceOses).toEqual(["mac", "windows", "linux", "iphone", "android"]);
  expect(deviceOses.filter(isPhoneOs)).toEqual(["iphone", "android"]);
  expect(deviceOses.map(formOf)).toEqual([
    "computer",
    "computer",
    "computer",
    "phone",
    "phone",
  ]);
  expect(osesHere(true)).toEqual(deviceOses);
  // Your own computer would pair itself: only the phones are offered there.
  expect(osesHere(false)).toEqual(["iphone", "android"]);
  for (const locale of ["cs", "en"] as const) {
    const copy = messages(locale, "work");
    expect([
      copy.osMac,
      copy.osWindows,
      copy.osLinux,
      copy.osIphone,
      copy.osAndroid,
    ]).toEqual(["Mac", "Windows", "Linux", "iPhone", "Android"]);
  }
});

test("a paired device shows its system where Codex names it", () => {
  expect(deviceOs(device)).toBe("android");
  expect(deviceOs({ ...device, platform: "iOS" })).toBe("iphone");
  expect(deviceOs({ ...device, platform: "macos" })).toBe("mac");
  expect(deviceOs({ ...device, platform: "windows" })).toBe("windows");
  expect(deviceOs({ ...device, platform: "linux" })).toBe("linux");
  expect(deviceOs({ ...device, platform: null })).toBeNull();
  expect(deviceForm({ ...device, deviceType: null, platform: "ios" })).toBe(
    "phone",
  );
  expect(
    deviceForm({ ...device, deviceType: "desktop", platform: "macos" }),
  ).toBe("computer");
  // An unknown form is a computer: only phones are known to say so.
  expect(deviceForm({ ...device, deviceType: null, platform: null })).toBe(
    "computer",
  );
});

test("the dialog: a phone gets the QR code, a computer the short code or a reason", () => {
  expect(pairingShape("iphone", "ABCD-EFGH")).toEqual({
    qr: true,
    code: true,
    unavailable: false,
  });
  // Without a short code a phone still scans the QR code.
  expect(pairingShape("android", null)).toEqual({
    qr: true,
    code: false,
    unavailable: false,
  });
  expect(pairingShape("mac", "ABCD-EFGH")).toEqual({
    qr: false,
    code: true,
    unavailable: false,
  });
  // A computer has nothing to enter: the dialog says so, in both languages.
  expect(pairingShape("windows", null)).toEqual({
    qr: false,
    code: false,
    unavailable: true,
  });
  expect(messages("cs", "work").computerNoCode).toContain(
    "krátký kód pro počítač",
  );
  expect(messages("en", "work").computerNoCode).toContain(
    "short code for a computer",
  );
});

const ready = {
  kind: "connections",
  state: "ready",
  devices: [],
  restart: false,
} as const;
const stateOf = (
  state: "no-remote-control" | "organization-ai" | "no-chatgpt" | "team",
) => ({
  kind: "connections" as const,
  state,
  devices: [],
  restart: false,
});

test("the apps for a system: ChatGPT by its state and system, the others coming", () => {
  expect(pairApps).toEqual(["chatgpt", "claude", "t3code", "vscode"]);
  expect(appCard("chatgpt", "mac", ready, false)).toEqual({
    app: "chatgpt",
    available: true,
    sshOnly: false,
    line: "appChatgptReady",
  });
  expect(appCard("chatgpt", "iphone", ready, false).line).toBe(
    "appChatgptReadyPhone",
  );
  // ChatGPT Desktop runs on Mac and Windows: Linux pairs no ChatGPT by code.
  expect(appCard("chatgpt", "linux", ready, false)).toMatchObject({
    available: false,
    line: "appComing",
  });
  expect(appCard("chatgpt", "mac", stateOf("organization-ai"), false)).toEqual({
    app: "chatgpt",
    available: false,
    sshOnly: false,
    line: "phoneStateOrganizationAi",
  });
  expect(appCard("chatgpt", "mac", null, true).line).toBe("phoneLoading");
  expect(appCard("chatgpt", "mac", null, false).line).toBe("phoneFailed");
  // Nothing is claimed for Claude, T3 Code or VS Code but that they are coming.
  for (const app of ["claude", "t3code", "vscode"] as const)
    for (const os of deviceOses)
      expect(appCard(app, os, ready, false)).toEqual({
        app,
        available: false,
        sshOnly: false,
        line: "appComing",
      });
  for (const locale of ["cs", "en"] as const) {
    const copy = messages(locale, "work");
    expect(copy.phoneStateOrganizationAi).toMatch(/ChatGPT/);
    expect(copy.appChatgptReady).toMatch(/ChatGPT Desktop/);
    expect(copy.appChatgptReadyPhone).not.toMatch(/Desktop/);
  }
});

test("SSH only on Mac, Windows and Linux, for an app that speaks it, where it comes in", () => {
  for (const os of ["mac", "windows"] as const) {
    expect(offersSshWay("chatgpt", os, true)).toBe(true);
    expect(offersSshWay("t3code", os, true)).toBe(true);
  }
  // Linux has no ChatGPT Desktop, but T3 Code speaks SSH there.
  expect(offersSshWay("chatgpt", "linux", true)).toBe(false);
  expect(offersSshWay("t3code", "linux", true)).toBe(true);
  for (const os of ["iphone", "android"] as const)
    for (const app of pairApps) expect(offersSshWay(app, os, true)).toBe(false);
  for (const app of ["claude", "vscode"] as const)
    expect(offersSshWay(app, "mac", true)).toBe(false);
  for (const os of deviceOses)
    expect(offersSshWay("chatgpt", os, false)).toBe(false);
});

test("where no code pairs but SSH comes in, an app leads to SSH (0215)", () => {
  for (const state of [
    "no-remote-control",
    "organization-ai",
    "no-chatgpt",
    "team",
  ] as const)
    expect({
      state,
      card: appCard("chatgpt", "mac", stateOf(state), false, true),
    }).toMatchObject({
      state,
      card: { available: false, sshOnly: true },
    });
  expect(appCard("t3code", "linux", null, false, true)).toEqual({
    app: "t3code",
    available: false,
    sshOnly: true,
    line: "appCodeComing",
  });
  // A phone has no SSH; Claude speaks none here; without a path in nothing leads there.
  expect(
    appCard("chatgpt", "iphone", stateOf("organization-ai"), false, true)
      .sshOnly,
  ).toBe(false);
  expect(appCard("claude", "mac", null, false, true).sshOnly).toBe(false);
  expect(
    appCard("chatgpt", "mac", stateOf("organization-ai"), false, false).sshOnly,
  ).toBe(false);
  // Where the code pairs, SSH stays a way inside the pairing, not the app's.
  expect(appCard("chatgpt", "mac", ready, false, true).sshOnly).toBe(false);
  for (const locale of ["cs", "en"] as const) {
    expect(messages(locale, "work").appSsh).toMatch(/SSH/);
    expect(messages(locale, "work").pairSshTitle).toContain("{app}");
  }
});

test("the dialog foot: Nový kód once the code ended, on the code step only", () => {
  const foot = (
    step: "app" | "code" | "ssh",
    ended = false,
    paired = false,
    sshOnly = false,
  ) => pairingFoot({ step, ended, paired, sshOnly });
  expect(foot("app")).toEqual({ newCode: false, status: false, back: false });
  expect(foot("code")).toEqual({ newCode: false, status: true, back: true });
  // The code expired or was refused while SSH was open: Nový kód waits on the
  // code step and comes back there; the SSH step shows neither.
  expect(foot("ssh", true)).toEqual({
    newCode: false,
    status: false,
    back: true,
  });
  expect(foot("code", true)).toEqual({
    newCode: true,
    status: true,
    back: true,
  });
  expect(foot("code", true, true).newCode).toBe(false);
  // SSH alone goes back to the apps as well.
  expect(foot("ssh", false, false, true).back).toBe(true);
});

test("one motion template, filled per system, app and way", () => {
  const texts = (
    os: (typeof deviceOses)[number],
    way: "code" | "ssh",
  ): string[] | null =>
    motionSteps(os, "chatgpt", way)?.map((step): string => step.text) ?? null;
  const phone = [
    "phoneMotionOpen",
    "phoneMotionCodex",
    "phoneMotionAdd",
    "phoneMotionScan",
    "phoneMotionDone",
  ];
  const computer = [
    "computerMotionOpen",
    "computerMotionConnections",
    "computerMotionControl",
    "computerMotionCode",
    "phoneMotionDone",
  ];
  expect(texts("iphone", "code")).toEqual(phone);
  expect(texts("android", "code")).toEqual(phone);
  expect(texts("mac", "code")).toEqual(computer);
  expect(texts("windows", "code")).toEqual(computer);
  expect(texts("mac", "ssh")?.[0]).toBe("sshMotionCopy");
  expect(texts("iphone", "ssh")).toBeNull();
  expect(texts("linux", "code")).toBeNull();
  expect(motionSteps("mac", "claude", "code")).toBeNull();
  // Every caption exists in both languages.
  for (const locale of ["cs", "en"] as const) {
    const copy = messages(locale, "work");
    for (const os of deviceOses)
      for (const way of ["code", "ssh"] as const)
        for (const step of motionSteps(os, "chatgpt", way) ?? [])
          expect(copy[step.text]).toBeTruthy();
  }
});
