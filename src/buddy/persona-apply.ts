import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { readFolderState } from "../folder/read-state";
import { acquireFileLock, FileLockError } from "../platform/flock";
import type { ToolsEnvironment } from "../tools/overview";
import { resolveOnPath } from "../tools/status";
import { serviceEnvironment } from "../update/service-control";
import { type BuddyChat, type BuddyChatReason, buddyChat } from "./chat";
import {
  type ActiveWork,
  askActiveWork,
  type GatewayUnit,
  gatewayUnitState,
  owePromptRefresh,
  type PromptRefresh,
  promptRefreshOwed,
  refreshPrompts,
  reloadUnits,
  restartGateway,
  restartPending,
  type ServiceRun,
  settlePromptRefresh,
  systemctl,
} from "./gateway-refresh";
import {
  confirmPersona,
  type DerivedFile,
  derivedFileState,
  derivedFiles,
  type Persona,
  type PersonaAddress,
  type PersonaField,
  type PersonaLocale,
  type PersonaRead,
  personaLockPath,
  readPersona,
  writeDerivedFile,
} from "./persona";
import { buddyT3Quiet, buddyT3Unit } from "./t3-runtime";

// `lazurio buddy persona [--apply] [--confirm]` (decision F64): Buddy's
// persona as it is, and, with `--apply`, everything derived from it put in
// place and brought to his running conversations: SOUL.md and his gateway's
// acting sender written (`persona.ts`), their stored prompts cleared and his
// gateway restarted once he is idle (`gateway-refresh.ts`), and his T3
// settings applied (`chat.ts`), his T3 Code stopped and started around them
// once it has no run going (F61's rule). Each file is replaced atomically on
// its own; there is no transaction across SOUL.md, the drop-in and the T3
// settings, so whatever did not happen stays visible and the next apply does
// it. The installer and Machines run it where they rendered these files
// themselves; the Launchpad calls the same core from Začínáme and
// Nastavení → Buddy.

/** A derived file: read, it is `in-place` or `outdated`; applied, it is
 * `in-place`, `written`, or had only its mode set (`mode`). */
export type DerivedState = "in-place" | "outdated" | "written" | "mode";

/** The gateway's restart: nothing it reads changed since it started
 * (`none`), done now, waiting for Buddy to be idle (`pending`), not done
 * because systemd refused it or refused to reread the units first
 * (`failed`, still pending for the next apply), or no user manager to ask
 * (`unavailable`). */
export type GatewayRestart =
  | "none"
  | "pending"
  | "done"
  | "failed"
  | "unavailable";

/** Buddy's T3 settings (`lazurio buddy chat`), `waiting` while his T3 Code
 * runs and has a run going (or cannot say), or `failed` when its unit did not
 * stop or start again. */
export type PersonaChat = Readonly<{
  state: BuddyChat["state"] | "waiting" | "failed";
  reason?: BuddyChatReason;
}>;

/** The stored prompts: what a refresh did now, or a refresh owed that waits
 * (read, or applied while Buddy is busy). */
export type PersonaPrompts = PromptRefresh | Readonly<{ state: "owed" }>;

/** The persona as the Launchpad and the command show it. */
export type PersonaView = Readonly<{
  buddyName: string;
  address: PersonaAddress;
  user: Readonly<{ nominative: string; accusative: string; dative: string }>;
  tone?: string;
  confirmed: boolean;
  confirmedAt?: string;
  revision: string;
}>;

/** A refused member, as a reason names it: `user.dative` is
 * `invalid-user-dative`. */
type PersonaFieldName =
  | "schema-version"
  | "buddy-name"
  | "address"
  | "user-nominative"
  | "user-accusative"
  | "user-dative"
  | "tone";

export type BuddyPersonaReason =
  | "not-personal"
  | "home-unknown"
  | "folder-unreadable"
  | "persona-missing"
  | "persona-unreadable"
  | `invalid-${PersonaFieldName}`
  /** The persona changed under a confirmation, or in every round of an
   * apply (`waiting`: the next apply takes it on). */
  | "persona-changed"
  | "persona-busy"
  | "persona-unsafe"
  | "hermes-home-missing"
  /** Another apply is under way and does the same work. */
  | "apply-running"
  | "apply-lock-unavailable"
  | "files-unwritable"
  /** systemd did not reread the units: nothing restarted on the old ones. */
  | "units-reload-failed"
  /** Some stored prompt was not cleared, or there were more than one refresh
   * clears, or nothing could be cleared: the refresh stays owed. */
  | "prompts-incomplete"
  | "gateway-restart-failed"
  | "chat-restart-failed";

export const invalidReason = (
  field: PersonaField,
): `invalid-${PersonaFieldName}` =>
  `invalid-${field.replaceAll(".", "-").replaceAll("_", "-") as PersonaFieldName}`;

export type BuddyPersona = Readonly<{
  kind: "buddy-persona";
  /** Read: `in-place` or `outdated`. Applied: `applied`, `waiting` (for
   * Buddy to be idle, his T3 Code to have no run going, or another apply) or
   * `failed` (retried by the next apply). Either: `unavailable` or
   * `skipped`. */
  state:
    | "in-place"
    | "outdated"
    | "applied"
    | "waiting"
    | "failed"
    | "unavailable"
    | "skipped";
  reason?: BuddyPersonaReason;
  persona?: PersonaView;
  locale?: PersonaLocale;
  files?: Readonly<{ soul: DerivedState; actingSender: DerivedState }>;
  prompts?: PersonaPrompts;
  restart?: GatewayRestart;
  chat?: PersonaChat;
}>;

export type BuddyPersonaEnvironment = Readonly<{
  /** The user's home, PATH and the runner of `hermes`, `t3` and
   * `systemctl`. */
  tools: ToolsEnvironment;
  /** This process's environment, for `systemctl --user`. */
  env: Readonly<Record<string, string | undefined>>;
  /** Tests only: Hermes's `active-work` verb. */
  activeWork?: ((hermesHome: string) => Promise<ActiveWork>) | undefined;
  /** Tests only: the clock of `confirmed_at` and of the owed refresh. */
  now?: (() => Date) | undefined;
  /** Tests only: at most this many conversations in one refresh. */
  promptCap?: number | undefined;
}>;

const view = (persona: Persona, revision: string): PersonaView =>
  Object.freeze({
    buddyName: persona.buddyName,
    address: persona.address,
    user: persona.user,
    ...(persona.tone === undefined ? {} : { tone: persona.tone }),
    confirmed: persona.confirmedAt !== undefined,
    ...(persona.confirmedAt === undefined
      ? {}
      : { confirmedAt: persona.confirmedAt }),
    revision,
  });

const refused = (
  state: "unavailable" | "skipped" | "failed" | "waiting",
  reason: BuddyPersonaReason,
  persona?: PersonaView,
): BuddyPersona =>
  Object.freeze({
    kind: "buddy-persona",
    state,
    reason,
    ...(persona === undefined ? {} : { persona }),
  });

const unusable = (read: Exclude<PersonaRead, { state: "valid" }>) =>
  read.state === "absent"
    ? refused("unavailable", "persona-missing")
    : read.state === "invalid"
      ? refused("unavailable", invalidReason(read.field))
      : refused("unavailable", "persona-unreadable");

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** One apply at a time, across processes (the command and the Launchpad): a
 * kernel `flock` in Buddy's state directory, released by the kernel when its
 * holder ends. A second apply finds it taken and leaves the work to the
 * first. */
export const applyLockPath = (home: string): string =>
  join(home, ".local", "state", "lazurio", "buddy", ".persona-apply.lock");

/** How often an apply goes again when the persona changed while it applied
 * it, before it answers `waiting` (`persona-changed`) instead. */
const applyAttempts = 3;

type Prepared =
  | Readonly<{
      ready: true;
      persona: PersonaView;
      files: readonly DerivedFile[];
    }>
  | Readonly<{ ready: false; answer: BuddyPersona }>;

/** The persona as it is now, ready to derive from: read, confirmed first with
 * `confirm`, a persona the installer would take, and Buddy's Hermes home
 * there. */
async function prepare(
  context: Context,
  locale: PersonaLocale,
  confirm: boolean,
): Promise<Prepared> {
  const { environment, home, hermesHome } = context;
  const not = (answer: BuddyPersona): Prepared =>
    Object.freeze({ ready: false, answer });
  let read = await readPersona(home);
  if (read.state !== "valid") return not(unusable(read));
  if (confirm) {
    const confirmed = await confirmPersona(
      home,
      environment.now === undefined ? {} : { now: environment.now },
    );
    if (confirmed.kind === "invalid")
      return not(refused("unavailable", invalidReason(confirmed.field)));
    if (confirmed.kind === "persona-changed")
      return not(refused("unavailable", "persona-changed"));
    if (confirmed.kind === "busy")
      return not(refused("unavailable", "persona-busy"));
    if (confirmed.kind === "unsafe")
      return not(refused("unavailable", "persona-unsafe"));
    read = await readPersona(home);
    if (read.state !== "valid") return not(unusable(read));
  }
  const persona = view(read.persona, read.revision);
  if (!(await isDirectory(hermesHome)))
    return not(refused("unavailable", "hermes-home-missing", persona));
  return Object.freeze({
    ready: true,
    persona,
    files: derivedFiles(home, read.persona, locale),
  });
}

/** Buddy's persona and what derives from it, on the user's own Osobní
 * Prostředí only: read, or with `apply` put in place and brought to his
 * running conversations; with `confirm`, the person's confirmation of the
 * names recorded first. Nothing derived is written without his Hermes home
 * (no Buddy) or for a persona the installer would refuse.
 *
 * An apply reads the persona only once it holds its turn, and answers only
 * for the persona that is still current: before it answers, it reads the
 * revision again under the writers' lock (the turn first, then the writers'
 * lock: writers never take the turn, so the two cannot deadlock), and gives
 * up its turn before that lock. A write that completes while it applies is
 * either seen there, and applied in another round, at most `applyAttempts`
 * in all, or completes only after the turn is free, so the apply that its
 * writer runs next takes the turn and reads it. A second apply that finds the
 * turn taken can therefore leave the work to the first (`apply-running`). */
export async function buddyPersona(
  environment: BuddyPersonaEnvironment,
  options: Readonly<{ folder: string; apply?: boolean; confirm?: boolean }>,
): Promise<BuddyPersona> {
  const { tools } = environment;
  const home = tools.home;
  if (!home || !isAbsolute(home)) return refused("unavailable", "home-unknown");
  let locale: PersonaLocale;
  try {
    const { preferences } = await readFolderState(
      join(options.folder, ".lazurio"),
    );
    if (preferences.machine?.kind !== "personal-vm")
      return refused("skipped", "not-personal");
    locale = preferences.profile.locale;
  } catch {
    return refused("unavailable", "folder-unreadable");
  }
  const service: ServiceRun = {
    run: tools.run,
    env: serviceEnvironment(environment.env),
  };
  const context: Context = {
    environment,
    home,
    hermesHome: join(home, ".hermes"),
    folder: options.folder,
  };
  if (options.apply !== true) {
    const ready = await prepare(context, locale, options.confirm === true);
    return ready.ready
      ? reported(context, ready.files, service, ready.persona, locale)
      : ready.answer;
  }
  const lockPath = applyLockPath(home);
  let turn: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    turn = await acquireFileLock(lockPath, { timeoutMs: 2_000 });
  } catch (error) {
    return error instanceof FileLockError && error.reason === "busy"
      ? refused("waiting", "apply-running")
      : refused("unavailable", "apply-lock-unavailable");
  }
  try {
    for (let attempt = 1; ; attempt += 1) {
      const ready = await prepare(
        context,
        locale,
        attempt === 1 && options.confirm === true,
      );
      if (!ready.ready) return ready.answer;
      const answer = await applied(
        context,
        ready.files,
        service,
        ready.persona,
        locale,
      );
      let writers: Awaited<ReturnType<typeof acquireFileLock>>;
      try {
        writers = await acquireFileLock(personaLockPath(home), {
          timeoutMs: 10_000,
        });
      } catch (error) {
        return error instanceof FileLockError && error.reason === "busy"
          ? refused("waiting", "persona-busy", ready.persona)
          : refused("unavailable", "persona-unsafe", ready.persona);
      }
      try {
        const now = await readPersona(home);
        const revision = now.state === "absent" ? null : now.revision;
        if (revision === ready.persona.revision) {
          await turn.release();
          return answer;
        }
      } finally {
        await writers.release();
      }
      if (attempt === applyAttempts)
        return refused("waiting", "persona-changed", ready.persona);
    }
  } finally {
    await turn.release();
  }
}

type Context = Readonly<{
  environment: BuddyPersonaEnvironment;
  home: string;
  hermesHome: string;
  folder: string;
}>;

const paths = (files: readonly DerivedFile[]) => files.map(({ path }) => path);

const chatOf = (answer: BuddyChat): PersonaChat =>
  Object.freeze({
    state: answer.state,
    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
  });

/** What is in place, without writing, restarting or clearing anything. */
async function reported(
  context: Context,
  files: readonly DerivedFile[],
  service: ServiceRun,
  persona: PersonaView,
  locale: PersonaLocale,
): Promise<BuddyPersona> {
  const state = async (file: DerivedFile): Promise<DerivedState> =>
    (await derivedFileState(file)) === "in-place" ? "in-place" : "outdated";
  const [soul = "outdated", actingSender = "outdated"] = await Promise.all(
    files.map(state),
  );
  const unit = await gatewayUnitState(service);
  const owed = await promptRefreshOwed(context.home);
  const running = unit.state === "running";
  const restart: GatewayRestart =
    unit.state === "unknown"
      ? "unavailable"
      : (await restartPending(unit, paths(files))) || (owed && running)
        ? "pending"
        : "none";
  // A stopped gateway on units systemd has not reread would start on them.
  const reloadOwed = unit.state === "stopped" && unit.needsReload;
  const chat = chatOf(
    await buddyChat(context.environment.tools, { folder: context.folder }),
  );
  const inPlace =
    soul === "in-place" &&
    actingSender === "in-place" &&
    restart !== "pending" &&
    !owed &&
    !reloadOwed &&
    chat.state !== "outdated";
  return Object.freeze({
    kind: "buddy-persona",
    state: inPlace ? "in-place" : "outdated",
    persona,
    locale,
    files: Object.freeze({ soul, actingSender }),
    ...(owed ? { prompts: Object.freeze({ state: "owed" as const }) } : {}),
    restart,
    chat,
  });
}

/** The derived files in place, then their way to the running conversations.
 * SOUL.md about to change makes a refresh of the stored prompts owed first,
 * so a failure anywhere after leaves it for the next apply. systemd rereads
 * the units, and where it refuses nothing restarts on the old ones. A refresh
 * that is owed runs when SOUL.md was written now (busy or not: it only clears
 * what the next turn rebuilds), with no gateway running, or at the idle
 * moment. The gateway restarts once, only while Hermes's `active-work` says
 * Buddy is idle, when it runs from before the files or after a complete
 * refresh that was owed; the owed refresh is settled only after a complete
 * refresh and that restart. Buddy's T3 settings follow, his T3 Code stopped
 * and started around them only when it has no run going. */
async function applied(
  context: Context,
  files: readonly DerivedFile[],
  service: ServiceRun,
  persona: PersonaView,
  locale: PersonaLocale,
): Promise<BuddyPersona> {
  const { environment, home, hermesHome } = context;
  const { tools } = environment;
  const written: Record<DerivedFile["name"], DerivedState> = {
    soul: "in-place",
    actingSender: "in-place",
  };
  try {
    for (const file of files) {
      if (file.name === "soul" && (await derivedFileState(file)) === "outdated")
        await owePromptRefresh(home, environment.now);
      written[file.name] = await writeDerivedFile(file);
    }
  } catch {
    return refused("failed", "files-unwritable", persona);
  }

  const unit: GatewayUnit = await gatewayUnitState(service);
  // Pending as the unit stood before the reload: a gateway that started while
  // systemd still held older units runs them, and a reload now does not
  // change a running process.
  const filesPending = await restartPending(unit, paths(files));
  const reloadFailed =
    (unit.state === "running" || unit.state === "stopped") &&
    unit.needsReload &&
    !(await reloadUnits(service));
  const running = unit.state === "running";
  const owed = await promptRefreshOwed(home);

  // Buddy is idle when his gateway says nothing runs, or when it does not run
  // at all; without an answer he counts as busy.
  let moment: ActiveWork = "idle";
  if (filesPending || (owed && running))
    moment = running
      ? await (environment.activeWork ?? askActiveWork)(hermesHome)
      : unit.state === "unknown"
        ? "unknown"
        : "idle";

  let prompts: PromptRefresh | undefined;
  if (owed && (written.soul === "written" || !running || moment === "idle")) {
    const hermes =
      (await resolveOnPath("hermes", tools.path, tools.platform)) ??
      (await resolveOnPath(
        "hermes",
        join(home, ".local", "bin"),
        tools.platform,
      ));
    prompts = await refreshPrompts({
      home,
      hermes,
      path: tools.path,
      run: tools.run,
      ...(environment.promptCap === undefined
        ? {}
        : { cap: environment.promptCap }),
    });
  }
  const refreshed = prompts?.state === "refreshed";

  let restart: GatewayRestart =
    unit.state === "unknown" ? "unavailable" : "none";
  if (running && (filesPending || (owed && refreshed)))
    restart = reloadFailed
      ? "failed"
      : moment !== "idle"
        ? "pending"
        : (await restartGateway(service))
          ? "done"
          : "failed";
  if (owed && refreshed && (!running || restart === "done"))
    await settlePromptRefresh(home);

  const chatAnswer = await buddyChat(tools, {
    folder: context.folder,
    apply: true,
  });
  let chat = chatOf(chatAnswer);
  if (chatAnswer.state === "unavailable" && chatAnswer.reason === "t3-running")
    chat =
      (await buddyT3Quiet({ home, path: tools.path, run: tools.run })) !==
      "quiet"
        ? Object.freeze({ state: "waiting" })
        : await restartedChat(context, service);

  const reason: BuddyPersonaReason | undefined = reloadFailed
    ? "units-reload-failed"
    : prompts !== undefined && prompts.state !== "refreshed"
      ? "prompts-incomplete"
      : restart === "failed"
        ? "gateway-restart-failed"
        : chat.state === "failed"
          ? "chat-restart-failed"
          : undefined;
  const stillOwed = await promptRefreshOwed(home);
  const waiting =
    restart === "pending" || chat.state === "waiting" || stillOwed;
  return Object.freeze({
    kind: "buddy-persona",
    state: reason !== undefined ? "failed" : waiting ? "waiting" : "applied",
    ...(reason === undefined ? {} : { reason }),
    persona,
    locale,
    files: Object.freeze({
      soul: written.soul,
      actingSender: written.actingSender,
    }),
    ...(prompts !== undefined
      ? { prompts }
      : stillOwed
        ? { prompts: Object.freeze({ state: "owed" as const }) }
        : {}),
    restart,
    chat,
  });
}

/** F61's rule, once Buddy's T3 Code has no run going: it owns its home while
 * it runs, so its unit stops, the settings are applied, and it starts again
 * whatever the apply answered. Only a unit that runs is stopped: a T3 Code
 * running outside it keeps its home, and the change waits for it. */
async function restartedChat(
  context: Context,
  service: ServiceRun,
): Promise<PersonaChat> {
  const waiting = Object.freeze({ state: "waiting" as const });
  if (!(await systemctl(service, 30_000, "is-active", "--quiet", buddyT3Unit)))
    return waiting;
  if (!(await systemctl(service, 120_000, "stop", buddyT3Unit)))
    return Object.freeze({ state: "failed" });
  const chat = await buddyChat(context.environment.tools, {
    folder: context.folder,
    apply: true,
  }).catch(() => undefined);
  const started = await systemctl(service, 120_000, "start", buddyT3Unit);
  if (!started || chat === undefined) return Object.freeze({ state: "failed" });
  // Still owned after the stop: another T3 Code holds the home.
  return chat.state === "unavailable" && chat.reason === "t3-running"
    ? waiting
    : chatOf(chat);
}
