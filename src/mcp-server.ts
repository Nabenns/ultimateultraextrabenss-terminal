import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import type { StatusBoard } from "./status-board.js";
import type { Orchestrator } from "./orchestrator.js";
import type { MessageBus } from "./bus.js";
import type { Job } from "./types.js";

export interface McpDeps {
  board: StatusBoard;
  orchestrator: Orchestrator;
  bus: MessageBus;
}

/** Pure tool handlers, independent of MCP transport — directly testable. */
export function createToolHandlers(deps: McpDeps) {
  return {
    async dispatch_task(args: { assignments: { role: string; task: string }[] }): Promise<{ jobs: Job[] }> {
      const jobs = await deps.orchestrator.dispatch(args.assignments);
      return { jobs };
    },
    async get_status(_args: Record<string, never>): Promise<{ summary: ReturnType<StatusBoard["summary"]>; jobs: Job[] }> {
      return { summary: deps.board.summary(), jobs: deps.board.getAll() };
    },
    async get_results(args: { jobId?: string }): Promise<{ jobs: Job[] }> {
      if (args.jobId) {
        const job = deps.board.get(args.jobId);
        return { jobs: job ? [job] : [] };
      }
      return { jobs: deps.board.getAll() };
    },
    async send_message(args: { from: string; to: string; text: string }): Promise<{ ok: true }> {
      await deps.bus.send({ ...args, timestamp: Date.now() });
      return { ok: true };
    },
  };
}

/**
 * Wires the four tool handlers onto an McpServer and serves them over the
 * Streamable HTTP transport on 127.0.0.1:port. Returns a shutdown function.
 *
 * Verified against @modelcontextprotocol/sdk@1.29.0:
 * - McpServer.registerTool(name, { description, inputSchema }, handler) where
 *   inputSchema is a Zod raw shape; handler receives the parsed args object.
 * - StreamableHTTPServerTransport({ sessionIdGenerator: undefined }) for
 *   stateless mode; transport.handleRequest(req, res) bridges Node http.
 */
export async function startMcpServer(deps: McpDeps, port: number): Promise<() => void> {
  const handlers = createToolHandlers(deps);
  const server = new McpServer({ name: "ben-terminal-hub", version: "0.1.0" });

  // Handler errors intentionally propagate; McpServer.registerTool converts a
  // thrown error into an isError tool result so Hermes sees the failure.
  const asText = (result: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  });

  server.registerTool(
    "dispatch_task",
    {
      description: "Dispatch one or more role/task assignments to workers.",
      inputSchema: {
        assignments: z.array(z.object({ role: z.string(), task: z.string() })),
      },
    },
    async (args) => asText(await handlers.dispatch_task(args)),
  );

  server.registerTool(
    "get_status",
    {
      description: "Get the status board summary and all jobs.",
      inputSchema: {},
    },
    async () => asText(await handlers.get_status({})),
  );

  server.registerTool(
    "get_results",
    {
      description: "Get job results, optionally filtered to a single jobId.",
      inputSchema: {
        jobId: z.string().optional(),
      },
    },
    async (args) => asText(await handlers.get_results(args)),
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a message from one worker to another via the bus.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        text: z.string(),
      },
    },
    async (args) => asText(await handlers.send_message(args)),
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const http = createServer((req, res) => {
    void transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolve);
  });

  return () => {
    http.close();
    void server.close();
  };
}
