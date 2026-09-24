// The generated files the Folder owns, in one fixed order. Everything that
// journals, stages, renames or verifies generated output iterates this list;
// nothing else in the Folder is written by the product. `AGENTS.md` is the
// per-Machine instruction file; `manual/` is the agent manual shipped with the
// product (decision F14) and rendered from the same inputs.
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
    title: { cs: "Tahle Mašina", en: "This Machine" },
    summary: {
      cs: "druh, Owner, preset, zóny, co kam smí a SSH na další Mašiny",
      en: "kind, Owner, preset, zones, what may reach what and SSH to other Machines",
    },
  },
  {
    path: "manual/working-here.md",
    title: { cs: "Jak se tu pracuje", en: "Working here" },
    summary: {
      cs: "Draft, Publikace, worktrees, handoff a kam patří poznatky",
      en: "Draft, Publication, worktrees, handoff and where knowledge goes",
    },
  },
  {
    path: "manual/roles.md",
    title: { cs: "Role", en: "Roles" },
    summary: {
      cs: "Principál, Kolega, role v Organizaci, Owner, Buddy, Task Agent",
      en: "Principal, Kolega, Organization roles, Owner, Buddy, Task Agent",
    },
  },
  {
    path: "manual/glossary.md",
    title: { cs: "Slovník", en: "Glossary" },
    summary: {
      cs: "pojmy, které agent na Mašině potřebuje",
      en: "the terms an agent on a Machine needs",
    },
  },
  {
    path: "manual/troubleshooting.md",
    title: { cs: "Řešení problémů", en: "Troubleshooting" },
    summary: {
      cs: "aktualizace produktu a obsahu, Machine identita, odmítnutí a hlášení problémů",
      en: "product and content updates, Machine identity, refusals and reporting",
    },
  },
] as const);

export const manualPaths = Object.freeze(
  manualEntries.map((entry) => entry.path),
);
export type ManualPath = (typeof manualEntries)[number]["path"];
export const outputPaths = Object.freeze([
  "AGENTS.md",
  ...manualPaths,
] as const);
export type OutputPath = (typeof outputPaths)[number];

export function isOutputPath(value: unknown): value is OutputPath {
  return (
    typeof value === "string" &&
    (outputPaths as readonly string[]).includes(value)
  );
}

// Where an output lives inside the Folder: the top level, or the owned
// `manual/` directory. The directory is created by initialization only.
export function outputFile(folder: string, path: OutputPath) {
  const separator = path.indexOf("/");
  if (separator === -1) return { directory: folder, name: path };
  return {
    directory: `${folder}/${path.slice(0, separator)}`,
    name: path.slice(separator + 1),
  };
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
