import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFixtureSigstore,
  type FixtureSigstore,
  writeFixtureRelease,
} from "../scripts/update-fixture";
import {
  identityDefines,
  nativeTarget,
  updateTargets,
} from "../src/update/identity";
import { renderManifest, sha256Hex } from "../src/update/manifest";

// install.sh with `curl` (and optionally `gh`) replaced on PATH: the origin is
// a directory, nothing touches the network, HOME and TMPDIR are temporary
// directories, and nothing is ever installed into the real home. The shell is
// `/bin/sh` unless LAZURIO_TEST_SHELL names another (`/bin/dash`, `bash
// --posix`), so the same tests prove the script is POSIX.
const shell = (process.env.LAZURIO_TEST_SHELL ?? "/bin/sh").split(" ");
const target = nativeTarget(process.platform, process.arch);
const supported = (updateTargets as readonly string[]).includes(target);
const script = new URL("../install.sh", import.meta.url).pathname;
const origin = "https://github.com/Lazurio/LazurioPlatform";
const systemTool = (tool: string) =>
  ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .map((directory) => join(directory, tool))
    .find((candidate) => existsSync(candidate));
const hasSha256sum = systemTool("sha256sum") !== undefined;
const hasShasum = systemTool("shasum") !== undefined;
let root: string;
afterEach(async () => rm(root, { recursive: true, force: true }));

type Options = Readonly<{
  downloader?: "curl" | "wget" | "none";
  digest?: "sha256sum" | "shasum" | "none";
  gh?: "accepts" | "refuses" | "signed-out";
  /** `uname -s` and `uname -m`; the real ones by default. */
  uname?: readonly [string, string];
  uid?: number;
  /** The released executable; by default a script that records its call. */
  executable?: Uint8Array;
  /** Write the release tree yourself (the compiled journey signs one). */
  release?: (tree: string) => Promise<void>;
}>;

async function scene(options: Options = {}) {
  root = await realpath(await mkdtemp(join(tmpdir(), "install-sh-")));
  const tree = join(root, "tree");
  const tools = join(root, "tools");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  for (const directory of [tree, tools, home, temporary])
    await mkdir(directory);
  // PATH is this private directory and NOTHING else: shims for exactly the
  // tools install.sh (and the fake downloaders) use. No system directory is
  // on it, so a `gh`, `curl` or `wget` the Machine happens to have — a hosted
  // CI runner has them all — is absent unless a test puts its own shim here.
  // Shims, not links: a wrapper such as macOS's `shasum` finds its real
  // program next to the path it was run by.
  const digest = options.digest ?? (hasSha256sum ? "sha256sum" : "shasum");
  for (const tool of [
    "cut",
    "mktemp",
    "rm",
    "awk",
    "grep",
    "chmod",
    "cp",
    "sed",
    ...(digest === "none" ? [] : [digest]),
    ...(options.uname ? [] : ["uname"]),
    ...(options.uid === undefined ? ["id"] : []),
  ]) {
    const found = systemTool(tool);
    if (!found) throw new Error(`Test prerequisite missing: ${tool}`);
    await writeFile(join(tools, tool), `#!/bin/sh\nexec ${found} "$@"\n`, {
      mode: 0o755,
    });
  }
  if (options.uname)
    await writeFile(
      join(tools, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo '${options.uname[0]}' ;; -m) echo '${options.uname[1]}' ;; esac\n`,
      { mode: 0o755 },
    );
  if (options.uid !== undefined)
    await writeFile(join(tools, "id"), `#!/bin/sh\necho ${options.uid}\n`, {
      mode: 0o755,
    });

  if (options.release) await options.release(tree);
  else {
    // The "executable" records how it was run and says something, as the
    // real one does; `refuse` makes it fail the way a refused release does.
    const executable =
      options.executable ??
      new TextEncoder().encode(
        `#!/bin/sh\necho "$@" > "${root}/ran"\nif [ -f "${root}/refuse" ]; then echo 'Installation failed: attestation-invalid' >&2; exit 1; fi\necho 'Lazurio 1.1.0 is installed.'\n`,
      );
    const release = join(tree, "v1.1.0");
    await mkdir(release);
    await writeFile(join(release, `lazurio-${target}`), executable);
    await writeFile(join(release, "lazurio.sigstore.json"), "{}");
    await writeFile(
      join(release, "manifest.json"),
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
  }

  // `curl` in GitHub's real multi-hop shape (verified read-only against a
  // public release): latest -> 302 to the exact-tag URL of the repository ->
  // 302 into signed asset storage on ANOTHER host, whose URL names no tag.
  // Not followed, a redirect has no body; `first-hop` overrides the first one.
  // With a `downgrade` file the storage hop is plain `http://` and serves the
  // `forged` tree; like the real curl, the shim refuses that hop when
  // `--proto-redir =https` was given (exit 1, curl 8's own words, observed
  // against a loopback TLS server that redirects to plain HTTP) and follows
  // it otherwise.
  const storage =
    "https://release-assets.githubusercontent.com/github-production-release-asset/1/0a1b?sig=fixture";
  if ((options.downloader ?? "curl") === "curl")
    await writeFile(
      join(tools, "curl"),
      `#!/bin/sh
echo "$@" >> "${root}/curl.log"
out=/dev/null; follow=; format=; redirects=
while [ $# -gt 1 ]; do
  case "$1" in
    --output) out=$2; shift ;;
    --write-out) format=$2; shift ;;
    --proto-redir) redirects=$2; shift ;;
    --location) follow=1 ;;
  esac
  shift
done
url=$1
redirect=; effective=$url; file=
case "$url" in
  ${origin}/releases/latest/download/*)
    redirect="${origin}/releases/download/v1.1.0/\${url##*/}"
    if [ -f "${root}/first-hop" ]; then IFS= read -r redirect < "${root}/first-hop" || true; fi
    [ "$redirect" = none ] && redirect=
    if [ -n "$follow" ] && [ -n "$redirect" ]; then effective=${storage}; redirect=; file="${tree}/v1.1.0/\${url##*/}"; fi ;;
  ${origin}/releases/download/*)
    if [ -n "$follow" ]; then effective=${storage}; file="${tree}/\${url#${origin}/releases/download/}"
    else redirect=${storage}; fi ;;
  *) exit 6 ;;
esac
if [ -n "$follow" ] && [ -n "$file" ] && [ -f "${root}/downgrade" ]; then
  if [ "$redirects" = =https ]; then echo 'curl: (1) Protocol "http" disabled (in redirect)' >&2; exit 1; fi
  effective=http://release-assets.githubusercontent.com/forged; file="${root}/forged/\${file##*/}"
fi
if [ -n "$file" ]; then [ -f "$file" ] || exit 22; cp "$file" "$out"; fi
case "$format" in
  *redirect_url*) printf '%s' "$redirect" ;;
  *url_effective*) printf '%s' "$effective" ;;
esac
`,
      { mode: 0o755 },
    );
  // A wget that would download anything: it must never be asked.
  if (options.downloader === "wget")
    await writeFile(
      join(tools, "wget"),
      `#!/bin/sh\necho "$@" >> "${root}/wget.log"\nexit 0\n`,
      { mode: 0o755 },
    );
  if (options.gh)
    await writeFile(
      join(tools, "gh"),
      // Records its arguments and whether the download had ALREADY been run.
      `#!/bin/sh
if [ "$1 $2" = "auth token" ]; then ${options.gh === "signed-out" ? "exit 1" : "echo token; exit 0"}; fi
echo "$@" >> "${root}/gh.log"
[ -e "${root}/ran" ] && echo executed-before-verify >> "${root}/gh.log"
exit ${options.gh === "accepts" ? 0 : 1}
`,
      { mode: 0o755 },
    );
  const run = async (env: Record<string, string> = {}, ...args: string[]) => {
    const child = Bun.spawn([...shell, script, ...args], {
      env: { HOME: home, PATH: tools, TMPDIR: temporary, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  };
  return { run, home, tools, temporary, tree };
}
const ran = () => readFile(join(root, "ran"), "utf8").catch(() => null);
const lines = async (name: string) =>
  (await readFile(join(root, name), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
const workDirectory = (call: string | null) =>
  call?.match(/--verify-release (\S+)/)?.[1];

test.skipIf(!supported)(
  "without gh: the digest is checked before anything runs, then the executable verifies its own release",
  async () => {
    const { run, temporary } = await scene();
    const result = await run({}, "--service", "systemd-user", "--folder", "/F");
    // On a failure the script's own words say which step it was.
    expect({ code: result.code, stderr: result.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(result.stdout).toBe(
      [
        `Installing Lazurio v1.1.0 for ${target}.`,
        `Checked: lazurio-${target} matches the SHA-256 in the manifest of v1.1.0.`,
        "The GitHub CLI (gh) is not installed, so there is no independent second check; lazurio verifies the release attestation itself next.",
        "Lazurio 1.1.0 is installed.",
        "",
      ].join("\n"),
    );
    // No `gh` was reachable, whatever this Machine has installed.
    expect(existsSync(join(root, "gh.log"))).toBe(false);
    // The executable is told where the release files are, and gets the
    // operator's arguments unchanged.
    const call = await ran();
    const work = workDirectory(call);
    expect(work).toStartWith(temporary);
    expect(call).toBe(
      `install --verify-release ${work} --service systemd-user --folder /F\n`,
    );
    // The private directory is gone afterwards.
    expect(await readdir(temporary)).toEqual([]);
    const requests = await lines("curl.log");
    // `latest` once, for the tag, and NOT followed; the three release files
    // by exact tag, followed into storage over HTTPS only.
    expect(requests).toHaveLength(4);
    expect(requests[0]).toContain("/releases/latest/download/manifest.json");
    expect(requests[0]).toContain("--head");
    expect(requests[0]).not.toContain("--location");
    expect(requests.slice(1).map((line) => line.split(" ").at(-1))).toEqual(
      ["manifest.json", `lazurio-${target}`, "lazurio.sigstore.json"].map(
        (asset) => `${origin}/releases/download/v1.1.0/${asset}`,
      ),
    );
    for (const line of requests.slice(1)) {
      expect(line).toContain("--proto-redir =https");
      expect(line).toContain("--location");
    }
    for (const line of requests) expect(line).toContain("--proto =https");
  },
  30_000,
);

test.skipIf(!supported)(
  "a download that differs from its manifest is never executed; a refusing executable fails the script",
  async () => {
    const { run, tree, temporary } = await scene();
    await writeFile(join(tree, `v1.1.0/lazurio-${target}`), "#!/bin/sh\n");
    const tampered = await run();
    expect(tampered).toEqual({
      code: 1,
      stdout: `Installing Lazurio v1.1.0 for ${target}.\n`,
      stderr: `install.sh: the downloaded lazurio-${target} does not match the SHA-256 in the manifest of v1.1.0, so it was not run; nothing was installed.\n`,
    });
    expect(await ran()).toBeNull();
    expect(await readdir(temporary)).toEqual([]);

    await rm(root, { recursive: true, force: true });
    const refusing = await scene();
    await writeFile(join(root, "refuse"), "");
    const refused = await refusing.run();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      "Installation failed: attestation-invalid\ninstall.sh: lazurio did not install itself; the reason is above.\n",
    );
    expect(await readdir(refusing.temporary)).toEqual([]);
  },
);

test.skipIf(!supported)(
  "with a signed-in gh: the attestation of manifest and executable is verified independently BEFORE anything runs",
  async () => {
    const { run } = await scene({ gh: "accepts" });
    const result = await run({ LAZURIO_VERSION: "v1.1.0" });
    expect({ code: result.code, stderr: result.stderr }).toEqual({
      code: 0,
      stderr: "",
    });
    expect(result.stdout).toContain(
      "Checked by the GitHub CLI: attested by the release workflow of Lazurio/LazurioPlatform at v1.1.0.",
    );
    const calls = await lines("gh.log");
    // Manifest and executable, both BEFORE the download was executed.
    expect(calls).toHaveLength(2);
    expect(calls.join("\n")).not.toContain("executed-before-verify");
    for (const call of calls)
      expect(call).toContain(
        "--repo Lazurio/LazurioPlatform --signer-workflow Lazurio/LazurioPlatform/.github/workflows/release.yml --source-ref refs/tags/v1.1.0",
      );
    // An exact version never asks `latest`.
    expect((await lines("curl.log")).join("\n")).not.toContain("/latest/");
    expect(await ran()).toStartWith("install --verify-release ");

    await rm(root, { recursive: true, force: true });
    const refusing = await scene({ gh: "refuses" });
    const refused = await refusing.run();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      "install.sh: gh attestation verify refused manifest.json of v1.1.0, so nothing was run; nothing was installed.\n",
    );
    // The first refusal stops everything: one call, nothing run or installed.
    expect(await lines("gh.log")).toHaveLength(1);
    expect(await ran()).toBeNull();
    expect(await readdir(refusing.home)).toEqual([]);
    expect((await refusing.run({ LAZURIO_VERSION: "latest" })).code).toBe(1);

    // gh present but signed out: no second check, said so, and it installs.
    await rm(root, { recursive: true, force: true });
    const signedOut = await scene({ gh: "signed-out" });
    const unsigned = await signedOut.run();
    expect(unsigned.code).toBe(0);
    expect(unsigned.stdout).toContain(
      "The GitHub CLI (gh) is not signed in, so there is no independent second check; lazurio verifies the release attestation itself next.",
    );
    expect(await lines("gh.log")).toEqual([]);
  },
  30_000,
);

test.skipIf(!supported)(
  "the tag is read from the FIRST redirect of latest, which must be a release of this repository",
  async () => {
    const { run } = await scene();
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
      // A plaintext hop is not a release of this repository either.
      [
        "http://github.com/Lazurio/LazurioPlatform/releases/download/v1.1.0/manifest.json",
        "did not redirect to a release of Lazurio/LazurioPlatform",
      ],
      [
        `${origin}/releases/download/nightly/manifest.json`,
        "could not find out which release is the latest one",
      ],
      [
        `${origin}/releases/download/v1.1.0/x/manifest.json`,
        "could not find out which release is the latest one",
      ],
      [
        `${origin}/releases/download/v1.1/manifest.json`,
        "could not find out which release is the latest one",
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
      expect(await lines("curl.log")).toHaveLength(1);
      expect(await ran()).toBeNull();
    }
  },
);

test.skipIf(!supported || !hasShasum)("shasum alone is enough", async () => {
  const { run } = await scene({ digest: "shasum" });
  const result = await run();
  expect({ code: result.code, stderr: result.stderr }).toEqual({
    code: 0,
    stderr: "",
  });
  expect(await ran()).toStartWith("install --verify-release ");
});

test.skipIf(!supported)(
  "a redirect that leaves HTTPS stops the script before anything runs, and nothing is installed",
  async () => {
    const { run, home, temporary } = await scene();
    // A plaintext hop could supply a forged manifest AND a matching
    // executable: the digest comparison alone would pass them.
    const forged = new TextEncoder().encode(
      `#!/bin/sh\necho forged > "${root}/forged-ran"\n`,
    );
    await mkdir(join(root, "forged"));
    await writeFile(join(root, "forged", `lazurio-${target}`), forged);
    await writeFile(join(root, "forged", "lazurio.sigstore.json"), "{}");
    await writeFile(
      join(root, "forged", "manifest.json"),
      renderManifest({
        version: "1.1.0",
        sourceCommit: "b".repeat(40),
        minimumUpdaterVersion: "1.0.0",
        repository: "Lazurio/LazurioPlatform",
        targets: {
          [target]: { sha256: sha256Hex(forged), size: forged.byteLength },
        },
      }),
    );
    await writeFile(join(root, "downgrade"), "");
    // The shim is a faithful witness: asked WITHOUT `--proto-redir =https`
    // it follows the plaintext hop and hands out the forged manifest.
    const lax = Bun.spawnSync(
      [
        join(root, "tools/curl"),
        "--location",
        "--output",
        join(root, "lax.json"),
        `${origin}/releases/download/v1.1.0/manifest.json`,
      ],
      { env: { PATH: join(root, "tools") } },
    );
    expect(lax.exitCode).toBe(0);
    expect(await readFile(join(root, "lax.json"), "utf8")).toContain(
      "b".repeat(40),
    );
    await rm(join(root, "lax.json"));
    await rm(join(root, "curl.log"));

    const result = await run();
    expect(result).toEqual({
      code: 1,
      stdout: `Installing Lazurio v1.1.0 for ${target}.\n`,
      stderr: [
        'curl: (1) Protocol "http" disabled (in redirect)',
        "install.sh: could not download manifest.json of v1.1.0 from GitHub; nothing was installed.",
        "",
      ].join("\n"),
    });
    // Every download insisted on HTTPS for every hop; the first one failed.
    const requests = await lines("curl.log");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("--proto =https --proto-redir =https");
    // Nothing was executed, nothing installed, nothing left behind.
    expect(await ran()).toBeNull();
    expect(existsSync(join(root, "forged-ran"))).toBe(false);
    expect(await readdir(home)).toEqual([]);
    expect(await readdir(temporary)).toEqual([]);
  },
);

test.skipIf(!supported)(
  "wget alone is refused before any request: it cannot be held to HTTPS on every redirect",
  async () => {
    const { run, home } = await scene({
      downloader: "wget",
      uname: ["Linux", "x86_64"],
    });
    expect(await run()).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "install.sh: Lazurio needs curl to download itself over HTTPS, and curl is not installed. Install it with your system's package manager (for example: sudo apt install curl on Ubuntu or Debian, sudo dnf install curl on Fedora), then run this again.\n",
    });
    expect(existsSync(join(root, "wget.log"))).toBe(false);
    expect(await readdir(home)).toEqual([]);
  },
);

test.skipIf(!supported || !hasSha256sum)(
  "sha256sum alone is enough",
  async () => {
    const { run } = await scene({ digest: "sha256sum" });
    expect((await run()).code).toBe(0);
    expect(await ran()).toStartWith("install --verify-release ");
  },
);

test("an unsupported platform, root, and missing tools are refused in one plain sentence before any download", async () => {
  for (const [uname, platform] of [
    [["Darwin", "x86_64"], "Darwin x86_64"],
    [["MINGW64_NT-10.0-22631", "x86_64"], "MINGW64_NT-10.0-22631 x86_64"],
    [["FreeBSD", "amd64"], "FreeBSD amd64"],
    [["Linux", "armv7l"], "Linux armv7l"],
  ] as const) {
    const { run } = await scene({ uname });
    expect(await run()).toEqual({
      code: 1,
      stdout: "",
      stderr: `install.sh: Lazurio supports Linux on x64 and arm64, and macOS on Apple silicon (arm64). This computer is ${platform}. Windows and Intel Macs are not supported yet; nothing was installed.\n`,
    });
    expect(existsSync(join(root, "curl.log"))).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
  const linux = ["Linux", "x86_64"] as const;
  for (const [options, said] of [
    [
      { uname: linux, uid: 0 },
      "Lazurio installs for one user and never needs sudo. Run this again as the user who will use Lazurio, without sudo.",
    ],
    [
      { uname: linux, downloader: "none" },
      "Lazurio needs curl to download itself over HTTPS, and curl is not installed. Install it with your system's package manager (for example: sudo apt install curl on Ubuntu or Debian, sudo dnf install curl on Fedora), then run this again.",
    ],
    [
      { uname: linux, digest: "none" },
      "Lazurio needs sha256sum or shasum to check the download, and neither is installed. Install one of them and run this again.",
    ],
  ] as const) {
    const { run } = await scene(options);
    expect(await run()).toEqual({
      code: 1,
      stdout: "",
      stderr: `install.sh: ${said}\n`,
    });
    expect(existsSync(join(root, "curl.log"))).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
});

// The whole journey with the REAL compiled executable: install.sh downloads a
// release signed by a throwaway Sigstore, the executable verifies it against
// that fixture trust root (the FIXTURE define; a release build has none) and
// installs itself into the temporary HOME. No gh anywhere.
let sigstore: FixtureSigstore | undefined;
afterAll(async () => sigstore?.close());

test.skipIf(!supported)(
  "the compiled executable verifies its release without gh, reports conflicts and refuses a release it cannot verify, leaving nothing behind",
  async () => {
    sigstore ??= await createFixtureSigstore();
    const signer = sigstore;
    const build = await realpath(
      await mkdtemp(join(tmpdir(), "install-sh-build-")),
    );
    try {
      const trustedRoot = join(build, "FIXTURE-trusted-root.json");
      await writeFile(trustedRoot, signer.trustedRoot);
      const commit = "0123456789abcdef0123456789abcdef01234567";
      const outfile = join(build, "lazurio");
      const compiled = Bun.spawnSync(
        [
          process.execPath,
          "build",
          new URL("../src/cli.ts", import.meta.url).pathname,
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          ...identityDefines(
            { version: "1.1.0", commit, target },
            { baseUrl: "http://127.0.0.1:9", trustedRoot },
          ),
          "--outfile",
          outfile,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(compiled.exitCode).toBe(0);
      const bytes = new Uint8Array(await readFile(outfile));
      // A verifiable release; ~/.local/bin/lazurio occupied by someone else
      // and another lazurio first on PATH.
      const good = await scene({
        release: (tree) =>
          writeFixtureRelease(tree, signer, {
            version: "1.1.0",
            commit,
            artifacts: { [target]: bytes },
          }),
      });
      await mkdir(join(good.home, ".local/bin"), { recursive: true });
      await writeFile(
        join(good.home, ".local/bin/lazurio"),
        "someone else's\n",
      );
      await writeFile(join(good.tools, "lazurio"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      const installed = await good.run();
      expect({ code: installed.code, stderr: installed.stderr }).toEqual({
        code: 0,
        stderr: "",
      });
      const out = installed.stdout;
      expect(out).toContain(
        "The GitHub CLI (gh) is not installed, so there is no independent second check",
      );
      expect(out).toContain(
        `Verified: this executable is lazurio 1.1.0 for ${target}, built and attested by the release workflow of Lazurio/LazurioPlatform at v1.1.0.`,
      );
      expect(out).toContain("Lazurio 1.1.0 is installed.");
      // The conflict and the shadowing, in words, and the way to straighten.
      expect(out).toContain(
        `${join(good.home, ".local/bin/lazurio")} is a regular file that is not Lazurio's; it was left unchanged.`,
      );
      expect(out).toContain(
        `Another program named lazurio resolves first on PATH: ${join(good.tools, "lazurio")}.`,
      );
      expect(out).toContain(
        "This installation is not yet the standard one. To have an agent straighten it, give it the prompt that",
      );
      expect(out).toContain(
        "install prompt` prints (add --locale cs for Czech).",
      );
      expect(out).toContain(
        "Next, create your Lazurio Folder and start the Launchpad:",
      );
      expect(
        await readFile(join(good.home, ".local/bin/lazurio"), "utf8"),
      ).toBe("someone else's\n");
      // The trust-root cache and the downloads are gone.
      expect(await readdir(good.temporary)).toEqual([]);
      await rm(root, { recursive: true, force: true });

      // Signed by another workflow: the executable refuses before writing.
      const bad = await scene({
        release: (tree) =>
          writeFixtureRelease(tree, signer, {
            version: "1.1.0",
            commit,
            artifacts: { [target]: bytes },
            claims: {
              identity:
                "https://github.com/Lazurio/LazurioPlatform/.github/workflows/other.yml@refs/tags/v1.1.0",
            },
          }),
      });
      const refused = await bad.run();
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(
        [
          "Installation failed: attestation-invalid",
          "The release attestation does not vouch for this executable: it is not what the release workflow of Lazurio/LazurioPlatform built for this version. Nothing was installed.",
          "install.sh: lazurio did not install itself; the reason is above.",
          "",
        ].join("\n"),
      );
      expect(await readdir(bad.home)).toEqual([]);
      expect(await readdir(bad.temporary)).toEqual([]);
    } finally {
      await rm(build, { recursive: true, force: true });
    }
  },
  180_000,
);
