import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { identityDefines, nativeTarget } from "../../src/update/identity";
import {
  swapSelector,
  versionDirectory,
  versionName,
} from "../../src/update/layout";

/** REAL compiled executables of the TEST-ONLY product (`fixtures/
 * update-product.ts`) with different embedded versions. Compiled once per test
 * process into one temporary directory — a compile takes a fraction of a
 * second, a copy per test would not be needed at all.
 */
export const target = nativeTarget(process.platform, process.arch);
export const commit = "c".repeat(40);

export type ProductBinary = Readonly<{
  version: string;
  path: string;
  bytes: Buffer;
  sha256: string;
  name: string;
}>;

let root: Promise<string> | undefined;
const built = new Map<string, Promise<ProductBinary>>();

function buildRoot(): Promise<string> {
  root ??= (async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "update-product-")),
    );
    process.on("exit", () =>
      rmSync(directory, { recursive: true, force: true }),
    );
    return directory;
  })();
  return root;
}

/** Path of the control file every binary of this process reads at start. */
export async function controlFile(): Promise<string> {
  return join(await buildRoot(), "control");
}

export async function setControl(mode: string | null): Promise<void> {
  const path = await controlFile();
  await rm(`${path}.reached`, { force: true });
  if (mode === null) await rm(path, { force: true });
  else await writeFile(path, mode);
}

export function productBinary(version: string): Promise<ProductBinary> {
  let binary = built.get(version);
  if (!binary) {
    binary = (async () => {
      const directory = await buildRoot();
      const path = join(directory, `lazurio-${version}`);
      const child = Bun.spawn(
        [
          process.execPath,
          "build",
          resolve(import.meta.dir, "../fixtures/update-product.ts"),
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          ...identityDefines({ version, commit, target }),
          "--define",
          `LAZURIO_TEST_CONTROL=${JSON.stringify(join(directory, "control"))}`,
          "--outfile",
          path,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      if ((await child.exited) !== 0)
        throw new Error(await new Response(child.stderr).text());
      const bytes = await readFile(path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return Object.freeze({
        version,
        path,
        bytes,
        sha256,
        name: versionName(version, sha256),
      });
    })();
    built.set(version, binary);
  }
  return binary;
}

/** The signed identity a publisher would write for this binary. */
export function identityOf(
  binary: ProductBinary,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: binary.version,
    target,
    sourceCommit: commit,
    toolchain: `bun@${Bun.version}`,
    schemas: { preferences: [1], manifest: [1] },
    artifactSha256: binary.sha256,
    artifactBytes: binary.bytes.length,
    ...overrides,
  };
}

/** What an installer (not part of this slice) leaves behind: one staged
 * version and the selector that names it.
 */
export async function installVersion(
  base: string,
  binary: ProductBinary,
  identity: Record<string, unknown> = identityOf(binary),
): Promise<void> {
  const directory = versionDirectory(base, binary.name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(binary.path, join(directory, "lazurio"));
  await chmod(join(directory, "lazurio"), 0o500);
  await writeFile(join(directory, "identity.json"), JSON.stringify(identity), {
    mode: 0o400,
  });
  await swapSelector(base, binary.name);
}
