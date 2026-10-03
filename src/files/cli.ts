import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  LaunchpadStartRefused,
  readStartState,
} from "../launchpad/start-check";
import {
  type CliContext,
  type CommandOutput,
  operatorFolder,
} from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import {
  accountHome,
  type DocumentsRefusal,
  documentAt,
  isRefused,
  openDocuments,
} from "./documents";
import { filesUrlPath } from "./rules";

/** `lazurio files link <path>`: the link an agent hands the Operator for a
 * file or folder in the Documents folder (decision F34). The same rules and
 * Documents adapter as the Launchpad's Files page; it records nothing. */
export const filesHelp = `files link <path> [--folder <absolute Folder>] [--json]
  The link to a file or folder in the Documents folder of this account
  (~/Documents), for the Operator. The path is absolute or relative to the
  current directory and must exist inside ~/Documents; a name starting with a
  dot is never served. In a Remote Environment with a recorded entry it
  prints <Launchpad origin>/files/<path>: the link opens in the Operator's
  browser behind the Environment's sign-in and downloads the file (a folder
  opens on the Files page). Without an entry it prints the absolute path: on
  a workstation the file is already on the Operator's computer. A path
  outside ~/Documents, hidden or missing is refused: save or copy the file
  into ~/Documents/<task>/ first. --json prints {kind: "files-link", hosted,
  url} or {kind: "files-link", hosted, path}, and {kind: "blocked", reason}
  when refused. The Folder (for the entry) is found as for lazurio doctor.
  Exit status: 0 a link or path, 2 refused or usage, 1 failure.`;

export type FilesContext = CliContext & Readonly<{ cwd: string }>;

const synopsis = "files link <path> [--folder <absolute Folder>] [--json]";

type LinkRefusal = DocumentsRefusal;

// One sentence each, in the Folder's language; never the path, which could
// be private.
const explanations: Readonly<Record<"cs" | "en", Record<LinkRefusal, string>>> =
  {
    en: {
      "outside-documents":
        "The path is not inside ~/Documents. Save or copy the file into ~/Documents/<task>/ first, then run lazurio files link again.",
      "path-hidden":
        "A name on the path starts with a dot: hidden files and folders are never served. Save the file under a visible name in ~/Documents/<task>/.",
      "path-invalid":
        "A name on the path cannot be served (a control character, a separator or an over-long name). Save the file under a plain name in ~/Documents/<task>/.",
      "not-found":
        "Nothing exists at this path. Save the file into ~/Documents/<task>/ first.",
      "not-regular":
        "This is neither a file nor a folder. Only files and folders in ~/Documents are served.",
      "not-directory": "Not a folder.",
      "not-file": "Not a file.",
      "documents-unavailable":
        "~/Documents is not usable here: it is missing, not a folder, or a link to the home folder or the Lazurio Folder.",
    },
    cs: {
      "outside-documents":
        "Cesta neleží v ~/Documents. Nejdřív soubor ulož nebo zkopíruj do ~/Documents/<úkol>/ a pak spusť lazurio files link znovu.",
      "path-hidden":
        "Jméno v cestě začíná tečkou: skryté soubory a složky se nikdy nezpřístupňují. Ulož soubor pod viditelným jménem do ~/Documents/<úkol>/.",
      "path-invalid":
        "Jméno v cestě nejde zpřístupnit (řídicí znak, oddělovač nebo příliš dlouhé jméno). Ulož soubor pod obyčejným jménem do ~/Documents/<úkol>/.",
      "not-found":
        "Na téhle cestě nic není. Nejdřív soubor ulož do ~/Documents/<úkol>/.",
      "not-regular":
        "Tohle není soubor ani složka. Zpřístupňují se jen soubory a složky v ~/Documents.",
      "not-directory": "Není to složka.",
      "not-file": "Není to soubor.",
      "documents-unavailable":
        "~/Documents tu nejde použít: chybí, není to složka, nebo je to link na domovskou složku či Lazurio Folder.",
    },
  };

const notes = {
  hosted: {
    en: "Hand this link to the Operator instead of the path: it opens in their browser behind this Environment's sign-in and downloads the file (a folder opens on the Files page).",
    cs: "Předej Operátorovi tenhle odkaz místo cesty: otevře se mu v prohlížeči za přihlášením tohohle Environmentu a soubor stáhne (složka se otevře na stránce Soubory).",
  },
  local: {
    en: "This Environment has no hosted entry: the file is already on this computer, at this path.",
    cs: "Tenhle Environment nemá hostovaný vstup: soubor už je na tomhle počítači, na téhle cestě.",
  },
  remote: {
    en: "This Remote Environment records no hosted entry yet, so there is no browser link: the file lies at this path here.",
    cs: "Tenhle Remote Environment zatím nemá zaznamenaný hostovaný vstup, takže odkaz do prohlížeče neexistuje: soubor leží tady na téhle cestě.",
  },
} as const;

export async function runFilesCommand(
  args: readonly string[],
  context: FilesContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: ${synopsis}`,
  });
  let values: { json?: boolean | undefined; folder?: string | undefined };
  let target: string;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        folder: { type: "string" },
      },
    });
    values = parsed.values;
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (
      parsed.positionals.length !== 2 ||
      parsed.positionals[0] !== "link" ||
      parsed.positionals[1] === "" ||
      new Set(names).size !== names.length ||
      (values.folder !== undefined &&
        (!isAbsolute(values.folder) ||
          resolve(values.folder) !== values.folder))
    )
      return usage;
    target = parsed.positionals[1] as string;
  } catch {
    return usage;
  }
  const json = values.json === true;
  try {
    const folder = values.folder ?? (await operatorFolder(context));
    // No Folder of its own: a workstation without a supervised unit, which
    // has no recorded entry either.
    const state =
      folder === undefined
        ? null
        : await readStartState(folder, { locked: false });
    const locale = state?.preferences.profile.locale ?? "en";
    const entry = state?.entry ?? null;
    const refuse = (reason: LinkRefusal) =>
      Object.freeze({
        code: exitUsage,
        ...(json
          ? { stdout: JSON.stringify({ kind: "blocked", reason }) }
          : {
              stderr: `Files link refused (${reason}): ${explanations[locale][reason]}`,
            }),
      });
    const absolute = resolve(context.cwd, target);
    const documents = await openDocuments(
      {
        home: accountHome(context.env, context.platform),
        platform: context.platform,
        folder,
      },
      { create: false },
    );
    if (isRefused(documents))
      return refuse(
        documents.refusal === "not-found"
          ? "outside-documents"
          : documents.refusal,
      );
    // Where the path really leads, then whether that is inside ~/Documents
    // and visible, by the same rules the Files page applies to a request.
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      return refuse("not-found");
    }
    const resolved = await documentAt(documents, real);
    if (isRefused(resolved)) return refuse(resolved.refusal);
    if (entry !== null) {
      const url = `${entry.externalOrigin}${filesUrlPath(resolved.segments)}`;
      return Object.freeze({
        code: exitOk,
        ...(json
          ? {
              stdout: JSON.stringify({ kind: "files-link", hosted: true, url }),
            }
          : { stdout: url, stderr: notes.hosted[locale] }),
      });
    }
    // A Remote Environment whose handover has no entry yet.
    const remote = (state?.preferences.machine ?? null) !== null;
    return Object.freeze({
      code: exitOk,
      ...(json
        ? {
            stdout: JSON.stringify({
              kind: "files-link",
              hosted: false,
              path: absolute,
            }),
          }
        : {
            stdout: absolute,
            stderr: (remote ? notes.remote : notes.local)[locale],
          }),
    });
  } catch (error) {
    // The start refusal is an enumerated id; nothing else is printed, since
    // it could quote a private path.
    return Object.freeze({
      code: exitFailure,
      stderr:
        error instanceof LaunchpadStartRefused
          ? `Files link failed: the Folder could not be read (${error.reason})`
          : "Files link failed",
    });
  }
}
