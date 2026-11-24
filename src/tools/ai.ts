// The AI of an Environment (root decision 0201 points 1, 3 and 6; plan
// DEV-6665): whether an agent can work here, as Codex and Claude Code say it
// themselves. No flag or Organization setting says it.
//
// - Codex answers through its app-server's `account/read`: an account (a
//   ChatGPT sign-in or an API key) is usable, and `requiresOpenaiAuth: false`
//   means the configured model provider needs no OpenAI sign-in. That is how
//   an Organization's AI pool (root decision 0181) configures Codex on its
//   work Environments, so its AI is provided and the step is done without the
//   person.
// - Claude Code answers through `claude auth status --json` (`loggedIn`).
//
// The AI step of Začínáme and the shell's prompt read this. The sign-in
// itself (`lazurio tools login codex|claude`, task 742 of DEV-6665) comes
// later and only makes a reading change. Pure: the processes are
// ai-probe.ts, so the page can parse the route's answer with this module.

export const aiProviders = ["codex", "claude"] as const;
export type AiProvider = (typeof aiProviders)[number];

export const isAiProvider = (name: string): name is AiProvider =>
  (aiProviders as readonly string[]).includes(name);

/** What people sign in to: the subscription, not the program. */
export const aiProviderName: Readonly<Record<AiProvider, string>> = {
  codex: "ChatGPT",
  claude: "Claude",
};

/** OpenAI's page for ChatGPT's sign-in by code (root decision 0201 point 10,
 * F19's addendum of 2026-10-21): the one address `codex login --device-auth`
 * prints, `{issuer}/codex/device` with Codex's default issuer
 * `https://auth.openai.com` (read in Codex 0.162.0's
 * `codex-rs/login/src/device_code_auth.rs` and `server.rs`, and in the
 * strings of the Codex 0.163.0 binary). Only this exact page is shown to a
 * person; the core and the page check it alike. */
export const codexDevicePage = "https://auth.openai.com/codex/device";

/** The one-time code of that sign-in as Codex prints it: groups of capital
 * letters and digits joined by dashes (`ABCD-1234` in Codex's app-server
 * documentation). Nothing else is shown as the code. */
export const codexDeviceCode = /^[A-Z0-9]{2,16}(?:-[A-Z0-9]{2,16}){1,3}$/;

// After `lazurio tools login codex|claude` (F19's addendum of 2026-10-15) the
// running services read the new sign-in (root decision 0201 point 4): the
// Codex app-server unit Lazurio manages, and T3 Code. What became of them is
// part of the sign-in's answer; ai-services.ts asks them.

/** One provider as T3 Code answered after the refresh. */
export type T3Provider = Readonly<{
  provider: string;
  instanceId: string;
  enabled: boolean;
  status: string;
  auth: string;
}>;

/** An instance under a default provider's ID that runs another driver: T3
 * then turned nothing on and refreshed nothing. */
export type T3Mismatch = Readonly<{
  provider: string;
  instanceId: string;
  driver: string;
}>;

export type T3Reload =
  /** T3 Code turned the providers on and read them again. */
  | Readonly<{ state: "refreshed"; providers: readonly T3Provider[] }>
  /** No `t3` here (a workstation): nothing to tell. */
  | Readonly<{ state: "not-installed" }>
  /** A T3 Code without the refresh: it reads the sign-in at its own next
   * check, within about five minutes. */
  | Readonly<{ state: "not-supported" }>
  | Readonly<{ state: "driver-mismatch"; mismatches: readonly T3Mismatch[] }>
  | Readonly<{
      state: "failed";
      reason: "not-running" | "refused" | "unreadable" | "timeout";
    }>
  /** T3 Code answered, but not with an enabled instance of each CLI it was
   * asked to turn on (`providers`): it did not turn them on. A provider still
   * being checked right after it was turned on is enabled. */
  | Readonly<{
      state: "failed";
      reason: "not-enabled";
      providers: readonly AiProvider[];
    }>;

export type AiServices = Readonly<{
  /** codex only: the Codex app-server unit, restarted, not Lazurio's here,
   * or failed. */
  appServer?: Readonly<{ state: "restarted" | "not-managed" | "failed" }>;
  t3: T3Reload;
}>;

/** Whether the services read the sign-in, or will by themselves: false for a
 * failed restart, a refused or failed refresh and a driver mismatch, which
 * the person or the Operator must see. */
export function aiServicesReady(services: AiServices): boolean {
  return (
    services.appServer?.state !== "failed" &&
    ["refreshed", "not-installed", "not-supported"].includes(services.t3.state)
  );
}

/** One CLI's answer: signed in (`account` its e-mail when it names one),
 * signed out, provided by the configuration (no sign-in needed), not on the
 * operator's PATH, or no answer. */
export type AiProviderState =
  | "signed-in"
  | "signed-out"
  | "provided"
  | "not-installed"
  | "unknown";

export type AiProviderReading = Readonly<{
  provider: AiProvider;
  state: AiProviderState;
  /** Codex signed out because the OpenAI sign-in it holds no longer works:
   * revoked, expired or stored without its account (`codexReading`). Only
   * with `signed-out`. */
  lapsed?: true;
  /** Codex signed in: a ChatGPT account or an API key. */
  method?: "chatgpt" | "api-key";
  /** The account's e-mail, when the CLI names one. */
  account?: string;
}>;

/** The Environment's AI: provided by its Organization, connected by the
 * person, missing (every CLI answered and none can work), or not known. */
export type AiState = "organization" | "connected" | "missing" | "unknown";

export type AiReading = Readonly<{
  state: AiState;
  providers: readonly AiProviderReading[];
}>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** An e-mail as a label: one line, no control characters, at most 254. */
function email(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean !== "" &&
    clean.length <= 254 &&
    !/[\p{Cc}\s]/u.test(clean) &&
    clean.includes("@")
    ? clean
    : undefined;
}

// What Codex's `account/read` answers with an error when the configured
// provider needs an OpenAI sign-in and the one Codex holds no longer works
// (read in Codex 0.167.1: `codex-rs/login/src/auth/manager.rs`, the app-
// server's `account_processor/workspace_routing.rs` and the model
// provider's `account_state`). Each arises only where the provider requires
// OpenAI auth: a provider of the Organization's AI pool never checks a
// ChatGPT account, so these never stand for it.
// - The refresh of the ChatGPT tokens refused for good: "Your access token
//   could not be refreshed because your refresh token was revoked | has
//   expired | was already used. Please log out and sign in again.", "… could
//   not be refreshed. Please log out and sign in again." and "… because you
//   have since logged out or signed in to another account. Please sign in
//   again." (JSON-RPC -32603).
// - The account's check refused by OpenAI even after a refresh: "workspace
//   routing discovery unauthorized (401)" (-32603).
// - A ChatGPT sign-in stored without its plan, half written: "plan type is
//   required for chatgpt authentication" (-32600).
// Any other error is not known (fail closed, root decision 0201 point 4).
const codexLapsedSignIn: readonly RegExp[] = [
  /^Your access token could not be refreshed\b.*\bsign in again\.?$/i,
  /^workspace routing discovery unauthorized \(401\)$/i,
  /^plan type is required for chatgpt authentication$/i,
];

/** Whether an `account/read` error says the OpenAI sign-in is no longer
 * usable (`codexLapsedSignIn`), by its message alone. */
export function codexSignInLapsed(error: unknown): boolean {
  if (!isRecord(error) || typeof error.message !== "string") return false;
  const message = error.message.trim();
  return codexLapsedSignIn.some((pattern) => pattern.test(message));
}

/** Codex's `account/read` answer: its result (`{ account,
 * requiresOpenaiAuth }`), or the error it answered instead. An error that
 * says the OpenAI sign-in no longer works reads signed out (`lapsed`), so
 * Začínáme offers a new sign-in; any other error is not known. */
export function codexReading(
  result: unknown,
  error?: unknown,
): AiProviderReading {
  const unknown = { provider: "codex", state: "unknown" } as const;
  if (error !== undefined)
    return codexSignInLapsed(error)
      ? { provider: "codex", state: "signed-out", lapsed: true }
      : unknown;
  if (!isRecord(result)) return unknown;
  if (result.requiresOpenaiAuth === false)
    return { provider: "codex", state: "provided" };
  const account = result.account;
  if (account === null) return { provider: "codex", state: "signed-out" };
  if (!isRecord(account)) return unknown;
  if (account.type === "apiKey")
    return { provider: "codex", state: "signed-in", method: "api-key" };
  if (account.type === "chatgpt") {
    const label = email(account.email);
    return {
      provider: "codex",
      state: "signed-in",
      method: "chatgpt",
      ...(label === undefined ? {} : { account: label }),
    };
  }
  return unknown;
}

/** `claude auth status --json` as Claude Code prints it, whatever its exit
 * code: `loggedIn` true or false, and the e-mail. */
export function claudeReading(stdout: string): AiProviderReading {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return { provider: "claude", state: "unknown" };
  }
  if (!isRecord(value) || typeof value.loggedIn !== "boolean")
    return { provider: "claude", state: "unknown" };
  if (!value.loggedIn) return { provider: "claude", state: "signed-out" };
  const label = email(value.email);
  return {
    provider: "claude",
    state: "signed-in",
    ...(label === undefined ? {} : { account: label }),
  };
}

/** The Environment's AI from its CLIs: provided wins (the Organization's
 * pool), then any sign-in; missing only when every CLI answered that it
 * cannot work (signed out or not installed); otherwise not known. */
export function aiState(providers: readonly AiProviderReading[]): AiState {
  if (providers.some((reading) => reading.state === "provided"))
    return "organization";
  if (providers.some((reading) => reading.state === "signed-in"))
    return "connected";
  return providers.length > 0 &&
    providers.every(
      (reading) =>
        reading.state === "signed-out" || reading.state === "not-installed",
    )
    ? "missing"
    : "unknown";
}

const states: readonly AiState[] = [
  "organization",
  "connected",
  "missing",
  "unknown",
];
const providerStates: readonly AiProviderState[] = [
  "signed-in",
  "signed-out",
  "provided",
  "not-installed",
  "unknown",
];

/** `GET /api/ai` (`{ kind: "ai", state, providers }`) in its exact shape, or
 * null. A provider this page does not know is left out. */
export function parseAiAnswer(value: unknown): AiReading | null {
  if (
    !isRecord(value) ||
    value.kind !== "ai" ||
    !states.includes(value.state as AiState) ||
    !Array.isArray(value.providers)
  )
    return null;
  const providers: AiProviderReading[] = [];
  for (const entry of value.providers) {
    if (!isRecord(entry)) return null;
    if (!(aiProviders as readonly unknown[]).includes(entry.provider)) continue;
    if (!providerStates.includes(entry.state as AiProviderState)) return null;
    const method =
      entry.method === "chatgpt" || entry.method === "api-key"
        ? entry.method
        : undefined;
    const account = email(entry.account);
    const lapsed = entry.state === "signed-out" && entry.lapsed === true;
    providers.push(
      Object.freeze({
        provider: entry.provider as AiProvider,
        state: entry.state as AiProviderState,
        ...(lapsed ? { lapsed: true as const } : {}),
        ...(method === undefined ? {} : { method }),
        ...(account === undefined ? {} : { account }),
      }),
    );
  }
  return Object.freeze({
    state: value.state as AiState,
    providers: Object.freeze(providers),
  });
}
