import { Database, constants as sqlite } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { buddyRulesPath } from "../folder/outputs";
import { readFolderState } from "../folder/read-state";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { buddyT3Home } from "./t3-runtime";

// Buddy's chat in Lazurio (decision F61; root decision 0210 point 8 and the
// Organization Admin's decisions of 2026-10-22): a T3 Code of its own on the
// user's Osobní Prostředí, home `~/.t3-buddy`, whose one provider is Buddy
// himself, the Hermes Agent over ACP. Machines run that instance (its unit,
// port and route) and declare its one project, Buddy's working directory
// `<Folder>/.agents/buddy`; T3 Code keeps the conversation. Lazurio owns the
// members of the instance's settings that make it Buddy's, and nothing else
// in them:
//
// - the provider instance `buddy`: T3's ACP driver with a local command,
//   `hermes acp`, with `HERMES_HOME` (Buddy's one Hermes home, shared with
//   his Telegram gateway), `LAZURIO_BUDDY_CHANNEL=t3`, the channel Delegace
//   records for a delegation from this chat, and T3 Code's acting-sender
//   claim (Lazurio/t3code#106): `T3CODE_ACTING_SENDER=buddy` with the user's
//   name from Buddy's persona, as it stands alone and after „za“, so what
//   Buddy's `t3` writes or decides in the user's threads shows „Buddy za
//   <jméno>“. The claim lives only in Buddy's own provider: never in a T3
//   Code service's environment or in the user's Chat (`~/.t3`), whose agents
//   would all inherit it. These variables reach the `hermes acp` process.
//   That process only views a session of Hermes's gateway, which runs
//   Buddy's turns and tools with its own environment, so there Delegace
//   takes the channel from Hermes's session (`HERMES_SESSION_SOURCE=acp`,
//   F61's addendum of 2026-10-24) and the claim comes from the gateway's own
//   environment;
// - Codex and Claude off: the only built-in instances T3 Code turns on by
//   itself, so Buddy is this instance's only provider;
// - no turn continues by itself after an update (one conversation: a
//   "Continue where you left off." would speak for the user);
// - no T3 browser for agents: Buddy works through his own tools and bots.
//
// Keys and shapes are T3 Code's (Lazurio/t3code `packages/contracts`
// `settings.ts` and `providerInstance.ts`, `packages/provider-acp-registry`
// `settings.ts`, as of the v0.1.1 rebuild). The person's Chat (`~/.t3`) is
// never touched here: there T3 Code writes its settings itself (decision
// F51). This home exists only for Buddy, so the Platform writes its members
// into `settings.json` itself, the way T3 Code's own offline commands change
// a home (`t3 project add` without a running server): only while it holds T3
// Code's ownership of the home, which a running server holds for as long as
// it runs. So no server writes the file between the read and the replace,
// and none starts meanwhile; a running one makes `--apply` refuse
// (`t3-running`) when there is something to change, and Machines stop the
// unit, apply and start it. Only these members change, and the file is
// replaced atomically, only while it still holds what was read. The server
// decodes the members like any other and its own later writes keep them.

/** The provider instance that is Buddy. */
export const buddyInstanceId = "buddy";
/** The channel Delegace records for a delegation from this chat. */
export const buddyChannel = "t3";

export type BuddyChatInputs = Readonly<{
  /** The user's home, absolute. */
  home: string;
  /** Hermes's command, absolute. */
  hermes: string;
  /** The user's name from Buddy's persona, as it stands alone and after
   * Czech „za“. */
  user: Readonly<{ nominative: string; accusative: string }>;
}>;

/** The members of Buddy's T3 settings that Lazurio owns, as T3 Code keeps
 * them. */
export function buddyChatSettings(inputs: BuddyChatInputs) {
  return {
    continueThreadsAfterServerUpdate: false,
    enableAgentBrowserAccess: false,
    providerInstances: {
      [buddyInstanceId]: {
        driver: "acpRegistry",
        displayName: "Buddy",
        enabled: true,
        environment: [
          {
            name: "HERMES_HOME",
            value: join(inputs.home, ".hermes"),
            sensitive: false,
          },
          {
            name: "LAZURIO_BUDDY_CHANNEL",
            value: buddyChannel,
            sensitive: false,
          },
          { name: "T3CODE_ACTING_SENDER", value: "buddy", sensitive: false },
          {
            name: "T3CODE_ACTING_FOR",
            value: inputs.user.nominative,
            sensitive: false,
          },
          {
            name: "T3CODE_ACTING_FOR_ACCUSATIVE",
            value: inputs.user.accusative,
            sensitive: false,
          },
        ],
        config: {
          source: "local",
          commandPath: inputs.hermes,
          commandArgs: ["acp"],
        },
      },
      codex: { driver: "codex", enabled: false },
      claudeAgent: { driver: "claudeAgent", enabled: false },
    },
  } as const;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `current` with Lazurio's members in place and every other member as it
 * was: the person's or T3's own settings, another provider instance, a
 * variable, a configuration key or a colour of Buddy's that Lazurio does not
 * set. An instance Lazurio turns off keeps everything but `enabled`. Buddy's
 * own keeps no `enabled` in its configuration either: T3 Code reads a false
 * there as off whatever the instance says (`resolveProviderInstanceEnabled`),
 * so the instance's `enabled` is his one switch. */
export function reconcileBuddyChatSettings(
  current: Readonly<Json>,
  inputs: BuddyChatInputs,
): Json {
  const owned = buddyChatSettings(inputs);
  const own = owned.providerInstances[buddyInstanceId];
  const instances = isObject(current.providerInstances)
    ? current.providerInstances
    : {};
  const buddy = isObject(instances[buddyInstanceId])
    ? instances[buddyInstanceId]
    : {};
  const names = new Set<unknown>(own.environment.map(({ name }) => name));
  const variables = Array.isArray(buddy.environment)
    ? buddy.environment.filter(
        (variable) => !(isObject(variable) && names.has(variable.name)),
      )
    : [];
  const { enabled: _folded, ...config } = isObject(buddy.config)
    ? buddy.config
    : {};
  const off = (instance: unknown, driver: string): Json =>
    isObject(instance)
      ? { ...instance, enabled: false }
      : { driver, enabled: false };
  return {
    ...current,
    continueThreadsAfterServerUpdate: owned.continueThreadsAfterServerUpdate,
    enableAgentBrowserAccess: owned.enableAgentBrowserAccess,
    providerInstances: {
      ...instances,
      [buddyInstanceId]: {
        ...buddy,
        driver: own.driver,
        displayName: own.displayName,
        enabled: own.enabled,
        environment: [...variables, ...own.environment],
        config: { ...config, ...own.config },
      },
      codex: off(instances.codex, "codex"),
      claudeAgent: off(instances.claudeAgent, "claudeAgent"),
    },
  };
}

/** The same settings whatever the order of their members: T3 Code writes
 * them back in the order of its schema. */
function sameSettings(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : isObject(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export type BuddyChatReason =
  | "not-personal"
  | "home-unknown"
  | "folder-unreadable"
  | "buddy-layer-missing"
  | "buddy-layer-in-git"
  | "buddy-persona-unreadable"
  | "hermes-missing"
  | "hermes-acp-unavailable"
  | "t3-running"
  | "t3-settings-unreadable"
  | "t3-settings-busy";

export type BuddyChat = Readonly<{
  kind: "buddy-chat";
  state: "managed" | "outdated" | "unavailable" | "skipped";
  reason?: BuddyChatReason;
}>;

const answer = (
  state: BuddyChat["state"],
  reason?: BuddyChatReason,
): BuddyChat =>
  Object.freeze({
    kind: "buddy-chat",
    state,
    ...(reason === undefined ? {} : { reason }),
  });

/** How many times a write yields to another writer of the file before the
 * answer is `t3-settings-busy`. With T3 Code's ownership held, no server is
 * one; a T3 command that writes without it (`t3 theme set`, which Lazurio
 * never runs on its homes) still could be. */
const writeAttempts = 5;

/** T3 Code's ownership of its state directory (Lazurio/t3code
 * `apps/server/src/serverOwnership.ts`): an exclusive transaction on
 * `server-owner.sqlite`, a file that holds no data and is never removed.
 * T3 Code's server holds it for as long as it runs, refuses to start without
 * it, and its own offline commands take it before they change anything; the
 * system releases it when its holder ends, however it ends. Undefined while a
 * server of this home runs. */
function ownT3Home(stateDirectory: string): Database | undefined {
  // Opened as T3 Code opens it, so both lock the same file.
  const owner = new Database(
    join(stateDirectory, "server-owner.sqlite"),
    sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_CREATE,
  );
  try {
    owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return owner;
  } catch (error) {
    owner.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") return undefined;
    throw error;
  }
}

/** Whether Buddy's T3 Code has Lazurio's members (`managed`) or not yet
 * (`outdated`); with `apply`, writes them first. Only on the user's own
 * Osobní Prostředí, with Buddy's layer in the Folder outside any Git work
 * tree (a Git root would give T3 Code checkpoints, and its rollback a second
 * Hermes session), the user's name in Buddy's persona and Hermes's ACP server
 * ready (`hermes acp --check`):
 * otherwise nothing is written, so no instance points at a Buddy without
 * his rules or his server. Settings already in place need nothing; a change
 * needs T3 Code's ownership of the home (`t3-running` while its server
 * runs). */
export async function buddyChat(
  tools: ToolsEnvironment,
  options: Readonly<{
    folder: string;
    apply?: boolean;
    /** Tests only: runs inside the change, after each read of
     * `settings.json` (`read`) and between the last comparison and the
     * replace (`replace`), as another writer or a starting server would. */
    during?: (step: "read" | "replace") => Promise<void>;
  }>,
): Promise<BuddyChat> {
  const home = tools.home;
  if (!home || !isAbsolute(home)) return answer("unavailable", "home-unknown");
  try {
    const { preferences } = await readFolderState(
      join(options.folder, ".lazurio"),
    );
    if (preferences.machine?.kind !== "personal-vm")
      return answer("skipped", "not-personal");
  } catch {
    return answer("unavailable", "folder-unreadable");
  }
  if (!(await regularFile(join(options.folder, buddyRulesPath))))
    return answer("unavailable", "buddy-layer-missing");
  if (await insideGitWorkTree(join(options.folder, dirname(buddyRulesPath))))
    return answer("unavailable", "buddy-layer-in-git");
  const user = await personaUser(home);
  if (user === undefined)
    return answer("unavailable", "buddy-persona-unreadable");
  const hermes =
    (await resolveOnPath("hermes", tools.path, tools.platform)) ??
    (await resolveOnPath(
      "hermes",
      join(home, ".local", "bin"),
      tools.platform,
    ));
  if (hermes === undefined) return answer("unavailable", "hermes-missing");
  const check = await tools.run(
    [hermes, "acp", "--check"],
    60_000,
    {
      HOME: home,
      HERMES_HOME: join(home, ".hermes"),
      ...(tools.path ? { PATH: tools.path } : {}),
    },
    { maxBytes: 32 * 1024 },
  );
  if (check === "timeout" || check.exitCode !== 0)
    return answer("unavailable", "hermes-acp-unavailable");

  const inputs = { home, hermes, user };
  const directories = [
    join(home, buddyT3Home),
    join(home, buddyT3Home, "userdata"),
  ];
  const settings = join(directories[1] as string, "settings.json");
  const inPlace = (read: Settings) =>
    read.raw !== null &&
    sameSettings(
      read.document,
      reconcileBuddyChatSettings(read.document, inputs),
    );
  const first = await readSettings(directories, settings);
  if (first === "unsafe")
    return answer("unavailable", "t3-settings-unreadable");
  if (inPlace(first)) return answer("managed");
  if (!options.apply) return answer("outdated");
  for (const directory of directories) await ensureDirectory(directory);
  const owner = ownT3Home(directories[1] as string);
  if (owner === undefined) return answer("unavailable", "t3-running");
  try {
    for (let attempt = 0; attempt < writeAttempts; attempt += 1) {
      const read = await readSettings(directories, settings);
      if (read === "unsafe")
        return answer("unavailable", "t3-settings-unreadable");
      await options.during?.("read");
      if (inPlace(read)) return answer("managed");
      const next = reconcileBuddyChatSettings(read.document, inputs);
      const replaced = await replaceIfUnchanged(
        settings,
        read.raw,
        `${JSON.stringify(next, null, 2)}\n`,
        () => options.during?.("replace") ?? Promise.resolve(),
      );
      if (replaced) return answer("managed");
    }
    return answer("unavailable", "t3-settings-busy");
  } finally {
    owner.close();
  }
}

/** A name T3 Code takes for an acting sender (Lazurio/t3code#106,
 * `apps/server/src/lazurio/actingSender.ts`): 1 to 64 characters on one line,
 * nothing to trim, no control, formatting, private-use or separator
 * characters. A name it refused would fail every `t3` command Buddy runs. */
const isActingName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 64 &&
  value === value.trim() &&
  !/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);

/** The user's name from Buddy's persona, `~/.config/lazurio/buddy/
 * persona.json` (`lazurio.buddy-persona.v1`, written by Buddy's install):
 * its `user.nominative` and `user.accusative`, each a name T3 Code takes;
 * undefined for anything else. */
async function personaUser(
  home: string,
): Promise<BuddyChatInputs["user"] | undefined> {
  try {
    const persona: unknown = JSON.parse(
      await readFile(
        join(home, ".config", "lazurio", "buddy", "persona.json"),
        "utf8",
      ),
    );
    if (
      !isObject(persona) ||
      persona.schema_version !== "lazurio.buddy-persona.v1" ||
      !isObject(persona.user)
    )
      return undefined;
    const { nominative, accusative } = persona.user;
    return isActingName(nominative) && isActingName(accusative)
      ? { nominative, accusative }
      : undefined;
  } catch {
    return undefined;
  }
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether `directory` or one above it holds `.git`, as Git finds a work
 * tree. Where nothing can be seen, Git sees nothing either. */
async function insideGitWorkTree(directory: string): Promise<boolean> {
  for (let at = directory; ; at = dirname(at)) {
    if (
      await lstat(join(at, ".git")).then(
        () => true,
        () => false,
      )
    )
      return true;
    if (dirname(at) === at) return false;
  }
}

/** `settings.json` as it is now: absent (`raw` null), or plain JSON, an
 * object whose `providerInstances` is absent or an object. Anything else is
 * left as it is: a file T3 Code cannot decode stays for the user to repair,
 * as T3 Code keeps it, and one with comments, which T3 Code reads but a
 * rewrite would drop, stays the person's. So does a link or another kind of
 * file on the way. */
type Settings = Readonly<{ raw: string | null; document: Json }>;

async function readSettings(
  directories: readonly string[],
  path: string,
): Promise<Settings | "unsafe"> {
  for (const directory of directories) {
    try {
      if (!(await lstat(directory)).isDirectory()) return "unsafe";
    } catch (error) {
      if (missing(error)) return { raw: null, document: {} };
      return "unsafe";
    }
  }
  let raw: string;
  try {
    if (!(await lstat(path)).isFile()) return "unsafe";
    raw = await readFile(path, "utf8");
  } catch (error) {
    return missing(error) ? { raw: null, document: {} } : "unsafe";
  }
  if (raw.trim() === "") return { raw, document: {} };
  try {
    const document: unknown = JSON.parse(raw);
    if (
      !isObject(document) ||
      (document.providerInstances !== undefined &&
        !isObject(document.providerInstances))
    )
      return "unsafe";
    return { raw, document };
  } catch {
    return "unsafe";
  }
}

/** A directory of Buddy's T3 home, private to this account where it is
 * made here; T3 Code makes the same ones when it starts first. */
async function ensureDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await lstat(directory)).isDirectory())
    throw new Error(`Not a directory: ${directory}`);
}

/** Replaces `path` with `contents` atomically (a new file renamed over it)
 * only while it still holds `raw` (null: while it is absent); false when
 * another writer changed it meanwhile and nothing was replaced. `between`
 * runs between that last comparison and the rename (tests only). */
async function replaceIfUnchanged(
  path: string,
  raw: string | null,
  contents: string,
  between: () => Promise<void>,
): Promise<boolean> {
  const directory = dirname(path);
  const temporary = join(directory, `.settings.json.${randomUUID()}.lazurio`);
  const file = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    const now = await readFile(path, "utf8").catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (now !== raw) return false;
    await between();
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
