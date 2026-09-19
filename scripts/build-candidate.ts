import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { folderStateSchemas } from "../src/folder/state";
import { identityDefines, nativeTarget } from "../src/update/identity";
import { artifactIdentity } from "./artifact-identity";
import { candidateTarget } from "./candidate-target";

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

const { values, positionals, tokens } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  allowPositionals: true,
  tokens: true,
  options: { target: { type: "string" } },
});
const output = positionals[0];
if (
  !output ||
  positionals.length !== 1 ||
  !isAbsolute(output) ||
  tokens.filter((token) => token.kind === "option").length > 1
)
  throw new Error(
    "Supply one absolute, absent output directory and optional Linux --target",
  );
const target = candidateTarget(values.target, process.platform, process.arch);
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
const binary = join(output, target.filename);
await run([
  "build",
  "src/cli.ts",
  "--compile",
  ...(target.bunTarget ? [`--target=${target.bunTarget}`] : []),
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  // The executable states its own identity (docs/update.md "Identity in the
  // binary"); the same three values go into identity.json below.
  ...identityDefines({
    version: pkg.version,
    commit: sourceCommit,
    target: target.target,
  }),
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
  target: target.target,
  sourceCommit,
  toolchain: pkg.packageManager,
  schemas: folderStateSchemas,
  lockfile,
  artifact: await readFile(binary),
});
// identity.json and the embedded identity must be one fact. A native build is
// asked directly; a cross-build cannot run here and is covered by the shared
// `identityDefines` input plus the target's own qualification.
if (target.target === nativeTarget(process.platform, process.arch)) {
  const reported = Bun.spawnSync([binary, "--version", "--json"], {
    env: {},
    stdout: "pipe",
    stderr: "pipe",
  });
  const embedded =
    reported.exitCode === 0 ? JSON.parse(reported.stdout.toString()) : null;
  if (
    embedded?.version !== identity.version ||
    embedded?.commit !== identity.sourceCommit ||
    embedded?.target !== identity.target
  )
    throw new Error(
      "Embedded identity differs from identity.json; retained output is not a qualified candidate",
    );
}
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
