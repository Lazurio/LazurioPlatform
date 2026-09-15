import { strict as assert } from "node:assert";
import { chmod, copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Only a newly created temporary fixture is written; no installed roots are discovered.
const temporary = await mkdtemp(join(tmpdir(), "platform-proof-"));
const binary = join(
  temporary,
  process.platform === "win32" ? "proof.exe" : "proof",
);
const source = resolve(
  `dist/platform-proof${process.platform === "win32" ? ".exe" : ""}`,
);
const args = [
  "--purpose",
  "buddy",
  "--detail",
  "technical",
  "--coordination",
  "coordinator",
];
// No PATH, BUN_OPTIONS or BUN_BE_BUN inherited. This is dependency isolation, not an OS sandbox.
const env =
  process.platform === "win32"
    ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
    : {};
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  await copyFile(source, binary);
  await chmod(binary, 0o755);
  const cli = Bun.spawn([binary, "preview", ...args], {
    cwd: temporary,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const expected = JSON.parse(await new Response(cli.stdout).text());
  assert.equal(await cli.exited, 0);
  server = Bun.spawn([binary, "serve", ...args], {
    cwd: temporary,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = server.stdout as ReadableStream<Uint8Array>;
  const reader = output.getReader();
  let text = "";
  const timeout = setTimeout(() => server?.kill(), 10000);
  try {
    while (!text.includes("\n")) {
      const part = await reader.read();
      assert(!part.done, "server exited before announcing URL");
      text += new TextDecoder().decode(part.value);
    }
    const { url } = JSON.parse(text.slice(0, text.indexOf("\n")));
    assert.equal(new URL(url).hostname, "127.0.0.1");
    assert.deepEqual(
      await (await fetch(new URL("status", url))).json(),
      expected,
    );
    const html = await (await fetch(url)).text();
    assert(html.includes("Platform proof"));
    const script = html.match(/src="([^"]+\.js)"/);
    assert(script?.[1], "embedded compiled UI script present");
    const js = await fetch(new URL(script[1], url));
    assert.equal(js.status, 200);
    assert((await js.text()).includes("/status"));
    assert.equal((await fetch(new URL("unknown", url))).status, 404);
    const invalid = Bun.spawn([binary, "preview", ...args, "--unexpected"], {
      cwd: temporary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.notEqual(await invalid.exited, 0);
    assert.deepEqual(await readdir(temporary), [
      process.platform === "win32" ? "proof.exe" : "proof",
    ]);
    console.log(
      "PASS: isolated standalone CLI, embedded HTML/JS, shared HTTP result, invalid CLI rejection, no cwd writes",
    );
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
} finally {
  if (server) {
    server.kill();
    await server.exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
