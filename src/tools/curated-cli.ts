import { activatableTools } from "./catalog";
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
}>;

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

export function installText(result: InstallResult): string {
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
        `Next: lazurio tools login ${result.tool}`,
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
    text: json ? JSON.stringify(result) : installText(result),
  };
}

const failureText: Record<string, string> = {
  "not-installed": "the tool is not installed; run lazurio tools install first",
  "unexpected-url":
    "the tool offered an address that is not its official sign-in page, so it was not shown",
  "unexpected-output": "the tool answered in a form Lazurio does not know",
  "tool-exit": "the tool ended without completing the sign-in",
  "not-confirmed": "the tool ended, but its status does not say signed in",
  "invalid-phone":
    "the phone number is not an international number (+ country code and number)",
  "spawn-failed": "the tool could not be started",
};

// What a person reads for one state; `null` when nothing new is to be said.
function loginLines(state: LoginState): string[] {
  switch (state.kind) {
    case "pending": {
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
        state.account === undefined
          ? `${state.tool}: signed in.`
          : `${state.tool}: signed in as ${state.account}${
              state.organization === undefined ? "" : ` (${state.organization})`
            }.`,
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
): Promise<CuratedOutput> {
  const refused = refuseTool(name, json);
  if (refused) return refused;
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
  const sessions = createLoginSessions(context.login);
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
    let state = await sessions.start(
      name,
      phone === undefined ? {} : { phone },
    );
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
      code: state.kind === "signed-in" ? 0 : 1,
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
  const sessions = createLoginSessions(context.login);
  let result: LogoutResult;
  try {
    result = await sessions.logout(name);
  } finally {
    await sessions.close();
  }
  const text =
    result.kind === "logged-out"
      ? result.revocation === "remote"
        ? `${name}: signed out; the linked device was removed from the account.`
        : `${name}: signed out on this Machine. The provider still lists this sign-in until you revoke it there.`
      : `${name}: sign-out failed (${result.reason}).`;
  return {
    code: result.kind === "logged-out" ? 0 : 1,
    result,
    text: json ? JSON.stringify(result) : text,
  };
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
