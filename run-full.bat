@echo off
REM ============================================================
REM  Hub launcher - FULL ROSTER (all 11 workers)
REM  Builds the project, then starts the Hub with agents.config.json.
REM  Opens 11 Windows Terminal tabs (opencode serve + attach each)
REM  and the Hub MCP server on http://127.0.0.1:4100/mcp
REM ============================================================
setlocal
cd /d "%~dp0"

echo [hub] Building...
call npm run build
if errorlevel 1 (
  echo [hub] Build failed. Aborting.
  exit /b 1
)

echo [hub] Starting Hub with full roster (11 workers on ports 4101-4111)...
node dist/hub.js agents.config.json

endlocal
