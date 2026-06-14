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
  body { margin: 0; font: 14px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
         background: #0d1117; color: #e6edf3; }
  header { padding: 16px 24px; border-bottom: 1px solid #21262d; display: flex;
           align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .summary { display: flex; gap: 14px; flex-wrap: wrap; }
  .pill { padding: 2px 10px; border-radius: 999px; background: #161b22; border: 1px solid #21262d; }
  .muted { color: #7d8590; }
  main { padding: 16px 24px; display: grid; gap: 12px;
         grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
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
<main id="workers"></main>
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
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

/**
 * Starts the dashboard HTTP server on 127.0.0.1:port.
 * Serves the HTML shell at / and a JSON snapshot at /api/status.
 * Returns a shutdown function.
 */
export async function startDashboard(deps: DashboardDeps, port: number): Promise<() => void> {
  const html = dashboardHtml();
  const server: Server = createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildSnapshot(deps)));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return () => {
    server.close();
  };
}
