import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineFailureAnswer } from "../src/machine/cli";
import { MachineContextError } from "../src/machine/context";
import {
  type RunningProduct,
  requireInstalledProduct,
  runningProduct,
  trustedInstallBase,
} from "../src/machine/installed-product";
import { resolveInstallBase } from "../src/update/base";
import { developmentCommit, developmentVersion } from "../src/update/identity";
import { versionExecutable } from "../src/update/layout";

// Decision F68 (#782): only the installed product acts on the declared
// operator's Folder and home. A test in process, a source run and a pull
// request's own build, wherever it lies, are refused.
const built = {
  version: "1.2.3",
  commit: "a".repeat(40),
  target: "linux-x64",
} as const;

const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => "accepted",
    (error: unknown) =>
      error instanceof MachineContextError ? error.code : String(error),
  );

async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "installed-")));
  const home = join(root, "home");
  const installed = versionExecutable(trustedInstallBase(home), built.version);
  await mkdir(join(installed, ".."), { recursive: true });
  await writeFile(installed, "#!/bin/sh\n");
  await chmod(installed, 0o700);
  return { root, home, installed };
}

test.skipIf(process.platform === "win32")(
  "only a built, non-fixture product running from the operator's trusted base passes",
  async () => {
    const { root, home, installed } = await world();
    try {
      expect(trustedInstallBase(home)).toBe(
        join(home, ".local", "share", "lazurio"),
      );
      const running = (over: Partial<RunningProduct> = {}): RunningProduct => ({
        identity: built,
        fixture: false,
        executable: installed,
        ...over,
      });
      expect(await refused(requireInstalledProduct(running(), home))).toBe(
        "accepted",
      );
      // Reached through the selector's link: the resolved file is the same.
      const link = join(root, "bin-lazurio");
      await symlink(installed, link);
      expect(
        await refused(
          requireInstalledProduct(
            running({ executable: await realpath(link) }),
            home,
          ),
        ),
      ).toBe("accepted");
      for (const [name, over] of [
        [
          "a source run",
          {
            identity: {
              ...built,
              version: developmentVersion,
              commit: developmentCommit,
            },
          },
        ],
        ["a fixture build", { fixture: true }],
        [
          "a build elsewhere",
          { executable: join(root, "elsewhere", "lazurio") },
        ],
        [
          "another version's file",
          { identity: { ...built, version: "1.2.4" } },
        ],
      ] as const)
        expect([
          name,
          await refused(requireInstalledProduct(running(over), home)),
        ]).toEqual([name, "machine-not-installed-product"]);
      // Another operator's home is another trusted base.
      expect(
        await refused(requireInstalledProduct(running(), join(root, "other"))),
      ).toBe("machine-not-installed-product");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "XDG_DATA_HOME moves nothing: a base of the caller's own is not trusted",
  async () => {
    const { root, home } = await world();
    try {
      // The update's own resolution follows XDG_DATA_HOME; the guard does not.
      const xdg = join(root, "xdg");
      const own = resolveInstallBase({
        platform: "linux",
        env: { XDG_DATA_HOME: xdg },
        homedir: home,
      }) as string;
      expect(own).toBe(join(xdg, "lazurio"));
      const planted = versionExecutable(own, built.version);
      await mkdir(join(planted, ".."), { recursive: true });
      await writeFile(planted, "#!/bin/sh\n");
      const previous = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = xdg;
      try {
        expect(
          await refused(
            requireInstalledProduct(
              { identity: built, fixture: false, executable: planted },
              home,
            ),
          ),
        ).toBe("machine-not-installed-product");
      } finally {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("this test process is not the installed product, so it is refused", async () => {
  const running = await runningProduct();
  expect(running.identity.version).toBe(developmentVersion);
  expect(
    await refused(requireInstalledProduct(running, "/nonexistent-home")),
  ).toBe("machine-not-installed-product");
  // The answer Lazurio Machines and a person read says why and what to do.
  expect(
    machineFailureAnswer(
      new MachineContextError("machine-not-installed-product"),
    ),
  ).toMatchObject({
    code: 2,
    result: { kind: "blocked", reason: "machine-not-installed-product" },
  });
});
