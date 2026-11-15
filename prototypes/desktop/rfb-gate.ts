/** The client half of an RFB (VNC) connection, read message by message, so
 * that the desktop service and not the person's page decides whether a key,
 * a pointer or a paste reaches the screen. The server half passes unchanged.
 *
 * RFB 3.8 (RFC 6143): the client sends its 12-byte version, one byte for the
 * security type (only None, 1, is accepted: admission is the gateway's), one
 * byte of ClientInit, then messages whose lengths follow from their first
 * bytes. A message the gate does not know ends the connection, because its
 * length, and so every later message, would be a guess. */

export type GateVerdict =
  | { kind: "pass"; bytes: Uint8Array }
  | { kind: "drop"; bytes: Uint8Array; reason: "input" | "never" }
  | { kind: "close"; reason: string };

/** What the client sent, with its effect on the screen. */
export type ClientMessage =
  | { type: "handshake"; bytes: Uint8Array }
  | { type: "format" | "encodings" | "update" | "fence" | "continuous"; bytes: Uint8Array }
  | { type: "key"; bytes: Uint8Array; down: boolean; keysym: number }
  | { type: "pointer"; bytes: Uint8Array; mask: number; x: number; y: number }
  | { type: "cut"; bytes: Uint8Array }
  | { type: "never"; bytes: Uint8Array; name: string };

type Phase = "version" | "security" | "init" | "messages" | "closed";

export class ClientStream {
  #buffer = new Uint8Array(0);
  #phase: Phase = "version";

  /** Bytes from the client in, whole messages out. */
  push(chunk: Uint8Array): ClientMessage[] | { error: string } {
    if (this.#phase === "closed") return { error: "closed" };
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer, 0);
    joined.set(chunk, this.#buffer.length);
    this.#buffer = joined;
    const out: ClientMessage[] = [];
    for (;;) {
      const next = this.#next();
      if (next === null) break;
      if ("error" in next) {
        this.#phase = "closed";
        return next;
      }
      out.push(next);
    }
    return out;
  }

  #take(length: number): Uint8Array | null {
    if (this.#buffer.length < length) return null;
    const bytes = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return bytes;
  }

  #next(): ClientMessage | { error: string } | null {
    const view = new DataView(
      this.#buffer.buffer,
      this.#buffer.byteOffset,
      this.#buffer.byteLength,
    );
    const have = this.#buffer.length;
    switch (this.#phase) {
      case "version": {
        const bytes = this.#take(12);
        if (bytes === null) return null;
        const text = new TextDecoder().decode(bytes);
        if (text !== "RFB 003.008\n")
          return { error: `unsupported client version ${JSON.stringify(text)}` };
        this.#phase = "security";
        return { type: "handshake", bytes };
      }
      case "security": {
        const bytes = this.#take(1);
        if (bytes === null) return null;
        if (bytes[0] !== 1) return { error: `security type ${bytes[0]} refused` };
        this.#phase = "init";
        return { type: "handshake", bytes };
      }
      case "init": {
        const bytes = this.#take(1);
        if (bytes === null) return null;
        // Always shared: one person's desktop never disconnects another's.
        bytes[0] = 1;
        this.#phase = "messages";
        return { type: "handshake", bytes };
      }
      case "closed":
        return { error: "closed" };
      case "messages":
        break;
    }
    if (have < 1) return null;
    const kind = this.#buffer[0];
    const fixed = (length: number, type: "format" | "update" | "continuous") => {
      const bytes = this.#take(length);
      return bytes === null ? null : { type, bytes };
    };
    switch (kind) {
      case 0:
        return fixed(20, "format");
      case 2: {
        if (have < 4) return null;
        const bytes = this.#take(4 + 4 * view.getUint16(2));
        return bytes === null ? null : { type: "encodings", bytes };
      }
      case 3:
        return fixed(10, "update");
      case 4: {
        const bytes = this.#take(8);
        if (bytes === null) return null;
        const v = new DataView(bytes.buffer);
        return { type: "key", bytes, down: bytes[1] !== 0, keysym: v.getUint32(4) };
      }
      case 5: {
        const bytes = this.#take(6);
        if (bytes === null) return null;
        const v = new DataView(bytes.buffer);
        return {
          type: "pointer",
          bytes,
          mask: bytes[1] ?? 0,
          x: v.getUint16(2),
          y: v.getUint16(4),
        };
      }
      case 6: {
        if (have < 8) return null;
        // A negative length is the extended clipboard; its absolute value is
        // still the payload's length.
        const length = Math.abs(view.getInt32(4));
        const bytes = this.#take(8 + length);
        return bytes === null ? null : { type: "cut", bytes };
      }
      case 150:
        return fixed(10, "continuous");
      case 248: {
        if (have < 9) return null;
        const bytes = this.#take(9 + (this.#buffer[8] ?? 0));
        return bytes === null ? null : { type: "fence", bytes };
      }
      case 251: {
        // SetDesktopSize: the shared screen keeps its size for everyone.
        if (have < 8) return null;
        const bytes = this.#take(8 + 16 * (this.#buffer[6] ?? 0));
        return bytes === null ? null : { type: "never", bytes, name: "SetDesktopSize" };
      }
      case 252: {
        // xvp: shutdown, reboot, reset.
        const bytes = this.#take(4);
        return bytes === null ? null : { type: "never", bytes, name: "xvp" };
      }
      default:
        return { error: `unknown client message ${kind}` };
    }
  }
}

/** Whether a message may reach the screen. */
export function verdict(message: ClientMessage, inControl: boolean): GateVerdict {
  switch (message.type) {
    case "never":
      return { kind: "drop", bytes: message.bytes, reason: "never" };
    case "key":
    case "pointer":
    case "cut":
      return inControl
        ? { kind: "pass", bytes: message.bytes }
        : { kind: "drop", bytes: message.bytes, reason: "input" };
    default:
      return { kind: "pass", bytes: message.bytes };
  }
}

/** Keys and buttons a person still holds when control ends, so that the
 * screen never keeps a pressed Shift or a held mouse button. */
export class HeldInput {
  #keys = new Set<number>();
  #mask = 0;
  #x = 0;
  #y = 0;

  note(message: ClientMessage): void {
    if (message.type === "key") {
      if (message.down) this.#keys.add(message.keysym);
      else this.#keys.delete(message.keysym);
    } else if (message.type === "pointer") {
      this.#mask = message.mask;
      this.#x = message.x;
      this.#y = message.y;
    }
  }

  /** RFB messages that release everything held, in order. */
  release(): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const keysym of this.#keys) {
      const bytes = new Uint8Array(8);
      bytes[0] = 4;
      new DataView(bytes.buffer).setUint32(4, keysym);
      out.push(bytes);
    }
    if (this.#mask !== 0) {
      const bytes = new Uint8Array(6);
      bytes[0] = 5;
      const v = new DataView(bytes.buffer);
      v.setUint16(2, this.#x);
      v.setUint16(4, this.#y);
      out.push(bytes);
    }
    this.#keys.clear();
    this.#mask = 0;
    return out;
  }
}
