import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { DownloadHTTPError } from "tuf-js/dist/error";
import { DistributionTransport } from "../src/distribution/transport";

test("transport policy rejects insecure, credentialed and noncanonical origins", () => {
  for (const origin of [
    "http://example.com",
    "https://example.com/",
    "https://name:secret@example.com",
    "https://example.com#fragment",
  ])
    expect(
      () =>
        new DistributionTransport([origin], 1000, new AbortController().signal),
    ).toThrow();
});

test("real transfers bound bytes, redirects and temp lifetime without exposing URLs", async () => {
  let foreignRequests = 0;
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      foreignRequests++;
      return new Response("foreign");
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/redirect":
          return Response.redirect(new URL("/ok", request.url), 302);
        case "/foreign":
          return Response.redirect(`${foreign.url}?token=fixture-secret`, 302);
        case "/loop":
          return Response.redirect(request.url, 302);
        case "/missing":
          return new Response(null, { status: 404 });
        default:
          return new Response("candidate");
      }
    },
  });
  const transport = new DistributionTransport(
    [server.url.origin],
    5000,
    new AbortController().signal,
    true,
  );
  try {
    expect(
      (await transport.downloadBytes(`${server.url}redirect`, 9)).toString(),
    ).toBe("candidate");
    let temporary = "";
    await transport.downloadFile(`${server.url}ok`, 9, async (path) => {
      temporary = path;
      expect((await readFile(path)).toString()).toBe("candidate");
    });
    await expect(access(temporary)).rejects.toThrow();
    let called = false;
    await expect(
      transport.downloadFile(`${server.url}ok`, 8, async () => {
        called = true;
      }),
    ).rejects.toThrow("body refused");
    expect(called).toBe(false);
    await expect(
      transport.downloadBytes(`${server.url}foreign`, 100),
    ).rejects.toThrow("origin refused");
    expect(foreignRequests).toBe(0);
    await expect(
      transport.downloadBytes(`${server.url}loop`, 100),
    ).rejects.toThrow("redirect refused");
    try {
      await transport.downloadBytes(
        `${server.url}missing?token=fixture-secret`,
        100,
      );
      throw new Error("Unexpected success");
    } catch (error) {
      expect(error).toBeInstanceOf(DownloadHTTPError);
      expect((error as DownloadHTTPError).statusCode).toBe(404);
      expect(String(error)).not.toContain("fixture-secret");
    }
    const permitted = new DistributionTransport(
      [server.url.origin, foreign.url.origin],
      5000,
      new AbortController().signal,
      true,
    );
    expect(
      (await permitted.downloadBytes(`${server.url}foreign`, 100)).toString(),
    ).toBe("foreign");
    expect(foreignRequests).toBe(1);
    await expect(
      transport.downloadFile(`${server.url}ok`, 9, async (path) => {
        temporary = path;
        throw new Error("handler failure");
      }),
    ).rejects.toThrow("handler failure");
    await expect(access(temporary)).rejects.toThrow();
  } finally {
    await server.stop(true);
    await foreign.stop(true);
  }
});

test("one operation deadline and explicit cancellation cover a stalled response body", async () => {
  let requested = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requested++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      );
    },
  });
  try {
    const transport = new DistributionTransport(
      [server.url.origin],
      100,
      new AbortController().signal,
      true,
    );
    await expect(
      transport.downloadBytes(server.url.href, 100),
    ).rejects.toThrow();
    const before = requested;
    await expect(transport.downloadBytes(server.url.href, 100)).rejects.toThrow(
      "cancelled",
    );
    expect(requested).toBe(before);
    const controller = new AbortController();
    const cancelled = new DistributionTransport(
      [server.url.origin],
      5000,
      controller.signal,
      true,
    );
    const transfer = cancelled.downloadBytes(server.url.href, 100);
    controller.abort();
    await expect(transfer).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});
