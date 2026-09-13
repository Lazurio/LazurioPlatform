import { expect, test } from "bun:test";
import {
  readApplicationRequest,
  requestApplication,
} from "../src/launchpad/application-client";

test("application transport refuses redirects and oversized or malformed responses", async () => {
  let mode = "redirect";
  let redirected = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/redirected") redirected++;
      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "/redirected" },
        });
      if (mode === "large") return new Response("x".repeat(65_537));
      if (mode === "invalid") return new Response("not-json");
      return Response.json({ error: "denied" }, { status: 403 });
    },
  });
  const input = {
    sessionUrl: `${server.url.href}#${"a".repeat(64)}`,
    operation: "status",
    selection: {
      company: "Example",
      module: "fixture",
      package: "app/package.json",
    },
  };
  try {
    await expect(requestApplication(input)).rejects.toThrow();
    expect(redirected).toBe(0);
    mode = "large";
    await expect(requestApplication(input)).rejects.toThrow();
    mode = "invalid";
    await expect(requestApplication(input)).rejects.toThrow();
    mode = "denied";
    expect(await requestApplication(input)).toEqual({
      httpOk: false,
      result: { error: "denied" },
    });
  } finally {
    await server.stop(true);
  }
});

test("application client rejects nonlocal or ambiguous session destinations before transport", async () => {
  const token = "a".repeat(64);
  const selection = {
    company: "Example",
    module: "fixture",
    package: "app/package.json",
  };
  for (const sessionUrl of [
    `https://127.0.0.1:1234/#${token}`,
    `http://example.invalid:1234/#${token}`,
    `http://user:password@127.0.0.1:1234/#${token}`,
    `http://127.0.0.1:1234/path#${token}`,
    `http://127.0.0.1:1234/?redirect=elsewhere#${token}`,
    "http://127.0.0.1:1234/#bad",
  ])
    await expect(
      requestApplication({ sessionUrl, operation: "start", selection }),
    ).rejects.toThrow();
  await expect(
    requestApplication({
      sessionUrl: `http://127.0.0.1:1234/#${token}`,
      operation: "constructor",
      selection,
    }),
  ).rejects.toThrow();
  await expect(
    requestApplication({
      sessionUrl: `http://127.0.0.1:1234/#${token}`,
      operation: "start",
      selection: { ...selection, executable: "/bin/sh" },
    }),
  ).rejects.toThrow();
});

test("application stdin reader bounds bytes and refuses malformed UTF-8 and JSON", async () => {
  expect(
    await readApplicationRequest(new Blob(['{"operation":"status"}']).stream()),
  ).toEqual({ operation: "status" });
  await expect(
    readApplicationRequest(new Blob(["x".repeat(16 * 1024 + 1)]).stream()),
  ).rejects.toThrow();
  await expect(
    readApplicationRequest(new Blob([new Uint8Array([0xff])]).stream()),
  ).rejects.toThrow();
  await expect(
    readApplicationRequest(new Blob(["{"]).stream()),
  ).rejects.toThrow();
});
