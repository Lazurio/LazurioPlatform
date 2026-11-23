import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  organizationFilesDirectory,
  organizationFilesPlace,
  provideOrganizationFiles,
} from "../src/modules/organization-files";

const posix = test.skipIf(process.platform === "win32");

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** A root checkout with its GitHub remote and one commit of the manifests. */
async function root(parent: string, name: string, manifest: string) {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "modules.manifest.json"), manifest);
  await writeFile(join(directory, "lazurio.organization.json"), "{}\n");
  git(directory, "init", "-q", "-b", "main");
  git(directory, "config", "user.email", "fixture@example.test");
  git(directory, "config", "user.name", "fixture");
  git(directory, "remote", "add", "origin", `git@github.com:acme/${name}.git`);
  git(directory, "add", ".");
  git(directory, "commit", "-q", "-m", "root");
  return directory;
}

const place = (home: string, organizationRoot: string, appPackage: string) =>
  organizationFilesPlace({
    home,
    company: "acme",
    appId: "notes",
    organizationRoot,
    moduleDirectory: join(organizationRoot, "workspace/notes"),
    appPackage,
  });

posix(
  "two Apps with the same id, in two checkouts or two packages, each keep their own copy (H20)",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "orgfiles-")));
    const home = join(parent, "home");
    const one = await root(parent, "one", '{"one":true}\n');
    const two = await root(parent, "two", '{"two":true}\n');
    const places = [
      place(home, one, "app/v1/package.json"),
      place(home, two, "app/v1/package.json"),
      place(home, one, "app/v2/package.json"),
    ];
    expect(new Set(places).size).toBe(3);
    await provideOrganizationFiles({
      organizationRoot: one,
      place: places[0] as string,
      files: ["modules.manifest.json"],
    });
    await provideOrganizationFiles({
      organizationRoot: two,
      place: places[1] as string,
      files: ["modules.manifest.json", "lazurio.organization.json"],
    });
    const read = (at: string, file: string) =>
      readFile(join(organizationFilesDirectory(at), file), "utf8");
    expect(await read(places[0] as string, "modules.manifest.json")).toBe(
      '{"one":true}\n',
    );
    expect(await read(places[1] as string, "modules.manifest.json")).toBe(
      '{"two":true}\n',
    );
    expect(
      JSON.parse(await read(places[0] as string, "revision.json")).repository,
    ).toBe("acme/one");
    expect(
      (await readdir(organizationFilesDirectory(places[0] as string))).sort(),
    ).toEqual(["modules.manifest.json", "revision.json"]);
  },
);

posix(
  "the copy is read-only: writing, replacing or deleting its files is refused",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "orgfiles-")));
    const organization = await root(parent, "root", "{}\n");
    const at = place(join(parent, "home"), organization, "app/package.json");
    const copy = await provideOrganizationFiles({
      organizationRoot: organization,
      place: at,
      files: ["modules.manifest.json"],
    });
    const file = join(copy, "modules.manifest.json");
    await expect(writeFile(file, "changed")).rejects.toThrow();
    await expect(unlink(file)).rejects.toThrow();
    await expect(writeFile(join(copy, "other.json"), "{}")).rejects.toThrow();
    await expect(
      rename(join(copy, "revision.json"), join(copy, "moved.json")),
    ).rejects.toThrow();
    await expect(unlink(copy)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{}\n");
  },
);

posix(
  "the path always resolves to a whole copy while copies are replaced, and a failure before the switch keeps the previous one",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "orgfiles-")));
    const organization = await root(parent, "root", '{"n":0}\n');
    const at = place(join(parent, "home"), organization, "app/package.json");
    const copy = await provideOrganizationFiles({
      organizationRoot: organization,
      place: at,
      files: ["modules.manifest.json"],
    });
    let reading = true;
    let reads = 0;
    // On macOS an open through `current` at the moment the link is replaced
    // can fail with EINVAL (seen on CI, #1211); that open is tried again. It
    // is no partial copy: a missing file, any other error or a copy that does
    // not parse still fails the test, and Linux stays strict.
    const open = async (file: string) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await readFile(join(copy, file), "utf8");
        } catch (error) {
          if (
            process.platform !== "darwin" ||
            (error as NodeJS.ErrnoException).code !== "EINVAL" ||
            attempt >= 20
          )
            throw error;
        }
      }
    };
    const reader = (async () => {
      while (reading) {
        JSON.parse(await open("revision.json"));
        await open("modules.manifest.json");
        reads++;
        await Bun.sleep(0);
      }
    })();
    for (let n = 1; n <= 20; n++) {
      await writeFile(
        join(organization, "modules.manifest.json"),
        `{"n":${n}}\n`,
      );
      git(organization, "commit", "-q", "-am", `n${n}`);
      await provideOrganizationFiles({
        organizationRoot: organization,
        place: at,
        files: ["modules.manifest.json"],
      });
    }
    reading = false;
    await reader;
    expect(reads).toBeGreaterThan(0);
    expect(await readFile(join(copy, "modules.manifest.json"), "utf8")).toBe(
      '{"n":20}\n',
    );
    // A failure after the new version is written, before the switch.
    await writeFile(join(organization, "modules.manifest.json"), '{"n":21}\n');
    git(organization, "commit", "-q", "-am", "n21");
    await expect(
      provideOrganizationFiles({
        organizationRoot: organization,
        place: at,
        files: ["modules.manifest.json"],
        beforeSwitch: async () => {
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    expect(await readFile(join(copy, "modules.manifest.json"), "utf8")).toBe(
      '{"n":20}\n',
    );
    // The next copy completes and leaves only it and the one before.
    await provideOrganizationFiles({
      organizationRoot: organization,
      place: at,
      files: ["modules.manifest.json"],
    });
    expect(await readFile(join(copy, "modules.manifest.json"), "utf8")).toBe(
      '{"n":21}\n',
    );
    expect((await readdir(at)).filter((e) => e.startsWith("v-")).length).toBe(
      2,
    );
  },
  30_000,
);

posix(
  "a root that is not itself a Git checkout with a GitHub remote gets an empty copy without revision.json, also inside another checkout (H20)",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "orgfiles-")));
    const home = join(parent, "home");
    const plain = join(parent, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "modules.manifest.json"), "{}\n");
    // A directory inside another checkout: Git would find the parent's.
    const outer = await root(parent, "outer", "{}\n");
    const nested = join(outer, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "modules.manifest.json"), "{}\n");
    for (const organization of [plain, nested]) {
      const copy = await provideOrganizationFiles({
        organizationRoot: organization,
        place: place(home, organization, "app/package.json"),
        files: ["modules.manifest.json"],
      });
      expect(await readdir(copy)).toEqual([]);
    }
    Bun.spawnSync(["chmod", "-R", "u+w", parent]);
    await rm(parent, { recursive: true, force: true });
  },
);

test("only the canonical manifests can be copied", async () => {
  await expect(
    provideOrganizationFiles({
      organizationRoot: "/nonexistent",
      place: join(tmpdir(), "never"),
      files: [".env"],
    }),
  ).rejects.toThrow("Undeclarable organization file");
});
