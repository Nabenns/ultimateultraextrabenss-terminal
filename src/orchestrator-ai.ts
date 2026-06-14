import type { ChatMessage, LlmClient } from "./llm-client.js";
import type { Orchestrator, Assignment } from "./orchestrator.js";
import type { StatusBoard } from "./status-board.js";
import type { Job } from "./types.js";

export interface Decision {
  reply: string;
  assignments: Assignment[];
}

export interface OrchestratorAIOptions {
  /** Called with every reply the AI produces — user-initiated and autonomous. */
  onReply?: (reply: string) => void;
  /** Seed conversation history (e.g. restored from disk on restart). */
  initialHistory?: ChatMessage[];
  /** Called whenever history changes, for persistence. */
  onHistoryChange?: (history: ChatMessage[]) => void;
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

/** Max number of recent history messages sent to the LLM per turn. */
const HISTORY_WINDOW = 12;

/** Max consecutive autonomous correction rounds before pausing for the user. */
const MAX_AUTO_ROUNDS = 5;

const SYSTEM_PROMPT = (roles: string[]) => `You are the Orchestrator for a team of AI worker agents, each a separate opencode process with a fixed role. Your job is to read the user's request and decide which role(s) should handle it, then assign each a concrete task. You do NOT do the work yourself — you route and coordinate.

Available roles (deliberation, execution, support):
${roles.map((r) => `- ${r}`).join("\n")}

Guidance:
- Pick the role(s) that genuinely fit the request. A code change might go to backend/frontend; a "should we do X?" might go to visionary + skeptic + decider; understanding the codebase goes to researcher first.
- You may assign multiple roles in one turn when they can work in parallel.
- DEFAULT TO DISPATCHING. If the request describes any actionable work, emit assignments — do not just acknowledge it in prose. Only return empty assignments when you genuinely cannot proceed without more information.
- If the request is unclear or you need info before dispatching, ask the user instead of assigning — return an empty assignments list.
- Keep each task self-contained and specific; the worker only sees the task text (it does NOT see this conversation).

Examples:
- User: "pelajari project di C:/foo" -> {"reply":"Saya kerahkan researcher untuk memetakan project.","assignments":[{"role":"researcher","task":"Pelajari project di C:/foo READ-ONLY: struktur folder, stack, entry point, alur. Ringkas terstruktur."}]}
- User: "tambah endpoint login" -> {"reply":"Backend mengerjakan endpoint login.","assignments":[{"role":"backend","task":"Tambahkan endpoint POST /login dengan validasi input. Ikuti pola project yang ada."}]}
- User: "haruskah kita pakai GraphQL?" -> {"reply":"Saya gelar diskusi.","assignments":[{"role":"visionary","task":"Argumen untuk pindah ke GraphQL."},{"role":"skeptic","task":"Risiko dan biaya pindah ke GraphQL."},{"role":"decider","task":"Putuskan GraphQL atau tidak berdasarkan argumen kedua sisi."}]}
- User: "tolong dong" (ambiguous) -> {"reply":"Boleh perjelas tugasnya? Misal: review project, tambah fitur, atau riset sesuatu.","assignments":[]}

Respond with ONLY a JSON object (optionally in a \`\`\`json fence) of this exact shape:
{"reply": "<short message shown to the user>", "assignments": [{"role": "<role>", "task": "<task>"}]}
The "reply" explains what you're doing (or asks your question). "assignments" is [] when you are only replying/asking.`;

/**
 * The router brain: holds conversation history, asks the LLM what to do with
 * each user message, dispatches the chosen assignments via the Orchestrator,
 * and re-engages automatically when those jobs finish (the correction loop).
 */
export class OrchestratorAI {
  private history: ChatMessage[] = [];
  /** Job IDs dispatched in the current round, still awaiting completion. */
  private pendingJobs = new Set<string>();
  /** Consecutive autonomous correction rounds since the last user message. */
  private autoRounds = 0;

  constructor(
    private readonly llm: Pick<LlmClient, "chat">,
    private readonly orchestrator: Pick<Orchestrator, "dispatch">,
    private readonly board: Pick<StatusBoard, "summary" | "getAll"> & { get?: (id: string) => Job | undefined },
    private readonly roles: string[],
    private readonly options: OrchestratorAIOptions = {},
  ) {
    if (options.initialHistory) this.history = [...options.initialHistory];
  }

  /** Snapshot of the current conversation history (for persistence). */
  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  private pushHistory(msg: ChatMessage): void {
    this.history.push(msg);
    this.options.onHistoryChange?.(this.history);
  }

  /** Handle a user message: ask the LLM, dispatch, and return the reply. */
  async handle(userMessage: string): Promise<string> {
    this.autoRounds = 0; // a fresh user message resets the autonomous-round budget
    this.pushHistory({ role: "user", content: userMessage });
    return this.think();
  }

  /**
   * Called by the Hub when a job finishes. When ALL jobs dispatched in the
   * current round have settled, the AI re-engages with their results to decide
   * whether to continue, correct, or report — without the user typing again.
   * Bounded by MAX_AUTO_ROUNDS so a misbehaving loop can't burn tokens forever.
   */
  async notifyJobSettled(jobId: string): Promise<void> {
    if (!this.pendingJobs.has(jobId)) return;
    this.pendingJobs.delete(jobId);
    if (this.pendingJobs.size > 0) return; // wait for the rest of the round

    if (this.autoRounds >= MAX_AUTO_ROUNDS) {
      const msg =
        "Auto-correction paused after several autonomous rounds to avoid an unbounded loop. Send a new message to continue.";
      this.pushHistory({ role: "assistant", content: msg });
      this.options.onReply?.(msg);
      this.autoRounds = 0;
      return;
    }
    this.autoRounds++;

    const results = this.collectResults();
    const anyFailed = this.board.getAll().some((j) => j.state === "failed");
    const failNote = anyFailed
      ? " Some jobs FAILED — decide whether to retry with a corrected task, route to another role, or report the failure to the user."
      : "";
    this.pushHistory({
      role: "user",
      content: `[system] All dispatched workers have finished. Results:\n${results}\n\nReview the results. If the goal is met, report back to the user. If more work or correction is needed, dispatch follow-up assignments.${failNote}`,
    });
    const reply = await this.think();
    this.options.onReply?.(reply);
  }

  /** One LLM turn: build context, get a decision, dispatch, track jobs. */
  private async think(): Promise<string> {
    const statusLine = JSON.stringify(this.board.summary());
    // Only send a recent window of history. Unbounded history (especially the
    // verbose "all workers finished" entries) accumulates and drowns the current
    // request, making the model chat instead of dispatch.
    const recent = this.history.slice(-HISTORY_WINDOW);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT(this.roles) },
      { role: "system", content: `Current job status: ${statusLine}` },
      ...recent,
    ];

    const raw = await this.llm.chat(messages);
    const decision = parseDecision(raw);

    this.pushHistory({ role: "assistant", content: decision.reply });

    if (decision.assignments.length > 0) {
      // Only dispatch to known roles; ignore hallucinated role names.
      const valid = decision.assignments.filter((a) => this.roles.includes(a.role));
      if (valid.length > 0) {
        const jobs = await this.orchestrator.dispatch(valid);
        for (const j of jobs) this.pendingJobs.add(j.id);
      }
    }

    return decision.reply;
  }

  /** Summarize the outcome of jobs the board knows about for the LLM. */
  private collectResults(): string {
    const lines = this.board.getAll().map((j) => {
      const detail = j.summary ?? (j.remainingTodos?.length ? `remaining: ${j.remainingTodos.join("; ")}` : "(no output)");
      return `- ${j.role} [${j.state}]: ${detail}`;
    });
    return lines.length ? lines.join("\n") : "(no jobs)";
  }
}
