import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { acquireFileLock, FileLockError } from "../platform/flock";

// Buddy's persona (decision F64; root decision 0210 with its addenda, plan
// DEV-6676): one source, `~/.config/lazurio/buddy/persona.json`
// (`lazurio.buddy-persona.v1`), and one deriver, the Platform. From it the
// Platform derives Buddy's SOUL.md (`~/.hermes/SOUL.md`, the persona only, in
// the Folder's locale), the acting sender of his gateway (the drop-in
// `hermes-gateway.service.d/lazurio-acting-sender.conf`, T3 Code's claim
// „Buddy za <jméno>“, Lazurio/t3code#106) and the members of Buddy's T3
// settings that come from it (`chat.ts`: the acting sender and his display
// name). The validation and the renderers are a byte-for-byte port of the
// interim installer `buddy-install.sh` 2026-10-25.1 (`persona_check`,
// `acting_name_ok`, `soul_text`, `acting_dropin_text`, `sd_env` and
// `persona-build`; 2026-10-24.2 renders the same bytes), so the installer's
// next run finds the very bytes it would have written, and the installer and
// Machines (Machines#701) can call `lazurio buddy persona --apply` instead of
// rendering. The goldens in `tests/fixtures/buddy-persona` are the installer's
// own output; the installer itself lives outside this repository.
//
// Delegace's persona drop-in (`delegace.service.d/persona.conf`) is not
// derived here: it stays the installer's until Delegace reads the persona
// itself (Lazurio/LazurioPlatform#616), and then it goes.

/** The schema of Buddy's persona. */
export const personaSchemaVersion = "lazurio.buddy-persona.v1";

export type PersonaLocale = "cs" | "en";
export type PersonaAddress = "ty" | "vy";

/** Buddy's persona as the Platform reads it. */
export type Persona = Readonly<{
  buddyName: string;
  address: PersonaAddress;
  user: Readonly<{ nominative: string; accusative: string; dative: string }>;
  /** One line of at most 300 characters; absent: Lazurio's line for the
   * address. */
  tone?: string;
  /** When the person confirmed the names (Začínáme); absent until then. */
  confirmedAt?: string;
}>;

/** A member of the persona that a check refused, in the installer's words. */
export type PersonaField =
  | "schema_version"
  | "buddy_name"
  | "address"
  | "user.nominative"
  | "user.accusative"
  | "user.dative"
  | "tone";

/** The persona's file, under the user's home. */
export const personaPath = (home: string): string =>
  join(home, ".config", "lazurio", "buddy", "persona.json");
/** Buddy's SOUL.md, in his one Hermes home. */
export const soulPath = (home: string): string =>
  join(home, ".hermes", "SOUL.md");
/** The drop-in that gives Buddy's gateway its acting sender. The unit itself
 * is Hermes's (`hermes gateway install`). */
export const actingSenderPath = (home: string): string =>
  join(
    home,
    ".config",
    "systemd",
    "user",
    "hermes-gateway.service.d",
    "lazurio-acting-sender.conf",
  );

/** The modes the installer gives them (`persona-build`, `soul-render` and
 * `acting-dropin-render`): the persona and SOUL.md private, the drop-in
 * readable as systemd's own files are. */
export const personaMode = 0o600;
export const personaDirectoryMode = 0o700;
export const soulMode = 0o600;
export const actingSenderMode = 0o644;

// ---- Validation: `persona_check` ------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Characters no persona name holds (the installer's NAME_RE): they would
 * need quoting in a unit file, a shell or a template. */
const forbiddenInName = new Set(["`", "$", "\\", '"', "<", ">", "{", "}"]);

/** A name as the installer's NAME_RE takes it: 1 to 60 characters (code
 * points, as Python counts them), none a C0 control character, DEL or one of
 * `` ` $ \ " < > { } ``. */
export function isPersonaName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f || forbiddenInName.has(character))
      return false;
    count += 1;
    if (count > 60) return false;
  }
  return count >= 1;
}

/** A name T3 Code takes for an acting sender (Lazurio/t3code#106,
 * `apps/server/src/lazurio/actingSender.ts`; the installer's
 * `acting_name_ok`): 1 to 64 characters (UTF-16 units) on one line, nothing to
 * trim, no control, formatting, private-use or separator characters. A name it
 * refused would fail every `t3` command Buddy runs. JavaScript's `trim` and
 * Python's `strip` differ only in characters these categories refuse anyway
 * (U+001C to U+001F, U+0085 and U+FEFF). */
export const isActingName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 64 &&
  value === value.trim() &&
  !/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);

const isTone = (value: unknown): value is string => {
  if (typeof value !== "string" || value.includes("\n")) return false;
  const length = [...value].length;
  return length >= 1 && length <= 300;
};

/** A lone surrogate (only a `\ud800` escape in the file makes one), which no
 * UTF-8 file can store: the installer refuses it in every member
 * (`no_lone_surrogate`, 2026-10-25.1). A paired one is one character. */
const hasLoneSurrogate = (value: string) => /\p{Cs}/u.test(value);

/** When the person confirmed the names: a UTC time to the second, as the
 * Platform writes it. Anything else reads as not confirmed and never makes
 * the persona invalid: the installer does not check the member at all. */
const confirmedAtShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const confirmedAtOf = (value: unknown): string | undefined =>
  typeof value === "string" &&
  confirmedAtShape.test(value) &&
  !Number.isNaN(Date.parse(value))
    ? value
    : undefined;

export type PersonaCheck =
  | Readonly<{ ok: true; persona: Persona }>
  | Readonly<{ ok: false; field: PersonaField | "document" }>;

/** A member as NAME_RE and the installer's `no_lone_surrogate` take it. */
const isStorableName = (value: unknown): value is string =>
  isPersonaName(value) && !hasLoneSurrogate(value);

/** The installer's `persona_check` (2026-10-25.1), in its order, so a refusal
 * names the same member: the schema; Buddy's name (NAME_RE, then no lone
 * surrogate); the address; each of the user's three names (NAME_RE, then no
 * lone surrogate); the nominative and the accusative as T3 Code takes them;
 * the tone (one line of at most 300 characters, then no lone surrogate).
 * Unknown members are kept and ignored, as every reader does. */
export function checkPersona(document: unknown): PersonaCheck {
  const refused = (field: PersonaField | "document"): PersonaCheck =>
    Object.freeze({ ok: false, field });
  if (!isObject(document)) return refused("document");
  if (document.schema_version !== personaSchemaVersion)
    return refused("schema_version");
  const buddyName = document.buddy_name;
  if (!isStorableName(buddyName)) return refused("buddy_name");
  const address = document.address;
  if (address !== "ty" && address !== "vy") return refused("address");
  const user = isObject(document.user) ? document.user : {};
  const { nominative, accusative, dative } = user;
  if (!isStorableName(nominative)) return refused("user.nominative");
  if (!isStorableName(accusative)) return refused("user.accusative");
  if (!isStorableName(dative)) return refused("user.dative");
  if (!isActingName(nominative)) return refused("user.nominative");
  if (!isActingName(accusative)) return refused("user.accusative");
  const tone = document.tone;
  if ("tone" in document && !(isTone(tone) && !hasLoneSurrogate(tone)))
    return refused("tone");
  const confirmedAt = confirmedAtOf(document.confirmed_at);
  return Object.freeze({
    ok: true,
    persona: Object.freeze({
      buddyName,
      address,
      user: Object.freeze({ nominative, accusative, dative }),
      ...(typeof tone === "string" ? { tone } : {}),
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
    }),
  });
}

// ---- Rendering: `soul_text`, `acting_dropin_text`, `sd_env` ----------------

/** Python's whitespace (`str.isspace`), which the installer's `strip()`
 * removes: JavaScript's `trim` also removes U+FEFF and keeps U+001C to
 * U+001F and U+0085. */
const pythonWhitespace = new Set(
  [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
    0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ].map((point) => String.fromCodePoint(point)),
);

/** Python's `str.strip()`. */
export function pythonStrip(value: string): string {
  const characters = [...value];
  let start = 0;
  let end = characters.length;
  while (start < end && pythonWhitespace.has(characters[start] as string))
    start += 1;
  while (end > start && pythonWhitespace.has(characters[end - 1] as string))
    end -= 1;
  return characters.slice(start, end).join("");
}

/** Lazurio's line for the tone when the persona has none. */
const tones = {
  cs: {
    ty: "Mluvíš jako parťák: česky s diakritikou, věcně, stručně a vlídně, bez vaty. Pravdu říkáš i tehdy, když je nepříjemná, a nejistotu přiznáš.",
    vy: "Mluvíš zdvořile a vlídně: česky s diakritikou, věcně a stručně, bez vaty. Pravdu říkáš i tehdy, když je nepříjemná, a nejistotu přiznáš.",
  },
  en: {
    ty: "You talk like a partner: in plain English, to the point, briefly and kindly, without filler. You tell the truth even when it is unpleasant, and you admit uncertainty.",
    vy: "You talk politely and kindly: in plain English, to the point and briefly, without filler. You tell the truth even when it is unpleasant, and you admit uncertainty.",
  },
} as const;

/** How the address reads in each language. English has no ty and vy, but the
 * person may write to Buddy in Czech: the address holds in every language
 * with a formal and an informal you (Machines#880, point 4). */
const addresses = {
  cs: {
    ty: "tykáš. Oslovuješ uživatele jménem. Platí to v každém jazyce, ve kterém uživatel píše: kde jazyk rozlišuje formální a neformální oslovení, používáš neformální.",
    vy: "vykáš: vy, váš, vám a rozkazovací způsob v množném čísle („zkontrolujte“). Oslovuješ uživatele jménem. Platí to v každém jazyce, ve kterém uživatel píše: kde jazyk rozlišuje formální a neformální oslovení, používáš formální.",
  },
  en: {
    ty: "you use the informal one (in Czech: tykání), and you never use a past tense that would assume the user's gender. You call the user by name.",
    vy: "you use the formal one (in Czech: vykání — vy, váš, vám and plural imperatives), and you never use a past tense that would assume the user's gender. You call the user by name.",
  },
} as const;

/** Buddy's SOUL.md for a locale: his persona only, never his role or rules
 * (those are the Lazurio layer's, `.agents/buddy/.hermes.md`), and never the
 * mark „Buddy za <jméno>“, which T3 Code shows by itself. The installer's
 * `soul_text`, byte for byte. */
export function soulText(persona: Persona, locale: PersonaLocale): string {
  const b = persona.buddyName;
  const { nominative, accusative, dative } = persona.user;
  const tone = persona.tone || tones[locale][persona.address];
  // A Buddy named Buddy, the product's default name, is not "Buddy, Buddy".
  // Python's `strip().casefold()`: no character but the ASCII letters folds
  // or lowers to one of b, u, d and y, so `toLowerCase` compares the same.
  const who =
    pythonStrip(b).toLowerCase() === "buddy" ? `**${b}**` : `**${b}**, Buddy`;
  const address = addresses[locale][persona.address];
  if (locale === "en")
    return (
      "<!-- Buddy's persona. Lazurio derives it from ~/.config/lazurio/buddy/persona.json;\n" +
      "     it changes in Settings → Buddy, not by hand here. -->\n" +
      `# ${b}\n\n` +
      `You are ${who}. Your user is ${nominative}. This file is only your persona. Your role, your limits\n` +
      "and the way you work come from Lazurio's rules for Buddy (`~/Lazurio/.agents/buddy/.hermes.md`).\n\n" +
      "## Persona\n\n" +
      `- Name: ${b}\n` +
      `- User: ${nominative} (in Czech: ${accusative} in the accusative, ${dative} in the dative).\n` +
      "- Address: when you speak Czech or another language with a formal and an informal you, " +
      `${address}\n` +
      `- Tone: ${tone}\n`
    );
  return (
    "<!-- Persona Buddyho. Lazurio ji odvozuje z ~/.config/lazurio/buddy/persona.json;\n" +
    "     mění se v Nastavení → Buddy, ne ručně tady. -->\n" +
    `# ${b}\n\n` +
    `Jsi ${who}. Tvůj uživatel je ${nominative}. Tento soubor je jen tvoje persona. Roli, hranice\n` +
    "a způsob práce ti dávají pravidla Buddyho od Lazuria (`~/Lazurio/.agents/buddy/.hermes.md`).\n\n" +
    "## Persona\n\n" +
    `- Jméno: ${b}\n` +
    `- Uživatel: ${nominative} (4. pád: ${accusative}, 3. pád: ${dative}).\n` +
    `- Oslovení: uživateli ${address}\n` +
    "- Minulý čas, který by vynucoval rod, o uživateli nepoužíváš.\n" +
    `- Tón: ${tone}\n`
  );
}

/** One assignment of a systemd `Environment=` line, quoted (systemd.syntax
 * "Quoting"), with `%` doubled, since systemd expands specifiers in
 * `Environment=` before it unquotes. The installer's `sd_env`. */
export const systemdQuoted = (assignment: string): string =>
  `"${assignment
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`;

/** The drop-in of Buddy's gateway: every `t3` he runs from Telegram or a
 * cron job shows „Buddy za <jméno>“ (Lazurio/t3code#106). Never in
 * Delegace's unit or a T3 Code service. The installer's `acting_dropin_text`,
 * byte for byte, its note on who writes it included: the installer compares
 * the file with its own render (`cmp`) until it calls the Platform instead
 * (I-b), and both change their words in that one step. */
export function actingSenderText(persona: Persona): string {
  return (
    "# Lazurio: Buddy acts for his user in T3 Code (Lazurio/t3code#106), from ~/.config/lazurio/buddy/persona.json.\n" +
    "# Written by buddy-install.sh (interim); Machines re-derive it (Machines#701).\n" +
    "[Service]\n" +
    `Environment=${systemdQuoted("T3CODE_ACTING_SENDER=buddy")}\n` +
    `Environment=${systemdQuoted(`T3CODE_ACTING_FOR=${persona.user.nominative}`)}\n` +
    `Environment=${systemdQuoted(`T3CODE_ACTING_FOR_ACCUSATIVE=${persona.user.accusative}`)}\n`
  );
}

/** Buddy's name in T3 Code (the provider instance's `displayName`, which T3
 * Code trims and refuses blank): his own name, or Buddy for a name of spaces
 * alone. */
export const buddyDisplayName = (persona: Persona): string =>
  persona.buddyName.trim() || "Buddy";

/** The files the Platform derives from the persona, with their modes. */
export type DerivedFile = Readonly<{
  name: "soul" | "actingSender";
  path: string;
  mode: number;
  text: string;
}>;

export function derivedFiles(
  home: string,
  persona: Persona,
  locale: PersonaLocale,
): readonly DerivedFile[] {
  return [
    {
      name: "soul",
      path: soulPath(home),
      mode: soulMode,
      text: soulText(persona, locale),
    },
    {
      name: "actingSender",
      path: actingSenderPath(home),
      mode: actingSenderMode,
      text: actingSenderText(persona),
    },
  ];
}

// ---- The persona's file -----------------------------------------------------

/** A persona is a few hundred bytes; anything far larger is not one. */
const personaBytes = 256 * 1024;

const revisionOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The persona as it is now. `revision` is the sha256 of the file's bytes,
 * which a write must name (`writePersona`). */
export type PersonaRead =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "unreadable"; revision?: string }>
  | Readonly<{
      state: "invalid";
      field: PersonaField;
      document: Readonly<Json>;
      revision: string;
    }>
  | Readonly<{
      state: "valid";
      persona: Persona;
      document: Readonly<Json>;
      revision: string;
    }>;

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** The persona's bytes: absent, or a regular file of at most `personaBytes`,
 * never through a link. */
async function personaFileBytes(
  path: string,
): Promise<Buffer | "absent" | "unreadable"> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > personaBytes) return "unreadable";
      const bytes = await handle.readFile();
      return bytes.byteLength > personaBytes ? "unreadable" : bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    return missing(error) ? "absent" : "unreadable";
  }
}

/** The persona from its bytes: UTF-8 without a byte order mark, which
 * Python's `json.load` refuses too, then JSON, then `checkPersona`. */
function personaOf(bytes: Buffer): PersonaRead {
  const revision = revisionOf(bytes);
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    return Object.freeze({ state: "unreadable", revision });
  }
  const check = checkPersona(document);
  if (!check.ok)
    return check.field === "document"
      ? Object.freeze({ state: "unreadable", revision })
      : Object.freeze({
          state: "invalid",
          field: check.field,
          document: document as Json,
          revision,
        });
  return Object.freeze({
    state: "valid",
    persona: check.persona,
    document: document as Json,
    revision,
  });
}

/** Buddy's persona from `persona.json` of the user's absolute `home`. */
export async function readPersona(home: string): Promise<PersonaRead> {
  const bytes = await personaFileBytes(personaPath(home));
  if (bytes === "absent") return Object.freeze({ state: "absent" });
  if (bytes === "unreadable") return Object.freeze({ state: "unreadable" });
  return personaOf(bytes);
}

/** A change of the persona, as Začínáme and Nastavení → Buddy send it. */
export type PersonaUpdate = Readonly<{
  buddyName: string;
  address: string;
  user: Readonly<{ nominative: string; accusative: string; dative: string }>;
  /** Absent: the tone stays as it is; null or blank: Lazurio's line. */
  tone?: string | null;
  /** The person confirmed the names: the first confirmation is kept. */
  confirm?: boolean;
}>;

export type PersonaWrite =
  | Readonly<{
      kind: "written";
      persona: Persona;
      revision: string;
      /** This write recorded the person's first confirmation (decision
       * F60's addendum of 2026-10-26: Buddy's first meeting follows it). */
      firstConfirmation?: true;
    }>
  | Readonly<{ kind: "unchanged"; persona: Persona; revision: string }>
  | Readonly<{ kind: "invalid"; field: PersonaField }>
  /** The file is not what the writer read: nothing was written. */
  | Readonly<{ kind: "persona-changed"; current: PersonaRead }>
  /** Another writer held the persona's lock for longer than a write takes. */
  | Readonly<{ kind: "busy" }>
  /** The persona's directory or file is a link or not what it should be, or
   * no lock can be taken there: nothing was written. */
  | Readonly<{ kind: "unsafe" }>;

/** The members of a persona in the installer's order (`persona-build`), then
 * the confirmation, then every other member as it was. */
function personaDocument(
  persona: Persona,
  previous: Readonly<Json> | undefined,
): Json {
  const previousUser =
    previous !== undefined && isObject(previous.user) ? previous.user : {};
  const known = new Set([
    "schema_version",
    "buddy_name",
    "address",
    "user",
    "tone",
    "confirmed_at",
  ]);
  const rest = Object.fromEntries(
    Object.entries(previous ?? {}).filter(([key]) => !known.has(key)),
  );
  const userRest = Object.fromEntries(
    Object.entries(previousUser).filter(
      ([key]) => !["nominative", "accusative", "dative"].includes(key),
    ),
  );
  return {
    schema_version: personaSchemaVersion,
    buddy_name: persona.buddyName,
    address: persona.address,
    user: {
      nominative: persona.user.nominative,
      accusative: persona.user.accusative,
      dative: persona.user.dative,
      ...userRest,
    },
    ...(persona.tone === undefined ? {} : { tone: persona.tone }),
    ...(persona.confirmedAt === undefined
      ? previous?.confirmed_at === undefined
        ? {}
        : { confirmed_at: previous.confirmed_at }
      : { confirmed_at: persona.confirmedAt }),
    ...rest,
  };
}

/** The file's text, as the installer writes it: `json.dumps(p,
 * ensure_ascii=False, indent=2)` and a line feed. For strings both escape the
 * same characters the same way. */
export const personaText = (document: Readonly<Json>): string =>
  `${JSON.stringify(document, null, 2)}\n`;

/** The persona's file for `persona`, every other member of `previous` kept. */
export const personaFileText = (
  persona: Persona,
  previous?: Readonly<Json>,
): string => personaText(personaDocument(persona, previous));

/** A value stripped as Python strips; anything but a string as it is, for the
 * check to refuse. */
const stripped = (value: unknown): unknown =>
  typeof value === "string" ? pythonStrip(value) : value;

/** The persona a person's values make, as `persona-build` makes it from the
 * installer's options: each value stripped as Python strips, a blank tone
 * left out (Lazurio's line). */
export function personaFromValues(
  update: PersonaUpdate,
  current: Persona | undefined,
): PersonaCheck {
  const tone =
    update.tone === undefined
      ? current?.tone
      : update.tone === null
        ? undefined
        : stripped(update.tone) || undefined;
  const user: unknown = update.user;
  return checkPersona({
    schema_version: personaSchemaVersion,
    buddy_name: stripped(update.buddyName),
    address: stripped(update.address),
    user: isObject(user)
      ? {
          nominative: stripped(user.nominative),
          accusative: stripped(user.accusative),
          dative: stripped(user.dative),
        }
      : user,
    ...(tone === undefined ? {} : { tone }),
  });
}

/** A UTC time to the second, as `confirmed_at` holds it. */
export const confirmationTime = (now: Date): string =>
  `${now.toISOString().slice(0, 19)}Z`;

export type PersonaWriteOptions = Readonly<{
  /** The clock of `confirmed_at`. */
  now?: () => Date;
  /** Tests only: runs right before the last comparison and the replace, as
   * another writer would. */
  during?: () => Promise<void>;
}>;

/** Where every writer of the persona takes its turn: one file beside it. */
export const personaLockPath = (home: string): string =>
  join(home, ".config", "lazurio", "buddy", ".persona.lock");

/** A write takes milliseconds; a writer that waits longer answers `busy`. */
const personaLockTimeoutMs = 10_000;

/** Runs `body` while holding the persona's lock: a kernel `flock`
 * (`acquireFileLock`) on `.persona.lock` in the persona's private directory,
 * which the kernel releases when its holder ends, however it ends, so a
 * writer that dies never blocks the next one. Every writer of the Platform
 * holds it from its read of the persona to its replace, so two of them can
 * never both find the same revision and both write. No lock, no write. */
async function underPersonaLock(
  home: string,
  body: () => Promise<PersonaWrite>,
): Promise<PersonaWrite> {
  if (!(await privateDirectory(dirname(personaPath(home)))))
    return Object.freeze({ kind: "unsafe" });
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(personaLockPath(home), {
      timeoutMs: personaLockTimeoutMs,
    });
  } catch (error) {
    return Object.freeze({
      kind:
        error instanceof FileLockError && error.reason === "busy"
          ? "busy"
          : "unsafe",
    });
  }
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

/** Writes the persona from `update` atomically, only while the file is still
 * the one the writer read: `revision` is that read's (null: there was none).
 * Otherwise nothing is written and the answer is `persona-changed` with the
 * persona as it is now (the Launchpad's 409). The read, the comparison and the
 * replace happen under the persona's lock. The file is 0600 in a 0700
 * directory; members the Platform does not know stay. */
export function writePersona(
  home: string,
  update: PersonaUpdate,
  revision: string | null,
  options: PersonaWriteOptions = {},
): Promise<PersonaWrite> {
  return underPersonaLock(home, () =>
    writeLocked(home, update, revision, options),
  );
}

async function writeLocked(
  home: string,
  update: PersonaUpdate,
  revision: string | null,
  options: PersonaWriteOptions,
): Promise<PersonaWrite> {
  const now = options.now ?? (() => new Date());
  const current = await readPersona(home);
  // A link or another kind of file where the persona belongs is never
  // replaced: it is not the persona anybody read.
  if (current.state === "unreadable" && current.revision === undefined)
    return Object.freeze({ kind: "unsafe" });
  const currentRevision = current.state === "absent" ? null : current.revision;
  if (currentRevision !== revision)
    return Object.freeze({ kind: "persona-changed", current });
  const previous = current.state === "valid" ? current.persona : undefined;
  const check = personaFromValues(update, previous);
  // The values always make an object, so a refusal names a member.
  if (!check.ok)
    return Object.freeze({
      kind: "invalid",
      field: check.field === "document" ? "schema_version" : check.field,
    });
  const confirmedAt =
    previous?.confirmedAt ??
    (update.confirm === true ? confirmationTime(now()) : undefined);
  const persona: Persona = Object.freeze({
    ...check.persona,
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
  });
  // Members the Platform does not know stay, an invalid persona's too.
  const written = await replacePersona(
    home,
    persona,
    current.state === "valid" || current.state === "invalid"
      ? current.document
      : undefined,
    revision,
    options.during,
  );
  return written.kind === "written" &&
    previous?.confirmedAt === undefined &&
    persona.confirmedAt !== undefined
    ? Object.freeze({ ...written, firstConfirmation: true })
    : written;
}

/** Sets `confirmed_at` of a valid persona, once, under the persona's lock: a
 * persona already confirmed stays as it is, and one that is not valid is not
 * written (`invalid`, with its member, or `persona-changed`). */
export function confirmPersona(
  home: string,
  options: PersonaWriteOptions = {},
): Promise<PersonaWrite> {
  const now = options.now ?? (() => new Date());
  return underPersonaLock(home, async () => {
    const current = await readPersona(home);
    if (current.state === "invalid")
      return Object.freeze({ kind: "invalid", field: current.field });
    if (current.state !== "valid")
      return Object.freeze({ kind: "persona-changed", current });
    if (current.persona.confirmedAt !== undefined)
      return Object.freeze({
        kind: "unchanged",
        persona: current.persona,
        revision: current.revision,
      });
    return replacePersona(
      home,
      { ...current.persona, confirmedAt: confirmationTime(now()) },
      current.document,
      current.revision,
      options.during,
    );
  });
}

async function replacePersona(
  home: string,
  persona: Persona,
  previous: Readonly<Json> | undefined,
  revision: string | null,
  during?: () => Promise<void>,
): Promise<PersonaWrite> {
  const bytes = Buffer.from(personaFileText(persona, previous), "utf8");
  const next = revisionOf(bytes);
  if (next === revision)
    return Object.freeze({ kind: "unchanged", persona, revision: next });
  const path = personaPath(home);
  // The lock orders the Platform's writers; the installer's own first write
  // (`persona-build`) does not take it, so the file is compared once more
  // right before the replace.
  const replaced = await replaceAtomically(
    path,
    bytes,
    personaMode,
    async () => {
      await during?.();
      const now = await personaFileBytes(path);
      if (now === "unreadable") return false;
      return (now === "absent" ? null : revisionOf(now)) === revision;
    },
  );
  if (!replaced)
    return Object.freeze({
      kind: "persona-changed",
      current: await readPersona(home),
    });
  return Object.freeze({ kind: "written", persona, revision: next });
}

/** The persona's directory, made where it is missing: private to this
 * account, as the installer's `install -d -m 700` leaves it. A link or another
 * kind of file is refused. */
async function privateDirectory(directory: string): Promise<boolean> {
  await mkdir(dirname(directory), {
    recursive: true,
    mode: personaDirectoryMode,
  });
  try {
    await mkdir(directory, { mode: personaDirectoryMode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory()) return false;
  if ((info.mode & 0o777) !== personaDirectoryMode)
    await chmod(directory, personaDirectoryMode);
  return true;
}

// ---- The derived files ------------------------------------------------------

/** A derived file as it is: its exact bytes and mode in a regular file
 * (`in-place`), the bytes with another mode (`mode`), or anything else
 * (`outdated`), a link among them: a link is replaced by the file, never
 * written through. */
export async function derivedFileState(
  file: DerivedFile,
): Promise<"in-place" | "mode" | "outdated"> {
  try {
    const info = await lstat(file.path);
    if (!info.isFile()) return "outdated";
    if (!(await readFile(file.path)).equals(Buffer.from(file.text, "utf8")))
      return "outdated";
    return (info.mode & 0o777) === file.mode ? "in-place" : "mode";
  } catch {
    return "outdated";
  }
}

/** Puts a derived file in place: a new file with its exact mode, whatever the
 * umask, renamed over the old one, so Hermes and systemd never read half of
 * it; only a mode is set where the bytes are already right, so the file's
 * time stays and no restart follows from it. The drop-in's directory is made
 * where it is missing; Hermes's home never is: without it there is no Buddy. */
export async function writeDerivedFile(
  file: DerivedFile,
): Promise<"in-place" | "mode" | "written"> {
  const state = await derivedFileState(file);
  if (state === "in-place") return "in-place";
  if (state === "mode") {
    await chmod(file.path, file.mode);
    return "mode";
  }
  const directory = dirname(file.path);
  if (file.name === "actingSender")
    await mkdir(directory, { recursive: true, mode: 0o755 });
  if (!(await stat(directory)).isDirectory())
    throw new Error("Not a directory");
  await replaceAtomically(
    file.path,
    Buffer.from(file.text, "utf8"),
    file.mode,
    async () => true,
  );
  return "written";
}

/** Replaces `path` with `bytes` atomically (a new file renamed over it, its
 * mode set exactly), only while `still` holds right before the rename; false
 * when it did not and nothing was replaced. */
async function replaceAtomically(
  path: string,
  bytes: Uint8Array,
  mode: number,
  still: () => Promise<boolean>,
): Promise<boolean> {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${randomUUID()}.lazurio`,
  );
  const file = await open(temporary, "wx", mode);
  let renamed = false;
  try {
    try {
      await file.chmod(mode);
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    if (!(await still())) return false;
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}
