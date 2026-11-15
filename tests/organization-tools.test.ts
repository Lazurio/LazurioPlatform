import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { operatorGit } from "../src/organization-settings/local";
import { declaredOrganizationTools } from "../src/organization-settings/tools";
import {
  type OrganizationTool,
  organizationToolIds,
} from "../src/organizations/organization-settings";
import {
  compareVersions,
  organizationToolRecipes,
  organizationToolsState,
  provisionOrganizationTools,
} from "../src/tools/organization-tools";
import { toolsEnvironmentOf } from "../src/tools/overview";
import { runTool, type ToolRunner } from "../src/tools/status";
import {
  everythingText,
  type UpdateParts,
  updateEverything,
} from "../src/update/everything";
import { writeOrganization } from "./fixtures/catalog-folder";
import { bindings } from "./fixtures/machine-bindings";
import { writeOwnedFixture } from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

// Decision F73: the tools an Organization declares in `settings.tools` are
// made available in its work Environments by `lazurio update`, by their
// official path and without asking. Here without a vendor: the official
// installers are replaced by a fake that writes what they would (a program
// in the installer's home that reports a version), every other command runs
// for real, in a temporary home. The live installation of cargo and pnpm in
// a temporary home is recorded in decision F73's verification.

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0))
    await rm(parent, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "organization-tools-")),
  );
  parents.push(parent);
  return parent;
}

/** A program that prints `line` for `--version`, and records any other
 * argv in `<directory>/calls`. */
async function program(directory: string, name: string, line: string) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, name);
  await writeFile(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${line}'; exit 0; fi\necho "${name} $*" >> '${join(directory, "calls")}'\n`,
  );
  await chmod(file, 0o755);
  return file;
}

/** The runner of a test: the official installer of a recipe is replaced
 * by `install` (it gets the environment the installer would), everything
 * else runs for real. */
function runner(
  install: (env: Readonly<Record<string, string>>) => Promise<number>,
  calls: string[],
): ToolRunner {
  const installers = new Set(
    Object.values(organizationToolRecipes).map((recipe) => recipe.installer),
  );
  return async (command, timeout, env, options) => {
    if (command[0] === "/bin/sh" && installers.has(command[2] ?? "")) {
      calls.push(
        `installer ${command[2]?.includes("rustup") ? "cargo" : "pnpm"}`,
      );
      const exitCode = await install(env);
      return {
        exitCode,
        stdout: "",
        stderr: exitCode === 0 ? "" : "curl: (6) Could not resolve host",
      };
    }
    if (command[1] !== "--version") calls.push(command.join(" "));
    return runTool(command, timeout, env, options);
  };
}

const cargo = (minimum: string): OrganizationTool => ({
  tool: "cargo",
  minimum,
});
const pnpm = (minimum: string): OrganizationTool => ({ tool: "pnpm", minimum });
const windows = process.platform === "win32";

test("versions compare by number, a suffix aside", () => {
  expect(compareVersions("1.100.0", "1.89.0")).toBeGreaterThan(0);
  expect(compareVersions("1.89.0", "1.89.0")).toBe(0);
  expect(compareVersions("11.0.0-rc.1", "11.0.0")).toBe(0);
  expect(compareVersions("10.33.0", "11.0.0")).toBeLessThan(0);
});

test("every tool the reader accepts has exactly one recipe, and no recipe edits a shell profile", () => {
  expect(Object.keys(organizationToolRecipes).sort()).toEqual(
    [...organizationToolIds].sort(),
  );
  expect(organizationToolRecipes.cargo.installer).toContain("--no-modify-path");
  expect(organizationToolRecipes.cargo.installer).toContain(
    "https://sh.rustup.rs",
  );
  expect(organizationToolRecipes.pnpm.installer).toContain(
    "https://get.pnpm.io/install.sh",
  );
  expect(organizationToolRecipes.pnpm.installerEnv).toEqual({
    PNPM_NO_MODIFY_PATH: "1",
  });
  // Fetched to a private file before it runs, never piped into a shell.
  for (const recipe of Object.values(organizationToolRecipes))
    expect(recipe.installer).not.toContain("| sh");
});

test.skipIf(windows)(
  "a tool at its minimum is left exactly as it is, wherever it was installed",
  async () => {
    const user = await home();
    const system = join(user, "system-bin");
    await program(system, "cargo", "cargo 1.90.0 (abc 2026-01-01)");
    const calls: string[] = [];
    const items = await provisionOrganizationTools({
      tools: [cargo("1.89.0")],
      path: system,
      home: user,
      platform: process.platform,
      run: runner(async () => 0, calls),
    });
    expect(items).toEqual([
      {
        tool: "cargo",
        minimum: "1.89.0",
        result: "current",
        version: "1.90.0",
      },
    ]);
    expect(calls).toEqual([]);
  },
);

test.skipIf(windows)(
  "a missing tool: its official installer runs with the recipe's environment, and its programs are linked into ~/.local/bin, never over what is there",
  async () => {
    const user = await home();
    const entry = join(user, ".local", "bin");
    await mkdir(entry, { recursive: true });
    // Someone's own `pnpx` already there: it stays.
    await writeFile(join(entry, "pnpx"), "#!/bin/sh\necho mine\n");
    const pnpmHome = join(user, ".local", "share", "pnpm", "bin");
    const calls: string[] = [];
    let installerEnv: Readonly<Record<string, string>> = {};
    const items = await provisionOrganizationTools({
      tools: [pnpm("11.0.0")],
      path: "/usr/bin:/bin",
      home: user,
      platform: process.platform,
      run: runner(async (env) => {
        installerEnv = env;
        await program(pnpmHome, "pnpm", "12.21.0");
        await program(pnpmHome, "pnpx", "12.21.0");
        return 0;
      }, calls),
    });
    expect(items).toEqual([
      {
        tool: "pnpm",
        minimum: "11.0.0",
        result: "installed",
        version: "12.21.0",
        onPath: false,
      },
    ]);
    expect(calls).toEqual(["installer pnpm"]);
    expect(installerEnv.PNPM_NO_MODIFY_PATH).toBe("1");
    expect(installerEnv.HOME).toBe(user);
    expect(await readlink(join(entry, "pnpm"))).toBe(join(pnpmHome, "pnpm"));
    expect((await lstat(join(entry, "pnpx"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(entry, "pnpx"), "utf8")).toContain("mine");
    // No shell profile appeared.
    await expect(lstat(join(user, ".profile"))).rejects.toThrow();
    await expect(lstat(join(user, ".bashrc"))).rejects.toThrow();
  },
);

test.skipIf(windows)(
  "below the minimum: the official installer's own installation is raised by the tool's own update",
  async () => {
    const user = await home();
    const bin = join(user, ".cargo", "bin");
    await program(bin, "cargo", "cargo 1.80.0 (old 2025-01-01)");
    await program(bin, "rustup", "rustup 1.28.0");
    const entry = join(user, ".local", "bin");
    const calls: string[] = [];
    const run = runner(async () => 0, calls);
    const items = await provisionOrganizationTools({
      tools: [cargo("1.89.0")],
      path: bin,
      home: user,
      platform: process.platform,
      run: async (command, timeout, env, options) => {
        const answer = await run(command, timeout, env, options);
        // `rustup default stable` makes the newer toolchain cargo's.
        if (command.at(-2) === "default")
          await program(bin, "cargo", "cargo 1.100.0 (new 2026-11-05)");
        return answer;
      },
    });
    expect(items).toEqual([
      {
        tool: "cargo",
        minimum: "1.89.0",
        result: "updated",
        from: "1.80.0",
        version: "1.100.0",
        onPath: true,
      },
    ]);
    expect(calls).toEqual([
      `${join(bin, "rustup")} update stable --no-self-update`,
      `${join(bin, "rustup")} default stable`,
    ]);
    expect(await readlink(join(entry, "cargo"))).toBe(join(bin, "cargo"));
  },
);

test.skipIf(windows)(
  "below the minimum but installed another way (a system package): reported, never replaced or shadowed",
  async () => {
    const user = await home();
    const system = join(user, "usr-bin");
    await program(system, "cargo", "cargo 1.75.0");
    const calls: string[] = [];
    const items = await provisionOrganizationTools({
      tools: [cargo("1.89.0")],
      path: system,
      home: user,
      platform: process.platform,
      run: runner(async () => 0, calls),
    });
    expect(items).toEqual([
      {
        tool: "cargo",
        minimum: "1.89.0",
        result: "below-minimum",
        version: "1.75.0",
        reason: "foreign-installation",
        path: join(system, "cargo"),
        source: "https://rustup.rs",
      },
    ]);
    expect(calls).toEqual([]);
    await expect(lstat(join(user, ".local", "bin", "cargo"))).rejects.toThrow();
  },
);

test.skipIf(windows)(
  "a failed installer and a tool still below its minimum after it are failures that name their stage; the next tool runs either way",
  async () => {
    const user = await home();
    const calls: string[] = [];
    const items = await provisionOrganizationTools({
      tools: [cargo("1.89.0"), pnpm("11.0.0")],
      path: "/usr/bin:/bin",
      home: user,
      platform: process.platform,
      run: runner(async (env) => {
        if (env.PNPM_NO_MODIFY_PATH === undefined) return 1;
        await program(
          join(user, ".local", "share", "pnpm", "bin"),
          "pnpm",
          "10.0.0",
        );
        return 0;
      }, calls),
    });
    expect(items).toEqual([
      {
        tool: "cargo",
        minimum: "1.89.0",
        result: "failed",
        stage: "install",
        reason: "exit-1",
        detail: "curl: (6) Could not resolve host",
        source: "https://rustup.rs",
      },
      {
        tool: "pnpm",
        minimum: "11.0.0",
        result: "failed",
        stage: "verify",
        reason: "below-minimum-after:10.0.0",
        source: "https://pnpm.io/installation",
      },
    ]);
    expect(calls).toEqual(["installer cargo", "installer pnpm"]);
  },
);

test("no recipe runs on Windows yet: each tool is one item", async () => {
  const items = await provisionOrganizationTools({
    tools: [pnpm("11.0.0")],
    path: undefined,
    home: "C:\\Users\\a",
    platform: "win32",
    run: async () => {
      throw new Error("Not run");
    },
  });
  expect(items).toEqual([
    {
      tool: "pnpm",
      minimum: "11.0.0",
      result: "unsupported-platform",
      platform: "win32",
    },
  ]);
});

test.skipIf(windows)(
  "doctor's reading changes nothing: at the minimum, below it, missing",
  async () => {
    const user = await home();
    const bin = join(user, "bin");
    await program(bin, "cargo", "cargo 1.80.0");
    expect(
      await organizationToolsState({
        tools: [cargo("1.89.0"), pnpm("11.0.0")],
        path: bin,
        home: user,
        platform: process.platform,
        run: runTool,
      }),
    ).toEqual([
      {
        tool: "cargo",
        minimum: "1.89.0",
        state: "below-minimum",
        version: "1.80.0",
      },
      { tool: "pnpm", minimum: "11.0.0", state: "missing" },
    ]);
  },
);

// ---- Which declaration applies --------------------------------------------

const os = executionOs(process.platform);

async function git(directory: string, ...args: string[]) {
  const result = await runChild(
    [
      "git",
      "-C",
      directory,
      "-c",
      "user.name=Example",
      "-c",
      "user.email=example@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { env: { PATH: process.env.PATH, HOME: directory, LC_ALL: "C" } },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function folderWith(
  preset: "hosted-organization-team" | "hosted-personal",
  settings: unknown,
) {
  const parent = await home();
  const folder = join(parent, "Lazurio");
  await mkdir(join(folder, "organizations"), {
    recursive: true,
    mode: 0o700,
  });
  if (preset === "hosted-personal")
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset,
    machine: preset === "hosted-personal" ? bindings.personal : bindings.team,
    profile: presetProfile(preset, os),
  });
  const root = await writeOrganization(folder, "Example_GEN3", {
    slug: "example",
    state: "current",
    modules: [],
  });
  await git(root, "init", "--quiet", "--initial-branch=main");
  const manifest = join(root, "lazurio.organization.json");
  const document = JSON.parse(await readFile(manifest, "utf8"));
  await writeOwnedFixture(manifest, JSON.stringify({ ...document, settings }));
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "settings");
  const tools = toolsEnvironmentOf(
    { PATH: process.env.PATH, HOME: parent },
    process.platform,
  );
  return {
    folder,
    tools,
    version: await git(root, "rev-parse", "HEAD"),
    reader: operatorGit(tools),
  };
}

test.skipIf(windows)(
  "an Organization's Environment applies the declaration of the Organization its handover names, at the commit of its main",
  async () => {
    const declared = [cargo("1.89.0"), pnpm("11.0.0")];
    const { folder, tools, version, reader } = await folderWith(
      "hosted-organization-team",
      { tools: declared },
    );
    expect(await declaredOrganizationTools(folder, tools, reader)).toEqual({
      kind: "declared",
      organization: "example",
      version,
      tools: declared,
    });
  },
);

test.skipIf(windows)(
  "a personal Environment applies none, and an invalid section applies none and says so",
  async () => {
    const personal = await folderWith("hosted-personal", {
      tools: [cargo("1.89.0")],
    });
    expect(
      await declaredOrganizationTools(
        personal.folder,
        personal.tools,
        personal.reader,
      ),
    ).toEqual({ kind: "not-run", reason: "not-governed" });
    const invalid = await folderWith("hosted-organization-team", {
      tools: [{ tool: "cargo", minimum: "latest" }],
    });
    expect(
      await declaredOrganizationTools(
        invalid.folder,
        invalid.tools,
        invalid.reader,
      ),
    ).toEqual({ kind: "not-run", reason: "settings-invalid" });
  },
);

// ---- In `lazurio update` ---------------------------------------------------

const product = {
  part: "product",
  result: "current",
  version: "0.1.22",
} as const;

test("the Organization's tools run after the content and before the builds; a failing part is one item and stops nothing", async () => {
  const order: string[] = [];
  const parts = (
    organizationTools: UpdateParts["organizationTools"],
  ): UpdateParts => ({
    content: async () => {
      order.push("content");
      return {
        kind: "content-sync",
        at: "2026-11-15T08:00:00.000Z",
        organizations: [],
        entries: [],
      };
    },
    ...(organizationTools === undefined ? {} : { organizationTools }),
    builds: async () => {
      order.push("builds");
      return [];
    },
    product: async () => {
      order.push("product");
      return product;
    },
  });
  const items = await updateEverything(
    parts(async (onStep) => {
      order.push("organization-tools");
      onStep("cargo", "installing");
      return {
        kind: "provisioned",
        items: [
          {
            tool: "cargo",
            minimum: "1.89.0",
            result: "installed",
            version: "1.100.0",
            onPath: true,
          },
          {
            tool: "pnpm",
            minimum: "11.0.0",
            result: "current",
            version: "12.21.0",
          },
        ],
      };
    }),
  );
  expect(order).toEqual(["content", "organization-tools", "builds", "product"]);
  expect(items).toEqual([
    {
      part: "organization-tools",
      tool: "cargo",
      minimum: "1.89.0",
      result: "installed",
      version: "1.100.0",
      onPath: true,
    },
    {
      part: "organization-tools",
      tool: "pnpm",
      minimum: "11.0.0",
      result: "current",
      version: "12.21.0",
    },
    product,
  ]);
  expect(everythingText(items)).toEqual([
    "Installed the Organization's tool cargo (minimum 1.89.0): 1.100.0.",
  ]);
  order.length = 0;
  const failed = await updateEverything(
    parts(async () => {
      throw new Error("broken");
    }),
  );
  expect(order).toEqual(["content", "builds", "product"]);
  expect(failed).toEqual([
    {
      part: "organization-tools",
      result: "failed",
      reason: "operation-failed",
    },
    product,
  ]);
  const silent = await updateEverything(
    parts(async () => ({ kind: "not-run", reason: "not-governed" })),
  );
  expect(everythingText(silent)).toEqual([]);
});
