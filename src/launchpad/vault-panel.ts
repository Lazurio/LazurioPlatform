import type { VaultPhase, VaultStatus } from "../vault/flow";
import type { MessageKey } from "./messages";
import { vaultPath } from "./routes";
import { answerWithin } from "./tools-view";
import { fill } from "./update-view";
import {
  parseVaultSettingUp,
  parseVaultStatus,
  vaultAction,
  vaultOpenLink,
  vaultRowLine,
  vaultSetupPollMs,
} from "./vault-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Post = (
  path: string,
  body: unknown,
) => Promise<{ value: unknown; ok: boolean }>;

// The Environment's own vault on the tools screen (decision F53, the
// wireframe of prototypes-lazurio#33): the row says the state, opens the
// vault ("Otevřít trezor") once it is connected, and offers one action only
// where a setup can move it on. The Environment sets the vault up itself, at
// the Launchpad's start: the row follows a setup that runs, whoever started
// it, by the state the server reads, never a state it remembers.

const answerMs = 45_000;

export function createVaultPanel(
  options: Readonly<{
    post: Post;
    copy: () => Copy;
    /** The vault's state changed: the tools section draws again. */
    changed: () => void;
    /** A setup this page followed ended connected: the page reads the
     * Folder again (the setup in which the vault became ready turned the
     * agents' switch on there, decision F53). */
    connected: () => void;
  }>,
) {
  let status: VaultStatus | null = null;
  let unreadable = false;
  let reading = 0;
  let running: VaultPhase | null = null;

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
  const svg = (name: string) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", "icon");
    node.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    node.append(use);
    return node;
  };

  /** Reads the vault's state; `sync` asks the vault itself (on the first
   * read and on Refresh status). A setup that runs is followed. */
  async function read(sync: boolean): Promise<void> {
    const turn = ++reading;
    let value: unknown = null;
    try {
      const answer = await answerWithin(
        options.post(
          sync ? "/api/tools/bitwarden/refresh" : "/api/tools/bitwarden/status",
          {},
        ),
        answerMs,
      );
      value = answer.answered ? answer.value : null;
    } catch {}
    if (turn !== reading) return;
    const pending = parseVaultSettingUp(value);
    if (pending !== null) {
      void setup(pending);
      return;
    }
    const parsed = parseVaultStatus(value);
    unreadable = parsed === null;
    if (parsed !== null) status = parsed;
    options.changed();
  }

  /** Starts the setup, or joins the one that runs (`joined`: the one a
   * reading found), and asks again until it ends; the answer is the state
   * it ended in. */
  async function setup(
    joined?: Readonly<{ job: string; phase: VaultPhase }>,
  ): Promise<void> {
    if (running !== null) return;
    running = joined?.phase ?? "install";
    options.changed();
    let body: unknown = joined === undefined ? {} : { job: joined.job };
    for (;;) {
      let value: unknown = null;
      try {
        const answer = await answerWithin(
          options.post("/api/tools/bitwarden/setup", body),
          answerMs,
        );
        value = answer.answered ? answer.value : null;
      } catch {}
      const pending = parseVaultSettingUp(value);
      if (pending !== null) {
        running = pending.phase;
        options.changed();
        body = { job: pending.job };
        await new Promise((resolve) => setTimeout(resolve, vaultSetupPollMs));
        continue;
      }
      const parsed = parseVaultStatus(value);
      // The setup's answer is the newest state: a read that started before
      // it ended is dropped when it arrives (`read` compares its turn).
      reading++;
      running = null;
      unreadable = parsed === null;
      if (parsed !== null) status = parsed;
      options.changed();
      if (parsed?.state === "connected") options.connected();
      return;
    }
  }

  /** The status line and the controls of the bitwarden row; no details. */
  function row(copy: Copy): Readonly<{
    line: Readonly<{ text: string; state: string }>;
    controls: readonly HTMLElement[];
    details: HTMLElement | null;
  }> {
    const line =
      unreadable && running === null
        ? { text: copy.vaultLoadFailed, state: "unknown" }
        : vaultRowLine(status, running, copy);
    const controls: HTMLElement[] = [];
    const action = vaultAction(status, running, copy);
    if (action !== null) {
      const node = element("button", "primary", action);
      node.type = "button";
      node.dataset.tool = "bitwarden";
      node.dataset.control = "vault";
      node.setAttribute("aria-label", fill(copy.vaultActionNamed, { action }));
      node.addEventListener("click", () => void setup());
      controls.push(node);
    }
    // A personal Environment whose person has not connected their own
    // Bitwarden (root decision 0203 point 7): the way to the form, never a
    // setup, which would only wait for them.
    if (running === null && status?.state === "needs-connection") {
      const connect = element("a", "button primary", copy.vaultConnectAction);
      connect.href = vaultPath;
      connect.dataset.route = "";
      connect.dataset.tool = "bitwarden";
      connect.dataset.control = "vault-connect";
      controls.push(connect);
    }
    const link = running === null ? vaultOpenLink(status) : null;
    if (link !== null) {
      const anchor = element("a", "button", copy.vaultOpen);
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.dataset.tool = "bitwarden";
      anchor.dataset.control = "vault-open";
      anchor.append(svg("external"));
      controls.push(anchor);
    }
    return { line, controls, details: null };
  }

  return Object.freeze({ read, row, setup });
}
