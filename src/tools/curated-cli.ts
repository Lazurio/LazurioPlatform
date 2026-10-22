import { createInterface } from "node:readline";
import { sharedEnvironment } from "../folder/render";
import { pilotRefusesCuratedGh } from "../github/pilot";
import {
  type AiServices,
  aiProviderName,
  aiServicesReady,
  isAiProvider,
} from "./ai";
import { activatableTools, executorToolName, vaultToolName } from "./catalog";
import type { GitIdentity, GitIdentityFailure } from "./git-identity";
import {
  githubLoginRefused,
  githubRefusal,
  githubRefusalText,
  type HostedEnvironment,
  HostedEnvironmentUnreadable,
} from "./github-gate";
import {
  curatedTool,
  type InstallEnvironment,
  type InstallResult,
  installTool,
} from "./install";
import {
  createLoginSessions,
  type LoginEnvironment,
  type LoginState,
  type LogoutResult,
  type SignInPage,
} from "./login";
import { qrMatrix, qrTerminal } from "./qr";
import type { SshKeyRemoval, SshLink, SshLinkFailure } from "./ssh-key";
import { githubRuleText, teamGithubText } from "./team-github";

/** The terminal adapter of the curated flows (decision F19): `tools install`,
 * `tools login`, `tools logout` and `tools composio-org`. The same core the
 * Launchpad serves; the terminal holds the login session for as long as the
 * command runs. */
export type CuratedContext = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  /** Test seams and the process's own environment for the core. */
  install: InstallEnvironment;
  login: LoginEnvironment;
  /** Where a running login writes each state change. */
  write: (line: string) => void;
  /** Ctrl-C: cancels a running login. */
  signal?: AbortSignal | undefined;
  /** The kind of Environment at the start of install, login and logout:
   * the hosted operator Folder's preset, none on a workstation, or
   * unreadable, where gh's sign-in, key linking and sign-out stop before gh
   * runs (#83). Absent: none. */
  environment?: HostedEnvironment | undefined;
  /** The same read again now: a running gh login re-checks the Team rule
   * before every step that changes the account or the Machine, and stops as
   * `environment-unreadable` when it can no longer be read. */
  environmentNow?: (() => Promise<HostedEnvironment>) | undefined;
  /** codex and claude: where their sign-in page opens here, read at the
   * start (F19's addendum of 2026-10-15): the computer's own browser, the
   * Environment browser of a Remote Environment, none there, or unreadable,
   * where the sign-in stops before anything runs. Absent: the computer's
   * own browser. */
  signInPage?: (() => Promise<SignInPage | "unreadable">) | undefined;
  /** The terminal a person types in: a code of Claude Code's code page is
   * pasted here. Absent where nobody types (an agent, a pipe). */
  input?: NodeJS.ReadableStream | undefined;
}>;

/** gh's sign-in, key linking or sign-out on an Environment whose kind could
 * not be read: stopped before gh runs, with the reason a running session
 * ends with (fail closed, #83). Refusal only: nothing is signed out or
 * removed. */
function environmentUnreadable(
  tool: string,
  json: boolean,
  action: "login" | "logout",
): CuratedOutput {
  const result: LoginState = Object.freeze({
    kind: "failed",
    tool,
    reason: "environment-unreadable",
  });
  return {
    code: 1,
    result,
    text: json
      ? JSON.stringify(result)
      : action === "login"
        ? loginLines(result).join("\n")
        : `${tool}: sign-out stopped: the kind of this Environment could not be read, so nothing was signed out.`,
  };
}

/** gh's curated sign-in, key linking or sign-out while gh and Git are wired
 * to the shared GitHub App sign-in pilot (decision F48): an
 * account-wide sign-in and an account SSH key are what the pilot replaces,
 * and through its launcher neither would work. Refused before gh runs. */
async function githubPilotRefusal(
  env: Readonly<Record<string, string | undefined>>,
  json: boolean,
  action: "login" | "ssh-key" | "logout",
): Promise<CuratedOutput | undefined> {
  const pilot = await pilotRefusesCuratedGh(env);
  if (pilot === undefined) return undefined;
  const result = {
    kind: "blocked",
    reason: "github-sign-in-pilot",
    tool: "gh",
    action,
  };
  const text =
    action === "logout"
      ? `This Environment uses one shared GitHub App sign-in (pilot, decision F48). Sign out: lazurio github sign-out. A gh sign-in left from before the pilot is removed with gh auth logout --hostname github.com.`
      : `This Environment uses one shared GitHub App sign-in (pilot, decision F48); an account-wide gh sign-in or SSH key is not set up here. Sign in: lazurio github sign-in. Back to the account-wide sign-in: lazurio github pilot unwire.`;
  return { code: 2, result, text: json ? JSON.stringify(result) : text };
}

/** On an Environment shared by several operators (the Team preset). */
export const sharedSignInsText =
  "Warning: this is the whole Team's shared Environment. Sign in with team accounts only; whatever is signed in here, anyone in the Team can use. Personal accounts belong in your own Environment.";

export type CuratedOutput = Readonly<{
  code: number;
  result: Record<string, unknown>;
  text: string;
}>;

// A command about one tool: an unknown name or an agent-setup tool is
// refused with a pointer to what does apply.
export function refuseTool(
  name: string,
  json: boolean,
): CuratedOutput | undefined {
  const entry = activatableTools().find((tool) => tool.name === name);
  if (entry === undefined) {
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
      text: json
        ? JSON.stringify(result)
        : `Unknown tool ${name}; the catalog offers: ${known.join(", ")}`,
    };
  }
  // The Environment's vault has its own flow (decisions F43, F53): no
  // sign-in of a person, the Environment's own account and vault.
  if (name === vaultToolName) {
    const result = {
      kind: "blocked",
      reason: "setup-vault",
      tool: name,
      command: "lazurio vault setup",
    };
    return {
      code: 2,
      result,
      text: json
        ? JSON.stringify(result)
        : `${name} is the Environment's own vault: the Launchpad sets it up at its start, and lazurio vault setup does the same; lazurio vault status says how it is.`,
    };
  }
  // Executor is set up by Lazurio itself (decision F44).
  if (name === executorToolName) {
    const result = {
      kind: "blocked",
      reason: "setup-executor",
      tool: name,
      command: "lazurio executor setup",
    };
    return {
      code: 2,
      result,
      text: json
        ? JSON.stringify(result)
        : `${name} is set up by Lazurio itself: lazurio executor setup (or Settings → Tools → executor) installs and repairs it.`,
    };
  }
  if (curatedTool(name) === undefined) {
    const result = {
      kind: "blocked",
      reason: "setup-agent",
      tool: name,
      prompt: `lazurio tools prompt ${name}`,
    };
    return {
      code: 2,
      result,
      text: json
        ? JSON.stringify(result)
        : `${name} is set up by an agent, not by Lazurio. Give an agent the prepared prompt: lazurio tools prompt ${name}`,
    };
  }
  return undefined;
}

const stageText: Record<string, string> = {
  preflight: "before anything was downloaded",
  resolve: "while finding the latest release",
  download: "while downloading",
  checksum: "while verifying the published checksum",
  extract: "while reading the archive",
  place: "while placing the binary",
  installer: "in the official installer",
  verify: "when the installed tool was checked",
};

export function installText(
  result: InstallResult,
  team = false,
  /** A public Environment, which has no GitHub identity (decision F55). */
  isPublic = false,
): string {
  switch (result.kind) {
    case "installed":
      return [
        `${result.tool} ${result.version ?? ""} installed at ${result.path}`.replace(
          "  ",
          " ",
        ),
        ...(result.onPath
          ? []
          : [
              "~/.local/bin is not on this PATH: add it in your shell profile so the tool is found.",
            ]),
        // A Team Environment's gh is not signed in (Matěj 2026-09-28).
        team && result.tool === "gh"
          ? githubRuleText(isPublic).en
          : `Next: lazurio tools login ${result.tool}`,
      ].join("\n");
    case "already-installed":
      return `${result.tool} ${result.version ?? ""} already works at ${result.path}; nothing was changed.`.replace(
        "  ",
        " ",
      );
    case "unsupported-platform":
      return `The curated installer of ${result.tool} does not cover ${result.platform} ${result.arch}. Give an agent the prepared prompt: lazurio tools prompt ${result.tool}`;
    case "install-failed":
      return [
        `The installation of ${result.tool} failed ${stageText[result.stage] ?? result.stage} (${result.reason}). Nothing that already worked was changed.`,
        ...(result.detail
          ? ["Last lines of the installer:", result.detail]
          : []),
        `Finish it with an agent: lazurio tools prompt ${result.tool}`,
      ].join("\n");
  }
}

export async function runInstall(
  name: string,
  json: boolean,
  context: CuratedContext,
): Promise<CuratedOutput> {
  const refused = refuseTool(name, json);
  if (refused) return refused;
  if (!json) context.write(`Installing ${name} from its official source…`);
  const result = await installTool(name, context.install);
  return {
    code:
      result.kind === "installed" || result.kind === "already-installed"
        ? 0
        : 1,
    result,
    text: json
      ? JSON.stringify(result)
      : installText(
          result,
          context.environment?.kind === "hosted" &&
            sharedEnvironment(context.environment.preset),
          context.environment?.kind === "hosted" &&
            context.environment.audience === "public",
        ),
  };
}

const failureText: Record<string, string> = {
  "not-installed": "the tool is not installed; run lazurio tools install first",
  "unexpected-url":
    "the tool offered an address that is not its official sign-in page, so it was not shown",
  "unexpected-output": "the tool answered in a form Lazurio does not know",
  "tool-exit": "the tool ended without completing the sign-in",
  "not-confirmed":
    "the tool did not complete it: its status does not say signed in, so it was stopped",
  "invalid-phone":
    "the phone number is not an international number (+ country code and number)",
  "spawn-failed": "the tool could not be started",
  "not-signed-in":
    "gh has no sign-in in this Environment; sign in first: lazurio tools login gh",
  "environment-unreadable":
    "the kind of this Environment could not be read, so the sign-in stopped before changing anything further",
  "no-challenge":
    "the tool showed no link, code or QR code within a minute, so it was stopped; check that this Environment reaches the internet and try again",
  "browser-unavailable":
    "the Environment browser did not open the sign-in page, so the CLI was stopped",
  "provider-unknown":
    "Codex did not answer whether your Organization provides the AI in this Environment, so nothing was started; try again",
};

const sshFailureText: Record<SshLinkFailure, string> = {
  "not-signed-in": "gh is not signed in",
  "scope-missing":
    "the gh sign-in may not manage the SSH keys of your account (scope admin:public_key)",
  "keygen-missing": "ssh-keygen is not installed in this Environment",
  "keygen-failed": "a new key could not be created in ~/.ssh",
  "key-passphrase":
    "the existing key {path} is protected by a passphrase, which agents cannot enter; it was left as it is",
  "key-incomplete":
    "the existing key {path} has no matching .pub file; it was left as it is",
  "key-unreadable":
    "the existing key {path} could not be read; it was left as it is",
  "key-in-use":
    "GitHub refuses the key {path} because it is already in use there (another GitHub account or a repository's deploy key); no second key was created",
  "register-failed": "the key could not be registered on your GitHub account",
  "host-keys-unavailable": "GitHub's published host keys could not be read",
  "host-key-mismatch":
    "~/.ssh/known_hosts holds a github.com host key that differs from the keys GitHub publishes; nothing was changed",
  "known-hosts-failed": "~/.ssh/known_hosts could not be read or written",
  "ssh-missing": "ssh is not installed in this Environment",
  "proof-failed": "ssh -T git@github.com did not answer with GitHub's greeting",
  "proof-other-account":
    "GitHub greeted another account over SSH ({provedAs}): another key of this Environment is offered first",
};

/** One sentence for why the SSH key is not linked. */
export function sshFailureSentence(
  ssh: Extract<SshLink, { state: "not-linked" }>,
): string {
  return (sshFailureText[ssh.reason] ?? ssh.reason)
    .replace("{path}", ssh.key?.path ?? "~/.ssh")
    .replace("{provedAs}", ssh.provedAs ?? "?");
}

function sshLines(account: string | undefined, ssh: SshLink): string[] {
  const who = account ?? "the signed-in account";
  if (ssh.state === "linked")
    return [
      `SSH key linked: ${ssh.key.path} (${ssh.key.fingerprint}, ${
        ssh.key.created ? "created now" : "existing key, unchanged"
      }; ${
        ssh.registration === "added"
          ? "registered on your account now"
          : "already registered on your account"
      }). git clone git@github.com:… works as ${who}.`,
    ];
  return [
    `The SSH key is NOT linked: ${sshFailureSentence(ssh)}.`,
    `git over SSH does not work as ${who} yet. Try again: lazurio tools login gh --ssh-key`,
    "Or finish it with an agent: lazurio tools prompt gh",
  ];
}

const gitIdentityFailureText: Record<GitIdentityFailure, string> = {
  "git-missing": "git is not installed in this Environment",
  "config-unreadable": "git could not read its configuration",
  "viewer-unavailable": "GitHub did not return the signed-in account",
  "write-failed": "git config --global refused the write",
};

// The person's Git identity after a gh sign-in (decision F19, addendum
// 2026-10-14): nothing to say when git had it.
function gitIdentityLines(identity: GitIdentity): string[] {
  if (identity.state === "present") return [];
  const fix =
    "Set it with your GitHub profile name (else your login) and <id>+<login>@users.noreply.github.com: git config --global user.name … and user.email …, or sign in again: lazurio tools login gh";
  if (identity.state === "set") {
    const written = identity.fields.map((field) =>
      field === "user.name"
        ? `user.name ${identity.identity.name}`
        : `user.email ${identity.identity.email}`,
    );
    const incomplete = identity.incomplete;
    return [
      `Git identity for your commits: set ${written.join(" and ")} (git config --global).`,
      ...(incomplete === undefined
        ? []
        : [
            `${incomplete.missing.join(" and ")} NOT set: ${gitIdentityFailureText[incomplete.reason] ?? incomplete.reason}. Commits in this Environment fail with "Author identity unknown" until it is.`,
            fix,
          ]),
    ];
  }
  return [
    `The Git identity is NOT set: ${gitIdentityFailureText[identity.reason] ?? identity.reason}. Commits in this Environment fail with "Author identity unknown" until it is.`,
    fix,
  ];
}

/** Whether a login reached its full target: for gh, the SSH key linked; for
 * codex and claude, the running services read the sign-in or will by
 * themselves. */
export function loginComplete(state: LoginState): boolean {
  return (
    state.kind === "signed-in" &&
    (state.tool !== "gh" || state.ssh?.state === "linked") &&
    (state.services === undefined || aiServicesReady(state.services))
  );
}

// What became of the services that read an AI sign-in (root decision 0201
// point 4): nothing to say where there are none.
export function aiServicesLines(tool: string, services: AiServices): string[] {
  const lines: string[] = [];
  if (services.appServer?.state === "restarted")
    lines.push(
      "The Codex app-server was restarted, so Codex clients of this Environment use the new sign-in.",
    );
  if (services.appServer?.state === "failed")
    lines.push(
      "The Codex app-server could NOT be restarted: Codex clients of this Environment keep the old sign-in until it is (systemctl --user restart lazurio-codex-app-server.service).",
    );
  const t3 = services.t3;
  switch (t3.state) {
    case "refreshed":
      lines.push(
        `Chat (T3 Code) turned on and read again: ${t3.providers
          .map(
            (provider) =>
              `${provider.provider} ${
                !provider.enabled
                  ? "turned off"
                  : provider.auth === "authenticated"
                    ? "ready"
                    : "turned on, its sign-in still being checked"
              }`,
          )
          .join(", ")}.`,
      );
      break;
    case "not-supported":
      lines.push(
        "Chat (T3 Code) reads the new sign-in at its next check, within about five minutes.",
      );
      break;
    case "driver-mismatch":
      lines.push(
        `Chat (T3 Code) did NOT turn on ${tool}: ${t3.mismatches
          .map(
            (mismatch) =>
              `its provider "${mismatch.instanceId}" runs the driver ${mismatch.driver}, not ${mismatch.provider}`,
          )
          .join(
            "; ",
          )}. Change or remove that provider in Chat's Settings → Providers, then sign in again.`,
      );
      break;
    case "failed":
      lines.push(
        t3.reason === "not-enabled"
          ? `Chat (T3 Code) did NOT turn on ${t3.providers.join(" and ")}: it answered without an enabled ${t3.providers.join(" or ")} provider. Check the providers in Chat's Settings → Providers, then sign in again.`
          : t3.reason === "not-running"
            ? "Chat (T3 Code) is not running, so it was not asked; it reads the sign-in when it starts."
            : `Chat (T3 Code) did NOT read the sign-in again (${t3.reason}); it reads it at its next check, within about five minutes.`,
      );
      break;
    case "not-installed":
      break;
  }
  return lines;
}

// What a person reads for one state; `null` when nothing new is to be said.
// `typing`: a person types in this terminal, where a code can be pasted;
// `deviceCode`: codex signs in by code (root decision 0201 point 10).
function loginLines(
  state: LoginState,
  options: Readonly<{ typing?: boolean; deviceCode?: boolean }> = {},
): string[] {
  const { typing = false, deviceCode = false } = options;
  const again = `lazurio tools login ${state.tool}${deviceCode ? " --device-code" : ""}`;
  switch (state.kind) {
    case "pending": {
      if (state.step === "ssh-key")
        return [
          "Signed in to GitHub. Linking the SSH key of this Environment: key pair, registration on your account, GitHub's host keys, proof over SSH…",
        ];
      if (state.step === "services")
        return [
          "Signed in. Asking the running services (the Codex app-server, Chat) to use the new sign-in…",
        ];
      const challenge = state.challenge;
      if (challenge === undefined) return ["Starting the sign-in…"];
      if (challenge.kind === "page") {
        const name = isAiProvider(state.tool)
          ? aiProviderName[state.tool]
          : state.tool;
        return [
          challenge.view !== undefined
            ? `Sign in to ${name} in the Environment browser: ${challenge.view}`
            : `Sign in to ${name} in the browser window that opened. If none opened, open: ${challenge.url ?? ""}`,
          ...(challenge.code && typing
            ? ["If the page ends on a code, paste it here and press Enter."]
            : []),
          "Waiting for you to finish the sign-in. Ctrl-C cancels.",
        ];
      }
      if (challenge.kind === "device-code") {
        // gh's sign-in, or ChatGPT's by code, with its setting for a code
        // OpenAI's page refuses (root decision 0201 point 10).
        const chatgpt = state.tool === "codex";
        return [
          `Sign in to ${chatgpt ? "ChatGPT" : "GitHub"} on any device (phone or computer):`,
          `  1. Open ${challenge.url}`,
          `  2. Enter the code  ${challenge.code}`,
          ...(chatgpt
            ? [
                "The code is valid for 15 minutes. If ChatGPT's page refuses it, turn sign-in with a code on in your ChatGPT security settings (for a work account, its admin allows it) and enter it again.",
                "Waiting for you to enter the code. Ctrl-C cancels.",
              ]
            : ["Waiting for you to finish in the browser. Ctrl-C cancels."]),
        ];
      }
      if (challenge.kind === "url")
        return [
          "Open this link in a browser on any device and sign in to Composio:",
          `  ${challenge.url}`,
          `The link is valid until ${new Date(state.expiresAt).toLocaleTimeString()}. Waiting… Ctrl-C cancels.`,
        ];
      if (challenge.kind === "qr")
        return [
          "Scan this QR code with WhatsApp on your phone:",
          "Settings (or ⋮ menu) > Linked devices > Link a device.",
          "",
          ...qrTerminal(qrMatrix(challenge.payload)),
          "",
          "The code changes every few seconds; a new one is drawn here.",
          "Cannot scan it? Pair with a phone number instead: lazurio tools login wacli --phone <+number>",
        ];
      return [
        `Pairing code for ${challenge.phone}:  ${challenge.code}`,
        "On your phone in WhatsApp: Linked devices > Link a device > Link with phone number instead, then enter the code.",
        "Keep this command running until the pairing completes. Ctrl-C cancels.",
      ];
    }
    case "signed-in":
      return [
        `${state.tool}: ${state.already === true ? "already signed in in this Environment" : "signed in"}${
          state.account === undefined
            ? ""
            : ` as ${state.account}${
                state.organization === undefined
                  ? ""
                  : ` (${state.organization})`
              }`
        }${state.already === true ? "; nothing was paired or changed" : ""}.`,
        ...(state.tool === "gh" && state.ssh !== undefined
          ? sshLines(state.account, state.ssh)
          : []),
        ...(state.tool === "gh" && state.gitIdentity !== undefined
          ? gitIdentityLines(state.gitIdentity)
          : []),
        ...(state.tool === "composio"
          ? [
              "Apps connected in Composio belong to this account and its current organization for the whole Environment.",
              "See or change the organization: lazurio tools composio-org list",
            ]
          : []),
        ...(state.services === undefined
          ? []
          : aiServicesLines(state.tool, state.services)),
      ];
    case "failed":
      return [
        `Sign-in of ${state.tool} failed: ${failureText[state.reason] ?? state.reason}.`,
        // An AI CLI has no agent prompt: without AI there is no agent.
        isAiProvider(state.tool)
          ? `Try again: ${again}`
          : `Finish it with an agent: lazurio tools prompt ${state.tool}`,
      ];
    case "blocked":
      if (state.reason === "no-environment-browser")
        return [
          `This Remote Environment has no Environment browser, so the sign-in page could not return to ${state.tool} here. Nothing was started; an update of the Environment adds the browser.`,
          ...(state.tool === "codex"
            ? [
                "ChatGPT can sign in with a code on any device instead: lazurio tools login codex --device-code",
              ]
            : []),
        ];
      if (state.reason === "organization-provided")
        return [
          "Your Organization provides AI in this Environment: Codex uses its provider and needs no ChatGPT sign-in. Nothing was started.",
        ];
      return [teamGithubText.en];
    case "expired":
      return [
        `The sign-in of ${state.tool} expired before it was completed. Start it again: ${again}`,
        // OpenAI's page refuses a code while the setting is off, and Codex
        // only waits.
        ...(deviceCode
          ? [
              "If ChatGPT's page refused the code, turn sign-in with a code on in your ChatGPT security settings first.",
            ]
          : []),
      ];
    case "cancelled":
      return [`The sign-in of ${state.tool} was cancelled.`];
    case "none":
      return [];
  }
}

export async function runLogin(
  name: string,
  phone: string | undefined,
  json: boolean,
  context: CuratedContext,
  sshKey = false,
  deviceCode = false,
): Promise<CuratedOutput> {
  // codex and claude sign in here too (F19's addendum of 2026-10-15),
  // though agents are not told about them as catalog tools.
  const ai = isAiProvider(name);
  const refused = ai ? undefined : refuseTool(name, json);
  if (refused) return refused;
  // ChatGPT's sign-in by code (root decision 0201 point 10): codex only.
  if (deviceCode && name !== "codex") {
    const result = {
      kind: "blocked",
      reason: "device-code-codex-only",
      tool: name,
    };
    return {
      code: 2,
      result,
      text: json
        ? JSON.stringify(result)
        : "--device-code applies to codex only (ChatGPT's sign-in with a code).",
    };
  }
  if (sshKey && name !== "gh") {
    const result = { kind: "blocked", reason: "ssh-key-gh-only", tool: name };
    return {
      code: 2,
      result,
      text: json
        ? JSON.stringify(result)
        : "--ssh-key applies to gh only (the SSH key of this Environment on GitHub).",
    };
  }
  if (phone !== undefined && name !== "wacli") {
    const result = { kind: "blocked", reason: "phone-wacli-only", tool: name };
    return {
      code: 2,
      result,
      text: json
        ? JSON.stringify(result)
        : "--phone applies to wacli only (WhatsApp pairing).",
    };
  }
  if (name === "gh") {
    const pilot = await githubPilotRefusal(
      context.env,
      json,
      sshKey ? "ssh-key" : "login",
    );
    if (pilot !== undefined) return pilot;
  }
  const environment = context.environment ?? { kind: "none" };
  if (environment.kind === "unreadable" && name === "gh")
    return environmentUnreadable(name, json, "login");
  // Where an AI CLI's page opens: the kind of Environment decides it, and
  // one that cannot be read stops the sign-in before anything runs. By code
  // the person opens OpenAI's page on any device, so no page opens here.
  let signInPage: SignInPage | undefined;
  if (ai && !deviceCode) {
    const page =
      environment.kind === "unreadable"
        ? "unreadable"
        : await (context.signInPage?.() ?? { kind: "own" as const });
    if (page === "unreadable")
      return environmentUnreadable(name, json, "login");
    signInPage = page;
  }
  const environmentNow = context.environmentNow;
  const sessions = createLoginSessions({
    ...context.login,
    ...(signInPage === undefined ? {} : { signInPage }),
    ...(environmentNow === undefined
      ? {}
      : {
          // Unreadable now: the session fails as environment-unreadable
          // before the step (LoginEnvironment.refused throws).
          refused: async (tool, action) => {
            const now = await environmentNow();
            if (now.kind === "unreadable")
              throw new HostedEnvironmentUnreadable(now.source);
            return githubLoginRefused(
              now.kind === "hosted" ? now.preset : undefined,
              tool,
              action,
            );
          },
        }),
  });
  // gh on a Team Environment (Matěj 2026-09-28): neither a person's
  // sign-in nor their SSH key; the Organization's Lazurio for GitHub is the
  // way. Refused before anything runs. (Another tool on an unreadable
  // Environment runs as before: the Team rule is gh's only.)
  const preset = environment.kind === "hosted" ? environment.preset : undefined;
  const audience =
    environment.kind === "hosted" ? environment.audience : undefined;
  const refusal = await githubRefusal(
    preset,
    name,
    sshKey ? "ssh-key" : "login",
    sessions,
  );
  if (refusal !== undefined) {
    await sessions.close();
    return {
      code: 2,
      result: refusal,
      text: json
        ? JSON.stringify(refusal)
        : githubRefusalText(refusal, "en", audience),
    };
  }
  if (!json && preset !== undefined && sharedEnvironment(preset))
    context.write(sharedSignInsText);
  const emit = (state: LoginState) => {
    if (json) context.write(JSON.stringify(state));
    else
      for (const line of loginLines(state, {
        typing: context.input !== undefined,
        deviceCode,
      }))
        context.write(line);
  };
  const aborted = new Promise<"aborted">((resolve) => {
    if (context.signal?.aborted) resolve("aborted");
    context.signal?.addEventListener("abort", () => resolve("aborted"), {
      once: true,
    });
  });
  // A code of Claude Code's code page, pasted in the terminal, goes to the
  // waiting CLI; it is never echoed or kept.
  let typing: ReturnType<typeof createInterface> | undefined;
  const takeCodes = (handle: string) => {
    if (typing !== undefined || context.input === undefined) return;
    typing = createInterface({ input: context.input, terminal: false });
    typing.on("line", (line) => {
      if (line.trim() === "") return;
      const taken = sessions.code(name, handle, line);
      // With --json only the session's states are written.
      if (json) return;
      if (taken === "invalid-code")
        context.write(
          "That is not the whole code. Copy all of it from the page and paste it again.",
        );
      else if (taken === "accepted")
        context.write("Code handed over; waiting for the CLI…");
    });
  };
  try {
    let state = await sessions.start(name, {
      ...(phone === undefined ? {} : { phone }),
      ...(sshKey ? { sshKey } : {}),
      ...(deviceCode ? { deviceCode } : {}),
    });
    emit(state);
    let shown = JSON.stringify(state);
    while (state.kind === "pending") {
      const handle = state.session;
      if (state.challenge?.kind === "page" && state.challenge.code)
        takeCodes(handle);
      const outcome = await Promise.race([
        sessions.changed(name, handle, 1_000),
        aborted,
      ]);
      if (outcome === "aborted") {
        state = sessions.cancel(name, handle);
        emit(state);
        break;
      }
      state = sessions.poll(name, handle);
      const next = JSON.stringify(state);
      if (next !== shown) emit(state);
      shown = next;
    }
    // WhatsApp's first sync runs on in the pairing process: wait for it,
    // unless the operator stops it.
    if (state.kind === "signed-in" && name === "wacli") {
      if (!json)
        context.write(
          "Finishing the first sync of your messages; this can take a few minutes. Ctrl-C stops it safely.",
        );
      await Promise.race([sessions.settled(), aborted]);
    }
    return {
      // A refusal of the Team rule is a refusal like every other one.
      code: loginComplete(state) ? 0 : state.kind === "blocked" ? 2 : 1,
      result: state,
      text: "",
    };
  } finally {
    typing?.close();
    await sessions.close();
  }
}

export async function runLogout(
  name: string,
  json: boolean,
  context: CuratedContext,
): Promise<CuratedOutput> {
  const refused = refuseTool(name, json);
  if (refused) return refused;
  if (name === "gh") {
    const pilot = await githubPilotRefusal(context.env, json, "logout");
    if (pilot !== undefined) return pilot;
  }
  const environment = context.environment ?? { kind: "none" };
  // Whether this is a Team Environment decides which account may be signed
  // out; unknown, gh is not signed out at all (#83).
  if (environment.kind === "unreadable" && name === "gh")
    return environmentUnreadable(name, json, "logout");
  const sessions = createLoginSessions(context.login);
  let result: LogoutResult;
  try {
    // A Team Environment signs out a person's account left there, never
    // the Organization's identity (Matěj 2026-09-28).
    const refusal = await githubRefusal(
      environment.kind === "hosted" ? environment.preset : undefined,
      name,
      "logout",
      sessions,
    );
    if (refusal !== undefined)
      return {
        code: 2,
        result: refusal,
        text: json
          ? JSON.stringify(refusal)
          : githubRefusalText(
              refusal,
              "en",
              environment.kind === "hosted" ? environment.audience : undefined,
            ),
      };
    result = await sessions.logout(name);
  } finally {
    await sessions.close();
  }
  const text =
    result.kind === "logged-out"
      ? [
          result.revocation === "remote"
            ? `${name}: signed out; the linked device was removed from the account.`
            : `${name}: signed out in this Environment. The provider still lists this sign-in until you revoke it there.`,
          ...(result.sshKey === undefined
            ? []
            : [sshRemovalText(result.sshKey)]),
        ].join("\n")
      : `${name}: sign-out failed (${result.reason}).`;
  return {
    code: result.kind === "logged-out" ? 0 : 1,
    result,
    text: json ? JSON.stringify(result) : text,
  };
}

/** What sign-out did with this Machine's SSH key on the GitHub account. */
export function sshRemovalText(removal: SshKeyRemoval): string {
  const key =
    removal.fingerprint === undefined ? "" : ` (${removal.fingerprint})`;
  const where =
    "Remove it under GitHub Settings > SSH and GPG keys (https://github.com/settings/keys) if this Environment must lose access.";
  switch (removal.state) {
    case "removed":
      return `The SSH key of this Environment${key} was removed from your GitHub account; the key files in ~/.ssh stay.`;
    case "not-registered":
      return `The SSH key of this Environment${key} was not registered on your GitHub account.`;
    case "no-key":
      return "This Environment has no SSH key in ~/.ssh; nothing was removed from GitHub.";
    case "kept-not-lazurio":
      return `The SSH key of this Environment${key} stays registered on your GitHub account: it was not registered by Lazurio. ${where}`;
    case "not-removed":
      return `The SSH key of this Environment${key} may still be registered on your GitHub account: ${
        removal.reason === "scope-missing"
          ? "the gh sign-in may not manage SSH keys (scope admin:public_key)"
          : "gh could not remove it"
      }. ${where}`;
  }
}

export async function runComposioOrganization(
  positionals: readonly string[],
  json: boolean,
  context: CuratedContext,
): Promise<CuratedOutput | undefined> {
  const [action = "list", id, ...rest] = positionals;
  if (rest.length > 0) return undefined;
  if (!(action === "list" && id === undefined) && !(action === "switch" && id))
    return undefined;
  const sessions = createLoginSessions(context.login);
  try {
    if (action === "list") {
      const result = await sessions.composioOrganizations();
      return {
        code: result.kind === "composio-organizations" ? 0 : 1,
        result,
        text: json
          ? JSON.stringify(result)
          : result.kind === "composio-organizations"
            ? [
                "Composio organizations of the signed-in account (* current):",
                ...result.organizations.map(
                  (entry) =>
                    `${entry.current ? "*" : " "} ${entry.name}  (${entry.id})`,
                ),
                "Apps connected in Composio belong to the account and organization of this Environment.",
                "Switch: lazurio tools composio-org switch <id>",
              ].join("\n")
            : `The organizations could not be read (${result.reason}).`,
      };
    }
    const result = await sessions.selectComposioOrganization(id as string);
    return {
      code: result.kind === "composio-organization-selected" ? 0 : 1,
      result,
      text: json
        ? JSON.stringify(result)
        : result.kind === "composio-organization-selected"
          ? `Composio organization is now ${result.organization ?? result.id}.`
          : `The organization was not switched (${result.reason}).`,
    };
  } finally {
    await sessions.close();
  }
}
