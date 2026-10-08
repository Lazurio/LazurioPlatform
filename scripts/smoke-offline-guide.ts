import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  offlineGuideHeaders,
  offlineWorker,
  offlineWorkerHeaders,
} from "../src/launchpad/offline-guide";
import { renderOfflineGuide } from "../src/shell/offline-page";
import {
  cacheName,
  OFFLINE_CONTACT_PATH,
  OFFLINE_EXPIRY_MS,
  OFFLINE_PAGE_PATH,
  OFFLINE_VERSION_MESSAGE,
  OFFLINE_WORKER_PATH,
} from "../src/shell/offline-policy";

// Smoke of the offline guide (decision F41) in a real Chromium, with the
// worker, the page and the shell's registration exactly as the Launchpad and
// the shell build them. It proves what unit tests cannot: a navigation whose
// name does not resolve shows the guide at the same address; a changed worker
// replaces the old one on the next load and drops its cache; after 30 days
// without contact the worker removes itself instead of guiding; when the
// Environment stops keeping the guide (its tailnet dropped, or the guide
// retired) while its pages keep loading, the next load removes the installed
// worker and its caches and no later load registers one again; a Launchpad
// rolled back to a release before the guide, which answers neither address
// and registers nothing, still loses the worker at its next refresh; and
// without `Service-Worker-Allowed` the browser refuses the worker. Playwright
// is supplied externally, as for smoke-application-ui.ts:
//   NODE_PATH=<directory with playwright> bun scripts/smoke-offline-guide.ts

const { chromium } = createRequire(import.meta.url)("playwright");

const host = "environment.localhost";
const server: {
  version: string;
  /** The handover's tailnet; null: the Environment keeps no guide. */
  tailnet: string | null;
  allowScope: boolean;
  /** A Launchpad from before the guide: neither address, no registration. */
  legacy: boolean;
  /** How often the browser asked for the worker's script. */
  workerFetches: number;
} = {
  version: "v1",
  tailnet: "headscale.example.lazurio.io",
  allowScope: true,
  legacy: false,
  workerFetches: 0,
};

const guide = (): string | null =>
  server.tailnet === null
    ? null
    : renderOfflineGuide({
        locale: "cs",
        environment: "Team Smoke",
        organization: "Example",
        tailnet: server.tailnet,
        docs: "https://documentation.lazurio.ai/cs/guide/tailscale/",
      });
const digestOf = (page: string | null) =>
  createHash("sha256")
    .update(page ?? "")
    .digest("hex");

/** The shell's registration (`src/shell/offline-guide.ts`) built for the
 * page, as the shell's bundle carries it. */
async function registrationScript(root: string): Promise<string> {
  const entry = join(root, "registration.ts");
  await writeFile(
    entry,
    `import { registerGuide } from ${JSON.stringify(join(import.meta.dir, "../src/shell/offline-guide"))};
(globalThis as unknown as { lazurioRegisterGuide: typeof registerGuide }).lazurioRegisterGuide = registerGuide;
`,
  );
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
  });
  const output = built.outputs[0];
  if (!built.success || output === undefined)
    throw new Error("The registration did not build");
  return output.text();
}
let registration = "";

// The app page hands the shell's registration its document as the shell's
// state does: an Environment's, saying whether it keeps the guide.
const appPage = () =>
  server.legacy
    ? `<!doctype html><meta charset="utf-8"><title>App</title><h1>APP</h1>`
    : `<!doctype html><meta charset="utf-8"><title>App</title><h1>APP</h1>
<script>${registration}</script>
<script>lazurioRegisterGuide(${JSON.stringify({ current: "environment", ...(server.tailnet === null ? {} : { offlineGuide: true }) })});</script>`;

const listener = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (
      server.legacy &&
      (path === OFFLINE_PAGE_PATH || path === OFFLINE_WORKER_PATH)
    )
      return new Response("not-found", { status: 404 });
    if (path === OFFLINE_PAGE_PATH) {
      const page = guide();
      return page === null
        ? new Response("not found", { status: 404 })
        : new Response(page, { headers: offlineGuideHeaders });
    }
    if (path === OFFLINE_WORKER_PATH) {
      server.workerFetches += 1;
      const headers: Record<string, string> = { ...offlineWorkerHeaders };
      if (!server.allowScope) delete headers["Service-Worker-Allowed"];
      return new Response(offlineWorker(guide(), server.version), { headers });
    }
    return new Response(appPage(), {
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
    registration = await registrationScript(root);
    // 1. Install and the guide on a failed navigation, at the same address.
    const profile = join(root, "a");
    await installed(profile);
    let context = await open(profile, false);
    let page = await context.newPage();
    await page.goto(`${origin}/deep/link?x=1`);
    const shown = await text(page);
    check(
      "a navigation that does not resolve shows the guide",
      shown.includes("Zapni Tailscale") &&
        shown.includes("headscale.example.lazurio.io"),
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

    // 4. The Environment stops keeping the guide (its tailnet dropped from
    // the handover, or the guide retired) while its pages keep loading: the
    // next load checks the installed worker, gets the retiring worker at the
    // same address, and the worker removes itself and its caches. No later
    // load registers one again, until the Environment keeps the guide again.
    const profileB = join(root, "b");
    server.version = "v3";
    await installed(profileB);
    server.tailnet = null;
    context = await open(profileB, true);
    page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.waitForTimeout(2000);
    await page.reload();
    await page.waitForTimeout(500);
    const left = await registrations(page);
    const leftKeys = await cacheKeys(page);
    check(
      "a dropped tailnet: the next load removes the worker",
      left === 0,
      String(left),
    );
    check(
      "and its caches",
      !leftKeys.some((key) => key.startsWith("lazurio-offline-")),
      leftKeys.join(","),
    );
    const fetchesAfter = server.workerFetches;
    await page.reload();
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForTimeout(500);
    check(
      "and no later load registers one again",
      server.workerFetches === fetchesAfter &&
        (await registrations(page)) === 0,
      `${server.workerFetches - fetchesAfter} fetches`,
    );
    server.tailnet = "headscale.example.lazurio.io";
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    check(
      "a tailnet again: the next load registers it again",
      (await registrations(page)) === 1,
    );
    await context.close();

    // 5. A Launchpad rolled back to a release before the guide: it answers
    // neither address and its pages register nothing, so no update check
    // can reach the worker. Its next refresh of the page is answered 404,
    // and it removes itself and its caches instead of renewing its contact.
    const profileD = join(root, "d");
    await installed(profileD);
    context = await open(profileD, true);
    page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.waitForTimeout(500);
    const kept = cacheName(digestOf(guide()));
    const recent = Date.now();
    await page.evaluate(
      `caches.open(${JSON.stringify(kept)}).then((c) => c.put(${JSON.stringify(OFFLINE_CONTACT_PATH)}, new Response(JSON.stringify({ at: ${recent}, refreshedAt: ${recent - 2 * 60 * 60 * 1000} }))))`,
    );
    server.legacy = true;
    await page.reload();
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForTimeout(500);
    const rolledBack = await registrations(page);
    const rolledBackKeys = await cacheKeys(page);
    check(
      "a rollback before the guide: the next refresh removes the worker",
      rolledBack === 0,
      String(rolledBack),
    );
    check(
      "and its caches",
      !rolledBackKeys.some((key) => key.startsWith("lazurio-offline-")),
      rolledBackKeys.join(","),
    );
    await context.close();
    server.legacy = false;

    // 6. Without Service-Worker-Allowed the browser refuses the worker: it
    // fetches the script and keeps no registration.
    const profileC = join(root, "c");
    server.allowScope = false;
    const fetchesBefore = server.workerFetches;
    context = await open(profileC, true);
    page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.waitForTimeout(1500);
    check(
      "without the scope header the registration fails",
      server.workerFetches > fetchesBefore && (await registrations(page)) === 0,
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
