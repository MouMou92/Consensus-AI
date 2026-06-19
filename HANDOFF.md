# HANDOFF — Projet "Consensus IA"

_Dernière mise à jour : 2026-06-19_

## Quoi
Outil web local Node (zéro dépendance externe) qui fait débattre 4 IA en boucle
(Claude Code, Codex, **Antigravity** `agy`, Mistral API) sur un projet ou une idée,
jusqu'au consensus, puis génère une synthèse. UI = "table ronde" sombre.

## Emplacements
- CODE (le vrai outil) : `C:\Users\DSM-Consult\Documents\Consensus-IA - Claude\00 - CONCENSUS-IA`
- Lancement : `.\ai-workflow\start-web.ps1` (ou `npm start`) → http://localhost:8765
- Fichiers clés : `ai-workflow/web/{server.js, providers.js, app.js, index.html, styles.css}`, `ai-workflow/config.json` (local, ignoré git)
- GitHub : https://github.com/MouMou92/Consensus-AI (PRIVÉ, nom réel "Consensus-AI")
- NE PAS confondre avec `C:\Users\DSM-Consult\Desktop\GLOBAL\04_Consensus-IA` = autre dossier (vieux outputs d'audit), PAS le repo.

## Les 4 sièges
- **Claude Code** (`claude -p`, stdin) — architecture / qualité.
- **Codex** (`codex exec -c model_reasoning_effort="medium" --skip-git-repo-check`, stdin) — qualité dev. Reasoning forcé à `medium` car le profil utilisateur est en `xhigh` (très lent → timeouts). Timeout 300 s.
- **Antigravity** (`agy`, binaire Go) — siège "Google". L'id interne reste `gemini` (pour ne pas casser la table ronde à 4 ni les fichiers de tours) mais le label/logo/rôle disent "Antigravity". Chemin absolu figé : `C:\Users\DSM-Consult\AppData\Local\agy\bin\agy.exe`.
- **Mistral** (API) — synthétiseur final par défaut.

## État (fait et vérifié)
- **RÉSOLU — Gemini → Antigravity.** La Gemini CLI a perdu son tier gratuit OAuth (18/06/2026). Le siège "Google" fait maintenant tourner Antigravity (`agy`), avec 3 spécificités gérées dans `providers.callCliHeadless` :
  1. **Prompt en argument** (`promptMode: "arg"`) : `agy -p` EXIGE la valeur en argument et ne lit pas stdin.
  2. **Capture par fichier** (`captureMode: "file"`) : `agy -p` a un bug "stdout vide en non-TTY" (pipe). Contournement = on lui demande d'écrire sa réponse dans un fichier temp (via `--add-dir` + `--dangerously-skip-permissions`) et le serveur relit ce fichier. Couvre tous les tours.
  3. **Gros prompts** : au-delà de ~28 Ko (limite ligne de commande Windows), le prompt est écrit dans un fichier temp et référencé via `@fichier`.
- **Mistral reparle** : `consensusAgent: "mistral"` (modifiable via le menu "Synthèse par"). Avant il était muet car synthesisOnly + consensusAgent=claude → jamais appelé.
- **Fallback synthèse** (`runFinalConsensus` + `orderedConsensusCandidates`) : l'agent de synthèse choisi est essayé en premier ; s'il échoue (erreur OU sortie vide), bascule auto selon l'ordre claude → codex → antigravity → mistral. La boucle de débat continue tant qu'il reste ≥ 2 agents (un siège en échec ne bloque rien).
- **Injection des clés** : `process.env` (chargé depuis `.env` au démarrage) + `agent.env` sont passés aux CLI. `GEMINI_API_KEY` / `ANTIGRAVITY_API_KEY` arrivent donc jusqu'à `agy`. Voir `.env.example`.
- **Auto-découverte** du binaire `agy` hors PATH (dont `%LOCALAPPDATA%\agy\bin`).
- Distribuable à jour : `.gitignore`, `config.example.json`, `.env.example`, README.

## Décisions clés
- Modèle = self-host distribuable (on GARDE les CLI, aucune donnée du proprio). Pas de SaaS central.
- Siège "Google" = Antigravity (`agy`), pas la Gemini CLI (tier gratuit mort).
- **Plan B Antigravity** si `agy` redevient inutilisable en headless : dans `config.json`, remettre `agents.gemini.command = "gemini"` (+ `args: ["-p"]`, `promptMode`/`captureMode` retirés ou `stdin`/`stdout`) et ajouter une `GEMINI_API_KEY` (AI Studio) dans `ai-workflow/.env`. La Gemini CLI classique n'a pas le bug TTY.

## Pièges connus
- **`agy -p` non-TTY** : renvoie une sortie vide quand lancé en pipe (sans vrai terminal). D'où la capture par fichier. Pas de pseudo-TTY sur Windows sans dépendance native → on ne va pas par là.
- **Codex `xhigh`** : profil utilisateur très lent → timeouts. On force `medium` via `-c`.
- **PowerShell** ne supporte pas `&&` → lancer git add / commit / push sur 3 lignes séparées.
- **`.git/index.lock` fantôme** : si `git add`/`commit` répond "Unable to create index.lock / Another git process seems to be running" et que `git push` dit "up-to-date" (= rien n'a été committé), supprimer le verrou : `Remove-Item ".git\index.lock" -Force` puis refaire add/commit/push.
- **Montage périmé** : l'environnement de l'assistant voit parfois une copie tronquée des fichiers fraîchement édités → vérifs via lecture hôte ; les fichiers réels sont OK.
- Le dépôt git PARENT (`Documents\Consensus-IA - Claude`) a un index corrompu → le vrai repo est le dépôt NEUF dans `00 - CONCENSUS-IA`.

## Réflexe publication
```
git add .
git commit -m "..."
git push
```
(3 lignes, PowerShell. Si "index.lock" : `Remove-Item ".git\index.lock" -Force` d'abord.)
