import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeTarget, updateTargets } from "../src/update/identity";
import { renderManifest, sha256Hex } from "../src/update/manifest";

// install.sh with `curl` (and optionally `gh`) replaced on PATH: the origin is
// a directory, nothing touches the network, and HOME is a temporary directory.
const target = nativeTarget(process.platform, process.arch);
const supported = (updateTargets as readonly string[]).includes(target);
const script = new URL("../install.sh", import.meta.url).pathname;
let root: string;
afterEach(async () => rm(root, { recursive: true, force: true }));

async function scene(options: { gh?: "accepts" | "refuses" } = {}) {
  root = await realpath(await mkdtemp(join(tmpdir(), "install-sh-")));
  const tree = join(root, "tree/v1.1.0");
  const tools = join(root, "tools");
  await mkdir(tree, { recursive: true });
  await mkdir(tools);
  // PATH is this private directory and NOTHING else: shims for exactly the
  // tools install.sh (and the curl shim) use. No system directory is on it, so
  // a `gh` the Machine happens to have — a hosted CI runner does — is absent
  // unless a test puts its own shim here. Shims, not links: a wrapper such as
  // macOS's `shasum` finds its real program next to the path it was run by.
  let digestTool = false;
  for (const tool of [
    "uname",
    "cut",
    "mktemp",
    "rm",
    "awk",
    "grep",
    "chmod",
    "cp",
    "sha256sum",
    "shasum",
  ]) {
    const found = ["/usr/bin", "/bin"]
      .map((directory) => join(directory, tool))
      .find((candidate) => existsSync(candidate));
    if (found)
      await writeFile(join(tools, tool), `#!/bin/sh\nexec ${found} "$@"\n`, {
        mode: 0o755,
      });
    else if (!["sha256sum", "shasum"].includes(tool))
      throw new Error(`Test prerequisite missing: ${tool}`);
    digestTool ||= found !== undefined && tool.startsWith("sha");
  }
  if (!digestTool) throw new Error("Test prerequisite missing: sha256sum");
  // The "executable" records how it was run.
  const executable = new TextEncoder().encode(
    `#!/bin/sh\necho "$@" > "${root}/ran"\n`,
  );
  await writeFile(join(tree, `lazurio-${target}`), executable);
  await writeFile(join(tree, "lazurio.sigstore.json"), "{}");
  await writeFile(
    join(tree, "manifest.json"),
    renderManifest({
      version: "1.1.0",
      sourceCommit: "a".repeat(40),
      minimumUpdaterVersion: "1.0.0",
      repository: "Lazurio/LazurioPlatform",
      targets: {
        "plan9-mips": { sha256: "0".repeat(64), size: 1 },
        [target]: {
          sha256: sha256Hex(executable),
          size: executable.byteLength,
        },
        "zz-last": { sha256: "f".repeat(64), size: 1 },
      },
    }),
  );
  const origin = "https://github.com/Lazurio/LazurioPlatform";
  // `curl` in GitHub's real multi-hop shape (verified read-only against a
  // public release): latest -> 302 to the exact-tag URL of the repository ->
  // 302 into signed asset storage on ANOTHER host, whose URL names no tag.
  // Not followed, a redirect has no body; `first-hop` overrides the first one.
  await writeFile(
    join(tools, "curl"),
    `#!/bin/sh
echo "$@" >> "${root}/curl.log"
out=/dev/null; follow=; format=
while [ $# -gt 1 ]; do
  case "$1" in
    --output) out=$2; shift ;;
    --write-out) format=$2; shift ;;
    --location) follow=1 ;;
  esac
  shift
done
url=$1
storage="https://release-assets.githubusercontent.com/github-production-release-asset/1/0a1b?sig=fixture"
redirect=; effective=$url; file=
case "$url" in
  ${origin}/releases/latest/download/*)
    redirect="${origin}/releases/download/v1.1.0/\${url##*/}"
    if [ -f "${root}/first-hop" ]; then IFS= read -r redirect < "${root}/first-hop" || true; fi
    [ "$redirect" = none ] && redirect=
    if [ -n "$follow" ] && [ -n "$redirect" ]; then effective=$storage; redirect=; file="${root}/tree/v1.1.0/\${url##*/}"; fi ;;
  ${origin}/releases/download/*)
    if [ -n "$follow" ]; then effective=$storage; file="${root}/tree/\${url#${origin}/releases/download/}"
    else redirect=$storage; fi ;;
  *) exit 6 ;;
esac
if [ -n "$file" ]; then [ -f "$file" ] || exit 22; cp "$file" "$out"; fi
case "$format" in
  *redirect_url*) printf '%s' "$redirect" ;;
  *url_effective*) printf '%s' "$effective" ;;
esac
`,
    { mode: 0o755 },
  );
  if (options.gh)
    await writeFile(
      join(tools, "gh"),
      // Records its arguments and whether the download had ALREADY been run.
      `#!/bin/sh\necho "$@" >> "${root}/gh.log"\n[ -e "${root}/ran" ] && echo executed-before-verify >> "${root}/gh.log"\nexit ${options.gh === "accepts" ? 0 : 1}\n`,
      { mode: 0o755 },
    );
  return async (env: Record<string, string> = {}, ...args: string[]) => {
    const child = Bun.spawn(["/bin/sh", script, ...args], {
      env: { HOME: root, PATH: tools, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  };
}
const ran = () => readFile(join(root, "ran"), "utf8").catch(() => null);

test.skipIf(!supported)(
  "without gh: HTTPS only, said plainly; the digest of the manifest is held",
  async () => {
    const run = await scene();
    const result = await run({}, "--service", "systemd-user", "--folder", "/F");
    // On a failure the script's own words say which step it was.
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({
      code: 0,
    });
    expect(result.stderr).toContain("NOT verified beyond HTTPS");
    // No `gh` was reachable, whatever this Machine has installed.
    expect(existsSync(join(root, "gh.log"))).toBe(false);
    expect(await ran()).toBe("install --service systemd-user --folder /F\n");
    const log = await readFile(join(root, "curl.log"), "utf8");
    // `latest` once, for the tag, and NOT followed; the two assets by exact
    // tag, followed into storage over HTTPS only. HTTPS on every request.
    const requests = log.split("\n").filter(Boolean);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toContain("/releases/latest/download/manifest.json");
    expect(requests[0]).toContain("--head");
    expect(requests[0]).not.toContain("--location");
    for (const line of requests.slice(1)) {
      expect(line).toContain("/releases/download/v1.1.0/");
      expect(line).toContain("--proto-redir =https");
      expect(line).toContain("--location");
    }
    for (const line of requests) expect(line).toContain("--proto =https");

    // A download that differs from the manifest is never executed.
    await rm(join(root, "ran"));
    await writeFile(join(root, `tree/v1.1.0/lazurio-${target}`), "#!/bin/sh\n");
    const tampered = await run();
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain("does not match the digest");
    expect(await ran()).toBeNull();
  },
);

test.skipIf(!supported)(
  "with gh: the attestation of manifest and executable is verified BEFORE anything runs",
  async () => {
    const run = await scene({ gh: "accepts" });
    const result = await run({ LAZURIO_VERSION: "v1.1.0" });
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({
      code: 0,
    });
    expect(result.stdout).toContain("Verified:");
    const calls = (await readFile(join(root, "gh.log"), "utf8"))
      .split("\n")
      .filter(Boolean);
    // Manifest and executable, both BEFORE the download was executed.
    expect(calls).toHaveLength(2);
    expect(calls.join("\n")).not.toContain("executed-before-verify");
    for (const call of calls)
      expect(call).toContain(
        "--repo Lazurio/LazurioPlatform --signer-workflow Lazurio/LazurioPlatform/.github/workflows/release.yml --source-ref refs/tags/v1.1.0",
      );
    // An exact version never asks `latest`.
    expect(await readFile(join(root, "curl.log"), "utf8")).not.toContain(
      "/latest/",
    );
    expect(await ran()).toBe("install\n");

    await rm(root, { recursive: true, force: true });
    const refusing = await scene({ gh: "refuses" });
    const refused = await refusing();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("nothing was executed");
    // The first refusal stops everything: one call, nothing run or installed.
    expect(
      (await readFile(join(root, "gh.log"), "utf8"))
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(1);
    expect(await ran()).toBeNull();
    expect(existsSync(join(root, ".local"))).toBe(false);
    expect(existsSync(join(root, "Library"))).toBe(false);
    expect((await refusing({ LAZURIO_VERSION: "latest" })).code).toBe(1);
  },
);

test.skipIf(!supported)(
  "the tag is read from the FIRST redirect of latest, which must be a release of this repository",
  async () => {
    const run = await scene();
    const origin = "https://github.com/Lazurio/LazurioPlatform";
    for (const [firstHop, said] of [
      // The final URL of the chain: signed storage, no repository, no tag.
      [
        "https://release-assets.githubusercontent.com/github-production-release-asset/1/0a1b?sig=fixture",
        "did not redirect to a release of Lazurio/LazurioPlatform",
      ],
      [
        "https://github.com/Other/Repository/releases/download/v1.1.0/manifest.json",
        "did not redirect to a release of Lazurio/LazurioPlatform",
      ],
      [
        `${origin}.evil.example/releases/download/v1.1.0/manifest.json`,
        "did not redirect to a release of Lazurio/LazurioPlatform",
      ],
      [`${origin}/releases/download/v1.1.0/other.json`, "did not redirect"],
      [
        `${origin}/releases/download/nightly/manifest.json`,
        "could not resolve a release tag",
      ],
      [
        `${origin}/releases/download/v1.1.0/x/manifest.json`,
        "could not resolve a release tag",
      ],
      [
        `${origin}/releases/download/v1.1/manifest.json`,
        "could not resolve a release tag",
      ],
      // No redirect at all.
      ["none", "did not redirect to a release of Lazurio/LazurioPlatform"],
    ] as const) {
      await writeFile(join(root, "first-hop"), firstHop);
      await rm(join(root, "curl.log"), { force: true });
      const result = await run();
      expect({ firstHop, code: result.code, stderr: result.stderr }).toEqual({
        firstHop,
        code: 1,
        stderr: expect.stringContaining(said),
      });
      // Refused after the one request for the tag: nothing downloaded or run.
      expect(
        (await readFile(join(root, "curl.log"), "utf8"))
          .split("\n")
          .filter(Boolean),
      ).toHaveLength(1);
      expect(await ran()).toBeNull();
    }
  },
);
