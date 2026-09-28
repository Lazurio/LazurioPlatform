import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchpadOnce } from "../scripts/qualify/launchpad-once";
import { streamRedacted } from "../scripts/qualify/redact";

// A fake Launchpad whose stderr carries what a real one might: the startup
// line with its session URL (a bearer token in the fragment) and an
// Authorization header. The printed output must carry none of it.
const fragment =
  "deadbeefdeadbeef0123456789abcdef0123456789abcdef0123456789abcdef";
const bearer = "b34r3r5ecr3t";
const page = Bun.serve({ port: 0, fetch: () => new Response("page") });
let directory: string | undefined;
afterAll(async () => {
  page.stop(true);
  if (directory) await rm(directory, { recursive: true });
});

async function fake(name: string, body: string) {
  directory ??= await mkdtemp(join(tmpdir(), "launchpad-once-"));
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}
const stderrLines = [
  `echo '{"url":"http://127.0.0.1:${page.port}/settings#${fragment}","scope":"local-development-profile-panel"}' >&2`,
  `echo 'Authorization: Bearer ${bearer}' >&2`,
].join("\n");

test("a started Launchpad: the outcome is detected, its stderr is printed only redacted", async () => {
  const executable = await fake(
    "serving",
    [
      stderrLines,
      `echo '{"url":"http://127.0.0.1:${page.port}/#${fragment}","scope":"local-development-profile-panel"}'`,
      "trap 'exit 0' TERM",
      "while :; do sleep 0.1; done",
    ].join("\n"),
  );
  const printed: string[] = [];
  const result = await launchpadOnce({
    executable,
    folder: "/nonexistent",
    env: { PATH: process.env.PATH },
    print: (line) => printed.push(line),
  });
  expect(result).toEqual({
    started: { scope: "local-development-profile-panel" },
    status: 200,
    exit: 0,
  });
  const text = printed.join("\n");
  expect(text).toContain("#<redacted>");
  expect(text).toContain("Authorization: <redacted>");
  for (const secret of [fragment, bearer]) expect(text).not.toContain(secret);
});

test("a Launchpad that exits early: the failure is detected and what it wrote is flushed, redacted", async () => {
  const executable = await fake("exiting", `${stderrLines}\nexit 3`);
  const printed: string[] = [];
  await expect(
    launchpadOnce({
      executable,
      folder: "/nonexistent",
      env: { PATH: process.env.PATH },
      print: (line) => printed.push(line),
    }),
  ).rejects.toThrow("The Launchpad printed no start line");
  const text = printed.join("\n");
  expect(text).toContain("#<redacted>");
  expect(text).toContain("<redacted>");
  for (const secret of [fragment, bearer]) expect(text).not.toContain(secret);
});

test("streamed output is redacted line by line, the last line flushed", async () => {
  const written: string[] = [];
  await streamRedacted(
    new Response(
      `ok line\nhttp://127.0.0.1:1/#${fragment}\nAuthorization: Bearer ${bearer}`,
    ).body as ReadableStream<Uint8Array>,
    (line) => written.push(line),
  );
  expect(written).toEqual([
    "ok line",
    "http://127.0.0.1:1/#<redacted>",
    "Authorization: <redacted>",
  ]);
});
