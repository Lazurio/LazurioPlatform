import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
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
 * Environment of that release draws, and the Environment browser's contract
 * the forks vendor from it (decision F50 point 5). Nothing in it depends on a
 * target, so the publishing job of `.github/workflows/release.yml` builds it
 * once, and the one attestation of the release names it among its subjects.
 * It is not in `manifest.json` and never an input of an update.
 *
 *   bun run scripts/release-shell.ts --version <X.Y.Z> --commit <sha> --out <absolute directory>
 */
export const shellArtifactFile = "lazurio-shell.tar.gz";
const shellArtifactSchema = "lazurio.shell-artifact.v1";

const root = join(import.meta.dir, "..");
const vendor = join(root, "src", "shell", "vendor");

/** The Environment browser's contract module (decision F50 point 1), its two
 * parts, and the directory the archive holds it in. */
const browserContractSource = join(root, "src", "browser", "contract");
const browserContractParts = ["pure", "node"] as const;
export const browserContractDirectory = "browser-contract";

/** The contract's major (F50 point 3), which `artifact.json` names: its
 * vectors are `vectors/v1/` and its documents' schemas end in `.v1`. Within a
 * major the contract only grows; a major change is decided as an addendum to
 * F50 first. */
export const browserContractMajor = 1;

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
  for (const [path, bytes] of await browserContractFiles())
    files.set(`${browserContractDirectory}/${path}`, bytes);
  return files;
}

/** The Environment browser's contract as the forks vendor it (decision F50
 * points 5 and 6), by its path below `browser-contract/`, laid out as the
 * module's own directory: both parts as ES modules with their declarations,
 * the module's MIT licence file, and its vectors with their README, byte for
 * byte. Every one of them is MIT; the archive's root `LICENSE` covers the
 * rest. */
async function browserContractFiles(): Promise<Map<string, Uint8Array>> {
  const files = browserContractModules();
  files.set("LICENSE", await readFile(join(browserContractSource, "LICENSE")));
  for (const path of await filesBelow(join(browserContractSource, "vectors")))
    files.set(
      `vectors/${path}`,
      await readFile(join(browserContractSource, "vectors", path)),
    );
  return files;
}

/** Every regular file below a directory, by its path relative to it. A hidden
 * file is never part of the module (the archive admits no hidden path), and
 * anything that is neither a file nor a directory, such as a link, refuses
 * the build: nothing from outside the module may enter the archive. */
async function filesBelow(directory: string, below = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(directory, below), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".")) continue;
    const path = below === "" ? entry.name : `${below}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesBelow(directory, path)));
    else if (entry.isFile()) found.push(path);
    else throw new Error(`Not a regular file of the module: ${path}`);
  }
  return found;
}

// This repository's compiler options, as `tsconfig.json` sets them.
function repositoryCompilerOptions(): Readonly<{
  options: ts.CompilerOptions;
  errors: readonly ts.Diagnostic[];
}> {
  const config = ts.readConfigFile(
    join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  if (config.error !== undefined)
    throw new Error("tsconfig.json is not readable");
  return ts.parseJsonConfigFileContent(config.config, ts.sys, root);
}

const messages = (problems: readonly ts.Diagnostic[]) =>
  problems
    .map((problem) => ts.flattenDiagnosticMessageText(problem.messageText, " "))
    .join("; ");

// The module's two parts as the forks take them: each part an ES module of
// its own with its declarations, so `node.js` imports `pure.js` and every
// rule keeps one definition. They are transpiled, not bundled as
// `contract.js` is: a bundle of the Node part would carry its own copy of the
// pure rules it uses. The pinned TypeScript that writes `contract.d.ts`
// writes both forms of both parts in one program, with the repository's
// compiler options, against Node's declarations alone (the Node part needs
// only `node:` built-ins, never Bun's). Not minified and with the module's
// comments, so a fork reviews a bump as a diff. The one import between the
// parts names the file the archive holds, `./pure.js`, which Node's own
// module loader needs and bundlers and TypeScript accept. Any diagnostic
// refuses the build.
function browserContractModules(): Map<string, Uint8Array> {
  const { options, errors } = repositoryCompilerOptions();
  const program = ts.createProgram(
    browserContractParts.map((part) =>
      join(browserContractSource, `${part}.ts`),
    ),
    {
      ...options,
      noEmit: false,
      declaration: true,
      types: ["node"],
      typeRoots: [join(root, "node_modules", "@types")],
      // The same bytes on every runner.
      newLine: ts.NewLineKind.LineFeed,
    },
  );
  const written = new Map<string, Uint8Array>();
  const emitted = program.emit(
    undefined,
    (name, text) => written.set(basename(name), new TextEncoder().encode(text)),
    undefined,
    false,
    { after: [partImports], afterDeclarations: [partImports] },
  );
  const problems = [
    ...errors,
    ...ts.getPreEmitDiagnostics(program),
    ...emitted.diagnostics,
  ];
  const expected = browserContractParts
    .flatMap((part) => [`${part}.d.ts`, `${part}.js`])
    .sort();
  if (
    problems.length > 0 ||
    emitted.emitSkipped ||
    [...written.keys()].sort().join() !== expected.join()
  )
    throw new Error(
      `The browser contract's modules were not produced: ${messages(problems)}`,
    );
  return written;
}

// An import or export of another part of the module (`./pure`) names that
// part's file in the archive (`./pure.js`).
function partImports(context: ts.TransformationContext) {
  const { factory } = context;
  const parts: readonly string[] = browserContractParts;
  const archived = (specifier: ts.Expression | undefined) => {
    if (specifier === undefined || !ts.isStringLiteral(specifier)) return null;
    const part = /^\.\/([a-z]+)$/.exec(specifier.text)?.[1];
    return part !== undefined && parts.includes(part)
      ? factory.createStringLiteral(`./${part}.js`)
      : null;
  };
  const visit = (node: ts.Node): ts.Node => {
    if (ts.isImportDeclaration(node)) {
      const specifier = archived(node.moduleSpecifier);
      if (specifier !== null)
        return factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          specifier,
          node.attributes,
        );
    }
    if (ts.isExportDeclaration(node)) {
      const specifier = archived(node.moduleSpecifier);
      if (specifier !== null)
        return factory.updateExportDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          specifier,
          node.attributes,
        );
    }
    return node;
  };
  return <T extends ts.SourceFile | ts.Bundle>(file: T): T =>
    ts.isSourceFile(file)
      ? (ts.visitEachChild(file, visit, context) as T)
      : file;
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
  const { options, errors } = repositoryCompilerOptions();
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
    throw new Error(`contract.d.ts was not produced: ${messages(problems)}`);
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

/** The bytes of the asset: the shell's files, the browser contract's and
 * `artifact.json`, which names the release, the promised interface version,
 * the contract's major with its files (`browserContract`, an addition to
 * `lazurio.shell-artifact.v1`) and the SHA-256 of every other file, in a
 * deterministic `.tar.gz` (the same inputs give the same bytes). */
export async function buildShellArtifact(release: {
  version: string;
  sourceCommit: string;
}): Promise<Uint8Array> {
  if (!isProductVersion(release.version)) throw new Error("Invalid version");
  if (!/^[0-9a-f]{40}$/.test(release.sourceCommit))
    throw new Error("Invalid source commit");
  const files = await packedFiles();
  const paths = [...files.keys()].sort();
  const listed = Object.fromEntries(
    paths.map((path) => [path, sha256Hex(files.get(path) as Uint8Array)]),
  );
  const metadata = {
    schema: shellArtifactSchema,
    version: release.version,
    sourceCommit: release.sourceCommit,
    interface: shellElementInterface.version,
    // The files the MIT exception of decision F50 point 6 covers; `files`
    // lists their digests with every other file's.
    browserContract: {
      major: browserContractMajor,
      files: paths.filter((path) =>
        path.startsWith(`${browserContractDirectory}/`),
      ),
    },
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
