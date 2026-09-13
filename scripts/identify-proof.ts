import { artifactIdentity } from "./artifact-identity";

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error("Cannot establish source provenance");
  return result.stdout.toString().trim();
};

if (git(["status", "--porcelain"]))
  throw new Error("Commit source changes before producing artifact provenance");
const sourceCommit = git(["rev-parse", "HEAD"]);
const pkg = await Bun.file("package.json").json();
if (pkg.packageManager !== `bun@${Bun.version}`)
  throw new Error("Build must use the pinned Bun toolchain");
const build = Bun.spawn([process.execPath, "run", "build:proof"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) throw new Error("Proof build failed");
if (
  git(["status", "--porcelain"]) ||
  git(["rev-parse", "HEAD"]) !== sourceCommit
)
  throw new Error("Source changed during the build");
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const binary = `dist/platform-proof${process.platform === "win32" ? ".exe" : ""}`;
console.log(
  JSON.stringify(
    {
      kind: "unsigned-foundation-proof",
      identity: artifactIdentity({
        version: pkg.version,
        target,
        sourceCommit,
        toolchain: pkg.packageManager,
        lockfile: await Bun.file("bun.lock").bytes(),
        artifact: await Bun.file(binary).bytes(),
      }),
    },
    null,
    2,
  ),
);
