@echo off
REM ============================================================
REM  Hub launcher - SMOKE TEST (single frontend worker)
REM  Builds the project, then starts the Hub with agents.smoke.json.
REM  Opens 1 Windows Terminal tab (opencode serve + attach) and
REM  the Hub MCP server on http://127.0.0.1:4100/mcp
REM ============================================================
setlocal
cd /d "%~dp0"

echo [hub] Building...
call npm run build
if errorlevel 1 (
  echo [hub] Build failed. Aborting.
  exit /b 1
)

echo [hub] Starting Hub with smoke config (1 worker: frontend on 4106)...
node dist/hub.js agents.smoke.json

endlocal
