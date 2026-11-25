import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSocketUrl, connectCdp } from "../src/browser/people/cdp";

// Review of #1253, through the view in a real Chrome (root decision 0210,
// addendum of 2026-11-25): where the page does not reach Buddy's origin, a
// click opens his card with the line and no action, never a frame; once the
// origin answers again, the next click opens his frame. The browser itself
// decides whether Buddy's origin answers: every request to it is failed or
// fulfilled by the test (a picture, or his page). Skipped where no Chrome is
// installed; `LAZURIO_TEST_CHROME` names one.

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
// A one-pixel PNG for his picture.
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  "base64",
);

async function served() {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "buddy-reach-page.ts")],
    target: "browser",
  });
  if (!built.success) throw new Error("The page did not build");
  const script = await built.outputs[0]?.text();
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/page.js")
        return new Response(script, {
          headers: { "content-type": "text/javascript" },
        });
      return new Response(
        '<!doctype html><title>page</title><body><script src="/page.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
}

async function headlessChrome(executable: string, reaches: () => boolean) {
  const profile = await realpath(
    await mkdtemp(join(tmpdir(), "buddy-reach-chrome-")),
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
    const { requestId, request } = event.params as {
      requestId: string;
      request: { url: string };
    };
    const picture = new URL(request.url).pathname === "/assets/avatar.webp";
    void (
      reaches()
        ? cdp.send(
            "Fetch.fulfillRequest",
            {
              requestId,
              responseCode: 200,
              responseHeaders: [
                {
                  name: "content-type",
                  value: picture ? "image/png" : "text/html",
                },
              ],
              body: (picture
                ? pixel
                : Buffer.from("<!doctype html><title>Buddy</title>")
              ).toString("base64"),
            },
            sessionId,
          )
        : cdp.send(
            "Fetch.failRequest",
            { requestId, errorReason: "AddressUnreachable" },
            sessionId,
          )
    ).catch(() => undefined);
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

type State = {
  layout: string | null;
  card: boolean;
  line: string | null;
  actionShown: boolean;
  frames: number;
};

async function until(
  read: () => Promise<State>,
  done: (state: State) => boolean,
  withinMs: number,
): Promise<State> {
  const started = Date.now();
  for (;;) {
    const state = await read();
    if (done(state)) return state;
    if (Date.now() - started > withinMs)
      throw new Error(`The page never did: ${JSON.stringify(state)}`);
    await Bun.sleep(50);
  }
}

test.skipIf(chrome === null || !posix || uid === 0)(
  "off the tailnet a click opens the card with no action and no frame; once Buddy answers again the next click opens his frame, and once he is lost again the card",
  async () => {
    if (chrome === null) return;
    let reaches = false;
    const server = await served();
    const browser = await headlessChrome(chrome, () => reaches);
    const read = async () =>
      (await browser.evaluate("buddyTest.state()")) as State;
    try {
      await browser.navigate(`http://127.0.0.1:${server.port}/`);
      await until(
        async () =>
          ((await browser.evaluate("typeof buddyTest === 'object'")) as boolean)
            ? read()
            : ({ layout: null } as State),
        (state) => state.layout !== null,
        15_000,
      );
      // Buddy's origin does not answer: the card, with the line, no action.
      await browser.evaluate("buddyTest.click(), true");
      const off = await until(
        read,
        (state) => state.card && state.layout === "panel",
        10_000,
      );
      expect(off.line).toContain("tailnet");
      expect(off.actionShown).toBe(false);
      expect(off.frames).toBe(0);
      // Closed, the tailnet turned on: the next click asks again and opens
      // his frame.
      await browser.evaluate("buddyTest.click(), true");
      await until(read, (state) => state.layout === "closed", 5_000);
      reaches = true;
      await browser.evaluate("buddyTest.click(), true");
      const on = await until(read, (state) => state.frames === 1, 10_000);
      expect(on.card).toBe(false);
      // Lost right after (well within a minute): closed, the next click asks
      // again and shows the card instead of opening the frame.
      await browser.evaluate("buddyTest.click(), true");
      await until(read, (state) => state.layout === "closed", 5_000);
      reaches = false;
      await browser.evaluate("buddyTest.click(), true");
      const lost = await until(
        read,
        (state) => state.card && state.layout === "panel",
        10_000,
      );
      expect(lost.actionShown).toBe(false);
    } finally {
      await browser.close();
      server.stop(true);
    }
  },
  90_000,
);
