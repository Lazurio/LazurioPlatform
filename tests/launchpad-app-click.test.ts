import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSocketUrl, connectCdp } from "../src/browser/people/cdp";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { bootElementId } from "../src/launchpad/boot";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { binding, handoverEntry } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import { freePort } from "./fixtures/ports";

// The Launchpad's Chat and Automate tabs in a real page (the addendum of
// 2026-10-31 to the decision of 2026-10-17): a plain click follows the
// recorded origin as it is and the page asks its server for nothing on the
// way, no `POST /api/chat/pair`, no `POST /api/mausbot/pair`. T3 Code and
// MausBot pair an unpaired browser themselves. The hosted Launchpad is served
// behind a loopback stand-in for the gateway that adds its Host and cookie
// and records every request; the apps' origins are answered inside the
// browser, so nothing leaves this computer. Run in headless Chrome over
// DevTools with this repository's own client (src/browser/people/cdp.ts),
// as tests/public-vault.test.ts does; skipped where no Chrome is installed.
// `LAZURIO_TEST_CHROME` names one.

const chrome: string | null = (() => {
  const named = process.env.LAZURIO_TEST_CHROME;
  if (named !== undefined && named !== "") return named;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && existsSync(mac)) return mac;
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    const found = Bun.which(name);
    if (found !== null) return found;
  }
  return null;
})();
const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? -1;

const host = "workspace.example.lazurio.io";
const t3codeOrigin = `https://t3code.${host}`;
const mausbotOrigin = `https://mausbot.${host}`;

/** A hosted Launchpad whose entry records T3 Code and MausBot, behind a
 * loopback gateway stand-in that records every request it passes on. */
async function served() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-app-click-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-organization-personal";
  const port = freePort();
  const { team: _, ...owner } = organization.owner;
  const machine = binding({
    ...organization,
    owner,
    entry: {
      ...handoverEntry(host, port),
      mausbot: { external_origin: mausbotOrigin, listen_port: freePort() },
    },
  });
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    {
      path: parent,
      home: parent,
      platform: process.platform,
      run: async () => "timeout",
    },
  );
  const origin = `https://launchpad.${host}`;
  const requests: string[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const headers = new Headers(request.headers);
      headers.set("host", new URL(origin).host);
      headers.set("cookie", "__Secure-lazurio-workspace=valid");
      if (request.method !== "GET" && request.method !== "HEAD") {
        headers.set("origin", origin);
        headers.set("sec-fetch-site", "same-origin");
      }
      const answer = await fetch(
        `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? null
              : await request.arrayBuffer(),
          redirect: "manual",
        },
      );
      return new Response(await answer.arrayBuffer(), {
        status: answer.status,
        headers: answer.headers,
      });
    },
  });
  return {
    url: `http://127.0.0.1:${gateway.port}/`,
    requests,
    async close() {
      gateway.stop(true);
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** A headless Chrome of its own profile with one tab, in which the apps'
 * origins are answered by the browser itself: each request to them is
 * recorded and answered with an empty page. */
async function headlessChrome(executable: string) {
  const profile = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-app-click-chrome-")),
  );
  const child = Bun.spawn(
    [
      executable,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      // The runners' Linux user namespaces refuse Chrome's own sandbox;
      // only this test's loopback pages are opened.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (!existsSync(portFile)) {
    if (Date.now() - started > 15_000) throw new Error("Chrome did not start");
    await Bun.sleep(100);
  }
  const port = Number((await readFile(portFile, "utf8")).split("\n")[0]);
  const cdp = await connectCdp(await browserSocketUrl(port));
  const { targetId } = (await cdp.send("Target.createTarget", {
    url: "about:blank",
  })) as { targetId: string };
  const { sessionId } = (await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })) as { sessionId: string };
  const appRequests: string[] = [];
  cdp.onEvent((event) => {
    if (event.method !== "Fetch.requestPaused" || event.sessionId !== sessionId)
      return;
    const { requestId, request } = event.params as {
      requestId: string;
      request: { url: string };
    };
    appRequests.push(request.url);
    void cdp
      .send(
        "Fetch.fulfillRequest",
        {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/html" }],
          body: Buffer.from("<!doctype html><title>app</title>").toString(
            "base64",
          ),
        },
        sessionId,
      )
      .catch(() => undefined);
  });
  await cdp.send(
    "Fetch.enable",
    {
      patterns: [t3codeOrigin, mausbotOrigin].map((origin) => ({
        urlPattern: `${origin}/*`,
      })),
    },
    sessionId,
  );
  const evaluate = async (expression: string): Promise<unknown> => {
    const { result } = (await cdp.send(
      "Runtime.evaluate",
      { returnByValue: true, expression },
      sessionId,
    )) as { result: { value?: unknown } };
    return result.value;
  };
  return {
    appRequests,
    evaluate,
    navigate: (url: string) => cdp.send("Page.navigate", { url }, sessionId),
    async close() {
      cdp.close();
      child.kill();
      await child.exited;
      await rm(profile, { recursive: true, force: true });
    },
  };
}

/** Polls `read` until `done`, at most `withinMs`. */
async function until<A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
  withinMs: number,
): Promise<A> {
  const started = Date.now();
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    if (Date.now() - started > withinMs) throw new Error("The page never did");
    await Bun.sleep(50);
  }
}

// The tab of `app` in the switch at the top of the column, its address and
// whether the page is drawn; clicked as a person clicks it (a plain click).
const tab = (app: string) =>
  `document.querySelector("#column-head")?.shadowRoot?.querySelector('a[data-app="${app}"]')`;
const look = (app: string) =>
  `({ ready: document.documentElement.hasAttribute("data-ready"), href: ${tab(app)}?.href ?? null })`;
const click = (app: string) => `(${tab(app)}.click(), true)`;

test.skipIf(chrome === null || !posix || uid === 0)(
  "a plain click on Chat or Automate follows the recorded origin and asks the Launchpad for no pairing",
  async () => {
    if (chrome === null) return;
    const app = await served();
    const browser = await headlessChrome(chrome);
    try {
      for (const [name, origin] of [
        ["chat", t3codeOrigin],
        ["automate", mausbotOrigin],
      ] as const) {
        await browser.navigate(app.url);
        const drawn = (await until(
          () => browser.evaluate(look(name)),
          (state) =>
            (state as { ready: boolean; href: string | null }).ready &&
            (state as { href: string | null }).href !== null,
          15_000,
        )) as { href: string };
        // The tab is the recorded origin, as it is.
        expect(drawn.href).toBe(`${origin}/`);
        // The page knows the entry, from its boot document or from
        // `GET /api/entry`: all the old click needed to pair on the way.
        await until(
          async () =>
            app.requests.includes("GET /api/entry") ||
            ((await browser.evaluate(
              `document.getElementById(${JSON.stringify(bootElementId)})?.textContent?.includes(${JSON.stringify(origin)}) === true`,
            )) as boolean),
          (known) => known,
          10_000,
        );
        const seen = app.requests.length;
        const asked = browser.appRequests.length;
        expect(await browser.evaluate(click(name))).toBe(true);
        // The browser goes to the app's own origin, as recorded.
        await until(
          async () => browser.appRequests.length,
          (count) => count > asked,
          10_000,
        );
        expect(browser.appRequests.slice(asked, asked + 1)).toEqual([
          `${origin}/`,
        ]);
        expect(
          await until(
            async () => (await browser.evaluate("location.href")) as string,
            (href) => href === `${origin}/`,
            10_000,
          ),
        ).toBe(`${origin}/`);
        // And the Launchpad was asked nothing on the way: no pairing, no
        // request that changes anything (the page's own background reads
        // may still pass while it unloads).
        await Bun.sleep(300);
        expect([
          name,
          app.requests
            .slice(seen)
            .filter((request) => !request.startsWith("GET ")),
        ]).toEqual([name, []]);
      }
      // Never a pairing route, over the whole visit.
      expect(
        app.requests.filter((request) =>
          /\/api\/(chat|mausbot)\/pair$/.test(request),
        ),
      ).toEqual([]);
    } finally {
      await browser.close();
      await app.close();
    }
  },
  90_000,
);
