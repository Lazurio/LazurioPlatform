import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  guideVideoFile,
  guideVideoLocales,
  guideVideoNames,
  guideVideoPath,
  guideVideoPlayer,
} from "../src/launchpad/guide-video";
import {
  guideVideoFilePaths,
  guideVideoRoutes,
} from "../src/launchpad/guide-video-files";
import { messages } from "../src/launchpad/messages";
import { startLaunchpad } from "../src/launchpad/server";
import { folderFixture } from "./fixtures/catalog-folder";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// Guide videos (docs/launchpad-development.md "Guide videos"; F53's addendum
// of 2026-10-16 on the guide video): the player the page draws, the files
// the Launchpad carries, and their answers by byte range, which Safari and
// iOS need to play a video at all. How the player looks and plays is checked
// in a browser (root decision 0178).

const cs = messages("cs");
const en = messages("en");
const posixTest = test.skipIf(process.platform === "win32");
const videos = join(import.meta.dir, "..", "src", "launchpad", "videos");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("the player: one button named for its video, opening the browser's own player in the page's language, nothing loaded or played before the person asks", () => {
  for (const [locale, copy, play, name] of [
    ["cs", cs, "Přehrát video", "Přehrát video: Trezor v Bitwardenu"],
    ["en", en, "Play video", "Play video: Vault in Bitwarden"],
  ] as const) {
    const player = guideVideoPlayer(
      {
        name: "vault-bitwarden",
        locale,
        title: copy.startBitwardenTitle,
        describedBy: "vault-bitwarden-steps",
      },
      copy,
    );
    expect(player).toEqual({
      play: { label: play, name },
      video: {
        src: `/videos/vault-bitwarden-${locale}.mp4`,
        type: "video/mp4",
        poster: `/videos/vault-bitwarden-${locale}.webp`,
        name: copy.startBitwardenTitle,
        describedBy: "vault-bitwarden-steps",
        attributes: { controls: "", playsinline: "", preload: "none" },
      },
    });
    // The accessible name begins with the words the button shows (WCAG
    // 2.5.3), so a voice command by them reaches it.
    expect(player.play.name.startsWith(player.play.label)).toBe(true);
  }
  // Without a text it describes, none.
  expect(
    guideVideoPlayer({ name: "vault-bitwarden", locale: "cs", title: "x" }, cs)
      .video.describedBy,
  ).toBeNull();
});

test("the Trezor page holds the player's slot at the top of its Bitwarden section, above the steps, and the play icon", async () => {
  const html = await readFile(
    join(import.meta.dir, "..", "src", "launchpad", "index.html"),
    "utf8",
  );
  const section = html.slice(
    html.indexOf('<section class="group" id="vault-bitwarden"'),
    html.indexOf("</section>", html.indexOf('id="vault-bitwarden"')),
  );
  const order = [
    'id="vault-bitwarden-heading"',
    'id="vault-bitwarden-video"',
    'id="vault-bitwarden-first"',
    'id="vault-bitwarden-steps"',
  ].map((id) => section.indexOf(id));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(html).toContain('<symbol id="i-play"');
  // The player is the page's only video, and nothing in it plays by itself.
  expect(html).not.toMatch(/\bautoplay\b/);
});

/** The boxes of an MP4 (ISO BMFF) at one level: type, start and size. */
function boxes(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): { type: string; start: number; size: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: { type: string; start: number; size: number }[] = [];
  for (let at = start; at + 8 <= end; ) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    }
    if (size < header || at + size > end) break;
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    found.push({ type, start: at + header, size: size - header });
    at += size;
  }
  return found;
}
const child = (
  bytes: Uint8Array,
  parent: { start: number; size: number },
  type: string,
) =>
  boxes(bytes, parent.start, parent.start + parent.size).filter(
    (box) => box.type === type,
  );

test("every guide video is in both languages: H.264 in MP4, its index first, no audio track, a WebP poster, small", async () => {
  const expected = guideVideoNames.flatMap((name) =>
    guideVideoLocales.flatMap((locale) => [
      guideVideoFile(name, locale, "video"),
      guideVideoFile(name, locale, "poster"),
    ]),
  );
  // Exactly these files, here and served.
  expect((await readdir(videos)).sort()).toEqual([...expected].sort());
  expect(Object.keys(guideVideoFilePaths).sort()).toEqual([...expected].sort());
  for (const file of expected) {
    const bytes = new Uint8Array(await readFile(join(videos, file)));
    if (file.endsWith(".webp")) {
      expect([file, new TextDecoder().decode(bytes.subarray(0, 4))]).toEqual([
        file,
        "RIFF",
      ]);
      expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");
      expect([file, bytes.length < 100 * 1024]).toEqual([file, true]);
      continue;
    }
    expect([file, bytes.length < 4 * 1024 * 1024]).toEqual([file, true]);
    const top = boxes(bytes);
    // `moov` before `mdat`: a browser starts playing before the whole file
    // came.
    const order = top.map((box) => box.type);
    expect([file, order[0]]).toEqual([file, "ftyp"]);
    expect([file, order.indexOf("moov") < order.indexOf("mdat")]).toEqual([
      file,
      true,
    ]);
    const [moov] = top.filter((box) => box.type === "moov");
    const handlers: string[] = [];
    const samples: string[] = [];
    for (const trak of child(
      bytes,
      moov as { start: number; size: number },
      "trak",
    ))
      for (const mdia of child(bytes, trak, "mdia")) {
        for (const hdlr of child(bytes, mdia, "hdlr"))
          handlers.push(
            new TextDecoder().decode(
              bytes.subarray(hdlr.start + 8, hdlr.start + 12),
            ),
          );
        for (const minf of child(bytes, mdia, "minf"))
          for (const stbl of child(bytes, minf, "stbl"))
            for (const stsd of child(bytes, stbl, "stsd"))
              samples.push(
                new TextDecoder().decode(
                  bytes.subarray(stsd.start + 12, stsd.start + 16),
                ),
              );
      }
    // One video track and nothing else: no sound.
    expect([file, handlers]).toEqual([file, ["vide"]]);
    expect([file, samples]).toEqual([file, ["avc1"]]);
  }
});

/** The Range answers of one file, from `get`. */
async function rangeAnswers(
  get: (path: string, headers?: Record<string, string>) => Promise<Response>,
) {
  const file = "vault-bitwarden-cs.mp4";
  const bytes = new Uint8Array(await readFile(join(videos, file)));
  const size = bytes.length;
  const path = `${guideVideoPath}${file}`;
  // The whole file: its type, its length, and that it takes ranges.
  const full = await get(path);
  expect(full.status).toBe(200);
  expect(full.headers.get("content-type")).toBe("video/mp4");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(full.headers.get("content-length")).toBe(String(size));
  expect(full.headers.get("cache-control")).toBe("no-cache");
  expect(full.headers.get("x-content-type-options")).toBe("nosniff");
  const etag = full.headers.get("etag") ?? "";
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  expect(sha256(new Uint8Array(await full.arrayBuffer()))).toBe(sha256(bytes));
  // One range: 206 with exactly its bytes.
  for (const [range, start, end] of [
    ["bytes=0-99", 0, 99],
    ["bytes=100-", 100, size - 1],
    ["bytes=-100", size - 100, size - 1],
    [`bytes=${size - 10}-${size + 50}`, size - 10, size - 1],
  ] as const) {
    const part = await get(path, { range });
    expect([range, part.status]).toEqual([range, 206]);
    expect(part.headers.get("content-range")).toBe(
      `bytes ${start}-${end}/${size}`,
    );
    expect(part.headers.get("content-length")).toBe(String(end - start + 1));
    expect(part.headers.get("content-type")).toBe("video/mp4");
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(sha256(new Uint8Array(await part.arrayBuffer()))).toBe(
      sha256(bytes.subarray(start, end + 1)),
    );
  }
  // Past the end: 416, with the file's length.
  const past = await get(path, { range: `bytes=${size}-` });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${size}`);
  await past.arrayBuffer();
  // The range of another version (If-Range), or several ranges: the whole
  // file, 200.
  for (const headers of [
    { range: "bytes=0-99", "if-range": '"0123456789abcdef0123456789abcdef"' },
    { range: "bytes=0-9,20-29" },
  ]) {
    const whole = await get(path, headers);
    expect(whole.status).toBe(200);
    expect(sha256(new Uint8Array(await whole.arrayBuffer()))).toBe(
      sha256(bytes),
    );
  }
  // Its own version's range: 206.
  const same = await get(path, { range: "bytes=0-9", "if-range": etag });
  expect(same.status).toBe(206);
  await same.arrayBuffer();
  // The browser's copy is current: 304, no body.
  const kept = await get(path, { "if-none-match": etag });
  expect(kept.status).toBe(304);
  expect(await kept.text()).toBe("");
  // The poster.
  const poster = await get(`${guideVideoPath}vault-bitwarden-en.webp`);
  expect(poster.status).toBe(200);
  expect(poster.headers.get("content-type")).toBe("image/webp");
  expect(sha256(new Uint8Array(await poster.arrayBuffer()))).toBe(
    sha256(
      new Uint8Array(await readFile(join(videos, "vault-bitwarden-en.webp"))),
    ),
  );
  // Nothing else.
  for (const other of [
    `${guideVideoPath}vault-bitwarden-de.mp4`,
    `${guideVideoPath}vault-bitwarden-cs.webm`,
    `${guideVideoPath}..%2Fshell.json`,
  ]) {
    const answer = await get(other);
    expect([other, answer.status]).toEqual([other, 404]);
    await answer.arrayBuffer();
  }
}

posixTest(
  "the route answers byte ranges: 206 with the bytes asked, 416 past the end, 200 for the whole file or another version, 304 for a current copy",
  async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: guideVideoRoutes,
      fetch: () => new Response("not-found", { status: 404 }),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      await rangeAnswers((path, headers = {}) =>
        fetch(`${base}${path}`, { headers }),
      );
      // HEAD: the same headers, no body; another method: 405.
      const head = await fetch(`${base}/videos/vault-bitwarden-cs.mp4`, {
        method: "HEAD",
        headers: { range: "bytes=0-99" },
      });
      expect(head.status).toBe(206);
      expect(head.headers.get("content-length")).toBe("100");
      const post = await fetch(`${base}/videos/vault-bitwarden-cs.mp4`, {
        method: "POST",
      });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    } finally {
      server.stop(true);
    }
  },
  30_000,
);

posixTest(
  "locally the Launchpad serves the videos without the token, as the page",
  async () => {
    await folderFixture(async (folder) => {
      const app = await startLaunchpad(folder);
      const session = new URL(app.url);
      try {
        await rangeAnswers((path, headers = {}) =>
          fetch(new URL(path, session), { headers }),
        );
      } finally {
        await app.close();
      }
    });
  },
  30_000,
);

posixTest(
  "hosted, only after the gateway's admission, with the byte range intact",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-video-")),
    );
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port ?? 0;
    probe.stop(true);
    const preset = "hosted-organization-personal";
    await initializeHandoverFolder(folder, {
      preset,
      machine: organizationWithEntry(port),
      profile: presetProfile(preset, executionOs(process.platform), {
        locale: "cs",
      }),
    });
    const app = await startLaunchpad(folder, undefined, undefined, undefined, {
      fetcher: async (_url, init) =>
        new Headers(init.headers).get("cookie") ===
        "__Secure-lazurio-workspace=valid"
          ? new Response("ok")
          : new Response("no", { status: 401 }),
    });
    const base = `http://127.0.0.1:${port}`;
    const host = "launchpad.workspace.example.lazurio.io";
    const valid = { host, cookie: "__Secure-lazurio-workspace=valid" };
    try {
      const path = `${base}/videos/vault-bitwarden-cs.mp4`;
      expect((await fetch(path, { headers: { host } })).status).toBe(401);
      expect(
        (
          await fetch(path, {
            headers: { host, cookie: "__Secure-lazurio-workspace=forged" },
          })
        ).status,
      ).toBe(401);
      await rangeAnswers((asked, headers = {}) =>
        fetch(`${base}${asked}`, { headers: { ...valid, ...headers } }),
      );
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);
