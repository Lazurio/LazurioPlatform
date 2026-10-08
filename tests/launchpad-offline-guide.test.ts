import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  offlineDocsUrl,
  offlineWorkerSource,
} from "../src/launchpad/offline-guide";
import { type HostedOptions, startLaunchpad } from "../src/launchpad/server";
import {
  OFFLINE_PAGE_PATH,
  OFFLINE_WORKER_PATH,
} from "../src/shell/offline-policy";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// Decision F41: the Launchpad of an Environment that is a node of a tailnet
// answers the offline guide's page and worker under `/.lazurio/`, only after
// the gateway's admission, always revalidated, the worker with the header
// that lets it answer the whole origin, and its bytes carrying the version
// and the digest of the page it keeps. Without a tailnet there is neither.

const posixTest = test.skipIf(process.platform === "win32");

const tailnet = "https://headscale.example.lazurio.io";

async function hostedLaunchpad(
  offlineTailnet: HostedOptions["offlineTailnet"],
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-offline-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  const preset = "hosted-organization-personal";
  await initializeHandoverFolder(folder, {
    preset,
    machine: organizationWithEntry(port),
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const app = await startLaunchpad(folder, undefined, undefined, undefined, {
    fetcher: async (_url, init) =>
      new Headers(init.headers).get("cookie") ===
      "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 }),
    ...(offlineTailnet === undefined ? {} : { offlineTailnet }),
  });
  const host = "launchpad.workspace.example.lazurio.io";
  return {
    app,
    parent,
    base: `http://127.0.0.1:${port}`,
    host,
    valid: { host, cookie: "__Secure-lazurio-workspace=valid" },
  };
}

posixTest(
  "hosted: the guide page and its worker only after the gateway's admission",
  async () => {
    const { app, parent, base, host, valid } = await hostedLaunchpad(
      async () => tailnet,
    );
    try {
      for (const path of [OFFLINE_PAGE_PATH, OFFLINE_WORKER_PATH]) {
        expect(
          (await fetch(`${base}${path}`, { headers: { host } })).status,
        ).toBe(401);
        expect(
          (
            await fetch(`${base}${path}`, {
              headers: { host, cookie: "__Secure-lazurio-workspace=forged" },
            })
          ).status,
        ).toBe(401);
      }

      const page = await fetch(`${base}${OFFLINE_PAGE_PATH}`, {
        headers: valid,
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("cache-control")).toBe("no-cache");
      const html = await page.text();
      expect(html).toContain("headscale.example.lazurio.io");
      expect(html).toContain(offlineDocsUrl("cs"));
      expect(html).toContain("Zapni Tailscale");

      const worker = await fetch(`${base}${OFFLINE_WORKER_PATH}`, {
        headers: valid,
      });
      expect(worker.status).toBe(200);
      expect(worker.headers.get("content-type")).toContain("text/javascript");
      // Always revalidated, and allowed to answer the whole origin: an update
      // fetched without this header fails and would keep the old worker.
      expect(worker.headers.get("cache-control")).toBe("no-cache");
      expect(worker.headers.get("service-worker-allowed")).toBe("/");
      const script = await worker.text();
      const digest = createHash("sha256").update(html).digest("hex");
      expect(script.startsWith("const LAZURIO_OFFLINE = ")).toBe(true);
      expect(script).toContain(`"page":"${digest}"`);
      expect(script).toContain('"retired":false');
      expect(script.endsWith(offlineWorkerSource)).toBe(true);
      // One classic script: nothing imported that could change unseen.
      expect(script).not.toContain("importScripts");

      // A page that answers the same is the same worker, byte for byte.
      const again = await fetch(`${base}${OFFLINE_WORKER_PATH}`, {
        headers: valid,
      });
      expect(await again.text()).toBe(script);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

posixTest(
  "hosted: without a tailnet the Environment has neither the page nor the worker",
  async () => {
    const { app, parent, base, valid } = await hostedLaunchpad(
      async () => null,
    );
    try {
      for (const path of [OFFLINE_PAGE_PATH, OFFLINE_WORKER_PATH])
        expect((await fetch(`${base}${path}`, { headers: valid })).status).toBe(
          404,
        );
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);
