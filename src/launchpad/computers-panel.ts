import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;

// Settings → Connections → Počítače pro agenty (decision F73): the people's
// computers paired through Lazurio Agent Desktop, each with its system,
// whether it is attached now and its last activity, and its removal after a
// confirmation. Pairing itself starts in the application, never here. The
// group shows only where this Environment uses people's computers (the
// server says so); every server value is drawn as text.

export type ComputerItem = Readonly<{
  deviceId: string;
  name: string;
  os: "macos" | "windows" | null;
  connected: boolean;
  lastActivity: string | null;
  agents: "executor" | "missing";
}>;

/** The server's answer as the panel uses it, or null for anything else;
 * `computers` is null where this Environment does not use them. */
export function parseComputers(
  value: unknown,
): Readonly<{ computers: readonly ComputerItem[] | null }> | null {
  if (value === null || typeof value !== "object") return null;
  const answer = value as Record<string, unknown>;
  if (answer.kind !== "computers") return null;
  if (answer.supported !== true) return { computers: null };
  if (!Array.isArray(answer.computers)) return null;
  const computers: ComputerItem[] = [];
  for (const raw of answer.computers) {
    if (raw === null || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.deviceId !== "string" ||
      typeof item.name !== "string" ||
      typeof item.connected !== "boolean"
    )
      return null;
    computers.push({
      deviceId: item.deviceId,
      name: item.name,
      os: item.os === "macos" || item.os === "windows" ? item.os : null,
      connected: item.connected,
      lastActivity:
        typeof item.lastActivity === "string" &&
        !Number.isNaN(Date.parse(item.lastActivity))
          ? item.lastActivity
          : null,
      agents: item.agents === "executor" ? "executor" : "missing",
    });
  }
  return { computers };
}

/** The line under a computer's name. */
export function computerDetail(
  copy: Copy,
  item: ComputerItem,
  format: (date: Date) => string,
): string {
  return [
    item.os === "macos" ? "macOS" : item.os === "windows" ? "Windows" : "",
    item.connected ? copy.computersConnected : copy.computersDisconnected,
    item.lastActivity === null
      ? copy.computersNever
      : copy.computersLast.replace(
          "{time}",
          format(new Date(item.lastActivity)),
        ),
    item.agents === "missing" ? copy.computersAgentsMissing : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

export function createComputersPanel(
  options: Readonly<{
    get: (path: string) => Answer;
    post: (path: string, body: unknown) => Answer;
    copy: () => Copy;
    locale: () => string;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing Computers UI");
    return element;
  };
  const group = find<HTMLElement>("#computers-group");
  const list = find<HTMLUListElement>("#computers-list");
  const status = find<HTMLParagraphElement>("#computers-state");

  let computers: readonly ComputerItem[] | null = null;
  let supported = false;
  let loading = false;
  let failed: MessageKey | null = null;
  let confirming: string | null = null;
  let removing: string | null = null;
  let reading = 0;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    content?: string,
  ) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (content !== undefined) created.textContent = content;
    return created;
  };
  const button = (label: string, className: string, action: () => void) => {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };

  function render() {
    const copy = options.copy();
    group.hidden = !supported;
    const message =
      failed !== null
        ? copy[failed]
        : computers !== null && computers.length === 0
          ? copy.computersEmpty
          : null;
    status.textContent = message ?? "";
    status.hidden = message === null;
    list.hidden = computers === null || computers.length === 0;
    const formatter = new Intl.DateTimeFormat(options.locale(), {
      dateStyle: "medium",
      timeStyle: "short",
    });
    list.replaceChildren(
      ...(computers ?? []).map((item) => {
        const row = element("li");
        const main = element("div", "row-copy");
        main.append(
          element("p", "row-title", item.name),
          element(
            "p",
            "row-desc",
            computerDetail(copy, item, (date) => formatter.format(date)),
          ),
        );
        const actions = element("div", "phone-device-actions");
        if (confirming === item.deviceId) {
          actions.append(
            element(
              "span",
              "row-status",
              copy.computersRemoveConfirm.replace("{name}", item.name),
            ),
            button(copy.computersCancel, "", () => {
              confirming = null;
              render();
            }),
            button(copy.computersRemoveYes, "primary", () => {
              void remove(item.deviceId);
            }),
          );
        } else {
          const action = button(copy.computersRemove, "", () => {
            confirming = item.deviceId;
            render();
          });
          action.disabled = removing !== null;
          actions.append(action);
        }
        row.append(main, actions);
        return row;
      }),
    );
  }

  async function refresh(): Promise<void> {
    const turn = ++reading;
    loading = true;
    let read: ReturnType<typeof parseComputers> = null;
    try {
      const { value, ok } = await options.get("/api/computers");
      read = ok ? parseComputers(value) : null;
    } catch {
      read = null;
    }
    if (turn !== reading) return;
    loading = false;
    if (read === null) {
      failed = "computersFailed";
    } else {
      failed = null;
      supported = read.computers !== null;
      computers = read.computers;
    }
    render();
  }

  async function remove(deviceId: string) {
    removing = deviceId;
    confirming = null;
    render();
    try {
      const { ok } = await options.post("/api/computers/remove", { deviceId });
      failed = ok ? null : "computersRemoveFailed";
    } catch {
      failed = "computersRemoveFailed";
    } finally {
      removing = null;
    }
    if (failed === null) await refresh();
    else render();
  }

  return {
    refresh,
    render,
    get loaded() {
      return computers !== null || loading;
    },
  };
}
