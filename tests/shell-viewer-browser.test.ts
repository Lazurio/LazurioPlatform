import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSocketUrl, connectCdp } from "../src/browser/people/cdp";

// The coordinator's decision of 2026-11-25 08:31Z, in a real browser (review
// of #1255): a page that holds nothing of Lazurio's but the element a
// deliverer put there, `<lazurio-buddy version="staging">` or
// `"production"`, asks for the narrowed `viewer` and never for the whole
// account; a page whose element names no version asks for the whole
// document. The built shell is served by a local Bun server that answers
// the shell's document with 404, as an application host and a Module's
// origin without the Launchpad do, and records every path asked. Skipped
// where no Chrome is installed; `LAZURIO_TEST_CHROME` names one.

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

async function served(element: string) {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "src", "shell", "index.ts")],
    target: "browser",
    format: "esm",
  });
  if (!built.success) throw new Error("the shell did not build");
  const script = await built.outputs[0]?.text();
  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      asked.push(path);
      if (path === "/.lazurio/shell.js")
        return new Response(script, {
          headers: { "content-type": "text/javascript" },
        });
      if (path === "/")
        return new Response(
          `<!doctype html><title>app</title><body><main>App</main><script type="module" src="/.lazurio/shell.js"></script>${element}</body>`,
          { headers: { "content-type": "text/html" } },
        );
      return new Response("not found", { status: 404 });
    },
  });
  return { server, asked };
}

async function headlessChrome(executable: string) {
  const profile = await realpath(
    await mkdtemp(join(tmpdir(), "viewer-chrome-")),
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
  return {
    navigate: (url: string) => cdp.send("Page.navigate", { url }, sessionId),
    async close() {
      cdp.close();
      child.kill();
      await child.exited;
      await rm(profile, { recursive: true, force: true });
    },
  };
}

const accountPaths = (asked: readonly string[]) =>
  asked.filter((path) => path.startsWith("/.lazurio/account/"));

async function askedFor(executable: string, element: string) {
  const { server, asked } = await served(element);
  const browser = await headlessChrome(executable);
  try {
    await browser.navigate(`http://127.0.0.1:${server.port}/`);
    const started = Date.now();
    while (accountPaths(asked).length === 0 && Date.now() - started < 15_000)
      await Bun.sleep(100);
    // A little longer, so a second read would show too.
    await Bun.sleep(500);
    return accountPaths(asked);
  } finally {
    await browser.close();
    server.stop(true);
  }
}

test.skipIf(chrome === null)(
  "a page with only the element a deliverer named STAGING or production asks for the narrowed viewer, never the whole account",
  async () => {
    for (const version of ["staging", "production"]) {
      const paths = await askedFor(
        chrome as string,
        `<lazurio-buddy version="${version}"></lazurio-buddy>`,
      );
      expect(paths.length).toBeGreaterThan(0);
      expect(new Set(paths)).toEqual(new Set(["/.lazurio/account/viewer"]));
    }
    // Without a deliverer's version: the whole document, as before.
    const plain = await askedFor(
      chrome as string,
      "<lazurio-buddy></lazurio-buddy>",
    );
    expect(plain.length).toBeGreaterThan(0);
    expect(new Set(plain)).toEqual(new Set(["/.lazurio/account/environments"]));
  },
  120_000,
);
