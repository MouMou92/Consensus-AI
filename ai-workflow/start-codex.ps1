$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "run-agent.ps1") -Step "codex-analysis"
