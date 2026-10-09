import type { ExecutorPhase, ExecutorStatus } from "../executor/flow";
import {
  executorAction,
  executorFacts,
  executorPollMs,
  executorRowLine,
  parseExecutorSettingUp,
  parseExecutorStatus,
} from "./executor-view";
import type { MessageKey } from "./messages";
import { answerWithin } from "./tools-view";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Post = (
  path: string,
  body: unknown,
) => Promise<{ value: unknown; ok: boolean }>;

// Executor's row on the tools screen (decision F44): the state in plain
// words, one action (Install, Update, Repair, or an agent for a conflict),
// and the version, address, service and agents behind Details. The setup
// runs in the Launchpad: the row says its step while it runs and the state
// the server reads afterwards, never a state it remembers.

const answerMs = 45_000;

export function createExecutorPanel(
  options: Readonly<{
    post: Post;
    copy: () => Copy;
    /** Executor's state changed: the tools section draws again. */
    changed: () => void;
    /** The conflict's prepared prompt for an agent. */
    prompt: (
      title: string,
      hint: string,
      text: string,
      from: HTMLElement,
    ) => void;
  }>,
) {
  let status: ExecutorStatus | null = null;
  let unreadable = false;
  let reading = 0;
  let running: ExecutorPhase | null = null;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function read(): Promise<void> {
    const turn = ++reading;
    let parsed: ExecutorStatus | null = null;
    try {
      const answer = await answerWithin(
        options.post("/api/tools/executor/status", {}),
        answerMs,
      );
      parsed = answer.answered ? parseExecutorStatus(answer.value) : null;
    } catch {}
    if (turn !== reading) return;
    unreadable = parsed === null;
    if (parsed !== null) status = parsed;
    options.changed();
  }

  /** Starts the setup, or joins the one that runs, and asks again until it
   * ends; the answer is the state it ended in. */
  async function setup(): Promise<void> {
    if (running !== null) return;
    running = "install";
    options.changed();
    let body: unknown = {};
    for (;;) {
      let value: unknown = null;
      try {
        const answer = await answerWithin(
          options.post("/api/tools/executor/setup", body),
          answerMs,
        );
        value = answer.answered ? answer.value : null;
      } catch {}
      const pending = parseExecutorSettingUp(value);
      if (pending !== null) {
        running = pending.phase;
        options.changed();
        body = { job: pending.job };
        await new Promise((resolve) => setTimeout(resolve, executorPollMs));
        continue;
      }
      const parsed = parseExecutorStatus(value);
      running = null;
      unreadable = parsed === null;
      if (parsed !== null) status = parsed;
      options.changed();
      return;
    }
  }

  /** The status line, the one control and the details of the row. */
  function row(copy: Copy): Readonly<{
    line: Readonly<{ text: string; state: string }>;
    controls: readonly HTMLElement[];
    details: HTMLElement | null;
  }> {
    const line =
      unreadable && running === null
        ? { text: copy.executorLoadFailed, state: "unknown" }
        : executorRowLine(status, running, copy);
    const controls: HTMLElement[] = [];
    const action = running === null ? executorAction(status, copy) : null;
    if (action !== null) {
      const node = element("button", "primary", action.label);
      node.type = "button";
      node.dataset.tool = "executor";
      node.dataset.control = "executor";
      node.setAttribute(
        "aria-label",
        fill(copy.executorActionNamed, { action: action.label }),
      );
      node.addEventListener("click", () => {
        if (action.kind === "setup") void setup();
        else
          options.prompt(
            copy.executorConflictTitle,
            copy.toolsPromptHint,
            copy.executorConflictPrompt,
            node,
          );
      });
      controls.push(node);
    }
    return { line, controls, details: details(copy) };
  }

  function details(copy: Copy): HTMLElement | null {
    const facts = executorFacts(status, copy);
    if (facts.length === 0) return null;
    const section = element("section", "vault-facts");
    section.append(element("h4", "", copy.executorDetails));
    const list = element("dl", "vault-list");
    for (const fact of facts)
      list.append(element("dt", "", fact.label), element("dd", "", fact.value));
    section.append(list);
    if (
      status !== null &&
      status.state !== "unsupported" &&
      (status.agents.codex === "registered" ||
        status.agents.claude === "registered")
    )
      section.append(element("p", "tools-muted", copy.executorNewChats));
    return section;
  }

  return Object.freeze({ read, row, setup });
}
