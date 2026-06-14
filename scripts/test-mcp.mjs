// Manual MCP smoke test for the Hub.
// Connects to the Hub MCP server (Streamable HTTP) exactly like Hermes would,
// lists the four tools, then optionally dispatches a real task to a worker.
//
// Usage:
//   node scripts/test-mcp.mjs            # list tools + get_status
//   node scripts/test-mcp.mjs dispatch   # also dispatch a real task to "frontend"
//
// Requires the Hub to be running (run-smoke.bat) so port 4100 is live.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HUB_URL = "http://127.0.0.1:4100/mcp";

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function main() {
  const doDispatch = process.argv[2] === "dispatch";
  const transport = new StreamableHTTPClientTransport(new URL(HUB_URL));
  const client = new Client({ name: "hub-smoke-test", version: "1.0.0" });

  console.log(`Connecting to Hub MCP at ${HUB_URL} ...`);
  await client.connect(transport);
  console.log("Connected.");

  const tools = await client.listTools();
  log("TOOLS", tools.tools.map((t) => t.name));

  const statusBefore = await client.callTool({ name: "get_status", arguments: {} });
  log("get_status (before)", statusBefore.content?.[0]?.text ?? statusBefore);

  if (doDispatch) {
    const dispatch = await client.callTool({
      name: "dispatch_task",
      arguments: {
        assignments: [
          { role: "frontend", task: "Reply with exactly: HELLO FROM FRONTEND WORKER. Do not create files." },
        ],
      },
    });
    log("dispatch_task", dispatch.content?.[0]?.text ?? dispatch);

    console.log("\nWaiting 20s for the worker to process the prompt...");
    await new Promise((r) => setTimeout(r, 20000));

    const results = await client.callTool({ name: "get_results", arguments: {} });
    log("get_results (after)", results.content?.[0]?.text ?? results);
  }

  await client.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("MCP smoke test failed:", err);
  process.exit(1);
});
