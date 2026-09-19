import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { identityDefines } from "../src/update/identity";
import { createFixtureSigstore, writeFixtureRelease } from "./update-fixture";

/** Builds the bundle that `scripts/qualify-update-linux.sh` runs ON a
 * disposable Linux Machine: four REAL product executables (`src/cli.ts`) that
 * differ only in their embedded version, a release tree for each of them —
 * manifest, executable and a Sigstore bundle signed by a throwaway FIXTURE
 * Sigstore (`scripts/update-fixture.ts`) — the loopback origin server, the
 * fixture trusted root and the script. Cross-compiles from any host.
 *
 *   bun run scripts/qualify-update-linux.ts --target <linux-arm64|linux-x64> --out <absent absolute directory> --bundle-path <absolute path of the bundle ON the Linux Machine>
 *
 * FIXTURE BUILDS, NEVER A RELEASE: the executables carry the fixture define —
 * a loopback origin and a trusted root read from `<bundle-path>` — say so in
 * `--version`, and are refused by a product updater's self-check. This signs
 * nothing real, publishes nothing and installs nothing on the host.
 */
const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    target: { type: "string" },
    out: { type: "string" },
    "bundle-path": { type: "string" },
  },
});
const target = values.target ?? "";
const out = values.out ?? "";
const bundlePath = values["bundle-path"] ?? "";
if (
  !["linux-arm64", "linux-x64"].includes(target) ||
  !isAbsolute(out) ||
  resolve(out) !== out ||
  !isAbsolute(bundlePath)
)
  throw new Error(
    "Usage: --target <linux-arm64|linux-x64> --out <absent absolute directory> --bundle-path <absolute path on the Machine>",
  );

const port = 38917;
const versions = ["1.0.0", "1.1.0", "1.1.5", "1.2.0"];
const run = async (command: string[]) => {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Failed: ${command[0]}`);
};
const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
const commit = git.stdout.toString().trim();
if (git.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit))
  throw new Error("Source commit unavailable");

// Exclusive: an existing directory is never adopted.
await mkdir(out, { mode: 0o700 });
const compile = (entry: string, outfile: string, defines: string[] = []) =>
  run([
    process.execPath,
    "build",
    entry,
    "--compile",
    `--target=bun-${target}`,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...defines,
    "--outfile",
    outfile,
  ]);
const trustedRootName = "FIXTURE-trusted-root.json";
const sigstore = await createFixtureSigstore();
try {
  await writeFile(join(out, trustedRootName), sigstore.trustedRoot);
  const tree = join(out, "tree");
  await mkdir(tree);
  for (const version of versions) {
    const executable = join(out, `lazurio-${version}`);
    await compile(
      "src/cli.ts",
      executable,
      identityDefines(
        { version, commit, target },
        {
          baseUrl: `http://127.0.0.1:${port}`,
          trustedRoot: join(bundlePath, trustedRootName),
        },
      ),
    );
    await writeFixtureRelease(tree, sigstore, {
      version,
      commit,
      artifacts: { [target]: await readFile(executable) },
    });
  }
} finally {
  await sigstore.close();
}
await compile(
  "scripts/update-fixture-server.ts",
  join(out, "update-fixture-server"),
);
await copyFile(
  "scripts/qualify-update-linux.sh",
  join(out, "qualify-update-linux.sh"),
);
await chmod(join(out, "qualify-update-linux.sh"), 0o700);
await writeFile(
  join(out, "bundle.env"),
  `COMMIT=${commit}\nTARGET=${target}\nPORT=${port}\nBUNDLE_PATH=${bundlePath}\n`,
);
console.log(`FIXTURE bundle for ${target} at commit ${commit}: ${out}`);
