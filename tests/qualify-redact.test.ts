import { expect, test } from "bun:test";
import { logLines, redact } from "../scripts/qualify/redact";

// A synthetic unit journal as the diagnostics would print it: the
// Launchpad's startup line carries its session URL with a bearer token in the
// fragment. None of the secrets below may reach the public job log.
const fragment =
  "deadbeefdeadbeef0123456789abcdef0123456789abcdef0123456789abcdef";
const cookie = "lazurio_session=c0ffee1234567890";
const queryToken = "q7u3ry70k3n";
const journal = [
  "● lazurio-launchpad.service - Lazurio Launchpad",
  "     Active: active (running) since Mon 2026-09-28 17:37:17 UTC; 3s ago",
  "   Main PID: 4242 (lazurio)",
  `Sep 28 17:37:18 runner lazurio[4242]: {"url":"http://127.0.0.1:1/settings#${fragment}","scope":"local-development-profile-panel"}`,
  `Sep 28 17:37:19 runner lazurio[4242]: Set-Cookie: ${cookie}; HttpOnly; SameSite=Strict`,
  `Sep 28 17:37:20 runner lazurio[4242]: GET /api/update/status?token=${queryToken}&x=1 200`,
  `Sep 28 17:37:21 runner lazurio[4242]: {"sessionToken":"${queryToken}","credential":42,"ok":true}`,
  "Sep 28 17:37:22 runner lazurio[4242]: Authorization: Bearer abcdef123456",
  "ActiveState=active",
  "SubState=running",
  "Result=success",
  "NRestarts=0",
  "ExecMainStatus=0",
].join("\n");

test("the diagnostics print no secret, and still every state line", () => {
  const printed = logLines(journal, 120).join("\n");
  for (const secret of [
    fragment,
    cookie,
    "c0ffee1234567890",
    queryToken,
    "abcdef123456",
  ])
    expect(printed).not.toContain(secret);
  for (const state of [
    "Active: active (running)",
    "Main PID: 4242 (lazurio)",
    "ActiveState=active",
    "SubState=running",
    "Result=success",
    "NRestarts=0",
    "ExecMainStatus=0",
    '"scope":"local-development-profile-panel"',
    "http://127.0.0.1:1/settings#<redacted>",
    '"ok":true',
  ])
    expect(printed).toContain(state);
});

test("each rule on its own", () => {
  expect(redact("see https://example.test/a/b#frag?x=1 there")).toBe(
    "see https://example.test/a/b#<redacted> there",
  );
  expect(redact('{"token": "abc", "Cookie":"k=v", "name":"x"}')).toBe(
    '{"token": "<redacted>", "Cookie":"<redacted>", "name":"x"}',
  );
  expect(redact("/path?a=1&access_token=xyz&b=2")).toBe(
    "/path?a=1&access_token=<redacted>&b=2",
  );
  expect(redact("CLIENT_SECRET=hunter2 and more")).toBe(
    "CLIENT_SECRET=<redacted>",
  );
  expect(redact("header Bearer zzz.yyy")).toBe("header Bearer <redacted>");
  // Nothing secret-shaped is left alone.
  expect(redact("Restart=always RestartUSec=5s")).toBe(
    "Restart=always RestartUSec=5s",
  );
});

test("redaction happens before truncation", () => {
  const long = `${"x".repeat(290)} http://127.0.0.1:1/#${fragment}`;
  const [line] = logLines(long);
  expect(line).not.toContain(fragment.slice(0, 5));
  expect(line?.length).toBeLessThanOrEqual(300);
});
