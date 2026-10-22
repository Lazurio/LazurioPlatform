import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { buddyRulesPath } from "../folder/outputs";
import { readFolderState } from "../folder/read-state";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";

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
//   his Telegram gateway) and `LAZURIO_BUDDY_CHANNEL=t3`, which every tool
//   Buddy runs there inherits, so budíček wakes him back in this chat;
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
// into `settings.json` the way T3 Code's own commands write that file beside
// its running server (`t3 theme set`): read it, change only these members,
// and replace it atomically only while it still holds what was read. The
// server watches the file and takes the change; its own later writes keep
// the members, which it decodes like any other.

/** The home of Buddy's T3 Code, under the user's home. */
export const buddyChatHome = ".t3-buddy";
/** The provider instance that is Buddy. */
export const buddyInstanceId = "buddy";
/** The channel budíček records for a delegation from this chat. */
export const buddyChannel = "t3";

export type BuddyChatPaths = Readonly<{
  /** The user's home, absolute. */
  home: string;
  /** Hermes's command, absolute. */
  hermes: string;
}>;

/** The members of Buddy's T3 settings that Lazurio owns, as T3 Code keeps
 * them. */
export function buddyChatSettings(paths: BuddyChatPaths) {
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
            value: join(paths.home, ".hermes"),
            sensitive: false,
          },
          {
            name: "LAZURIO_BUDDY_CHANNEL",
            value: buddyChannel,
            sensitive: false,
          },
        ],
        config: {
          source: "local",
          commandPath: paths.hermes,
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
 * set. An instance Lazurio turns off keeps everything but `enabled`. */
export function reconcileBuddyChatSettings(
  current: Readonly<Json>,
  paths: BuddyChatPaths,
): Json {
  const owned = buddyChatSettings(paths);
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
        config: {
          ...(isObject(buddy.config) ? buddy.config : {}),
          ...own.config,
        },
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
  | "hermes-missing"
  | "hermes-acp-unavailable"
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
 * answer is `t3-settings-busy`, as T3 Code's own `t3 theme set` does. */
const writeAttempts = 5;

/** Whether Buddy's T3 Code has Lazurio's members (`managed`) or not yet
 * (`outdated`); with `apply`, writes them first. Only on the user's own
 * Osobní Prostředí, with Buddy's layer in the Folder outside any Git work
 * tree (a Git root would give T3 Code checkpoints, and its rollback a second
 * Hermes session) and Hermes's ACP server ready (`hermes acp --check`):
 * otherwise nothing is written, so no instance points at a Buddy without
 * his rules or his server. */
export async function buddyChat(
  tools: ToolsEnvironment,
  options: Readonly<{
    folder: string;
    apply?: boolean;
    /** Tests only: runs after each read of `settings.json`, before the
     * write, as another writer of the file would. */
    afterRead?: () => Promise<void>;
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

  const paths = { home, hermes };
  const directories = [
    join(home, buddyChatHome),
    join(home, buddyChatHome, "userdata"),
  ];
  const settings = join(directories[1] as string, "settings.json");
  for (let attempt = 0; attempt < writeAttempts; attempt += 1) {
    const read = await readSettings(directories, settings);
    if (read === "unsafe")
      return answer("unavailable", "t3-settings-unreadable");
    const next = reconcileBuddyChatSettings(read.document, paths);
    if (read.raw !== null && sameSettings(read.document, next))
      return answer("managed");
    if (!options.apply) return answer("outdated");
    await options.afterRead?.();
    for (const directory of directories) await ensureDirectory(directory);
    if (
      await replaceIfUnchanged(
        settings,
        read.raw,
        `${JSON.stringify(next, null, 2)}\n`,
      )
    )
      return answer("managed");
  }
  return answer("unavailable", "t3-settings-busy");
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

/** `settings.json` as it is now: absent (`raw` null), or a JSON object whose
 * `providerInstances` is absent or an object. Anything else, or a link or
 * another kind of file on the way, is not read further: T3 Code keeps a file
 * it cannot decode for the user to repair, and so does this. */
async function readSettings(
  directories: readonly string[],
  path: string,
): Promise<Readonly<{ raw: string | null; document: Json }> | "unsafe"> {
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
 * another writer changed it meanwhile and nothing was replaced. */
async function replaceIfUnchanged(
  path: string,
  raw: string | null,
  contents: string,
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
