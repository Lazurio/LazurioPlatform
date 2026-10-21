import {
  type AiProvider,
  type AiServices,
  codexDeviceCode,
  codexDevicePage,
  isAiProvider,
} from "../tools/ai";
import type { PublicEntry } from "./chat";

// Začínáme's "Připojit AI" (root decision 0201 points 3-6, F19's addendum of
// 2026-10-15): the page starts `lazurio tools login codex|claude` through the
// Launchpad's curated login routes, follows it every two seconds and, on a
// Remote Environment, opens its right panel on the Environment browser's tab
// with the sign-in page, as Integrace does (a CLI cannot open the Launchpad's
// panel itself). A code of Claude's code page goes back through the same
// routes. "Přihlásit kódem" starts ChatGPT's sign-in by code instead (root
// decision 0201 point 10, F19's addendum of 2026-10-21): the step shows the
// code and OpenAI's page for it, and nothing opens in the panel. What the
// step then says is the AI as the CLIs answer it (`GET /api/ai`); this
// controller only holds the sign-in in this page's memory.

/** Where the step's sign-in page opens: the Environment browser in the right
 * panel (a Remote Environment whose entry routes it), the computer's own
 * browser, which the CLI opens itself (a workstation, no entry), or nowhere
 * (a Remote Environment without the Environment browser): then the step says
 * why and starts nothing. The server decides the same from its entry. */
export type AiSignInPlace = "panel" | "own" | "none";

export function aiSignInPlace(entry: PublicEntry | null): AiSignInPlace {
  if (entry === null) return "own";
  return entry.browserOrigin === undefined ? "none" : "panel";
}

/** Why a sign-in ended without signing in, as the step tells it. */
export type AiSignInFailure =
  | "failed"
  | "expired"
  | "no-answer"
  | "browser-unavailable"
  | "no-environment-browser"
  | "provider-unknown";

export type AiSignIn =
  | Readonly<{ kind: "idle" }>
  /** Started; no page yet (`session` once the server named one). `byCode`:
   * ChatGPT's sign-in by code, here and on `failed`, so "Zkusit znovu"
   * starts it by code again. */
  | Readonly<{
      kind: "starting";
      tool: AiProvider;
      session?: string;
      byCode?: true;
    }>
  /** The page is open where `view` (the panel) or `url` (the computer's own
   * browser) shows it; `code`: it ends on a code the CLI waits for. */
  | Readonly<{
      kind: "waiting";
      tool: AiProvider;
      session: string;
      view?: string;
      url?: string;
      code: boolean;
      /** The last code handed over: taken, or not a whole code. */
      codeNote?: "sent" | "invalid";
    }>
  /** ChatGPT's sign-in by code: the one-time code and OpenAI's page for it
   * (`codexDevicePage`), which the person opens on any device. */
  | Readonly<{
      kind: "by-code";
      tool: AiProvider;
      session: string;
      url: string;
      code: string;
    }>
  /** Signed in; the running services are reading the sign-in. */
  | Readonly<{ kind: "finishing"; tool: AiProvider; session: string }>
  /** Signed in, with what became of the services; it stays while the page
   * lives, so a service that did not read it is said beside the account. */
  | Readonly<{ kind: "signed-in"; tool: AiProvider; services?: AiServices }>
  | Readonly<{
      kind: "failed";
      tool: AiProvider;
      reason: AiSignInFailure;
      byCode?: true;
    }>;

export const idleAiSignIn: AiSignIn = Object.freeze({ kind: "idle" });

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** An https address, as the server answers a view or a page. */
function address(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** The services' outcome as the server answers it, only in its known
 * shapes; anything else is left out (the account is what counts). */
function servicesOf(value: unknown): AiServices | undefined {
  if (!isRecord(value) || !isRecord(value.t3)) return undefined;
  const t3 = value.t3;
  const appServer =
    isRecord(value.appServer) &&
    ["restarted", "not-managed", "failed"].includes(
      value.appServer.state as string,
    )
      ? {
          state: value.appServer.state as
            | "restarted"
            | "not-managed"
            | "failed",
        }
      : undefined;
  let reload: AiServices["t3"] | undefined;
  if (t3.state === "refreshed" && Array.isArray(t3.providers))
    reload = { state: "refreshed", providers: [] };
  else if (t3.state === "not-installed" || t3.state === "not-supported")
    reload = { state: t3.state };
  else if (t3.state === "driver-mismatch")
    reload = { state: "driver-mismatch", mismatches: [] };
  else if (t3.state === "failed" && t3.reason === "not-enabled")
    reload = {
      state: "failed",
      reason: "not-enabled",
      providers: Array.isArray(t3.providers)
        ? t3.providers.filter((cli): cli is AiProvider => isAiProvider(cli))
        : [],
    };
  else if (
    t3.state === "failed" &&
    ["not-running", "refused", "unreadable", "timeout"].includes(
      t3.reason as string,
    )
  )
    reload = {
      state: "failed",
      reason: t3.reason as "not-running" | "refused" | "unreadable" | "timeout",
    };
  if (reload === undefined) return undefined;
  return { ...(appServer === undefined ? {} : { appServer }), t3: reload };
}

/** What one answer of the login routes means for the step: the next state,
 * or null for an answer of no known shape. `organization-provided` asks the
 * page to read the AI again: the Organization provides it after all.
 * `byCode`: the sign-in was started by code, which `starting` and `failed`
 * keep. */
export function aiSignInAnswer(
  tool: AiProvider,
  value: unknown,
  byCode = false,
): AiSignIn | "organization-provided" | null {
  if (!isRecord(value) || value.tool !== tool) return null;
  const mode = byCode ? { byCode: true as const } : {};
  switch (value.kind) {
    case "pending": {
      if (
        typeof value.session !== "string" ||
        !/^[0-9a-f]{32}$/.test(value.session)
      )
        return null;
      if (value.step === "services")
        return { kind: "finishing", tool, session: value.session };
      const challenge = value.challenge;
      if (challenge === undefined)
        return { kind: "starting", tool, session: value.session, ...mode };
      // ChatGPT's sign-in by code: only OpenAI's exact page and a whole
      // code, as the core accepts them.
      if (isRecord(challenge) && challenge.kind === "device-code")
        return tool === "codex" &&
          challenge.url === codexDevicePage &&
          typeof challenge.code === "string" &&
          codexDeviceCode.test(challenge.code)
          ? {
              kind: "by-code",
              tool,
              session: value.session,
              url: codexDevicePage,
              code: challenge.code,
            }
          : null;
      if (!isRecord(challenge) || challenge.kind !== "page") return null;
      const view = address(challenge.view);
      const url = address(challenge.url);
      if ((view === undefined) === (url === undefined)) return null;
      return {
        kind: "waiting",
        tool,
        session: value.session,
        ...(view === undefined ? {} : { view }),
        ...(url === undefined ? {} : { url }),
        code: challenge.code === true,
      };
    }
    case "signed-in": {
      const services = servicesOf(value.services);
      return {
        kind: "signed-in",
        tool,
        ...(services === undefined ? {} : { services }),
      };
    }
    case "failed":
      return {
        kind: "failed",
        tool,
        reason:
          value.reason === "browser-unavailable" ||
          value.reason === "provider-unknown"
            ? value.reason
            : "failed",
        ...mode,
      };
    case "expired":
      return { kind: "failed", tool, reason: "expired", ...mode };
    case "blocked":
      if (value.reason === "organization-provided")
        return "organization-provided";
      if (value.reason === "no-environment-browser")
        return { kind: "failed", tool, reason: "no-environment-browser" };
      return null;
    case "cancelled":
    case "none":
      return idleAiSignIn;
    default:
      return null;
  }
}

type Transport = (
  path: string,
  body: unknown,
) => Promise<Readonly<{ value: unknown; ok: boolean }>>;

/** The page's AI sign-in: one at a time, held through its session handle;
 * starting another replaces it on the server too. */
export function createAiSignIn(
  options: Readonly<{
    post: Transport;
    /** Opens the right panel on the Environment browser's view. */
    showView: (view: string) => void;
    /** The state changed: the step is drawn again. */
    changed: () => void;
    /** Signed in, or the Organization provides the AI: read it again. */
    readAi: () => void;
    /** Test seams: how long an answer may take, how often it is asked. */
    answerMs?: number;
    pollMs?: number;
  }>,
) {
  const answerMs = options.answerMs ?? 45_000;
  const pollMs = options.pollMs ?? 2_000;
  let current: AiSignIn = idleAiSignIn;
  let turn = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The view the panel was opened on, once per sign-in.
  let shown: string | undefined;
  // The sign-in of this turn is ChatGPT's by code.
  let byCode = false;
  const mode = () => (byCode ? { byCode: true as const } : {});

  const set = (next: AiSignIn) => {
    current = next;
    options.changed();
  };
  const ask = async (path: string, body: unknown) => {
    let late: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.post(path, body).then(
          (answer) => answer.value,
          () => undefined,
        ),
        new Promise<"late">((resolve) => {
          late = setTimeout(() => resolve("late"), answerMs);
        }),
      ]);
    } finally {
      clearTimeout(late);
    }
  };
  const sessionOf = (state: AiSignIn) =>
    state.kind === "waiting" ||
    state.kind === "by-code" ||
    state.kind === "finishing" ||
    state.kind === "starting"
      ? state.session
      : undefined;

  function follow(tool: AiProvider, value: unknown, mine: number) {
    if (mine !== turn) return;
    const next = aiSignInAnswer(tool, value, byCode);
    if (next === "organization-provided") {
      set(idleAiSignIn);
      options.readAi();
      return;
    }
    if (next === null) {
      set({ kind: "failed", tool, reason: "failed", ...mode() });
      return;
    }
    // A code note stays while the page is the same.
    const kept =
      next.kind === "waiting" &&
      current.kind === "waiting" &&
      current.session === next.session &&
      current.codeNote !== undefined
        ? { ...next, codeNote: current.codeNote }
        : next;
    if (JSON.stringify(kept) !== JSON.stringify(current)) set(kept);
    if (
      next.kind === "waiting" &&
      next.view !== undefined &&
      shown !== next.view
    ) {
      shown = next.view;
      options.showView(next.view);
    }
    if (next.kind === "signed-in") options.readAi();
    const session = sessionOf(next);
    if (session !== undefined)
      timer = setTimeout(() => void poll(tool, session, mine), pollMs);
  }

  async function poll(tool: AiProvider, session: string, mine: number) {
    if (mine !== turn) return;
    const value = await ask("/api/tools/login/poll", { tool, session });
    if (mine !== turn) return;
    if (value === "late" || value === undefined) {
      // Not left running without anyone to watch it.
      void options
        .post("/api/tools/login/cancel", { tool, session })
        .catch(() => undefined);
      set({ kind: "failed", tool, reason: "no-answer", ...mode() });
      return;
    }
    follow(tool, value, mine);
  }

  return {
    state: (): AiSignIn => current,

    /** "Přihlásit ChatGPT" (codex) or "Přihlásit Claude" (claude), and
     * "Zkusit znovu"; with `byCode`, "Přihlásit kódem", ChatGPT's sign-in
     * by code (Claude has none: nothing is asked). */
    async start(tool: string, how: Readonly<{ byCode?: boolean }> = {}) {
      if (!isAiProvider(tool) || (how.byCode === true && tool !== "codex"))
        return;
      clearTimeout(timer);
      const mine = ++turn;
      shown = undefined;
      byCode = how.byCode === true;
      set({ kind: "starting", tool, ...mode() });
      const value = await ask("/api/tools/login/start", {
        tool,
        ...(byCode ? { deviceCode: true } : {}),
      });
      if (mine !== turn) return;
      if (value === "late" || value === undefined) {
        set({ kind: "failed", tool, reason: "no-answer", ...mode() });
        return;
      }
      follow(tool, value, mine);
    },

    /** "Zrušit": the CLI is stopped on the server. */
    async cancel() {
      const state = current;
      clearTimeout(timer);
      turn++;
      set(idleAiSignIn);
      const session = sessionOf(state);
      if (session !== undefined && "tool" in state)
        await options
          .post("/api/tools/login/cancel", { tool: state.tool, session })
          .catch(() => undefined);
    },

    /** "Otevřít přihlášení": the panel on the sign-in's tab again. */
    reopen() {
      if (current.kind === "waiting" && current.view !== undefined)
        options.showView(current.view);
    },

    /** A code of Claude's code page, typed in the step. */
    async sendCode(code: string) {
      const state = current;
      if (state.kind !== "waiting" || !state.code) return;
      const mine = turn;
      const answer = await options
        .post("/api/tools/login/code", {
          tool: state.tool,
          session: state.session,
          code,
        })
        .catch(() => ({ value: null, ok: false }));
      if (mine !== turn || current.kind !== "waiting") return;
      set({ ...current, codeNote: answer.ok ? "sent" : "invalid" });
    },

    /** The page goes: nothing more is asked. */
    stop() {
      clearTimeout(timer);
      turn++;
    },
  };
}

export type AiSignInController = ReturnType<typeof createAiSignIn>;
