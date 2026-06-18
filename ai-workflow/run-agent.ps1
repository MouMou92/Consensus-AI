param(
  [ValidateSet("claude-architecture", "codex-analysis", "codex-implementation", "gemini-review", "claude-final")]
  [string]$Step = "claude-architecture"
)

$ErrorActionPreference = "Stop"

$workflowRoot = Resolve-Path $PSScriptRoot
$projectRoot = Resolve-Path (Join-Path $workflowRoot "..")
$configPath = Join-Path $workflowRoot "config.json"
$promptOut = Join-Path $workflowRoot "99-active-agent-prompt.md"

if (-not (Test-Path $configPath)) {
  throw "Missing config: $configPath"
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$targetProject = $config.targetProjectPath
if (-not $targetProject) {
  $targetProject = $projectRoot.Path
}

if (-not (Test-Path $targetProject -PathType Container)) {
  throw "Target project folder does not exist: $targetProject"
}

$targetProject = (Resolve-Path $targetProject).Path

$agent = switch ($Step) {
  "claude-architecture" { "claude" }
  "codex-analysis" { "codex" }
  "codex-implementation" { "codex" }
  "gemini-review" { "gemini" }
  "claude-final" { "claude" }
}

$rolePrompt = switch ($Step) {
  "claude-architecture" { Join-Path $workflowRoot "prompts\claude.md" }
  "codex-analysis" { Join-Path $workflowRoot "prompts\codex.md" }
  "codex-implementation" { Join-Path $workflowRoot "prompts\codex.md" }
  "gemini-review" { Join-Path $workflowRoot "prompts\gemini.md" }
  "claude-final" { Join-Path $workflowRoot "prompts\final.md" }
}

$instructionPath = Join-Path $workflowRoot "00-user-instructions.md"
$scanPath = Join-Path $workflowRoot "00-project-scan.md"

$stepGoal = switch ($Step) {
  "claude-architecture" { "Avis Claude : analyser la qualite globale du code en lecture seule et ecrire le fichier Claude." }
  "codex-analysis" { "Avis Codex : analyser la qualite technique du code en lecture seule et ecrire le fichier Codex." }
  "codex-implementation" { "Avis Codex : analyser la qualite technique du code en lecture seule et ecrire le fichier Codex." }
  "gemini-review" { "Avis Gemini : auditer securite, UX, performance et risques en lecture seule puis ecrire le rapport Gemini." }
  "claude-final" { "Consensus : comparer les avis Claude, Codex et Gemini puis ecrire une synthese de qualite du code." }
}

$agentConfig = $config.agents.$agent
if (-not $agentConfig) {
  throw "Missing agent config for $agent"
}

$composed = @"
# Prompt Compose - $Step

Tu travailles dans le dossier projet cible :

~~~text
$targetProject
~~~

Le dossier de coordination Consensus IA est :

~~~text
$($projectRoot.Path)
~~~

## Fichiers De Sortie A Utiliser

- Instructions utilisateur : $instructionPath
- Scan projet : $scanPath
- Architecture Claude : $(Join-Path $workflowRoot "01-claude-architecture.md")
- Analyse Codex read-only : $(Join-Path $workflowRoot "02-codex-implementation.md")
- Rapport Gemini : $(Join-Path $workflowRoot "03-gemini-review.md")
- Consensus qualite : $(Join-Path $workflowRoot "04-decisions-finales.md")

N'ecris pas ces fichiers dans un nouveau dossier du projet cible. Utilise les chemins ci-dessus.

## Objectif De Cette Session

$stepGoal

## Regles Non Negociables

- Avant analyse, verifier `git status --short --branch`.
- Ne jamais supprimer de fichier sans confirmation explicite.
- Politique d'ecriture : lecture seule sur le projet cible pour toutes les IA.
- Pour cette etape : lecture seule sur le projet cible ; ne modifie aucun fichier applicatif du projet.
- Sauvegarder le resultat dans les fichiers Markdown du dossier de coordination.

## Prompt De Role

$(Get-Content $rolePrompt -Raw)

## Instructions Utilisateur

$(Get-Content $instructionPath -Raw)

## Scan Projet

$(Get-Content $scanPath -Raw)

"@

Set-Content -Path $promptOut -Value $composed -Encoding UTF8

try {
  Set-Clipboard -Value $composed
  $clipboardMessage = "Prompt copied to clipboard."
} catch {
  $clipboardMessage = "Clipboard unavailable. Open ai-workflow\99-active-agent-prompt.md manually."
}

Set-Location $targetProject

Write-Host "Consensus IA step: $Step"
Write-Host "Agent command: $($agentConfig.command)"
Write-Host "Target project: $targetProject"
Write-Host "Prompt file: $promptOut"
Write-Host $clipboardMessage
Write-Host ""
Write-Host "Git status in target project:"
git status --short --branch
Write-Host ""
Write-Host "Paste the copied prompt into the agent if it does not read stdin automatically."
Write-Host ""

$sessionArgs = @($agentConfig.sessionArgs)
if (Get-Command $agentConfig.command -ErrorAction SilentlyContinue) {
  & $agentConfig.command @sessionArgs
} else {
  Write-Host "Command '$($agentConfig.command)' not found in this PowerShell session."
  Write-Host "Open the tool manually in the target folder and paste the prompt from clipboard."
}
