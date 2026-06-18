param(
  [string]$ProjectPath = "",
  [string]$BranchName = "",
  [string]$CommitMessage = "backup: before ai workflow change"
)

$ErrorActionPreference = "Stop"

function Run-Git {
  param([string[]]$Args)
  & git @Args
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Args -join ' ') failed"
  }
}

$workflowRoot = Resolve-Path $PSScriptRoot
$configPath = Join-Path $workflowRoot "config.json"

if (-not $ProjectPath -and (Test-Path $configPath)) {
  $config = Get-Content $configPath -Raw | ConvertFrom-Json
  $ProjectPath = $config.targetProjectPath
  if (-not $BranchName) {
    $BranchName = $config.branchName
  }
}

if (-not $ProjectPath) {
  $ProjectPath = (Resolve-Path (Join-Path $workflowRoot "..")).Path
}

if (-not $BranchName) {
  $BranchName = "ai/project-loop"
}

$targetProject = Resolve-Path $ProjectPath
Set-Location $targetProject

Write-Host "Project: $targetProject"
Write-Host ""
Write-Host "Git status:"
& git status --short --branch

if ($LASTEXITCODE -ne 0) {
  throw "This folder is not a valid Git repository."
}

$currentBranch = (& git branch --show-current).Trim()
if (-not $currentBranch) {
  $currentBranch = "HEAD"
}

if ($currentBranch -ne $BranchName) {
  & git show-ref --verify --quiet "refs/heads/$BranchName"
  if ($LASTEXITCODE -eq 0) {
    Run-Git @("switch", $BranchName)
  } else {
    Run-Git @("switch", "-c", $BranchName)
  }
}

$status = (& git status --short)
if (-not $status) {
  Write-Host "No changes to commit."
  exit 0
}

$deletions = $status | Where-Object { $_ -match "^\s*D|^D" }
if ($deletions) {
  Write-Host "Deletion detected. Backup commit aborted until deletions are explicitly confirmed."
  $deletions | ForEach-Object { Write-Host $_ }
  exit 2
}

Run-Git @("add", "-A")
& git commit -m $CommitMessage
if ($LASTEXITCODE -ne 0) {
  Write-Host "Commit did not complete. Check Git user.name/user.email or staged content."
  exit $LASTEXITCODE
}

Write-Host "Backup commit created."
