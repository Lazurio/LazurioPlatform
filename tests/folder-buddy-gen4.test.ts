import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Persona } from "../src/buddy/persona";
import {
  buddyGen3Present,
  writeBuddyFolderLocked,
} from "../src/folder/buddy-folder";
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

// How the user decides with Buddy (the first converted person, 2026-11-21):
// Buddy puts decisions into the conversation with a recommendation and a
// sentence to answer with, keeps the question tool for approving the exact
// wording of a message to other people or on request, starts with what is new
// since the user's last message, and keeps one overview file while the user is
// away. An AI employee keeps the question tool for its questions.
test("Buddy decides with the user in the conversation; an AI employee keeps the question tool", () => {
  const words = {
    cs: {
      decide: "- **Rozhodnutí** předkládej v rozhovoru běžnou zprávou",
      tool: "- **Nástroj na otázky** svého harnessu",
      back: "- **Když se uživatel vrátí,** začni tím, co je nové od jeho poslední zprávy",
      away: "- **Když uživatel není k dispozici**",
      employee: "- **Otázky** pokládej nástrojem na otázky svého harnessu",
    },
    en: {
      decide: "- **Decisions** go into the conversation as an ordinary message",
      tool: "- **The question tool** of your harness",
      back: "- **When the user comes back,** start with what is new since their last message",
      away: "- **When the user is not available**",
      employee: "- **Questions** go through your harness's question tool",
    },
  } as const;
  for (const locale of locales) {
    const w = words[locale];
    const buddy = renderBuddyAgents(source(locale), "buddy", persona);
    for (const line of [w.decide, w.tool, w.back, w.away])
      expect(buddy).toContain(line);
    expect(buddy).not.toContain(w.employee);
    const employee = renderBuddyAgents(source(locale), "employee", persona);
    expect(employee).toContain(w.employee);
    for (const line of [w.decide, w.tool, w.back, w.away])
      expect(employee).not.toContain(line);
  }
});

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

test("informal address from Settings → Buddy says it overrides the tone block's formal address", () => {
  const named = renderBuddyAgents(source("cs"), "buddy", persona);
  // The default tone block asks for vykání; the persona's tykání must win,
  // and say so, so that the text does not contradict itself.
  expect(named).toContain("V češtině uživateli standardně vykej");
  expect(named).toContain(
    "Aleně tykáš, jak si uživatel nastavil v Nastavení → Buddy; tato volba má přednost před větou o vykání v bloku tónu výše.",
  );
  expect(renderBuddyAgents(source("en"), "buddy", persona)).toContain(
    "this choice takes precedence over the sentence on formal address in the tone block above",
  );
  // Formal address needs no exception.
  expect(renderBuddyAgents(source("cs"), "buddy")).not.toContain(
    "má přednost před větou o vykání",
  );
});

test("while Buddy GEN3 is still in the home, the text says to leave his folders, services and chat alone", () => {
  for (const locale of locales)
    for (const profile of ["buddy", "employee"] as const) {
      const without = renderBuddyAgents(source(locale), profile, persona);
      const beside = renderBuddyAgents(source(locale), profile, persona, {
        gen3: true,
      });
      for (const word of [
        "~/.t3-buddy",
        "~/.hermes",
        "lazurio-t3-buddy.service",
      ])
        expect({
          locale,
          profile,
          word,
          without: without.includes(word),
        }).toEqual({ locale, profile, word, without: false });
      expect(beside).toContain("~/.t3-buddy");
      expect(beside).toContain("~/.hermes");
      expect(beside).toContain("hermes-gateway.service");
      expect(beside).toContain("~/Buddy/archiv/");
    }
  const cs = renderBuddyAgents(source("cs"), "buddy", persona, { gen3: true });
  expect(cs).toContain("Na tyto složky a služby nesahej");
  // A precaution, never a claim about the archive's state: the folders may
  // still be there after a verified archive (R9 removes them later).
  expect(cs).toContain("Mohou být zdrojem jeho rozhovoru");
  expect(cs).not.toContain("Jen tam je jeho rozhovor");
  expect(cs).not.toContain("teprve vyvézt");
  const en = renderBuddyAgents(source("en"), "buddy", persona, { gen3: true });
  expect(en).toContain("They may be the source of his conversation");
  expect(en).not.toContain("is only there");
  expect(en).not.toContain("yet to be exported");
  // Only AGENTS.md changes; the skills are the same bytes.
  const plain = renderBuddyFolder(source("cs"), "buddy", persona);
  const gen3 = renderBuddyFolder(source("cs"), "buddy", persona, {
    gen3: true,
  });
  for (const path of buddyFolderPaths)
    if (path !== "AGENTS.md") expect(gen3[path]).toBe(plain[path]);
  expect(gen3["AGENTS.md"]).not.toBe(plain["AGENTS.md"]);
});

test("Buddy GEN3 counts as present while ~/.t3-buddy or ~/.hermes exists in any form", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "buddy-gen3-")));
  try {
    expect(await buddyGen3Present(home)).toBe(false);
    await mkdir(join(home, ".hermes"));
    expect(await buddyGen3Present(home)).toBe(true);
    await rm(join(home, ".hermes"), { recursive: true });
    await symlink(join(home, "elsewhere"), join(home, ".t3-buddy"));
    expect(await buddyGen3Present(home)).toBe(true);
    await rm(join(home, ".t3-buddy"));
    await writeFile(join(home, ".hermes"), "");
    expect(await buddyGen3Present(home)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("buddy-brain: what the pinned GBrain asks for, checked against its source", () => {
  const skill = (locale: "cs" | "en") =>
    renderBuddyFolder(source(locale), "buddy", persona)[
      ".agents/skills/buddy-brain/SKILL.md"
    ];
  const cs = skill("cs");
  const en = skill("en");
  // No connection name from memory: the tools are what Executor offers.
  expect(cs).not.toContain("user.personal");
  expect(cs).toContain("Jména nástrojů ber z toho, co ti Executor nabídne");
  expect(en).toContain("Take the tool names from what Executor offers you");
  // remember: provenance required, entity is the subject's name or slug.
  expect(cs).toContain("`provenance` (povinná");
  expect(en).toContain("the name or slug of whom or what the fact is about");
  // GBrain says "Not for facts about a person" of `share`, not `visibility`.
  expect(cs).toContain("nepoužívej `share: true`");
  expect(en).toContain("Do not use `share: true`");
  // put_page on an existing page needs the revision, and a refusal changes nothing.
  expect(cs).toContain("`revision_required` a nic nezmění");
  expect(en).toContain("ends with `revision_required` and changes nothing");
  // A page changes through edit_page; the quote wrapper the pinned GBrain may
  // put around any read (quoted: "transcript") is never part of a write.
  expect(cs).toContain("**Úprava existující stránky:** vždy `edit_page`");
  expect(en).toContain("**Changing an existing page:** always `edit_page`");
  for (const text of [cs, en]) {
    expect(text).toContain("`include_content: true`");
    expect(text).toContain('`quoted: "transcript"`');
  }
  expect(cs).toContain("Obal není součást textu stránky");
  expect(en).toContain("The wrapper is not part of the page's text");
  // new_text is the wanted replacement, never taken from the read.
  expect(cs).toContain(
    "`new_text` napiš sám jako požadovanou náhradu, bez obalu",
  );
  expect(en).toContain(
    "write `new_text` yourself as the replacement you want, without the wrapper",
  );
  for (const text of [cs, en])
    expect(text).toContain("`edits: [{ old_text, new_text }]`");
  expect(cs).not.toContain("Stránku priorit přepisuješ");
  expect(en).not.toContain("You rewrite the priorities page");
  // The degraded signals the pinned GBrain really sends (no
  // `semantic_degraded`): empty is no proof while one of them is there.
  for (const text of [cs, en]) {
    expect(text).not.toContain("semantic_degraded");
    for (const signal of [
      "`facts_degraded`",
      "`search_degraded`",
      "`degraded_recall`",
      "`_meta.retrieval.degraded`",
    ])
      expect(text).toContain(signal);
  }
  expect(cs).toContain("neznamená, že tam nic není");
  expect(en).toContain("no proof that nothing is there");
});

test("buddy-vlakna: no question tool on a round, and a status file's first sentence checked at its source", () => {
  const skill = (locale: "cs" | "en") =>
    renderBuddyFolder(source(locale), "buddy", persona)[
      ".agents/skills/buddy-vlakna/SKILL.md"
    ];
  expect(skill("cs")).toContain("Na obchůzce se neptej nástrojem na otázky");
  expect(skill("cs")).toContain("naplánované úlohy vlákna neběží");
  expect(skill("cs")).toContain("ověř u zdroje");
  expect(skill("en")).toContain("Do not ask with the question tool on a round");
  expect(skill("en")).toContain("the thread's scheduled tasks do not run");
  expect(skill("en")).toContain("at its source");
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
  // Canonical: on macOS `tmpdir()` is behind the `/var` symlink, which the
  // Buddy folder's parent check refuses, as it would any symlinked home.
  return realpath(await mkdtemp(join(tmpdir(), "buddy-gen4-")));
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

test("the threads skill answers a pending question elsewhere directly, by link or with t3 request over SSH", () => {
  for (const locale of locales) {
    const skill = renderBuddyFolder(source(locale), "buddy", persona)[
      ".agents/skills/buddy-vlakna/SKILL.md"
    ];
    expect(skill).toContain("t3 request list --thread <id> --json");
    expect(skill).toContain(
      't3 request respond <requestId> --thread <id> --answer "<label>"',
    );
  }
});

test("Buddy reads a Lazurio mechanism in the manual before he says how it works", () => {
  // Matěj 2026-11-21 (plan LZD-0033 task-2026-11-21-830): twice Buddy guessed
  // a mechanism wrong; he reads it in ~/Lazurio/manual/ instead of guessing.
  for (const profile of ["buddy", "employee"] as const) {
    const cs = renderBuddyFolder(source("cs"), profile, persona)["AGENTS.md"];
    const en = renderBuddyFolder(source("en"), profile, persona)["AGENTS.md"];
    expect(cs).toContain("přečti si ho v `~/Lazurio/manual/`; neodhaduj");
    expect(en).toContain("read it in `~/Lazurio/manual/`; do not guess");
    expect(cs).not.toContain("zbytek si přečti, když ho potřebuješ");
    expect(en).not.toContain("read the rest when you need it");
  }
});
