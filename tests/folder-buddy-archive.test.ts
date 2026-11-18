import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePersona } from "../src/buddy/persona";
import { writeBuddyLocked } from "../src/folder/buddy-folder";
import {
  initializeMachineFolder,
  refreshMachineFolder,
} from "../src/machine/cli";
import { binding, entries } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";

// Buddy GEN3's archives live in `~/Buddy/archiv/` (plan LZD-0033 R6a),
// inside Buddy GEN4's folder, whose files Lazurio writes after every change
// of the Folder: initialization, a refresh and the writer itself leave every
// archive there byte for byte, with its modes.

const posix = test.skipIf(process.platform === "win32");

const noChoices = {
  preset: undefined,
  locale: "cs",
  detail: undefined,
  coordination: undefined,
} as const;

const convertedAt = (parent: string) => {
  const machine = binding({
    ...personal,
    entry: {
      ...entries.personal,
      buddy: {
        generation: 4,
        folder: "/home/operator/Buddy",
        profile: "buddy",
      },
    },
  });
  return {
    ...machine,
    entry: {
      ...(machine.entry as NonNullable<typeof machine.entry>),
      buddyFolder: join(parent, "Buddy"),
    },
  };
};

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (directory: string, prefix: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await lstat(path);
      const key = `${prefix}${name}`;
      if (info.isDirectory()) {
        out[`${key}/`] = (info.mode & 0o777).toString(8);
        await walk(path, `${key}/`);
      } else
        out[key] =
          `${(info.mode & 0o777).toString(8)} ${(await readFile(path)).toString("base64")}`;
    }
  };
  await walk(root, "");
  return out;
}

posix(
  "initialization, a refresh and the writer of Buddy GEN4's folder leave ~/Buddy/archiv/ untouched",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "buddy-archiv-")),
    );
    try {
      const folder = join(parent, "Lazurio");
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o700 });
      await mkdir(join(folder, "personalspace"), { mode: 0o700 });
      // An archive already there before the conversion.
      const archive = join(parent, "Buddy", "archiv");
      const one = join(archive, "buddy-gen3-20261118T090807Z");
      await mkdir(join(one, "attachments"), { recursive: true, mode: 0o700 });
      await writeFile(join(one, "manifest.json"), "{}\n", { mode: 0o600 });
      await writeFile(join(one, "records.jsonl"), '{"id":"x"}\n', {
        mode: 0o600,
      });
      await writeFile(join(one, "attachments", "abc-AGENTS.md"), "bytes", {
        mode: 0o600,
      });
      await writeFile(join(archive, "AGENTS.md"), "not Lazurio's", {
        mode: 0o644,
      });
      const before = await snapshot(archive);

      const machine = convertedAt(parent);
      expect(
        (await initializeMachineFolder(folder, machine, noChoices)).code,
      ).toBe(0);
      expect(await snapshot(archive)).toEqual(before);
      expect((await stat(join(parent, "Buddy", "AGENTS.md"))).isFile()).toBe(
        true,
      );

      // A refresh after the persona changed rewrites Buddy's own files.
      await writePersona(
        parent,
        {
          buddyName: "Bertík",
          address: "ty",
          user: { nominative: "Alena", accusative: "Alenu", dative: "Aleně" },
        },
        null,
      );
      expect((await refreshMachineFolder(folder, machine)).code).toBe(0);
      expect(
        await readFile(join(parent, "Buddy", "AGENTS.md"), "utf8"),
      ).toContain("Jsi Bertík");
      expect(await snapshot(archive)).toEqual(before);

      expect(await writeBuddyLocked(folder, async () => {})).toBeUndefined();
      expect(await snapshot(archive)).toEqual(before);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
