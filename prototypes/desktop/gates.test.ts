import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStream, HeldInput, verdict } from "./rfb-gate";

const handshake = () =>
  new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 1, 0]);
const key = (down: boolean, keysym: number) => {
  const b = new Uint8Array(8);
  b[0] = 4;
  b[1] = down ? 1 : 0;
  new DataView(b.buffer).setUint32(4, keysym);
  return b;
};
const pointer = (mask: number, x: number, y: number) => {
  const b = new Uint8Array(6);
  b[0] = 5;
  b[1] = mask;
  new DataView(b.buffer).setUint16(2, x);
  new DataView(b.buffer).setUint16(4, y);
  return b;
};

describe("RFB gate", () => {
  test("the handshake passes and ClientInit is always shared", () => {
    const stream = new ClientStream();
    const out = stream.push(handshake());
    if ("error" in out) throw new Error(out.error);
    expect(out.map((m) => m.type)).toEqual(["handshake", "handshake", "handshake"]);
    expect(out[2]?.bytes[0]).toBe(1);
  });

  test("a security type other than None ends the connection", () => {
    const stream = new ClientStream();
    const out = stream.push(
      new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 2]),
    );
    expect("error" in out).toBe(true);
  });

  test("input passes only in control; screen requests always pass", () => {
    const stream = new ClientStream();
    stream.push(handshake());
    const update = new Uint8Array(10);
    update[0] = 3;
    const out = stream.push(
      new Uint8Array([...update, ...key(true, 0x61), ...pointer(1, 10, 20)]),
    );
    if ("error" in out) throw new Error(out.error);
    expect(out.map((m) => verdict(m, false).kind)).toEqual(["pass", "drop", "drop"]);
    expect(out.map((m) => verdict(m, true).kind)).toEqual(["pass", "pass", "pass"]);
  });

  test("messages split across chunks are reassembled", () => {
    const stream = new ClientStream();
    stream.push(handshake());
    const bytes = key(true, 0x10c);
    const first = stream.push(bytes.slice(0, 3));
    const second = stream.push(bytes.slice(3));
    expect(first).toEqual([]);
    if ("error" in second) throw new Error(second.error);
    expect(second[0]).toMatchObject({ type: "key", down: true, keysym: 0x10c });
  });

  test("a paste is input; SetDesktopSize and xvp never pass", () => {
    const stream = new ClientStream();
    stream.push(handshake());
    const cut = new Uint8Array([6, 0, 0, 0, 0, 0, 0, 2, 104, 105]);
    const size = new Uint8Array([251, 0, 0, 100, 0, 100, 1, 0, ...new Uint8Array(16)]);
    const xvp = new Uint8Array([252, 0, 1, 2]);
    const out = stream.push(new Uint8Array([...cut, ...size, ...xvp]));
    if ("error" in out) throw new Error(out.error);
    expect(out.map((m) => verdict(m, false).kind)).toEqual(["drop", "drop", "drop"]);
    expect(out.map((m) => verdict(m, true).kind)).toEqual(["pass", "drop", "drop"]);
  });

  test("an unknown message ends the connection instead of guessing", () => {
    const stream = new ClientStream();
    stream.push(handshake());
    expect("error" in stream.push(new Uint8Array([200, 0, 0, 0]))).toBe(true);
  });

  test("held keys and buttons are released when control ends", () => {
    const held = new HeldInput();
    const stream = new ClientStream();
    stream.push(handshake());
    const out = stream.push(
      new Uint8Array([...key(true, 0xffe1), ...pointer(1, 5, 6), ...key(true, 0x61), ...key(false, 0x61)]),
    );
    if ("error" in out) throw new Error(out.error);
    for (const m of out) held.note(m);
    const released = held.release();
    expect(released).toEqual([key(false, 0xffe1), pointer(0, 5, 6)]);
    expect(held.release()).toEqual([]);
  });
});

describe("computer gate", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "desktop-turn-"));
    process.env.LAZURIO_DESKTOP_STATE = directory;
  });
  afterEach(async () => {
    delete process.env.LAZURIO_DESKTOP_STATE;
    await rm(directory, { recursive: true, force: true });
  });

  // A stand-in for `cua-driver mcp`: it answers every request with the tool
  // name it received, so a call that reached it is visible in the output.
  const stub = `
    let buf = "";
    for await (const chunk of Bun.stdin.stream()) {
      buf += new TextDecoder().decode(chunk);
      let at;
      while ((at = buf.indexOf("\\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1);
        console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { reached: m.params?.name ?? m.method } }));
      }
    }`;

  async function run(lines: object[]): Promise<{ id: number; result: Record<string, unknown> }[]> {
    const stubPath = join(directory, "stub.ts");
    await writeFile(stubPath, stub);
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "computer-gate.ts"), "--driver", "bun", stubPath],
      {
        stdin: "pipe",
        stdout: "pipe",
        env: { ...process.env, LAZURIO_DESKTOP_STATE: directory, AGENT_BROWSER_SESSION: "thread-a", CODEX_THREAD_ID: "t1" },
      },
    );
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    child.stdin.end();
    const text = await new Response(child.stdout).text();
    await child.exited;
    return text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .sort((a, b) => a.id - b.id);
  }

  const call = (id: number, name: string) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: { session: "s" } },
  });

  test("without a person every call reaches the driver and input is noted", async () => {
    const out = await run([call(1, "click"), call(2, "list_windows")]);
    expect(out.map((m) => m.result.reached)).toEqual(["click", "list_windows"]);
    const { activeAgents } = await import("./turn");
    const agents = await activeAgents(Date.now(), directory);
    expect(agents.map((a) => [a.agent, a.tool])).toEqual([["thread-a", "click"]]);
  });

  test("while a person holds the screen input is refused, reading passes", async () => {
    const now = Date.now();
    await writeFile(
      join(directory, "person.json"),
      JSON.stringify({ holder: "person", who: "person", since: now, until: now + 60_000 }),
    );
    const out = await run([
      call(1, "click"),
      call(2, "get_desktop_state"),
      call(3, "type_text"),
      call(4, "a_tool_of_a_later_driver"),
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
    ]);
    expect(out[0]?.result.isError).toBe(true);
    expect(out[0]?.result.reached).toBeUndefined();
    expect(out[1]?.result.reached).toBe("get_desktop_state");
    expect(out[2]?.result.isError).toBe(true);
    expect(out[3]?.result.isError).toBe(true);
    expect(out[4]?.result.reached).toBe("tools/list");
  });

  test("an expired lease holds nothing", async () => {
    const now = Date.now();
    await writeFile(
      join(directory, "person.json"),
      JSON.stringify({ holder: "person", who: "person", since: now - 200_000, until: now - 1 }),
    );
    const out = await run([call(1, "click")]);
    expect(out[0]?.result.reached).toBe("click");
  });
});
