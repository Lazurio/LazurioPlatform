import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { type HostedOptions, startLaunchpad } from "../src/launchpad/server";
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

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  return port;
};

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
    // prepare_script to run (decision F30): navigations that arrive while it
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
