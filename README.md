# ben-terminal

A multi-agent terminal orchestrator. You chat in **one web UI**; an in-Hub
**Orchestrator-AI** decides which of 11 fixed-role [`opencode`](https://opencode.ai)
workers should handle each task, dispatches them, and automatically re-engages
when they finish to review results and continue, correct, or report back.

Each worker is a real `opencode serve` process in its own Windows Terminal tab.
The Hub drives them over HTTP and shows everything in a live web dashboard plus a
2D "office" view.

```
Browser (1 chat)
   │  HTTP
   ▼
Hub  ─ Orchestrator-AI (LLM)   ← decides who does what, runs the correction loop
     ─ StatusBoard             ← authoritative job state
     ─ WorkerManager           ← spawns/kills opencode workers (Windows Terminal)
     ─ Dashboard + /office     ← web UI on 127.0.0.1:4099
   │  HTTP (per worker)
   ▼
11 opencode workers (visionary, advocate, skeptic, decider, architect,
                     frontend, backend, tester, reviewer, researcher, docs)
```

## Roles

| Band | Roles | Purpose |
|------|-------|---------|
| Deliberation | visionary, advocate, skeptic, decider | propose, argue for/against, decide |
| Execution | architect, frontend, backend, tester | design and build |
| Support | reviewer, researcher, docs | review, investigate, document |

Each role has its own persona in `.opencode/agent/<role>.md`.

## Requirements

- Windows with **Windows Terminal** (`wt.exe`)
- Node.js 20+ and `opencode` installed and on PATH
- An opencode global config (`~/.config/opencode/opencode.json`) with a `model`
  and provider credentials. The Orchestrator-AI reuses these — **no secrets live
  in this repo.**

## Run

```
run-full.bat     # all 11 workers
run-smoke.bat    # 1 worker (frontend), for quick checks
```

Each builds first, then starts the Hub. The browser auto-opens to
**http://127.0.0.1:4099** (use `127.0.0.1`, not `localhost`, if your browser
prefers IPv6 — both are bound, but `127.0.0.1` is safest).

Then just chat. Example: *"pelajari project di C:/path lalu usulkan satu
perbaikan dan putuskan apakah layak."* The orchestrator routes it to the right
roles and reports back when done.

## Web UI

- **Chat (left):** one box; the AI decides which roles work.
- **Worker grid (right):** live job state, elapsed timer per job, `stalled?` flag.
  Click a card to see that worker's **live activity feed** (tool calls +
  reasoning), set a per-role model override, or stop it.
- **Header:** token/cost counter, `stop all`, theme toggle, `office ↗` link.
- **Office (`/office`):** a 2D top-down office where each worker is an avatar
  that animates by state (idle / working / done / failed / stalled).

## Configuration

`agents.config.json` (full roster) and `agents.smoke.json` (one worker) declare
the workers: `{ name, port, cwd, agent, model, attach }`. Pass a config path as
the first CLI arg, or set `HUB_CONFIG`. Ports 4101–4111; the Hub reserves 4099.

`cwd` is the project directory each worker operates in — point it at the repo you
want the team to work on.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run build` | compile TypeScript to `dist/` |
| `npm test` | run the unit suite (Vitest) |
| `npm run smoke` | build + start Hub with 1 worker |
| `npm run full` | build + start Hub with 11 workers |
| `npm run doctor` | spawn a real worker, dispatch a bash task, assert it completes, clean up |

## How it stays reliable

- **Headless workers auto-allow tool permissions** (bash/edit/webfetch) via a
  worker-only config, so they don't hang waiting for an approval no one can give.
  Your global opencode config is untouched.
- **Cleanup on shutdown:** the Hub kills worker servers on exit so they don't
  orphan across restarts.
- **Stalled detection:** running jobs with no worker activity past 3 minutes are
  flagged in the UI.
- **Bounded correction loop:** at most 5 autonomous rounds before pausing for you,
  so it can't loop forever.

## Notes

- Workers run headless (`attach: false`) by default; watch their work in the web
  conversation panel rather than the terminal.
- History persists to `hub-history.json` (gitignored) and survives restarts.
