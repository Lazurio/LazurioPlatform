import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseIdentity } from "../src/update/identity";

// Tests the supplied bytes, never rebuilds or activates an installed product.
// POSIX fixture smoke only; not Windows, browser UI or update qualification.
const binary = process.argv[2];
assert.equal(process.argv.length, 3);
assert.ok(binary && isAbsolute(binary));
assert.ok(["darwin", "linux"].includes(process.platform));
const before = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const root = await realpath(await mkdtemp(join(tmpdir(), "candidate-smoke-")));
const folder = join(root, "Lazurio");
const env = { HOME: root, PATH: "/usr/bin:/bin" };
let server: ReturnType<typeof Bun.spawn> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
const cli = async (args: string[]) => {
  const child = Bun.spawn([binary, ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, "Candidate operation failed");
    assert.equal(error, "");
    return JSON.parse(output);
  } finally {
    clearTimeout(timeout);
  }
};
try {
  // The executable states its own identity; beside a candidate build it must
  // be the same fact as identity.json (docs/update.md "Identity in the binary").
  const embedded = parseIdentity(await cli(["--version", "--json"]));
  const declared = await readFile(
    join(dirname(binary), "identity.json"),
    "utf8",
  ).catch(() => undefined);
  if (declared !== undefined) {
    const { identity } = JSON.parse(declared);
    assert.deepEqual(embedded, {
      version: identity.version,
      commit: identity.sourceCommit,
      target: identity.target,
    });
  }
  const choices = [
    "--access",
    "local",
    "--purpose",
    "human",
    "--detail",
    "technical",
    "--coordination",
    "coordinator",
  ];
  assert.deepEqual(
    await cli([
      "folder-init",
      "--folder",
      folder,
      ...choices,
      "--locale",
      "cs",
    ]),
    { kind: "initialized", revision: 1 },
  );
  assert.deepEqual(
    await cli([
      "profile-update",
      "--folder",
      folder,
      ...choices,
      "--locale",
      "en",
      "--expected-revision",
      "1",
    ]),
    { kind: "updated", revision: 2 },
  );
  const child = Bun.spawn([binary, "launchpad", "--folder", folder], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  server = child;
  watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const reader = child.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const chunk = await reader.read();
    assert.ok(!chunk.done, "Launchpad exited before readiness");
    line += new TextDecoder().decode(chunk.value);
    assert.ok(line.length < 16_384, "Unexpected readiness output");
  }
  const session = new URL(JSON.parse(line.split("\n")[0] as string).url);
  assert.equal(session.hostname, "127.0.0.1");
  const page = await fetch(session.origin, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("<html"));
  const request = (authorized: boolean) =>
    fetch(new URL("/api/profile", session), {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        Origin: session.origin,
        ...(authorized
          ? { Authorization: `Bearer ${session.hash.slice(1)}` }
          : {}),
      },
      body: "{}",
    });
  assert.equal((await request(false)).status, 403);
  const profile = await request(true);
  assert.equal(profile.status, 200);
  const state = await profile.json();
  assert.equal(state.revision, 2);
  assert.equal(state.profile.locale, "en");
  child.kill("SIGTERM");
  assert.equal(await child.exited, 0);
  assert.equal(
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    before,
  );
  console.log(
    `PASS: candidate ${before}; CLI initialization/update, embedded HTML, API denial/profile and graceful shutdown. Not installer or browser UI qualification.`,
  );
} finally {
  if (watchdog) clearTimeout(watchdog);
  if (server && server.exitCode === null) {
    server.kill("SIGKILL");
    await server.exited;
  }
  await rm(root, { recursive: true, force: true });
}
