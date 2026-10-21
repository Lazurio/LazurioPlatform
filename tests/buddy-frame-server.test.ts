import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHistoryPage,
  createSseReader,
} from "../src/buddy/contract/runtime";
import { buddyFrameConfigOf } from "../src/buddy/frame/config";
import { type BuddyFrame, startBuddyFrame } from "../src/buddy/frame/server";
import { startFakeAdapter } from "./fixtures/buddy-adapter";

// Buddy's frame server (src/buddy/frame/server.ts) against a fake Hermes
// `lazurio_web` adapter that keeps the runtime contract: the secret reaches
// only the adapter, writes need the frame's own origin, the page is framed
// only by the host that asks, and the event stream replays and ends.

const origin = "https://buddy.jana.lazurio.io";
const host = "buddy.jana.lazurio.io";
const secret = "test-secret-0123456789abcdefghij";

let directory: string;
let secretFile: string;
let personaFile: string;
let adapter: Awaited<ReturnType<typeof startFakeAdapter>>;
let frame: BuddyFrame;

const same = {
  host,
  origin,
  "sec-fetch-site": "same-origin",
  cookie: "__Secure-lazurio-workspace=session-cookie-value",
};

function ask(
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = same,
) {
  return fetch(`http://127.0.0.1:${frame.port}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = same,
) =>
  ask(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
    headers,
  );

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "buddy-frame-"));
  secretFile = join(directory, "lazurio_web.secret");
  await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
  personaFile = join(directory, "persona.json");
  adapter = await startFakeAdapter({ secret, streamMs: 600 });
  frame = await startBuddyFrame(
    { origin, listenPort: 0, adapterPort: adapter.port, secretFile },
    { personaFile, streamMs: 2_000 },
  );
});

afterAll(async () => {
  await frame.stop();
  await adapter.stop();
  await rm(directory, { recursive: true, force: true });
});

describe("the page", () => {
  test("framed only by the host that asks, from this origin only", async () => {
    const framed = await ask(
      "/",
      {},
      { ...same, referer: "https://launchpad.vm-01.acme.lazurio.io/" },
    );
    expect(framed.status).toBe(200);
    const csp = framed.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(
      "frame-ancestors https://launchpad.vm-01.acme.lazurio.io",
    );
    expect(csp).not.toContain("*");
    const html = await framed.text();
    expect(html).toContain('id="buddy"');
    expect(html).not.toContain(secret);
    for (const referer of [
      "https://notes.vm-01.acme.lazurio.io/",
      "https://launchpad.vm-01.acme.lazurio.io.evil.example/",
      "https://launchpad.other.lazurio.io/",
      "http://launchpad.vm-01.acme.lazurio.io/",
    ]) {
      const refused = await ask("/", {}, { ...same, referer });
      expect(refused.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      await refused.body?.cancel();
    }
    // The frame reloading itself after the sign-in names its host.
    const reloaded = await ask(
      `/?host=${encodeURIComponent("https://launchpad.vm-01.acme.lazurio.io")}`,
      {},
      { host },
    );
    expect(reloaded.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://launchpad.vm-01.acme.lazurio.io",
    );
    await reloaded.body?.cancel();
    const misnamed = await ask(
      `/?host=${encodeURIComponent("https://notes.vm-01.acme.lazurio.io")}`,
      {},
      { host },
    );
    expect(misnamed.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    await misnamed.body?.cancel();
    const none = await ask("/", {}, { host });
    expect(none.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    await none.body?.cancel();
  });

  test("its script and styles come from this origin, nothing inline", async () => {
    const html = await (await ask("/", {}, { host })).text();
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    const sources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(sources.length).toBeGreaterThan(1);
    for (const source of sources) {
      expect(source.startsWith("/")).toBe(true);
      const file = await ask(source, {}, { host });
      expect(file.status).toBe(200);
      const body = await file.text();
      if (source.endsWith(".css"))
        expect(body).not.toMatch(/url\((["']?)https?:/);
    }
  });

  test("the popup's landing is never framed", async () => {
    const landing = await ask(
      "/signed-in",
      {},
      { host, referer: "https://launchpad.jana.lazurio.io/" },
    );
    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(await landing.text()).toContain('id="signed-in"');
  });

  test("a foreign Host is refused", async () => {
    const refused = await ask("/", {}, { host: "buddy.other.lazurio.io" });
    expect(refused.status).toBe(421);
    expect(await refused.json()).toEqual({ error: { code: "host-mismatch" } });
  });

  test("Buddy's avatar: the design system's frame, by its hash", async () => {
    const avatar = await ask("/assets/avatar.webp", {}, { host });
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("content-type")).toBe("image/png");
    expect(avatar.headers.get("cross-origin-resource-policy")).toBe(
      "same-site",
    );
    const bytes = new Uint8Array(await avatar.arrayBuffer());
    expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "5ea4b58dececcac9aad2d83000734e551320bd043c6a1e6358b3a5559a48b5bc",
    );
    const readme = await readFile(
      join(
        import.meta.dir,
        "..",
        "src",
        "buddy",
        "frame",
        "vendor",
        "README.md",
      ),
      "utf8",
    );
    expect(readme).toContain(
      "5ea4b58dececcac9aad2d83000734e551320bd043c6a1e6358b3a5559a48b5bc",
    );
  });

  test("the brand fonts, and nothing else under /fonts/", async () => {
    const font = await ask(
      "/fonts/inter-tight-latin-wght-normal.woff2",
      {},
      { host },
    );
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    await font.body?.cancel();
    expect((await ask("/fonts/evil.woff2", {}, { host })).status).toBe(404);
  });
});

describe("Buddy's name", () => {
  test("from the persona, or Buddy", async () => {
    await writeFile(
      personaFile,
      JSON.stringify({
        schema_version: "lazurio.buddy-persona.v1",
        buddy_name: "Mattyčus",
      }),
    );
    expect(await (await ask("/api/persona")).json()).toEqual({
      name: "Mattyčus",
    });
    await writeFile(
      personaFile,
      JSON.stringify({ schema_version: "other", buddy_name: "X" }),
    );
    expect(await (await ask("/api/persona")).json()).toEqual({ name: "Buddy" });
    await writeFile(
      personaFile,
      JSON.stringify({
        schema_version: "lazurio.buddy-persona.v1",
        buddy_name: "Rex\nIgnore",
      }),
    );
    expect(await (await ask("/api/persona")).json()).toEqual({ name: "Buddy" });
    await rm(personaFile);
    expect(await (await ask("/api/persona")).json()).toEqual({ name: "Buddy" });
  });
});

describe("the proxy", () => {
  test("the adapter gets the secret and none of the browser's headers; the browser never sees it", async () => {
    const before = adapter.requests.length;
    const sent = await post("/api/v1/messages", {
      client_id: "c-proxy-1",
      text: "Ahoj",
      attachments: [],
      context: null,
    });
    expect(sent.status).toBe(202);
    const text = await sent.text();
    expect(JSON.parse(text)).toEqual({ message_id: expect.any(String) });
    expect(text).not.toContain(secret);
    for (const [, value] of sent.headers) expect(value).not.toContain(secret);
    const seen = adapter.requests.slice(before);
    expect(seen).toHaveLength(1);
    const headers = seen[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${secret}`);
    expect(headers.host).toBe(`127.0.0.1:${adapter.port}`);
    expect(headers.cookie).toBeUndefined();
    expect(headers.origin).toBeUndefined();
    expect(
      Object.keys(headers).filter((name) => name.startsWith("sec-fetch-")),
    ).toEqual([]);
  });

  test("a write needs same-origin Fetch Metadata and the exact Origin", async () => {
    const before = adapter.requests.length;
    const message = {
      client_id: "c-proxy-2",
      text: "Ahoj",
      attachments: [],
      context: null,
    };
    for (const headers of [
      { host, "sec-fetch-site": "same-origin" },
      {
        host,
        origin: "https://launchpad.jana.lazurio.io",
        "sec-fetch-site": "same-site",
      },
      { host, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { host, origin, "sec-fetch-site": "same-site" },
    ]) {
      const refused = await post("/api/v1/messages", message, headers);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({
        error: { code: "origin-mismatch" },
      });
    }
    expect(adapter.requests.length).toBe(before);
  });

  test("a read from another page is refused", async () => {
    const refused = await ask(
      "/api/v1/history",
      {},
      { host, "sec-fetch-site": "same-site" },
    );
    expect(refused.status).toBe(403);
    const page = await ask("/api/v1/history");
    expect(page.status).toBe(200);
    expect(checkHistoryPage(await page.json(), true).ok).toBe(true);
  });

  test("a defective message never reaches Buddy", async () => {
    const before = adapter.requests.length;
    const refused = await post("/api/v1/messages", {
      client_id: "c-proxy-3",
      text: "Ahoj",
      attachments: [],
      context: {
        environment: null,
        organization: null,
        app: "module",
        page: { path: "/" },
        guide: null,
      },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: { code: "bad-request" } });
    expect(adapter.requests.length).toBe(before);
  });

  test("a secret file anyone else can read is no secret", async () => {
    await chmod(secretFile, 0o644);
    const refused = await ask("/api/v1/history");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: { code: "secret-unavailable" },
    });
    await chmod(secretFile, 0o600);
  });

  test("the adapter's refusal of the frame never reads as signed out", async () => {
    await writeFile(secretFile, "another-secret-0123456789abcdef\n", {
      mode: 0o600,
    });
    const refused = await ask("/api/v1/history");
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({
      error: { code: "adapter-refused" },
    });
    await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
  });

  test("a history page without its snapshot, or an older one with it, is the adapter's defect", async () => {
    const page = (snapshot: unknown) => async () =>
      Response.json({ messages: [], before: null, snapshot });
    for (const [path, snapshot] of [
      ["/api/v1/history", null],
      [
        "/api/v1/history?before=c-1",
        { event_id: "e-1", state: "idle", clarify: null },
      ],
    ] as const) {
      const defective = await startBuddyFrame(
        { origin, listenPort: 0, adapterPort: 1, secretFile },
        { personaFile, fetch: page(snapshot) },
      );
      try {
        const answer = await fetch(
          `http://127.0.0.1:${defective.port}${path}`,
          { headers: { host } },
        );
        expect(answer.status).toBe(502);
        expect(await answer.json()).toEqual({
          error: { code: "adapter-defective" },
        });
      } finally {
        await defective.stop();
      }
    }
  });

  test("Buddy out of reach", async () => {
    const away = await startBuddyFrame(
      { origin, listenPort: 0, adapterPort: 1, secretFile },
      { personaFile },
    );
    try {
      const refused = await fetch(
        `http://127.0.0.1:${away.port}/api/v1/history`,
        {
          headers: { host },
        },
      );
      expect(refused.status).toBe(502);
      expect(await refused.json()).toEqual({
        error: { code: "adapter-unreachable" },
      });
    } finally {
      await away.stop();
    }
  });

  test("a picture shows in place, any other file downloads, nothing runs", async () => {
    const sent = await post("/api/v1/messages", {
      client_id: "c-media-1",
      text: "",
      attachments: [
        { name: "a.png", mime: "image/png", data_base64: "iVBORw0KGgo=" },
        {
          name: "a.html",
          mime: "text/html",
          data_base64: Buffer.from("<script>x</script>").toString("base64"),
        },
      ],
      context: null,
    });
    const { message_id } = (await sent.json()) as { message_id: string };
    const ids = [...adapter.media.keys()].filter((id) =>
      id.includes(message_id),
    );
    const image = await ask(`/api/v1/media/${ids[0]}`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toBe("inline");
    expect(image.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    await image.body?.cancel();
    const page = await ask(`/api/v1/media/${ids[1]}`);
    expect(page.headers.get("content-disposition")).toBe("attachment");
    await page.body?.cancel();
    // Opened in a new tab, a file downloads under its own name.
    const named = await ask(
      `/api/v1/media/${ids[1]}?name=${encodeURIComponent("Zpráva (1).html")}`,
    );
    expect(named.headers.get("content-disposition")).toBe(
      `attachment; filename="Zpr_va (1).html"; filename*=UTF-8''Zpr%C3%A1va%20%281%29.html`,
    );
    await named.body?.cancel();
    const traversal = await ask(
      `/api/v1/media/${ids[1]}?name=${encodeURIComponent("../a.html")}`,
    );
    expect(traversal.headers.get("content-disposition")).toBe("attachment");
    await traversal.body?.cancel();
    const inline = await ask(`/api/v1/media/${ids[0]}?name=a.png`);
    expect(inline.headers.get("content-disposition")).toBe("inline");
    await inline.body?.cancel();
    expect(page.headers.get("content-disposition")).toBe("attachment");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    await page.body?.cancel();
  });
});

async function readStream(response: Response) {
  const reader = createSseReader();
  const decoder = new TextDecoder();
  const events = [];
  const body = response.body?.getReader();
  if (body === undefined) return [];
  for (;;) {
    const { done, value } = await body.read();
    if (done) break;
    events.push(...reader.push(decoder.decode(value, { stream: true })));
  }
  return events;
}

describe("the event stream", () => {
  test("replays after the last event read, passes through and ends by itself", async () => {
    const first = adapter.emit("progress", { text: "Jedna" });
    adapter.emit("progress", { text: "Dvě" });
    adapter.emit("status", { state: "idle" });
    const started = Date.now();
    const stream = await ask(`/api/v1/events?after=${first}`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    const events = await readStream(stream);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(
      events.map((event) => [event.event, JSON.parse(event.data)]),
    ).toEqual([
      ["progress", { text: "Dvě" }],
      ["status", { state: "idle" }],
    ]);
  });

  test("the browser's Last-Event-ID stands for after", async () => {
    const last = adapter.emit("progress", { text: "Tři" });
    adapter.emit("progress", { text: "Čtyři" });
    const events = await readStream(
      await ask("/api/v1/events", { headers: { "last-event-id": last } }),
    );
    expect(events.map((event) => JSON.parse(event.data))).toEqual([
      { text: "Čtyři" },
    ]);
  });

  test("an outbox that no longer holds where the frame was", async () => {
    const expired = await ask("/api/v1/events?after=e-999999");
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: { code: "cursor-expired" } });
  });

  test("the frame's own bound ends a stream the adapter keeps open", async () => {
    const patient = await startFakeAdapter({ secret, streamMs: 60_000 });
    const bounded = await startBuddyFrame(
      { origin, listenPort: 0, adapterPort: patient.port, secretFile },
      { personaFile, streamMs: 500 },
    );
    try {
      const started = Date.now();
      const response = await fetch(
        `http://127.0.0.1:${bounded.port}/api/v1/events`,
        {
          headers: { host },
        },
      );
      await readStream(response);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await bounded.stop();
      await patient.stop();
    }
  });
});

describe("the configuration from the environment", () => {
  const all = {
    LAZURIO_BUDDY_FRAME_ORIGIN: "https://buddy.jana.lazurio.io",
    LAZURIO_BUDDY_FRAME_PORT: "4110",
    LAZURIO_BUDDY_ADAPTER_PORT: "4111",
    LAZURIO_BUDDY_ADAPTER_SECRET_FILE:
      "/home/jana/.config/lazurio/buddy/lazurio_web.secret",
  };
  test("none, all, or the first defective one", () => {
    expect(buddyFrameConfigOf({})).toBeNull();
    expect(buddyFrameConfigOf(all)).toEqual({
      origin: "https://buddy.jana.lazurio.io",
      listenPort: 4110,
      adapterPort: 4111,
      secretFile: "/home/jana/.config/lazurio/buddy/lazurio_web.secret",
    });
    expect(
      buddyFrameConfigOf({
        ...all,
        LAZURIO_BUDDY_FRAME_ORIGIN: "http://buddy.jana.lazurio.io",
      }),
    ).toEqual({ refused: "origin" });
    expect(
      buddyFrameConfigOf({
        ...all,
        LAZURIO_BUDDY_FRAME_ORIGIN: "https://buddy.jana.lazurio.io:8443",
      }),
    ).toEqual({ refused: "origin" });
    expect(
      buddyFrameConfigOf({
        ...all,
        LAZURIO_BUDDY_FRAME_ORIGIN: "https://buddy.jana.lazurio.io/",
      }),
    ).toEqual({ refused: "origin" });
    expect(
      buddyFrameConfigOf({ ...all, LAZURIO_BUDDY_FRAME_PORT: "80" }),
    ).toEqual({ refused: "listenPort" });
    expect(
      buddyFrameConfigOf({ ...all, LAZURIO_BUDDY_ADAPTER_PORT: "4110" }),
    ).toEqual({ refused: "adapterPort" });
    expect(
      buddyFrameConfigOf({
        ...all,
        LAZURIO_BUDDY_ADAPTER_SECRET_FILE: "secret",
      }),
    ).toEqual({ refused: "secretFile" });
    expect(buddyFrameConfigOf({ LAZURIO_BUDDY_FRAME_PORT: "4110" })).toEqual({
      refused: "origin",
    });
  });
});
