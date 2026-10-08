import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  offlineGuideHeaders,
  offlineWorker,
  offlineWorkerHeaders,
  offlineWorkerSource,
} from "../src/launchpad/offline-guide";
import { renderOfflineGuide } from "../src/shell/offline-page";
import {
  cacheName,
  OFFLINE_CONTACT_PATH,
  OFFLINE_EXPIRY_MS,
  OFFLINE_PAGE_PATH,
  OFFLINE_VERSION_MESSAGE,
  OFFLINE_WORKER_PATH,
  offlineWorkerPrelude,
} from "../src/shell/offline-policy";

// Smoke of the offline guide (decision F41) in a real Chromium, with the
// worker and the page exactly as the Launchpad builds them. It proves what
// unit tests cannot: a navigation whose name does not resolve shows the
// guide at the same address; a changed worker replaces the old one on the
// next load and drops its cache; a retiring worker removes itself; after 30
// days without contact the worker removes itself instead of guiding; and
// without `Service-Worker-Allowed` the browser refuses the worker. Playwright
// is supplied externally, as for smoke-application-ui.ts:
//   NODE_PATH=<directory with playwright> bun scripts/smoke-offline-guide.ts

const { chromium } = createRequire(import.meta.url)("playwright");

const host = "environment.localhost";
const server = {
  version: "v1",
  tailnet: "headscale.example.lazurio.io",
  retired: false,
  allowScope: true,
};

const guide = () =>
  renderOfflineGuide({
    locale: "cs",
    environment: "Team Smoke",
    organization: "Example",
    tailnet: server.tailnet,
    docs: "https://documentation.lazurio.ai/cs/guide/tailscale/",
  });
const digestOf = (page: string) =>
  createHash("sha256").update(page).digest("hex");

// The app page registers the worker as the shell does (offline-guide.ts).
const appPage = `<!doctype html><meta charset="utf-8"><title>App</title><h1>APP</h1>
<script>navigator.serviceWorker.register("${OFFLINE_WORKER_PATH}",{scope:"/",updateViaCache:"none"}).then(function(r){return r.update()}).catch(function(e){window.registrationError=String(e)});</script>`;

const listener = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === OFFLINE_PAGE_PATH)
      return new Response(guide(), { headers: offlineGuideHeaders });
    if (path === OFFLINE_WORKER_PATH) {
      const page = guide();
      const body = server.retired
        ? offlineWorkerPrelude({
            version: server.version,
            page: digestOf(page),
            retired: true,
          }) + offlineWorkerSource
        : offlineWorker(page, server.version);
      const headers: Record<string, string> = { ...offlineWorkerHeaders };
      if (!server.allowScope) delete headers["Service-Worker-Allowed"];
      return new Response(body, { headers });
    }
    return new Response(appPage, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});
const origin = `http://${host}:${listener.port}`;
const resolvable = `--host-resolver-rules=MAP ${host} 127.0.0.1`;
const unresolvable = `--host-resolver-rules=MAP ${host} ~NOTFOUND`;

type Context = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
};
type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: string | (() => T | Promise<T>)): Promise<T>;
  reload(): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
};

const results: string[] = [];
let failed = false;
function check(name: string, ok: boolean, detail = ""): void {
  results.push(
    `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`,
  );
  if (!ok) failed = true;
}

async function open(profile: string, online: boolean): Promise<Context> {
  return chromium.launchPersistentContext(profile, {
    args: [online ? resolvable : unresolvable],
  });
}

const text = (page: Page) =>
  page.evaluate(() => document.body?.innerText ?? "");

const activeVersion = (page: Page) =>
  page.evaluate(
    `new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("message", (event) => resolve(event.data && event.data.version), { once: true });
      navigator.serviceWorker.ready.then((r) => r.active.postMessage({ type: "${OFFLINE_VERSION_MESSAGE}" }));
      setTimeout(() => resolve(null), 3000);
    })`,
  ) as Promise<string | null>;

const cacheKeys = (page: Page) =>
  page.evaluate(() => caches.keys()) as Promise<string[]>;
const registrations = (page: Page) =>
  page.evaluate(() =>
    navigator.serviceWorker.getRegistrations().then((list) => list.length),
  ) as Promise<number>;

async function installed(profile: string): Promise<void> {
  const context = await open(profile, true);
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForTimeout(500);
  await context.close();
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "smoke-offline-guide-"));
  try {
    // 1. Install and the guide on a failed navigation, at the same address.
    const profile = join(root, "a");
    await installed(profile);
    let context = await open(profile, false);
    let page = await context.newPage();
    await page.goto(`${origin}/deep/link?x=1`);
    const shown = await text(page);
    check(
      "a navigation that does not resolve shows the guide",
      shown.includes("Zapni Tailscale") && shown.includes(server.tailnet),
    );
    check(
      "the address keeps the deep link",
      page.url().endsWith("/deep/link?x=1"),
    );
    await context.close();

    // 2. A changed worker (new version, new page) replaces the old one on
    // the next load, and the old cache goes.
    context = await open(profile, true);
    page = await context.newPage();
    await page.goto(`${origin}/`);
    const before = await activeVersion(page);
    const oldCache = cacheName(digestOf(guide()));
    server.version = "v2";
    server.tailnet = "headscale.other.lazurio.io";
    await page.reload();
    await page.waitForTimeout(1500);
    await page.reload();
    const after = await activeVersion(page);
    const keys = await cacheKeys(page);
    check("the version before the update", before === "v1", String(before));
    check(
      "the next load installs the new worker",
      after === "v2",
      String(after),
    );
    check(
      "the old cache is gone and the new one kept",
      !keys.includes(oldCache) && keys.includes(cacheName(digestOf(guide()))),
      keys.join(","),
    );
    await context.close();
    context = await open(profile, false);
    page = await context.newPage();
    await page.goto(`${origin}/`);
    check(
      "the guide shows the new page",
      (await text(page)).includes("headscale.other.lazurio.io"),
    );
    await context.close();

    // 3. After 30 days without contact the worker removes itself.
    context = await open(profile, true);
    page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.waitForTimeout(1000);
    const current = cacheName(digestOf(guide()));
    const old = Date.now() - OFFLINE_EXPIRY_MS - 60_000;
    await page.evaluate(
      `caches.open(${JSON.stringify(current)}).then((c) => c.put(${JSON.stringify(OFFLINE_CONTACT_PATH)}, new Response(JSON.stringify({ at: ${old}, refreshedAt: ${old} }))))`,
    );
    await context.close();
    context = await open(profile, false);
    page = await context.newPage();
    let guided = false;
    try {
      await page.goto(`${origin}/`);
      guided = (await text(page)).includes("Zapni Tailscale");
    } catch {
      guided = false;
    }
    await page.waitForTimeout(500);
    await context.close();
    // Online again, on a page that registers nothing (the guide page itself).
    context = await open(profile, true);
    page = await context.newPage();
    await page.goto(`${origin}${OFFLINE_PAGE_PATH}`);
    const expiredLeft = await registrations(page);
    const expiredKeys = await cacheKeys(page);
    check("an expired worker does not guide", !guided);
    check(
      "and it removed itself and its caches",
      expiredLeft === 0 &&
        !expiredKeys.some((key) => key.startsWith("lazurio-offline-")),
      `${expiredLeft} ${expiredKeys.join(",")}`,
    );
    await context.close();

    // 4. A retiring worker at the same address removes itself and its caches.
    const profileB = join(root, "b");
    server.version = "v3";
    await installed(profileB);
    server.retired = true;
    context = await open(profileB, true);
    page = await context.newPage();
    // The app page asks for an update and gets the retiring worker; then a
    // page that registers nothing tells what is left.
    await page.goto(`${origin}/`);
    await page.waitForTimeout(2000);
    await page.goto(`${origin}${OFFLINE_PAGE_PATH}`);
    await page.waitForTimeout(500);
    const left = await registrations(page);
    const leftKeys = await cacheKeys(page);
    check("the retiring worker unregisters", left === 0, String(left));
    check(
      "and removes its caches",
      !leftKeys.some((key) => key.startsWith("lazurio-offline-")),
      leftKeys.join(","),
    );
    await context.close();
    server.retired = false;

    // 5. Without Service-Worker-Allowed the browser refuses the worker.
    const profileC = join(root, "c");
    server.allowScope = false;
    context = await open(profileC, true);
    page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.waitForTimeout(1500);
    const refused = await page.evaluate(
      () =>
        (window as unknown as { registrationError?: string })
          .registrationError ?? "",
    );
    check(
      "without the scope header the registration fails",
      refused.length > 0 && (await registrations(page)) === 0,
      refused.slice(0, 80),
    );
    await context.close();
    server.allowScope = true;
  } finally {
    listener.stop(true);
    await rm(root, { recursive: true, force: true });
  }
  for (const line of results) console.log(line);
  if (failed) process.exit(1);
}

await main();
