import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { identityDefines } from "../src/update/identity";

/** Builds the bundle that `scripts/qualify-update-linux.sh` runs ON a Linux
 * Machine: three REAL product executables (`src/cli.ts`) that differ only in
 * their embedded version, the signed loopback fixture server, and the script.
 * Cross-compiles from any host; copying the bundle to the Machine and running
 * it there is the operator's step and needs nothing from this repository.
 *
 *   bun run scripts/qualify-update-linux.ts build --target <linux-arm64|linux-x64> --out <absent absolute directory>
 *
 * Development evidence tooling: it signs nothing real, publishes nothing and
 * installs nothing on the host.
 */
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  allowPositionals: true,
  options: { target: { type: "string" }, out: { type: "string" } },
});
const target = values.target ?? "";
const out = values.out ?? "";
if (
  positionals.length !== 1 ||
  positionals[0] !== "build" ||
  !["linux-arm64", "linux-x64"].includes(target) ||
  !isAbsolute(out) ||
  resolve(out) !== out
)
  throw new Error(
    "Usage: build --target <linux-arm64|linux-x64> --out <absent absolute directory>",
  );

const run = async (command: string[]) => {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Failed: ${command[0]}`);
};
const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
const commit = git.stdout.toString().trim();
if (git.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit))
  throw new Error("Source commit unavailable");
const toolchain = JSON.parse(await readFile("package.json", "utf8"))
  .packageManager as string;

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
for (const version of ["1.0.0", "1.1.0", "1.2.0"])
  await compile(
    "src/cli.ts",
    join(out, `lazurio-${version}`),
    identityDefines({ version, commit, target }),
  );
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
  `COMMIT=${commit}\nTARGET=${target}\nTOOLCHAIN=${toolchain}\n`,
);
console.log(`Bundle for ${target} at commit ${commit}: ${out}`);
