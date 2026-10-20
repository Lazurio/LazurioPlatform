import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerStatic,
  resolveStaticRequest,
  servedRoots,
} from "../src/modules/built/static-server";
import {
  staticServerFiles,
  staticServerServes,
  staticServerSource,
} from "../src/modules/built/store";

// The Platform's static server of built apps (decision F58): what it answers
// for each path of a build, the headers it answers with, the previous build's
// assets, and the written-out script as the app's one process on its declared
// listener, ready at once and ending with exit 0 on SIGTERM.
let root = "";
let build = "";
let previous = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "static-server-")));
  build = join(root, "build");
  previous = join(root, "previous");
  const files: Record<string, string> = {
    "index.html": "<h1>home</h1>",
    "404.html": "<h1>missing</h1>",
    "guide/index.html": "<h1>guide</h1>",
    "about.html": "<h1>about</h1>",
    "_astro/page.B4x9zQ1a.js": "console.log('new');",
    "assets/app-Dk3f9a1b.css": "body{}",
    "robots.txt": "User-agent: *",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(build, path, ".."), { recursive: true });
    await writeFile(join(build, path), text);
  }
  await mkdir(join(previous, "_astro"), { recursive: true });
  await writeFile(join(previous, "_astro/page.Old00000.js"), "old");
  await writeFile(join(previous, "index.html"), "<h1>old home</h1>");
  // A link out of the build is never followed.
  await writeFile(join(root, "secret.txt"), "outside");
  await symlink(join(root, "secret.txt"), join(build, "leak.txt"));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("a path is the exact file, then <path>.html, then <path>/index.html; a directory without its slash redirects", async () => {
  const resolve = (path: string, fallback: "404" | "spa" = "404") =>
    resolveStaticRequest(build, path, fallback);
  expect(await resolve("/")).toEqual({
    kind: "file",
    path: join(build, "index.html"),
    status: 200,
  });
  expect(await resolve("/guide/")).toMatchObject({ kind: "file", status: 200 });
  expect(await resolve("/guide")).toEqual({
    kind: "redirect",
    location: "/guide/",
  });
  expect(await resolve("/about")).toEqual({
    kind: "file",
    path: join(build, "about.html"),
    status: 200,
  });
  expect(await resolve("/robots.txt")).toMatchObject({ status: 200 });
  // `404`: the build's 404.html with its status; `spa`: the index for a
  // path without an extension, nothing for a missing file.
  expect(await resolve("/nowhere")).toEqual({
    kind: "file",
    path: join(build, "404.html"),
    status: 404,
  });
  expect(await resolve("/deals/42", "spa")).toEqual({
    kind: "file",
    path: join(build, "index.html"),
    status: 200,
  });
  expect(await resolve("/missing.js", "spa")).toEqual({ kind: "missing" });
  // Nothing outside the build: no `..`, no encoded separator, no link out.
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/a%2Fb", "/%00"])
    expect(await resolve(path)).toEqual({ kind: "refused" });
  expect(await resolve("/leak.txt")).toMatchObject({ status: 404 });
});

test("HTML is revalidated, content-named files are kept a year, a tag answers 304, HEAD has no body, other methods 405", async () => {
  const ask = (path: string, init?: RequestInit) =>
    answerStatic(new Request(`http://127.0.0.1${path}`, init), {
      root: build,
      fallback: "404",
    });
  const page = await ask("/");
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-cache");
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toBe("<h1>home</h1>");
  for (const path of ["/_astro/page.B4x9zQ1a.js", "/assets/app-Dk3f9a1b.css"])
    expect((await ask(path)).headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  expect((await ask("/robots.txt")).headers.get("cache-control")).toBe(
    "no-cache",
  );
  const tag = page.headers.get("etag") as string;
  expect((await ask("/", { headers: { "If-None-Match": tag } })).status).toBe(
    304,
  );
  const head = await ask("/", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  const post = await ask("/", { method: "POST" });
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
  expect((await ask("/guide?x=1")).headers.get("location")).toBe("/guide/?x=1");
  expect((await ask("/nowhere")).status).toBe(404);
});

test("an asset missing from this build is served from the previous one, a page never", async () => {
  const ask = (path: string) =>
    answerStatic(new Request(`http://127.0.0.1${path}`), {
      root: build,
      previous,
      fallback: "404",
    });
  const old = await ask("/_astro/page.Old00000.js");
  expect(old.status).toBe(200);
  expect(await old.text()).toBe("old");
  expect(await (await ask("/")).text()).toBe("<h1>home</h1>");
  expect((await ask("/_astro/never.js")).status).toBe(404);
});

async function freePort() {
  return new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
}

test("the written-out server runs as the app's process: healthy at once on its listener, exit 0 on SIGTERM, and --check answers like it serves", async () => {
  const files = await staticServerFiles(join(root, "cache"));
  // Written once per version of its text, beside an empty Bun configuration.
  expect(await Bun.file(files.script).text()).toBe(staticServerSource());
  expect(await Bun.file(files.config).text()).toBe("");
  expect(await staticServerFiles(join(root, "cache"))).toEqual(files);
  // The app's builds and the record of what it serves, as the store keeps
  // them: <key>/ beside served.json.
  const app = join(root, "app");
  const [first, second] = ["a".repeat(40), "b".repeat(40)];
  await cp(build, join(app, first), { recursive: true });
  await cp(build, join(app, second), { recursive: true });
  await writeFile(join(app, second, "index.html"), "<h1>second</h1>");
  await rm(join(app, second, "_astro"), { recursive: true });
  await mkdir(join(app, second, "_astro"));
  await writeFile(join(app, second, "_astro/page.Cz2new00.js"), "second");
  const served = join(app, "served.json");
  const record = async (key: string, previous: string | null) => {
    const temporary = `${served}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        schema_version: "lazurio.build-served.v1",
        mode: "built",
        key,
        commit: key,
        previous,
        at: new Date().toISOString(),
      }),
    );
    await rename(temporary, served);
  };
  await record(first, null);
  const port = await freePort();
  const started = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${files.config}`,
      files.script,
      "--served",
      served,
      "--fallback",
      "404",
    ],
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        LAZURIO_RUNTIME_ENTRYPOINT_ID: "web",
        LAZURIO_RUNTIME_LISTENER_WEB_HOST: "127.0.0.1",
        LAZURIO_RUNTIME_LISTENER_WEB_PORT: String(port),
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const page = (path: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" })
      .then(async (response) => ({
        status: response.status,
        text: await response.text(),
      }))
      .catch(() => ({ status: 0, text: "" }));
  try {
    let status = 0;
    while (status !== 200 && performance.now() - started < 10_000) {
      status = (await page("/")).status;
      if (status !== 200) await Bun.sleep(5);
    }
    expect(status).toBe(200);
    expect((await page("/")).text).toBe("<h1>home</h1>");
    expect((await page("/guide/")).text).toBe("<h1>guide</h1>");
    // A swap is a new record: probed every 20 ms, no request is refused,
    // and the next answers come from the new build, its assets and the
    // previous build's alike.
    let refused = 0;
    let probes = 0;
    let probing = true;
    const probe = (async () => {
      while (probing) {
        probes++;
        if ((await page("/")).status !== 200) refused++;
        await Bun.sleep(20);
      }
    })();
    await Bun.sleep(200);
    await record(second, first);
    const switchedBy = performance.now() + 2000;
    while (
      (await page("/")).text !== "<h1>second</h1>" &&
      performance.now() < switchedBy
    )
      await Bun.sleep(5);
    await Bun.sleep(200);
    probing = false;
    await probe;
    expect((await page("/")).text).toBe("<h1>second</h1>");
    expect(probes).toBeGreaterThan(10);
    expect(refused).toBe(0);
    expect((await page("/_astro/page.Cz2new00.js")).text).toBe("second");
    expect((await page("/_astro/page.B4x9zQ1a.js")).status).toBe(200);
    // A record of the development version (the app is about to be stopped)
    // keeps the build it serves.
    const temporary = `${served}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        schema_version: "lazurio.build-served.v1",
        mode: "dev",
        key: null,
        commit: null,
        previous: null,
        at: new Date().toISOString(),
      }),
    );
    await rename(temporary, served);
    expect((await page("/")).text).toBe("<h1>second</h1>");
  } finally {
    child.kill("SIGTERM");
  }
  expect(await child.exited).toBe(0);
  const serves = (path: string) =>
    staticServerServes({
      executable: process.execPath,
      files,
      root: build,
      path,
      fallback: "404",
    });
  expect(await serves("/")).toBe(true);
  expect(await serves("/guide/")).toBe(true);
  // A redirect or the 404 page never reports healthy.
  expect(await serves("/guide")).toBe(false);
  expect(await serves("/nowhere")).toBe(false);
  // Without its listener, or without a build to serve, it refuses to start.
  const bare = Bun.spawn(
    [process.execPath, files.script, "--served", served, "--fallback", "404"],
    { env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore" },
  );
  expect(await bare.exited).toBe(2);
  const nothing = Bun.spawn(
    [
      process.execPath,
      files.script,
      "--served",
      join(app, "missing", "served.json"),
      "--fallback",
      "404",
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        LAZURIO_RUNTIME_ENTRYPOINT_ID: "web",
        LAZURIO_RUNTIME_LISTENER_WEB_HOST: "127.0.0.1",
        LAZURIO_RUNTIME_LISTENER_WEB_PORT: String(await freePort()),
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  expect(await nothing.exited).toBe(2);
});

test("a record that cannot be read now is read again at the next request; a development record keeps the build served", async () => {
  const app = join(root, "retry");
  await mkdir(app, { recursive: true });
  const served = join(app, "served.json");
  const record = async (value: Record<string, unknown>) => {
    const temporary = `${served}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        schema_version: "lazurio.build-served.v1",
        commit: null,
        at: "2026-10-20T00:00:00.000Z",
        ...value,
      }),
    );
    await rename(temporary, served);
  };
  const [first, second] = ["c".repeat(40), "d".repeat(40)];
  await record({ mode: "built", key: first, previous: null });
  const roots = servedRoots(served);
  expect((await roots()).root).toBe(join(app, first));
  // A new record that cannot be read for a moment: the last build stays…
  await record({ mode: "built", key: second, previous: first });
  await chmod(served, 0o000);
  try {
    expect((await roots()).root).toBe(join(app, first));
  } finally {
    // …and the same file, readable again, is read at the next request.
    await chmod(served, 0o600);
  }
  expect(await roots()).toEqual({
    root: join(app, second),
    previous: join(app, first),
  });
  // A development record (the app is about to be stopped) keeps it.
  await record({ mode: "dev", key: null, previous: null });
  expect((await roots()).root).toBe(join(app, second));
});
