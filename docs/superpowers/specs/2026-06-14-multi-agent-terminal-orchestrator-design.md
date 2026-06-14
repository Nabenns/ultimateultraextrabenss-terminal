# Multi-Agent Terminal Orchestrator — Design

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation

## Problem

User wants a multi-agent system where multiple `opencode` instances run as real
separate processes (not just subagents), each as a fixed role (orchestrator,
developer/frontend, backend, tester, etc.). The user interacts with a single
"central terminal" (the orchestrator), sends it one message, and it splits the
work across the right job-agents, runs them in parallel, then verifies what is
done and what remains. The whole orchestrator is in turn driven by **Hermes**
(Nous Research agent) as an outer AI-to-AI correction loop.

## Goals

- One entry point for the user: talk to Hermes, Hermes drives the orchestrator.
- Orchestrator decides "whose job is this", dispatches to workers, runs them in
  parallel, verifies completion, and reports "what's done / what's left".
- Workers are real `opencode` processes, each visible in its own Windows Terminal
  tab, that the user can watch live.
- Workers can communicate with each other (e.g. frontend asks backend for the
  API contract) without flooding the orchestrator's context.
- Hermes drives and corrects the orchestrator via a clean, standard interface.

## Non-Goals (YAGNI)

- No remote/multi-machine access in v1 (all on localhost).
- No auth on worker servers in v1 (localhost-only bind).
- No dynamic role creation in v1 — roles are configured up front.
- No persistence/replay of the message bus beyond an in-memory + log file.

## Architecture — Three Layers

```
LAYER 3 — HERMES (outer brain / correction loop)
   |  connects via MCP: dispatch_task, get_status, get_results, send_message
   v
LAYER 2 — THE HUB (single Node/TS process)
   |  = message bus + status board + MCP server + orchestrator logic
   |  controls each worker purely over its HTTP API
   v
LAYER 1 — WORKERS (one opencode process per role, each in a WT tab)
   frontend | backend | tester | ...   (each: opencode serve + optional attach)
```

### Layer responsibilities

**The Hub** (the only thing the user starts directly, plus the worker tabs):
A single Node/TypeScript process that fuses three roles:
1. **MCP server** — exposes tools to Hermes (Layer 3).
2. **Orchestrator logic** — owns task decomposition routing and verification.
3. **Message bus + status board** — the single point through which all worker
   messages flow, and the authoritative record of job state.

**Workers**: Each role is a long-running `opencode` instance launched as:
- `opencode serve --port <N>` — headless server holding that worker's session
  and agent state, exposing the opencode HTTP API.
- `opencode attach http://localhost:<N>` — a TUI in the same WT tab so the user
  can watch the worker work live (optional but default-on).

**Hermes**: External. Connects to the Hub as an MCP client. Its built-in
nudge/learning loop becomes the correction loop: dispatch → read status →
see incomplete → dispatch correction.

## Process Model (Windows)

- Workers are spawned via `wt.exe` into tabs/panes of one Windows Terminal window.
- Each worker tab runs `opencode serve --port <N>` (control plane) and, by
  default, `opencode attach http://localhost:<N>` (visible TUI).
- Tools verified present: `wt.exe`, Node v24, npm 11, `opencode`.

## Worker Control (opencode HTTP API)

The Hub controls each worker over HTTP (server bound to `127.0.0.1:<port>`):

| Purpose | Endpoint |
|---|---|
| Create a worker session | `POST /session` |
| Assign a task (non-blocking, enables true parallelism) | `POST /session/:id/prompt_async` |
| Know the moment a worker finishes/goes idle | `GET /event` (SSE stream) |
| Read what the worker produced | `GET /session/:id/message` |
| Read remaining work ("tinggal apa") | `GET /session/:id/todo` |
| Stop a runaway worker | `POST /session/:id/abort` |
| Health check | `GET /global/health` |

Parallelism comes from `prompt_async`: the Hub fires tasks to all relevant
workers without blocking, then reacts to SSE events as each completes.

## Inter-Worker Communication

Topology: **shared message bus** (chosen over star and mesh). Workers never
connect directly to each other. To send a message to a peer, a worker's message
goes to the Hub; the Hub delivers it by issuing a `prompt_async` to the target
worker. Every message is recorded by the Hub for tracing/debugging. The
orchestrator remains the authority on *who does what*; the bus is only the
transport.

## MCP Tools Exposed to Hermes

| Tool | Purpose |
|---|---|
| `dispatch_task` | Give the orchestrator a high-level goal; it decomposes and routes to workers. |
| `get_status` | Return job board: which jobs are done / running / failed. |
| `get_results` | Return concrete outputs/diffs/remaining-todos per job. |
| `send_message` | Send a directed message to a specific worker (or broadcast). |

## Status Board

Authoritative in-memory state in the Hub, mirrored to a log file. Per job:
`id`, `role`, `state` (queued/running/done/failed), `sessionID`, `lastUpdate`,
`summary`, `remainingTodos`. Updated from worker SSE events and message results.
This is what answers "udah beres belum, tinggal apa" for both the orchestrator
and Hermes (via `get_status` / `get_results`).

## Security Notes

- Worker opencode servers bind to `127.0.0.1` only; no network exposure in v1.
- No basic-auth password in v1 for simplicity (localhost-only). If remote access
  is needed later, set `OPENCODE_SERVER_PASSWORD` and add auth to Hub→worker
  calls. **Flagged and accepted by user.**
- The Hub's MCP server is local (stdio or localhost) for Hermes to connect.

## Runtime / Stack

- Orchestrator + Hub: **Node.js / TypeScript** (mature MCP SDK, easy child-process
  management, native fetch for the opencode HTTP API and SSE).
- Workers: `opencode` (already installed).
- Outer loop: Hermes (separate install).

## Open Questions Deferred to Planning

- Exact role roster and default prompts/agent config per role.
- Config file format for declaring roles, ports, and working directories.
- How the Hub starts workers: shell out to `wt.exe` with a generated command line.
- MCP transport choice for Hermes ↔ Hub (stdio vs HTTP) — confirm against
  Hermes's MCP client expectations during planning.
