// JSON-RPC over newline-delimited lines (MCP's stdio transport), the framing
// of both sides of a computer's session: the SSH session from the computer
// and each agent's socket. A line longer than `maxBytes` is dropped whole,
// never parsed in parts; a screenshot fits well below the default.

export const maxLineBytes = 64 * 1024 * 1024;

/** A `data` handler that calls `onLine` with each complete line. */
export function lineSplitter(
  onLine: (line: string) => void,
  maxBytes: number = maxLineBytes,
): (chunk: Buffer | string) => void {
  let parts: Buffer[] = [];
  let length = 0;
  let overlong = false;
  return (chunk) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (;;) {
      const newline = data.indexOf(0x0a);
      if (newline === -1) {
        if (!overlong) {
          parts.push(data);
          length += data.length;
          if (length > maxBytes) {
            overlong = true;
            parts = [];
            length = 0;
          }
        }
        return;
      }
      const head = data.subarray(0, newline);
      if (!overlong && length + head.length <= maxBytes) {
        parts.push(head);
        const line = Buffer.concat(parts).toString("utf8").replace(/\r$/, "");
        if (line.trim() !== "") onLine(line);
      }
      parts = [];
      length = 0;
      overlong = false;
      data = data.subarray(newline + 1);
    }
  };
}

export type JsonRpcId = string | number;
export type JsonRpcMessage = Readonly<{
  jsonrpc?: unknown;
  id?: JsonRpcId | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}>;

/** One parsed message, or null for anything that is not a JSON object. */
export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRpcMessage)
      : null;
  } catch {
    return null;
  }
}

export const isRequest = (message: JsonRpcMessage) =>
  typeof message.method === "string" &&
  (typeof message.id === "string" || typeof message.id === "number");

export const isNotification = (message: JsonRpcMessage) =>
  typeof message.method === "string" && message.id === undefined;

export const isResponse = (message: JsonRpcMessage) =>
  message.method === undefined &&
  (typeof message.id === "string" || typeof message.id === "number") &&
  ("result" in message || "error" in message);

export const errorAnswer = (id: JsonRpcId, code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

export const resultAnswer = (id: JsonRpcId, result: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, result });

/** The MCP protocol version Lazurio speaks first. */
export const protocolVersion = "2025-06-18";

/** JSON-RPC's code for a method this side does not serve. */
export const methodNotFound = -32601;
/** Lazurio's code: the computer is held by another agent. */
export const computerBusy = -32001;
/** Lazurio's code: the computer is not attached. */
export const computerAway = -32002;

/** What an agent is told when the computer is not attached (contract v0,
 * section 3), in both languages, the person's first. */
export function awayMessage(name: string): string {
  return `Počítač ${name} není připojený: na počítači je ovládání vypnuté, počítač spí nebo je offline. (Computer ${name} is not connected: control is switched off on the computer, or it is asleep or offline.)`;
}

/** What an agent is told while another agent holds the computer. */
export function busyMessage(name: string, agent: string, since: Date): string {
  const time = since.toISOString().slice(11, 16);
  return `Počítač ${name} teď ovládá jiný agent (${agent}, od ${time} UTC). Zkuste to, až skončí. (Another agent, ${agent}, has controlled computer ${name} since ${time} UTC. Try again when it is done.)`;
}

/** The application's own tool that updates it; the computer is away for
 * about a minute after it. */
export const appUpdateTool = "lazurio_app_update";

/** What an agent is told while the application updates itself. */
export function updatingMessage(name: string): string {
  return `Aplikace Lazurio Agent Desktop na počítači ${name} se aktualizuje. Zkuste to za chvíli, asi za minutu. (Lazurio Agent Desktop on computer ${name} is updating. Try again in about a minute.)`;
}

/** What the agent that asked for the update hears when the session ends
 * before the application answered: the update runs. */
export function updateStartedMessage(name: string): string {
  return `Aktualizace aplikace na počítači ${name} běží. Počítač se asi za minutu připojí znovu. (The update of the application on computer ${name} is running. The computer reconnects in about a minute.)`;
}
