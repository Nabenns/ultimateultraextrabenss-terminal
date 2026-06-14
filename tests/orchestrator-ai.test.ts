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
