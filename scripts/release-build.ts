import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import {
  identityDefines,
  nativeTarget,
  updateTargets,
} from "../src/update/identity";
import { artifactFile } from "../src/update/manifest";

/** One release executable, `lazurio-<target>`, with its identity embedded
 * (docs/update.md "Publishing"). Run by `.github/workflows/release.yml` on a
 * runner of the target itself, so the result is asked what it is before it is
 * uploaded. It never passes the fixture define: a release has one origin.
 *
 *   bun run scripts/release-build.ts --version <X.Y.Z> --commit <sha> --target <target> --out <absolute directory>
 */
const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    version: { type: "string" },
    commit: { type: "string" },
    target: { type: "string" },
    out: { type: "string" },
  },
});
const { version = "", commit = "", target = "", out = "" } = values;
if (!(updateTargets as readonly string[]).includes(target) || !isAbsolute(out))
  throw new Error(
    "Usage: --version <X.Y.Z> --commit <sha> --target <target> --out <absolute directory>",
  );
await mkdir(out, { recursive: true });
const outfile = join(out, artifactFile(target));
const build = Bun.spawn(
  [
    process.execPath,
    "build",
    "src/cli.ts",
    "--compile",
    `--target=bun-${target}`,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    ...identityDefines({ version, commit, target }),
    "--outfile",
    outfile,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await build.exited) !== 0) throw new Error("Release build failed");
if (target !== nativeTarget(process.platform, process.arch))
  throw new Error("A release executable is built on a runner of its target");
const reported = Bun.spawnSync([outfile, "--version", "--json"], {
  env: {},
  stdout: "pipe",
});
if (
  reported.exitCode !== 0 ||
  reported.stdout.toString().trim() !==
    JSON.stringify({ version, commit, target })
)
  throw new Error("The executable does not report the identity it was given");
console.log(`Built ${outfile}`);
