import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
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
  const port = await freePort();
  const started = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${files.config}`,
      files.script,
      "--root",
      build,
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
  try {
    let status = 0;
    while (status !== 200 && performance.now() - started < 10_000) {
      status = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" })
        .then((response) => response.status)
        .catch(() => 0);
      if (status !== 200) await Bun.sleep(5);
    }
    expect(status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/guide/`)).text()).toBe(
      "<h1>guide</h1>",
    );
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
  // Without its listener it refuses to start (Module Standard 4.2).
  const bare = Bun.spawn(
    [process.execPath, files.script, "--root", build, "--fallback", "404"],
    { env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore" },
  );
  expect(await bare.exited).toBe(2);
});
