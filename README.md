# Consensus IA - Audit multi-IA en boucle

Ce dossier est un cockpit local qui fait dialoguer plusieurs IA (Claude Code,
Codex, Gemini CLI, Mistral) sur la qualite d'un projet local. La boucle se
deroule entierement en automatique, depuis l'interface web. Le projet audite
reste en lecture seule.

## Vue d'ensemble

- Chaque IA donne un avis au tour 0.
- A chaque tour suivant, chaque IA lit les avis des autres et revise son
  jugement, jusqu'a declarer **STATUT: ACCORD**.
- La boucle s'arrete des que toutes les IA sont d'accord, ou apres 5 tours.
- Une synthese finale est produite automatiquement par Mistral (API).

## Installation - une seule fois

Toutes les CLI tournent en mode headless (sans fenetre). Il faut juste les
installer et faire le login une bonne fois pour toutes.

### 1. Pre-requis

- Node.js 18+ et npm.
- Git.
- Un compte Anthropic, ChatGPT/OpenAI et Google avec les CLI correspondantes.
- Une cle API Mistral (console.mistral.ai).

### 2. Installer les 3 CLI

Dans une PowerShell **non administrateur** :

```powershell
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g @google/gemini-cli
```

Si une des commandes echoue avec "package not found", la CLI a peut-etre
change de nom : `npm search @google gemini` ou `npm search anthropic claude`
pour retrouver le nom courant.

### 3. Authentifier chaque CLI une seule fois

Toujours dans PowerShell (ces commandes ouvrent un navigateur ou un device
flow) :

```powershell
claude          # ouvre Claude Code et demande de se connecter
codex login
gemini          # ouvre Gemini CLI et demande de se connecter
```

Une fois cette ceremonie faite, **tu ne retournes plus jamais dans
PowerShell**. Les sessions sont persistees par chaque outil.

## Lancer l'interface

Le serveur n'utilise que des modules Node natifs : aucun `npm install` n'est
necessaire. Depuis la racine du projet (le dossier qui contient ce README) :

**Windows (PowerShell)**

```powershell
.\ai-workflow\start-web.ps1
```

**macOS / Linux**

```bash
bash ai-workflow/start-web.sh
```

**Multiplateforme (npm)**

```bash
npm start
```

Puis ouvrir <http://localhost:8765>. Au premier lancement, un assistant
**« Connecter les IA »** s'ouvre et te guide : il detecte chaque CLI, te donne
les commandes d'installation / de connexion a copier, et verifie l'etat. Il
faut au moins 2 IA pretes pour lancer une boucle.

> Configuration : au premier demarrage, l'app utilise des reglages par defaut.
> Pour personnaliser, copie `ai-workflow/config.example.json` en
> `ai-workflow/config.json` (ignore par Git, propre a ta machine). De meme,
> copie `ai-workflow/.env.example` en `ai-workflow/.env` pour ta cle Mistral
> (ou saisis-la dans l'interface).

## Premier audit

1. Cliquer `Parcourir` pour choisir le dossier projet a auditer.
2. Coller ta cle API Mistral dans la carte Mistral, cliquer `Sauver cle`.
3. Verifier que chaque agent est marque `Pret` (sinon cliquer `Tester` et
   suivre l'indication). Au minimum 2 agents doivent etre Pret.
4. Decocher les agents que tu ne veux pas dans la boucle.
5. Ecrire la question d'audit dans le panneau central.
6. Cliquer `Lancer l'audit en boucle`.

L'interface affiche le tour courant, le statut REVISE/ACCORD/ERROR de chaque
agent, et met a jour les panneaux Claude/Codex/Gemini/Mistral au fur et a
mesure. Le panneau Consensus apparait quand la boucle est terminee.

## Fichiers produits

```
ai-workflow/
  00-project-scan.md         # scan du projet (regenere a chaque audit)
  00-user-instructions.md    # ta question
  04-decisions-finales.md    # consensus final
  iterations-state.json      # etat de la boucle
  iterations/
    round-0/
      claude.md
      codex.md
      gemini.md
      mistral.md
    round-1/
      ...
  .env                       # cle API Mistral (jamais commitee)
```

## Securite

- Le projet audite n'est jamais modifie : tous les agents tournent en lecture
  seule.
- La cle API Mistral est stockee dans `ai-workflow/.env`, ignore par Git.
- Le serveur web ecoute uniquement sur 127.0.0.1.

## Configuration avancee

`ai-workflow/config.json` controle :

- `maxRounds` : nombre de tours maximum (5 par defaut).
- `minAgents` : nombre minimum d'agents disponibles pour autoriser la boucle.
- Pour chaque agent : `command`, `args`, `stdinMode`, `timeoutMs`, `enabled`.

Si une des CLI utilise un autre nom de commande chez toi, ajuste
`agents.<id>.command`. Si le mode print s'appelle `--print` au lieu de `-p`,
modifie `args`.

## Depannage

| Symptome | Cause probable | Action |
|---|---|---|
| Carte Claude `CLI introuvable` | npm global pas dans le PATH du shell qui a lance `start-web.ps1` | Fermer la fenetre du serveur, ouvrir une PS fraiche, relancer `start-web.ps1` |
| Mistral `Cle manquante` | Cle pas encore saisie | Coller la cle dans la carte Mistral et cliquer `Sauver cle` |
| Tour 0 `ERROR` sur une CLI | Pas authentifie | Relancer la commande de login une seule fois en PS |
| Boucle bloquee a `En cours` | Une CLI attend une saisie | Verifier que `args` et `stdinMode` sont coherents dans config.json |
| Tous les agents `REVISE` au tour 5 | Pas de convergence | Lire le consensus final (Mistral arbitre) ou augmenter `maxRounds` |
