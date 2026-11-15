import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FolderAdoptionError } from "./handover-layout";
import { readFolderOwnInstructions } from "./inspect-own-instructions";
import { FolderOperationBusyError } from "./lock";
import {
  maxOwnInstructionsBytes,
  type OwnInstructionsProblem,
  ownInstructionsNotice,
  ownInstructionsProblem,
} from "./own-instructions";
import { updateOwnInstructions } from "./update-profile";

/** `lazurio folder instructions`: the terminal surface of the person's own
 * instructions for agents (root decision 0233, decision F14's addendum of
 * 2026-11-06). An agent uses it only on the person's word. */
export const folderInstructionsHelp = `folder instructions show [--folder <absolute Folder>] [--json]
  The user's own instructions for agents in this Environment's Folder: the
  text (or that there is none), its size in UTF-8 bytes and the bound (${maxOwnInstructionsBytes}),
  the Folder's revision and whether this Environment has own instructions at
  all. The user's own computer, a Personal Environment and a Work Environment
  assigned to one person have them; a Team Environment, an Environment with
  automations and a public Environment have none. Read-only.
folder instructions add <line> [--folder <absolute Folder>] [--expected-revision <n>] [--json]
  Appends one line to the own instructions (after -- when it starts with a
  dash). Only on the user's word: propose the exact line first.
folder instructions set (--file <path> | --text <text>) [--folder <absolute Folder>] [--expected-revision <n>] [--json]
  Replaces the whole text; a file is UTF-8 and its final line end is not part
  of the text.
folder instructions clear [--folder <absolute Folder>] [--expected-revision <n>] [--json]
  Removes the own instructions.
  The text is plain: no control characters but tab and line ends, at most
  ${maxOwnInstructionsBytes} UTF-8 bytes. The Folder renders it in AGENTS.md right after the
  communication voice, through the profile transaction (recovery:
  profile-resume), so a change is a new rendering and never drift. Own
  instructions say how agents work with the user and grant nothing; Lazurio's
  rules and the Organization's win. Together with a custom communication
  voice they share one budget in AGENTS.md (person-text-too-large names the
  sizes). The command reads the Folder's revision itself;
  --expected-revision refuses when the Folder is at another one. Without
  --folder, the Environment's own Folder. In a Work Environment every answer
  of a change says that the instructions belong to the Organization with the
  Environment and that its Admins may read them ("notice" in --json): say it
  to the user before the first saved line.
  Exit status: 0 read, saved or unchanged, 2 blocked or usage, 1 failure.`;

const usage =
  "Usage: folder instructions show [--folder <Folder>] [--json] | folder instructions add <line> [--folder <Folder>] [--expected-revision <n>] [--json] | folder instructions set (--file <path> | --text <text>) [--folder <Folder>] [--expected-revision <n>] [--json] | folder instructions clear [--folder <Folder>] [--expected-revision <n>] [--json]";

export type FolderInstructionsOutput = Readonly<{
  code: number;
  stdout?: string;
  stderr?: string;
}>;

export type FolderInstructionsContext = Readonly<{
  /** The Folder a command without --folder speaks about: the Environment's
   * own, found as `lazurio integrations` finds it (`operatorFolder`).
   * Absent or undefined, none: the command asks for --folder. */
  defaultFolder?: (() => Promise<string | undefined>) | undefined;
}>;

type Locale = "cs" | "en";
type Words = Readonly<Record<Locale, string>>;
type Command = "add" | "set" | "clear";
// The file of `set --file` is read whole; anything this large is not own
// instructions, whatever it holds.
const maxFileBytes = 64 * 1024;

const none: Words = {
  cs: "Toto Prostředí vlastní pokyny uživatele nemá: mají je jen vlastní počítač uživatele, Osobní Prostředí a Pracovní Prostředí přiřazené jednomu člověku.",
  en: "This Environment has no own instructions of a user: only the user's own computer, a Personal Environment and a Work Environment assigned to one person have them.",
};

const invalid: Readonly<
  Record<OwnInstructionsProblem | "not-one-line", Words>
> = {
  "not-text": {
    cs: "text se nepodařilo přečíst jako UTF-8",
    en: "the text could not be read as UTF-8",
  },
  blank: {
    cs: "text je prázdný; vlastní pokyny odstraní `lazurio folder instructions clear`",
    en: "the text is empty; `lazurio folder instructions clear` removes the own instructions",
  },
  "not-plain-text": {
    cs: "vlastní pokyny jsou prostý text bez řídicích znaků (kromě tabulátoru a konce řádku)",
    en: "own instructions are plain text without control characters (other than tab and line ends)",
  },
  "too-long": {
    cs: "text má {bytes} bajtů a vlastní pokyny smí mít nejvýš {maxBytes}",
    en: "the text takes {bytes} bytes and own instructions may take {maxBytes} at most",
  },
  "not-one-line": {
    cs: "`add` přidává jeden neprázdný řádek; víc řádků uloží `lazurio folder instructions set`",
    en: "`add` appends one line that is not empty; `lazurio folder instructions set` saves several",
  },
};

// A blocked reason in one clear sentence; any other is named as it is.
const blocked: Readonly<Record<string, Words>> = {
  "own-instructions-unavailable": none,
  "person-text-too-large": {
    cs: "Vlastní pokyny se nevejdou vedle tónu komunikace: tón má {voiceBytes} bajtů a oddíl vlastních pokynů {instructionsBytes}, dohromady smí mít nejvýš {maxBytes}. Kratší musí být pokyny, nebo vlastní tón.",
    en: "The own instructions do not fit next to the communication voice: the voice takes {voiceBytes} bytes and the section of own instructions {instructionsBytes}, and together they may take {maxBytes} at most. Either the instructions or the custom voice has to be shorter.",
  },
  "voice-context-too-large": {
    cs: "S tímto textem by `AGENTS.md` přesáhl 32 KiB, které harness načte.",
    en: "With this text `AGENTS.md` would exceed the 32 KiB a harness loads.",
  },
  "stale-revision": {
    cs: "Folder se mezitím změnil; stejný příkaz stačí spustit znovu.",
    en: "The Folder changed meanwhile; running the same command again is enough.",
  },
  "folder-busy": {
    cs: "S Folderem právě pracuje jiná operace Lazuria; stejný příkaz stačí za chvíli spustit znovu.",
    en: "Another Lazurio operation holds this Folder; running the same command again in a moment is enough.",
  },
};

const fill = (text: string, values: Readonly<Record<string, unknown>>) =>
  text.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => String(values[key]));

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

function usageError(message?: string): FolderInstructionsOutput {
  return {
    code: 2,
    stderr: `${message === undefined ? "" : `${message}\n`}${usage}\n${folderInstructionsHelp}`,
  };
}

type Options = {
  folder?: string | undefined;
  json?: boolean | undefined;
  file?: string | undefined;
  text?: string | undefined;
  "expected-revision"?: string | undefined;
};

export async function runFolderInstructionsCommand(
  args: readonly string[],
  context: FolderInstructionsContext = {},
): Promise<FolderInstructionsOutput> {
  let values: Options;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      tokens: true,
      allowPositionals: true,
      options: {
        folder: { type: "string" },
        json: { type: "boolean" },
        file: { type: "string" },
        text: { type: "string" },
        "expected-revision": { type: "string" },
      },
    });
    ({ values, positionals } = parsed);
    const supplied = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (supplied.has(token.name)) throw new Error("Duplicate command option");
      supplied.add(token.name);
    }
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const [group, command, ...rest] = positionals;
  const expected = values["expected-revision"];
  if (
    group !== "instructions" ||
    (command !== "show" &&
      command !== "add" &&
      command !== "set" &&
      command !== "clear") ||
    rest.length !== (command === "add" ? 1 : 0) ||
    // Options of one command only.
    ((values.file !== undefined || values.text !== undefined) &&
      command !== "set") ||
    (command === "set" &&
      (values.file === undefined) === (values.text === undefined)) ||
    (expected !== undefined &&
      (command === "show" ||
        !/^[1-9][0-9]*$/.test(expected) ||
        !Number.isSafeInteger(Number(expected)))) ||
    (values.folder !== undefined &&
      (!isAbsolute(values.folder) || resolve(values.folder) !== values.folder))
  )
    return usageError();
  const json = values.json === true;
  const folder = values.folder ?? (await context.defaultFolder?.());
  if (folder === undefined)
    return {
      code: 2,
      stdout: json
        ? JSON.stringify({ kind: "blocked", reason: "folder-unknown" })
        : "No Folder known: name it with --folder <absolute Folder>.",
    };
  let recorded: Awaited<ReturnType<typeof readFolderOwnInstructions>>;
  try {
    recorded = await readFolderOwnInstructions(folder);
  } catch (error) {
    if (error instanceof FolderOperationBusyError)
      return {
        code: 2,
        stdout: json
          ? JSON.stringify({
              kind: "blocked",
              reason: "folder-busy",
              retryable: true,
            })
          : (blocked["folder-busy"]?.en ?? ""),
      };
    // Neither the path nor the state's content is echoed.
    return {
      code: 1,
      stdout: json
        ? JSON.stringify({ kind: "blocked", reason: "folder-unreadable" })
        : "The Folder's own instructions could not be read (lazurio doctor says why).",
    };
  }
  const locale: Locale = recorded.locale;
  // Whose they are, with every answer on a Work Environment.
  const notice =
    recorded.allowed && recorded.ofOrganization
      ? { notice: ownInstructionsNotice[locale] }
      : {};
  const answer = (
    code: number,
    result: Record<string, unknown>,
    text: string,
  ): FolderInstructionsOutput => ({
    code,
    stdout: json
      ? JSON.stringify({ ...result, ...notice })
      : "notice" in notice
        ? `${text}\n${notice.notice}`
        : text,
  });
  if (command === "show") {
    const result = {
      kind: "own-instructions",
      revision: recorded.revision,
      allowed: recorded.allowed,
      text: recorded.text,
      bytes: recorded.bytes,
      maxBytes: recorded.maxBytes,
    };
    if (!recorded.allowed)
      return answer(
        0,
        result,
        recorded.text === ""
          ? none[locale]
          : `${none[locale]} ${
              locale === "cs"
                ? "Uložený text se nevykresluje; odstraní ho `lazurio folder instructions clear`."
                : "The recorded text is not rendered; `lazurio folder instructions clear` removes it."
            }`,
      );
    return answer(
      0,
      result,
      recorded.text === ""
        ? fill(
            locale === "cs"
              ? "Vlastní pokyny: žádné (0 z {maxBytes} bajtů). Revize Folderu {revision}."
              : "Own instructions: none (0 of {maxBytes} bytes). Folder revision {revision}.",
            result,
          )
        : `${fill(
            locale === "cs"
              ? "Vlastní pokyny ({bytes} z {maxBytes} bajtů), revize Folderu {revision}:"
              : "Own instructions ({bytes} of {maxBytes} bytes), Folder revision {revision}:",
            result,
          )}\n${recorded.text}`,
    );
  }
  const refused = (
    reason: string,
    details: Record<string, unknown>,
    sentence: string,
  ) =>
    answer(
      2,
      { kind: "blocked", reason, ...details },
      `${locale === "cs" ? "Neuloženo" : "Not saved"}: ${sentence}`,
    );
  const refusedText = (
    problem: OwnInstructionsProblem | "not-one-line",
    size: number,
  ) => {
    const details = {
      problem,
      bytes: size,
      maxBytes: maxOwnInstructionsBytes,
    };
    return refused(
      "own-instructions-invalid",
      details,
      `${fill(invalid[problem][locale], details)}.`,
    );
  };
  // The whole next text: the recorded one with the line appended, the given
  // one, or none.
  let next: string;
  if (command === "add") {
    const line = rest[0] ?? "";
    if (/[\n\r]/.test(line) || line.trim().length === 0)
      return refusedText("not-one-line", bytesOf(line));
    next =
      recorded.text === ""
        ? line
        : `${recorded.text}${recorded.text.endsWith("\n") ? "" : "\n"}${line}`;
  } else if (command === "set") {
    if (values.file === undefined) next = values.text ?? "";
    else {
      let content: Buffer;
      try {
        const { size } = await stat(values.file);
        if (size > maxFileBytes) return refusedText("too-long", size);
        content = await readFile(values.file);
      } catch {
        return answer(
          1,
          { kind: "blocked", reason: "file-unreadable" },
          locale === "cs"
            ? "Soubor s textem se nepodařilo přečíst."
            : "The file with the text could not be read.",
        );
      }
      try {
        next = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(content)
          // The file's final line end is the file's, not the text's.
          .replace(/\r?\n$/, "");
      } catch {
        return refusedText("not-text", content.length);
      }
    }
    if (next === "") return refusedText("blank", 0);
  } else next = "";
  const problem = ownInstructionsProblem(next);
  if (problem !== null) return refusedText(problem, bytesOf(next));
  // The revision the command decided against: the one it read, which the
  // caller may hold it to.
  if (expected !== undefined && Number(expected) !== recorded.revision)
    return refused(
      "stale-revision",
      {},
      blocked["stale-revision"]?.[locale] ?? "",
    );
  const size = { bytes: bytesOf(next), maxBytes: maxOwnInstructionsBytes };
  let result: Awaited<ReturnType<typeof updateOwnInstructions>>;
  try {
    result = await updateOwnInstructions(folder, recorded.revision, {
      text: next === "" ? null : next,
    });
  } catch (error) {
    if (error instanceof FolderOperationBusyError)
      return refused(
        "folder-busy",
        { retryable: true },
        blocked["folder-busy"]?.[locale] ?? "",
      );
    // A foreign entry in an owned place is a named refusal before any write.
    if (!(error instanceof FolderAdoptionError)) throw error;
    return refused(
      `folder-${error.code}`,
      { entry: error.entry },
      `folder-${error.code} (${error.entry})`,
    );
  }
  if (result.kind === "blocked") {
    const sentence = blocked[result.reason]?.[locale];
    return refused(
      result.reason,
      Object.fromEntries(
        Object.entries(result).filter(
          ([key]) => key !== "kind" && key !== "reason",
        ),
      ),
      sentence === undefined
        ? `${result.reason}${"path" in result ? ` (${result.path})` : ""}`
        : fill(sentence, result),
    );
  }
  const words: Readonly<Record<Command, Readonly<Record<string, Words>>>> = {
    add: {
      updated: {
        cs: "Řádek je uložený ({bytes} z {maxBytes} bajtů); revize Folderu {revision}.",
        en: "The line is saved ({bytes} of {maxBytes} bytes); Folder revision {revision}.",
      },
    },
    set: {
      updated: {
        cs: "Vlastní pokyny jsou uložené ({bytes} z {maxBytes} bajtů); revize Folderu {revision}.",
        en: "The own instructions are saved ({bytes} of {maxBytes} bytes); Folder revision {revision}.",
      },
      unchanged: {
        cs: "Beze změny: vlastní pokyny už takto znějí.",
        en: "Unchanged: the own instructions already read this way.",
      },
    },
    clear: {
      updated: {
        cs: "Vlastní pokyny jsou odstraněné; revize Folderu {revision}.",
        en: "The own instructions are removed; Folder revision {revision}.",
      },
      unchanged: {
        cs: "Beze změny: žádné vlastní pokyny tu nejsou.",
        en: "Unchanged: there are no own instructions here.",
      },
    },
  };
  const outcome = { ...result, ...size };
  return answer(
    0,
    outcome,
    fill(
      (words[command][result.kind] ?? words.set.unchanged ?? none)[locale],
      outcome,
    ),
  );
}
