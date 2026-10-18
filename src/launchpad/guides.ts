import type { ShellEnvironmentKind } from "../shell/contract";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// The Launchpad's part in the shell's guide (decision F56): which
// explanation the "?" beside a page's heading plays, and the explanations of
// the page shown that the Launchpad hands over (`provideGuides`), since they
// point at its own elements by their `data-guide` marks. A variant is chosen
// only from facts the page knows, here the Environment's kind from the
// shell's document, never from an Organization's name
// (Lazurio/LazurioPlatform#499). Soubory is the first page with a "?"
// (plan DEV-6612, PR 4): the shell's principle "files" explains it, and a
// Team Environment's own explanation adds that the whole Team shares the
// folder. Pure: ui.ts hands the result to the shell.

/** An explanation as `provideGuides` takes it. */
export type PageGuideInput = Readonly<{
  id: string;
  title: string;
  steps: readonly Readonly<{ text: string; at: string }>[];
}>;

export type PageGuide = Readonly<{
  /** The id the page's "?" plays; null where the page has no "?". */
  help: string | null;
  /** The explanations of this page the Launchpad hands over. */
  guides: readonly PageGuideInput[];
}>;

/** The Files page of a Team Environment: the folder is the Team's. */
export const filesTeamGuide = (copy: Copy): PageGuideInput => ({
  id: "files-team",
  title: copy.filesTitle,
  steps: [
    { text: copy.guideFilesTeamDrag, at: "tab-chat" },
    { text: copy.guideFilesTeamShow, at: "files-list" },
    { text: copy.guideFilesTeamShared, at: "files-list" },
  ],
});

/** The guide of a route in an Environment of `kind` (null: not known yet;
 * an automated Environment is a work one). */
export function pageGuide(
  route: PageRoute,
  kind: ShellEnvironmentKind | null,
  copy: Copy,
): PageGuide {
  if (route.view === "files")
    return kind === "team"
      ? { help: "files-team", guides: [filesTeamGuide(copy)] }
      : { help: "files", guides: [] };
  return { help: null, guides: [] };
}
