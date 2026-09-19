import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionCommand } from "../src/update/cli";
import {
  developmentCommit,
  developmentVersion,
  embeddedIdentity,
  identityDefines,
  nativeTarget,
  parseIdentity,
} from "../src/update/identity";

test("a source run has the development identity, which sorts below every release", () => {
  expect(embeddedIdentity()).toEqual({
    version: developmentVersion,
    commit: developmentCommit,
    target: nativeTarget(process.platform, process.arch),
  });
  expect(versionCommand([]).stdout).toBe(
    `lazurio ${developmentVersion} (commit ${developmentCommit}, target ${nativeTarget(process.platform, process.arch)})`,
  );
  expect(versionCommand(["--unknown"]).code).toBe(2);
});

test("identity values are validated before they are embedded or reported", () => {
  const valid = {
    version: "1.2.3",
    commit: "a".repeat(40),
    target: "linux-x64",
  };
  expect(parseIdentity(valid)).toEqual(valid);
  for (const broken of [
    { ...valid, version: "1.2" },
    { ...valid, version: undefined },
    { ...valid, commit: "abc" },
    { ...valid, target: "linux x64" },
  ])
    expect(() => parseIdentity(broken)).toThrow();
  expect(identityDefines(valid)).toEqual([
    "--define",
    'LAZURIO_BUILD_VERSION="1.2.3"',
    "--define",
    `LAZURIO_BUILD_COMMIT="${"a".repeat(40)}"`,
    "--define",
    'LAZURIO_BUILD_TARGET="linux-x64"',
  ]);
});

// The real CLI entrypoint compiled with the same defines the candidate build
// passes (`identityDefines`), then asked as a standalone executable.
test.skipIf(process.platform === "win32")(
  "a compiled executable reports exactly the identity it was built with",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "update-identity-")),
    );
    try {
      const identity = {
        version: "3.1.4-rc.2",
        commit: "0123456789abcdef0123456789abcdef01234567",
        target: nativeTarget(process.platform, process.arch),
      };
      const binary = join(directory, "lazurio");
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          new URL("../src/cli.ts", import.meta.url).pathname,
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          ...identityDefines(identity),
          "--outfile",
          binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode).toBe(0);
      const run = (args: string[]) => {
        const child = Bun.spawnSync([binary, ...args], {
          cwd: directory,
          env: {},
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          code: child.exitCode,
          stdout: child.stdout.toString().trim(),
          stderr: child.stderr.toString().trim(),
        };
      };
      expect(run(["--version", "--json"])).toEqual({
        code: 0,
        stdout: JSON.stringify(identity),
        stderr: "",
      });
      expect(run(["--version"]).stdout).toBe(
        `lazurio 3.1.4-rc.2 (commit ${identity.commit}, target ${identity.target})`,
      );
      // The self-check an updater runs on a candidate reports the same
      // embedded identity, and an update without an installation is refused.
      expect(JSON.parse(run(["self-check", "--json"]).stdout)).toMatchObject({
        schemaVersion: 1,
        identity,
        folder: null,
      });
      expect(run(["update", "--base", join(directory, "base")])).toEqual({
        code: 34,
        stdout: "",
        stderr: "Update failed: not-installed",
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  },
  60_000,
);
