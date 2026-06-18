/**
 * Self-built "office" visualization (Claw3D-inspired, dependency-free).
 * A top-down Canvas 2D office where each worker is a desk + avatar that
 * animates by job state. Polls /api/status. Served by the Hub at /office.
 *
 * No Three.js, no external deps — just Canvas 2D so it stays in our control.
 */
export function officeHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ben-terminal Office</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
    font: 14px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 12px 20px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 16px; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  a { color: #6b8afd; text-decoration: none; }
  .muted { color: #7d8590; }
  .wrap { flex: 1; min-height: 0; position: relative; }
  canvas { display: block; width: 100%; height: 100%; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; }
  .legend span::before { content: "●"; margin-right: 4px; }
  .lg-idle::before { color: #6e7681; }
  .lg-running::before { color: #3b82f6; }
  .lg-done::before { color: #22c55e; }
  .lg-failed::before { color: #ef4444; }
  .lg-stalled::before { color: #f59e0b; }
</style>
</head>
<body>
<header>
  <h1>ben-terminal Office</h1>
  <a href="/">← dashboard</a>
  <div class="legend">
    <span class="lg-idle">idle</span>
    <span class="lg-running">working</span>
    <span class="lg-done">done</span>
    <span class="lg-failed">failed</span>
    <span class="lg-stalled">stalled</span>
  </div>
  <span class="muted" id="updated" style="margin-left:auto"></span>
</header>
<div class="wrap"><canvas id="office"></canvas></div>
<script>
const canvas = document.getElementById('office');
const ctx = canvas.getContext('2d');
let workers = [];
let dpr = Math.max(1, window.devicePixelRatio || 1);

function resize(){
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
}
window.addEventListener('resize', resize); resize();

const COLORS = { idle:'#6e7681', running:'#3b82f6', done:'#22c55e', failed:'#ef4444', stalled:'#f59e0b' };

function stateOf(w){
  const jobs = w.jobs || [];
  if (jobs.some(j => j.state === 'running' && j.stalled)) return 'stalled';
  if (jobs.some(j => j.state === 'running')) return 'running';
  if (jobs.length && jobs.every(j => j.state === 'failed')) return 'failed';
  if (jobs.some(j => j.state === 'done')) return 'done';
  return 'idle';
}

async function poll(){
  try {
    const d = await (await fetch('/api/status')).json();
    workers = d.workers || [];
    document.getElementById('updated').textContent = 'updated ' + new Date(d.generatedAt).toLocaleTimeString();
  } catch(e){ /* keep last frame */ }
}

function draw(t){
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  // floor grid
  ctx.strokeStyle = '#161b22'; ctx.lineWidth = 1*dpr;
  const grid = 40*dpr;
  for (let x=0; x<W; x+=grid){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y=0; y<H; y+=grid){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  const n = workers.length || 1;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cw = W / cols, ch = H / rows;

  workers.forEach((w, i) => {
    const cx = (i % cols) * cw + cw/2;
    const cy = Math.floor(i / cols) * ch + ch/2;
    const st = stateOf(w);
    const color = COLORS[st];
    const deskW = Math.min(cw, ch) * 0.5;
    const deskH = deskW * 0.55;

    // desk
    ctx.fillStyle = '#1c2230';
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 2*dpr;
    roundRect(cx - deskW/2, cy + deskH*0.2, deskW, deskH*0.7, 6*dpr);
    ctx.fill(); ctx.stroke();

    // activity ring (pulses when running/stalled)
    const pulsing = st === 'running' || st === 'stalled';
    const pulse = pulsing ? (0.5 + 0.5*Math.sin(t/300)) : 1;
    const r = Math.min(cw,ch) * 0.13;
    ctx.beginPath();
    ctx.arc(cx, cy - deskH*0.2, r + (pulsing? r*0.5*pulse : 0), 0, Math.PI*2);
    ctx.fillStyle = hexA(color, pulsing ? 0.12 + 0.12*pulse : 0.12);
    ctx.fill();

    // avatar head
    ctx.beginPath();
    ctx.arc(cx, cy - deskH*0.2, r, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();

    // name + state
    ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'center';
    ctx.font = (13*dpr)+'px ui-monospace, monospace';
    ctx.fillText(w.name, cx, cy + deskH*1.25);
    ctx.fillStyle = color; ctx.font = (11*dpr)+'px ui-monospace, monospace';
    const jobCount = (w.jobs||[]).length;
    ctx.fillText(st + (jobCount? ' · '+jobCount+' job'+(jobCount===1?'':'s') : ''), cx, cy + deskH*1.25 + 16*dpr);

    // health dot
    ctx.beginPath();
    ctx.arc(cx + deskW/2 - 6*dpr, cy + deskH*0.3, 4*dpr, 0, Math.PI*2);
    ctx.fillStyle = w.healthy === true ? '#22c55e' : w.healthy === false ? '#ef4444' : '#6e7681';
    ctx.fill();
  });
  requestAnimationFrame(draw);
}

function roundRect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
}
function hexA(hex, a){
  const n = parseInt(hex.slice(1),16);
  return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';
}

poll();
setInterval(poll, 2000);
requestAnimationFrame(draw);
</script>
</body>
</html>`;
}
