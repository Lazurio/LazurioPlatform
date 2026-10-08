// A synthetic MCP server on stdio (newline-delimited JSON-RPC 2.0, the MCP
// stdio transport) for the contract of decision F42 (proposed): it answers
// `initialize` and `tools/list` with two tools, ignores notifications and
// answers every other request with "method not found", so a probe can count
// its tools. No network, no files.
export {};

const send = (message: unknown) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);

type Request = {
  id?: string | number | null;
  method?: unknown;
  params?: { protocolVersion?: unknown };
};

function answer(request: Request) {
  if (request.id === undefined || request.id === null) return;
  if (request.method === "initialize")
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion:
          typeof request.params?.protocolVersion === "string"
            ? request.params.protocolVersion
            : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
      },
    });
  else if (request.method === "tools/list")
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: ["first", "second"].map((name) => ({
          name,
          description: `The ${name} tool.`,
          inputSchema: { type: "object", properties: {} },
        })),
      },
    });
  else
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" },
    });
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line === "") continue;
    try {
      answer(JSON.parse(line) as Request);
    } catch {}
  }
}
