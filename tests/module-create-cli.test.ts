import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCli } from "../src/cli";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import { writePersonalspaceCheckout } from "./fixtures/personalspace-template";

// `lazurio module create` and `lazurio module prepare` through the CLI's own
// entrypoint (`runCli`), which dispatched neither: `module prepare` fell to
// the catalog's usage (issue #114) and `module create` did not exist (#267).
// The refusals that need nothing read run in this process; the plan runs end
// to end in a child process of `src/cli.ts` with a fake gh on its PATH and
// the operator's real git, so nothing reaches a real account. Synthetic
// names only.

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
let parent = "";
beforeAll(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), "module-create-cli-")));
});
afterAll(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
});

/** `runCli` with its stdout and stderr lines. */
async function cli(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: string) => void stdout.push(String(line));
  console.error = (line: string) => void stderr.push(String(line));
  try {
    const code = await runCli(args);
    return { code, stdout, stderr: stderr.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const report = (lines: readonly string[]) => JSON.parse(lines.at(-1) as string);

test("usage errors exit 2 with the command's help, before anything is read", async () => {
  const folder = "/nonexistent-lazurio-folder";
  const cases: [string[], string][] = [
    [
      [
        "personalspace/notes",
        "--stack",
        "vite-react",
        "--teams",
        "core",
        "--dry-run",
      ],
      "A personal module has no Teams",
    ],
    [["personalspace/notes", "--dry-run"], "module create needs --stack"],
    [
      [
        "personalspace/notes",
        "personalspace/diary",
        "--stack",
        "none",
        "--dry-run",
      ],
      "takes one module",
    ],
    [
      ["personalspace/notes", "--stack", "none"],
      "Show the person the plan with --dry-run first",
    ],
    [
      [
        "personalspace/notes",
        "--stack",
        "none",
        "--dry-run",
        "--confirm",
        `sha256:${"0".repeat(64)}`,
      ],
      "Either --dry-run or --confirm <plan>, not both",
    ],
    [
      ["personalspace/notes", "--stack", "none", "--confirm", "yes"],
      "--confirm takes the plan's digest",
    ],
    [
      ["personalspace/notes", "--stack", "none", "--port", "x", "--dry-run"],
      "--port is a port number",
    ],
    [
      ["personalspace/notes", "--stack", "none", "--dry-run", "--unknown"],
      "Unknown option",
    ],
    [
      ["Acme/portal", "--stack", "none", "--dry-run"],
      "An Organization's module names its Teams",
    ],
    [
      ["Acme/portal", "--stack", "none", "--teams", "core,", "--dry-run"],
      "An Organization's module names its Teams",
    ],
    [
      ["Acme/portal", "--stack", "none", "--teams", "core"],
      "Show the person the plan with --dry-run first",
    ],
  ];
  for (const [args, message] of cases) {
    const run = await cli(["module", "create", ...args, "--folder", folder]);
    expect(run.code, args.join(" ")).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("module create personalspace/<module>");
    expect(run.stdout).toEqual([]);
  }
});

test("refusals by name alone: an unknown Organization, the stack and the slug", async () => {
  const folder = "/nonexistent-lazurio-folder";
  const refused = async (args: string[], reason: string) => {
    const run = await cli([
      "module",
      "create",
      ...args,
      "--dry-run",
      "--json",
      "--folder",
      folder,
    ]);
    expect(run.code, args.join(" ")).toBe(2);
    expect(JSON.parse(run.stdout[0] as string)).toEqual({
      kind: "module-create-step",
      key: "plan",
      state: "running",
    });
    expect(JSON.parse(run.stdout[1] as string)).toMatchObject({
      kind: "module-create-step",
      key: "plan",
      state: "failed",
      code: reason,
    });
    expect(report(run.stdout)).toMatchObject({
      schema_version: "lazurio.module_create.report.v1",
      status: "blocked",
      reason,
    });
    return report(run.stdout);
  };
  // The Organization form: no such Organization in a Folder that is none.
  const organization = await refused(
    ["Acme/portal", "--stack", "none", "--teams", "core"],
    "organization_not_found",
  );
  expect(organization.scope).toBe("organization");
  await refused(["personalspace/notes", "--stack", "rails"], "unknown_stack");
  await refused(["personalspace/Notes", "--stack", "none"], "invalid_slug");
  await refused(["personalspace/mausbot", "--stack", "none"], "reserved_slug");
});

posixTest(
  "a workstation without a Personalspace refuses before GitHub is asked",
  async () => {
    const folder = join(parent, "workstation", "Lazurio");
    await mkdir(dirname(folder), { recursive: true });
    await initializeFolder(
      folder,
      presetProfile("local", executionOs(process.platform)),
    );
    const run = await cli([
      "module",
      "create",
      "personalspace/notes",
      "--stack",
      "none",
      "--dry-run",
      "--json",
      "--folder",
      folder,
    ]);
    expect(run.code).toBe(2);
    expect(report(run.stdout)).toMatchObject({
      status: "blocked",
      reason: "personalspace-absent",
      next_steps: ["Install it first: lazurio personalspace install."],
    });
  },
);

test("module prepare reaches the module lifecycle (issue #114)", async () => {
  const run = await cli([
    "module",
    "prepare",
    "personalspace/notes",
    "--folder",
    "/nonexistent-lazurio-folder",
    "--json",
  ]);
  // The lifecycle's own answer, not the catalog's usage error.
  expect(run.code).toBe(1);
  expect(JSON.parse(run.stdout[0] as string)).toEqual({
    kind: "blocked",
    operation: "prepare",
    reason: "folder-unreadable",
  });
  expect(run.stderr).not.toContain("Usage: organization list");
});

test("the help names module create", async () => {
  const run = await cli(["help"]);
  expect(run.code).toBe(0);
  expect(run.stdout.join("\n")).toContain(
    "module create personalspace/<module> --stack <stack>",
  );
});

// The fake gh of this Environment: the account `example`, its own private
// Personalspace, no repository `example/notes`; every call is logged.
async function fakeGh(bin: string, calls: string) {
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$*" in
  "api user") echo '{"login":"example","id":12345}' ;;
  "api repos/example/example_GEN3") echo '{"full_name":"example/example_GEN3","private":true,"archived":false,"owner":{"login":"example","id":12345,"type":"User"},"permissions":{"admin":true,"pull":true}}' ;;
  "api repos/example/notes") echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
  *) echo 'unexpected gh call' >&2; exit 1 ;;
esac
`,
  );
  await chmod(gh, 0o755);
}

posixTest(
  "the plan end to end through the CLI: the person's private repository, the slot and the lease, only GitHub reads",
  async () => {
    const root = join(parent, "end-to-end");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const folder = join(root, "Lazurio");
    const calls = join(root, "gh-calls");
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    await fakeGh(bin, calls);
    await initializeFolder(
      folder,
      presetProfile("local", executionOs(process.platform)),
    );
    await writePersonalspaceCheckout(
      join(folder, "personalspace", "example_GEN3"),
      "example/example_GEN3",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "..", "src", "cli.ts"),
        "module",
        "create",
        "personalspace/notes",
        "--stack",
        "bun-service",
        "--name",
        "Poznámky",
        "--dry-run",
        "--json",
        "--folder",
        folder,
      ],
      {
        cwd: folder,
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[1] as string)).toMatchObject({
      kind: "module-create-step",
      key: "plan",
      state: "done",
    });
    expect(report(lines)).toMatchObject({
      status: "actionable",
      reason: "scaffold_planned",
      module: { name: "personalspace/notes", display_name: "Poznámky" },
      repository: { full_name: "example/notes", private: true, create: true },
      slot: {
        default_access: "private",
        git: { url: "git@github.com:example/notes.git" },
      },
      lease: { port: 23_052 },
      manifest: { adds_pool: true },
      worktree: null,
    });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "api user",
      "api repos/example/example_GEN3",
      "api repos/example/notes",
    ]);
  },
);
