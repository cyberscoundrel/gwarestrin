// Minimal MCP stdio server (newline-delimited JSON-RPC 2.0, MCP stdio transport).
// Exposes one tool: echo(text) -> "MCP_OK:<text>". No SDK needed.
// Usage: node scripts/mock-mcp.mjs
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notification: no reply

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-mcp", version: "0.1.0" },
        },
      });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo text back with a marker",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
      break;
    case "tools/call": {
      const text = String(params?.arguments?.text ?? "");
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `MCP_OK:${text}` }] },
      });
      break;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
