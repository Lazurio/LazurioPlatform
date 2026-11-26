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
  // Visibility: the pinned GBrain's recall gives remote callers (Executor)
  // `world` facts only, so a `private` fact is lost to every agent; a test
  // persona's Buddy saved one as private and could not read it back (rc.3).
  expect(cs).toContain("vrací `recall` jen fakta `world`");
  expect(en).toContain("`recall` returns `world` facts only");
  // Who reads a world fact, as it is: not only the person's agents.
  expect(cs).toContain(
    "agenti Prostředí, mapa paměti v Lazuriu a každý, komu GBrain ke zdroji dal přístup",
  );
  expect(en).toContain(
    "the Environment's agents, the memory map in Lazurio and anyone GBrain grants access to the source",
  );
  // Ordinary facts without visibility; an explicit private choice is kept.
  expect(cs).toContain("zapisuj bez `visibility`");
  expect(en).toContain("without `visibility`");
  expect(cs).toContain("Jeho volbu nikdy sám nerozšiřuj na `world`");
  expect(en).toContain("Never widen their choice to `world` yourself");
  // A private result Buddy did not ask for (GBrain's own default, a private
  // page): no claim of success, no silent rewrite, the person decides, one
  // world write on their yes, and a second private result ends it unresolved.
  expect(cs).toContain(
    "Když `remember` vrátí `visibility: private`, ač jsi `private` neposlal",
  );
  expect(en).toContain(
    "When `remember` returns `visibility: private` though you did not pass `private`",
  );
  expect(cs).toContain(
    "Neříkej, že je zapamatovaný a ověřený, a znovu ho sám nezapisuj",
  );
  expect(en).toContain(
    "Do not say it is remembered and checked, and do not write it again on your own",
  );
  expect(cs).toContain(
    "Teprve na jeho souhlas ho zapiš jednou s `visibility: world`",
  );
  expect(en).toContain(
    "Only on their yes write it once with `visibility: world`",
  );
  expect(cs).toContain(
    "Když i pak přijde `private`, dál nezapisuj a řekni mu, že zápis nejde ověřit",
  );
  expect(en).toContain(
    "When `private` comes back again, write no more and tell them the write cannot be checked",
  );
  // The pinned GBrain refuses a world fact replacing a private one (replaces_visibility_mismatch).
  expect(cs).toContain("GBrain soukromý fakt faktem `world` nenahradí");
  expect(en).toContain("does not let a `world` fact replace a private one");
  for (const text of [cs, en]) {
    expect(text).not.toContain("write it again without `visibility`");
    expect(text).not.toContain("zapiš ho znovu bez `visibility`");
    expect(text).not.toContain("only its person's agents read the facts");
    expect(text).not.toContain("čtou fakta jen agenti jeho člověka");
  }
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

test("Buddy's Brain is the truth and the tool's memory a notebook: the rule, the places and the catch-up (LZD-0033 R11d)", () => {
  for (const locale of locales)
    for (const profile of ["buddy", "employee"] as const) {
      const files = renderBuddyFolder(source(locale), profile, persona);
      const agents = files["AGENTS.md"];
      const skills = [
        files[".agents/skills/buddy-brain/SKILL.md"],
        files[".claude/skills/buddy-brain/SKILL.md"],
      ];
      const cs = locale === "cs";
      // The rule: written in the same turn, the tool's memory a pointer at most.
      expect(agents).toContain(
        cs
          ? "**Paměť nástroje je zápisník.**"
          : "**Your tool's memory is a notebook.**",
      );
      expect(agents).toContain(
        cs ? "ve stejném tahu, kdy vznikly" : "in the same turn they arise",
      );
      expect(agents).toContain(
        cs
          ? "Co v Brainu není, jiný agent neví."
          : "What is not in the Brain, another agent does not know.",
      );
      // Read the Brain after a summary and after a switch of the model.
      expect(agents).toContain(
        cs ? "po přepnutí modelu" : "after a switch of the model",
      );
      // The tool's memory stays on (decided 2026-11-25): nothing switches it off.
      for (const text of Object.values(files)) {
        expect(text).not.toContain("autoMemoryEnabled");
        expect(text).not.toContain("generate_memories");
      }
      for (const skill of skills) {
        // The same four places in every Personal Environment.
        for (const page of [
          "`buddy/dohody`",
          "`buddy/priority`",
          "`buddy/ceka`",
          "`buddy/denik/2026-11`",
        ])
          expect(skill).toContain(page);
        expect(skill).toContain(
          cs ? "deník jen na dotaz" : "the diary only when asked",
        );
        // A decided item keeps the user's words verbatim and the time.
        expect(skill).toContain(
          cs ? "jeho slova doslova a čas" : "their words verbatim and the time",
        );
        // The one catch-up of what is only in the tool's memory today. Its
        // completion is its own record, never the existence of a page an
        // agreement may have created first.
        expect(skill).not.toContain(
          cs
            ? "když stránka `buddy/dohody` ještě neexistuje"
            : "when the page `buddy/dohody` does not exist yet",
        );
        expect(skill).toContain("`buddy/dorovnani`");
        expect(skill).toContain(
          cs
            ? "i když `buddy/dohody` už existuje"
            : "even when `buddy/dohody` already exists",
        );
        // Interrupted: done is written only after both sources are processed
        // and checked, so a half-done catch-up is never marked done.
        expect(skill).toContain(
          cs
            ? "`hotovo` zapiš na `buddy/dorovnani` až po zpracování a ověření obou zdrojů"
            : "Write `hotovo` on `buddy/dorovnani` only after both sources are processed and checked",
        );
        // Repeated: what the Brain holds is not written again, an item leaves
        // the tool's memory only once checked, and the run starts over safely.
        expect(skill).toContain(
          cs
            ? "nejdřív čtením zjisti, jestli už tam je"
            : "first check by reading whether it is already there",
        );
        expect(skill).toContain(
          cs
            ? "ověř čtením a teprve potom ji v paměti nástroje a na staré stránce nahraď odkazem"
            : "check it by reading, and only then replace it with a pointer",
        );
        expect(skill).toContain(
          cs
            ? "přerušené dorovnání jde bezpečně zopakovat od začátku"
            : "an interrupted catch-up can safely start over",
        );
        // Nothing to move is a finished catch-up too.
        expect(skill).toContain(cs ? "i když je to 0" : "also when it is 0");
        expect(skill).toContain(
          cs
            ? "nic jiného z paměti nástroje necituj"
            : "quote nothing else from the tool's memory",
        );
      }
    }
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

test("a thread Buddy started takes its task from him; his main thread takes turns only from the user (#1177)", () => {
  // On Bob's Environment (2026-11-21) both of Buddy's delegated threads loaded
  // these instructions and refused his task as "a message from another thread".
  const cs = renderBuddyFolder(source("cs"), "buddy", persona)["AGENTS.md"];
  const en = renderBuddyFolder(source("en"), "buddy", persona)["AGENTS.md"];
  expect(cs).toContain(
    "Ve svém hlavním vlákně bereš tahy jen od svého uživatele.",
  );
  expect(cs).toContain(
    "je zadání od tohoto rodiče tvoje zadání v rozsahu, který ti dal",
  );
  expect(en).toContain(
    "In your main thread you take turns only from your user.",
  );
  expect(en).toContain(
    "the task from that parent is your task, within the scope it gave you",
  );
  expect(cs).not.toContain("Tahy bereš jen od svého uživatele.");
});
