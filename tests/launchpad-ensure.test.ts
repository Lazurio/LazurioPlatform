import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import {
  type HostedOptions,
  isLocalEnsure,
  localEnsureMayStart,
  localEnsureModeHeader,
  startLaunchpad,
} from "../src/launchpad/server";
import { runModuleCommand } from "../src/modules/module-cli";
import type { ModuleHost } from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
import { applicationUnitName } from "../src/modules/systemd-user-runner";
import type { CliContext } from "../src/update/cli";
import { folderFixture, writeOrganization } from "./fixtures/catalog-folder";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";
import { organizationWithEntry } from "./fixtures/machine-bindings";
import { compilePlatform, linuxHost, runnable } from "./fixtures/module-host";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import { freePort } from "./fixtures/ports";

// The gateway's `ensure` (launchpad-parity B5, slice P6): a browser opens a
// module's hostname, the Machines gateway asks the Launchpad to make the
// module's default app run, and proxies the browser only on 204. Answered by
// the same module core as `lazurio module start|status`. The Linux path runs
// against the in-memory user manager; the session path starts a real
// synthetic app under the compiled process guard. Synthetic names only.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "launchpad-ensure-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const cookieName = "__Secure-lazurio-workspace";
const fetcher: AuthFetcher = async (_url, init) =>
  new Headers(init.headers).get("cookie") === `${cookieName}=valid`
    ? new Response("ok")
    : new Response("no", { status: 401 });

function cliContext(home: string): CliContext {
  return {
    identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
    platform: process.platform,
    env: { HOME: home },
    executable: join(home, "lazurio"),
    hostedFolder: async () => undefined,
  };
}

// A hosted Folder with its recorded entry: gamma holds a runnable module
// `notes`, a module whose default app is invalid while a second declared app
// is valid (`board`) and an app-less one (`memo`); delta and epsilon both
// declare `shared`, which the gateway serves at one hostname.
async function hostedFolder(parent: string) {
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-organization-personal";
  const machine = organizationWithEntry(freePort());
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const gamma = await writeOrganization(folder, "gamma", {
    slug: "gamma",
    state: "current",
    modules: [
      { id: "notes" },
      { id: "slow" },
      { id: "board", broken: true },
      { id: "memo", apps: false },
    ],
  });
  // board: a second declared app with a valid runtime next to the invalid
  // default; ensure must never fall back to it.
  const board = join(gamma, "workspace", "board");
  const manifest = JSON.parse(
    await readFile(join(board, "lazurio.module.json"), "utf8"),
  );
  manifest.apps = ["app/package.json", "tools/package.json"];
  await writeFile(join(board, "lazurio.module.json"), JSON.stringify(manifest));
  const notes = JSON.parse(
    await readFile(
      join(gamma, "workspace", "notes", "app", "package.json"),
      "utf8",
    ),
  );
  notes.lazurio.runtime.id = "board-tools";
  notes.lazurio.runtime.module = "board";
  await mkdir(join(board, "tools"));
  await writeFile(join(board, "tools", "package.json"), JSON.stringify(notes));
  for (const directory of ["delta", "epsilon"])
    await writeOrganization(folder, directory, {
      slug: directory,
      state: "current",
      modules: [{ id: "shared" }],
    });
  return { folder, entry, gamma };
}

type Entry = Awaited<ReturnType<typeof hostedFolder>>["entry"];
const launchpadHost = "launchpad.workspace.example.lazurio.io";

// The subrequest the Machines gateway makes after the switch, header for
// header (M:workloads/workspace-vm/ingress.ts:124-138, Machines ab84f38):
// `method GET`; `rewrite /api/internal/hosted/modules/{args[2]}/ensure?` (the
// exact module id, an empty query); `Origin` the Launchpad's origin;
// `Sec-Fetch-Site: same-origin`; only the session cookie (and its chunks,
// absent here); no Authorization, DPoP, Connection, Upgrade or
// Sec-WebSocket-*; the browser's own Sec-Fetch-Mode and Sec-Fetch-Dest kept.
// The one change M2 makes (launchpad-parity C.2 step 7, F22 point 3): `Host`
// is the Launchpad's hostname instead of `127.0.0.1:<port>`. `null` drops a
// header, to prove each one matters.
function gateway(entry: Entry) {
  return async (
    id: string,
    change: Record<string, string | null> = {},
    method = "GET",
  ) => {
    const headers: Record<string, string> = {
      host: launchpadHost,
      origin: entry.externalOrigin,
      "sec-fetch-site": "same-origin",
      cookie: `${cookieName}=valid`,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    for (const [name, value] of Object.entries(change))
      if (value === null) delete headers[name];
      else headers[name] = value;
    const response = await fetch(
      `http://127.0.0.1:${entry.listenPort}/api/internal/hosted/modules/${id}/ensure?`,
      { method, headers },
    );
    const text = await response.text();
    return {
      code: response.status,
      text,
      body: text === "" ? null : JSON.parse(text),
    };
  };
}

posixTest(
  "ensure on the Linux path: the gateway's exact subrequest, one Host rule, the default app only, typed refusals and the wire statuses the gateway reads",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "linux-")));
    const { folder, entry, gamma } = await hostedFolder(parent);
    const port = await runnable(folder, "gamma", "notes");
    const home = join(parent, "home");
    await mkdir(home);
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, port, binary);
    const cli = async (...args: string[]) =>
      (
        await runModuleCommand(
          ["module", ...args, "--folder", folder, "--json"],
          cliContext(home),
          host,
        )
      ).result;
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher, ensureWaitMs: 10_000 },
      undefined,
      {},
      undefined,
      host,
    );
    const ensure = gateway(entry);
    try {
      // Admission. Today's gateway sends a loopback Host (the resident's
      // rule); the Platform admits only its entry's Host, on every route, so
      // that subrequest is refused until M2 changes the one gateway line.
      const denied = async (
        change: Record<string, string | null>,
        reason: string,
      ) =>
        expect(await ensure("notes", change)).toEqual({
          code: 401,
          text: JSON.stringify({ error: "denied", reason }),
          body: { error: "denied", reason },
        });
      await denied({ host: `127.0.0.1:${entry.listenPort}` }, "host-mismatch");
      // The browser's module Host, which the gateway must not forward here.
      await denied(
        { host: "notes.workspace.example.lazurio.io" },
        "host-mismatch",
      );
      // A GET, but a lifecycle mutation: the same-origin rule applies.
      await denied({ origin: null }, "origin-mismatch");
      await denied(
        { origin: "https://notes.workspace.example.lazurio.io" },
        "origin-mismatch",
      );
      await denied({ "sec-fetch-site": null }, "origin-mismatch");
      await denied({ cookie: null }, "cookie-missing");
      await denied({ cookie: `${cookieName}=forged` }, "auth-denied");
      // Every browser route keeps its rule: an admitted GET read needs no
      // Origin, a POST still does.
      const base = `http://127.0.0.1:${entry.listenPort}`;
      const browser = { host: launchpadHost, cookie: `${cookieName}=valid` };
      expect(
        (
          await fetch(`${base}/api/modules/gamma/notes/status`, {
            headers: browser,
          })
        ).status,
      ).toBe(200);
      expect((await fetch(`${base}/`, { headers: browser })).status).toBe(200);
      expect(
        (
          await fetch(`${base}/api/modules/gamma/notes/start`, {
            method: "POST",
            headers: { ...browser, "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(401);
      expect(manager.commands("systemd-run")).toEqual([]);

      // The id names no module, no valid id, or a module that cannot run:
      // 404, which the gateway shows as "not available here".
      expect(await ensure("nothing")).toMatchObject({
        code: 404,
        body: {
          kind: "blocked",
          operation: "ensure",
          reason: "module-unknown",
          module: "nothing",
        },
      });
      for (const invalid of ["Notes", "-notes", "no%2Fte", "%ZZ"])
        expect(await ensure(invalid), invalid).toEqual({
          code: 404,
          text: JSON.stringify({
            kind: "blocked",
            operation: "ensure",
            reason: "module-unknown",
          }),
          body: {
            kind: "blocked",
            operation: "ensure",
            reason: "module-unknown",
          },
        });
      expect(await ensure("memo")).toMatchObject({
        code: 404,
        body: { operation: "ensure", reason: "no-app", organization: "gamma" },
      });
      // board's default app is invalid; its other declared app is valid and
      // is never started instead.
      expect(await ensure("board")).toMatchObject({
        code: 404,
        body: { operation: "ensure", reason: "default-app-invalid" },
      });
      // Two Organizations declare the id; the gateway serves one hostname
      // for both: none is guessed. 409, which the gateway shows as "could
      // not be prepared".
      expect(await ensure("shared")).toEqual({
        code: 409,
        text: expect.any(String),
        body: {
          kind: "blocked",
          operation: "ensure",
          reason: "module-ambiguous",
          module: "shared",
          candidates: ["delta", "epsilon"],
        },
      });
      expect(manager.commands("systemd-run")).toEqual([]);

      // A background fetch or a WebSocket reconnect to a stopped module only
      // reports: 503 "starting", nothing starts.
      const stopped = {
        kind: "module",
        operation: "ensure",
        organization: "gamma",
        module: "notes",
        app: "app/package.json",
        runner: "systemd-user",
        survivesLaunchpadRestart: true,
        outcome: "not-managed",
        state: "stopped",
        healthy: false,
        service: null,
        runtime: null,
      };
      expect(await ensure("notes", { "sec-fetch-mode": "cors" })).toMatchObject(
        { code: 503, body: stopped },
      );
      expect(
        await ensure("notes", {
          "sec-fetch-mode": "websocket",
          "sec-fetch-dest": "empty",
        }),
      ).toMatchObject({ code: 503, body: stopped });
      expect(
        await ensure("notes", {
          "sec-websocket-key": "x3JJHMbDL1EzLkh9GBhXDw==",
        }),
      ).toMatchObject({ code: 503, body: stopped });
      expect(manager.commands("systemd-run")).toEqual([]);

      // A navigation is an Open: the default app starts, and the answer is
      // 204 with no body once it reports healthy.
      expect(await ensure("notes")).toEqual({
        code: 204,
        text: "",
        body: null,
      });
      const unit = applicationUnitName(gamma, {
        company: "gamma",
        module: "notes",
        package: "app/package.json",
      });
      expect(manager.commands("systemd-run")).toHaveLength(1);
      // `lazurio module status` shows what ensure started, with the link
      // from the recorded entry.
      const status = await cli("status", "gamma/notes");
      expect(status).toMatchObject({
        kind: "module",
        state: "running",
        healthy: true,
        service: { unit },
        runtime: { url: "https://notes.workspace.example.lazurio.io/" },
      });
      // Already running: every request of the page, background or not, is
      // 204, and nothing starts again.
      for (const change of [
        { "sec-fetch-mode": "cors" },
        { "sec-fetch-mode": null },
        {},
      ])
        expect(await ensure("notes", change)).toMatchObject({ code: 204 });
      expect(manager.commands("systemd-run")).toHaveLength(1);
      // Only GET.
      expect((await ensure("notes", {}, "POST")).code).toBe(405);

      // An explicitly stopped module starts again on the next navigation
      // (Fetch Metadata absent counts as one).
      expect(await cli("stop", "gamma/notes")).toMatchObject({
        outcome: "group-stopped",
      });
      expect(
        await ensure("notes", {
          "sec-fetch-mode": null,
          "sec-fetch-dest": null,
        }),
      ).toMatchObject({ code: 204 });
      expect(manager.commands("systemd-run")).toHaveLength(2);
      // board's second app never ran: every unit is notes'.
      expect(
        manager
          .commands("systemd-run")
          .every((call) => call.args.some((arg) => arg.includes(unit))),
      ).toBe(true);
      await cli("stop", "gamma/notes");
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

// LazurioPlatform#504 (F39's addendum of 2026-10-18): the Environment browser
// never holds a Lazurio session, so the gateway's loopback entry for it
// (`entry.browser.local_port`, Machines) asks `ensure` without one: a
// loopback Host naming the Launchpad's listener, no Origin and no Fetch
// Metadata, the browser's mode passed on in `X-Lazurio-Fetch-Mode`. Anything
// that looks like a browser, or names another Host, goes through the
// admission as before and is refused without a session.
posixTest(
  "the loopback entry's readiness call: ensure without a session only from loopback, with a loopback Host and no Origin or Fetch Metadata",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "local-")));
    const { folder, entry } = await hostedFolder(parent);
    const port = await runnable(folder, "gamma", "notes");
    const home = join(parent, "home");
    await mkdir(home);
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, port, binary);
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher, ensureWaitMs: 10_000 },
      undefined,
      {},
      undefined,
      host,
    );
    const loopback = `127.0.0.1:${entry.listenPort}`;
    const local = async (
      id: string,
      headers: Record<string, string>,
      method = "GET",
    ) => {
      const response = await fetch(
        `http://127.0.0.1:${entry.listenPort}/api/internal/hosted/modules/${id}/ensure?`,
        { method, headers },
      );
      const text = await response.text();
      return {
        code: response.status,
        body: text === "" ? null : JSON.parse(text),
      };
    };
    try {
      // Anything a browser sends, or another Host: the admission, which a
      // request without the session never passes.
      for (const [headers, reason] of [
        [{ host: loopback, origin: entry.externalOrigin }, "host-mismatch"],
        [{ host: loopback, "sec-fetch-site": "same-origin" }, "host-mismatch"],
        [{ host: loopback, "sec-fetch-mode": "navigate" }, "host-mismatch"],
        [{ host: loopback, "Sec-Fetch-Dest": "document" }, "host-mismatch"],
        [{ host: "notes.workspace.example.lazurio.io" }, "host-mismatch"],
        [{ host: `attacker.example:${entry.listenPort}` }, "host-mismatch"],
        [{ host: "127.0.0.1:1" }, "host-mismatch"],
        [{ host: launchpadHost }, "origin-mismatch"],
      ] as const)
        expect(await local("notes", headers), JSON.stringify(headers)).toEqual({
          code: 401,
          body: { error: "denied", reason },
        });
      expect(manager.commands("systemd-run")).toEqual([]);

      // The readiness call: a background request passed on as such only
      // reports; a WebSocket upgrade never starts anything.
      expect(
        await local("notes", {
          host: loopback,
          "x-lazurio-fetch-mode": "cors",
        }),
      ).toMatchObject({ code: 503, body: { state: "stopped" } });
      expect(
        await local("notes", {
          host: `localhost:${entry.listenPort}`,
          "sec-websocket-key": "x3JJHMbDL1EzLkh9GBhXDw==",
        }),
      ).toMatchObject({ code: 503 });
      expect(manager.commands("systemd-run")).toEqual([]);
      // The same typed answers as the gateway's.
      expect(await local("nothing", { host: loopback })).toMatchObject({
        code: 404,
        body: { reason: "module-unknown" },
      });
      expect((await local("notes", { host: loopback }, "POST")).code).toBe(405);
      // No mode at all, or an empty one, is no browser's navigation: it
      // only reports, never an Open.
      for (const headers of [
        { host: loopback },
        { host: loopback, "x-lazurio-fetch-mode": "" },
      ])
        expect(
          await local("notes", headers),
          JSON.stringify(headers),
        ).toMatchObject({ code: 503, body: { state: "stopped" } });
      expect(manager.commands("systemd-run")).toEqual([]);
      // A navigation passed on is an Open; once running, every call is 204.
      expect(
        await local("notes", {
          host: loopback,
          "x-lazurio-fetch-mode": "navigate",
        }),
      ).toEqual({ code: 204, body: null });
      expect(manager.commands("systemd-run")).toHaveLength(1);
      expect(await local("notes", { host: loopback })).toEqual({
        code: 204,
        body: null,
      });
      expect(manager.commands("systemd-run")).toHaveLength(1);
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

// Machines#633 (head 1c3b4e54), the local entry's twin of `lazurio_module`:
// the request the Launchpad receives, header for header. Caddy's
// `reverse_proxy 127.0.0.1:<port>` from loopback, `method GET`, `rewrite
// /api/internal/hosted/modules/{args[2]}/ensure?`, `header_up Host
// 127.0.0.1:<port>`, `-Origin`, `-Sec-Fetch-*`, `-Cookie`, `-Authorization`,
// `-DPoP`, `-Connection`, `-Upgrade`, `-Sec-WebSocket-*`; the browser's other
// headers pass (User-Agent, Accept, Client Hints, Caddy's X-Forwarded-*), and
// `X-Lazurio-Fetch-Mode` carries the browser's Sec-Fetch-Mode only when it
// sent one. Nothing of the browser's session or Fetch Metadata reaches it.
function machines633(
  entry: Entry,
  mode: string | null,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    host: `127.0.0.1:${entry.listenPort}`,
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "cs-CZ,cs;q=0.9",
    "accept-encoding": "gzip, deflate, br, zstd",
    "sec-ch-ua": '"Chromium";v="155", "Not.A/Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "upgrade-insecure-requests": "1",
    priority: "u=0, i",
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-host": "notes.workspace.example.lazurio.io",
    "x-forwarded-proto": "https",
    ...(mode === null ? {} : { "x-lazurio-fetch-mode": mode }),
    ...extra,
  };
  return fetch(
    `http://127.0.0.1:${entry.listenPort}/api/internal/hosted/modules/notes/ensure?`,
    { method: "GET", headers },
  );
}

posixTest(
  "Machines#633's exact readiness request: a navigation starts the module; no mode, a background mode or a socket only report; anything a browser adds is refused",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "m633-")));
    const { folder, entry } = await hostedFolder(parent);
    const port = await runnable(folder, "gamma", "notes");
    const home = join(parent, "home");
    await mkdir(home);
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, port, binary);
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher, ensureWaitMs: 10_000 },
      undefined,
      {},
      undefined,
      host,
    );
    const status = async (response: Promise<Response>) => {
      const answer = await response;
      await answer.body?.cancel();
      return answer.status;
    };
    try {
      // Without the browser's mode (curl in the Environment), with a
      // background fetch, a WebSocket's mode or a module's subresource: 503,
      // nothing starts.
      for (const mode of [null, "cors", "no-cors", "same-origin", "websocket"])
        expect(await status(machines633(entry, mode)), String(mode)).toBe(503);
      expect(manager.commands("systemd-run")).toEqual([]);
      // What the twin removes, if it ever arrived, sends the request through
      // the admission, which it does not pass.
      for (const extra of [
        { origin: "https://notes.workspace.example.lazurio.io" },
        { "sec-fetch-site": "same-origin" },
        { "sec-fetch-mode": "navigate" },
        { "sec-fetch-dest": "document" },
      ])
        expect(
          await status(machines633(entry, "navigate", extra)),
          JSON.stringify(extra),
        ).toBe(401);
      expect(manager.commands("systemd-run")).toEqual([]);
      // The browser's top-level navigation: the module starts, 204.
      expect(await status(machines633(entry, "navigate"))).toBe(204);
      expect(manager.commands("systemd-run")).toHaveLength(1);
      // Running: every call continues, nothing starts again.
      for (const mode of [null, "cors", "navigate"])
        expect(await status(machines633(entry, mode)), String(mode)).toBe(204);
      expect(manager.commands("systemd-run")).toHaveLength(1);
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

posixTest(
  "ensure with a chunked session (a personal VM's large session): the gateway's chunks admit it and reach the auth endpoint unchanged; a gap is refused",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "chunked-")));
    const { folder, entry } = await hostedFolder(parent);
    const port = await runnable(folder, "gamma", "notes");
    const home = join(parent, "home");
    await mkdir(home);
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, port, binary);
    // The gateway forwards the whole cookie and `_0…_3`, dropping every
    // absent one (M:workloads/workspace-vm/ingress.ts:73-92); here the
    // session is split in two. The auth endpoint's oauth2-proxy reassembles
    // the chunks itself, so only the chunks, never a re-joined cookie, pass.
    const session = `${cookieName}_0=va; ${cookieName}_1=lid`;
    const forwarded: (string | null)[] = [];
    const chunkedFetcher: AuthFetcher = async (_url, init) => {
      const cookie = new Headers(init.headers).get("cookie");
      forwarded.push(cookie);
      return cookie === session
        ? new Response("ok")
        : new Response("no", { status: 401 });
    };
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher: chunkedFetcher, ensureWaitMs: 10_000 },
      undefined,
      {},
      undefined,
      host,
    );
    const ensure = gateway(entry);
    try {
      const denied = async (cookie: string, reason: string) =>
        expect(await ensure("notes", { cookie })).toEqual({
          code: 401,
          text: JSON.stringify({ error: "denied", reason }),
          body: { error: "denied", reason },
        });
      await denied(`${cookieName}_0=va; ${cookieName}_2=lid`, "cookie-invalid");
      await denied(`${cookieName}_1=lid`, "cookie-missing");
      expect(forwarded).toEqual([]);
      expect(manager.commands("systemd-run")).toEqual([]);
      // The navigation is admitted and starts the default app: 204.
      expect(await ensure("notes", { cookie: session })).toEqual({
        code: 204,
        text: "",
        body: null,
      });
      expect(forwarded).toEqual([session]);
      expect(manager.commands("systemd-run")).toHaveLength(1);
      // The browser's own Launchpad route admits the same session.
      expect(
        (
          await fetch(`http://127.0.0.1:${entry.listenPort}/`, {
            headers: { host: launchpadHost, cookie: session },
          })
        ).status,
      ).toBe(200);
      await runModuleCommand(
        ["module", "stop", "gamma/notes", "--folder", folder, "--json"],
        cliContext(home),
        host,
      );
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

posixTest(
  "ensure timing and refusals: a start still running answers 503 and goes on, concurrent navigations start once, a refused start is 409 with the start's reason",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "timing-")));
    const { folder, entry } = await hostedFolder(parent);
    // The declared start check takes about a second and a half.
    const port = await runnable(
      folder,
      "gamma",
      "slow",
      "await Bun.sleep(1500); process.exit(0);",
    );
    const home = join(parent, "home");
    await mkdir(home);
    const manager = createFakeServiceManager({
      runtimeDirectory: join(parent, "runtime"),
    });
    await mkdir(manager.runtimeDirectory);
    const host = linuxHost(manager, home, port, binary);
    const launchpad = (moduleHost: ModuleHost, hosted: HostedOptions) =>
      startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        hosted,
        undefined,
        {},
        undefined,
        moduleHost,
      );
    const ensure = gateway(entry);
    // Without the operator's Bun the start is refused before any effect: the
    // refusal names the operation that refused, `start`.
    const bare = await launchpad(
      { ...host, bunExecutable: join(home, "missing-bun") },
      { fetcher },
    );
    try {
      expect(await ensure("slow")).toMatchObject({
        code: 409,
        body: {
          kind: "blocked",
          operation: "start",
          reason: "toolchain-missing",
          module: "slow",
        },
      });
      expect(manager.commands("systemd-run")).toEqual([]);
    } finally {
      await bare.close();
    }
    const app = await launchpad(host, { fetcher, ensureWaitMs: 300 });
    try {
      // Two navigations at once, answered within the wait: 503 "starting"
      // while the declared check runs; one start serves both.
      const [first, second] = await Promise.all([
        ensure("slow"),
        ensure("slow"),
      ]);
      for (const answer of [first, second])
        expect(answer).toMatchObject({
          code: 503,
          body: {
            kind: "module",
            operation: "ensure",
            module: "slow",
            outcome: "start-pending",
            healthy: false,
          },
        });
      // The start goes on after the answer; the gateway's "starting" page
      // reloads every 2 s until one answer is 204.
      let answer = await ensure("slow", { "sec-fetch-mode": "cors" });
      for (let attempt = 0; attempt < 50 && answer.code !== 204; attempt++) {
        await Bun.sleep(100);
        answer = await ensure("slow", { "sec-fetch-mode": "cors" });
      }
      expect(answer.code).toBe(204);
      expect(manager.commands("systemd-run")).toHaveLength(1);
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
    }
    // A slow declared check that fails after the start's install, with no
    // prepare_script to run (decision F34): navigations that arrive while it
    // runs join that one start and share its refusal, 409 with the start's
    // reason (the gateway shows "could not be prepared"); the check ran once,
    // not once per queued request.
    const ran = join(parent, "check-runs");
    await runnable(
      folder,
      "gamma",
      "notes",
      `await Bun.sleep(700); require("node:fs").appendFileSync(${JSON.stringify(ran)}, "x"); process.exit(1);`,
    );
    const waiting = await launchpad(host, { fetcher });
    try {
      const answers = await Promise.all([
        ensure("notes"),
        ensure("notes"),
        ensure("notes"),
      ]);
      for (const refused of answers)
        expect(refused).toMatchObject({
          code: 409,
          body: {
            kind: "blocked",
            operation: "start",
            reason: "prerequisites-not-ready",
            module: "notes",
          },
        });
      expect(await readFile(ran, "utf8")).toBe("x");
      expect(manager.commands("systemd-run")).toHaveLength(1);
    } finally {
      expect(await waiting.close()).toEqual({ kind: "closed" });
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

posixTest(
  "ensure on the session path: a navigation starts the default app as the Launchpad's child and answers 204 once it serves",
  async () => {
    const parent = await realpath(await mkdtemp(join(root, "session-")));
    const { folder, entry } = await hostedFolder(parent);
    const port = await runnable(folder, "gamma", "notes");
    const home = join(parent, "home");
    await mkdir(home);
    const host: ModuleHost = {
      platform: "darwin",
      home,
      path: "/usr/bin:/bin",
      runtimeDirectory: undefined,
      platformExecutable: binary,
      bunExecutable: process.execPath,
      runnerKind: async () => "session",
      createRunner: () => createSessionRunner(binary),
      readJournal: async () => {
        throw new Error("A session app has no journal");
      },
    };
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher, ensureWaitMs: 15_000 },
      undefined,
      {},
      undefined,
      host,
    );
    let closed = false;
    try {
      const ensure = gateway(entry);
      expect(await ensure("notes", { "sec-fetch-mode": "cors" })).toMatchObject(
        { code: 503, body: { runner: "session", state: "stopped" } },
      );
      expect(await ensure("notes")).toEqual({
        code: 204,
        text: "",
        body: null,
      });
      // What the gateway proxies to on 204: the module's declared port.
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
        "synthetic module",
      );
      expect(await ensure("notes", { "sec-fetch-mode": "cors" })).toMatchObject(
        { code: 204 },
      );
      expect(await app.close()).toEqual({ kind: "closed" });
      closed = true;
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      if (!closed) await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

posixTest(
  "a workstation Launchpad has no ensure: no module hostnames, 404 behind its own admission",
  async () => {
    await folderFixture(async (folder) => {
      const home = join(folder, "..", "home");
      await mkdir(home);
      const manager = createFakeServiceManager({
        runtimeDirectory: join(folder, "..", "runtime"),
      });
      const app = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        {},
        undefined,
        linuxHost(manager, home, 1, binary),
      );
      try {
        const url = new URL(app.url);
        const response = await fetch(
          `${url.origin}/api/internal/hosted/modules/web/ensure`,
          { headers: { Authorization: `Bearer ${url.hash.slice(1)}` } },
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not-found" });
        expect(manager.calls).toEqual([]);
      } finally {
        await app.close();
      }
    });
  },
  30_000,
);

test("a local ensure is only a loopback peer with a loopback Host of this listener and nothing a browser sends", () => {
  const local = (headers: Record<string, string>, peer: string | null) =>
    isLocalEnsure({ headers: new Headers(headers), peer }, 4100);
  for (const host of ["127.0.0.1:4100", "localhost:4100", "[::1]:4100"])
    for (const peer of ["127.0.0.1", "127.0.1.1", "::1", "::ffff:127.0.0.1"])
      expect(local({ host }, peer), `${host} ${peer}`).toBe(true);
  // Not loopback, or not known.
  for (const peer of ["10.90.0.2", "::ffff:10.0.0.1", "fe80::1", null])
    expect(local({ host: "127.0.0.1:4100" }, peer), String(peer)).toBe(false);
  // Another Host: the Launchpad's own, a module's, another port, none.
  for (const host of [
    "launchpad.workspace.example.lazurio.io",
    "notes.workspace.example.lazurio.io",
    "127.0.0.1:4101",
    "127.0.0.1",
  ])
    expect(local({ host }, "127.0.0.1"), host).toBe(false);
  expect(local({}, "127.0.0.1")).toBe(false);
  // Origin or any Fetch Metadata.
  for (const extra of [
    { origin: "null" },
    { "sec-fetch-site": "none" },
    { "sec-fetch-mode": "navigate" },
    { "sec-fetch-dest": "document" },
    { "sec-fetch-user": "?1" },
    { "sec-fetch-storage-access": "none" },
  ])
    expect(
      local({ host: "127.0.0.1:4100", ...extra }, "127.0.0.1"),
      JSON.stringify(extra),
    ).toBe(false);
  // The browser's mode, passed on: only a navigation, or none, may start.
  const may = (headers: Record<string, string>) =>
    localEnsureMayStart(new Headers(headers));
  expect(may({})).toBe(false);
  expect(may({ [localEnsureModeHeader]: "" })).toBe(false);
  expect(may({ [localEnsureModeHeader]: "navigate" })).toBe(true);
  expect(may({ [localEnsureModeHeader]: "cors" })).toBe(false);
  expect(may({ [localEnsureModeHeader]: "websocket" })).toBe(false);
  expect(may({ "sec-websocket-key": "x" })).toBe(false);
});
