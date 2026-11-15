/** The desktop prototype: the Environment's whole screen in a web page, for
 * the windows the browser view cannot show.
 *
 *   bun serve.ts --port 4871 --origin http://127.0.0.1:4871 [--cdp 9433]
 *
 * - x11vnc reads the screen `:1`, one process per viewer started by socket
 *   activation on an owner-only unix socket (`-inetd`) and ended when the
 *   viewer leaves: no VNC port exists.
 * - The page is noVNC 1.7.0. Its WebSocket reaches x11vnc only through
 *   `rfb-gate.ts`, which drops keys, pointer and paste unless this viewer
 *   holds the screen.
 * - A person takes the screen (`POST /api/take`) for a lease that use renews;
 *   while they hold it, every agent's `computer` gate refuses input tools.
 * - `POST /api/focus {tab}` raises the browser window of that tab and the
 *   native windows that belong to it, and returns where they are, so the page
 *   opens on them. Releasing the screen puts the stacking back as it was.
 * - `GET /api/escapes` lists the windows on the screen that a tab's view
 *   cannot show (a dialog transient for a browser window, a lasting bubble),
 *   with the tab they belong to where it can be told.
 *
 * Admission is the gateway's, as for the view (decision F39 point 8): every
 * request must name this service's own host, and every WebSocket and every
 * change must carry its own Origin. Without a gateway (the prototype on
 * loopback) the origin is `http://127.0.0.1:<port>`. */

import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
import { type Cdp, connectCdp, windowForTarget } from "./cdp";
import { ClientStream, HeldInput, verdict } from "./rfb-gate";
import {
  activeAgents,
  holdForPerson,
  readPerson,
  releasePerson,
} from "./turn";
import {
  details,
  focus,
  pressKey,
  raise,
  restack,
  type TopLevel,
  topLevels,
  type WindowDetails,
} from "./windows";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "4871" },
    origin: { type: "string" },
    display: { type: "string", default: ":1" },
    cdp: { type: "string", default: "9433" },
  },
});
const port = Number(values.port);
const origin = new URL(values.origin ?? `http://127.0.0.1:${port}`).origin;
const display = values.display ?? ":1";
const cdpPort = Number(values.cdp);
const here = import.meta.dir;
const state =
  process.env.LAZURIO_DESKTOP_RUN ??
  join(homedir(), ".local/state/lazurio-desktop-prototype");
const toolRoot =
  process.env.LAZURIO_DESKTOP_TOOLS ??
  join(homedir(), ".local/opt/lazurio-desktop-prototype/root");

// ---------------------------------------------------------------- x11vnc

/** x11vnc per connection, never listening itself. `systemd-socket-activate`
 * (the standalone tool of systemd; the product would use a user socket unit
 * with `Accept=yes`, the same thing) listens on an owner-only unix socket and
 * starts one `x11vnc -inetd` for each connection, its fd 0 and 1 the
 * connected socket. So no TCP port exists, and the screen is read only while
 * someone watches. Measured on x11vnc 0.9.16 with libvncserver 0.9.14: a
 * listening x11vnc opens TCP even with `-rfbport 0`, and an IPv6 listener on
 * every interface even with `-noipv6` unless told `-listenv6 ::1`; and in
 * `-inetd` mode it reads and writes fd 0, so two pipes do not do. */
const vncSocket = join(state, "vnc/rfb.sock");
await mkdir(join(state, "vnc"), { recursive: true, mode: 0o700 });
await rm(vncSocket, { force: true });
const activator = Bun.spawn(
  [
    "systemd-socket-activate",
    "--inetd",
    "--accept",
    "--listen",
    vncSocket,
    "--setenv",
    `LD_LIBRARY_PATH=${join(toolRoot, "usr/lib/x86_64-linux-gnu")}`,
    join(toolRoot, "usr/bin/x11vnc"),
    "-inetd",
    "-display",
    display,
    "-nopw",
    "-noremote",
    "-nocmds",
    "-norc",
    // The screen's selections are every thread's clipboard; none of it goes
    // to a viewer. A person's paste still sets them.
    "-noprimary",
    "-noclipboard",
    "-ncache",
    "0",
    "-o",
    join(state, "x11vnc.log"),
  ],
  { stdout: "ignore", stderr: "ignore" },
);

type Rfb = { write(bytes: Uint8Array): void; end(): void };

async function connectVnc(
  onData: (chunk: Uint8Array) => void,
  onEnd: () => void,
): Promise<Rfb> {
  const socket = await Bun.connect({
    unix: vncSocket,
    socket: {
      data(_socket, chunk) {
        onData(chunk);
      },
      close() {
        onEnd();
      },
      error() {
        onEnd();
      },
    },
  });
  return {
    write(bytes) {
      socket.write(bytes);
    },
    end() {
      socket.end();
    },
  };
}

// This service is the only writer of a person's lease, and a lease belongs to
// one of its live viewers: a lease left by a previous run holds nothing, so
// it goes at start and at stop, and agents never wait for a page that is gone.
await releasePerson();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const ws of viewers.values()) ws.data.rfb?.end();
    activator.kill();
    void releasePerson().finally(() => process.exit(0));
  });

// ---------------------------------------------------------------- viewers

type Viewer = {
  id: string;
  who: string;
  lastMask: number;
  chain: Promise<void>;
  rfb: Rfb | null;
  queue: Uint8Array[];
  stream: ClientStream;
  held: HeldInput;
};

const viewers = new Map<string, ServerWebSocket<Viewer>>();
/** The viewer that holds the screen, if one of this service's viewers does. */
let holder: string | null = null;
/** The stacking before this hold raised anything, topmost first. */
let stackingBefore: string[] | null = null;

async function take(viewerId: string, who: string): Promise<void> {
  // The last person to take the screen has it; whoever had it before lets go
  // of every key and button they still held.
  if (holder !== null && holder !== viewerId) {
    const before = viewers.get(holder);
    if (before?.data.rfb)
      for (const bytes of before.data.held.release()) before.data.rfb.write(bytes);
  }
  holder = viewerId;
  await holdForPerson(who);
}

async function release(viewerId: string): Promise<void> {
  if (holder !== viewerId) return;
  const ws = viewers.get(viewerId);
  if (ws?.data.rfb) for (const bytes of ws.data.held.release()) ws.data.rfb.write(bytes);
  holder = null;
  await releasePerson();
  if (stackingBefore !== null) {
    const recorded = stackingBefore;
    stackingBefore = null;
    await restack(display, recorded).catch(() => undefined);
  }
}

// Leases: a person who neither types nor clicks nor keeps the page open for
// two minutes lets go of the screen, so agents never wait for a forgotten tab.
setInterval(async () => {
  if (holder !== null && (await readPerson()) === null)
    await release(holder).catch(() => undefined);
}, 5_000);

// ---------------------------------------------------------------- windows

const known = new Map<string, WindowDetails>();

async function describe(window: TopLevel): Promise<WindowDetails | null> {
  const cached = known.get(window.id);
  if (cached !== undefined) return { ...cached, ...window };
  try {
    const found = await details(display, window);
    known.set(window.id, found);
    return found;
  } catch {
    return null;
  }
}

const helperTypes = new Set([
  "TOOLTIP",
  "MENU",
  "POPUP_MENU",
  "DROPDOWN_MENU",
  "COMBO",
  "DND",
]);
const firstSeen = new Map<string, number>();

type Escape = WindowDetails & {
  kind: "dialog" | "bubble";
  parent: string | null;
  tab: string | null;
};

let cdp: Cdp | null = null;
async function browser(): Promise<Cdp> {
  if (cdp === null) cdp = await connectCdp(cdpPort);
  return cdp;
}

/** The page targets of the browser with the X11 window each is in: the one
 * window whose position, size and title match what Chrome reports. Several
 * matches name no window rather than a guess. */
async function tabWindows(
  windows: readonly WindowDetails[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let client: Cdp;
  try {
    client = await browser();
  } catch {
    cdp = null;
    return out;
  }
  const { targetInfos } = await client.send<{
    targetInfos: { targetId: string; type: string; title: string }[];
  }>("Target.getTargets");
  for (const target of targetInfos) {
    if (target.type !== "page") continue;
    const at = await windowForTarget(client, target.targetId).catch(() => null);
    if (at === null) continue;
    const { left, top, width, height } = at.bounds;
    const matches = windows.filter(
      (w) =>
        w.viewable &&
        !w.overrideRedirect &&
        w.x === left &&
        w.y === top &&
        w.width === width &&
        w.height === height &&
        w.name.startsWith(target.title),
    );
    if (matches.length === 1 && matches[0]) out.set(target.targetId, matches[0].id);
  }
  return out;
}

async function screenWindows(): Promise<WindowDetails[]> {
  const listed = await topLevels(display);
  const out: WindowDetails[] = [];
  for (const window of listed) {
    const found = await describe(window);
    if (found !== null) out.push(found);
  }
  const alive = new Set(listed.map((w) => w.id));
  for (const id of known.keys()) if (!alive.has(id)) known.delete(id);
  return out;
}

async function escapes(now = Date.now()): Promise<Escape[]> {
  const windows = await screenWindows();
  const tabs = await tabWindows(windows);
  const tabOf = new Map([...tabs].map(([tab, xid]) => [xid, tab]));
  const out: Escape[] = [];
  for (const w of windows) {
    if (!w.viewable || w.width < 50 || w.height < 50) continue;
    if (tabOf.has(w.id)) continue;
    const seen = firstSeen.get(w.id) ?? now;
    firstSeen.set(w.id, seen);
    if (!w.overrideRedirect && (w.type === "DIALOG" || w.transientFor !== null)) {
      const parent = w.transientFor;
      out.push({ ...w, kind: "dialog", parent, tab: parent ? (tabOf.get(parent) ?? null) : null });
    } else if (
      w.overrideRedirect &&
      !helperTypes.has(w.type ?? "") &&
      now - seen > 2_000
    ) {
      // A bubble: no parent property, so the tab is the one whose window it
      // lies over, if exactly one does.
      const under = windows.filter(
        (t) =>
          tabOf.has(t.id) &&
          w.x >= t.x &&
          w.y >= t.y &&
          w.x + w.width <= t.x + t.width &&
          w.y + w.height <= t.y + t.height,
      );
      const parent = under.length === 1 && under[0] ? under[0].id : null;
      out.push({ ...w, kind: "bubble", parent, tab: parent ? (tabOf.get(parent) ?? null) : null });
    }
  }
  return out;
}

/** Raises a tab's window and then its native windows, and focuses the
 * topmost of them, so the person's keys go there (without a window manager
 * nothing focuses a window on a click). */
async function focusTab(tab: string): Promise<{
  window: string | null;
  native: Escape[];
  rect: { x: number; y: number; width: number; height: number } | null;
}> {
  const windows = await screenWindows();
  const tabs = await tabWindows(windows);
  const xid = tabs.get(tab) ?? null;
  if (xid === null) return { window: null, native: [], rect: null };
  if (stackingBefore === null) stackingBefore = windows.map((w) => w.id);
  await raise(display, xid);
  const native = (await escapes()).filter((e) => e.parent === xid);
  for (const e of native) await raise(display, e.id);
  const top = native.at(-1)?.id ?? xid;
  await focus(display, top).catch(() => undefined);
  const parts = [windows.find((w) => w.id === xid), ...native].filter(
    (w): w is WindowDetails => w !== undefined,
  );
  const focusOn = native.length > 0 ? native : parts;
  const x = Math.min(...focusOn.map((w) => w.x));
  const y = Math.min(...focusOn.map((w) => w.y));
  return {
    window: xid,
    native,
    rect: {
      x,
      y,
      width: Math.max(...focusOn.map((w) => w.x + w.width)) - x,
      height: Math.max(...focusOn.map((w) => w.y + w.height)) - y,
    },
  };
}

/** Focuses the topmost viewable window at a point of the screen, unless it is
 * a bubble or menu (override-redirect), which takes no focus of its own. The
 * stacking before the first such change is kept for the release. */
async function focusAt(x: number, y: number): Promise<void> {
  const windows = await screenWindows();
  const hit = windows.find(
    (w) =>
      w.viewable &&
      w.width > 1 &&
      w.height > 1 &&
      x >= w.x &&
      y >= w.y &&
      x < w.x + w.width &&
      y < w.y + w.height,
  );
  if (hit === undefined || hit.overrideRedirect) return;
  if (stackingBefore === null) stackingBefore = windows.map((w) => w.id);
  await focus(display, hit.id);
}

// ---------------------------------------------------------------- http

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function file(path: string): Promise<Response> {
  try {
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(await readFile(path), {
      headers: {
        "Content-Type": types[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const host = new URL(origin).host;
const novnc = join(here, "node_modules/@novnc/novnc");

Bun.serve<Viewer>({
  hostname: "127.0.0.1",
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (request.headers.get("host") !== host)
      return new Response("Wrong host", { status: 421 });
    const changing = request.method !== "GET" && request.method !== "HEAD";
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if ((changing || upgrade) && request.headers.get("origin") !== origin)
      return new Response("Wrong origin", { status: 403 });
    const who =
      request.headers.get("x-auth-request-preferred-username") ?? "person";

    if (upgrade && url.pathname === "/rfb") {
      const id = url.searchParams.get("viewer") ?? "";
      if (!/^[a-z0-9]{16,64}$/.test(id) || viewers.has(id))
        return new Response("Bad viewer", { status: 400 });
      const ok = server.upgrade(request, {
        data: {
          id,
          who,
          lastMask: 0,
          chain: Promise.resolve(),
          rfb: null,
          queue: [],
          stream: new ClientStream(),
          held: new HeldInput(),
        },
        headers: request.headers.get("sec-websocket-protocol")?.includes("binary")
          ? { "Sec-WebSocket-Protocol": "binary" }
          : {},
      });
      return ok ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/") return file(join(here, "page.html"));
    if (url.pathname === "/page.js") return file(join(here, "page.js"));
    if (url.pathname === "/test") return file(join(here, "test-page.html"));
    if (url.pathname.startsWith("/novnc/")) {
      const rest = url.pathname.slice("/novnc/".length);
      if (!/^(core|vendor)\/[A-Za-z0-9_./-]+\.js$/.test(rest) || rest.includes(".."))
        return new Response("Not found", { status: 404 });
      return file(join(novnc, rest));
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      const viewer = url.searchParams.get("viewer");
      const person = await readPerson();
      return json({
        person,
        you: viewer !== null && holder === viewer && person !== null,
        agents: await activeAgents(),
        viewers: viewers.size,
      });
    }
    if (url.pathname === "/api/escapes" && request.method === "GET")
      return json({ escapes: await escapes() });
    if (changing) {
      const body = (await request.json().catch(() => ({}))) as {
        viewer?: unknown;
        tab?: unknown;
        window?: unknown;
      };
      const viewer = typeof body.viewer === "string" ? body.viewer : "";
      if (url.pathname === "/api/take" && viewers.has(viewer)) {
        await take(viewer, who);
        return json({ ok: true });
      }
      if (url.pathname === "/api/renew" && holder === viewer) {
        await holdForPerson(who);
        return json({ ok: true });
      }
      if (url.pathname === "/api/release") {
        await release(viewer);
        return json({ ok: true });
      }
      if (url.pathname === "/api/focus" && typeof body.tab === "string")
        return json(await focusTab(body.tab));
      // "Zavřít okno": only the holder, only a dialog the service itself found
      // outside a page, and only by the key a person would press (Escape on
      // the focused dialog), so the program decides what closing means.
      if (
        url.pathname === "/api/dismiss" &&
        holder === viewer &&
        typeof body.window === "string"
      ) {
        const found = (await escapes()).find(
          (e) => e.id === body.window && e.kind === "dialog",
        );
        if (found === undefined) return json({ ok: false }, 404);
        if (stackingBefore === null)
          stackingBefore = (await screenWindows()).map((w) => w.id);
        await raise(display, found.id);
        await focus(display, found.id);
        await pressKey(display, "Escape");
        return json({ ok: true });
      }
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      viewers.set(ws.data.id, ws);
      try {
        ws.data.rfb = await connectVnc(
          (chunk) => ws.sendBinary(chunk),
          () => ws.close(1011, "screen gone"),
        );
        for (const bytes of ws.data.queue) ws.data.rfb.write(bytes);
        ws.data.queue = [];
      } catch {
        ws.close(1011, "screen unavailable");
      }
    },
    message(ws, raw) {
      // One viewer's messages are handled one after another: a press that
      // waits for its focus must still reach the screen before its release.
      const chunk =
        typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw);
      ws.data.chain = ws.data.chain
        .then(() => handleMessage(ws, chunk))
        .catch(() => ws.close(1011, "gate error"));
    },
    async close(ws) {
      await ws.data.chain;
      await release(ws.data.id);
      ws.data.rfb?.end();
      viewers.delete(ws.data.id);
    },
  },
});

async function handleMessage(
  ws: ServerWebSocket<Viewer>,
  chunk: Uint8Array,
): Promise<void> {
      const messages = ws.data.stream.push(chunk);
      if ("error" in messages) {
        ws.close(1002, messages.error.slice(0, 120));
        return;
      }
      const inControl = holder === ws.data.id;
      let input = false;
      for (const message of messages) {
        const decision = verdict(message, inControl);
        if (decision.kind !== "pass") continue;
        const pressed =
          message.type === "pointer" &&
          (message.mask & 7) !== 0 &&
          ws.data.lastMask === 0;
        if (message.type === "pointer") ws.data.lastMask = message.mask & 7;
        if (message.type === "key" || message.type === "pointer") {
          ws.data.held.note(message);
          input = true;
        }
        // Without a window manager a click focuses nothing, so the person's
        // keys would go to whatever window Chrome focused last. A press
        // focuses the window under it first, as a window manager would.
        if (pressed && message.type === "pointer")
          await focusAt(message.x, message.y).catch(() => undefined);
        if (ws.data.rfb) ws.data.rfb.write(decision.bytes);
        else ws.data.queue.push(decision.bytes);
      }
      if (input) {
        const person = await readPerson();
        // Renew at most every 30 s of use.
        if (person !== null && person.until - Date.now() < 90_000)
          await holdForPerson(ws.data.who);
      }
}

console.log(`desktop prototype on ${origin} (screen ${display}, tabs from DevTools ${cdpPort})`);
