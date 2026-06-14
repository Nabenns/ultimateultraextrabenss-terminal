// Isolated verification of the MCP transport fix.
// Starts startMcpServer on a free port with stub deps (no real workers needed),
// connects an MCP client, lists tools, calls get_status, then shuts down.
import { startMcpServer } from "../dist/mcp-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 4199;

// Minimal stub deps — exercise the transport/handshake, not real orchestration.
const board = {
  summary: () => ({ queued: 0, running: 0, done: 0, failed: 0 }),
  getAll: () => [],
  get: () => undefined,
};
const orchestrator = { dispatch: async () => [], verify: async () => {} };
const bus = { send: async () => {}, history: () => [] };

async function main() {
  const stop = await startMcpServer({ board, orchestrator, bus }, PORT);
  console.log(`Test MCP server up on 127.0.0.1:${PORT}`);

  const client = new Client({ name: "verify", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));

  try {
    await client.connect(transport);
    console.log("HANDSHAKE OK");
    const tools = await client.listTools();
    console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
    const status = await client.callTool({ name: "get_status", arguments: {} });
    console.log("get_status:", status.content?.[0]?.text);
    console.log("RESULT: PASS");
  } finally {
    await client.close().catch(() => {});
    stop();
  }
  // Give the http close a tick, then exit.
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("RESULT: FAIL", err);
  process.exit(1);
});
