import { describe, it, expect, vi } from "vitest";
import { parseDecision, OrchestratorAI } from "../src/orchestrator-ai.js";

describe("parseDecision", () => {
  it("parses a fenced JSON block with assignments and reply", () => {
    const raw =
      'Here is my plan:\n```json\n{"reply":"Dispatching to backend.","assignments":[{"role":"backend","task":"build API"}]}\n```';
    const d = parseDecision(raw);
    expect(d.reply).toBe("Dispatching to backend.");
    expect(d.assignments).toEqual([{ role: "backend", task: "build API" }]);
  });

  it("parses bare JSON with no fence", () => {
    const raw = '{"reply":"ok","assignments":[]}';
    const d = parseDecision(raw);
    expect(d.reply).toBe("ok");
    expect(d.assignments).toEqual([]);
  });

  it("falls back to treating the whole text as a reply when no JSON is present", () => {
    const d = parseDecision("just a plain answer, no dispatch");
    expect(d.reply).toBe("just a plain answer, no dispatch");
    expect(d.assignments).toEqual([]);
  });

  it("drops assignments with unknown shape defensively", () => {
    const raw = '{"reply":"r","assignments":[{"role":"backend"},{"task":"x"},{"role":"fe","task":"go"}]}';
    const d = parseDecision(raw);
    expect(d.assignments).toEqual([{ role: "fe", task: "go" }]);
  });
});

describe("OrchestratorAI.handle", () => {
  function deps() {
    const dispatched: { role: string; task: string }[] = [];
    const orchestrator = {
      dispatch: vi.fn(async (a: { role: string; task: string }[]) => {
        dispatched.push(...a);
        return a.map((x, i) => ({ id: `job_${i}`, role: x.role }));
      }),
    };
    const board = { summary: () => ({ queued: 0, running: 0, done: 0, failed: 0 }), getAll: () => [] };
    return { orchestrator, board, dispatched };
  }

  it("sends the conversation to the LLM and dispatches the parsed assignments", async () => {
    const { orchestrator, board, dispatched } = deps();
    const llm = {
      chat: vi.fn(async () =>
        '{"reply":"On it — backend will build the API.","assignments":[{"role":"backend","task":"build the login API"}]}',
    ) };
    const ai = new OrchestratorAI(llm as never, orchestrator as never, board as never, ["backend", "frontend"]);

    const reply = await ai.handle("add a login endpoint");

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([{ role: "backend", task: "build the login API" }]);
    expect(reply).toContain("backend will build");
  });

  it("keeps conversation history across turns", async () => {
    const { orchestrator, board } = deps();
    const llm = { chat: vi.fn(async (_messages: { role: string; content: string }[]) => '{"reply":"ok","assignments":[]}') };
    const ai = new OrchestratorAI(llm as never, orchestrator as never, board as never, ["backend"]);

    await ai.handle("first message");
    await ai.handle("second message");

    const secondCall = llm.chat.mock.calls[1];
    const secondCallMessages = (secondCall?.[0] ?? []) as { role: string; content: string }[];
    const userTurns = secondCallMessages.filter((m) => m.role === "user");
    expect(userTurns.length).toBe(2);
    expect(userTurns[0]!.content).toContain("first message");
  });

  it("does not dispatch when the LLM returns no assignments", async () => {
    const { orchestrator, board } = deps();
    const llm = { chat: vi.fn(async () => '{"reply":"Which database do you use?","assignments":[]}') };
    const ai = new OrchestratorAI(llm as never, orchestrator as never, board as never, ["backend"]);

    const reply = await ai.handle("add login");
    expect(orchestrator.dispatch).not.toHaveBeenCalled();
    expect(reply).toContain("Which database");
  });
});

describe("OrchestratorAI auto-correction loop", () => {
  function jobBoard(jobs: Record<string, { role: string; state: string; summary: string | null }>) {
    return {
      summary: () => ({ queued: 0, running: 0, done: 0, failed: 0 }),
      getAll: () => Object.entries(jobs).map(([id, j]) => ({ id, ...j })),
      get: (id: string) => {
        const j = jobs[id];
        return j ? { id, ...j } : undefined;
      },
    };
  }

  it("re-engages the LLM with results once all dispatched jobs settle, and emits the reply", async () => {
    const jobs: Record<string, { role: string; state: string; summary: string | null }> = {};
    const dispatchCalls: { role: string; task: string }[][] = [];
    const orchestrator = {
      dispatch: vi.fn(async (a: { role: string; task: string }[]) => {
        dispatchCalls.push(a);
        return a.map((x, i) => {
          const id = `job_${dispatchCalls.length}_${i}`;
          jobs[id] = { role: x.role, state: "running", summary: null };
          return { id, role: x.role };
        });
      }),
    };
    const board = jobBoard(jobs);

    // 1st call: dispatch backend. 2nd call (after settle): report done, no more work.
    const llm = {
      chat: vi
        .fn()
        .mockResolvedValueOnce('{"reply":"Backend is on it.","assignments":[{"role":"backend","task":"build API"}]}')
        .mockResolvedValueOnce('{"reply":"Done — the API is built and verified.","assignments":[]}'),
    };

    const replies: string[] = [];
    const ai = new OrchestratorAI(llm as never, orchestrator as never, board as never, ["backend"], {
      onReply: (r) => replies.push(r),
    });

    await ai.handle("add a login endpoint");
    expect(dispatchCalls).toHaveLength(1);

    // Simulate the worker finishing.
    const jobId = Object.keys(jobs)[0]!;
    jobs[jobId]!.state = "done";
    jobs[jobId]!.summary = "Built POST /login with validation.";
    await ai.notifyJobSettled(jobId);

    // The AI re-engaged the LLM a 2nd time and emitted a follow-up reply.
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(replies.some((r) => r.includes("Done"))).toBe(true);

    // The 2nd LLM call included the worker's result in the prompt.
    const secondMessages = (llm.chat.mock.calls[1]?.[0] ?? []) as { role: string; content: string }[];
    expect(JSON.stringify(secondMessages)).toContain("Built POST /login");
  });

  it("waits for ALL dispatched jobs before re-engaging", async () => {
    const jobs: Record<string, { role: string; state: string; summary: string | null }> = {};
    const orchestrator = {
      dispatch: vi.fn(async (a: { role: string; task: string }[]) =>
        a.map((x, i) => {
          const id = `j${i}`;
          jobs[id] = { role: x.role, state: "running", summary: null };
          return { id, role: x.role };
        }),
      ),
    };
    const board = jobBoard(jobs);
    const llm = {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          '{"reply":"Dispatching both.","assignments":[{"role":"backend","task":"a"},{"role":"frontend","task":"b"}]}',
        )
        .mockResolvedValueOnce('{"reply":"both done","assignments":[]}'),
    };
    const ai = new OrchestratorAI(llm as never, orchestrator as never, board as never, ["backend", "frontend"]);

    await ai.handle("do two things");

    jobs["j0"]!.state = "done";
    await ai.notifyJobSettled("j0");
    expect(llm.chat).toHaveBeenCalledTimes(1); // not yet — j1 still running

    jobs["j1"]!.state = "done";
    await ai.notifyJobSettled("j1");
    expect(llm.chat).toHaveBeenCalledTimes(2); // now both settled
  });

  it("ignores settle notifications for jobs it did not dispatch", async () => {
    const board = jobBoard({});
    const orchestrator = { dispatch: vi.fn(async () => []) };
    const llm = { chat: vi.fn(async () => '{"reply":"ok","assignments":[]}') };
    const ai = new OrchestratorAI(llm as never, orchestrator as never, board as never, ["backend"]);

    await ai.notifyJobSettled("unknown_job");
    expect(llm.chat).not.toHaveBeenCalled();
  });
});

describe("OrchestratorAI history persistence", () => {
  const board = { summary: () => ({ queued: 0, running: 0, done: 0, failed: 0 }), getAll: () => [] };

  it("seeds from initialHistory and includes it in the next LLM call", async () => {
    const llm = { chat: vi.fn(async (_m: { role: string; content: string }[]) => '{"reply":"ok","assignments":[]}') };
    const ai = new OrchestratorAI(llm as never, { dispatch: vi.fn() } as never, board as never, ["backend"], {
      initialHistory: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    });

    await ai.handle("new question");
    const messages = (llm.chat.mock.calls[0]?.[0] ?? []) as { role: string; content: string }[];
    expect(JSON.stringify(messages)).toContain("earlier question");
    expect(JSON.stringify(messages)).toContain("new question");
  });

  it("calls onHistoryChange as the conversation grows", async () => {
    const snapshots: number[] = [];
    const llm = { chat: vi.fn(async () => '{"reply":"hi","assignments":[]}') };
    const ai = new OrchestratorAI(llm as never, { dispatch: vi.fn() } as never, board as never, ["backend"], {
      onHistoryChange: (h) => snapshots.push(h.length),
    });

    await ai.handle("hello");
    // at least: +1 user, +1 assistant
    expect(snapshots.at(-1)).toBeGreaterThanOrEqual(2);
    expect(ai.getHistory().length).toBeGreaterThanOrEqual(2);
  });

  it("caps the history window sent to the LLM (does not flood with old turns)", async () => {
    const seed: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < 40; i++) {
      seed.push({ role: i % 2 === 0 ? "user" : "assistant", content: `old turn ${i}` });
    }
    const llm = { chat: vi.fn(async (_m: { role: string; content: string }[]) => '{"reply":"ok","assignments":[]}') };
    const ai = new OrchestratorAI(llm as never, { dispatch: vi.fn() } as never, board as never, ["backend"], {
      initialHistory: seed,
    });

    await ai.handle("new request");
    const sent = (llm.chat.mock.calls[0]?.[0] ?? []) as { role: string; content: string }[];
    // 2 system messages + a bounded window (not all 41 history entries).
    expect(sent.length).toBeLessThanOrEqual(2 + 12);
    // The newest user message must be included.
    expect(JSON.stringify(sent)).toContain("new request");
    // A very old turn must have been dropped.
    expect(JSON.stringify(sent)).not.toContain("old turn 0");
  });
});
