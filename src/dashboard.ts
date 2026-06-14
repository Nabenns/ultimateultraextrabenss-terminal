import { createServer, type Server } from "node:http";
import type { StatusBoard } from "./status-board.js";
import type { Job } from "./types.js";

/** A point-in-time view of the fleet for the dashboard. */
export interface DashboardSnapshot {
  generatedAt: number;
  summary: ReturnType<StatusBoard["summary"]>;
  usage: { tokens: number; cost: number };
  workers: {
    name: string;
    healthy: boolean | null; // null = unknown (not yet checked)
    jobs: Job[];
  }[];
  jobs: Job[];
}

export interface DashboardDeps {
  board: StatusBoard;
  /** Declared worker roster (names), so empty roles still show up. */
  workerNames: string[];
  /** Live health map maintained by the Hub's health watch. */
  health: Map<string, boolean>;
  /**
   * Handles a chat message from the web UI: routes it through the Orchestrator-AI
   * and resolves with the reply text shown to the user. Optional so the dashboard
   * can run status-only in tests.
   */
  onChat?: (message: string) => Promise<string>;
  /**
   * Drains and returns autonomous replies produced by the correction loop since
   * the last call (for the web to poll). Optional.
   */
  drainReplies?: () => { text: string; at: number }[];
  /**
   * Returns the live conversation (user/assistant turns) for a worker by name,
   * fetched from its opencode session. Optional. Empty array if none/unknown.
   */
  getConversation?: (workerName: string) => Promise<{ role: string; text: string }[]>;
  /**
   * Aborts the active session of a worker by name. Resolves true if an abort was
   * issued, false if the worker/session was not found. Optional.
   */
  onAbort?: (workerName: string) => Promise<boolean>;
  /** Returns cached fleet-wide token/cost totals (refreshed by the Hub). Optional. */
  getUsage?: () => { tokens: number; cost: number };
  /** Returns the current per-role model overrides (role -> model or null). Optional. */
  getModels?: () => Record<string, string | null>;
  /** Sets (or clears, when model is null/empty) a role's model override. Optional. */
  setModel?: (role: string, model: string | null) => void;
}

/** Build the JSON snapshot the dashboard renders. Pure + directly testable. */
export function buildSnapshot(deps: DashboardDeps): DashboardSnapshot {
  const jobs = deps.board.getAll();
  const workers = deps.workerNames.map((name) => ({
    name,
    healthy: deps.health.has(name) ? deps.health.get(name)! : null,
    jobs: jobs.filter((j) => j.role === name),
  }));
  return {
    generatedAt: Date.now(),
    summary: deps.board.summary(),
    usage: deps.getUsage ? deps.getUsage() : { tokens: 0, cost: 0 },
    workers,
    jobs,
  };
}

const STATE_COLORS: Record<string, string> = {
  queued: "#888",
  running: "#3b82f6",
  done: "#22c55e",
  failed: "#ef4444",
};

/** Static HTML shell; data is fetched client-side from /api/status. */
function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ben-terminal Hub</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117; --fg: #e6edf3; --panel: #161b22; --border: #21262d;
    --border2: #30363d; --muted: #7d8590; --accent: #3b82f6; --send: #238636;
  }
  body.light {
    color-scheme: light;
    --bg: #ffffff; --fg: #1f2328; --panel: #f6f8fa; --border: #d0d7de;
    --border2: #d0d7de; --muted: #636c76; --accent: #0969da; --send: #1a7f37;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
         background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; }
  header { padding: 14px 24px; border-bottom: 1px solid var(--border); display: flex;
           align-items: baseline; gap: 16px; flex-wrap: wrap; flex: none; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .summary { display: flex; gap: 14px; flex-wrap: wrap; }
  .pill { padding: 2px 10px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); }
  .muted { color: var(--muted); }
  .spacer { flex: 1; }
  #theme { background: none; border: 1px solid var(--border2); color: var(--fg);
    border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; }
  .layout { flex: 1; display: grid; grid-template-columns: 380px 1fr; min-height: 0; }
  /* Chat panel */
  .chat { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  .chat-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { padding: 8px 12px; border-radius: 8px; max-width: 92%; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #1f6feb33; border: 1px solid #1f6feb55; }
  .msg.ai { align-self: flex-start; background: var(--panel); border: 1px solid var(--border); }
  .msg.sys { align-self: center; color: var(--muted); font-size: 12px; font-style: italic; }
  .chat-input { border-top: 1px solid var(--border); padding: 12px; display: flex; gap: 8px; flex: none; }
  .chat-input textarea { flex: 1; resize: none; background: var(--bg); color: var(--fg);
    border: 1px solid var(--border2); border-radius: 8px; padding: 8px 10px; font: inherit; min-height: 44px; }
  .chat-input button { background: var(--send); color: #fff; border: none; border-radius: 8px;
    padding: 0 16px; font: inherit; font-weight: 600; cursor: pointer; }
  .chat-input button:disabled { opacity: .5; cursor: default; }
  /* Worker grid */
  .workers-wrap { overflow-y: auto; padding: 16px 24px; }
  main { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .worker { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); overflow: hidden; cursor: pointer; transition: border-color .15s; }
  .worker:hover { border-color: var(--accent); }
  .worker-head { padding: 10px 14px; display: flex; align-items: center; gap: 8px;
                 border-bottom: 1px solid var(--border); }
  .worker-head .name { font-weight: 600; flex: 1; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .jobs { padding: 6px 14px 12px; display: flex; flex-direction: column; gap: 8px; }
  .job { border-left: 3px solid var(--border2); padding: 4px 0 4px 10px; }
  .job .task { white-space: pre-wrap; word-break: break-word; }
  .job .meta { font-size: 12px; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 4px; color: #0d1117; font-weight: 700; }
  .empty { color: var(--muted); font-style: italic; padding: 6px 0; }
  .summary-val { font-weight: 700; }
  /* Worker conversation modal */
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none;
    align-items: center; justify-content: center; z-index: 10; }
  .modal-bg.open { display: flex; }
  .modal { width: min(760px, 92vw); max-height: 84vh; background: var(--bg);
    border: 1px solid var(--border2); border-radius: 10px; display: flex; flex-direction: column; }
  .modal-head { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex;
    align-items: center; gap: 10px; }
  .modal-head .title { font-weight: 600; flex: 1; }
  .modal-head button { background: none; border: 1px solid var(--border2); color: var(--fg);
    border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
  .modal-body { overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .turn { padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
  .turn.user { background: #1f6feb22; border: 1px solid #1f6feb44; }
  .turn.assistant { background: var(--panel); border: 1px solid var(--border); }
  .turn .role { font-size: 11px; text-transform: uppercase; color: var(--muted); margin-bottom: 3px; }
  /* Responsive: stack chat above workers on narrow screens */
  @media (max-width: 720px) {
    .layout { grid-template-columns: 1fr; grid-template-rows: 45vh 1fr; }
    .chat { border-right: none; border-bottom: 1px solid var(--border); }
    header { padding: 12px 16px; gap: 10px; }
    .workers-wrap { padding: 12px 16px; }
  }
</style>
</head>
<body>
<header>
  <h1>ben-terminal Hub</h1>
  <div class="summary" id="summary"></div>
  <span class="pill" id="usage"></span>
  <span class="muted" id="updated"></span>
  <span class="spacer"></span>
  <button id="theme" onclick="toggleTheme()">theme</button>
</header>
<div class="layout">
  <section class="chat">
    <div class="chat-log" id="chatlog">
      <div class="msg sys">Ketik tugas atau pertanyaan. Orchestrator yang menentukan role mana yang mengerjakan.</div>
    </div>
    <form class="chat-input" id="chatform">
      <textarea id="chatbox" placeholder="Ketik tugas atau pertanyaan… (Enter kirim, Shift+Enter baris baru)"></textarea>
      <button type="submit" id="send">Kirim</button>
    </form>
  </section>
  <div class="workers-wrap"><main id="workers"></main></div>
</div>
<div class="modal-bg" id="modalbg">
  <div class="modal">
    <div class="modal-head">
      <span class="title" id="modaltitle">worker</span>
      <input id="modelinput" placeholder="model override (kosong = default)" style="background:var(--bg);color:var(--fg);border:1px solid var(--border2);border-radius:6px;padding:4px 8px;font:inherit;width:200px" />
      <button onclick="saveModel()">set model</button>
      <button onclick="abortWorker()" id="abortbtn">stop</button>
      <button onclick="closeWorker()">close</button>
    </div>
    <div class="modal-body" id="modalbody"></div>
  </div>
</div>
<script>
const STATE_COLORS = ${JSON.stringify(STATE_COLORS)};
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function toggleTheme(){
  document.body.classList.toggle('light');
  try { localStorage.setItem('hubTheme', document.body.classList.contains('light') ? 'light' : 'dark'); } catch(e){}
}
(function initTheme(){
  try { if (localStorage.getItem('hubTheme') === 'light') document.body.classList.add('light'); } catch(e){}
})();
function healthDot(h){
  const c = h === true ? '#22c55e' : h === false ? '#ef4444' : '#6e7681';
  const t = h === true ? 'healthy' : h === false ? 'down' : 'unknown';
  return '<span class="dot" style="background:'+c+'" title="'+t+'"></span>';
}
function jobView(j){
  const color = STATE_COLORS[j.state] || '#888';
  const summary = j.summary ? '<div class="meta muted">'+esc(j.summary)+'</div>' : '';
  const todos = (j.remainingTodos && j.remainingTodos.length)
    ? '<div class="meta muted">todo: '+esc(j.remainingTodos.join('; '))+'</div>' : '';
  return '<div class="job" style="border-left-color:'+color+'">'
    + '<div><span class="badge" style="background:'+color+'">'+j.state+'</span></div>'
    + '<div class="task">'+esc(j.prompt)+'</div>'+summary+todos+'</div>';
}
async function refresh(){
  try {
    const res = await fetch('/api/status');
    const d = await res.json();
    document.getElementById('summary').innerHTML = Object.entries(d.summary)
      .map(([k,v]) => '<span class="pill">'+k+' <span class="summary-val">'+v+'</span></span>').join('');
    if (d.usage) {
      const tok = d.usage.tokens >= 1e6 ? (d.usage.tokens/1e6).toFixed(1)+'M'
        : d.usage.tokens >= 1e3 ? (d.usage.tokens/1e3).toFixed(1)+'k' : String(d.usage.tokens);
      document.getElementById('usage').textContent =
        tok + ' tokens · $' + (d.usage.cost || 0).toFixed(2);
    }
    document.getElementById('updated').textContent =
      'updated ' + new Date(d.generatedAt).toLocaleTimeString();
    document.getElementById('workers').innerHTML = d.workers.map(w =>
      '<div class="worker" data-worker="'+esc(w.name)+'" onclick="openWorker(\''+esc(w.name)+'\')"><div class="worker-head">'+healthDot(w.healthy)
      + '<span class="name">'+esc(w.name)+'</span>'
      + '<span class="muted">'+w.jobs.length+' job'+(w.jobs.length===1?'':'s')+'</span></div>'
      + '<div class="jobs">'+(w.jobs.length ? w.jobs.map(jobView).join('') : '<div class="empty">no jobs yet</div>')+'</div></div>'
    ).join('');
  } catch (e) {
    document.getElementById('updated').textContent = 'hub unreachable';
  }
}
const log = document.getElementById('chatlog');
function addMsg(cls, text){
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
const form = document.getElementById('chatform');
const box = document.getElementById('chatbox');
const sendBtn = document.getElementById('send');
async function sendChat(){
  const text = box.value.trim();
  if (!text) return;
  box.value = '';
  addMsg('user', text);
  sendBtn.disabled = true;
  const thinking = addMsg('sys', 'orchestrator sedang memproses…');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const d = await res.json();
    thinking.remove();
    if (d.error) { addMsg('sys', 'error: ' + d.error); }
    else { addMsg('ai', d.reply || '(no reply)'); }
  } catch (e) {
    thinking.remove();
    addMsg('sys', 'gagal menghubungi hub');
  } finally {
    sendBtn.disabled = false;
    box.focus();
    refresh();
  }
}
form.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
async function pollReplies(){
  try {
    const res = await fetch('/api/replies');
    const d = await res.json();
    for (const r of (d.replies || [])) addMsg('ai', r.text);
  } catch (e) { /* ignore */ }
}
let openWorkerName = null;
async function openWorker(name){
  openWorkerName = name;
  document.getElementById('modaltitle').textContent = name + ' — conversation';
  document.getElementById('modalbg').classList.add('open');
  // Prefill the model override field from current settings.
  try {
    const m = await fetch('/api/models').then(r => r.json());
    document.getElementById('modelinput').value = (m.models && m.models[name]) || '';
  } catch(e){ document.getElementById('modelinput').value = ''; }
  await loadWorkerConvo();
}
async function saveModel(){
  if (!openWorkerName) return;
  const model = document.getElementById('modelinput').value.trim();
  try {
    await fetch('/api/models', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: openWorkerName, model }),
    });
    addMsg('sys', model ? (openWorkerName + ' model -> ' + model) : (openWorkerName + ' model -> default'));
  } catch(e){ addMsg('sys', 'gagal set model'); }
}
function closeWorker(){
  openWorkerName = null;
  document.getElementById('modalbg').classList.remove('open');
}
async function abortWorker(){
  if (!openWorkerName) return;
  const btn = document.getElementById('abortbtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/worker/' + encodeURIComponent(openWorkerName) + '/abort', { method: 'POST' });
    const d = await res.json();
    addMsg('sys', d.ok ? ('stopped ' + openWorkerName) : ('nothing to stop for ' + openWorkerName));
  } catch (e) {
    addMsg('sys', 'gagal stop ' + openWorkerName);
  } finally {
    btn.disabled = false;
    loadWorkerConvo();
  }
}
async function loadWorkerConvo(){
  if (!openWorkerName) return;
  try {
    const res = await fetch('/api/worker/' + encodeURIComponent(openWorkerName));
    const d = await res.json();
    const body = document.getElementById('modalbody');
    if (!d.turns || !d.turns.length){
      body.innerHTML = '<div class="empty">Belum ada percakapan. Worker ini belum dapat tugas.</div>';
      return;
    }
    body.innerHTML = d.turns.map(t =>
      '<div class="turn '+(t.role==='user'?'user':'assistant')+'">'
      + '<div class="role">'+esc(t.role)+'</div>'+esc(t.text)+'</div>'
    ).join('');
  } catch (e) {
    document.getElementById('modalbody').innerHTML = '<div class="empty">gagal memuat percakapan</div>';
  }
}
document.getElementById('modalbg').addEventListener('click', (e) => {
  if (e.target.id === 'modalbg') closeWorker();
});
refresh();
setInterval(refresh, 2000);
setInterval(pollReplies, 2500);
setInterval(() => { if (openWorkerName) loadWorkerConvo(); }, 2500);
</script>
</body>
</html>`;
}

/** Read and JSON-parse a request body, with a size guard. */
function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Starts the dashboard HTTP server on both loopback addresses (127.0.0.1 and
 * ::1) so `localhost` resolves regardless of whether Windows picks IPv4 or IPv6,
 * while staying off the network. Serves the HTML shell at /, a JSON snapshot at
 * /api/status, and accepts chat at POST /api/chat. Returns a shutdown fn.
 */
export async function startDashboard(deps: DashboardDeps, port: number): Promise<() => void> {
  const html = dashboardHtml();
  const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildSnapshot(deps)));
      return;
    }
    if (req.url === "/api/replies") {
      const replies = deps.drainReplies ? deps.drainReplies() : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ replies }));
      return;
    }
    if (req.url === "/api/models" && (!req.method || req.method === "GET")) {
      const models = deps.getModels ? deps.getModels() : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }
    if (req.url === "/api/models" && req.method === "POST") {
      void (async () => {
        try {
          const body = (await readJsonBody(req)) as { role?: unknown; model?: unknown };
          const role = typeof body.role === "string" ? body.role : "";
          const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
          if (!role) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "role is required" }));
            return;
          }
          deps.setModel?.(role, model);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, role, model }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
        }
      })();
      return;
    }
    if (req.url?.startsWith("/api/worker/") && req.url.endsWith("/abort") && req.method === "POST") {
      void (async () => {
        const mid = req.url!.slice("/api/worker/".length, -"/abort".length);
        const name = decodeURIComponent(mid);
        const ok = deps.onAbort ? await deps.onAbort(name).catch(() => false) : false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok }));
      })();
      return;
    }
    if (req.url?.startsWith("/api/worker/")) {
      void (async () => {
        const name = decodeURIComponent(req.url!.slice("/api/worker/".length));
        const turns = deps.getConversation ? await deps.getConversation(name).catch(() => []) : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name, turns }));
      })();
      return;
    }
    if (req.url === "/api/chat" && req.method === "POST") {
      void (async () => {
        try {
          if (!deps.onChat) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "chat not available" }));
            return;
          }
          const body = (await readJsonBody(req)) as { message?: unknown };
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "message is required" }));
            return;
          }
          const reply = await deps.onChat(message);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ reply }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
        }
      })();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };

  // Bind IPv4 loopback (required) then IPv6 loopback (best-effort), so
  // `localhost` works whether Windows resolves it to 127.0.0.1 or ::1, while
  // never exposing the server beyond loopback.
  const servers: Server[] = [];
  const listen = (host: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const server = createServer(handler);
      server.once("error", reject);
      server.listen(port, host, () => {
        servers.push(server);
        resolve();
      });
    });

  await listen("127.0.0.1"); // required — throws if the port is taken
  await listen("::1").catch(() => {
    // IPv6 loopback may be unavailable; IPv4 alone is acceptable.
  });

  return () => {
    for (const server of servers) server.close();
  };
}
