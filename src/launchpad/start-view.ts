import type { AiProviderReading, AiReading } from "../tools/ai";
import type { ContentList } from "./content-client";
import {
  type Basic,
  basicState,
  basics,
  basicsDone,
  type ComposioFact,
  contentBlockedBy,
  signsInAsPerson,
  type TourFacts,
} from "./first-run";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Nastavení → Začínáme (root decision 0201 points 1-3; the wireframe's
// `screens/Start.tsx`, prototypes-lazurio 1eefc3d): the onboarding of an
// Environment as a page that does not go away. Each basic is checked from the
// Environment's own state, never from what a browser remembers, so it reads
// the same in any browser and opens again any time: 1. Připojit AI, 2.
// GitHub, 3. the Organization's download or the personal space, which starts
// by itself once GitHub is there. Then the vault, the optional steps and the
// tour of the app. Pure: the DOM is start-panel.ts.

/** How a step stands: done, the one to do now, one that waits for an
 * earlier one, or a stop. */
export type StartMark = "done" | "now" | "later" | "failed";

export type StartStep = Readonly<{
  basic: Basic;
  mark: StartMark;
  title: string;
  /** One line under the title; null where the step's body says it. */
  status: string | null;
}>;

/** The GitHub step's one action: "Připojit", enabled only once AI is there
 * (0201 point 3). Null when GitHub is connected or not known yet. */
export type GithubAction = Readonly<{ enabled: boolean }> | null;

export type StartView = Readonly<{
  intro: string;
  done: number;
  total: number;
  steps: readonly StartStep[];
  github: GithubAction;
}>;

export type StartFacts = TourFacts &
  Readonly<{
    /** The AI as `GET /api/ai` read it; null before it answered. */
    aiReading: AiReading | null;
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

function aiStep(facts: StartFacts, copy: Copy): StartStep {
  const base = { basic: "ai" as const, title: copy.startAiTitle };
  switch (facts.ai) {
    case "organization":
      return { ...base, mark: "done", status: copy.startAiOrganization };
    case "connected": {
      const accounts = (facts.aiReading?.providers ?? [])
        .map((reading) => accountLabel(reading, copy))
        .filter((label): label is string => label !== null);
      return {
        ...base,
        mark: "done",
        status:
          accounts.length === 0
            ? copy.startConnected
            : fill(copy.startAiConnected, { accounts: accounts.join("; ") }),
      };
    }
    case "missing":
      return { ...base, mark: "now", status: copy.startAiMissing };
    case "unknown":
      return { ...base, mark: "now", status: copy.startAiUnknown };
    case "loading":
      return { ...base, mark: "now", status: copy.startChecking };
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
  // Offered once an agent can help (an AI not known is not claimed missing).
  const ready = facts.ai !== "missing" && facts.ai !== "loading";
  return [
    {
      ...base,
      mark: ready ? "now" : "later",
      status: ready ? copy.startGithubMissing : copy.startGithubAfterAi,
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
 * or an Automated Environment: their Organization prepares them). */
export function startView(facts: StartFacts, copy: Copy): StartView | null {
  if (!signsInAsPerson(facts.preset)) return null;
  const [github, action] = githubStep(facts, copy);
  const steps = [aiStep(facts, copy), github, contentStep(facts, copy)];
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
  };
}

/** The count beside Začínáme in the Settings navigation ("1/3") while a
 * basic is missing; null otherwise. */
export function startCount(facts: TourFacts): string | null {
  if (!signsInAsPerson(facts.preset)) return null;
  const missing = basics.some(
    (basic) => basicState(facts, basic) === "missing",
  );
  return missing ? `${basicsDone(facts)}/${basics.length}` : null;
}

/** One optional row: its title, one sentence, its state in a word, and
 * where its button leads (a Settings path) or what it opens. */
export type OptionalRow = Readonly<{
  id: "composio" | "ssh" | "codex";
  title: string;
  text: string;
  status: string | null;
  /** None once it is done (Composio connected). */
  action: Readonly<{
    label: string;
    to: "composio" | `/settings/${string}`;
  }> | null;
}>;

/** "Volitelné": Composio where Tools offer it; on a Remote Environment SSH
 * from the person's own computer (`sshDevices`: how many devices have a
 * key, null when not known) and Codex Desktop, which works over that SSH
 * (its state is the person's computer's, so it has none here). */
export function optionalRows(
  input: Readonly<{
    preset: string | null;
    composio: ComposioFact;
    sshDevices: number | null;
  }>,
  copy: Copy,
): readonly OptionalRow[] {
  const rows: OptionalRow[] = [];
  if (input.composio !== "none")
    rows.push({
      id: "composio",
      title: "Composio",
      text: copy.startComposioText,
      status:
        input.composio === "connected"
          ? copy.startConnected
          : copy.startNotConnected,
      action:
        input.composio === "connected"
          ? null
          : { label: copy.startConnect, to: "composio" },
    });
  if (input.preset !== "local") {
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
    rows.push({
      id: "codex",
      title: "Codex Desktop",
      text: copy.startCodexText,
      status: null,
      action: { label: copy.startGuide, to: "/settings/ssh" },
    });
  }
  return rows;
}
