import type { ChatMessage, LlmClient } from "./llm-client.js";
import type { Orchestrator, Assignment } from "./orchestrator.js";
import type { StatusBoard } from "./status-board.js";

export interface Decision {
  reply: string;
  assignments: Assignment[];
}

/**
 * Parse the router LLM's response into a Decision. Accepts a fenced ```json
 * block, bare JSON, or falls back to treating the whole text as a plain reply
 * with no assignments. Assignments missing role/task are dropped defensively.
 */
export function parseDecision(raw: string): Decision {
  const json = extractJson(raw);
  if (json) {
    const reply = typeof json.reply === "string" ? json.reply : raw.trim();
    const assignments = Array.isArray(json.assignments)
      ? json.assignments
          .filter(
            (a): a is Assignment =>
              !!a &&
              typeof (a as Assignment).role === "string" &&
              typeof (a as Assignment).task === "string",
          )
          .map((a) => ({ role: a.role, task: a.task }))
      : [];
    return { reply, assignments };
  }
  return { reply: raw.trim(), assignments: [] };
}

function extractJson(raw: string): { reply?: unknown; assignments?: unknown[] } | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const SYSTEM_PROMPT = (roles: string[]) => `You are the Orchestrator for a team of AI worker agents, each a separate opencode process with a fixed role. Your job is to read the user's request and decide which role(s) should handle it, then assign each a concrete task. You do NOT do the work yourself — you route and coordinate.

Available roles (deliberation, execution, support):
${roles.map((r) => `- ${r}`).join("\n")}

Guidance:
- Pick the role(s) that genuinely fit the request. A code change might go to backend/frontend; a "should we do X?" might go to visionary + skeptic + decider; understanding the codebase goes to researcher first.
- You may assign multiple roles in one turn when they can work in parallel.
- If the request is unclear or you need info before dispatching, ask the user instead of assigning — return an empty assignments list.
- Keep each task self-contained and specific; the worker only sees the task text.

Respond with ONLY a JSON object (optionally in a \`\`\`json fence) of this exact shape:
{"reply": "<short message shown to the user>", "assignments": [{"role": "<role>", "task": "<task>"}]}
The "reply" explains what you're doing (or asks your question). "assignments" is [] when you are only replying/asking.`;

/**
 * The router brain: holds conversation history, asks the LLM what to do with
 * each user message, dispatches the chosen assignments via the Orchestrator,
 * and returns the reply text to show in the web chat.
 */
export class OrchestratorAI {
  private history: ChatMessage[] = [];

  constructor(
    private readonly llm: Pick<LlmClient, "chat">,
    private readonly orchestrator: Pick<Orchestrator, "dispatch">,
    private readonly board: Pick<StatusBoard, "summary" | "getAll">,
    private readonly roles: string[],
  ) {}

  async handle(userMessage: string): Promise<string> {
    this.history.push({ role: "user", content: userMessage });

    const statusLine = JSON.stringify(this.board.summary());
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT(this.roles) },
      { role: "system", content: `Current job status: ${statusLine}` },
      ...this.history,
    ];

    const raw = await this.llm.chat(messages);
    const decision = parseDecision(raw);

    this.history.push({ role: "assistant", content: decision.reply });

    if (decision.assignments.length > 0) {
      // Only dispatch to known roles; ignore hallucinated role names.
      const valid = decision.assignments.filter((a) => this.roles.includes(a.role));
      if (valid.length > 0) await this.orchestrator.dispatch(valid);
    }

    return decision.reply;
  }
}
