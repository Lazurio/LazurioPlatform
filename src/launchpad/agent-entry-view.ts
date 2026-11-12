import type { MessageKey } from "./messages";

// "Agenti v aplikacích kolegů" in Settings → Tento Environment (Lazurio Auth
// docs/agent-application-entry.md, "The switch"; plan LZD-0009 M9): whether
// agents of this Environment may act for the person in the applications
// colleagues share with them, and the link to the Dashboard page where the
// person switches it, with their own sign-in in their own browser. The
// Launchpad only shows it: nothing on the Environment can switch it.

/** The answer of `POST /api/agent-entry`. `available` false: this
 * Environment has no switch (no relay, so no identity of its own at Lazurio
 * Auth, or a Team Environment). `agentEntry` null: the state cannot be read
 * now, with the reading's refusal code; never shown as off. */
export type AgentEntryAnswer =
  | Readonly<{ available: false }>
  | Readonly<{
      available: true;
      agentEntry: "on" | "off" | null;
      reason?: string;
      page: string;
    }>;

export type AgentEntryView = Readonly<{
  title: string;
  state: string;
  hint: string;
  link: Readonly<{ href: string; text: string }>;
}>;

type Copy = Readonly<
  Record<
    Extract<
      MessageKey,
      | "agentEntryTitle"
      | "agentEntryOn"
      | "agentEntryOff"
      | "agentEntryUnknown"
      | "agentEntryOnHint"
      | "agentEntryOffHint"
      | "agentEntryUnknownHint"
      | "agentEntryChange"
    >,
    string
  >
>;

/** The row to draw, or null where there is nothing to show. */
export function agentEntryView(
  answer: AgentEntryAnswer | null,
  copy: Copy,
): AgentEntryView | null {
  if (answer === null || !answer.available) return null;
  const [state, hint] =
    answer.agentEntry === "on"
      ? [copy.agentEntryOn, copy.agentEntryOnHint]
      : answer.agentEntry === "off"
        ? [copy.agentEntryOff, copy.agentEntryOffHint]
        : [copy.agentEntryUnknown, copy.agentEntryUnknownHint];
  return Object.freeze({
    title: copy.agentEntryTitle,
    state,
    hint,
    link: Object.freeze({ href: answer.page, text: copy.agentEntryChange }),
  });
}

/** The route's answer as the page takes it; anything else is no answer. */
export function parseAgentEntryAnswer(value: unknown): AgentEntryAnswer | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.available === false) return Object.freeze({ available: false });
  if (
    record.available !== true ||
    !(
      record.agentEntry === "on" ||
      record.agentEntry === "off" ||
      record.agentEntry === null
    ) ||
    typeof record.page !== "string" ||
    !record.page.startsWith("https://")
  )
    return null;
  return Object.freeze({
    available: true,
    agentEntry: record.agentEntry,
    page: record.page,
  });
}
