import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  folderInstructionsHelp,
  runFolderInstructionsCommand,
} from "../src/folder/instructions-cli";
import {
  maxOwnInstructionsBytes,
  ownInstructionsNotice,
} from "../src/folder/own-instructions";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { parseFolderPreferences } from "../src/folder/state";
import { updateProfile } from "../src/folder/update-profile";
import { bindings } from "./fixtures/machine-bindings";
import { writeRenderedFolder } from "./fixtures/rendered-folder";

// `lazurio folder instructions` (root decision 0233, decision F14's addendum
// of 2026-11-06): what an agent runs, on the person's word, to read and save
// the person's own instructions. Every Folder here is a temporary one.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function folderOf(
  preset: PresetName,
  machine: unknown,
  locale: "cs" | "en",
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "folder-instructions-cli-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const folder = join(parent, "Lazurio");
  await mkdir(join(folder, ".lazurio"), { recursive: true, mode: 0o700 });
  const profile = presetProfile(preset, executionOs(process.platform), {
    locale,
  });
  await writeRenderedFolder(folder, { preset, machine, profile });
  const run = async (...args: string[]) => {
    const output = await runFolderInstructionsCommand([
      "instructions",
      ...args,
      "--folder",
      folder,
    ]);
    return { ...output, stdout: output.stdout ?? "" };
  };
  return {
    parent,
    folder,
    profile,
    run,
    json: async (...args: string[]) => {
      const output = await run(...args, "--json");
      return { code: output.code, result: JSON.parse(output.stdout) };
    },
    state: async () =>
      parseFolderPreferences(
        JSON.parse(
          await readFile(join(folder, ".lazurio/preferences.json"), "utf8"),
        ),
      ),
    agents: () => readFile(join(folder, "AGENTS.md"), "utf8"),
  };
}
const hosted = process.platform === "linux";

test.skipIf(!hosted)(
  "on a Work Environment show, add, set and clear read and save the own instructions, and every change says whose they are",
  async () => {
    const f = await folderOf(
      "hosted-organization-personal",
      bindings.organization,
      "cs",
    );
    const notice = ownInstructionsNotice.cs;
    expect(notice).toBe(
      "Tyto pokyny patří Organizaci spolu s Prostředím a její Admini je smí číst. Soukromé věci patří do Osobního Prostředí.",
    );
    // Nothing yet.
    expect(await f.json("show")).toEqual({
      code: 0,
      result: {
        kind: "own-instructions",
        revision: 1,
        allowed: true,
        text: "",
        bytes: 0,
        maxBytes: maxOwnInstructionsBytes,
        notice,
      },
    });
    expect((await f.run("show")).stdout).toBe(
      `Vlastní pokyny: žádné (0 z 4096 bajtů). Revize Folderu 1.\n${notice}`,
    );
    // The first line: the command reads the revision itself.
    const first = await f.json("add", "Říkej mi Aleno.");
    expect(first).toEqual({
      code: 0,
      result: {
        kind: "updated",
        revision: 2,
        bytes: Buffer.byteLength("Říkej mi Aleno."),
        maxBytes: maxOwnInstructionsBytes,
        notice,
      },
    });
    // The next line goes after a line end; in words, with the notice.
    const second = await f.run("add", "Odpovídej stručně a začni výsledkem.");
    const text = "Říkej mi Aleno.\nOdpovídej stručně a začni výsledkem.";
    // Czech counts in bytes, not characters.
    const size = Buffer.byteLength(text);
    expect(size).toBeGreaterThan(text.length);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(
      `Řádek je uložený (${size} z 4096 bajtů); revize Folderu 3.\n${notice}`,
    );
    expect((await f.state()).customInstructions).toBe(text);
    expect(await f.agents()).toContain(`\`\`\`text\n${text}\n\`\`\``);
    expect((await f.run("show")).stdout).toBe(
      `Vlastní pokyny (${size} z 4096 bajtů), revize Folderu 3:\n${text}\n${notice}`,
    );
    expect((await f.json("show")).result).toMatchObject({
      revision: 3,
      text,
      bytes: size,
    });
    // `add` takes one line; several lines are `set`'s.
    for (const line of ["Dva\nřádky", "  "]) {
      const refused = await f.json("add", line);
      expect(refused.code).toBe(2);
      expect(refused.result).toMatchObject({
        kind: "blocked",
        reason: "own-instructions-invalid",
        problem: "not-one-line",
        notice,
      });
    }
    // The whole text replaced, from the option and from a file whose final
    // line end is not part of the text.
    expect(
      await f.json("set", "--text", "Piš mi krátce.\nBez úvodů."),
    ).toMatchObject({ code: 0, result: { kind: "updated", revision: 4 } });
    expect((await f.state()).customInstructions).toBe(
      "Piš mi krátce.\nBez úvodů.",
    );
    expect(
      await f.json("set", "--text", "Piš mi krátce.\nBez úvodů."),
    ).toMatchObject({ code: 0, result: { kind: "unchanged", notice } });
    const file = join(f.parent, "own.txt");
    await writeFile(file, "Říkej mi Aleno.\n\nPiš věcně.\n");
    const fromFile = await f.run("set", "--file", file);
    expect(fromFile.stdout).toBe(
      `Vlastní pokyny jsou uložené (${Buffer.byteLength("Říkej mi Aleno.\n\nPiš věcně.")} z 4096 bajtů); revize Folderu 5.\n${notice}`,
    );
    expect((await f.state()).customInstructions).toBe(
      "Říkej mi Aleno.\n\nPiš věcně.",
    );
    // A caller that holds a revision is held to it; the Folder stays.
    const stale = await f.json("add", "Pozdě.", "--expected-revision", "4");
    expect(stale).toEqual({
      code: 2,
      result: { kind: "blocked", reason: "stale-revision", notice },
    });
    expect(
      await f.json("add", "Včas.", "--expected-revision", "5"),
    ).toMatchObject({ code: 0, result: { kind: "updated", revision: 6 } });
    // Refused texts leave everything as it is and say why.
    const tooLong = await f.run("set", "--text", "ě".repeat(2049));
    expect(tooLong.code).toBe(2);
    expect(tooLong.stdout).toBe(
      `Neuloženo: text má 4098 bajtů a vlastní pokyny smí mít nejvýš 4096.\n${notice}`,
    );
    await writeFile(file, Buffer.from([0x50, 0xff, 0xfe]));
    expect((await f.json("set", "--file", file)).result).toMatchObject({
      reason: "own-instructions-invalid",
      problem: "not-text",
    });
    expect(
      (await f.json("set", "--text", "Zvonek \u0007")).result,
    ).toMatchObject({
      reason: "own-instructions-invalid",
      problem: "not-plain-text",
    });
    expect((await f.json("set", "--text", "")).result).toMatchObject({
      reason: "own-instructions-invalid",
      problem: "blank",
    });
    expect(
      await f.json("set", "--file", join(f.parent, "missing.txt")),
    ).toMatchObject({ code: 1, result: { reason: "file-unreadable" } });
    expect((await f.state()).revision).toBe(6);
    // Removed, and removing again changes nothing.
    const cleared = await f.run("clear");
    expect(cleared.code).toBe(0);
    expect(cleared.stdout).toBe(
      `Vlastní pokyny jsou odstraněné; revize Folderu 7.\n${notice}`,
    );
    expect((await f.state()).customInstructions).toBe("");
    expect(await f.agents()).not.toContain("## Vlastní pokyny uživatele");
    expect(await f.json("clear")).toEqual({
      code: 0,
      result: {
        kind: "unchanged",
        bytes: 0,
        maxBytes: maxOwnInstructionsBytes,
        notice,
      },
    });
  },
  60_000,
);

// The way back from a product that refuses a Folder with own instructions
// (the release notes' rollback): the text is saved from `show --json`,
// removed and restored. `set --file` treats the file's final line end as the
// file's; `--exact` takes the file as the text, so every valid text comes
// back byte for byte, whatever it ends with.
test("a text saved from show --json comes back byte for byte through set --file --exact", async () => {
  const f = await folderOf("local", null, "cs");
  const file = join(f.parent, "backup.txt");
  for (const text of [
    "Bez konce řádku 🙂",
    "Končí LF\n",
    "Končí CRLF\r\n",
    "Končí samotným CR\r",
    "Dva LF na konci\n\n",
    "Více řádků\ns prázdným\n\nna konci LF\n",
  ]) {
    expect((await f.json("set", "--text", text)).code).toBe(0);
    const shown = (await f.json("show")).result;
    expect(shown).toMatchObject({ text, bytes: Buffer.byteLength(text) });
    await writeFile(file, shown.text);
    expect((await f.json("clear")).code).toBe(0);
    expect((await f.state()).customInstructions).toBe("");
    expect((await f.json("set", "--file", file, "--exact")).code).toBe(0);
    expect((await f.state()).customInstructions).toBe(text);
  }
  // Without --exact the same file loses its final line end: a text that
  // ends with one, or with a lone carriage return before the added one, is
  // not what comes back.
  await writeFile(file, "Končí LF\n");
  expect((await f.json("set", "--file", file)).code).toBe(0);
  expect((await f.state()).customInstructions).toBe("Končí LF");
});

test("on the person's own computer the answers are in the Folder's language and carry no notice", async () => {
  const f = await folderOf("local", null, "en");
  expect((await f.run("show")).stdout).toBe(
    "Own instructions: none (0 of 4096 bytes). Folder revision 1.",
  );
  const added = await f.run("add", "Call me Alena.");
  expect(added).toMatchObject({
    code: 0,
    stdout: "The line is saved (14 of 4096 bytes); Folder revision 2.",
  });
  expect(await f.json("show")).toEqual({
    code: 0,
    result: {
      kind: "own-instructions",
      revision: 2,
      allowed: true,
      text: "Call me Alena.",
      bytes: 14,
      maxBytes: maxOwnInstructionsBytes,
    },
  });
  expect(await f.agents()).toContain(
    "## The user's own instructions\nThe user of this Environment wrote these instructions.",
  );
  // A line that starts with a dash goes after `--`.
  expect(
    (
      await runFolderInstructionsCommand([
        "instructions",
        "add",
        "--folder",
        f.folder,
        "--",
        "- Lead with the outcome.",
      ])
    ).stdout,
  ).toContain("Folder revision 3.");
  expect((await f.state()).customInstructions).toBe(
    "Call me Alena.\n- Lead with the outcome.",
  );
  // The voice and the instructions share one budget: next to a long custom
  // voice the long instructions are refused in a sentence with the sizes.
  const current = await f.state();
  expect(
    await updateProfile(f.folder, current.revision, {
      profile: current.profile,
      voice: { locale: "en", text: "v".repeat(6000) },
    }),
  ).toMatchObject({ kind: "updated" });
  const refused = await f.run("set", "--text", "x".repeat(4000));
  expect(refused.code).toBe(2);
  expect(refused.stdout).toMatch(
    /^Not saved: The own instructions do not fit next to the communication voice: the voice takes 6000 bytes and the section of own instructions \d+, and together they may take 8192 at most\. Either the instructions or the custom voice has to be shorter\.$/,
  );
  expect((await f.json("set", "--text", "x".repeat(4000))).result).toEqual({
    kind: "blocked",
    reason: "person-text-too-large",
    voiceBytes: 6000,
    instructionsBytes: expect.any(Number),
    maxBytes: 8192,
  });
  expect((await f.state()).customInstructions).toBe(
    "Call me Alena.\n- Lead with the outcome.",
  );
  expect((await f.run("set", "--text", "x".repeat(1000))).code).toBe(0);
  expect((await f.run("clear")).stdout).toBe(
    "The own instructions are removed; Folder revision 6.",
  );
}, 60_000);

test.skipIf(!hosted)(
  "a Team Environment has no own instructions: show says so and a change is refused",
  async () => {
    const f = await folderOf(
      "hosted-organization-team",
      bindings.assignedTeam,
      "cs",
    );
    const before = await f.agents();
    const none =
      "Toto Prostředí vlastní pokyny uživatele nemá: mají je jen vlastní počítač uživatele, Osobní Prostředí a Pracovní Prostředí přiřazené jednomu člověku.";
    expect(await f.json("show")).toEqual({
      code: 0,
      result: {
        kind: "own-instructions",
        revision: 1,
        allowed: false,
        text: "",
        bytes: 0,
        maxBytes: maxOwnInstructionsBytes,
      },
    });
    expect((await f.run("show")).stdout).toBe(none);
    for (const args of [
      ["add", "Říkej mi Aleno."],
      ["set", "--text", "Říkej mi Aleno."],
    ]) {
      expect(await f.json(...args)).toEqual({
        code: 2,
        result: { kind: "blocked", reason: "own-instructions-unavailable" },
      });
      expect(await f.run(...args)).toMatchObject({
        code: 2,
        stdout: `Neuloženo: ${none}`,
      });
    }
    expect((await f.state()).revision).toBe(1);
    expect(await f.agents()).toBe(before);
    // The same on a public Environment, whatever preset its Folder records.
    const visitors = await folderOf(
      "hosted-organization-personal",
      bindings.organizationPublic,
      "en",
    );
    expect((await visitors.json("show")).result).toMatchObject({
      allowed: false,
    });
    expect(await visitors.json("add", "Call me Alena.")).toEqual({
      code: 2,
      result: { kind: "blocked", reason: "own-instructions-unavailable" },
    });
  },
  60_000,
);

test("a wrong invocation is a usage error with the help, and without a Folder the command asks for one", async () => {
  const f = await folderOf("local", null, "en");
  for (const args of [
    [],
    ["instructions"],
    ["instructions", "forget"],
    ["notes", "show"],
    ["instructions", "show", "extra"],
    ["instructions", "add"],
    ["instructions", "add", "one", "two"],
    ["instructions", "set"],
    ["instructions", "set", "--text", "a", "--file", "/tmp/a"],
    ["instructions", "set", "--text", "a", "--exact"],
    ["instructions", "clear", "--exact"],
    ["instructions", "clear", "--text", "a"],
    ["instructions", "add", "a", "--file", "/tmp/a"],
    ["instructions", "show", "--expected-revision", "1"],
    ["instructions", "clear", "--expected-revision", "0"],
    ["instructions", "clear", "--expected-revision", "1.5"],
    ["instructions", "show", "--folder", "relative/Folder"],
    ["instructions", "show", "--unknown"],
    ["instructions", "show", "--json", "--json"],
  ]) {
    const output = await runFolderInstructionsCommand(
      args.includes("--folder") ? args : [...args, "--folder", f.folder],
    );
    expect(output.code).toBe(2);
    expect(output.stdout).toBeUndefined();
    expect(output.stderr).toContain("Usage: folder instructions show");
    expect(output.stderr).toContain(folderInstructionsHelp);
  }
  expect((await f.state()).revision).toBe(1);
  // Without --folder: the Environment's own Folder, where one is known.
  expect(
    await runFolderInstructionsCommand(["instructions", "show", "--json"]),
  ).toEqual({
    code: 2,
    stdout: JSON.stringify({ kind: "blocked", reason: "folder-unknown" }),
  });
  expect(
    await runFolderInstructionsCommand(["instructions", "add", "A line."], {
      defaultFolder: async () => undefined,
    }),
  ).toEqual({
    code: 2,
    stdout: "No Folder known: name it with --folder <absolute Folder>.",
  });
  const found = await runFolderInstructionsCommand(
    ["instructions", "add", "Call me Alena.", "--json"],
    { defaultFolder: async () => f.folder },
  );
  expect(found.code).toBe(0);
  expect(JSON.parse(found.stdout ?? "")).toMatchObject({
    kind: "updated",
    revision: 2,
  });
  // A Folder that cannot be read is a failure that echoes nothing of it.
  expect(
    await runFolderInstructionsCommand([
      "instructions",
      "show",
      "--json",
      "--folder",
      join(f.parent, "absent"),
    ]),
  ).toEqual({
    code: 1,
    stdout: JSON.stringify({ kind: "blocked", reason: "folder-unreadable" }),
  });
}, 60_000);

test("the lazurio executable answers folder instructions and lists it in its help", async () => {
  const f = await folderOf("local", null, "en");
  const lazurio = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, resolve("src/cli.ts"), ...args],
      {
        env: {},
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
  const added = await lazurio(
    "folder",
    "instructions",
    "add",
    "Call me Alena.",
    "--folder",
    f.folder,
    "--json",
  );
  expect(added.code, added.stderr).toBe(0);
  expect(JSON.parse(added.stdout)).toEqual({
    kind: "updated",
    revision: 2,
    bytes: 14,
    maxBytes: maxOwnInstructionsBytes,
  });
  const shown = await lazurio(
    "folder",
    "instructions",
    "show",
    "--folder",
    f.folder,
  );
  expect(shown.code).toBe(0);
  expect(shown.stdout).toBe(
    "Own instructions (14 of 4096 bytes), Folder revision 2:\nCall me Alena.\n",
  );
  const wrong = await lazurio("folder", "instructions", "forget");
  expect(wrong.code).toBe(2);
  expect(wrong.stdout).toBe("");
  expect(wrong.stderr).toContain("Usage: folder instructions show");
  const help = await lazurio("--help");
  expect(help.code).toBe(0);
  expect(help.stdout).toContain(folderInstructionsHelp);
}, 60_000);
