import type { Catalog } from "../organizations/catalog";
import {
  type AiProvider,
  type AiProviderReading,
  type AiReading,
  aiProviderName,
  aiServicesReady,
} from "../tools/ai";
import { type AiSignIn, type AiSignInPlace, idleAiSignIn } from "./ai-sign-in";
import { moduleName } from "./apps-view";
import { moduleRoute } from "./catalog-view";
import type { ContentList } from "./content-client";
import {
  type Basic,
  basicState,
  basics,
  basicsDone,
  type ComposioFact,
  contentBlockedBy,
  demoOnboarding,
  signsInAsPerson,
  type TourFacts,
} from "./first-run";
import type { MessageKey } from "./messages";
import { vaultPath } from "./routes";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Nastavení → Začínáme (root decision 0201 points 1-3; the wireframe's
// `screens/Start.tsx`, prototypes-lazurio 1eefc3d): the onboarding of an
// Environment as a page that does not go away. Each basic is checked from the
// Environment's own state, never from what a browser remembers, so it reads
// the same in any browser and opens again any time: 1. Připojit AI, 2.
// GitHub, 3. the Organization's download or the personal space, which starts
// by itself once GitHub is there. Then the vault, the optional steps and the
// tour of the app. The AI step signs ChatGPT and Claude in through their CLIs
// (F19's addendum of 2026-10-15, ai-sign-in.ts). Each row is its title, its
// action and its state, with at most one short line where the title alone
// does not say what it is for (F36's addendum of 2026-10-16, Matěj's
// "simplify the whole thing"). Pure: the DOM is start-panel.ts.

/** How a step stands: done, the one to do now, one that waits for an
 * earlier one, or a stop. */
export type StartMark = "done" | "now" | "later" | "failed";

export type StartStep = Readonly<{
  basic: Basic;
  mark: StartMark;
  title: string;
  /** One line under the title; null where the step's body says it. */
  status: string | null;
  /** A second line that needs attention (a sign-in that did not finish, a
   * service that did not read it); absent where there is none. */
  warning?: string;
}>;

/** The GitHub step's one action: "Připojit", enabled only once AI is there
 * (0201 point 3). Null when GitHub is connected or not known yet. */
export type GithubAction = Readonly<{ enabled: boolean }> | null;

/** What the AI step offers besides its line (root decision 0201 points 3-6,
 * the wireframe's states). */
export type AiAction =
  /** Nothing to do: the Organization's AI, a reading under way, no
   * Environment browser, or the services reading a new sign-in. */
  | Readonly<{ kind: "none" }>
  /** "Přihlásit ChatGPT" and "Přihlásit Claude" (both may be signed in),
   * each with its mark and nothing said before them; `cancel` where they
   * were opened from a connected step. */
  | Readonly<{ kind: "choose"; cancel: boolean }>
  /** Connected: "Přihlásit jiný účet" opens the choice again. */
  | Readonly<{ kind: "connected" }>
  /** Signing in: "Otevřít přihlášení" (the right panel again, or the page
   * itself in the computer's own browser; none before the page is open),
   * "Zrušit", and the field for the code of Claude's code page. */
  | Readonly<{
      kind: "signing-in";
      reopen: Readonly<{ panel: true }> | Readonly<{ url: string }> | null;
      code: Readonly<{
        note: Readonly<{ text: string; tone: "warn" | "quiet" }> | null;
      }> | null;
    }>
  /** "Zkusit znovu" for the sign-in that did not finish. */
  | Readonly<{ kind: "retry"; tool: AiProvider }>;

export type StartView = Readonly<{
  intro: string;
  done: number;
  total: number;
  steps: readonly StartStep[];
  github: GithubAction;
  ai: AiAction;
}>;

export type StartFacts = TourFacts &
  Readonly<{
    /** The AI as `GET /api/ai` read it; null before it answered. */
    aiReading: AiReading | null;
    /** This page's sign-in of ChatGPT or Claude (ai-sign-in.ts); idle when
     * absent. */
    aiSignIn?: AiSignIn;
    /** Where its page opens; the computer's own browser when absent. */
    aiPlace?: AiSignInPlace;
    /** "Přihlásit jiný účet" opened the choice on a connected step. */
    aiChoosing?: boolean;
    /** The GitHub login gh is signed in with, when it names one. */
    githubLogin: string | null;
    /** What the content routes listed, for the step's title. */
    list: ContentList | null;
  }>;

/** "ChatGPT, a@b.c": one signed-in account. */
function accountLabel(reading: AiProviderReading, copy: Copy): string | null {
  if (reading.state !== "signed-in") return null;
  const name =
    reading.provider === "claude"
      ? "Claude"
      : reading.method === "api-key"
        ? copy.startAiApiKey
        : "ChatGPT";
  return reading.account === undefined ? name : `${name}, ${reading.account}`;
}

/** Why the last sign-in did not finish, in one sentence. */
function aiFailure(
  signIn: Extract<AiSignIn, { kind: "failed" }>,
  copy: Copy,
): string {
  switch (signIn.reason) {
    case "expired":
      return copy.startAiExpired;
    case "no-answer":
      return copy.startAiNoAnswer;
    case "browser-unavailable":
      return copy.startAiBrowserFailed;
    case "no-environment-browser":
      return copy.startAiNoBrowser;
    case "provider-unknown":
      return copy.startAiProviderUnknown;
    case "failed":
      return copy.startAiFailed;
  }
}

/** What a sign-in that finished says about the services that did not read
 * it: Chat and the Codex app-server use it only later, or Chat refused. */
function aiServicesWarning(signIn: AiSignIn, copy: Copy): string | undefined {
  if (signIn.kind !== "signed-in" || signIn.services === undefined)
    return undefined;
  if (aiServicesReady(signIn.services)) return undefined;
  // Chat names its providers after the CLIs.
  const t3 = signIn.services.t3;
  const named = (cli: AiProvider) => (cli === "codex" ? "Codex" : "Claude");
  if (t3.state === "driver-mismatch")
    return fill(copy.startAiChatMismatch, { provider: named(signIn.tool) });
  if (t3.state === "failed" && t3.reason === "not-enabled")
    return fill(copy.startAiChatOff, {
      provider: (t3.providers.length > 0 ? t3.providers : [signIn.tool])
        .map(named)
        .join(", "),
    });
  return copy.startAiServicesLater;
}

function aiStep(facts: StartFacts, copy: Copy): [StartStep, AiAction] {
  const base = { basic: "ai" as const, title: copy.startAiTitle };
  const signIn = facts.aiSignIn ?? idleAiSignIn;
  const place = facts.aiPlace ?? "own";
  const ready = facts.ai === "organization" || facts.ai === "connected";
  const mark: StartMark = ready ? "done" : "now";
  const choose: AiAction = { kind: "choose", cancel: ready };
  // A sign-in under way says where to finish it.
  if (signIn.kind === "starting")
    return [
      { ...base, mark, status: copy.startAiStarting },
      { kind: "signing-in", reopen: null, code: null },
    ];
  if (signIn.kind === "waiting") {
    const name = aiProviderName[signIn.tool];
    return [
      {
        ...base,
        mark,
        status: fill(
          signIn.view !== undefined
            ? copy.startAiFinishPanel
            : copy.startAiFinishOwn,
          { name },
        ),
      },
      {
        kind: "signing-in",
        reopen:
          signIn.view !== undefined
            ? { panel: true }
            : signIn.url !== undefined
              ? { url: signIn.url }
              : null,
        code: signIn.code
          ? {
              note:
                signIn.codeNote === "invalid"
                  ? { text: copy.startAiCodeInvalid, tone: "warn" }
                  : signIn.codeNote === "sent"
                    ? { text: copy.startAiCodeSent, tone: "quiet" }
                    : null,
            }
          : null,
      },
    ];
  }
  if (signIn.kind === "finishing")
    return [
      {
        ...base,
        mark,
        status: fill(copy.startAiFinishing, {
          name: aiProviderName[signIn.tool],
        }),
      },
      { kind: "none" },
    ];
  if (facts.ai === "organization")
    return [
      { ...base, mark: "done", status: copy.startAiOrganization },
      { kind: "none" },
    ];
  // Signed in to one of them: the accounts, and another one on request.
  if (facts.ai === "connected") {
    const accounts = (facts.aiReading?.providers ?? [])
      .map((reading) => accountLabel(reading, copy))
      .filter((label): label is string => label !== null);
    const warning =
      signIn.kind === "failed"
        ? aiFailure(signIn, copy)
        : aiServicesWarning(signIn, copy);
    return [
      {
        ...base,
        mark: "done",
        status:
          accounts.length === 0
            ? copy.startConnected
            : fill(copy.startAiConnected, { accounts: accounts.join("; ") }),
        ...(warning === undefined ? {} : { warning }),
      },
      facts.aiChoosing === true
        ? choose
        : signIn.kind === "failed" && signIn.reason !== "no-environment-browser"
          ? { kind: "retry", tool: signIn.tool }
          : { kind: "connected" },
    ];
  }
  if (signIn.kind === "failed")
    return [
      { ...base, mark: "failed", status: aiFailure(signIn, copy) },
      signIn.reason === "no-environment-browser"
        ? { kind: "none" }
        : { kind: "retry", tool: signIn.tool },
    ];
  // Without the Environment browser the page could not return to the CLI.
  if (place === "none" && facts.ai !== "loading")
    return [
      { ...base, mark: "now", status: copy.startAiNoBrowser },
      { kind: "none" },
    ];
  switch (facts.ai) {
    // Only the title and the two sign-ins (Matěj, 2026-10-16).
    case "missing":
      return [{ ...base, mark: "now", status: null }, choose];
    case "unknown":
      return [{ ...base, mark: "now", status: copy.startAiUnknown }, choose];
    case "loading":
      return [
        { ...base, mark: "now", status: copy.startChecking },
        { kind: "none" },
      ];
  }
}

function githubStep(facts: StartFacts, copy: Copy): [StartStep, GithubAction] {
  const base = { basic: "github" as const, title: copy.startGithubTitle };
  if (facts.github === "connected")
    return [
      {
        ...base,
        mark: "done",
        status:
          facts.githubLogin === null
            ? copy.startGithubConnectedPlain
            : fill(copy.startGithubConnected, { login: facts.githubLogin }),
      },
      null,
    ];
  if (facts.github === "unknown")
    return [{ ...base, mark: "later", status: copy.startChecking }, null];
  // Offered once an agent can help (an AI not known is not claimed missing);
  // before, the step waits, its number saying the order.
  const ready = facts.ai !== "missing" && facts.ai !== "loading";
  return [
    {
      ...base,
      mark: ready ? "now" : "later",
      // What GitHub opens is the "?"'s (decision F56's addendum of
      // 2026-10-18); the step says its state.
      status: copy.startNotConnected,
    },
    { enabled: ready },
  ];
}

function contentStep(facts: StartFacts, copy: Copy): StartStep {
  const items = facts.list?.allowed === true ? facts.list.items : [];
  const [first] = items;
  const title =
    items.length > 1
      ? copy.startContentBoth
      : first?.kind === "personalspace"
        ? copy.startContentPersonal
        : first?.kind === "organization"
          ? fill(copy.startContentOrganization, {
              name: first.name ?? first.login,
            })
          : copy.startContentNone;
  const content = facts.content.state;
  const base = { basic: "content" as const, title };
  if (content === "none")
    return { ...base, mark: "done", status: copy.startContentNothing };
  if (content === "ready") return { ...base, mark: "done", status: null };
  if (content === "failed") return { ...base, mark: "failed", status: null };
  if (content === "loading" || content === "unknown")
    return { ...base, mark: "later", status: copy.startChecking };
  // Its turn comes after AI and GitHub (0201 point 3).
  return contentBlockedBy(facts) === null
    ? { ...base, mark: "now", status: null }
    : { ...base, mark: "later", status: null };
}

/** Začínáme from the facts, or null where the Environment has none (a Team
 * or an Automated Environment: their Organization prepares them) or has the
 * demo onboarding instead (a public Environment, `demoStartView`). */
export function startView(facts: StartFacts, copy: Copy): StartView | null {
  if (!signsInAsPerson(facts.preset) || demoOnboarding(facts)) return null;
  const [github, action] = githubStep(facts, copy);
  const [ai, aiAction] = aiStep(facts, copy);
  const steps = [ai, github, contentStep(facts, copy)];
  const done = basicsDone(facts);
  const total = basics.length;
  return {
    intro:
      done === total
        ? copy.startReady
        : fill(copy.startIntro, { done: String(done), total: String(total) }),
    done,
    total,
    steps,
    github: action,
    ai: aiAction,
  };
}

/** The count beside Začínáme in the Settings navigation ("1/3") while a
 * basic is missing; null otherwise. */
export function startCount(facts: TourFacts): string | null {
  if (!signsInAsPerson(facts.preset) || demoOnboarding(facts)) return null;
  const missing = basics.some(
    (basic) => basicState(facts, basic) === "missing",
  );
  return missing ? `${basicsDone(facts)}/${basics.length}` : null;
}

/** One optional row: its title, one sentence, its state in a word, and
 * where its button leads (a Settings path, or Trezor in Apps) or what it
 * opens. */
export type OptionalRow = Readonly<{
  id: "composio" | "ssh" | "bitwarden" | "codex";
  title: string;
  /** What it is, where its title does not say it (SSH, Codex); none where
   * the "?" of Začínáme says it (decision F56's addendum of 2026-10-18). */
  text: string | null;
  status: string | null;
  /** None once it is done (Composio connected). */
  action: Readonly<{
    label: string;
    to: "composio" | `/settings/${string}` | typeof vaultPath;
    /** The part of that page the button brings into view: Apps → Trezor's
     * steps for Bitwarden. */
    part?: "bitwarden";
  }> | null;
}>;

/** "Volitelné": Composio where Tools offer it; on a Remote Environment SSH
 * from the person's own computer (`sshDevices`: how many devices have a
 * key, null when not known) and Codex Desktop, which works over that SSH
 * (its state is the person's computer's, so it has none here). Between them
 * "Trezor v Bitwardenu" where Apps → Trezor gives the steps that add the
 * Environment's vault to Bitwarden in Codex Desktop and the person's browser
 * (`bitwarden`, `offersBitwarden`; F53's addendum of 2026-10-16): no state
 * either, since the extension is on the person's computer. */
export function optionalRows(
  input: Readonly<{
    preset: string | null;
    composio: ComposioFact;
    sshDevices: number | null;
    bitwarden: boolean;
  }>,
  copy: Copy,
): readonly OptionalRow[] {
  const rows: OptionalRow[] = [];
  if (input.composio !== "none")
    rows.push({
      id: "composio",
      title: "Composio",
      text: null,
      status:
        input.composio === "connected"
          ? copy.startConnected
          : copy.startNotConnected,
      action:
        input.composio === "connected"
          ? null
          : { label: copy.startConnect, to: "composio" },
    });
  const remote = input.preset !== "local";
  if (remote)
    rows.push({
      id: "ssh",
      title: copy.startSshTitle,
      text: copy.startSshText,
      status:
        input.sshDevices === null
          ? null
          : input.sshDevices > 0
            ? copy.startSet
            : copy.startNotSet,
      action: { label: copy.startGuide, to: "/settings/ssh" },
    });
  if (input.bitwarden)
    rows.push({
      id: "bitwarden",
      title: copy.startBitwardenTitle,
      text: null,
      status: null,
      action: {
        label: copy.startGuide,
        to: vaultPath,
        part: "bitwarden",
      },
    });
  if (remote)
    rows.push({
      id: "codex",
      title: "Codex Desktop",
      text: copy.startCodexText,
      status: null,
      action: { label: copy.startGuide, to: "/settings/ssh" },
    });
  return rows;
}

/** One row of a public Environment's Začínáme: its title, one sentence, a
 * state only where one needs saying, and where its button leads (a route of
 * this page, or with `app` the switch's Chat, which the page pairs on the
 * way); none where the app does not run here. */
export type DemoRow = Readonly<{
  id: "apps" | "module" | "chat";
  title: string;
  text: string;
  status: string | null;
  action: Readonly<{ label: string; href: string; app?: "chat" }> | null;
}>;

export type DemoStartView = Readonly<{
  intro: string;
  rows: readonly DemoRow[];
}>;

/** The module Začínáme of a public Environment offers to try: the first one
 * of the Folder's first Organization that has an app to open, by its
 * overview's route; null where there is none. */
export function demoModule(
  catalog: Catalog | null,
): Readonly<{ name: string; href: string }> | null {
  for (const organization of catalog?.organizations ?? [])
    for (const module of organization.modules) {
      if (
        module.absent === true ||
        module.defaultApp === null ||
        !module.executable
      )
        continue;
      const href =
        catalog === null ? null : moduleRoute(catalog, organization, module);
      if (href !== null) return { name: moduleName(module), href };
    }
  return null;
}

/** Začínáme of a public Environment (root decision 0204's line on 0201,
 * decision F55): what a visitor can do here, never a sign-in. Apps, a module
 * to try (`module`, or any in Apps) and Chat (`chat`: its address on this
 * Environment, null where it does not run), which says the AI is not
 * connected: a visitor gets no AI in a shared Environment (0204 point 6). */
export function demoStartView(
  input: Readonly<{
    chat: string | null;
    module: Readonly<{ name: string; href: string }> | null;
  }>,
  copy: Copy,
): DemoStartView {
  return {
    intro: copy.startDemoIntro,
    rows: [
      {
        id: "apps",
        title: "Apps",
        text: copy.demoAppsText,
        status: null,
        action: { label: copy.startOpen, href: "/" },
      },
      input.module === null
        ? {
            id: "module",
            title: copy.startDemoModuleTitle,
            text: copy.startDemoModuleAny,
            status: null,
            action: { label: copy.startOpen, href: "/" },
          }
        : {
            id: "module",
            title: input.module.name,
            text: copy.startDemoModuleText,
            status: null,
            action: { label: copy.startOpen, href: input.module.href },
          },
      {
        id: "chat",
        title: "Chat",
        text: copy.startDemoChatText,
        status: copy.startDemoNoAi,
        action:
          input.chat === null
            ? null
            : { label: copy.startOpen, href: input.chat, app: "chat" },
      },
    ],
  };
}
