# Desktop prototype (F74, proposed)

The Environment's whole screen in a web page, for the windows the browser view cannot show: a
GTK dialog nothing intercepted, the print preview, a bubble, another program's window. The
design and its open choices are [F74](../../docs/decisions.md#f74--the-desktop-of-a-remote-environment-the-escape-for-the-windows-the-browser-view-cannot-show).

This is a prototype: it runs from a worktree on a loopback port of its own and touches no unit of
the Environment. Nothing here is installed, wired into `lazurio`, or released.

| File | What it does |
| --- | --- |
| `serve.ts` | The desktop service: page, noVNC, the gated WebSocket to x11vnc, the lease, `POST /api/focus`, `GET /api/escapes`, `POST /api/dismiss` |
| `rfb-gate.ts` | Reads the client half of RFB; keys, pointer and paste pass only for the viewer who holds the screen |
| `turn.ts` | The lease of a person and the agents' last input, in one owner-only directory |
| `computer-gate.ts` | A pass-through in front of `cua-driver mcp` that refuses input tools while a person holds the screen |
| `windows.ts` | The screen's windows through `xwininfo`, `xprop` and `xdotool`: list, raise, focus, restore stacking |
| `cdp.ts` | A minimal DevTools client: which window holds a tab |
| `page.html`, `page.js` | The page: who holds the screen, take and release, whole screen or 1:1, the windows outside the page |
| `test-page.html` | A file input in a frame and on the page, and `window.print()` |
| `check.ts` | The live check on the screen, end to end (below) |
| `gates.test.ts` | Tests of both gates |
| `fetch-tools.sh` | Downloads Ubuntu's `x11vnc`, `xdotool` and `x11-utils` and extracts them into `~/.local/opt`, without root |

## Run

```sh
sh fetch-tools.sh        # once: the X11 tools into ~/.local/opt/lazurio-desktop-prototype
bun install              # noVNC 1.7.0
bun test                 # the gates
bun check.ts             # the live check; --shots <dir> keeps its screenshots
bun serve.ts --port 4871 --origin http://127.0.0.1:4871 --cdp <DevTools port of the browser whose tabs it finds>
```

`check.ts` starts a Chrome for Testing of its own on `:1` (temporary profile, own DevTools port,
no Lazurio extension), the service, and a headless Chrome off the screen for the person's page.
It sends input to the screen once, after it saw the pointer still for two seconds, and stops
everything it started. Its screenshots show the whole screen, other threads' windows included:
keep them out of this repository.

x11vnc never listens: `systemd-socket-activate` (part of systemd, run as the user) listens on a
unix socket in an owner-only directory and starts one `x11vnc -inetd` per connection. A listening
x11vnc opened a TCP port on every interface on this Ubuntu even when told not to; see F74.

## Third-party

- noVNC 1.7.0 (`@novnc/novnc`), MPL-2.0, served unchanged from `node_modules`.
- x11vnc 0.9.16 (GPL-2.0), xdotool (BSD-3-Clause) and x11-utils (MIT/X11) from Ubuntu's archive,
  extracted locally by `fetch-tools.sh`, never committed.
