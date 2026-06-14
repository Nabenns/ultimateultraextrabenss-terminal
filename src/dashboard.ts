import { createServer, type Server } from "node:http";
import type { StatusBoard } from "./status-board.js";
import type { Job } from "./types.js";

/** A point-in-time view of the fleet for the dashboard. */
export interface DashboardSnapshot {
  generatedAt: number;
  summary: ReturnType<StatusBoard["summary"]>;
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
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
         background: #0d1117; color: #e6edf3; display: flex; flex-direction: column; height: 100vh; }
  header { padding: 14px 24px; border-bottom: 1px solid #21262d; display: flex;
           align-items: baseline; gap: 16px; flex-wrap: wrap; flex: none; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .summary { display: flex; gap: 14px; flex-wrap: wrap; }
  .pill { padding: 2px 10px; border-radius: 999px; background: #161b22; border: 1px solid #21262d; }
  .muted { color: #7d8590; }
  .layout { flex: 1; display: grid; grid-template-columns: 380px 1fr; min-height: 0; }
  /* Chat panel */
  .chat { border-right: 1px solid #21262d; display: flex; flex-direction: column; min-height: 0; }
  .chat-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { padding: 8px 12px; border-radius: 8px; max-width: 92%; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #1f6feb33; border: 1px solid #1f6feb55; }
  .msg.ai { align-self: flex-start; background: #161b22; border: 1px solid #21262d; }
  .msg.sys { align-self: center; color: #7d8590; font-size: 12px; font-style: italic; }
  .chat-input { border-top: 1px solid #21262d; padding: 12px; display: flex; gap: 8px; flex: none; }
  .chat-input textarea { flex: 1; resize: none; background: #0d1117; color: #e6edf3;
    border: 1px solid #30363d; border-radius: 8px; padding: 8px 10px; font: inherit; min-height: 44px; }
  .chat-input button { background: #238636; color: #fff; border: none; border-radius: 8px;
    padding: 0 16px; font: inherit; font-weight: 600; cursor: pointer; }
  .chat-input button:disabled { opacity: .5; cursor: default; }
  /* Worker grid */
  .workers-wrap { overflow-y: auto; padding: 16px 24px; }
  main { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .worker { border: 1px solid #21262d; border-radius: 8px; background: #161b22; overflow: hidden; }
  .worker-head { padding: 10px 14px; display: flex; align-items: center; gap: 8px;
                 border-bottom: 1px solid #21262d; }
  .worker-head .name { font-weight: 600; flex: 1; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .jobs { padding: 6px 14px 12px; display: flex; flex-direction: column; gap: 8px; }
  .job { border-left: 3px solid #30363d; padding: 4px 0 4px 10px; }
  .job .task { white-space: pre-wrap; word-break: break-word; }
  .job .meta { font-size: 12px; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 4px; color: #0d1117; font-weight: 700; }
  .empty { color: #7d8590; font-style: italic; padding: 6px 0; }
  .summary-val { font-weight: 700; }
</style>
</head>
<body>
<header>
  <h1>ben-terminal Hub</h1>
  <div class="summary" id="summary"></div>
  <span class="muted" id="updated"></span>
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
<script>
const STATE_COLORS = ${JSON.stringify(STATE_COLORS)};
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
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
    document.getElementById('updated').textContent =
      'updated ' + new Date(d.generatedAt).toLocaleTimeString();
    document.getElementById('workers').innerHTML = d.workers.map(w =>
      '<div class="worker"><div class="worker-head">'+healthDot(w.healthy)
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
refresh();
setInterval(refresh, 2000);
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
