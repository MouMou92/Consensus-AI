param(
  [switch]$ClaudeOnly,
  [switch]$CodexOnly,
  [switch]$GeminiOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

function Open-AgentSession {
  param(
    [string]$Title,
    [string]$ScriptName
  )

  $scriptPath = Join-Path $PSScriptRoot $ScriptName
  $argumentList = "-NoExit -ExecutionPolicy Bypass -File `"$scriptPath`""
  Start-Process powershell.exe -ArgumentList $argumentList -WorkingDirectory $projectRoot
}

Write-Host "Project: $projectRoot"
Write-Host ""
Write-Host "Tool availability:"
foreach ($cmd in @("claude", "codex", "gemini", "git", "node")) {
  $found = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($found) {
    Write-Host "  OK  $cmd -> $($found.Source)"
  } else {
    Write-Host "  NO  $cmd"
  }
}

Write-Host ""
git status --short --branch

if ($ClaudeOnly) {
  Open-AgentSession "Claude" "start-claude.ps1"
  exit 0
}

if ($CodexOnly) {
  Open-AgentSession "Codex" "start-codex.ps1"
  exit 0
}

if ($GeminiOnly) {
  Open-AgentSession "Gemini" "start-gemini.ps1"
  exit 0
}

Open-AgentSession "Claude" "start-claude.ps1"
Open-AgentSession "Codex" "start-codex.ps1"
Open-AgentSession "Gemini" "start-gemini.ps1"
