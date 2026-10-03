import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type FilesContext, runFilesCommand } from "../src/files/cli";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { bindings, organizationWithEntry } from "./fixtures/machine-bindings";
import { commitOf, target } from "./fixtures/update-world";

// `lazurio files link` (decision F35): the link an agent hands the Operator,
// from the same rules and Documents adapter as the Launchpad's Files page.
// A temporary home, a Folder per kind of Environment; nothing is written.

const posix = process.platform !== "win32";
const origin = "https://launchpad.workspace.example.lazurio.io";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

type Kind = "hosted" | "hosted-without-entry" | "workstation";

async function world(kind: Kind, locale: "cs" | "en" = "en") {
  root = await realpath(await mkdtemp(join(tmpdir(), "files-link-")));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const folder = join(home, "Lazurio");
  if (kind === "workstation")
    await initializeFolder(
      folder,
      presetProfile("local", executionOs(process.platform), { locale }),
    );
  else {
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    await initializeHandoverFolder(folder, {
      preset,
      machine:
        kind === "hosted" ? organizationWithEntry() : bindings.organization,
      profile: presetProfile(preset, executionOs(process.platform), {
        locale,
      }),
    });
  }
  const documents = join(home, "Documents");
  await mkdir(join(documents, "Úkol 42"), { recursive: true });
  await writeFile(join(documents, "Úkol 42", "Zpráva (final).docx"), "report");
  await mkdir(join(documents, ".private"));
  await writeFile(join(documents, ".private", "notes.txt"), "hidden");
  await writeFile(join(home, "elsewhere.txt"), "outside");
  await symlink(join(home, "elsewhere.txt"), join(documents, "escape.txt"));
  await symlink(
    join(documents, "Úkol 42", "Zpráva (final).docx"),
    join(documents, "latest.docx"),
  );
  const context: FilesContext = {
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: process.platform,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    executable: join(root, "unused"),
    hostedFolder: undefined,
    cwd: documents,
  };
  return { root, home, folder, documents, context };
}

const link = (context: FilesContext, ...args: string[]) =>
  runFilesCommand(["link", ...args], context);

test.skipIf(!posix)(
  "a Remote Environment with an entry: the Files link of the file, its folder or the Documents folder",
  async () => {
    const { home, folder, documents, context } = await world("hosted");
    const before = (await readdir(home, { recursive: true })).sort();
    const file = join(documents, "Úkol 42", "Zpráva (final).docx");
    const url = `${origin}/files/%C3%9Akol%2042/Zpr%C3%A1va%20%28final%29.docx`;
    const human = await link(context, file, "--folder", folder);
    expect(human).toEqual({
      code: 0,
      stdout: url,
      stderr:
        "Hand this link to the Operator instead of the path: it opens in their browser behind this Environment's sign-in and downloads the file (a folder opens on the Files page).",
    });
    expect(await link(context, file, "--folder", folder, "--json")).toEqual({
      code: 0,
      stdout: JSON.stringify({ kind: "files-link", hosted: true, url }),
    });
    // Relative to the current directory; a folder; the Documents folder;
    // a link inside is the link of its target.
    expect(
      (await link(context, "Úkol 42/Zpráva (final).docx", "--folder", folder))
        .stdout,
    ).toBe(url);
    expect((await link(context, "Úkol 42", "--folder", folder)).stdout).toBe(
      `${origin}/files/%C3%9Akol%2042`,
    );
    expect((await link(context, ".", "--folder", folder)).stdout).toBe(
      `${origin}/files`,
    );
    expect(
      (await link(context, "latest.docx", "--folder", folder)).stdout,
    ).toBe(url);
    expect((await readdir(home, { recursive: true })).sort()).toEqual(before);
  },
);

test.skipIf(!posix)(
  "a path outside ~/Documents, hidden, escaping or missing is refused with what to do instead",
  async () => {
    const { home, folder, documents, context } = await world("hosted");
    for (const [path, reason] of [
      [join(home, "elsewhere.txt"), "outside-documents"],
      [folder, "outside-documents"],
      ["/", "outside-documents"],
      [join(documents, ".private", "notes.txt"), "path-hidden"],
      [join(documents, ".private"), "path-hidden"],
      ["escape.txt", "outside-documents"],
      ["missing.docx", "not-found"],
    ] as const) {
      const json = await link(context, path, "--folder", folder, "--json");
      expect([path, json]).toEqual([
        path,
        { code: 2, stdout: JSON.stringify({ kind: "blocked", reason }) },
      ]);
      const human = await link(context, path, "--folder", folder);
      expect(human.code).toBe(2);
      expect(human.stdout).toBeUndefined();
      expect(human.stderr).toStartWith(`Files link refused (${reason}): `);
      // The refusal never quotes the path.
      expect(human.stderr).not.toContain(home);
    }
    expect(
      (await link(context, join(home, "elsewhere.txt"), "--folder", folder))
        .stderr,
    ).toBe(
      "Files link refused (outside-documents): The path is not inside ~/Documents. Save or copy the file into ~/Documents/<task>/ first, then run lazurio files link again.",
    );
    const fifo = join(documents, "pipe");
    const child = Bun.spawn(["mkfifo", fifo]);
    expect(await child.exited).toBe(0);
    expect(
      (await link(context, fifo, "--folder", folder, "--json")).stdout,
    ).toBe(JSON.stringify({ kind: "blocked", reason: "not-regular" }));
  },
);

test.skipIf(!posix)(
  "without an entry: the path itself, on a workstation and on a Remote Environment whose handover has none",
  async () => {
    for (const kind of ["workstation", "hosted-without-entry"] as const) {
      const { folder, documents, context } = await world(kind);
      const file = join(documents, "Úkol 42", "Zpráva (final).docx");
      const human = await link(context, file, "--folder", folder);
      expect(human).toEqual({
        code: 0,
        stdout: file,
        stderr:
          kind === "workstation"
            ? "This Environment has no hosted entry: the file is already on this computer, at this path."
            : "This Remote Environment records no hosted entry yet, so there is no browser link: the file lies at this path here.",
      });
      expect(
        await link(
          context,
          "Úkol 42/Zpráva (final).docx",
          "--folder",
          folder,
          "--json",
        ),
      ).toEqual({
        code: 0,
        stdout: JSON.stringify({
          kind: "files-link",
          hosted: false,
          path: file,
        }),
      });
      await rm(root as string, { recursive: true, force: true });
      root = undefined;
    }
    // No Folder at all: a workstation without a supervised unit.
    const { documents, context } = await world("workstation");
    const none = await link(context, "Úkol 42", "--json");
    expect(none).toEqual({
      code: 0,
      stdout: JSON.stringify({
        kind: "files-link",
        hosted: false,
        path: join(documents, "Úkol 42"),
      }),
    });
  },
);

test.skipIf(!posix)(
  "the notes and refusals follow the Folder's language",
  async () => {
    const { folder, documents, context } = await world("hosted", "cs");
    const file = join(documents, "Úkol 42", "Zpráva (final).docx");
    expect((await link(context, file, "--folder", folder)).stderr).toBe(
      "Předej Operátorovi tenhle odkaz místo cesty: otevře se mu v prohlížeči za přihlášením tohohle Environmentu a soubor stáhne (složka se otevře na stránce Soubory).",
    );
    expect((await link(context, "/", "--folder", folder)).stderr).toBe(
      "Files link refused (outside-documents): Cesta neleží v ~/Documents. Nejdřív soubor ulož nebo zkopíruj do ~/Documents/<úkol>/ a pak spusť lazurio files link znovu.",
    );
  },
);

test("usage and an unreadable Folder", async () => {
  const { root: directory, context } = await world("workstation");
  for (const args of [
    [],
    ["link"],
    ["share", "x"],
    ["link", "a", "b"],
    ["link", ""],
    ["link", "x", "--json", "--json"],
    ["link", "x", "--folder", "relative"],
    ["link", "x", "--folder", `${directory}/../x`],
    ["link", "x", "--public"],
  ])
    expect([args, await runFilesCommand(args, context)]).toEqual([
      args,
      {
        code: 2,
        stderr:
          "Usage: files link <path> [--folder <absolute Folder>] [--json]",
      },
    ]);
  expect(
    await link(context, "Úkol 42", "--folder", join(directory, "missing")),
  ).toEqual({
    code: 1,
    stderr:
      "Files link failed: the Folder could not be read (folder-state-unreadable)",
  });
});

test.skipIf(!posix)(
  "lazurio files link runs from the command line with a temporary home: the link alone on stdout",
  async () => {
    const { root: directory, home, folder, documents } = await world("hosted");
    const xdg = join(directory, "xdg");
    const cli = async (...args: string[]) => {
      const child = Bun.spawn(
        [process.execPath, resolve("src/cli.ts"), "files", "link", ...args],
        {
          cwd: join(documents, "Úkol 42"),
          env: {
            HOME: home,
            PATH: "/usr/bin:/bin",
            XDG_CONFIG_HOME: join(xdg, "config"),
            XDG_STATE_HOME: join(xdg, "state"),
            XDG_DATA_HOME: join(xdg, "data"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const ok = await cli("Zpráva (final).docx", "--folder", folder);
    expect([ok.code, ok.stdout]).toEqual([
      0,
      `${origin}/files/%C3%9Akol%2042/Zpr%C3%A1va%20%28final%29.docx\n`,
    ]);
    const refused = await cli("../../elsewhere.txt", "--folder", folder);
    expect([refused.code, refused.stdout]).toEqual([2, ""]);
    expect(refused.stderr).toContain("Files link refused (outside-documents)");
    const usage = await cli();
    expect([usage.code, usage.stdout]).toEqual([2, ""]);
  },
);
