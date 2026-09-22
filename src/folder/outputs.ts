// The generated files the Folder owns, in one fixed order. Everything that
// journals, stages, renames or verifies generated output iterates this list;
// nothing else in the Folder is written by the product. `AGENTS.md` is the
// per-Machine instruction file; `manual/` is the agent manual shipped with the
// product (decision F14) and rendered from the same inputs.
export const manualEntries = Object.freeze([
  {
    path: "manual/lazurio.md",
    title: "Lazurio",
    summary: "what Lazurio is, the collaboration model and its boundaries",
  },
  {
    path: "manual/this-machine.md",
    title: "This Machine",
    summary: "kind, Owner, preset, zones and what may reach what",
  },
  {
    path: "manual/working-here.md",
    title: "Working here",
    summary: "Draft, Publication, worktrees, handoff and where knowledge goes",
  },
  {
    path: "manual/roles.md",
    title: "Roles",
    summary: "Principal, Kolega, Organization roles, Owner, Buddy, Task Agent",
  },
  {
    path: "manual/glossary.md",
    title: "Glossary",
    summary: "the terms an agent on a Machine needs",
  },
  {
    path: "manual/troubleshooting.md",
    title: "Troubleshooting",
    summary: "product update, Machine inspection, refusals and reporting",
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
