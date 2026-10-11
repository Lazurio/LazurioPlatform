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
// the server reads afterwards, never a state it remembers. A setup the page
// did not start (the Launchpad's own after its start, or Install in another
// page) is followed the same way once a reading finds it.

const answerMs = 45_000;

export function createExecutorPanel(
  options: Readonly<{
    post: Post;
    copy: () => Copy;
    /** Executor's state changed: the tools section draws again. */
    changed: () => void;
    /** A setup ended: the tools are read again, so the rest of the row (its
     * installation in Details) says what the setup left. */
    settled: () => void;
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
    let value: unknown = null;
    try {
      const answer = await answerWithin(
        options.post("/api/tools/executor/status", {}),
        answerMs,
      );
      value = answer.answered ? answer.value : null;
    } catch {}
    if (turn !== reading) return;
    // A setup runs: followed as if Install had been clicked here.
    const pending = parseExecutorSettingUp(value);
    if (pending !== null) {
      void setup(pending);
      return;
    }
    const parsed = parseExecutorStatus(value);
    unreadable = parsed === null;
    if (parsed !== null) status = parsed;
    options.changed();
  }

  /** Starts the setup, or joins the one that runs (`joined`: the one a
   * reading found), and asks again until it ends; the answer is the state
   * it ended in. */
  async function setup(
    joined?: Readonly<{ job: string; phase: ExecutorPhase }>,
  ): Promise<void> {
    if (running !== null) return;
    running = joined?.phase ?? "install";
    options.changed();
    let body: unknown = joined === undefined ? {} : { job: joined.job };
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
      // The setup's answer is the newest state: a read that started before
      // it ended is dropped when it arrives (`read` compares its turn).
      reading++;
      running = null;
      unreadable = parsed === null;
      if (parsed !== null) status = parsed;
      options.changed();
      options.settled();
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
