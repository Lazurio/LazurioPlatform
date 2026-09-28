import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureRelease } from "../scripts/update-fixture";
import {
  type AttestationVerifier,
  createAttestationVerifier,
  fixtureTrustedRoot,
} from "../src/update/attestation";
import { type CliContext, runInstallCommand } from "../src/update/cli";
import { UpdateFailure } from "../src/update/errors";
import { productOrigin } from "../src/update/identity";
import { performInstall } from "../src/update/install";
import { readSelector } from "../src/update/layout";
import {
  closeSharedSigstore,
  commitOf,
  executable,
  sharedSigstore,
  target,
} from "./fixtures/update-world";

// The downloaded way in (`install --verify-release`) runs the REAL
// sigstore-js verification against a fixture trust root: nothing reaches the
// network. HOME is a temporary directory; the person's real install base and
// ~/.local/bin are never read or written.
let root: string;
afterEach(async () => rm(root, { recursive: true, force: true }));
afterAll(closeSharedSigstore);

async function scene(
  options: Readonly<{
    /** Bytes released for this target; the running file is `executable`. */
    released?: Uint8Array;
    commit?: string;
    claims?: Parameters<typeof writeFixtureRelease>[2]["claims"];
  }> = {},
) {
  root = await realpath(await mkdtemp(join(tmpdir(), "upd-first-")));
  const home = join(root, "home");
  await mkdir(home);
  const tree = join(root, "tree");
  const running = executable("1.0.0");
  const sigstore = await sharedSigstore();
  await writeFixtureRelease(tree, sigstore, {
    version: "1.0.0",
    commit: options.commit ?? commitOf("1.0.0"),
    artifacts: { [target]: options.released ?? running },
    ...(options.claims ? { claims: options.claims } : {}),
  });
  const release = join(tree, "v1.0.0");
  const downloaded = join(release, `lazurio-${target}`);
  await writeFile(downloaded, running, { mode: 0o755 });
  const rootFile = join(root, "fixture-trusted-root.json");
  await writeFile(rootFile, sigstore.trustedRoot);
  const verify = createAttestationVerifier(
    productOrigin,
    fixtureTrustedRoot(rootFile),
  );
  const base = join(home, ".local/share/lazurio");
  const input = {
    base,
    executable: downloaded,
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: "linux",
    env: { HOME: home },
    release: { directory: release, verify },
  };
  // Nothing of an installation exists: no base, no ~/.local at all.
  const nothingBehind = async () => {
    expect(existsSync(base)).toBe(false);
    expect(await readdir(home)).toEqual([]);
  };
  return { home, base, release, downloaded, verify, input, nothingBehind };
}

const code = (result: Awaited<ReturnType<typeof performInstall>>) =>
  result.kind === "error" ? [result.code, result.context] : result.kind;

test("a downloaded executable that is the attested artifact of its release installs itself", async () => {
  const { input, base } = await scene();
  const asked: Parameters<AttestationVerifier>[0][] = [];
  expect(
    await performInstall({
      ...input,
      release: {
        ...input.release,
        verify: async (request) => {
          asked.push(request);
          await input.release.verify(request);
        },
      },
    }),
  ).toMatchObject({ kind: "installed", active: "1.0.0" });
  expect(await readSelector(base)).toBe("1.0.0");
  // The same check `lazurio update` runs: version, commit and the digests of
  // the manifest AND of the running executable among the attested subjects.
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({
    version: "1.0.0",
    sourceCommit: commitOf("1.0.0"),
  });
  expect(asked[0]?.subjectSha256).toEqual([
    new Bun.CryptoHasher("sha256")
      .update(await readFile(join(input.release.directory, "manifest.json")))
      .digest("hex"),
    new Bun.CryptoHasher("sha256")
      .update(await readFile(input.executable))
      .digest("hex"),
  ]);
});

test("every refusal of the downloaded way in happens before the first write and leaves nothing behind", async () => {
  // Another executable than the one the release attests.
  let world = await scene({
    released: executable("1.0.0", { healthy: false }),
  });
  expect(code(await performInstall(world.input))).toEqual([
    "release-invalid",
    { resource: "artifact", reason: "size" },
  ]);
  await world.nothingBehind();
  await rm(root, { recursive: true, force: true });

  // Same size, other bytes.
  const same = executable("1.0.0");
  const other = new Uint8Array(same);
  other[other.length - 2] = "x".charCodeAt(0);
  world = await scene({ released: other });
  expect(code(await performInstall(world.input))).toEqual([
    "release-invalid",
    { resource: "artifact", reason: "digest" },
  ]);
  await world.nothingBehind();
  await rm(root, { recursive: true, force: true });

  // Signed by another workflow: the attestation itself is refused.
  world = await scene({
    claims: {
      identity: `https://github.com/${productOrigin.repository}/.github/workflows/other.yml@refs/tags/v1.0.0`,
    },
  });
  expect(code(await performInstall(world.input))).toEqual([
    "attestation-invalid",
    { reason: "verification", detail: "UNTRUSTED_SIGNER_ERROR" },
  ]);
  await world.nothingBehind();
  await rm(root, { recursive: true, force: true });

  // A release of another commit than the one this executable was built from.
  world = await scene({ commit: "d".repeat(40) });
  expect(code(await performInstall(world.input))).toEqual([
    "release-invalid",
    { resource: "manifest", reason: "commit-mismatch" },
  ]);
  await world.nothingBehind();

  // The files of another version; a missing or oversized bundle; a manifest
  // that is not a file.
  expect(
    code(
      await performInstall({
        ...world.input,
        identity: { ...world.input.identity, version: "1.0.1" },
      }),
    ),
  ).toEqual([
    "release-invalid",
    { resource: "manifest", reason: "tag-mismatch" },
  ]);
  const bundle = join(world.release, "lazurio.sigstore.json");
  await rm(bundle);
  expect(code(await performInstall(world.input))).toEqual([
    "release-invalid",
    { resource: "bundle", reason: "file" },
  ]);
  await writeFile(bundle, new Uint8Array(1024 * 1024 + 1));
  expect(code(await performInstall(world.input))).toEqual([
    "release-invalid",
    { resource: "bundle", reason: "file" },
  ]);
  const manifest = join(world.release, "manifest.json");
  await rm(manifest);
  await symlink(join(root, "elsewhere.json"), manifest);
  expect(code(await performInstall(world.input))).toEqual([
    "release-invalid",
    { resource: "manifest", reason: "file" },
  ]);
  await world.nothingBehind();

  // Sigstore's trust root out of reach: refused, never weakened.
  await rm(root, { recursive: true, force: true });
  world = await scene();
  expect(
    code(
      await performInstall({
        ...world.input,
        release: {
          ...world.input.release,
          verify: async () => {
            throw new UpdateFailure("trust-unavailable");
          },
        },
      }),
    ),
  ).toEqual(["trust-unavailable", {}]);
  await world.nothingBehind();
});

test("the staged way in (the Machines role) needs no release files and no network", async () => {
  const { input, base } = await scene();
  const { release: _, ...staged } = input;
  expect(await performInstall(staged)).toMatchObject({
    kind: "installed",
    active: "1.0.0",
  });
  expect(await readSelector(base)).toBe("1.0.0");
});

const cliContext = (
  world: Awaited<ReturnType<typeof scene>>,
  env: Record<string, string> = {},
): CliContext => ({
  identity: world.input.identity,
  platform: "linux",
  env: { HOME: world.home, PATH: "/nonexistent", ...env },
  executable: world.downloaded,
  environment: { verify: world.verify },
});

test("the command surface: verified, installed and the first step; a refusal in words", async () => {
  const world = await scene();
  const entry = join(world.home, ".local/bin/lazurio");
  const bin = join(world.home, ".local/bin");
  const folder = join(world.home, "Lazurio");
  expect(
    await runInstallCommand(
      ["--verify-release", world.release],
      cliContext(world, { PATH: `${bin}:/nonexistent` }),
    ),
  ).toEqual({
    code: 0,
    stdout: [
      `Verified: this executable is lazurio 1.0.0 for ${target}, built and attested by the release workflow of Lazurio/LazurioPlatform at v1.0.0.`,
      "Lazurio 1.0.0 is installed.",
      `The command is ${entry}.`,
      `${bin} is on your PATH.`,
      "Next, create your Lazurio Folder and start the Launchpad:",
      `  lazurio folder-init --folder ${folder} --access local --purpose human --locale en --detail concise --coordination direct`,
      `  lazurio launchpad --folder ${folder}`,
      "The Folder's language and style are your choice: --locale cs, --detail technical and --coordination coordinator are the alternatives.",
    ].join("\n"),
  });
  // An initialized Folder: only the Launchpad. Something else there: left
  // alone, and folder-init is offered for a path that does not exist yet.
  await mkdir(join(folder, ".lazurio"), { recursive: true });
  const again = await runInstallCommand(
    ["--verify-release", world.release],
    cliContext(world, { PATH: bin }),
  );
  expect(again.stdout?.split("\n").slice(-2)).toEqual([
    "Next, start the Launchpad on your Lazurio Folder:",
    `  lazurio launchpad --folder ${folder}`,
  ]);
  await rm(join(folder, ".lazurio"), { recursive: true });
  expect(
    (
      await runInstallCommand(
        ["--verify-release", world.release],
        cliContext(world, { PATH: bin }),
      )
    ).stdout,
  ).toContain(
    `${folder} exists and is not a Lazurio Folder, so it is left alone.`,
  );
  // --service runs the Launchpad itself: no first step (refused here, no
  // systemd user manager, so only the usage shape is checked elsewhere).

  // A refused download says so in words, with the code first.
  await rm(world.base, { recursive: true });
  await rm(join(world.home, ".local"), { recursive: true });
  await writeFile(world.downloaded, executable("1.0.0", { healthy: false }));
  const refused = await runInstallCommand(
    ["--verify-release", world.release],
    cliContext(world),
  );
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(
    "Installation failed: release-invalid\nThe release files do not describe this executable (artifact: size). Nothing was installed.",
  );
  expect(existsSync(world.base)).toBe(false);
  const json = await runInstallCommand(
    ["--verify-release", world.release, "--json"],
    cliContext(world),
  );
  expect(JSON.parse(json.stdout ?? "")).toEqual({
    kind: "error",
    code: "release-invalid",
    context: { resource: "artifact", reason: "size" },
  });
  // The directory is absolute and canonical, as every path option.
  for (const directory of ["relative", `${world.release}/../v1.0.0`])
    expect(
      (
        await runInstallCommand(
          ["--verify-release", directory],
          cliContext(world),
        )
      ).code,
    ).toBe(2);
});

test("install prompt reads the installation, writes nothing and names every deviation", async () => {
  const world = await scene();
  const prompt = async (env: Record<string, string> = {}, ...args: string[]) =>
    runInstallCommand(["prompt", ...args], cliContext(world, env));

  // Nothing installed: said, and nothing is created by asking.
  const empty = JSON.parse((await prompt({}, "--json")).stdout ?? "");
  expect(empty).toMatchObject({
    kind: "install-prompt",
    locale: "en",
    standard: false,
    deviations: ["not-installed", "entry-missing", "directory-not-on-path"],
    facts: { platform: "linux", base: world.base, active: null },
  });
  await world.nothingBehind();

  // Installed, but ~/.local/bin is not on PATH and a legacy lazurio shadows.
  expect(
    (
      await runInstallCommand(
        ["--verify-release", world.release],
        cliContext(world),
      )
    ).code,
  ).toBe(0);
  const legacy = join(world.home, ".bun/bin");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "lazurio"), "#!/bin/sh\n", { mode: 0o755 });
  const shadowed = JSON.parse(
    (await prompt({ PATH: legacy }, "--json")).stdout ?? "",
  );
  expect(shadowed).toMatchObject({
    standard: false,
    deviations: ["directory-not-on-path", "shadowed"],
    facts: {
      active: "1.0.0",
      entry: { state: "present", shadowedBy: join(legacy, "lazurio") },
    },
  });
  const text = (await prompt({ PATH: legacy })).stdout ?? "";
  expect(text).toStartWith(
    "Task: straighten the Lazurio installation on this Machine to the standard.",
  );
  expect(text).toContain(
    `Another program named lazurio resolves first on PATH: ${join(legacy, "lazurio")}`,
  );
  expect(text).toContain("Only on the operator's explicit instruction");
  const czech = (await prompt({ PATH: legacy }, "--locale", "cs")).stdout;
  expect(czech).toStartWith("Úkol: srovnej instalaci Lazuria");

  // Standard: nothing deviates.
  const bin = join(world.home, ".local/bin");
  expect(
    JSON.parse(
      (await prompt({ PATH: `${bin}:${legacy}` }, "--json")).stdout ?? "",
    ),
  ).toMatchObject({ standard: true, deviations: [] });

  // A foreign file at the entry is named; asking changes nothing about it.
  await rm(join(bin, "lazurio"));
  await writeFile(join(bin, "lazurio"), "someone else's\n");
  expect(
    JSON.parse((await prompt({ PATH: bin }, "--json")).stdout ?? ""),
  ).toMatchObject({
    deviations: ["entry-foreign"],
    facts: { entry: { state: "conflict", occupant: { kind: "file" } } },
  });
  expect(await readFile(join(bin, "lazurio"), "utf8")).toBe("someone else's\n");

  for (const args of [
    ["prompt", "--locale", "de"],
    ["prompt", "extra"],
    ["prompt", "--verify-release", world.release],
    ["--locale", "cs"],
  ])
    expect((await runInstallCommand(args, cliContext(world))).code).toBe(2);
});
