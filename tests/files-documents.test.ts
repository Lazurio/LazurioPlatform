import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountHome,
  type DocumentEntry,
  type Documents,
  type DocumentsHost,
  documentTree,
  isRefused,
  listDocuments,
  openDocuments,
  readDocument,
  resolveDocument,
  uploadDocument,
} from "../src/files/documents";

// The Documents adapter (decision F34) against a temporary home: what it
// resolves, lists, archives and writes, and every way out of the folder it
// refuses. Nothing of this computer's own home is touched.

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const posix = process.platform !== "win32";

async function home() {
  root = await realpath(await mkdtemp(join(tmpdir(), "files-documents-")));
  const account = join(root, "home");
  await mkdir(account, { mode: 0o700 });
  const host: DocumentsHost = {
    home: account,
    platform: process.platform,
    folder: join(account, "Lazurio"),
  };
  return { root, account, host, documents: join(account, "Documents") };
}

async function opened(host: DocumentsHost): Promise<Documents> {
  const documents = await openDocuments(host, { create: true });
  if (isRefused(documents)) throw new Error(documents.refusal);
  return documents;
}

async function entry(documents: Documents, segments: string[]) {
  const found = await resolveDocument(documents, segments);
  if (isRefused(found)) throw new Error(found.refusal);
  return found;
}

async function mkfifo(path: string) {
  const child = Bun.spawn(["mkfifo", path]);
  if ((await child.exited) !== 0) throw new Error("mkfifo failed");
}

const bodyOf = (...chunks: (Uint8Array | Error)[]) =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else if (next instanceof Error) controller.error(next);
      else controller.enqueue(next);
    },
  });

test("the home is HOME, or USERPROFILE on Windows, and only when absolute", () => {
  expect(accountHome({ HOME: "/home/operator" }, "linux")).toBe(
    "/home/operator",
  );
  expect(accountHome({ HOME: "relative" }, "linux")).toBeUndefined();
  expect(accountHome({}, "darwin")).toBeUndefined();
  expect(
    accountHome(
      { HOME: "/ignored", USERPROFILE: "C:\\Users\\operator" },
      "win32",
    ),
  ).toBe("C:\\Users\\operator");
});

test.skipIf(!posix)(
  "the Documents folder is created, and nothing else, only when listing or uploading",
  async () => {
    const { account, host, documents } = await home();
    expect(await openDocuments(host, { create: false })).toEqual({
      refusal: "not-found",
    });
    expect(await readdir(account)).toEqual([]);
    const created = await opened(host);
    expect(created.real).toBe(documents);
    expect(await readdir(account)).toEqual(["Documents"]);
    expect((await stat(documents)).mode & 0o777).toBe(0o700);
    // No home: nothing to serve.
    expect(
      await openDocuments({ ...host, home: undefined }, { create: true }),
    ).toEqual({ refusal: "documents-unavailable" });
    // A missing home is not created either.
    expect(
      await openDocuments(
        { ...host, home: join(account, "absent") },
        { create: true },
      ),
    ).toEqual({ refusal: "documents-unavailable" });
    expect(await readdir(account)).toEqual(["Documents"]);
  },
);

test.skipIf(!posix)(
  "a Documents folder that is a file, the home itself, above it, or overlaps the Lazurio Folder serves nothing",
  async () => {
    const { root: base, account, host, documents } = await home();
    await writeFile(documents, "not a folder");
    expect(await openDocuments(host, { create: true })).toEqual({
      refusal: "documents-unavailable",
    });
    for (const target of [account, base, "/"]) {
      await rm(documents, { force: true });
      await symlink(target, documents);
      expect([target, await openDocuments(host, { create: true })]).toEqual([
        target,
        { refusal: "documents-unavailable" },
      ]);
    }
    // The Lazurio Folder, or a folder inside it.
    const folder = join(account, "Lazurio");
    await mkdir(join(folder, "organizations"), { recursive: true });
    for (const target of [folder, join(folder, "organizations")]) {
      await rm(documents, { force: true });
      await symlink(target, documents);
      expect(await openDocuments(host, { create: true })).toEqual({
        refusal: "documents-unavailable",
      });
    }
    // A hidden folder of the home, or one on a hidden path, is no Documents
    // folder either.
    for (const target of [
      join(account, ".ssh"),
      join(account, ".config", "docs"),
    ]) {
      await mkdir(target, { recursive: true });
      await rm(documents, { force: true });
      await symlink(target, documents);
      expect([target, await openDocuments(host, { create: true })]).toEqual([
        target,
        { refusal: "documents-unavailable" },
      ]);
    }
    // A visible folder of the home is fine.
    const visible = join(account, "Sdílené", "Dokumenty");
    await mkdir(visible, { recursive: true });
    await rm(documents, { force: true });
    await symlink(visible, documents);
    expect((await opened(host)).real).toBe(visible);
    // A link to an ordinary folder elsewhere is the Operator's choice.
    const elsewhere = join(base, "cloud", "Documents");
    await mkdir(elsewhere, { recursive: true });
    await rm(documents, { force: true });
    await symlink(elsewhere, documents);
    expect((await opened(host)).real).toBe(elsewhere);
  },
);

test.skipIf(!posix)(
  "a path resolves inside the folder only: links that leave it, links into hidden folders and special files are refused",
  async () => {
    const { root: base, host, documents } = await home();
    const docs = await opened(host);
    await mkdir(join(documents, "Úkol"));
    await writeFile(join(documents, "Úkol", "Zpráva.docx"), "report");
    await mkdir(join(documents, ".hidden"));
    await writeFile(join(documents, ".hidden", "secret.txt"), "secret");
    await writeFile(join(base, "outside.txt"), "outside");
    await mkdir(join(base, "home", ".ssh"));
    await writeFile(join(base, "home", ".ssh", "id_ed25519"), "key");
    await symlink(join(base, "outside.txt"), join(documents, "escape.txt"));
    await symlink(join(base, "home", ".ssh"), join(documents, "keys"));
    await symlink(join(base, "home"), join(documents, "home"));
    await symlink(
      join(documents, "Úkol", "Zpráva.docx"),
      join(documents, "latest.docx"),
    );
    await symlink(join(documents, ".hidden"), join(documents, "unhidden"));
    await symlink(join(documents, "missing"), join(documents, "dangling"));
    await mkfifo(join(documents, "pipe"));

    const file = await entry(docs, ["Úkol", "Zpráva.docx"]);
    expect(file).toMatchObject({
      kind: "file",
      segments: ["Úkol", "Zpráva.docx"],
      size: 6,
    });
    expect((await entry(docs, [])).kind).toBe("directory");
    // A link that stays inside resolves to its target.
    expect(await entry(docs, ["latest.docx"])).toMatchObject({
      kind: "file",
      segments: ["Úkol", "Zpráva.docx"],
    });
    for (const [path, refusal] of [
      [["escape.txt"], "outside-documents"],
      [["keys"], "outside-documents"],
      [["keys", "id_ed25519"], "outside-documents"],
      [["home", ".ssh", "id_ed25519"], "outside-documents"],
      [["unhidden"], "path-hidden"],
      [["unhidden", "secret.txt"], "path-hidden"],
      [["dangling"], "not-found"],
      [["absent.txt"], "not-found"],
      [["Úkol", "Zpráva.docx", "below-a-file"], "not-found"],
      [["pipe"], "not-regular"],
    ] as const)
      expect([path, await resolveDocument(docs, path)]).toEqual([
        path,
        { refusal },
      ]);
  },
);

test.skipIf(!posix)(
  "a listing holds the visible entries only, folders first, then names as people read them",
  async () => {
    const { root: base, host, documents } = await home();
    const docs = await opened(host);
    await mkdir(join(documents, "b-folder"));
    await mkdir(join(documents, "A-folder"));
    await writeFile(join(documents, "file10.txt"), "1234567890");
    await writeFile(join(documents, "file9.txt"), "123456789");
    await writeFile(join(documents, "Čaj.md"), "tea");
    await writeFile(join(documents, ".hidden.txt"), "hidden");
    await writeFile(
      join(documents, ".lazurio-upload-0123456789abcdef.part"),
      "x",
    );
    await writeFile(join(base, "outside.txt"), "outside");
    await symlink(join(base, "outside.txt"), join(documents, "escape.txt"));
    await symlink(join(documents, "file9.txt"), join(documents, "linked.txt"));
    await symlink(join(documents, "A-folder"), join(documents, "z-link"));
    await mkfifo(join(documents, "pipe"));
    const when = new Date("2026-10-02T08:30:00.000Z");
    await utimes(join(documents, "file9.txt"), when, when);
    const listed = await listDocuments(docs, await entry(docs, []));
    expect(listed.map((item) => [item.name, item.kind, item.size])).toEqual([
      ["A-folder", "directory", null],
      ["b-folder", "directory", null],
      ["z-link", "directory", null],
      ["Čaj.md", "file", 3],
      ["file9.txt", "file", 9],
      ["file10.txt", "file", 10],
      ["linked.txt", "file", 9],
    ]);
    expect(listed.find((item) => item.name === "file9.txt")?.modifiedAt).toBe(
      "2026-10-02T08:30:00.000Z",
    );
  },
);

test.skipIf(!posix)(
  "the tree holds a folder reached by a link and by its own name, as the listing does, and a link loop ends",
  async () => {
    const { host, documents } = await home();
    const docs = await opened(host);
    await mkdir(join(documents, "zpráva"));
    await writeFile(join(documents, "zpráva", "final.docx"), "final");
    // The link sorts before its target.
    await symlink(join(documents, "zpráva"), join(documents, "a-odkaz"));
    await symlink(documents, join(documents, "zpráva", "nahoru"));
    const tree = [];
    for await (const item of documentTree(docs, await entry(docs, [])))
      tree.push([item.kind, item.path.join("/")]);
    expect(tree).toEqual([
      ["directory", ""],
      ["directory", "a-odkaz"],
      ["file", "a-odkaz/final.docx"],
      ["directory", "zpráva"],
      ["file", "zpráva/final.docx"],
    ]);
    expect(
      (await listDocuments(docs, await entry(docs, []))).map(
        (item) => item.name,
      ),
    ).toEqual(["a-odkaz", "zpráva"]);
  },
);

test.skipIf(!posix || process.getuid?.() === 0)(
  "a folder that cannot be read is left out of the tree with its contents",
  async () => {
    const { host, documents } = await home();
    const docs = await opened(host);
    await mkdir(join(documents, "locked"));
    await writeFile(join(documents, "locked", "secret.txt"), "x");
    await writeFile(join(documents, "open.txt"), "y");
    await chmod(join(documents, "locked"), 0o000);
    try {
      const tree = [];
      for await (const item of documentTree(docs, await entry(docs, [])))
        tree.push([item.kind, item.path.join("/")]);
      expect(tree).toEqual([
        ["directory", ""],
        ["file", "open.txt"],
      ]);
    } finally {
      await chmod(join(documents, "locked"), 0o700);
    }
  },
);

test.skipIf(!posix)(
  "the tree of a folder is everything visible below it once, and a link loop ends",
  async () => {
    const { root: base, host, documents } = await home();
    const docs = await opened(host);
    await mkdir(join(documents, "Úkol", "data"), { recursive: true });
    await writeFile(join(documents, "Úkol", "Zpráva.docx"), "report");
    await writeFile(join(documents, "Úkol", "data", "a.csv"), "1,2");
    await writeFile(join(documents, "Úkol", ".notes"), "hidden");
    await symlink(join(documents, "Úkol"), join(documents, "Úkol", "loop"));
    await symlink(base, join(documents, "Úkol", "escape"));
    await mkfifo(join(documents, "Úkol", "pipe"));
    const tree = [];
    for await (const item of documentTree(docs, await entry(docs, ["Úkol"])))
      tree.push([item.kind, item.path.join("/")]);
    expect(tree).toEqual([
      ["directory", ""],
      ["directory", "data"],
      ["file", "data/a.csv"],
      ["file", "Zpráva.docx"],
    ]);
  },
);

test.skipIf(!posix)(
  "a read covers exactly the asked bytes, and a FIFO in a file's place fails at once",
  async () => {
    const { host, documents } = await home();
    const docs = await opened(host);
    await writeFile(join(documents, "digits.txt"), "0123456789");
    const file = await entry(docs, ["digits.txt"]);
    const read = async (start: number, end: number) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of readDocument(file.real, start, end))
        chunks.push(chunk);
      return Buffer.concat(chunks).toString();
    };
    expect(await read(0, 10)).toBe("0123456789");
    expect(await read(3, 7)).toBe("3456");
    expect(await read(5, 5)).toBe("");
    // The file shrank under the reader: the read breaks, never pads.
    await expect(read(0, 20)).rejects.toThrow();
    await rm(file.real);
    await mkfifo(file.real);
    await expect(read(0, 1)).rejects.toThrow("Not a regular file any more");
  },
);

async function upload(
  host: DocumentsHost,
  docs: Documents,
  directory: DocumentEntry,
  name: string,
  body: ReadableStream<Uint8Array> | null,
  length: number,
  now?: () => number,
) {
  return uploadDocument(host, docs, directory, name, body, length, now);
}

test.skipIf(!posix)(
  "an upload is written whole under a free name, never over an existing entry, and leaves no temporary file",
  async () => {
    const { host, documents } = await home();
    const docs = await opened(host);
    const folder = await entry(docs, []);
    const bytes = new TextEncoder().encode("first version");
    expect(
      await upload(host, docs, folder, "report.docx", bodyOf(bytes), 13),
    ).toEqual({ name: "report.docx", size: 13 });
    const second = new TextEncoder().encode("second");
    expect(
      await upload(host, docs, folder, "report.docx", bodyOf(second), 6),
    ).toEqual({ name: "report (2).docx", size: 6 });
    // A folder of the same name is not replaced either.
    await mkdir(join(documents, "data"));
    expect(await upload(host, docs, folder, "data", bodyOf(second), 6)).toEqual(
      { name: "data (2)", size: 6 },
    );
    expect(await readFile(join(documents, "report.docx"), "utf8")).toBe(
      "first version",
    );
    expect(await readFile(join(documents, "report (2).docx"), "utf8")).toBe(
      "second",
    );
    // An empty file is a file.
    expect(await upload(host, docs, folder, "empty.txt", null, 0)).toEqual({
      name: "empty.txt",
      size: 0,
    });
    expect((await readdir(documents)).sort()).toEqual([
      "data",
      "data (2)",
      "empty.txt",
      "report (2).docx",
      "report.docx",
    ]);
  },
);

test.skipIf(!posix)(
  "a broken or short upload removes its temporary file and creates nothing",
  async () => {
    const { host, documents } = await home();
    const docs = await opened(host);
    const folder = await entry(docs, []);
    const chunk = new Uint8Array(1024).fill(7);
    // The client goes away mid-body.
    expect(
      await upload(
        host,
        docs,
        folder,
        "broken.bin",
        bodyOf(chunk, chunk, new Error("The connection was closed.")),
        4096,
      ),
    ).toEqual({ refusal: "upload-incomplete" });
    // Fewer bytes than declared, or more.
    expect(
      await upload(host, docs, folder, "short.bin", bodyOf(chunk), 4096),
    ).toEqual({ refusal: "upload-incomplete" });
    expect(
      await upload(host, docs, folder, "long.bin", bodyOf(chunk, chunk), 1500),
    ).toEqual({ refusal: "upload-incomplete" });
    expect(await readdir(documents)).toEqual([]);
  },
);

test.skipIf(!posix)(
  "an upload is refused before writing when its name is not allowed or the space is too small",
  async () => {
    const { host, documents } = await home();
    const docs = await opened(host);
    const folder = await entry(docs, []);
    const body = () => bodyOf(new Uint8Array(10));
    for (const [name, refusal] of [
      [".bashrc", "path-hidden"],
      ["a/b", "path-invalid"],
      ["..", "path-invalid"],
      ["", "path-invalid"],
    ] as const)
      expect(await upload(host, docs, folder, name, body(), 10)).toEqual({
        refusal,
      });
    const small = { ...host, freeBytes: async () => 9 };
    expect(await upload(small, docs, folder, "big.bin", body(), 10)).toEqual({
      refusal: "disk-full",
    });
    expect(await readdir(documents)).toEqual([]);
    // Into a file: not a folder.
    await writeFile(join(documents, "file.txt"), "x");
    expect(
      await upload(
        host,
        docs,
        await entry(docs, ["file.txt"]),
        "x.txt",
        body(),
        10,
      ),
    ).toEqual({ refusal: "not-directory" });
  },
);

test.skipIf(!posix)(
  "without hard links an upload reserves its name exclusively and moves in, still never replacing an entry",
  async () => {
    const { host, documents } = await home();
    const noLinks: DocumentsHost = {
      ...host,
      link: async () => {
        throw Object.assign(new Error("Operation not permitted"), {
          code: "EPERM",
        });
      },
    };
    const docs = await opened(noLinks);
    const folder = await entry(docs, []);
    await writeFile(join(documents, "report.docx"), "existing");
    const bytes = new TextEncoder().encode("uploaded");
    expect(
      await upload(noLinks, docs, folder, "report.docx", bodyOf(bytes), 8),
    ).toEqual({ name: "report (2).docx", size: 8 });
    expect(await readFile(join(documents, "report.docx"), "utf8")).toBe(
      "existing",
    );
    expect(await readFile(join(documents, "report (2).docx"), "utf8")).toBe(
      "uploaded",
    );
    expect((await readdir(documents)).sort()).toEqual([
      "report (2).docx",
      "report.docx",
    ]);
    // Any other failure of the link is not taken for a missing feature.
    const broken: DocumentsHost = {
      ...host,
      link: async () => {
        throw Object.assign(new Error("I/O error"), { code: "EIO" });
      },
    };
    await expect(
      upload(broken, docs, folder, "other.docx", bodyOf(bytes), 8),
    ).rejects.toThrow("I/O error");
    expect((await readdir(documents)).sort()).toEqual([
      "report (2).docx",
      "report.docx",
    ]);
  },
);

test.skipIf(!posix)(
  "a name is stored in NFC, and leftovers of a killed upload older than an hour are removed",
  async () => {
    const { host, documents } = await home();
    const docs = await opened(host);
    const folder = await entry(docs, []);
    const old = join(documents, ".lazurio-upload-00000000000000aa.part");
    const recent = join(documents, ".lazurio-upload-00000000000000bb.part");
    await writeFile(old, "left behind");
    await writeFile(recent, "in progress elsewhere");
    const now = Date.now();
    const hourAgo = new Date(now - 61 * 60 * 1000);
    await utimes(old, hourAgo, hourAgo);
    const decomposed = "Zpra\u0301va.txt";
    const result = await upload(
      host,
      docs,
      folder,
      decomposed,
      bodyOf(new Uint8Array(1)),
      1,
      () => now,
    );
    expect(result).toEqual({ name: "Zpráva.txt", size: 1 });
    expect((await readdir(documents)).sort()).toEqual(
      [".lazurio-upload-00000000000000bb.part", "Zpráva.txt"].sort(),
    );
  },
);
