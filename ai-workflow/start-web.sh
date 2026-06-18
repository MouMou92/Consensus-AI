#!/usr/bin/env bash
# Lanceur multiplateforme (macOS / Linux) de l'interface Consensus IA.
# Equivalent de start-web.ps1 pour Windows.
set -euo pipefail

PORT="${1:-8765}"

# Se placer a la racine du projet (parent de ai-workflow/)
cd "$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js est requis. Installe Node.js (>=18) puis relance ce script." >&2
  exit 1
fi

export AI_WORKFLOW_PORT="$PORT"

echo "Demarrage de l'interface Consensus IA"
echo "Projet : $(pwd)"
echo "URL    : http://localhost:${PORT}"
echo ""
node ai-workflow/web/server.js
