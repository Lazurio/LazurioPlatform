import { join } from "node:path";
import { parseArgs } from "node:util";
import { browserEntryOf } from "../browser/view";
import { FolderAdoptionError } from "../folder/handover-layout";
import {
  readFolderTools,
  sharedSignInsWarning,
} from "../folder/inspect-tools-change";
import { withFolderReadLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readFolderState } from "../folder/read-state";
import { sharedEnvironment } from "../folder/render";
import { updateTools } from "../folder/update-profile";
import { converse, readCodex } from "./ai-probe";
import { reloadAiServices } from "./ai-services";
import { activatableTools, toolCatalog, toolPrompt } from "./catalog";
import {
  type CuratedContext,
  runComposioOrganization,
  runInstall,
  runLogin,
  runLogout,
  sharedSignInsText,
} from "./curated-cli";
import { hostedEnvironmentReader } from "./github-gate";
import type { InstallEnvironment } from "./install";
import type { LoginEnvironment, SignInPage } from "./login";
import {
  normalizeToolNote,
  quoteToolNote,
  toolNoteLimits,
  toolNoteProblem,
} from "./note";
import {
  runTool,
  type ToolSignIn,
  type ToolStatus,
  toolsSignIn,
  toolsStatus,
  xdgOf,
} from "./status";
import {
  githubActionRefused,
  teamGithubPhrase,
  teamGithubWorksAs,
} from "./team-github";
import { toolsUpdate } from "./update";

/** `lazurio tools`: the terminal surface of the operator's tools (decision
 * 0161 / F17) and of the tools enabled for agents in a Lazurio Folder
 * (decision 0162 / F18), docs/environment-tools.md. */
export const toolsHelp = `tools status [--json]
  The operator's tools (codex, claude, gh, git, node, npm, bun, composio,
  bw, wacli, gog, neon) as found on this process's PATH: path, real path, the version each reports and whether
  the PATH entry is the standard ~/.local/bin/<tool> (decision 0161).
  Read-only; the version commands never use the network. Versions are facts,
  not drift.
tools update <tool> [--json]
  Runs that one tool's official update path as the current user: the tool's
  own updater (claude update, bun upgrade) or the vendor's installer script
  (codex). composio, which Lazurio uses in its own build, runs its curated
  installer again at that pinned build, whatever version runs now, in place
  in ~/.local/bin and ~/.composio and keeping its sign-in; the update is
  done only when composio --version prints that build. Tools without an
  update path (gh, git, node, npm) are reported with their official source
  and nothing runs. Run it only with the Operator's consent. Never
  downgrades on its own; never touches another tool. A running Codex
  app-server is never stopped: after Codex changed its version, the answer
  says it keeps the old version until it is replaced.
tools list --folder <absolute Folder> [--sign-in] [--json]
  The catalog tools agents may be told to use (gh required, composio and
  bitwarden recommended, wacli, gogcli and neon optional): tier, setup mode (launchpad:
  a curated Launchpad flow sets it up; agent: an agent does, from the prepared
  prompt), whether each is enabled in that Folder, the operator's note on it,
  and the same live facts as tools status. Read-only. --sign-in also runs each
  installed tool's sign-in probe (gh auth status, composio whoami, wacli auth
  status, gog auth list --check, neon me) and reports signed in, as whom when
  the tool tells, not signed in, or unknown; the tools may contact their
  providers for it, so it runs only when asked. Only the account label is
  shown, never the tool's output.
tools prompt <tool> [--locale cs|en] [--json]
  The prepared prompt for an agent who installs that tool and guides the
  operator's sign-in: the task, the target state and the rule to enable the
  tool afterwards. Read-only text, no Folder; it installs nothing. In a
  Team Remote Environment (the preset of its operator's Folder) gh's prompt
  sets gh up without any sign-in or SSH key.
tools enable <tool> --folder <absolute Folder> --expected-revision <n> [--json]
tools disable <tool> --folder <absolute Folder> --expected-revision <n> [--json]
  Records the tool as enabled or not in that Folder and re-renders AGENTS.md
  and manual/ through the profile transaction (recovery: profile-resume).
  Enabling is context for agents: it grants no access, installs nothing, signs
  in nowhere and pins no version. A required tool is always on: enabling it is
  unchanged, disabling it is refused. Disabling a tool removes its note. On an
  Organization's Environment whose Organization does not allow a tool
  (composio, root decision 0194), the Organization decides it: both are
  refused (organization-governed) and the person's earlier choice is kept for
  when it is allowed again. No implicit Folder discovery.
tools note <tool> --folder <absolute Folder> --expected-revision <n> (--text <text> | --clear) [--json]
  Records or removes the operator's note for agents on a required or enabled
  tool: the intent with which it was installed, quoted for agents in
  manual/this-machine.md (AGENTS.md says a note exists). Plain text, 1 to 600
  characters after trimming, at most 6 lines, no control characters. It is
  context for agents and grants no access. Same transaction as enable.
  Exit status: 0 completed/unchanged, 2 blocked or usage, 1 operation failure.
tools install <tool> [--json]
  The curated installation of a tool set up in Lazurio (gh, composio, wacli):
  for the current user, without root, into ~/.local/bin/<tool> from the
  tool's official source at its latest release (gh and wacli: the release
  archive, verified against the release's published SHA-256 checksums;
  composio: Lazurio's pinned build of the Composio CLI, by Composio's
  installer from Lazurio's fork, pinned, without agent plugins or shell
  changes).
  A tool that already works is not touched; a broken copy elsewhere on PATH
  is not shadowed. On failure it points to the prepared agent prompt. In a
  Team Environment gh is installed only, never signed in afterwards.
tools login <tool> [--phone <+number>] [--ssh-key] [--json]
  Signs the operator in to that tool in the foreground: gh prints a one-time
  code for https://github.com/login/device, composio a sign-in link, wacli a
  WhatsApp QR code drawn here (or, with --phone, a pairing code). Open it on
  any device; nothing is copied to the clipboard and no key is typed. Waits
  until signed in, failed or expired; Ctrl-C cancels. With --json one JSON
  object per state change (including the code, since this command holds the
  session). The code or link is never written to a file or log.
  codex and claude (ChatGPT, Claude) sign in through their own CLI's browser
  sign-in, codex login (never its device code) and claude auth login. On a
  Remote Environment the page opens in the Environment browser (in a T3 Code
  thread, in its panel; elsewhere in Přehled of Nová karta, by the link this
  prints) and returns to the CLI inside the Environment; without the
  Environment browser nothing starts (blocked, no-environment-browser, exit
  2). On a computer of your own the CLI opens its browser. Where the
  Organization provides AI (Codex's provider needs no sign-in) codex is not
  signed in (blocked, organization-provided). A code of Claude's code page
  is pasted here. Signed in is what codex login status and claude auth status
  confirm; then the Codex app-server unit Lazurio manages is restarted (codex)
  and T3 Code turns the signed-in providers on and reads them again. Exit 0
  only when those services read the sign-in or will by themselves.
  gh then links this Environment's SSH key to the account: the existing default
  key (~/.ssh/id_ed25519, id_ecdsa, id_rsa) or a new ed25519 key without a
  passphrase, registered on the account, GitHub's published host keys in
  ~/.ssh/known_hosts, and ssh -T git@github.com as the proof. Exit 0 only when
  the key is linked. --ssh-key (gh only) links the key for a gh that is
  signed in already, with a one-time code only when the token lacks the
  admin:public_key scope.
  In a Team Environment (preset hosted-organization-team, read from the
  Remote Environment operator's Folder) gh is not signed in and --ssh-key links nothing:
  the Environment works in GitHub through Lazurio for GitHub, set up by the
  Organization (blocked, reason team-environment, exit 2). composio and wacli
  sign in for the whole shared Environment.
tools logout <tool> [--json]
  Runs the tool's own sign-out. gh and composio forget the sign-in in this
  Environment only (revoke it at the provider); wacli unlinks the device. gh
  first removes this Environment's SSH key from the account when Lazurio
  registered it (title "Lazurio: <host name>"); the key files stay. In a Team
  Environment gh signs out only a person's account left signed in there, never
  a GitHub App (bot) identity or a token from a variable (blocked,
  team-environment).
tools composio-org [list | switch <id>] [--json]
  The Composio organizations of the signed-in account, the current one
  marked, and switching the current one. Apps connected in Composio belong to
  the account and organization of this Environment.
  Tools set up by an agent (gogcli, neon) have no curated flow: use
  lazurio tools prompt <tool>. The Environment's own vault (bitwarden) is
  set up by the Launchpad at its start or with lazurio vault setup.`;

export class ToolsUsageError extends Error {}

export type ToolsCommandOutput = Readonly<{
  code: number;
  result: Record<string, unknown>;
  text: string;
}>;

// Wide enough for the longest catalog name, so the columns stay aligned.
const nameWidth = Math.max(...toolCatalog.map((entry) => entry.name.length));

const line = (tool: ToolStatus): string =>
  tool.installed
    ? `${tool.name.padEnd(nameWidth)} ${(tool.version ?? "?").padEnd(16)} ${tool.path}${
        tool.realPath && tool.realPath !== tool.path
          ? ` -> ${tool.realPath}`
          : ""
      }${tool.versionError ? `  (version: ${tool.versionError})` : ""}${
        tool.standardPath === false ? "  (outside ~/.local/bin)" : ""
      }`
    : `${tool.name.padEnd(nameWidth)} ${"missing".padEnd(16)} ${tool.source}`;

export async function runToolsCommand(
  args: string[],
  context: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
    /** Where a running login writes each state change (default: stdout). */
    write?: (line: string) => void;
    /** Ctrl-C of a running login. */
    signal?: AbortSignal;
    /** Test seams of the curated flows. */
    install?: Partial<InstallEnvironment>;
    login?: Partial<LoginEnvironment>;
    /** The declared operator's Folder on a hosted Machine (the handover):
     * resolves to it, to undefined where there positively is none, and
     * rejects where a hosted context is there but unreadable (#83). Absent,
     * none. `login` and `logout` read its preset: gh on a Team Environment
     * (Matěj 2026-09-28). */
    hostedFolder?: (() => Promise<string | undefined>) | undefined;
    /** Opens a page in the Environment browser as `lazurio browser open`
     * does (F38's addendum of 2026-10-15), answering its link: where the
     * sign-in page of codex and claude opens on a Remote Environment. */
    openPage?:
      | ((url: string) => Promise<Readonly<{ view: string }> | null>)
      | undefined;
    /** The terminal a person types in (a code of Claude's code page). */
    input?: NodeJS.ReadableStream | undefined;
  }> = { env: process.env, platform: process.platform },
): Promise<ToolsCommandOutput> {
  let values: ToolsOptions & { locale?: string | undefined };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        folder: { type: "string" },
        "expected-revision": { type: "string" },
        locale: { type: "string" },
        "sign-in": { type: "boolean" },
        text: { type: "string" },
        clear: { type: "boolean" },
        phone: { type: "string" },
        "ssh-key": { type: "boolean" },
      },
      allowPositionals: true,
    });
    ({ values, positionals } = parsed);
    const supplied = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (supplied.has(token.name)) throw new Error("Duplicate command option");
      supplied.add(token.name);
    }
  } catch (error) {
    // An unknown option is a usage error with the help text, exit 2.
    throw new ToolsUsageError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
  }
  // Options of one command only.
  if (
    (values["sign-in"] !== undefined && positionals[0] !== "list") ||
    (values.phone !== undefined && positionals[0] !== "login") ||
    (values["ssh-key"] !== undefined && positionals[0] !== "login") ||
    ((values.text !== undefined || values.clear !== undefined) &&
      positionals[0] !== "note")
  )
    throw new ToolsUsageError(usage);
  if (positionals[0] === "prompt") {
    const locale = values.locale ?? "en";
    const name = positionals[1];
    if (
      positionals.length !== 2 ||
      name === undefined ||
      (locale !== "cs" && locale !== "en") ||
      values.folder !== undefined ||
      values["expected-revision"] !== undefined
    )
      throw new ToolsUsageError(usage);
    // On a hosted Team Environment the prompt of gh guides no sign-in; it
    // knows that from the hosted operator Folder's preset, as login does.
    // Text only: an unreadable Environment gets the ordinary prompt, and the
    // sign-in it leads to refuses there as environment-unreadable (#83).
    const environment = await hostedEnvironmentReader(context.hostedFolder)();
    const prompt = toolPrompt(name, locale, {
      team:
        environment.kind === "hosted" && sharedEnvironment(environment.preset),
    });
    const entry = activatableTools().find((tool) => tool.name === name);
    if (prompt === undefined || entry === undefined) {
      const known = activatableTools().map((tool) => tool.name);
      const result = {
        kind: "blocked",
        reason: "tool-unknown",
        tool: name,
        known,
      };
      return {
        code: 2,
        result,
        text: values.json
          ? JSON.stringify(result)
          : `Unknown tool ${name}; the catalog offers: ${known.join(", ")}`,
      };
    }
    const result = {
      kind: "tool-prompt",
      tool: name,
      locale,
      setup: entry.activation.setup,
      prompt,
    };
    return {
      code: 0,
      result,
      text: values.json ? JSON.stringify(result) : prompt,
    };
  }
  if (values.locale !== undefined) throw new ToolsUsageError(usage);
  const folderBound = ["list", "enable", "disable", "note"].includes(
    positionals[0] ?? "",
  );
  if (folderBound) return runFolderToolsCommand(positionals, values, context);
  if (values.folder !== undefined || values["expected-revision"] !== undefined)
    throw new ToolsUsageError(usage);
  const common = {
    path: context.env.PATH,
    home: context.env.HOME,
    platform: context.platform,
    run: runTool,
  };
  const curated = ["install", "login", "logout", "composio-org"];
  if (curated.includes(positionals[0] ?? "")) {
    const json = values.json === true;
    const base = {
      path: context.env.PATH,
      home: context.env.HOME,
      xdg: xdgOf(context.env),
      platform: context.platform,
      run: runTool,
    };
    const [command, name] = positionals;
    // One reader for the command: a running login's later reads cannot turn
    // a hosted Environment found at the start into none.
    const environmentNow = hostedEnvironmentReader(context.hostedFolder);
    const tools = { ...base, run: context.login?.run ?? runTool };
    const curatedContext: CuratedContext = {
      env: context.env,
      platform: context.platform,
      install: { ...base, ...context.install },
      login: {
        ...base,
        // codex and claude (F19's addendum of 2026-10-15): Codex's own
        // answer whether the Organization provides the AI, and the running
        // services that read a new sign-in.
        organizationProvides: async (tool) =>
          tool === "codex" &&
          (await readCodex(tools, converse, 10_000)).state === "provided",
        reload: (tool, signedIn) =>
          reloadAiServices({ ...tools, tool, signedIn, env: context.env }),
        ...context.login,
      },
      write: context.write ?? ((line) => console.log(line)),
      signal: context.signal,
      ...(command === "install" || command === "login" || command === "logout"
        ? { environment: await environmentNow() }
        : {}),
      environmentNow,
      signInPage: () =>
        hostedSignInPage(context.hostedFolder, context.openPage),
      input: context.input,
    };
    if (command === "composio-org") {
      const output = await runComposioOrganization(
        positionals.slice(1),
        json,
        curatedContext,
      );
      if (output === undefined) throw new ToolsUsageError(usage);
      return output;
    }
    if (positionals.length !== 2 || name === undefined)
      throw new ToolsUsageError(usage);
    if (command === "install") return runInstall(name, json, curatedContext);
    if (command === "logout") return runLogout(name, json, curatedContext);
    return runLogin(
      name,
      values.phone,
      json,
      curatedContext,
      values["ssh-key"] === true,
    );
  }
  if (positionals[0] === "status" && positionals.length === 1) {
    const result = await toolsStatus(common);
    return {
      code: 0,
      result,
      text: values.json
        ? JSON.stringify(result)
        : result.tools.map(line).join("\n"),
    };
  }
  if (positionals[0] === "update" && positionals.length === 2) {
    // A curated update (composio) runs its installer as `tools install`
    // does: with the XDG base directories, and the same test seams.
    const result = await toolsUpdate({
      ...common,
      tool: positionals[1] ?? "",
      install: {
        xdg: xdgOf(context.env),
        fetch: context.install?.fetch,
        arch: context.install?.arch,
        temporaryDirectory: context.install?.temporaryDirectory,
      },
    });
    const code =
      result.kind === "tool-updated"
        ? 0
        : result.kind === "tool-unknown"
          ? 2
          : 1;
    let text = JSON.stringify(result);
    if (!values.json) {
      if (result.kind === "tool-unknown")
        text = `Unknown tool ${result.tool}; known: ${result.known.join(", ")}`;
      else if (result.kind === "tool-not-self-updating")
        text = `${result.tool} has no official self-update path here; installed: ${result.before.version ?? "missing"}. Official source: ${result.source}`;
      else if (result.kind === "tool-updated")
        text = `${result.tool}: ${result.before.version ?? "missing"} -> ${result.after.version ?? "?"}${result.changed ? "" : " (unchanged)"}${result.next === undefined ? "" : `\n${result.next}`}`;
      else
        text = `${result.tool}: update failed${result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`}\n${result.output}`;
    }
    return { code, result, text };
  }
  throw new ToolsUsageError(usage);
}

/** Where the sign-in page of codex and claude opens for a command without a
 * Folder: the computer's own browser where there is no hosted operator
 * Folder; on a Remote Environment the Environment browser its recorded entry
 * routes, or none; unreadable where the hosted context or its Folder cannot
 * be read (fail closed, as #83). */
export async function hostedSignInPage(
  hostedFolder: (() => Promise<string | undefined>) | undefined,
  openPage:
    | ((url: string) => Promise<Readonly<{ view: string }> | null>)
    | undefined,
): Promise<SignInPage | "unreadable"> {
  let folder: string | undefined;
  try {
    folder = await hostedFolder?.();
  } catch {
    return "unreadable";
  }
  if (folder === undefined) return { kind: "own" };
  let entry: Parameters<typeof browserEntryOf>[0];
  try {
    await inspectOwnedDirectory(folder);
    const state = join(folder, ".lazurio");
    entry = (await withFolderReadLock(state, () => readFolderState(state)))
      .preferences.machine?.entry;
  } catch {
    return "unreadable";
  }
  return browserEntryOf(entry) === undefined || openPage === undefined
    ? { kind: "none" }
    : { kind: "environment", open: openPage };
}

const usage =
  "Usage: tools status [--json] | tools update <tool> [--json] | tools list --folder <Folder> [--sign-in] [--json] | tools enable|disable <tool> --folder <Folder> --expected-revision <n> [--json] | tools note <tool> --folder <Folder> --expected-revision <n> (--text <text> | --clear) [--json] | tools prompt <tool> [--locale cs|en] [--json] | tools install|logout <tool> [--json] | tools login <tool> [--phone <+number>] [--ssh-key] [--json] | tools composio-org [list | switch <id>] [--json]";

type ToolsOptions = {
  json?: boolean | undefined;
  folder?: string | undefined;
  "expected-revision"?: string | undefined;
  "sign-in"?: boolean | undefined;
  text?: string | undefined;
  clear?: boolean | undefined;
  phone?: string | undefined;
  "ssh-key"?: boolean | undefined;
};

// On a Team Environment gh's line names the way the Environment works in
// GitHub instead of inviting a person to link their SSH key, and points to
// the sign-out of a person's account left there (Matěj 2026-09-28).
const sshText = (signIn: ToolSignIn, team: boolean): string =>
  signIn.ssh === undefined
    ? ""
    : team
      ? `, ${teamGithubPhrase.en}${
          githubActionRefused({
            brokered: true,
            tool: "gh",
            action: "logout",
            signIn,
          })
            ? ""
            : "; a personal account is signed in here: lazurio tools logout gh"
        }`
      : signIn.ssh.state === "linked"
        ? ", SSH key linked"
        : signIn.ssh.state === "not-linked"
          ? ", SSH key not linked: lazurio tools login gh --ssh-key"
          : ", SSH key not verified";

const signInText = (signIn: ToolSignIn, team: boolean): string =>
  signIn.state === "signed-in"
    ? `${
        signIn.account === undefined
          ? "signed in"
          : team && signIn.identity === "app"
            ? teamGithubWorksAs.en.replace("{account}", signIn.account)
            : `signed in as ${signIn.account}${
                signIn.organization === undefined
                  ? ""
                  : ` (${signIn.organization})`
              }`
      }${sshText(signIn, team)}`
    : signIn.state === "signed-out"
      ? "not signed in"
      : "sign-in unknown";

// The Folder-bound commands (decision F18). The Folder is always explicit;
// a mutation names the revision it was decided against.
async function runFolderToolsCommand(
  positionals: readonly string[],
  values: Readonly<ToolsOptions>,
  context: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
  }>,
): Promise<ToolsCommandOutput> {
  const folder = values.folder;
  if (!folder) throw new ToolsUsageError(usage);
  const done = (
    code: number,
    result: Record<string, unknown>,
    text: string,
  ): ToolsCommandOutput => ({
    code,
    result,
    text: values.json ? JSON.stringify(result) : text,
  });
  if (positionals[0] === "list") {
    if (positionals.length !== 1 || values["expected-revision"] !== undefined)
      throw new ToolsUsageError(usage);
    const recorded = await readFolderTools(folder);
    // The live facts of `tools status`, for the activatable tools only.
    const catalog = activatableTools();
    const status = await toolsStatus({
      path: context.env.PATH,
      home: context.env.HOME,
      platform: context.platform,
      run: runTool,
      catalog,
    });
    // The sign-in probes only when asked: they may contact the providers.
    const signIns = values["sign-in"]
      ? await toolsSignIn(
          catalog.map((entry, index) => ({
            probe: entry.signInProbe,
            status: status.tools[index] as ToolStatus,
          })),
          {
            path: context.env.PATH,
            home: context.env.HOME,
            xdg: xdgOf(context.env),
            run: runTool,
          },
        )
      : undefined;
    const tools = recorded.tools.map((selection, index) => {
      const signIn = signIns?.[index];
      const note = Object.hasOwn(recorded.notes, selection.name)
        ? recorded.notes[selection.name]
        : undefined;
      // What the Organization's settings say about the tool here (decision
      // F45): a tool it does not allow is not used by agents, whatever the
      // person chose.
      const organization = Object.hasOwn(recorded.governed, selection.name)
        ? recorded.governed[selection.name]
        : undefined;
      return {
        ...(status.tools[index] as ToolStatus),
        tier: selection.tier,
        setup: selection.setup,
        enabled: selection.enabled,
        // Whether this Environment offers it (decision F44): one it does
        // not is never rendered for agents and cannot be enabled.
        offered: selection.offered,
        ...(organization === undefined ? {} : { organization }),
        ...(signIn === undefined ? {} : { signIn }),
        ...(note === undefined ? {} : { note }),
      };
    });
    return done(
      0,
      { kind: "tools-list", revision: recorded.revision, tools },
      [
        `revision ${recorded.revision}`,
        ...tools.flatMap((tool) => [
          `${tool.name.padEnd(9)} ${tool.tier.padEnd(12)} ${tool.setup.padEnd(10)} ${(
            tool.organization?.allowed === false
              ? "not allowed by the Organization"
              : tool.enabled
                ? "enabled"
                : "disabled"
          ).padEnd(9)} ${
            tool.installed
              ? `${tool.version ?? "?"} ${tool.path}${
                  tool.standardPath === false ? "  (outside ~/.local/bin)" : ""
                }`
              : `missing ${tool.source}`
          }${tool.offered ? "" : "  (not offered here)"}${
            tool.signIn === undefined
              ? ""
              : `  (${signInText(tool.signIn, recorded.sharedEnvironment)})`
          }`,
          ...(tool.note === undefined
            ? []
            : [
                `${" ".repeat(10)}operator's note:`,
                ...quoteToolNote(tool.note).map(
                  (line) => `${" ".repeat(10)}${line}`,
                ),
              ]),
        ]),
      ].join("\n"),
    );
  }
  const name = positionals[1];
  const revision = values["expected-revision"] ?? "";
  if (
    positionals.length !== 2 ||
    name === undefined ||
    !/^[1-9][0-9]*$/.test(revision) ||
    !Number.isSafeInteger(Number(revision))
  )
    throw new ToolsUsageError(usage);
  if (positionals[0] === "note")
    return runNoteCommand(folder, name, Number(revision), values, done);
  const enabling = positionals[0] === "enable";
  const entry = activatableTools().find((tool) => tool.name === name);
  if (!entry) {
    const known = activatableTools().map((tool) => tool.name);
    return done(
      2,
      { kind: "blocked", reason: "tool-unknown", tool: name, known },
      `Unknown tool ${name}; the catalog offers: ${known.join(", ")}`,
    );
  }
  try {
    const recorded = await readFolderTools(folder);
    // A required tool is always on, but the command still speaks about one
    // real Folder at the revision the caller saw.
    if (entry.activation.tier === "required") {
      if (recorded.revision !== Number(revision))
        return done(
          2,
          { kind: "blocked", reason: "stale-revision", tool: name },
          "Blocked: stale-revision",
        );
      return enabling
        ? done(
            0,
            { kind: "unchanged", tool: name },
            `${name} is required and always enabled`,
          )
        : done(
            2,
            { kind: "blocked", reason: "tool-required", tool: name },
            `${name} is required and cannot be disabled`,
          );
    }
    // A tool the Organization does not allow here is its decision now
    // (decision F45): the person's choice of it does not change.
    if (
      Object.hasOwn(recorded.governed, name) &&
      recorded.governed[name]?.allowed === false
    )
      return done(
        2,
        { kind: "blocked", reason: "organization-governed", tool: name },
        `Blocked: organization-governed (the Organization does not allow ${name} on this Environment; only its Admin can allow it, in the Organization's settings)`,
      );
    const tools = enabling
      ? [...new Set([...recorded.enabled, name])].sort()
      : recorded.enabled.filter((tool) => tool !== name);
    // Without notes the recorded ones of the tools that stay on are kept, so
    // disabling a tool removes its note in the same change.
    const result = await updateTools(folder, Number(revision), tools);
    // On an Environment shared by several operators a sign-in of the tool is
    // shared by all of them; say so whenever a tool is enabled there.
    const shared =
      "warning" in sharedSignInsWarning(recorded, enabling ? tools : []);
    return done(
      result.kind === "blocked" ? 2 : 0,
      {
        ...result,
        tool: name,
        ...(shared ? { warning: "shared-environment-sign-ins" } : {}),
      },
      result.kind === "updated"
        ? `${name} ${enabling ? "enabled" : "disabled"}; Folder revision ${result.revision}${
            shared ? `\n${sharedSignInsText}` : ""
          }`
        : result.kind === "unchanged"
          ? `${name} is already ${enabling ? "enabled" : "disabled"}`
          : `Blocked: ${result.reason}${"path" in result ? ` (${result.path})` : ""}`,
    );
  } catch (error) {
    // A foreign top-level entry is a named refusal before any write.
    if (!(error instanceof FolderAdoptionError)) throw error;
    return done(
      2,
      {
        kind: "blocked",
        reason: `folder-${error.code}`,
        entry: error.entry,
        tool: name,
      },
      `Blocked: folder-${error.code} (${error.entry})`,
    );
  }
}

// `tools note`: the full next set of notes is the recorded one with this
// tool's note set or removed, at the revision the caller saw, through the same
// transaction as enable and disable.
async function runNoteCommand(
  folder: string,
  name: string,
  revision: number,
  values: Readonly<ToolsOptions>,
  done: (
    code: number,
    result: Record<string, unknown>,
    text: string,
  ) => ToolsCommandOutput,
): Promise<ToolsCommandOutput> {
  if ((values.text === undefined) === (values.clear !== true))
    throw new ToolsUsageError(usage);
  const entry = activatableTools().find((tool) => tool.name === name);
  if (!entry) {
    const known = activatableTools().map((tool) => tool.name);
    return done(
      2,
      { kind: "blocked", reason: "tool-unknown", tool: name, known },
      `Unknown tool ${name}; the catalog offers: ${known.join(", ")}`,
    );
  }
  const note =
    values.text === undefined ? undefined : normalizeToolNote(values.text);
  const problem = note === undefined ? null : toolNoteProblem(note);
  if (problem !== null)
    return done(
      2,
      { kind: "blocked", reason: "note-invalid", problem, tool: name },
      `Blocked: note-invalid (${problem}; 1 to ${toolNoteLimits.characters} characters, at most ${toolNoteLimits.lines} lines, no control characters)`,
    );
  try {
    const recorded = await readFolderTools(folder);
    const on = recorded.tools.some(
      (tool) => tool.name === name && tool.enabled,
    );
    if (!on && note !== undefined)
      return done(
        2,
        { kind: "blocked", reason: "tool-not-enabled", tool: name },
        `Blocked: tool-not-enabled (enable ${name} before you leave a note on it)`,
      );
    const next: Record<string, string> = { ...recorded.notes };
    if (note === undefined) delete next[name];
    else next[name] = note;
    // Sorted keys: the one representation of a set of notes.
    const notes = Object.fromEntries(
      Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const result = await updateTools(folder, revision, recorded.enabled, notes);
    return done(
      result.kind === "blocked" ? 2 : 0,
      { ...result, tool: name },
      result.kind === "updated"
        ? `${name}: note ${note === undefined ? "removed" : "saved"}; Folder revision ${result.revision}`
        : result.kind === "unchanged"
          ? `${name}: the note is already ${note === undefined ? "absent" : "this text"}`
          : `Blocked: ${result.reason}${"path" in result ? ` (${result.path})` : ""}`,
    );
  } catch (error) {
    if (!(error instanceof FolderAdoptionError)) throw error;
    return done(
      2,
      {
        kind: "blocked",
        reason: `folder-${error.code}`,
        entry: error.entry,
        tool: name,
      },
      `Blocked: folder-${error.code} (${error.entry})`,
    );
  }
}
