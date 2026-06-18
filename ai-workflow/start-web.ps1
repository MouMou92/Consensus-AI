param(
  [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverPath = Join-Path $PSScriptRoot "web\server.js"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install Node.js or fix PATH, then rerun this script."
}

Set-Location $projectRoot
$env:AI_WORKFLOW_PORT = "$Port"

Write-Host "Starting Consensus IA web interface"
Write-Host "Project: $projectRoot"
Write-Host "URL: http://localhost:$Port"
Write-Host ""
node $serverPath

