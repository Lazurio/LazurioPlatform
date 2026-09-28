import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { parseMachineEntry } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import {
  startOrRecover,
  startRecoveryMode,
} from "../src/launchpad/recovery-mode";
import { startLaunchpad } from "../src/launchpad/server";
import {
  checkBundledPage,
  LaunchpadStartRefused,
} from "../src/launchpad/start-check";
import { launchpadHealth } from "../src/update/service-control";
import { bindings } from "./fixtures/machine-bindings";

// Recovery mode (docs/update.md "Recovery mode"): a start refused on a
// condition the executable can name is served, not exited — on the same port,
// as the Recovery page (plain text when the page does not serve), with a typed
// refusal on every other API route and 503 on the health socket, which every
// updater reads as "not healthy". The page itself: launchpad-recovery-page.

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

// A socket path is short on macOS: /tmp, not the long per-user tmpdir.
const scratch = async (prefix: string) =>
  realpath(
    await mkdtemp(
      join(process.platform === "darwin" ? "/tmp" : tmpdir(), prefix),
    ),
  );

async function localFolder() {
  const parent = await scratch("lp-rec-");
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  return { parent, folder, state: join(folder, ".lazurio") };
}

const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) =>
      error instanceof LaunchpadStartRefused
        ? { reason: error.reason, entry: error.entry }
        : error,
  );

test.skipIf(process.platform === "win32")(
  "every condition the start can name refuses it by name, before anything listens",
  async () => {
    const { parent, folder, state } = await localFolder();
    try {
      // An interrupted Folder change.
      await mkdir(join(state, "transaction"));
      expect(await refusalOf(startLaunchpad(folder))).toEqual({
        reason: "folder-transaction-pending",
        entry: null,
      });
      await rm(join(state, "transaction"), { recursive: true });
      // State this version cannot read: an unknown key.
      const preferences = join(state, "preferences.json");
      const original = await readFile(preferences, "utf8");
      await writeFile(
        preferences,
        JSON.stringify({ ...JSON.parse(original), fromTheFuture: true }),
      );
      expect(await refusalOf(startLaunchpad(folder))).toEqual({
        reason: "folder-state-unreadable",
        entry: null,
      });
      await writeFile(preferences, original);
      // A Folder that is not there at all.
      expect(await refusalOf(startLaunchpad(join(parent, "missing")))).toEqual({
        reason: "folder-state-unreadable",
        entry: null,
      });
      // And the Folder, repaired, starts normally again.
      const app = await startLaunchpad(folder);
      await app.close();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "an invalid hosted entry is named as such",
  async () => {
    const parent = await scratch("lp-rec-h-");
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    try {
      await initializeHandoverFolder(folder, {
        preset,
        machine: {
          ...bindings.organization,
          entry: parseMachineEntry({
            externalOrigin: "https://launchpad.workspace.example.lazurio.io",
            authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
            authCookieName: "__Secure-lazurio-workspace",
            listenPort: freePort(),
            t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
            moduleOriginTemplate:
              "https://{module}.workspace.example.lazurio.io",
          }),
        },
        profile: presetProfile(preset, executionOs(process.platform)),
      });
      const preferences = join(folder, ".lazurio", "preferences.json");
      const recorded = JSON.parse(await readFile(preferences, "utf8"));
      recorded.machine.entry.listenPort = 0;
      await writeFile(preferences, JSON.stringify(recorded));
      expect(await refusalOf(startLaunchpad(folder))).toEqual({
        reason: "hosted-entry-invalid",
        entry: null,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Recovery mode serves the Recovery page, every other API route a typed refusal, and the health socket 503",
  async () => {
    const base = await scratch("lp-rec-b-");
    await mkdir(join(base, "update"), { recursive: true });
    const recovery = await startRecoveryMode({
      refusal: new LaunchpadStartRefused("folder-transaction-pending"),
      base,
    });
    try {
      expect(recovery.hosted).toBe(false);
      const origin = `http://127.0.0.1:${recovery.server.port}`;
      // Locally the link carries the credential of the Recovery page's
      // evidence, as the normal page's link does.
      expect(recovery.url).toMatch(
        new RegExp(`^${origin.replaceAll(".", "\\.")}/#[0-9a-f]{64}$`),
      );
      // The page paths serve the bundled page, still saying 503; its scripts
      // and styles answer 200 so the browser runs them.
      for (const path of ["/", "/settings/tools", "/settings/recovery"]) {
        const page = await fetch(`${origin}${path}`);
        expect([path, page.status]).toEqual([path, 503]);
        expect(page.headers.get("content-type")).toContain("text/html");
        expect(await page.text()).toContain('id="section-recovery"');
      }
      expect(
        await checkBundledPage(async (path) => {
          const answer = await fetch(`${origin}${path}`);
          // The document's 503 is its own; the check reads the assets.
          return path === "/"
            ? new Response(await answer.text(), {
                headers: { "content-type": "text/html" },
              })
            : answer;
        }),
      ).toBe(true);
      // Anything else is the reason in plain text.
      const other = await fetch(`${origin}/anything`);
      expect([other.status, other.headers.get("content-type")]).toEqual([
        503,
        "text/plain; charset=utf-8",
      ]);
      expect(await other.text()).toBe(
        "Lazurio Launchpad: Recovery mode\ncheck: start-refused\nreason: folder-transaction-pending\n",
      );
      for (const [method, path] of [
        ["GET", "/api/update/status"],
        ["POST", "/api/profile"],
        ["POST", "/api/apps/start"],
        ["POST", "/api/tools/install"],
      ] as const) {
        const answer = await fetch(`${origin}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect([path, answer.status, await answer.json()]).toEqual([
          path,
          503,
          {
            error: "recovery-mode",
            check: "start-refused",
            reason: "folder-transaction-pending",
          },
        ]);
      }
      const health = await fetch("http://launchpad/health", {
        unix: join(base, "update", "launchpad.sock"),
      });
      expect([health.status, await health.json()]).toEqual([
        503,
        {
          mode: "recovery",
          check: "start-refused",
          reason: "folder-transaction-pending",
        },
      ]);
      // Not healthy for the updater, and not a second Launchpad's to take.
      expect(await launchpadHealth(base)).toBeNull();
      await expect(
        startRecoveryMode({
          refusal: new LaunchpadStartRefused("asset-missing"),
          base,
        }),
      ).rejects.toThrow("Another Launchpad serves this install base");
    } finally {
      await recovery.close();
      await rm(base, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted Recovery mode keeps the gateway's port and admission",
  async () => {
    const entry = parseMachineEntry({
      externalOrigin: "https://launchpad.workspace.example.lazurio.io",
      authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
      authCookieName: "__Secure-lazurio-workspace",
      listenPort: freePort(),
      t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
      moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
    });
    const fetcher: AuthFetcher = async (_url, init) =>
      new Headers(init.headers).get("cookie") ===
      "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 });
    const recovery = await startRecoveryMode({
      refusal: new LaunchpadStartRefused("asset-missing", entry),
      hostedOptions: { fetcher },
    });
    try {
      expect(recovery.hosted).toBe(true);
      expect(recovery.url).toBe(`${entry.externalOrigin}/`);
      expect(recovery.server.port).toBe(entry.listenPort);
      const base = `http://127.0.0.1:${entry.listenPort}`;
      const host = "launchpad.workspace.example.lazurio.io";
      const denied = await fetch(`${base}/`, { headers: { host } });
      expect([denied.status, await denied.json()]).toEqual([
        401,
        { error: "denied", reason: "cookie-missing" },
      ]);
      const page = await fetch(`${base}/`, {
        headers: { host, cookie: "__Secure-lazurio-workspace=valid" },
      });
      expect(page.status).toBe(503);
      expect(await page.text()).toContain("reason: asset-missing");
    } finally {
      await recovery.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a hosted Folder whose state is refused still answers Recovery mode on the gateway's port, behind its admission",
  async () => {
    const parent = await scratch("lp-rec-hp-");
    const folder = join(parent, "Lazurio");
    const state = join(folder, ".lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    const entry = parseMachineEntry({
      externalOrigin: "https://launchpad.workspace.example.lazurio.io",
      authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
      authCookieName: "__Secure-lazurio-workspace",
      listenPort: freePort(),
      t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
      moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
    });
    const once = { attempts: 1, delayMs: 0 };
    try {
      await initializeHandoverFolder(folder, {
        preset,
        machine: { ...bindings.organization, entry },
        profile: presetProfile(preset, executionOs(process.platform)),
      });
      const preferences = join(state, "preferences.json");
      const original = await readFile(preferences, "utf8");
      const lock = join(state, ".operation-lock");
      const scenes: Record<string, () => Promise<() => Promise<unknown>>> = {
        // An interrupted profile or tools change.
        "folder-transaction-pending": async () => {
          await mkdir(join(state, "transaction"));
          return () => rm(join(state, "transaction"), { recursive: true });
        },
        // A key this version does not know; the entry itself still reads.
        "folder-state-unreadable": async () => {
          await writeFile(
            preferences,
            JSON.stringify({ ...JSON.parse(original), fromTheFuture: true }),
          );
          return () => writeFile(preferences, original);
        },
        // A lock this version does not recognize cannot be taken.
        "folder-lock-unavailable": async () => {
          await rm(lock, { recursive: true });
          await mkdir(lock, { mode: 0o700 });
          return async () => undefined;
        },
      };
      for (const [reason, arrange] of Object.entries(scenes)) {
        const undo = await arrange();
        const started = await startOrRecover(
          () => startLaunchpad(folder),
          (refusal) => startRecoveryMode({ refusal }),
          once,
        );
        if (started.mode !== "recovery") {
          if ("close" in started.value) await started.value.close();
          throw new Error(`${reason}: started normally`);
        }
        const recovery = started.value;
        try {
          expect([
            recovery.reason,
            recovery.hosted,
            recovery.url,
            recovery.server.port,
          ]).toEqual([
            reason,
            true,
            `${entry.externalOrigin}/`,
            entry.listenPort,
          ]);
          const denied = await fetch(`http://127.0.0.1:${entry.listenPort}/`, {
            headers: { host: "launchpad.workspace.example.lazurio.io" },
          });
          expect([denied.status, await denied.json()]).toEqual([
            401,
            { error: "denied", reason: "cookie-missing" },
          ]);
        } finally {
          await recovery.close();
        }
        await undo();
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("a start waits out a Folder that is busy for a moment, then serves Recovery mode; anything unnamed still fails", async () => {
  const retry = { attempts: 3, delayMs: 1 };
  let attempts = 0;
  const busyOnce = await startOrRecover(
    async () => {
      attempts++;
      if (attempts === 1)
        throw new LaunchpadStartRefused("folder-lock-unavailable");
      return "normal";
    },
    async () => "recovery",
    retry,
  );
  expect([busyOnce, attempts]).toEqual([
    { mode: "normal", value: "normal" },
    2,
  ]);
  attempts = 0;
  const stillPending = await startOrRecover(
    async () => {
      attempts++;
      throw new LaunchpadStartRefused("folder-transaction-pending");
    },
    async (refusal) => refusal.reason,
    retry,
  );
  expect([stillPending, attempts]).toEqual([
    { mode: "recovery", value: "folder-transaction-pending" },
    3,
  ]);
  // A condition that does not go away by waiting is served at once.
  attempts = 0;
  expect(
    await startOrRecover(
      async () => {
        attempts++;
        throw new LaunchpadStartRefused("folder-state-unreadable");
      },
      async (refusal) => refusal.reason,
      retry,
    ),
  ).toEqual({ mode: "recovery", value: "folder-state-unreadable" });
  expect(attempts).toBe(1);
  await expect(
    startOrRecover(
      async () => {
        throw new Error("port in use");
      },
      async () => "recovery",
      retry,
    ),
  ).rejects.toThrow("port in use");
});

test("a page whose bundle does not serve completely is asset-missing", async () => {
  const page = `<!doctype html><script type="module" crossorigin src="/chunk-a.js"></script><link rel="stylesheet" href="/chunk-b.css">`;
  const served = (missing: string | null) => async (path: string) =>
    path === "/"
      ? new Response(page, { headers: { "content-type": "text/html" } })
      : path === missing
        ? new Response("not-found", { status: 404 })
        : new Response("");
  expect(await checkBundledPage(served(null))).toBe(true);
  expect(await checkBundledPage(served("/chunk-a.js"))).toBe(false);
  expect(await checkBundledPage(served("/chunk-b.css"))).toBe(false);
  expect(
    await checkBundledPage(async () => new Response("", { status: 404 })),
  ).toBe(false);
});
