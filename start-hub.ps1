# ben-terminal Hub auto-start launcher (idempotent)
# Started by Windows Task Scheduler at logon. Safe to run manually too.

$ErrorActionPreference = "SilentlyContinue"
$hubDir   = "C:\Users\USER\gt\ben-terminal"
$nodeExe  = "C:\Program Files\nodejs\node.exe"
$cfg      = "agents.config.json"
$hubPort  = 4099   # dashboard (chat + status); the Hub binds this last
$logFile  = Join-Path $hubDir "hub-autostart.log"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "$ts  $msg"
}

# Already up? bail out so we never double-bind the dashboard port.
$inUse = Get-NetTCPConnection -LocalPort $hubPort -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
    Log "Hub already listening on $hubPort (PID $($inUse.OwningProcess)) - skip start."
    exit 0
}

Set-Location $hubDir
Log "Starting hub: $nodeExe dist\hub.js $cfg"
Start-Process -FilePath $nodeExe `
    -ArgumentList "dist\hub.js", $cfg `
    -WorkingDirectory $hubDir `
    -WindowStyle Hidden

# hub.js binds the dashboard port only AFTER waitForWorkers (can take up to ~60s
# on a cold start while 11 opencode workers come up). Poll up to 90s before warning.
$bound = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $check = Get-NetTCPConnection -LocalPort $hubPort -State Listen -ErrorAction SilentlyContinue
    if ($check) {
        Log "Hub started OK on $hubPort (PID $($check.OwningProcess)) after ~$($i*2)s."
        $bound = $true
        break
    }
}
if (-not $bound) { Log "WARN: hub not listening on $hubPort after 90s - check hub.log." }
