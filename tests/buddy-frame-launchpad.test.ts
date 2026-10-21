import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeclaredBuddyFrame } from "../src/buddy/frame/start";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { type HostedOptions, startLaunchpad } from "../src/launchpad/server";
import { startFakeAdapter } from "./fixtures/buddy-adapter";
import { personalWithEntry } from "./fixtures/machine-bindings";
import { freePort } from "./fixtures/ports";

// Buddy's frame is a second listener of the hosted Launchpad's own process
// (buddy-web-v1 CONTRACT section 4): it starts with the Launchpad where the
// Osobní Prostředí declares it, stops with it, and a defective declaration
// or a busy port never keeps the Launchpad from starting.

const posixTest = test.skipIf(process.platform === "win32");
const secret = "launchpad-test-secret-0123456789";
const origin = "https://buddy.example.lazurio.io";

async function hosted(
  buddyFrame: Exclude<HostedOptions["buddyFrame"], undefined>,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "buddy-launchpad-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-personal";
  await initializeHandoverFolder(folder, {
    preset,
    machine: personalWithEntry(freePort()),
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const app = await startLaunchpad(folder, undefined, undefined, undefined, {
    fetcher: async () => new Response("no", { status: 401 }),
    buddyFrame,
  });
  return { app, parent };
}

posixTest(
  "the frame starts with the hosted Launchpad and stops with it",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "buddy-secret-")),
    );
    const secretFile = join(parent, "lazurio_web.secret");
    await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
    const adapter = await startFakeAdapter({ secret });
    const listenPort = freePort();
    const { app, parent: folderParent } = await hosted({
      origin,
      listenPort,
      adapterPort: adapter.port,
      secretFile,
    });
    try {
      const persona = await fetch(
        `http://127.0.0.1:${listenPort}/api/persona`,
        {
          headers: { host: "buddy.example.lazurio.io" },
        },
      );
      expect(persona.status).toBe(200);
      expect(await persona.json()).toEqual({ name: expect.any(String) });
      const history = await fetch(
        `http://127.0.0.1:${listenPort}/api/v1/history`,
        {
          headers: { host: "buddy.example.lazurio.io" },
        },
      );
      expect(history.status).toBe(200);
    } finally {
      await app.close();
      await adapter.stop();
      await rm(parent, { recursive: true, force: true });
      await rm(folderParent, { recursive: true, force: true });
    }
    await expect(
      fetch(`http://127.0.0.1:${listenPort}/api/persona`, {
        headers: { host: "buddy.example.lazurio.io" },
      }),
    ).rejects.toThrow();
  },
);

posixTest(
  "without a declaration there is no frame, and a busy port leaves the Launchpad running",
  async () => {
    const none = await hosted(null);
    await none.app.close();
    await rm(none.parent, { recursive: true, force: true });
    const busy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("busy"),
    });
    const lines: string[] = [];
    expect(
      await startDeclaredBuddyFrame(
        {
          origin,
          listenPort: busy.port ?? 0,
          adapterPort: 1,
          secretFile: "/nonexistent",
        },
        {},
        (line) => lines.push(line),
      ),
    ).toBeNull();
    expect(lines).toEqual([
      JSON.stringify({ buddyFrame: "not-started", port: busy.port }),
    ]);
    await busy.stop(true);
    const refused: string[] = [];
    expect(
      await startDeclaredBuddyFrame({ refused: "secretFile" }, {}, (line) =>
        refused.push(line),
      ),
    ).toBeNull();
    expect(refused).toEqual([
      JSON.stringify({
        buddyFrame: "refused",
        variable: "LAZURIO_BUDDY_ADAPTER_SECRET_FILE",
      }),
    ]);
    const busyLaunchpad = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("busy"),
    });
    const started = await hosted({
      origin,
      listenPort: busyLaunchpad.port ?? 0,
      adapterPort: 1,
      secretFile: "/nonexistent",
    });
    await started.app.close();
    await busyLaunchpad.stop(true);
    await rm(started.parent, { recursive: true, force: true });
  },
);
