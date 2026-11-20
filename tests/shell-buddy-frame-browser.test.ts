import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSocketUrl, connectCdp } from "../src/browser/people/cdp";

// Buddy's frame and whether his window shows it, in a real browser (F60's
// addendum of 2026-11-20). The frame stays alive inside a closed window
// (F60 point 3), and the host tells it with `lazurio.buddy.shown` whether
// the window shows it, so that T3 Code does not read his answers as seen
// while it is hidden. Here the person opens the window, the frame asks for
// an explanation, the guide ends, and the person closes the window on the
// same page: the frame receives every word, in order, and stays. The page
// is the bubble and its element as the shell wires them
// (tests/fixtures/buddy-frame-page.ts); Buddy's origin is answered inside
// the browser by a page that tells the host every message it receives, so
// nothing leaves this computer. Run in headless Chrome over DevTools with
// this repository's own client, as tests/launchpad-app-click.test.ts does;
// skipped where no Chrome is installed. `LAZURIO_TEST_CHROME` names one.

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

const buddyOrigin = "https://buddy.example.lazurio.io";

// Buddy's frame: ready, then it asks for an explanation; every message from
// its parent is told back to the parent.
const framePage = `<!doctype html><title>Buddy</title><script>
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const type = event.data && event.data.type;
  if (typeof type !== "string") return;
  const received = type === "lazurio.buddy.shown" ? type + ":" + event.data.shown : type;
  parent.postMessage({ type: "test.received", received }, "*");
});
parent.postMessage({ type: "lazurio.buddy.ready", v: 1 }, "*");
parent.postMessage({ type: "lazurio.guide.play", v: 1, explainer: "files" }, "*");
</script>`;

async function served() {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "buddy-frame-page.ts")],
    target: "browser",
  });
  if (!built.success) throw new Error("The page did not build");
  const script = await built.outputs[0]?.text();
  if (script === undefined) throw new Error("The page did not build");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/page.js")
        return new Response(script, {
          headers: { "content-type": "text/javascript" },
        });
      return new Response(
        '<!doctype html><title>page</title><body><script src="/page.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return server;
}

/** A headless Chrome of its own profile with one tab, in which Buddy's
 * origin is answered by the browser itself. Site isolation is off, so that
 * the tab's own interception answers the frame too. */
async function headlessChrome(executable: string) {
  const profile = await realpath(
    await mkdtemp(join(tmpdir(), "buddy-frame-chrome-")),
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
      "--disable-site-isolation-trials",
      "--disable-features=IsolateOrigins,site-per-process",
      // The runners' Linux user namespaces refuse Chrome's own sandbox;
      // only this test's loopback page and its stand-in frame are opened.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (!existsSync(portFile)) {
    if (Date.now() - started > 45_000) throw new Error("Chrome did not start");
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
  cdp.onEvent((event) => {
    if (event.method !== "Fetch.requestPaused" || event.sessionId !== sessionId)
      return;
    const { requestId } = event.params as { requestId: string };
    void cdp
      .send(
        "Fetch.fulfillRequest",
        {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/html" }],
          body: Buffer.from(framePage).toString("base64"),
        },
        sessionId,
      )
      .catch(() => undefined);
  });
  await cdp.send(
    "Fetch.enable",
    { patterns: [{ urlPattern: `${buddyOrigin}/*` }] },
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

const state = () =>
  `({ frames: buddyTest.frames(), received: [...buddyTest.received], playing: buddyTest.playing() })`;
type State = { frames: number; received: string[]; playing: string | null };

test.skipIf(chrome === null || !posix || uid === 0)(
  "the frame hears whether the window shows it, in order, and stays alive in a closed window",
  async () => {
    if (chrome === null) return;
    const server = await served();
    const browser = await headlessChrome(chrome);
    const read = async () => (await browser.evaluate(state())) as State;
    try {
      await browser.navigate(`http://127.0.0.1:${server.port}/`);
      await until(
        () => browser.evaluate("typeof buddyTest === 'object'"),
        (ready) => ready === true,
        15_000,
      );
      // The person opens the window; the frame loads, hears it is shown,
      // and asks for an explanation, which plays while the window steps
      // aside.
      await browser.evaluate("buddyTest.bubble.toggle(), true");
      await until(read, (seen) => seen.playing === "files", 15_000);
      await browser.evaluate(
        "buddyTest.bubble.guided({ type: 'started', explainer: 'files' }), true",
      );
      await browser.evaluate(
        "buddyTest.stop(), buddyTest.bubble.guided({ type: 'done', explainer: 'files' }), true",
      );
      // The person closes the window on the same page.
      await browser.evaluate("buddyTest.bubble.toggle(), true");
      const closed = await until(
        read,
        (seen) =>
          seen.received.filter((type) => type.startsWith("lazurio.buddy.shown"))
            .length >= 4,
        5_000,
      );
      expect(
        closed.received.filter(
          (type) =>
            type.startsWith("lazurio.buddy.shown") ||
            type.startsWith("lazurio.guide."),
        ),
      ).toEqual([
        "lazurio.buddy.shown:true",
        "lazurio.buddy.shown:false",
        "lazurio.guide.started",
        "lazurio.guide.done",
        "lazurio.buddy.shown:true",
        "lazurio.buddy.shown:false",
      ]);
      // The frame stays alive inside the closed window.
      expect(closed.frames).toBe(1);
    } finally {
      await browser.close();
      server.stop(true);
    }
  },
  60_000,
);
