param(
  [ValidateSet("claude", "codex", "gemini")]
  [string]$AgentId = "claude",

  [ValidateSet("login", "session", "status")]
  [string]$Mode = "session"
)

$ErrorActionPreference = "Stop"

$workflowRoot = Resolve-Path $PSScriptRoot
$projectRoot = Resolve-Path (Join-Path $workflowRoot "..")
$configPath = Join-Path $workflowRoot "config.json"

function Resolve-AgentCommand {
  param([string]$Command)

  $found = Get-Command $Command -ErrorAction SilentlyContinue
  if ($found) {
    return $found.Source
  }

  if (Test-Path $Command) {
    return (Resolve-Path $Command).Path
  }

  $extensions = @(".exe", ".cmd", ".ps1", ".bat", "")
  foreach ($folder in ($env:PATH -split ";")) {
    if (-not $folder) {
      continue
    }

    foreach ($extension in $extensions) {
      $candidate = Join-Path $folder "$Command$extension"
      if (Test-Path $candidate) {
        return (Resolve-Path $candidate).Path
      }
    }
  }

  return $null
}

if (-not (Test-Path $configPath)) {
  throw "Missing config: $configPath"
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$agent = $config.agents.$AgentId
if (-not $agent) {
  throw "Unknown agent: $AgentId"
}

$targetProject = $config.targetProjectPath
if (-not $targetProject) {
  $targetProject = $projectRoot.Path
}

if (-not (Test-Path $targetProject -PathType Container)) {
  throw "Target project folder does not exist: $targetProject"
}

$targetProject = (Resolve-Path $targetProject).Path
Set-Location $targetProject

$argsToUse = @()
if ($Mode -eq "login") {
  $argsToUse = @($agent.loginArgs)
} elseif ($Mode -eq "status") {
  $argsToUse = @($agent.statusArgs)
} else {
  $argsToUse = @($agent.sessionArgs)
}

Write-Host "$($agent.label) - $Mode"
Write-Host "Role: $($agent.role)"
Write-Host "Command: $($agent.command) $($argsToUse -join ' ')"
Write-Host "Target project: $targetProject"
Write-Host ""

$resolvedCommand = Resolve-AgentCommand $agent.command
if (-not $resolvedCommand) {
  Write-Host "Command not found in this PowerShell session: $($agent.command)"
  Write-Host "Update the command path in the web interface, then retry."
  exit 1
}

& $resolvedCommand @argsToUse
