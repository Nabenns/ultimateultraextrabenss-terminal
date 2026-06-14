import { startDashboard } from "../dist/dashboard.js";
import { StatusBoard } from "../dist/status-board.js";

const PORT = 4098;
const board = new StatusBoard();
const j1 = board.addJob("frontend", "build the login form");
board.update(j1.id, { state: "running", sessionID: "ses_fe" });
const j2 = board.addJob("backend", "expose /api/login");
board.update(j2.id, { state: "done", sessionID: "ses_be", summary: "endpoint live", remainingTodos: [] });

const health = new Map([["frontend", true], ["backend", true], ["tester", false]]);

const stop = await startDashboard(
  { board, workerNames: ["frontend", "backend", "tester"], health },
  PORT,
);

const api = await fetch(`http://127.0.0.1:${PORT}/api/status`).then((r) => r.json());
const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());

console.log("API summary:", JSON.stringify(api.summary));
console.log("API workers:", api.workers.map((w) => `${w.name}(healthy=${w.healthy},jobs=${w.jobs.length})`).join(", "));
console.log("HTML shell length:", html.length, "starts with doctype:", html.trimStart().toLowerCase().startsWith("<!doctype"));
console.log("RESULT:", api.workers.length === 3 && html.includes("ben-terminal Hub") ? "PASS" : "FAIL");

stop();
setTimeout(() => process.exit(0), 100);
