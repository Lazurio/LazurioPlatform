import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Persona } from "../src/buddy/persona";
import { writeBuddyFolderLocked } from "../src/folder/buddy-folder";
import {
  buddyFolderPaths,
  buddyFolderSkillNames,
  renderBuddyAgents,
  renderBuddyFolder,
} from "../src/folder/buddy-gen4";
import { presetProfile } from "../src/folder/presets";
import { instructionTemplateRevision } from "../src/folder/render";

// Buddy GEN4's folder (plan LZD-0033, R2): one AGENTS.md and no CLAUDE.md,
// which both harnesses load (V1 and the first pilot thread), each skill in
// `.agents/skills/` and `.claude/skills/` byte for byte, two profiles of one
// mechanism (Matěj 2026-11-17) and the persona from Settings → Buddy.

const locales = ["cs", "en"] as const;
const source = (locale: "cs" | "en") => ({
  preset: "local",
  machine: null,
  profile: presetProfile("local", "linux", { locale }),
});
const persona: Persona = Object.freeze({
  buddyName: "Bertík",
  address: "ty",
  user: Object.freeze({
    nominative: "Alena",
    accusative: "Alenu",
    dative: "Aleně",
  }),
});
const allowAll = async () => {};

test("the folder holds AGENTS.md and each skill in both harness directories, and no CLAUDE.md", () => {
  expect([...buddyFolderPaths]).toEqual([
    "AGENTS.md",
    ".agents/skills/buddy-vlakna/SKILL.md",
    ".claude/skills/buddy-vlakna/SKILL.md",
    ".agents/skills/buddy-brain/SKILL.md",
    ".claude/skills/buddy-brain/SKILL.md",
  ]);
  for (const locale of locales)
    for (const profile of ["buddy", "employee"] as const) {
      const files = renderBuddyFolder(source(locale), profile, persona);
      expect(Object.keys(files).sort()).toEqual([...buddyFolderPaths].sort());
      expect(Object.keys(files)).not.toContain("CLAUDE.md");
      for (const name of buddyFolderSkillNames)
        expect(files[`.agents/skills/${name}/SKILL.md`]).toBe(
          files[`.claude/skills/${name}/SKILL.md`],
        );
      expect(files["AGENTS.md"]).toContain(instructionTemplateRevision);
    }
});

test("both locales have the same structure", () => {
  for (const profile of ["buddy", "employee"] as const) {
    const cs = renderBuddyFolder(source("cs"), profile, persona);
    const en = renderBuddyFolder(source("en"), profile, persona);
    for (const path of buddyFolderPaths) {
      const headings = (text: string) =>
        text
          .split("\n")
          .map((line) => /^#+ /.exec(line)?.[0] ?? "")
          .join("|");
      expect([path, headings(cs[path])]).toEqual([path, headings(en[path])]);
    }
  }
});

test("Buddy's profile takes over from coordinating threads; the employee's acts within recorded mandates", () => {
  for (const locale of locales) {
    const buddy = renderBuddyAgents(source(locale), "buddy", persona);
    const employee = renderBuddyAgents(source(locale), "employee", persona);
    expect(buddy).toContain("0089");
    expect(buddy).toMatch(/## (Převzetí|Taking over)/);
    expect(employee).toContain("0220");
    expect(employee).not.toMatch(/## (Převzetí|Taking over)/);
  }
});

test("the persona's names and address are filled in; without a persona the text is generic and formal", () => {
  const named = renderBuddyAgents(source("cs"), "buddy", persona);
  expect(named).toContain("Jsi Bertík, Buddy");
  expect(named).toContain("(Alena)");
  expect(named).toContain("Aleně tykáš");
  const generic = renderBuddyAgents(source("cs"), "buddy");
  expect(generic).toContain("Jsi Buddy, Buddy");
  expect(generic).not.toContain("(uživatel)");
  expect(generic).toContain("Uživateli vykáš");
});

test("Buddy GEN4 works with threads and the Brain, not with Hermes, Telegram or bots through Delegace", () => {
  for (const locale of locales)
    for (const profile of ["buddy", "employee"] as const) {
      const text = Object.values(
        renderBuddyFolder(source(locale), profile, persona),
      ).join("\n");
      expect(text).not.toMatch(/Hermes|Telegram|delegace zadej|SOUL\.md/);
      expect(text).toContain("schedule_task");
      expect(text).toContain("Brain");
    }
});

async function home() {
  return mkdtemp(join(tmpdir(), "buddy-gen4-"));
}

test("the folder is created owner-only, written once, and a second refresh writes nothing", async () => {
  const root = await home();
  try {
    const folder = join(root, "Buddy");
    const files = renderBuddyFolder(source("cs"), "buddy", persona);
    expect(await writeBuddyFolderLocked(folder, files, allowAll)).toEqual([
      ...buddyFolderPaths,
    ]);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
      files["AGENTS.md"],
    );
    expect(await writeBuddyFolderLocked(folder, files, allowAll)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an edited file is overwritten and the person's own files beside it stay untouched", async () => {
  const root = await home();
  try {
    const folder = join(root, "Buddy");
    await mkdir(join(folder, "pilot"), { recursive: true, mode: 0o700 });
    await writeFile(join(folder, "pilot", "CO-CHYBI.md"), "moje poznámky\n");
    await writeFile(join(folder, "AGENTS.md"), "ruční pilotní pokyny\n");
    const files = renderBuddyFolder(source("cs"), "buddy", persona);
    const written = await writeBuddyFolderLocked(folder, files, allowAll);
    expect(written).toContain("AGENTS.md");
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
      files["AGENTS.md"],
    );
    expect(await readFile(join(folder, "pilot", "CO-CHYBI.md"), "utf8")).toBe(
      "moje poznámky\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked folder or file is refused and nothing is written through it", async () => {
  const root = await home();
  try {
    const target = join(root, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(root, "Buddy"));
    const files = renderBuddyFolder(source("cs"), "buddy", persona);
    await expect(
      writeBuddyFolderLocked(join(root, "Buddy"), files, allowAll),
    ).rejects.toThrow();
    await expect(lstat(join(target, "AGENTS.md"))).rejects.toThrow();

    const second = join(root, "second");
    await mkdir(join(second, "Buddy"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "outside.md"), "outside\n");
    await symlink(join(root, "outside.md"), join(second, "Buddy", "AGENTS.md"));
    await expect(
      writeBuddyFolderLocked(join(second, "Buddy"), files, allowAll),
    ).rejects.toThrow();
    expect(await readFile(join(root, "outside.md"), "utf8")).toBe("outside\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only an absolute folder named Buddy is accepted", async () => {
  const files = renderBuddyFolder(source("cs"), "buddy", persona);
  await expect(
    writeBuddyFolderLocked("Buddy", files, allowAll),
  ).rejects.toThrow("Invalid Buddy folder");
  const root = await home();
  try {
    await expect(
      writeBuddyFolderLocked(join(root, "Lazurio"), files, allowAll),
    ).rejects.toThrow("Invalid Buddy folder");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
