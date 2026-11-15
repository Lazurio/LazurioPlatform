/** The screen's top-level windows through the X11 tools Machines would
 * install (`x11-utils`, `xdotool`). The prototype runs them from a user-level
 * extraction (`fetch-tools.sh`); `LAZURIO_DESKTOP_TOOLS` names its root, and
 * without it the tools are taken from PATH.
 *
 * There is no window manager on the screen, so stacking is what X11 itself
 * keeps: `XRaiseWindow` moves a window to the top, nothing else moves it, and
 * the order of the root's children is the stacking order. */

import { homedir } from "node:os";
import { join } from "node:path";

export type TopLevel = {
  /** X11 window id, as `0x…`. */
  id: string;
  name: string;
  className: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowDetails = TopLevel & {
  viewable: boolean;
  overrideRedirect: boolean;
  /** `_NET_WM_WINDOW_TYPE` without its prefix: `DIALOG`, `NORMAL`, `MENU`… */
  type: string | null;
  transientFor: string | null;
  role: string | null;
  pid: number | null;
};

const toolRoot =
  process.env.LAZURIO_DESKTOP_TOOLS ??
  join(homedir(), ".local/opt/lazurio-desktop-prototype/root");

function tool(name: string): string {
  return process.env.LAZURIO_DESKTOP_TOOLS === ""
    ? name
    : join(toolRoot, "usr/bin", name);
}

function toolEnv(display: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.DISPLAY = display;
  if (process.env.LAZURIO_DESKTOP_TOOLS !== "")
    env.LD_LIBRARY_PATH = join(toolRoot, "usr/lib/x86_64-linux-gnu");
  return env;
}

async function run(
  display: string,
  name: string,
  args: string[],
): Promise<string> {
  const child = Bun.spawn([tool(name), ...args], {
    env: toolEnv(display),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${name} ${args.join(" ")}: ${err.trim()}`);
  return out;
}

const childLine =
  /^\s+(0x[0-9a-f]+) (?:"((?:[^"\\]|\\.)*)"|\(has no name\)): \((?:"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/;

/** The root's children, topmost first (xwininfo prints XQueryTree's
 * bottom-to-top list from the top). Unmapped windows are included. */
export async function topLevels(display: string): Promise<TopLevel[]> {
  const out = await run(display, "xwininfo", ["-root", "-children"]);
  const windows: TopLevel[] = [];
  for (const line of out.split("\n")) {
    const match = childLine.exec(line);
    if (match === null) continue;
    windows.push({
      id: match[1] ?? "",
      name: match[2] ?? "",
      className: match[4] ?? "",
      width: Number(match[5]),
      height: Number(match[6]),
      x: Number(match[7]),
      y: Number(match[8]),
    });
  }
  return windows;
}

function propValue(out: string, name: string): string | null {
  const line = out.split("\n").find((l) => l.startsWith(`${name}(`));
  if (line === undefined) return null;
  const at = line.indexOf(" = ");
  if (at >= 0) return line.slice(at + 3).trim();
  const hash = line.indexOf("# ");
  return hash >= 0 ? line.slice(hash + 2).trim() : null;
}

/** One window's map state, override-redirect and the properties that tell a
 * dialog from a tab's window. Two processes per window, so callers cache by
 * id: a window's type and transient parent do not change once mapped. */
export async function details(
  display: string,
  window: TopLevel,
): Promise<WindowDetails> {
  const [stats, props] = await Promise.all([
    run(display, "xwininfo", ["-id", window.id, "-stats"]),
    run(display, "xprop", [
      "-id",
      window.id,
      "_NET_WM_WINDOW_TYPE",
      "WM_TRANSIENT_FOR",
      "WM_WINDOW_ROLE",
      "_NET_WM_PID",
    ]).catch(() => ""),
  ]);
  const type = propValue(props, "_NET_WM_WINDOW_TYPE");
  const role = propValue(props, "WM_WINDOW_ROLE");
  const pid = propValue(props, "_NET_WM_PID");
  return {
    ...window,
    viewable: /Map State: IsViewable/.test(stats),
    overrideRedirect: /Override Redirect State: yes/.test(stats),
    type: type === null ? null : type.replace(/^_NET_WM_WINDOW_TYPE_/, ""),
    transientFor: propValue(props, "WM_TRANSIENT_FOR"),
    role: role === null ? null : role.replace(/^"|"$/g, ""),
    pid: pid === null ? null : Number(pid),
  };
}

export async function raise(display: string, id: string): Promise<void> {
  await run(display, "xdotool", ["windowraise", id]);
}

export async function focus(display: string, id: string): Promise<void> {
  await run(display, "xdotool", ["windowfocus", id]);
}

/** A key pressed on the screen's real keyboard (XTEST), to the focused
 * window: what a person would press, never a synthetic event a program may
 * ignore. Only for a person who holds the screen. */
export async function pressKey(display: string, key: string): Promise<void> {
  await run(display, "xdotool", ["key", "--clearmodifiers", key]);
}

export async function focused(display: string): Promise<string> {
  const out = await run(display, "xdotool", ["getwindowfocus"]);
  return `0x${Number(out.trim()).toString(16)}`;
}

export async function pointer(
  display: string,
): Promise<{ x: number; y: number }> {
  const out = await run(display, "xdotool", ["getmouselocation"]);
  const match = /x:(-?\d+) y:(-?\d+)/.exec(out);
  return { x: Number(match?.[1]), y: Number(match?.[2]) };
}

/** Puts the windows back in a stacking recorded earlier (topmost first):
 * raising each from the bottom up rebuilds the order. Windows that are gone
 * are skipped, and windows that appeared since are raised again after, in
 * their own order, so they stay on top. Positions and sizes are never
 * touched. */
export async function restack(
  display: string,
  recorded: readonly string[],
): Promise<void> {
  const now = (await topLevels(display)).map((w) => w.id);
  const alive = new Set(now);
  const before = new Set(recorded);
  for (const id of [...recorded].reverse())
    if (alive.has(id)) await raise(display, id).catch(() => undefined);
  for (const id of now.filter((id) => !before.has(id)).reverse())
    await raise(display, id).catch(() => undefined);
}
