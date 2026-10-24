// The generated files the Folder owns, in one fixed order. Everything that
// journals, stages, renames or verifies generated output iterates this list;
// nothing else in the Folder is written by the product. `AGENTS.md` is the
// per-Machine instruction file; `manual/` is the agent manual shipped with the
// product (decision F14) and the skills below are its procedures, all rendered
// from the same inputs.
export const manualEntries = Object.freeze([
  {
    path: "manual/lazurio.md",
    title: { cs: "Lazurio", en: "Lazurio" },
    summary: {
      cs: "co je Lazurio, model spolupráce a jeho hranice",
      en: "what Lazurio is, the collaboration model and its boundaries",
    },
  },
  {
    path: "manual/this-machine.md",
    title: { cs: "Tenhle Environment", en: "This Environment" },
    summary: {
      cs: "druh, Owner, preset, zóny, co kam smí, jak s tebou uživatel pracuje, zapnuté nástroje a SSH na další Environmenty a zařízení",
      en: "kind, Owner, preset, zones, what may reach what, how the user works with you, enabled tools and SSH to other Environments and devices",
    },
  },
  {
    path: "manual/working-here.md",
    title: { cs: "Jak se tu pracuje", en: "Working here" },
    summary: {
      cs: "pull requesty a Publikace, worktrees, Git a GitHub, forky, bezpečné návyky, nálezy z review, handoff, otevřené otázky, chybějící práva, kam patří poznatky, jak se v Lazuriu staví, Integrace a tajné údaje",
      en: "pull requests and Publication, worktrees, Git and GitHub, forks, safe habits, review findings, handoff, open questions, missing rights, where knowledge goes, how Lazurio is built, Integrations and secrets",
    },
  },
  {
    path: "manual/roles.md",
    title: { cs: "Role", en: "Roles" },
    summary: {
      cs: "Uživatel, Kolega, role v Organizaci, Owner, Buddy, Task Agent",
      en: "User, Kolega, Organization roles, Owner, Buddy, Task Agent",
    },
  },
  {
    path: "manual/glossary.md",
    title: { cs: "Slovník", en: "Glossary" },
    summary: {
      cs: "pojmy, které agent na Environmentu potřebuje",
      en: "the terms an agent in an Environment needs",
    },
  },
  {
    path: "manual/troubleshooting.md",
    title: {
      cs: "Instalace, aktualizace a řešení problémů",
      en: "Installation, updates and troubleshooting",
    },
    summary: {
      cs: "jak je tu Lazurio nainstalované a jak se průběžně aktualizuje i s checkouty, identita Environmentu, odmítnutí a hlášení problémů",
      en: "how Lazurio is installed here and kept current with the checkouts, the Environment's identity, refusals and reporting",
    },
  },
] as const);

export const manualPaths = Object.freeze(
  manualEntries.map((entry) => entry.path),
);
export type ManualPath = (typeof manualEntries)[number]["path"];

// The agent skills the Folder carries (decision F14, addendum of 2026-10-14):
// one `SKILL.md` per skill and harness, byte-identical, where each harness
// discovers project skills in its working directory, the Folder's root:
// Codex in `.agents/skills/`, Claude Code in `.claude/skills/`. Lazurio owns
// these files only, never the directories around them, which may hold the
// person's own skills and settings. A further skill is one more name here
// and its text in `skills.ts`.
export const skillNames = Object.freeze(["new-module"] as const);
export type SkillName = (typeof skillNames)[number];
export const skillRoots = Object.freeze([
  ".agents/skills",
  ".claude/skills",
] as const);
export type SkillPath = `${(typeof skillRoots)[number]}/${SkillName}/SKILL.md`;
export const skillPaths: readonly SkillPath[] = Object.freeze(
  skillNames.flatMap((name) =>
    skillRoots.map((root): SkillPath => `${root}/${name}/SKILL.md`),
  ),
);

// Buddy's Lazurio layer (root decision 0210 with its addenda of 2026-10-20
// evening, point 1, and night; decision F14's addendum of 2026-10-21): the
// role and rules and the Lazurio skills Lazurio delivers to every Buddy, all
// in `.agents/buddy/`, Buddy's working directory (`terminal.cwd`). Hermes
// loads `.hermes.md` from its working directory instead of AGENTS.md and the
// skills through `skills.external_dirs: [<Folder>/.agents/buddy/skills]`,
// its lowest tier, so a variant Buddy keeps in `~/.hermes/skills` shadows
// the Lazurio skill of the same name (Lazurio/hermes-agent d923a5eb,
// agent/prompt_builder.py and agent/skill_utils.py). No harness discovers
// this directory (Codex reads `.agents/skills/`), and it stays inside the
// owned `.agents/`, so the Folder's top level is unchanged. Nobody but
// Lazurio owns these files: they are no output of the digest manifest, and
// every change of the Folder writes them over whatever is there
// (`buddy-layer.ts`). A name never leaves this list without a removal step:
// a dropped file would stay and Hermes would keep loading it.
export const buddyDirectory = ".agents/buddy" as const;
export const buddySkillNames = Object.freeze([
  "lazurio-t3-orchestration",
  "lazurio-mausbot",
  "lazurio-buddy-pomocnici",
] as const);
export type BuddySkillName = (typeof buddySkillNames)[number];
export type BuddyLayerPath =
  | `${typeof buddyDirectory}/.hermes.md`
  | `${typeof buddyDirectory}/skills/lazurio/${BuddySkillName}/SKILL.md`;
export const buddyRulesPath = `${buddyDirectory}/.hermes.md` as const;
export const buddySkillPath = (name: BuddySkillName): BuddyLayerPath =>
  `${buddyDirectory}/skills/lazurio/${name}/SKILL.md`;
export const buddyLayerPaths: readonly BuddyLayerPath[] = Object.freeze([
  buddyRulesPath,
  ...buddySkillNames.map(buddySkillPath),
]);

// A file the product writes in the Folder: a digest-owned output or a file of
// Buddy's Lazurio layer.
export type FolderFilePath = OutputPath | BuddyLayerPath;

export const outputPaths = Object.freeze([
  "AGENTS.md",
  ...manualPaths,
  ...skillPaths,
] as const);
export type OutputPath = "AGENTS.md" | ManualPath | SkillPath;

// The outputs a manifest of each schema records (decision F14, addendum of
// 2026-10-14). Schema 2 is the Folder before the skills: AGENTS.md and the
// manual. A release that renders an output an older Folder does not record
// creates it in that Folder's upgrade, where its absence is the proof that
// nothing of the person's is replaced. Schema 3 records every output of this
// product.
export const manifestOutputPaths = Object.freeze({
  2: Object.freeze(["AGENTS.md", ...manualPaths] as OutputPath[]),
  3: outputPaths as readonly OutputPath[],
} as const);

export function isOutputPath(value: unknown): value is OutputPath {
  return (
    typeof value === "string" &&
    (outputPaths as readonly string[]).includes(value)
  );
}

// Where an output lives inside the Folder: the top level, the owned
// `manual/` directory (created by initialization only), or a skill's
// directory, which the writing transaction creates where it is absent.
export function outputFile(folder: string, path: FolderFilePath) {
  const separator = path.lastIndexOf("/");
  if (separator === -1) return { directory: folder, name: path };
  return {
    directory: `${folder}/${path.slice(0, separator)}`,
    name: path.slice(separator + 1),
  };
}

// The directories an output lies in, Folder-relative, outermost first:
// none for AGENTS.md, `manual` for a manual file, `.agents`,
// `.agents/skills` and `.agents/skills/<name>` for a Codex skill.
export function outputDirectories(path: FolderFilePath): readonly string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

// One flat name per output inside a transaction or journal directory, so the
// exact-entry checks of the transaction stay one level deep.
export function stagedName(path: OutputPath): string {
  return path.replaceAll("/", "-");
}

export function receiptName(path: OutputPath): string {
  return path === "AGENTS.md"
    ? "created-agents.json"
    : `created-${stagedName(path).replace(/\.md$/, "")}.json`;
}
