import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentsHost } from "../src/files/documents";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { selectRange } from "../src/launchpad/files-routes";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { organizationWithEntry } from "./fixtures/machine-bindings";
import { readZip, unzipTest } from "./fixtures/zip-reader";

// The Files routes of the Launchpad (decision F34) over real HTTP: a local
// Launchpad with its session token and a hosted one behind a fake auth
// endpoint, each serving the Documents folder of a temporary home. Nothing
// of this computer's own home is read or written.

const posix = process.platform !== "win32";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  return port;
};

async function homeOf(prefix: string) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, "home");
  await mkdir(home, { mode: 0o700 });
  return { parent, home, documents: join(home, "Documents") };
}

// A local Launchpad: its session token is the credential of /api/*.
async function local() {
  const { parent, home, documents } = await homeOf("launchpad-files-");
  const folder = join(home, "Lazurio");
  await initializeFolder(
    folder,
    presetProfile("local", executionOs(process.platform)),
  );
  const host: DocumentsHost = {
    home,
    platform: process.platform,
    folder,
  };
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    host,
  );
  cleanups.push(() => app.close());
  const url = new URL(app.url);
  const base = url.origin;
  const token = url.hash.slice(1);
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: base,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return { app, parent, home, documents, base, token, call };
}

// A hosted Launchpad behind a gateway: the session cookie is the credential,
// revalidated at the (fake) auth endpoint.
async function hosted() {
  const { parent, home, documents } = await homeOf("launchpad-files-hosted-");
  const folder = join(home, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-organization-personal";
  const machine = organizationWithEntry(freePort());
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    undefined,
    undefined,
    undefined,
    undefined,
    { home, platform: process.platform, folder },
  );
  cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${entry.listenPort}`;
  const host = "launchpad.workspace.example.lazurio.io";
  const session = { host, cookie: "__Secure-lazurio-workspace=valid" };
  const sameOrigin = {
    ...session,
    origin: entry.externalOrigin,
    "sec-fetch-site": "same-origin",
  };
  return { app, parent, home, documents, base, host, session, sameOrigin };
}

async function streamedSha256(response: Response) {
  const hash = createHash("sha256");
  let size = 0;
  if (response.body === null) throw new Error("No body");
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { digest: hash.digest("hex"), size };
}

async function fileSha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

// A tree with a Czech name, a hidden file and folder, a link that leaves the
// folder and one that stays inside.
async function populate(parent: string, documents: string) {
  await mkdir(join(documents, "Úkol", "podklady"), { recursive: true });
  await writeFile(
    join(documents, "Úkol", "Zpráva pro klienta.docx"),
    "0123456789",
  );
  await writeFile(join(documents, "Úkol", "podklady", "čísla.csv"), "1;2;3\n");
  await writeFile(join(documents, ".hidden.txt"), "hidden");
  await mkdir(join(documents, ".ssh"));
  await writeFile(join(documents, ".ssh", "id_ed25519"), "not a key");
  await writeFile(join(parent, "outside.txt"), "outside");
  await symlink(join(parent, "outside.txt"), join(documents, "escape.txt"));
  await symlink(
    join(documents, "Úkol", "Zpráva pro klienta.docx"),
    join(documents, "poslední.docx"),
  );
}

const q = (path: string) => encodeURIComponent(path);
const disposition =
  "attachment; filename=\"Zprava pro klienta.docx\"; filename*=UTF-8''Zpr%C3%A1va%20pro%20klienta.docx";

test.skipIf(!posix)(
  "local: the Files API needs the session token; the page routes need none and carry nothing of the folder",
  async () => {
    const { parent, documents, base, call } = await local();
    await mkdir(documents, { mode: 0o700 });
    await populate(parent, documents);
    const page = await (await fetch(`${base}/`)).text();
    for (const path of ["/files", "/files/%C3%9Akol", "/files/%C3%9Akol/x"]) {
      const answer = await fetch(`${base}${path}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("content-type")).toContain("text/html");
      expect(await answer.text()).toBe(page);
    }
    for (const path of [
      "/api/files/list",
      `/api/files/download?path=${q("Úkol/Zpráva pro klienta.docx")}`,
      "/api/files/zip",
    ]) {
      expect((await fetch(`${base}${path}`)).status).toBe(403);
      expect(
        (
          await fetch(`${base}${path}`, {
            headers: { Authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(403);
      expect((await call(path)).status).toBe(200);
    }
    // A write from another origin, or without the token, writes nothing.
    for (const headers of [
      { Origin: "https://evil.example" },
      { Authorization: "" },
    ]) {
      const refused = await call("/api/files/upload?name=x.txt", {
        method: "POST",
        body: "x",
        headers,
      });
      expect(refused.status).toBe(403);
    }
    expect(await readdir(documents)).not.toContain("x.txt");
  },
);

test.skipIf(!posix)(
  "local: a listing creates the Documents folder, shows folders first and never what is hidden or outside",
  async () => {
    const { parent, home, documents, call } = await local();
    const empty = await call("/api/files/list");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ path: "", entries: [] });
    expect((await stat(documents)).mode & 0o777).toBe(0o700);
    expect((await readdir(home)).sort()).toEqual(["Documents", "Lazurio"]);
    await populate(parent, documents);
    const root = (await (await call("/api/files/list")).json()) as {
      path: string;
      entries: { name: string; kind: string; size: number | null }[];
    };
    expect(root.path).toBe("");
    expect(
      root.entries.map((entry) => [entry.name, entry.kind, entry.size]),
    ).toEqual([
      ["Úkol", "directory", null],
      ["poslední.docx", "file", 10],
    ]);
    const folder = await call(`/api/files/list?path=${q("Úkol")}`);
    expect(await folder.json()).toMatchObject({
      path: "Úkol",
      entries: [
        { name: "podklady", kind: "directory", size: null },
        { name: "Zpráva pro klienta.docx", kind: "file", size: 10 },
      ],
    });
    for (const [path, status, error] of [
      [`path=${q("../outside.txt")}`, 400, "path-invalid"],
      [`path=${q("/etc")}`, 400, "path-invalid"],
      ["path=%2e%2e", 400, "path-invalid"],
      ["path=..%2F..%2Fetc", 400, "path-invalid"],
      ["path=.ssh", 404, "path-hidden"],
      ["path=escape.txt", 404, "outside-documents"],
      ["path=missing", 404, "not-found"],
      [`path=${q("poslední.docx")}`, 409, "not-directory"],
      ["path=a&path=b", 400, "query-invalid"],
      ["folder=x", 400, "query-invalid"],
    ] as const) {
      const refused = await call(`/api/files/list?${path}`);
      expect([path, refused.status, await refused.json()]).toEqual([
        path,
        status,
        { error },
      ]);
    }
    expect(
      (await call("/api/files/list", { method: "POST", body: "{}" })).status,
    ).toBe(405);
  },
);

test.skipIf(!posix)(
  "local: a download carries the exact Czech name, its type and length, and serves one byte range",
  async () => {
    const { parent, documents, call } = await local();
    await mkdir(documents, { mode: 0o700 });
    await populate(parent, documents);
    const path = `/api/files/download?path=${q("Úkol/Zpráva pro klienta.docx")}`;
    const full = await call(path);
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("0123456789");
    const headers = Object.fromEntries(full.headers);
    expect(headers).toMatchObject({
      "content-disposition": disposition,
      "content-type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-length": "10",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "accept-ranges": "bytes",
      "content-security-policy": "sandbox",
    });
    const etag = headers.etag as string;
    const lastModified = headers["last-modified"] as string;
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    const ranged = async (
      range: string,
      extra: Record<string, string> = {},
    ) => {
      const answer = await call(path, { headers: { Range: range, ...extra } });
      return {
        status: answer.status,
        range: answer.headers.get("content-range"),
        length: answer.headers.get("content-length"),
        body: await answer.text(),
      };
    };
    expect(await ranged("bytes=2-5")).toEqual({
      status: 206,
      range: "bytes 2-5/10",
      length: "4",
      body: "2345",
    });
    expect(await ranged("bytes=-3")).toEqual({
      status: 206,
      range: "bytes 7-9/10",
      length: "3",
      body: "789",
    });
    expect(await ranged("bytes=8-")).toEqual({
      status: 206,
      range: "bytes 8-9/10",
      length: "2",
      body: "89",
    });
    expect(await ranged("bytes=10-")).toEqual({
      status: 416,
      range: "bytes */10",
      length: "0",
      body: "",
    });
    // A resume of the same version gets the part; of another version the
    // whole file, never two versions spliced together.
    expect((await ranged("bytes=5-", { "If-Range": etag })).body).toBe("56789");
    expect(
      (await ranged("bytes=5-", { "If-Range": lastModified })).status,
    ).toBe(206);
    expect(await ranged("bytes=5-", { "If-Range": '"0-0"' })).toMatchObject({
      status: 200,
      range: null,
      body: "0123456789",
    });
    // Several ranges, or another unit: the whole file.
    expect(await ranged("bytes=0-1,4-5")).toMatchObject({
      status: 200,
      body: "0123456789",
    });
    expect(await ranged("items=0-1")).toMatchObject({
      status: 200,
      body: "0123456789",
    });
    const head = await call(path, { method: "HEAD" });
    expect([
      head.status,
      head.headers.get("content-length"),
      head.headers.get("content-disposition"),
      await head.text(),
    ]).toEqual([200, "10", disposition, ""]);
    // Through a link that stays inside: the target's name.
    const linked = await call(`/api/files/download?path=${q("poslední.docx")}`);
    expect(linked.headers.get("content-disposition")).toBe(disposition);
    for (const [target, status, error] of [
      ["Úkol", 409, "not-file"],
      ["", 409, "not-file"],
      [".hidden.txt", 404, "path-hidden"],
      [".ssh/id_ed25519", 404, "path-hidden"],
      ["escape.txt", 404, "outside-documents"],
      ["missing.docx", 404, "not-found"],
    ] as const) {
      const refused = await call(`/api/files/download?path=${q(target)}`);
      expect([target, refused.status, await refused.json()]).toEqual([
        target,
        status,
        { error },
      ]);
    }
  },
);

test.skipIf(!posix)(
  "local: a 200 MiB file uploads past Bun's 128 MiB default and downloads back byte for byte",
  async () => {
    const { parent, documents, call } = await local();
    await mkdir(documents, { mode: 0o700 });
    // 200 MiB of a repeated random block: any lost, doubled or shifted
    // chunk changes the digest.
    const source = join(parent, "large.bin");
    const block = randomBytes(1024 * 1024);
    const handle = await open(source, "w");
    for (let index = 0; index < 200; index++) await handle.write(block);
    await handle.close();
    const expected = await fileSha256(source);
    const uploaded = await call(`/api/files/upload?name=${q("velký.bin")}`, {
      method: "POST",
      body: Bun.file(source),
    });
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toEqual({
      name: "velký.bin",
      path: "velký.bin",
      size: 200 * 1024 * 1024,
    });
    expect(await fileSha256(join(documents, "velký.bin"))).toBe(expected);
    const download = await call(`/api/files/download?path=${q("velký.bin")}`);
    expect(download.headers.get("content-length")).toBe(
      String(200 * 1024 * 1024),
    );
    expect(await streamedSha256(download)).toEqual({
      digest: expected,
      size: 200 * 1024 * 1024,
    });
    expect(await readdir(documents)).toEqual(["velký.bin"]);
  },
  60_000,
);

test.skipIf(!posix)(
  "local: an upload never replaces a file and answers the name it was saved under",
  async () => {
    const { documents, call } = await local();
    const upload = (path: string, name: string, body: string) =>
      call(`/api/files/upload?path=${q(path)}&name=${q(name)}`, {
        method: "POST",
        body,
      });
    const first = await upload("", "Zpráva.docx", "first");
    expect([first.status, await first.json()]).toEqual([
      201,
      { name: "Zpráva.docx", path: "Zpráva.docx", size: 5 },
    ]);
    const second = await upload("", "Zpráva.docx", "second");
    expect(await second.json()).toEqual({
      name: "Zpráva (2).docx",
      path: "Zpráva (2).docx",
      size: 6,
    });
    await mkdir(join(documents, "Úkol"));
    const inside = await upload("Úkol", "a.txt", "a");
    expect(await inside.json()).toEqual({
      name: "a.txt",
      path: "Úkol/a.txt",
      size: 1,
    });
    expect(await readFile(join(documents, "Zpráva.docx"), "utf8")).toBe(
      "first",
    );
    expect(await readFile(join(documents, "Zpráva (2).docx"), "utf8")).toBe(
      "second",
    );
  },
);

test.skipIf(!posix)(
  "local: an upload is refused before a byte is written: its name, its query, its length, its folder",
  async () => {
    const { documents, call } = await local();
    await mkdir(documents, { mode: 0o700 });
    await writeFile(join(documents, "file.txt"), "x");
    for (const [query, status, error] of [
      ["name=.bashrc", 404, "path-hidden"],
      ["name=a%2Fb.txt", 400, "path-invalid"],
      ["name=..", 400, "path-invalid"],
      ["name=", 400, "path-invalid"],
      ["path=x", 400, "query-invalid"],
      ["name=a.txt&name=b.txt", 400, "query-invalid"],
      ["name=a.txt&overwrite=1", 400, "query-invalid"],
      ["path=missing&name=a.txt", 404, "not-found"],
      ["path=file.txt&name=a.txt", 409, "not-directory"],
      ["path=..&name=a.txt", 400, "path-invalid"],
    ] as const) {
      const refused = await call(`/api/files/upload?${query}`, {
        method: "POST",
        body: "data",
      });
      expect([query, refused.status, await refused.json()]).toEqual([
        query,
        status,
        { error },
      ]);
    }
    // A body without a declared length cannot prove it arrived whole.
    const chunked = await call("/api/files/upload?name=stream.bin", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      }),
    });
    expect([chunked.status, await chunked.json()]).toEqual([
      411,
      { error: "length-required" },
    ]);
    expect((await call("/api/files/upload?name=a.txt")).status).toBe(405);
    expect(await readdir(documents)).toEqual(["file.txt"]);
  },
);

// Sends the headers and part of a declared body, then lets `stop` end it:
// the client going away mid-upload.
function partialUpload(
  base: string,
  token: string,
  name: string,
): Promise<{ abort: () => void }> {
  const url = new URL(`/api/files/upload?name=${q(name)}`, base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: "POST",
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: base,
        "Content-Length": String(10 * 1024 * 1024),
      },
    });
    request.on("error", () => undefined);
    request.write(Buffer.alloc(1024 * 1024, 1), (error) => {
      if (error) reject(error);
      else resolve({ abort: () => request.destroy() });
    });
  });
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return false;
}

test.skipIf(!posix)(
  "local: an upload the client abandons, or the Launchpad's close cuts off, leaves nothing behind",
  async () => {
    const { app, documents, base, token, call } = await local();
    await mkdir(documents, { mode: 0o700 });
    const temporaries = async () =>
      (await readdir(documents)).filter((name) =>
        name.startsWith(".lazurio-upload-"),
      );
    const abandoned = await partialUpload(base, token, "abandoned.bin");
    expect(await waitFor(async () => (await temporaries()).length === 1)).toBe(
      true,
    );
    abandoned.abort();
    expect(
      await waitFor(async () => (await readdir(documents)).length === 0),
    ).toBe(true);
    // The Launchpad stops during an upload: its close waits for the cleanup.
    await partialUpload(base, token, "cut.bin");
    expect(await waitFor(async () => (await temporaries()).length === 1)).toBe(
      true,
    );
    expect((await call("/api/files/list")).status).toBe(200);
    await app.close();
    expect(await readdir(documents)).toEqual([]);
  },
);

test.skipIf(!posix)(
  "local: the folder ZIP is named after the folder and holds every visible file under it, with UTF-8 names",
  async () => {
    const { parent, documents, call } = await local();
    await mkdir(documents, { mode: 0o700 });
    await populate(parent, documents);
    const whole = await call("/api/files/zip");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("application/zip");
    expect(whole.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Documents.zip\"; filename*=UTF-8''Documents.zip",
    );
    expect(whole.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await whole.arrayBuffer());
    const archive = readZip(bytes);
    expect(
      archive.entries.map((entry) => [
        entry.name,
        new TextDecoder().decode(entry.data),
      ]),
    ).toEqual([
      ["Documents/", ""],
      ["Documents/Úkol/", ""],
      ["Documents/Úkol/podklady/", ""],
      ["Documents/Úkol/podklady/čísla.csv", "1;2;3\n"],
      ["Documents/Úkol/Zpráva pro klienta.docx", "0123456789"],
      ["Documents/poslední.docx", "0123456789"],
    ]);
    const path = join(documents, "..", "whole.zip");
    await writeFile(path, bytes);
    const tested = await unzipTest(path);
    if (tested !== null) expect(tested.code).toBe(0);
    const folder = await call(`/api/files/zip?path=${q("Úkol")}`);
    expect(folder.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Ukol.zip\"; filename*=UTF-8''%C3%9Akol.zip",
    );
    expect(
      readZip(new Uint8Array(await folder.arrayBuffer())).entries.map(
        (entry) => entry.name,
      ),
    ).toEqual([
      "Úkol/",
      "Úkol/podklady/",
      "Úkol/podklady/čísla.csv",
      "Úkol/Zpráva pro klienta.docx",
    ]);
    for (const [path, status, error] of [
      [`path=${q("poslední.docx")}`, 409, "not-directory"],
      ["path=.ssh", 404, "path-hidden"],
      ["path=missing", 404, "not-found"],
    ] as const) {
      const refused = await call(`/api/files/zip?${path}`);
      expect([path, refused.status, await refused.json()]).toEqual([
        path,
        status,
        { error },
      ]);
    }
  },
);

test.skipIf(!posix)(
  "local: every JSON route reads at most 16 KiB of its body, declared or streamed",
  async () => {
    const { call } = await local();
    const post = (body: BodyInit, headers: Record<string, string> = {}) =>
      call("/api/catalog", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json", ...headers },
      });
    expect((await post("{}")).status).toBe(200);
    const large = JSON.stringify({ pad: "x".repeat(17 * 1024) });
    const declared = await post(large);
    expect([declared.status, await declared.json()]).toEqual([
      413,
      { error: "body-too-large" },
    ]);
    const streamed = await post(
      new ReadableStream({
        start(controller) {
          for (let index = 0; index < 20; index++)
            controller.enqueue(new Uint8Array(1024).fill(32));
          controller.close();
        },
      }),
    );
    expect([streamed.status, await streamed.json()]).toEqual([
      413,
      { error: "body-too-large" },
    ]);
    // The module routes read through the same bound.
    const module = await call("/api/modules/alpha/web/start", {
      method: "POST",
      body: large,
      headers: { "Content-Type": "application/json" },
    });
    expect([module.status, await module.json()]).toEqual([
      413,
      { error: "body-too-large" },
    ]);
  },
);

test.skipIf(!posix)(
  "hosted: a Files link downloads behind the gateway session; without the session nothing is served",
  async () => {
    const { parent, documents, base, host, session } = await hosted();
    await mkdir(documents, { mode: 0o700 });
    await populate(parent, documents);
    const link = `${base}/files/%C3%9Akol/Zpr%C3%A1va%20pro%20klienta.docx`;
    const admitted = await fetch(link, { headers: session });
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("content-disposition")).toBe(disposition);
    expect(admitted.headers.get("content-length")).toBe("10");
    expect(await admitted.text()).toBe("0123456789");
    const partial = await fetch(link, {
      headers: { ...session, range: "bytes=0-1" },
    });
    expect([partial.status, await partial.text()]).toEqual([206, "01"]);
    for (const headers of [
      { host },
      { host, cookie: "__Secure-lazurio-workspace=forged" },
      { host, "x-forwarded-user": "admin", "x-auth-request-email": "a@b" },
      { ...session, host: "other.example" },
    ]) {
      const refused = await fetch(link, { headers });
      expect(refused.status).toBe(401);
      expect(await refused.text()).not.toContain("0123456789");
    }
    const head = await fetch(link, { method: "HEAD", headers: session });
    expect([head.status, head.headers.get("content-length")]).toEqual([
      200,
      "10",
    ]);
  },
);

test.skipIf(!posix)(
  "hosted: a folder link is the page; a missing, hidden or escaping path is the page with 404",
  async () => {
    const { parent, documents, base, host, session } = await hosted();
    await mkdir(documents, { mode: 0o700 });
    await populate(parent, documents);
    const page = await (await fetch(`${base}/`, { headers: session })).text();
    expect(page).toContain("<html");
    for (const [path, status] of [
      ["/files", 200],
      ["/files/", 200],
      ["/files/%C3%9Akol", 200],
      ["/files/%C3%9Akol/", 200],
      ["/files/missing.docx", 404],
      ["/files/.ssh/id_ed25519", 404],
      ["/files/%2Essh/id_ed25519", 404],
      ["/files/escape.txt", 404],
      ["/files/a%2F..%2F..%2Fouside.txt", 404],
    ] as const) {
      const answer = await fetch(`${base}${path}`, { headers: session });
      expect([path, answer.status]).toEqual([path, status]);
      expect(answer.headers.get("content-type")).toContain("text/html");
      expect(await answer.text()).toBe(page);
    }
    expect((await fetch(`${base}/files`, { headers: { host } })).status).toBe(
      401,
    );
  },
);

test.skipIf(!posix)(
  "hosted: the Files API rides the same admission, and an upload must come from the Launchpad's own origin",
  async () => {
    const { documents, base, host, session, sameOrigin } = await hosted();
    expect(
      (await fetch(`${base}/api/files/list`, { headers: { host } })).status,
    ).toBe(401);
    const listed = await fetch(`${base}/api/files/list`, { headers: session });
    expect([listed.status, await listed.json()]).toEqual([
      200,
      { path: "", entries: [] },
    ]);
    const upload = (headers: Record<string, string>) =>
      fetch(`${base}/api/files/upload?name=${q("Zpráva.docx")}`, {
        method: "POST",
        body: "report",
        headers,
      });
    for (const headers of [
      session,
      { ...sameOrigin, origin: "https://evil.example" },
      { ...sameOrigin, "sec-fetch-site": "cross-site" },
      { ...sameOrigin, cookie: "__Secure-lazurio-workspace=forged" },
    ]) {
      const refused = await upload(headers);
      expect(refused.status).toBe(401);
    }
    expect(await readdir(documents)).toEqual([]);
    const accepted = await upload(sameOrigin);
    expect([accepted.status, await accepted.json()]).toEqual([
      201,
      { name: "Zpráva.docx", path: "Zpráva.docx", size: 6 },
    ]);
    const zip = await fetch(`${base}/api/files/zip`, { headers: session });
    expect(zip.status).toBe(200);
    expect(
      readZip(new Uint8Array(await zip.arrayBuffer())).entries.map(
        (entry) => entry.name,
      ),
    ).toEqual(["Documents/", "Documents/Zpráva.docx"]);
  },
);

test("one byte range or the whole file: malformed, multiple and other-version ranges are the whole file", () => {
  const validators = {
    etag: '"a-1"',
    lastModified: "Fri, 02 Oct 2026 10:00:00 GMT",
  };
  const pick = (
    range: string | null,
    ifRange: string | null = null,
    size = 100,
  ) => selectRange(range, ifRange, size, validators);
  expect(pick(null)).toEqual({ kind: "full" });
  expect(pick("bytes=0-0")).toEqual({ kind: "range", start: 0, end: 0 });
  expect(pick("bytes=10-200")).toEqual({ kind: "range", start: 10, end: 99 });
  expect(pick("bytes=-200")).toEqual({ kind: "range", start: 0, end: 99 });
  expect(pick("bytes=-0")).toEqual({ kind: "unsatisfiable" });
  expect(pick("bytes=100-")).toEqual({ kind: "unsatisfiable" });
  expect(pick("bytes=0-", null, 0)).toEqual({ kind: "unsatisfiable" });
  expect(pick("bytes=99999999999999999999-")).toEqual({
    kind: "unsatisfiable",
  });
  for (const range of [
    "bytes=5-1",
    "bytes=-",
    "bytes=a-b",
    "bytes=0-1,2-3",
    "lines=1-2",
  ])
    expect([range, pick(range)]).toEqual([range, { kind: "full" }]);
  expect(pick("bytes=1-2", '"a-1"')).toEqual({
    kind: "range",
    start: 1,
    end: 2,
  });
  expect(pick("bytes=1-2", validators.lastModified)).toEqual({
    kind: "range",
    start: 1,
    end: 2,
  });
  expect(pick("bytes=1-2", 'W/"a-1"')).toEqual({ kind: "full" });
  expect(pick("bytes=1-2", '"b-2"')).toEqual({ kind: "full" });
});
