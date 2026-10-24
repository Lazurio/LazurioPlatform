import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { createUpdatePill } from "../src/launchpad/update-pill";
import type { ModuleHost } from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
import type { UpdateError } from "../src/update/errors";
import type { Activator } from "../src/update/launchpad-activation";
import {
  closeSharedSigstore,
  createWorld,
  type World,
} from "./fixtures/update-world";

// The two routes of the pill (docs/update.md "Surfaces") on the loopback
// Launchpad: the same admission as every other route, a GET that reads and a
// POST that starts exactly what the pill showed.
let world: World;
afterEach(async () => world?.close());
afterAll(closeSharedSigstore);

test.skipIf(process.platform === "win32")(
  "GET /api/update/status and POST /api/update/apply on the installed Launchpad",
  async () => {
    world = await createWorld();
    await world.release("1.1.0");
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const starts: string[] = [];
    const activation = {
      inFlight: false,
      failure: null as UpdateError | null,
    };
    const activator: Activator = {
      async start(version) {
        starts.push(version);
        activation.inFlight = true;
      },
      async observe() {
        return { ...activation };
      },
    };
    const pill = createUpdatePill({
      environment: world.environment("1.0.0"),
      activator,
      // The poller's first check comes at once here; it is the CLI's check.
      poller: { startupDelayMs: 0, intervalMs: 3_600_000, jitterMs: 0 },
    });
    const app = await startLaunchpad(folder, undefined, undefined, {
      base: world.base,
      version: "1.0.0",
      pill,
    });
    const url = new URL(app.url);
    const auth = { Authorization: `Bearer ${url.hash.slice(1)}` };
    const get = (override: Record<string, string> = {}) =>
      fetch(new URL("/api/update/status", url), {
        headers: { ...auth, ...override },
      });
    const post = (body: unknown, override: Record<string, string> = {}) =>
      fetch(new URL("/api/update/apply", url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: url.origin,
          ...auth,
          ...override,
        },
        body: JSON.stringify(body),
      });
    try {
      // Admission: the token is required; a foreign Origin is refused; a
      // same-origin GET without an Origin header (what browsers send) passes.
      expect((await get({ Authorization: "" })).status).toBe(403);
      expect((await get({ Origin: "https://untrusted.example" })).status).toBe(
        403,
      );
      expect((await get({ Host: "untrusted.example" })).status).toBe(403);
      expect(
        (await fetch(new URL("/api/profile", url), { headers: auth })).status,
      ).toBe(405);
      let status = await (await get({ Origin: url.origin })).json();
      expect(status).toMatchObject({ kind: "update-pill", running: "1.0.0" });
      // The poller's check settles; the pill shows what it verified.
      for (let attempt = 0; attempt < 500; attempt++) {
        status = await (await get()).json();
        if (status.state !== "checking" && status.latest !== null) break;
        await Bun.sleep(10);
      }
      expect(status).toMatchObject({
        state: "available",
        latest: "1.1.0",
        notesUrl:
          "https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.0",
        action: "update",
        error: null,
        stale: false,
        supervised: false,
      });
      expect(Date.parse(status.checkedAt)).toBeGreaterThan(Date.now() - 60_000);
      // Input is exactly {version}; the version must be what was shown.
      expect((await post({})).status).toBe(400);
      expect((await post({ version: 1 })).status).toBe(400);
      expect((await post({ version: "1.1.0", extra: true })).status).toBe(400);
      const stale = await post({ version: "1.2.0" });
      expect([stale.status, await stale.json()]).toEqual([
        409,
        { kind: "stale", version: "1.2.0", latest: "1.1.0" },
      ]);
      expect(starts).toEqual([]);
      const started = await post({ version: "1.1.0" });
      expect([started.status, await started.json()]).toEqual([
        200,
        { kind: "started", version: "1.1.0" },
      ]);
      expect(starts).toEqual(["1.1.0"]);
      expect(await (await get()).json()).toMatchObject({
        state: "downloading",
        action: null,
      });
      const busy = await post({ version: "1.1.0" });
      expect([busy.status, (await busy.json()).code]).toEqual([409, "busy"]);
      expect(starts).toEqual(["1.1.0"]);
      // A cross-origin click is refused before anything is read.
      expect(
        (await post({ version: "1.1.0" }, { Origin: "https://x.example" }))
          .status,
      ).toBe(403);
      // The page carries the pill and never the token.
      const html = await (await fetch(url.origin)).text();
      expect(html).toContain('id="update-pill"');
      expect(html).not.toContain(url.hash.slice(1));
    } finally {
      await app.close();
    }
    // A Launchpad that is not an installed one has no pill.
    const plain = await startLaunchpad(folder);
    const plainUrl = new URL(plain.url);
    try {
      const response = await fetch(new URL("/api/update/status", plainUrl), {
        headers: { Authorization: `Bearer ${plainUrl.hash.slice(1)}` },
      });
      expect([response.status, await response.json()]).toEqual([
        503,
        { error: "update-unavailable" },
      ]);
    } finally {
      await plain.close();
    }
  },
);

// Aktualizovat (root decision 0212 points 3 and 7): one `lazurio update` as a
// job of the installed Launchpad, behind the same admission, Lazurio itself
// last through the pill's own action; a second click joins the run.
test.skipIf(process.platform === "win32")(
  "POST and GET /api/update/everything: one run at a time that a second click joins, Lazurio last through the pill",
  async () => {
    world = await createWorld();
    await world.release("1.1.0");
    const folder = join(world.root, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const starts: string[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activator: Activator = {
      async start(version) {
        starts.push(version);
        // The run stays under way until the test lets it go on.
        await released;
      },
      async observe() {
        return { inFlight: false, failure: null };
      },
    };
    const pill = createUpdatePill({
      environment: world.environment("1.0.0"),
      activator,
      poller: { startupDelayMs: 3_600_000, intervalMs: 3_600_000, jitterMs: 0 },
    });
    // No builds and no tools of the account: nothing but this Folder.
    const moduleHost: ModuleHost = {
      platform: process.platform,
      home: world.root,
      path: "/usr/bin:/bin",
      runtimeDirectory: undefined,
      platformExecutable: process.execPath,
      runnerKind: async () => "session",
      createRunner: () => createSessionRunner(process.execPath),
      readJournal: async () => ({ kind: "unavailable" }),
    };
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      { base: world.base, version: "1.0.0", pill },
      {},
      {
        path: world.root,
        home: world.root,
        platform: process.platform,
        run: async () => "timeout",
      },
      {},
      undefined,
      moduleHost,
    );
    const url = new URL(app.url);
    const auth = { Authorization: `Bearer ${url.hash.slice(1)}` };
    const route = new URL("/api/update/everything", url);
    const post = (override: Record<string, string> = {}) =>
      fetch(route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: url.origin,
          ...auth,
          ...override,
        },
        body: "{}",
      });
    const latest = async () =>
      (await (await fetch(route, { headers: auth })).json()) as {
        kind: string;
        job: { id: string; state: string; lines: unknown[] } | null;
      };
    try {
      expect(await latest()).toEqual({ kind: "update-everything", job: null });
      // The admission of every route: the token, and the same origin for a
      // write.
      expect((await fetch(route)).status).toBe(403);
      expect((await post({ Origin: "https://x.example" })).status).toBe(403);
      expect(
        (
          await fetch(route, {
            method: "POST",
            headers: {
              ...auth,
              "Content-Type": "application/json",
              Origin: url.origin,
            },
            body: '{"extra":1}',
          })
        ).status,
      ).toBe(400);
      const started = await post();
      expect(started.status).toBe(202);
      const first = (await started.json()) as { job: string; joined: boolean };
      expect(first.joined).toBe(false);
      // Lazurio's check verified 1.1.0 and the pill's action started it.
      for (let attempt = 0; attempt < 500 && starts.length === 0; attempt++)
        await Bun.sleep(10);
      expect(starts).toEqual(["1.1.0"]);
      // A second click joins the run under way.
      const joined = await post();
      expect([joined.status, await joined.json()]).toEqual([
        202,
        { kind: "update-everything", job: first.job, joined: true },
      ]);
      expect((await latest()).job).toMatchObject({
        id: first.job,
        state: "running",
        lines: [{ part: "product", step: "checking" }],
      });
      release();
      let job = (await latest()).job;
      for (
        let attempt = 0;
        attempt < 500 && job?.state !== "succeeded";
        attempt++
      ) {
        await Bun.sleep(10);
        job = (await latest()).job;
      }
      // This Folder holds no Organization: content had nothing to do.
      expect(job).toEqual({
        id: first.job,
        state: "succeeded",
        lines: [{ part: "product", result: "started", to: "1.1.0" }],
      });
    } finally {
      release();
      await app.close();
    }
    // A Launchpad that is not an installed one runs no update.
    const plain = await startLaunchpad(folder);
    const plainUrl = new URL(plain.url);
    try {
      const response = await fetch(
        new URL("/api/update/everything", plainUrl),
        {
          headers: { Authorization: `Bearer ${plainUrl.hash.slice(1)}` },
        },
      );
      expect([response.status, await response.json()]).toEqual([
        503,
        { error: "update-unavailable" },
      ]);
    } finally {
      await plain.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the pill's part of one update: current when nothing newer is verified, a failure by its code, and nothing started then",
  async () => {
    world = await createWorld();
    const starts: string[] = [];
    const activator: Activator = {
      async start(version) {
        starts.push(version);
      },
      async observe() {
        return { inFlight: false, failure: null };
      },
    };
    const pill = createUpdatePill({
      environment: world.environment("1.0.0"),
      activator,
      poller: { startupDelayMs: 3_600_000, intervalMs: 3_600_000, jitterMs: 0 },
    });
    // No release yet: the check fails and says why.
    const failed = await pill.updateNow();
    expect(failed).toMatchObject({ part: "product", result: "failed" });
    expect(typeof (failed as { code?: unknown }).code).toBe("string");
    await world.release("1.0.0");
    expect(await pill.updateNow()).toEqual({
      part: "product",
      result: "current",
      version: "1.0.0",
    });
    expect(starts).toEqual([]);
  },
);
