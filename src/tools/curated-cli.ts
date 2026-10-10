import { sharedEnvironment } from "../folder/render";
import { pilotRefusesCuratedGh } from "../github/pilot";
import { activatableTools, executorToolName, vaultToolName } from "./catalog";
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
} from "./login";
import { qrMatrix, qrTerminal } from "./qr";
import type { SshKeyRemoval, SshLink, SshLinkFailure } from "./ssh-key";
import { teamGithubText } from "./team-github";

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
 * to the Organization-scoped GitHub sign-in pilot (decision F46): an
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
  const organization = pilot.owning ?? "<Organization>";
  const text =
    action === "logout"
      ? `This Environment signs in to GitHub per Organization (pilot, decision F46). Sign out: lazurio github sign-out --organization ${organization}. A gh sign-in left from before the pilot is removed with gh auth logout --hostname github.com.`
      : `This Environment signs in to GitHub per Organization (pilot, decision F46); an account-wide gh sign-in or SSH key is not set up here. Sign in: lazurio github sign-in --organization ${organization}. Back to the account-wide sign-in: lazurio github pilot unwire.`;
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
  // The Environment vault has its own flow (decision F43): no sign-in of a
  // person, an account of the Environment.
  if (name === vaultToolName) {
    const result = {
      kind: "blocked",
      reason: "setup-vault",
      tool: name,
      command: "lazurio vault connect",
    };
    return {
      code: 2,
      result,
      text: json
        ? JSON.stringify(result)
        : `${name} is the Environment vault: connect it in the Launchpad (Settings → Tools → bitwarden) or with lazurio vault connect.`,
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

export function installText(result: InstallResult, team = false): string {
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
          ? teamGithubText.en
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

/** Whether a login reached its full target: for gh, the SSH key linked. */
export function loginComplete(state: LoginState): boolean {
  return (
    state.kind === "signed-in" &&
    (state.tool !== "gh" || state.ssh?.state === "linked")
  );
}

// What a person reads for one state; `null` when nothing new is to be said.
function loginLines(state: LoginState): string[] {
  switch (state.kind) {
    case "pending": {
      if (state.step === "ssh-key")
        return [
          "Signed in to GitHub. Linking the SSH key of this Environment: key pair, registration on your account, GitHub's host keys, proof over SSH…",
        ];
      const challenge = state.challenge;
      if (challenge === undefined) return ["Starting the sign-in…"];
      if (challenge.kind === "device-code")
        return [
          "Sign in to GitHub on any device (phone or computer):",
          `  1. Open ${challenge.url}`,
          `  2. Enter the code  ${challenge.code}`,
          "Waiting for you to finish in the browser. Ctrl-C cancels.",
        ];
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
        ...(state.tool === "composio"
          ? [
              "Apps connected in Composio belong to this account and its current organization for the whole Environment.",
              "See or change the organization: lazurio tools composio-org list",
            ]
          : []),
      ];
    case "failed":
      return [
        `Sign-in of ${state.tool} failed: ${failureText[state.reason] ?? state.reason}.`,
        `Finish it with an agent: lazurio tools prompt ${state.tool}`,
      ];
    case "blocked":
      return [teamGithubText.en];
    case "expired":
      return [
        `The sign-in of ${state.tool} expired before it was completed. Start it again: lazurio tools login ${state.tool}`,
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
): Promise<CuratedOutput> {
  const refused = refuseTool(name, json);
  if (refused) return refused;
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
  const environmentNow = context.environmentNow;
  const sessions = createLoginSessions({
    ...context.login,
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
      text: json ? JSON.stringify(refusal) : githubRefusalText(refusal, "en"),
    };
  }
  if (!json && preset !== undefined && sharedEnvironment(preset))
    context.write(sharedSignInsText);
  const emit = (state: LoginState) => {
    if (json) context.write(JSON.stringify(state));
    else for (const line of loginLines(state)) context.write(line);
  };
  const aborted = new Promise<"aborted">((resolve) => {
    if (context.signal?.aborted) resolve("aborted");
    context.signal?.addEventListener("abort", () => resolve("aborted"), {
      once: true,
    });
  });
  try {
    let state = await sessions.start(name, {
      ...(phone === undefined ? {} : { phone }),
      ...(sshKey ? { sshKey } : {}),
    });
    emit(state);
    let shown = JSON.stringify(state);
    while (state.kind === "pending") {
      const handle = state.session;
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
        text: json ? JSON.stringify(refusal) : githubRefusalText(refusal, "en"),
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
