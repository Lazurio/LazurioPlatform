import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSocketUrl, connectCdp } from "../src/browser/people/cdp";

// Buddy GEN4's frame and the guide's last word to it, in a real browser
// (plan LZD-0033, the sign; Lazurio/LazurioPlatform#1121). Where the page
// follows Buddy GEN4's sign, a closed window holds no frame, but a message
// posted to a frame arrives only after the task that posted it, and never
// in a frame removed before that. Here the frame asks for an explanation,
// the person takes over and leaves the window closed, and the guide ends:
// the frame must still receive `lazurio.guide.closed`, and only then go.
// The page is the bubble and its element as the shell wires them
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
  if (typeof type === "string")
    parent.postMessage({ type: "test.received", received: type }, "*");
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
  "a closed window's GEN4 frame receives the guide's end before it goes",
  async () => {
    if (chrome === null) return;
    const server = await served();
    const browser = await headlessChrome(chrome);
    try {
      await browser.navigate(`http://127.0.0.1:${server.port}/`);
      await until(
        () => browser.evaluate("typeof buddyTest === 'object'"),
        (ready) => ready === true,
        15_000,
      );
      // The person opens the window; the frame loads and asks for an
      // explanation, which plays while the window steps aside.
      await browser.evaluate("buddyTest.bubble.toggle(), true");
      await until(
        async () => (await browser.evaluate(state())) as State,
        (seen) => seen.playing === "files",
        15_000,
      );
      await browser.evaluate(
        "buddyTest.bubble.guided({ type: 'started', explainer: 'files' }), true",
      );
      await until(
        async () => (await browser.evaluate(state())) as State,
        (seen) => seen.received.includes("lazurio.guide.started"),
        5_000,
      );
      // The person takes over and leaves the window closed; then the guide
      // ends. The frame hears it, and only then goes.
      await browser.evaluate(
        "buddyTest.bubble.toggle(), buddyTest.bubble.toggle(), true",
      );
      expect(((await browser.evaluate(state())) as State).frames).toBe(1);
      await browser.evaluate(
        "buddyTest.stop(), buddyTest.bubble.guided({ type: 'closed', explainer: 'files' }), true",
      );
      const heard = await until(
        async () => (await browser.evaluate(state())) as State,
        (seen) => seen.received.includes("lazurio.guide.closed"),
        5_000,
      );
      expect(heard.received).toContain("lazurio.guide.closed");
      const gone = await until(
        async () => (await browser.evaluate(state())) as State,
        (seen) => seen.frames === 0,
        5_000,
      );
      expect(gone.frames).toBe(0);
    } finally {
      await browser.close();
      server.stop(true);
    }
  },
  60_000,
);
