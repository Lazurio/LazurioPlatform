import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import {
  type AuthFetcher,
  parseHostedEntry,
} from "../src/launchpad/hosted-trust";
import {
  startOrRecover,
  startRecoveryMode,
} from "../src/launchpad/recovery-mode";
import { startLaunchpad } from "../src/launchpad/server";
import { LaunchpadStartRefused } from "../src/launchpad/start-check";
import {
  type RecoverContext,
  recoverySource,
  runRecoverCommand,
} from "../src/recover/cli";
import type { RecoveryResult } from "../src/recover/recover";
import { performInstall } from "../src/update/install";
import { type ProcessRunner, runProcess } from "../src/update/self-check";
import { commitOf, executable, target } from "./fixtures/update-world";

// The Recovery page (docs/recovery.md "The Recovery page"): `GET
// /api/recovery` is exactly `lazurio recover --json` for the Launchpad's
// Folder and base, in Recovery mode and in the Recovery view of Settings;
// behind the same admission as the page; nothing changes anything. The
// install base and Folder are temporary, the active executable is the
// fixture's; nothing reaches the network.

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const once = { attempts: 1, delayMs: 0 };

async function createWorld() {
  // Short on macOS: the health socket lives under the base.
  root = await realpath(
    await mkdtemp(
      join(process.platform === "darwin" ? "/tmp" : tmpdir(), "lp-rp-"),
    ),
  );
  const home = join(root, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const base = join(root, "b");
  const source = join(root, "downloaded-lazurio");
  await writeFile(source, executable("1.0.0"), { mode: 0o700 });
  const installed = await performInstall({
    base,
    executable: source,
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: process.platform,
    env: {},
  });
  if (installed.kind !== "installed") throw new Error("Fixture install failed");
  const folder = join(home, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  return { root, home, base, folder, state: join(folder, ".lazurio") };
}

type World = Awaited<ReturnType<typeof createWorld>>;

/** The context of `lazurio recover` with this world's stand-ins; the health
 * socket is asked for real. The only process is the fixture's self-check. */
function context(world: World): RecoverContext {
  const run: ProcessRunner = async (command, timeoutMs, env) => {
    if (command[0]?.startsWith(world.root))
      return runProcess(command, timeoutMs, env);
    throw new Error(`Unexpected command ${command[0]}`);
  };
  return {
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: process.platform,
    env: { HOME: world.home },
    executable: join(world.root, "unused"),
    run,
    recovery: {
      now: () => new Date("2026-09-28T10:00:00.000Z"),
      machine: async () => ({
        home: world.home,
        user: ["canaryuser"],
        hostname: "canary-box.corp.example",
        kernel: "6.8.0-canary-box",
        arch: "arm64",
        bun: "1.4.2",
      }),
      machineContext: async () => null,
    },
  };
}

async function cliJson(world: World) {
  const output = await runRecoverCommand(
    ["--json", "--base", world.base, "--folder", world.folder],
    context(world),
  );
  return { code: output.code, json: JSON.parse(output.stdout ?? "null") };
}

const tokenOf = (url: string) => new URL(url).hash.slice(1);

test.skipIf(process.platform === "win32")(
  "on a refused Folder the Recovery page reads exactly what lazurio recover --json prints, with the credential",
  async () => {
    const world = await createWorld();
    // An interrupted Folder change: the start refuses it by name.
    await mkdir(join(world.state, "transaction"));
    const recovery = recoverySource(context(world), {
      base: world.base,
      folder: world.folder,
    });
    const started = await startOrRecover(
      () => startLaunchpad(world.folder),
      (refusal) => startRecoveryMode({ refusal, base: world.base, recovery }),
      once,
    );
    if (started.mode !== "recovery") {
      if ("close" in started.value) await started.value.close();
      throw new Error("started normally");
    }
    const app = started.value;
    try {
      const origin = `http://127.0.0.1:${app.server.port}`;
      const authorization = `Bearer ${tokenOf(app.url)}`;
      // Without the link's credential the evidence is not served.
      expect((await fetch(`${origin}/api/recovery`)).status).toBe(403);
      expect(
        (
          await fetch(`${origin}/api/recovery`, {
            headers: { authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(403);
      const answer = await fetch(`${origin}/api/recovery`, {
        headers: { authorization },
      });
      expect(answer.status).toBe(200);
      const served = await answer.json();
      const cli = await cliJson(world);
      expect(cli.code).toBe(3);
      expect(served).toEqual(cli.json);
      expect(served).toMatchObject({
        kind: "recovery",
        verdict: "broken",
        evidence: { check: "folder-state", code: "folder-state-pending" },
        issue: { kind: "prepared" },
      });
      // The Launchpad's own health answer is part of the evidence.
      expect(
        served.checks.find(
          (check: { id: string }) => check.id === "launchpad-health",
        ),
      ).toMatchObject({
        outcome: "failed",
        code: "launchpad-recovery-mode",
        context: {
          check: "start-refused",
          refusal: "folder-transaction-pending",
        },
      });
      // …and so the prepared issue says why the start was refused.
      expect(served.issue.body).toContain(
        '"refusal":"folder-transaction-pending"',
      );
      // Read-only: no POST, and every other route still names the reason.
      const post = await fetch(`${origin}/api/recovery`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: "{}",
      });
      expect([post.status, await post.json()]).toEqual([
        503,
        {
          error: "recovery-mode",
          check: "start-refused",
          reason: "folder-transaction-pending",
        },
      ]);
      // The page is the bundled one, its Recovery section in it.
      const page = await fetch(`${origin}/`);
      expect(page.status).toBe(503);
      const html = await page.text();
      expect(html).toContain('id="section-recovery"');
      expect(html).toContain('href="/settings/recovery"');
      expect(html).not.toContain(tokenOf(app.url));
    } finally {
      await app.close();
    }
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "a page that does not serve completely is the plain-text reason; the evidence still answers",
  async () => {
    const result: RecoveryResult = {
      kind: "recovery",
      verdict: "healthy",
      checks: [],
      evidence: null,
      prompt: null,
      issue: null,
    };
    const app = await startRecoveryMode({
      refusal: new LaunchpadStartRefused("asset-missing"),
      recovery: async () => result,
    });
    try {
      const origin = `http://127.0.0.1:${app.server.port}`;
      for (const path of ["/", "/settings/recovery"]) {
        const page = await fetch(`${origin}${path}`);
        expect([page.status, page.headers.get("content-type")]).toEqual([
          503,
          "text/plain; charset=utf-8",
        ]);
        expect(await page.text()).toBe(
          "Lazurio Launchpad: Recovery mode\ncheck: start-refused\nreason: asset-missing\n",
        );
      }
      const answer = await fetch(`${origin}/api/recovery`, {
        headers: { authorization: `Bearer ${tokenOf(app.url)}` },
      });
      expect([answer.status, await answer.json()]).toEqual([200, result]);
    } finally {
      await app.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted: the Recovery page and its evidence sit behind the gateway's admission",
  async () => {
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(""),
    });
    const listenPort = probe.port;
    probe.stop(true);
    const entry = parseHostedEntry({
      externalOrigin: "https://launchpad.workspace.example.lazurio.io",
      authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
      authCookieName: "__Secure-lazurio-workspace",
      listenPort,
    });
    const fetcher: AuthFetcher = async (_url, init) =>
      new Headers(init.headers).get("cookie") ===
      "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 });
    let reads = 0;
    const app = await startRecoveryMode({
      refusal: new LaunchpadStartRefused("folder-transaction-pending", entry),
      hostedOptions: { fetcher },
      recovery: async () => {
        reads++;
        return {
          kind: "recovery",
          verdict: "healthy",
          checks: [],
          evidence: null,
          prompt: null,
          issue: null,
        };
      },
    });
    try {
      expect(app.url).toBe(`${entry.externalOrigin}/`);
      const base = `http://127.0.0.1:${listenPort}`;
      const host = "launchpad.workspace.example.lazurio.io";
      const valid = { host, cookie: "__Secure-lazurio-workspace=valid" };
      for (const path of ["/", "/settings/recovery", "/api/recovery"]) {
        const denied = await fetch(`${base}${path}`, { headers: { host } });
        expect([path, denied.status, await denied.json()]).toEqual([
          path,
          401,
          { error: "denied", reason: "cookie-missing" },
        ]);
      }
      expect(reads).toBe(0);
      const page = await fetch(`${base}/`, { headers: valid });
      expect(page.status).toBe(503);
      expect(await page.text()).toContain('id="section-recovery"');
      const answer = await fetch(`${base}/api/recovery`, { headers: valid });
      expect([answer.status, (await answer.json()).verdict]).toEqual([
        200,
        "healthy",
      ]);
      expect(reads).toBe(1);
    } finally {
      await app.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "normal mode: the Recovery view of Settings reads the same use case, healthy on a healthy installation",
  async () => {
    const world = await createWorld();
    const recovery = recoverySource(context(world), {
      base: world.base,
      folder: world.folder,
    });
    const app = await startLaunchpad(
      world.folder,
      undefined,
      undefined,
      // The installed Launchpad answers its health socket with the active
      // version.
      { base: world.base, version: "1.0.0" },
      undefined,
      undefined,
      undefined,
      recovery,
    );
    try {
      const url = new URL(app.url);
      const authorization = `Bearer ${url.hash.slice(1)}`;
      const html = await (await fetch(url.origin)).text();
      expect(
        await (await fetch(new URL("/settings/recovery", url.origin))).text(),
      ).toBe(html);
      expect(html).toContain('href="/settings/recovery"');
      expect((await fetch(new URL("/api/recovery", url.origin))).status).toBe(
        403,
      );
      const served = await (
        await fetch(new URL("/api/recovery", url.origin), {
          headers: { authorization },
        })
      ).json();
      const cli = await cliJson(world);
      expect(cli.code).toBe(0);
      expect(served).toEqual(cli.json);
      expect(served).toMatchObject({
        verdict: "healthy",
        evidence: null,
        prompt: null,
        issue: null,
      });
      expect(
        served.checks.find(
          (check: { id: string }) => check.id === "launchpad-health",
        ),
      ).toMatchObject({ outcome: "ok", context: { version: "1.0.0" } });
    } finally {
      await app.close();
    }
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "a Launchpad without the recovery use case says so instead of guessing",
  async () => {
    const world = await createWorld();
    const app = await startLaunchpad(world.folder);
    try {
      const url = new URL(app.url);
      const answer = await fetch(new URL("/api/recovery", url.origin), {
        headers: { authorization: `Bearer ${url.hash.slice(1)}` },
      });
      expect([answer.status, await answer.json()]).toEqual([
        503,
        { error: "recovery-unavailable" },
      ]);
    } finally {
      await app.close();
    }
  },
);
