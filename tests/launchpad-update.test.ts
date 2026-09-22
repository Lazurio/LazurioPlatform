import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { createUpdatePill } from "../src/launchpad/update-pill";
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
