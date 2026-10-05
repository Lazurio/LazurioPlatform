import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import ts from "typescript";
import { shellScript } from "../src/shell/bundle";
import { shellFontPaths } from "../src/shell/font-files";
import { shellFonts } from "../src/shell/fonts";
import { shellElementInterface } from "../src/shell/interface";
import { isProductVersion } from "../src/update/identity";
import { sha256Hex } from "../src/update/manifest";

/** The shell of one release as one asset, `lazurio-shell.tar.gz`
 * (docs/update.md "The shell artifact"; decision F36): what a host outside an
 * Environment, such as the Lazurio Dashboard, pins to draw the rail every
 * Environment of that release draws. Nothing in it depends on a target, so the
 * publishing job of `.github/workflows/release.yml` builds it once, and the
 * one attestation of the release names it among its subjects. It is not in
 * `manifest.json` and never an input of an update.
 *
 *   bun run scripts/release-shell.ts --version <X.Y.Z> --commit <sha> --out <absolute directory>
 */
export const shellArtifactFile = "lazurio-shell.tar.gz";
const shellArtifactSchema = "lazurio.shell-artifact.v1";

const root = join(import.meta.dir, "..");
const vendor = join(root, "src", "shell", "vendor");

/** Every file of the asset but `artifact.json`, by its path inside. */
async function packedFiles(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>([
    // The string the macro of `src/launchpad/page.ts` embeds, by the same
    // function called plainly: the same build by the same Bun, so the bytes
    // the Launchpad of this release serves at `/.lazurio/shell.js`.
    ["shell.js", new TextEncoder().encode(shellScript())],
    ["contract.js", contractScript()],
    ["contract.d.ts", contractDeclarations()],
    ["LICENSE", await readFile(join(root, "LICENSE"))],
    ["NOTICE", await readFile(join(root, "NOTICE"))],
    // The interface icons inside `shell.js` are Iconoir's.
    [
      "LICENSE-iconoir.txt",
      await readFile(join(vendor, "LICENSE-iconoir.txt")),
    ],
  ]);
  // The fonts as the Launchpad serves them at `/.lazurio/fonts/<file>`: the
  // files it embeds, under the names the script requests.
  for (const { file } of shellFonts)
    files.set(`fonts/${file}`, await readFile(shellFontPaths[file]));
  // Every licence of the vendored fonts, so a new family brings its own.
  for (const name of await readdir(join(vendor, "fonts")))
    if (name.startsWith("LICENSE-"))
      files.set(`fonts/${name}`, await readFile(join(vendor, "fonts", name)));
  return files;
}

// `src/shell/contract.ts` alone as an ES module: the parsers of both
// documents without the elements, because importing `shell.js` defines them
// and so needs a DOM; a host reads and writes the documents in server code and
// tests. Not minified, so a host reviews a bump as a diff. Built from the
// repository root: the one comment Bun writes names the entry relative to the
// working directory.
function contractScript(): Uint8Array {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "src/shell/contract.ts",
      "--target=browser",
      "--format=esm",
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  if (!result.success)
    throw new Error(`contract.js did not build: ${result.stderr}`);
  return new Uint8Array(result.stdout);
}

// The declarations of the same module, by the pinned TypeScript with this
// repository's compiler options, in memory. Without Bun's types: the contract
// needs none, and a host need not be a Bun program. Any diagnostic refuses the
// build rather than shipping declarations that may not match `contract.js`.
function contractDeclarations(): Uint8Array {
  const entry = join(root, "src", "shell", "contract.ts");
  const config = ts.readConfigFile(
    join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  if (config.error !== undefined)
    throw new Error("contract.d.ts: tsconfig.json is not readable");
  const { options, errors } = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
  );
  const program = ts.createProgram([entry], {
    ...options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    types: [],
    // The same bytes on every runner.
    newLine: ts.NewLineKind.LineFeed,
  });
  const written: string[] = [];
  const emitted = program.emit(program.getSourceFile(entry), (_name, text) =>
    written.push(text),
  );
  const problems = [
    ...errors,
    ...ts.getPreEmitDiagnostics(program),
    ...emitted.diagnostics,
  ];
  const [declarations] = written;
  if (
    problems.length > 0 ||
    emitted.emitSkipped ||
    written.length !== 1 ||
    declarations === undefined
  )
    throw new Error(
      `contract.d.ts was not produced: ${problems
        .map((problem) =>
          ts.flattenDiagnosticMessageText(problem.messageText, " "),
        )
        .join("; ")}`,
    );
  return new TextEncoder().encode(declarations);
}

const block = 512;
const padding = (length: number, unit = block) =>
  (unit - (length % unit)) % unit;

// One POSIX ustar header of a regular file: mode 0644, owner and group 0
// without names, modified at time 0. Nothing of the runner or of the moment
// enters, so the same inputs give the same bytes.
function header(path: string, size: number): Uint8Array {
  // Every path is this script's own; plain ASCII fits the 100-byte name field.
  if (
    path.length >= 100 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(path)
  )
    throw new Error(`Not an archive path: ${path}`);
  const bytes = new Uint8Array(block);
  const ascii = (offset: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), offset);
  const octal = (offset: number, length: number, value: number) =>
    ascii(offset, `${value.toString(8).padStart(length - 1, "0")}\0`);
  ascii(0, path);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  // The checksum is computed with its own field as eight spaces.
  ascii(148, " ".repeat(8));
  ascii(156, "0");
  ascii(257, "ustar\u000000");
  const sum = bytes.reduce((total, byte) => total + byte, 0);
  ascii(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return bytes;
}

// The files in path order, then two zero blocks, padded to a whole record of
// 20 blocks as GNU tar and bsdtar write their archives.
function tar(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path) as Uint8Array;
    parts.push(
      header(path, data.length),
      data,
      new Uint8Array(padding(data.length)),
    );
  }
  const length = parts.reduce((total, part) => total + part.length, 0);
  parts.push(
    new Uint8Array(2 * block + padding(length + 2 * block, 20 * block)),
  );
  return Buffer.concat(parts);
}

// gzip with a header that names no time, no file and no operating system
// (255, unknown): Node's own gzip writes the runner's operating system there.
function gzip(data: Uint8Array): Uint8Array {
  const trailer = new DataView(new ArrayBuffer(8));
  trailer.setUint32(0, crc32(data), true);
  trailer.setUint32(4, data.length % 2 ** 32, true);
  return Buffer.concat([
    Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255),
    deflateRawSync(data, { level: 9 }),
    new Uint8Array(trailer.buffer),
  ]);
}

/** The bytes of the asset: the shell's files and `artifact.json`, which names
 * the release, the promised interface version and the SHA-256 of every other
 * file, in a deterministic `.tar.gz` (the same inputs give the same bytes). */
export async function buildShellArtifact(release: {
  version: string;
  sourceCommit: string;
}): Promise<Uint8Array> {
  if (!isProductVersion(release.version)) throw new Error("Invalid version");
  if (!/^[0-9a-f]{40}$/.test(release.sourceCommit))
    throw new Error("Invalid source commit");
  const files = await packedFiles();
  const listed = Object.fromEntries(
    [...files.keys()]
      .sort()
      .map((path) => [path, sha256Hex(files.get(path) as Uint8Array)]),
  );
  const metadata = {
    schema: shellArtifactSchema,
    version: release.version,
    sourceCommit: release.sourceCommit,
    interface: shellElementInterface.version,
    files: listed,
  };
  files.set(
    "artifact.json",
    new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`),
  );
  return gzip(tar(files));
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      out: { type: "string" },
    },
  });
  const { version = "", commit = "", out = "" } = values;
  if (
    !isProductVersion(version) ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !isAbsolute(out)
  )
    throw new Error(
      "Usage: --version <X.Y.Z> --commit <sha> --out <absolute directory>",
    );
  const artifact = await buildShellArtifact({ version, sourceCommit: commit });
  await mkdir(out, { recursive: true });
  const file = join(out, shellArtifactFile);
  // A release builds its asset once; an earlier file is never replaced.
  await writeFile(file, artifact, { flag: "wx" });
  console.log(
    `Wrote ${file} for ${version}: ${artifact.length} bytes, SHA-256 ${sha256Hex(artifact)}`,
  );
}
