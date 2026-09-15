import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { folderStateSchemas } from "../src/folder/state";
import { artifactIdentity } from "./artifact-identity";

// Development packaging only: no download, signing, installation or activation.
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Source provenance unavailable");
  return result.stdout.toString().trim();
};
const run = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error("Candidate build failed");
};

const output = process.argv[2];
if (!output || process.argv.length !== 3 || !isAbsolute(output))
  throw new Error("Supply one absolute, absent output directory");
if (
  resolve(output) !== output ||
  (await realpath(dirname(output))) !== dirname(output)
)
  throw new Error("Canonical output parent required");
if ((await realpath(process.cwd())) !== git(["rev-parse", "--show-toplevel"]))
  throw new Error("Run from the source repository root");
if (git(["status", "--porcelain"]))
  throw new Error("Clean committed source required");
const sourceCommit = git(["rev-parse", "HEAD"]);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (pkg.packageManager !== `bun@${Bun.version}`)
  throw new Error("Pinned Bun toolchain required");
const lockfile = await readFile("bun.lock");
await run(["install", "--frozen-lockfile", "--ignore-scripts"]);
await run(["run", "check:public"]);
// Exclusive creation; existing output (even empty) is never adopted or removed.
await mkdir(output, { mode: 0o700 });
const binary = join(
  output,
  process.platform === "win32" ? "lazurio.exe" : "lazurio",
);
await run([
  "build",
  "src/cli.ts",
  "--compile",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--outfile",
  binary,
]);
if (
  git(["status", "--porcelain"]) ||
  git(["rev-parse", "HEAD"]) !== sourceCommit
)
  throw new Error(
    "Source changed; retained output is not a qualified candidate",
  );
if (!lockfile.equals(await readFile("bun.lock")))
  throw new Error("Lock changed during build");
const identity = artifactIdentity({
  version: pkg.version,
  target: `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
  sourceCommit,
  toolchain: pkg.packageManager,
  schemas: folderStateSchemas,
  lockfile,
  artifact: await readFile(binary),
});
await writeFile(
  join(output, "identity.json"),
  `${JSON.stringify(
    {
      kind: "unsigned-development-candidate",
      identity,
    },
    null,
    2,
  )}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Built unsigned development CLI candidate; not installed or release-qualified.",
);
