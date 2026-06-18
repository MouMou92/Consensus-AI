"use strict";

const http = require("http");
const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const providers = require("./providers");

const webRoot = __dirname;
const projectRoot = path.resolve(__dirname, "..", "..");
const workflowRoot = path.join(projectRoot, "ai-workflow");
const port = Number(process.env.AI_WORKFLOW_PORT || 8765);

const configPath = path.join(workflowRoot, "config.json");
const instructionsPath = path.join(workflowRoot, "00-user-instructions.md");
const scanPath = path.join(workflowRoot, "00-project-scan.md");
const activePromptPath = path.join(workflowRoot, "99-active-agent-prompt.md");
const iterationsRoot = path.join(workflowRoot, "iterations");
const iterationStatePath = path.join(workflowRoot, "iterations-state.json");
const envPath = path.join(workflowRoot, ".env");
const finalPath = path.join(workflowRoot, "04-decisions-finales.md");
const promptsDir = path.join(workflowRoot, "prompts");
// Chat sandbox lives in the OS temp dir to be far from any project (no .git, no
// package.json, no source tree). CLIs that auto-detect a project root from cwd
// will find nothing here.
const chatSandboxDir = path.join(os.tmpdir(), "consensus-ia-chat-sandbox");

const agentOrder = ["claude", "codex", "gemini", "mistral"];

// Aide a la connexion (assistant premier lancement). Commandes a copier-coller.
// Les identifiants restent sur la machine de l'utilisateur : ces CLI se loguent
// chacune avec le compte de l'utilisateur, jamais via le serveur.
const AGENT_SETUP = {
  claude: {
    installCmd: "npm install -g @anthropic-ai/claude-code",
    loginCmd: "claude",
    loginNote: "Lance `claude` une fois dans un terminal et suis l'invite de connexion.",
    docUrl: "https://docs.claude.com/claude-code"
  },
  codex: {
    installCmd: "npm install -g @openai/codex",
    loginCmd: "codex login",
    loginNote: "Lance `codex login` et connecte ton compte ChatGPT/OpenAI.",
    docUrl: "https://github.com/openai/codex"
  },
  gemini: {
    installCmd: "npm install -g @google/gemini-cli",
    loginCmd: "gemini",
    loginNote: "Lance `gemini` une fois pour faire l'authentification Google (OAuth).",
    docUrl: "https://github.com/google-gemini/gemini-cli"
  },
  mistral: {
    keyNote: "Cree une cle API (offre gratuite possible) sur la console Mistral, puis colle-la ci-dessus.",
    docUrl: "https://console.mistral.ai/api-keys/"
  }
};

const finalResultFile = "ai-workflow/04-decisions-finales.md";

const editableFiles = [
  "ai-workflow/00-user-instructions.md",
  "ai-workflow/00-project-scan.md",
  "ai-workflow/04-decisions-finales.md",
  "ai-workflow/05-todo.md",
  "ai-workflow/99-active-agent-prompt.md",
  "ai-workflow/prompts/claude.md",
  "ai-workflow/prompts/codex.md",
  "ai-workflow/prompts/gemini.md",
  "ai-workflow/prompts/mistral.md",
  "ai-workflow/prompts/final.md",
  "ai-workflow/config.json",
  "README.md"
];

const excludedDirs = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt",
  "coverage", ".cache", ".turbo", ".parcel-cache", ".venv", "venv",
  "__pycache__", "target", "vendor", "bin", "obj", "iterations"
]);

const textExtensions = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".md", ".txt",
  ".html", ".css", ".scss", ".sass", ".py", ".ps1", ".yml", ".yaml",
  ".toml", ".ini", ".example", ".gitignore"
]);

const generatedWorkflowFiles = new Set([
  "ai-workflow/00-project-scan.md",
  "ai-workflow/99-active-agent-prompt.md"
]);

const sensitiveBasenames = new Set([".env", ".env.local", ".env.production", "secrets.json", "credentials.json"]);

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function decodeQueryPath(value) {
  const raw = String(value || "").trim();
  return raw ? path.resolve(raw) : "";
}

function nowIso() {
  return new Date().toISOString();
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function exec(command, args, options = {}) {
  return new Promise(resolve => {
    try {
      execFile(command, args, {
        cwd: options.cwd || projectRoot,
        windowsHide: true,
        timeout: options.timeout || 15000
      }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          message: error ? error.message : ""
        });
      });
    } catch (error) {
      resolve({ ok: false, code: 1, stdout: "", stderr: "", message: error.message });
    }
  });
}

function gitOutput(result) {
  return result.stdout || result.stderr || result.message || "";
}

function gitStatus(cwd) {
  return exec("git", ["status", "--short", "--branch"], { cwd });
}

function gitBranch(cwd) {
  return exec("git", ["branch", "--show-current"], { cwd });
}

function normalizeWorkspacePath(inputPath) {
  const normalized = String(inputPath || "").replace(/\\/g, "/");
  if (!editableFiles.includes(normalized)) {
    throw new Error("File is not editable from this interface.");
  }
  const resolved = path.resolve(projectRoot, normalized);
  if (!resolved.startsWith(projectRoot + path.sep)) {
    throw new Error("Invalid path.");
  }
  return { normalized, resolved };
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function defaultConfig() {
  return {
    targetProjectPath: projectRoot,
    branchName: "ai/project-loop",
    lastScanAt: null,
    writePolicy: "read-only",
    maxRounds: 5,
    minAgents: 2,
    // true = Mistral ne participe pas aux tours de debat (economie de quota),
    // mais reste utilise pour la synthese finale via pickConsensusAgent.
    mistralSynthesisOnly: true,
    agents: {
      claude: {
        label: "Claude Code",
        role: "Architecture et qualite globale",
        type: "cli-headless",
        command: "claude",
        args: ["-p"],
        stdinMode: true,
        timeoutMs: 300000,
        enabled: true
      },
      codex: {
        label: "Codex",
        role: "Qualite developpeur et maintenabilite",
        type: "cli-headless",
        command: "codex",
        args: ["exec"],
        stdinMode: true,
        timeoutMs: 300000,
        enabled: true
      },
      gemini: {
        label: "Gemini CLI",
        role: "Audit securite, performance et UX",
        type: "cli-headless",
        command: "gemini",
        args: ["-p"],
        stdinMode: true,
        timeoutMs: 300000,
        enabled: true
      },
      mistral: {
        label: "Mistral",
        role: "Avis complementaire et synthese finale (API)",
        type: "api",
        provider: "mistral",
        model: "mistral-large-latest",
        endpoint: "https://api.mistral.ai/v1/chat/completions",
        timeoutMs: 120000,
        enabled: true
      }
    },
    scan: {
      maxFiles: 500,
      maxContentFiles: 60,
      maxFileBytes: 12000,
      maxTotalBytes: 180000
    }
  };
}

function mergeAgents(agents = {}) {
  const defaults = defaultConfig().agents;
  return Object.fromEntries(Object.entries(defaults).map(([id, defaultForAgent]) => [
    id,
    { ...defaultForAgent, ...(agents[id] || {}) }
  ]));
}

async function readConfig() {
  if (!(await fileExists(configPath))) {
    return defaultConfig();
  }
  const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
  return {
    ...defaultConfig(),
    ...parsed,
    agents: mergeAgents(parsed.agents),
    scan: { ...defaultConfig().scan, ...(parsed.scan || {}) }
  };
}

async function writeConfig(config) {
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function sanitizeAgents(agents) {
  const defaults = defaultConfig().agents;
  const next = {};
  for (const id of Object.keys(defaults)) {
    const source = agents && agents[id] ? agents[id] : {};
    const merged = { ...defaults[id], ...source };
    merged.enabled = source.enabled === undefined ? defaults[id].enabled : Boolean(source.enabled);
    if (merged.type === "cli-headless") {
      merged.args = Array.isArray(source.args) ? source.args.map(item => String(item)) : defaults[id].args;
      merged.command = String(source.command || defaults[id].command || id).trim();
      merged.stdinMode = source.stdinMode === undefined ? defaults[id].stdinMode : Boolean(source.stdinMode);
    }
    next[id] = merged;
  }
  return next;
}

// ---------------------------------------------------------------------------
// env (Mistral key)
// ---------------------------------------------------------------------------

function loadEnvKeys() {
  return providers.loadEnv(envPath);
}

function loadMistralKey() {
  const env = loadEnvKeys();
  return env.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || "";
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function setMistralKey(key) {
  const env = loadEnvKeys();
  if (key) {
    env.MISTRAL_API_KEY = key;
  } else {
    delete env.MISTRAL_API_KEY;
  }
  providers.saveEnv(envPath, env);
  process.env.MISTRAL_API_KEY = key || "";
}

// ---------------------------------------------------------------------------
// folder browser
// ---------------------------------------------------------------------------

async function listFolder(folderPathInput) {
  if (!folderPathInput) {
    if (process.platform === "win32") {
      const candidates = [
        process.env.SystemDrive ? `${process.env.SystemDrive}\\` : "",
        process.env.HOMEDRIVE ? `${process.env.HOMEDRIVE}\\` : "",
        process.env.USERPROFILE || "",
        projectRoot,
        path.parse(projectRoot).root
      ].filter(Boolean);
      const unique = [...new Set(candidates.map(item => path.resolve(item)))];
      const roots = unique.map(item => ({
        name: item === path.parse(item).root ? item : path.basename(item) || item,
        path: item
      }));
      return { path: "", parent: "", entries: roots };
    }
    return { path: "/", parent: "", entries: [{ name: "/", path: "/" }] };
  }

  const resolved = path.resolve(folderPathInput);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Selected path is not a folder.");
  }

  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  const folders = entries
    .filter(entry => entry.isDirectory())
    .filter(entry => !["$Recycle.Bin", "System Volume Information"].includes(entry.name))
    .map(entry => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parsed = path.parse(resolved);
  const parent = resolved === parsed.root ? "" : path.dirname(resolved);
  return { path: resolved, parent, entries: folders };
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

function shouldSkipDir(name) {
  return excludedDirs.has(name) || name.startsWith(".");
}

function isProbablyTextFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (sensitiveBasenames.has(base) || base.startsWith(".env")) {
    return false;
  }
  const ext = path.extname(base);
  if (textExtensions.has(ext) || textExtensions.has(base)) {
    return true;
  }
  return [
    "dockerfile", "makefile", "package.json", "requirements.txt", "readme.md",
    "vite.config.ts", "next.config.js", "tsconfig.json", "pyproject.toml"
  ].includes(base);
}

function fileScore(file) {
  const rel = file.rel.toLowerCase();
  const base = path.basename(rel);
  let score = 0;
  if (!rel.includes("/")) score += 30;
  if (["readme.md", "package.json", "pyproject.toml", "requirements.txt",
       "vite.config.ts", "vite.config.js", "next.config.js", "tsconfig.json"].includes(base)) {
    score += 80;
  }
  if (rel.startsWith("src/") || rel.startsWith("app/") || rel.startsWith("pages/") || rel.startsWith("components/")) {
    score += 40;
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".py"].includes(path.extname(base))) score += 20;
  if (generatedWorkflowFiles.has(rel)) score -= 200;
  score -= Math.min(file.size / 2000, 20);
  return score;
}

async function collectProjectFiles(rootPath, maxFiles) {
  const files = [];
  let truncated = false;

  async function walk(dir, depth) {
    if (files.length >= maxFiles || depth > 8) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isDirectory() && shouldSkipDir(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(rootPath, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = await fsp.stat(absolute);
      } catch {
        continue;
      }
      files.push({ rel, absolute, size: stat.size });
    }
  }

  await walk(rootPath, 0);
  return { files, truncated };
}

async function scanProject(config) {
  const targetPath = path.resolve(config.targetProjectPath || projectRoot);
  const stat = await fsp.stat(targetPath);
  if (!stat.isDirectory()) {
    throw new Error("Target project path must be a folder.");
  }
  const scanConfig = { ...defaultConfig().scan, ...(config.scan || {}) };
  const { files, truncated } = await collectProjectFiles(targetPath, scanConfig.maxFiles);
  const gitStatusResult = await gitStatus(targetPath);
  const branchResult = await gitBranch(targetPath);

  const treeLines = files.map(file => `- ${file.rel} (${file.size} bytes)`);
  const contentCandidates = files
    .filter(file => isProbablyTextFile(file.absolute))
    .sort((a, b) => fileScore(b) - fileScore(a));

  const contentBlocks = [];
  let totalBytes = 0;
  for (const file of contentCandidates) {
    if (contentBlocks.length >= scanConfig.maxContentFiles || totalBytes >= scanConfig.maxTotalBytes) break;
    if (file.size > scanConfig.maxFileBytes * 3 || generatedWorkflowFiles.has(file.rel.toLowerCase())) continue;
    let content;
    try {
      content = await fsp.readFile(file.absolute, "utf8");
    } catch {
      continue;
    }
    const clipped = content.slice(0, scanConfig.maxFileBytes);
    totalBytes += Buffer.byteLength(clipped, "utf8");
    contentBlocks.push({ rel: file.rel, clipped, truncated: content.length > clipped.length });
  }

  const now = nowIso();
  const markdown = [
    "# 00 - Project Scan",
    "",
    `- Target project: \`${targetPath}\``,
    `- Scan date: ${now}`,
    `- Files indexed: ${files.length}${truncated ? " (truncated)" : ""}`,
    `- Git branch: ${branchResult.stdout.trim() || "unknown"}`,
    "",
    "## Git Status",
    "",
    "```text",
    gitOutput(gitStatusResult).trim() || "No Git status available.",
    "```",
    "",
    "## File Tree",
    "",
    ...treeLines,
    "",
    "## Selected File Excerpts",
    "",
    ...contentBlocks.flatMap(block => [
      `### ${block.rel}`,
      "",
      "```text",
      block.clipped.trimEnd(),
      block.truncated ? "\n... truncated ..." : "",
      "```",
      ""
    ])
  ].join("\n");

  await fsp.writeFile(scanPath, markdown, "utf8");
  const nextConfig = { ...config, targetProjectPath: targetPath, lastScanAt: now, scan: scanConfig };
  await writeConfig(nextConfig);

  return {
    markdown,
    config: nextConfig,
    output: `Scan complete: ${files.length} files indexed, ${contentBlocks.length} excerpts captured.`
  };
}

// ---------------------------------------------------------------------------
// iterations state
// ---------------------------------------------------------------------------

function emptyIterationState() {
  return {
    running: false,
    finished: false,
    error: "",
    mode: "audit",
    currentRound: -1,
    maxRounds: 5,
    startedAt: null,
    finishedAt: null,
    finalPath: null,
    activeAgents: [],
    rounds: []
  };
}

async function readIterationState() {
  if (!(await fileExists(iterationStatePath))) {
    return emptyIterationState();
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(iterationStatePath, "utf8"));
    return { ...emptyIterationState(), ...parsed };
  } catch {
    return emptyIterationState();
  }
}

async function writeIterationState(state) {
  await fsp.writeFile(iterationStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function parseStatus(text) {
  const match = String(text || "").match(/^STATUT:\s*(ACCORD|REVISE)\s*$/m);
  if (match) {
    return match[1];
  }
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// prompt composition
// ---------------------------------------------------------------------------

async function readPromptRole(agentId) {
  const filePath = path.join(promptsDir, `${agentId}.md`);
  if (!(await fileExists(filePath))) {
    return `# Role ${agentId}\n\n(Prompt manquant pour ${agentId})`;
  }
  return fsp.readFile(filePath, "utf8");
}

async function readInstructions() {
  if (!(await fileExists(instructionsPath))) {
    return "";
  }
  return fsp.readFile(instructionsPath, "utf8");
}

async function readPreviousOpinions(state, roundIndex, agentId) {
  if (roundIndex <= 0) {
    return "";
  }
  const previous = state.rounds[roundIndex - 1];
  if (!previous) {
    return "";
  }
  const blocks = [];
  for (const otherId of state.activeAgents) {
    if (otherId === agentId) continue;
    const info = previous.agents[otherId];
    if (!info || !info.relPath) continue;
    const absolute = path.join(projectRoot, info.relPath);
    if (!(await fileExists(absolute))) continue;
    const content = await fsp.readFile(absolute, "utf8");
    blocks.push(
      `### Avis de ${otherId.toUpperCase()} au tour ${roundIndex - 1} (statut ${info.status || "UNKNOWN"})\n\n${content.trim()}\n`
    );
  }
  if (!blocks.length) {
    return "";
  }
  return `## Avis des autres IA au tour ${roundIndex - 1}\n\n${blocks.join("\n")}\n`;
}

async function composeRoundPrompt(state, config, agentId, roundIndex) {
  const targetPath = path.resolve(config.targetProjectPath || projectRoot);
  const rolePrompt = await readPromptRole(agentId);
  const instructions = await readInstructions();
  const previousOpinions = await readPreviousOpinions(state, roundIndex, agentId);
  const isChatMode = state.mode === "chat";

  const header = isChatMode
    ? `# Consensus IA - Mode CHAT (debat d'idee) - Tour ${roundIndex}

IMPORTANT - A LIRE EN PRIORITE :
- Nous sommes en mode CHAT : il n'y a AUCUN projet, AUCUN dossier et AUCUN code a analyser.
- Le bloc "role" ci-dessous est redige pour un mode AUDIT. IGNORE toute consigne qui parle d'"auditer un projet", de "scan du projet", de citer "fichier:ligne", ou de "lecture seule sur le projet cible" : elles ne s'appliquent PAS ici.
- N'essaie de lire AUCUN fichier et ne fais reference a aucun depot. Conserve uniquement ton ANGLE d'expertise pour debattre.

Tu participes a une discussion entre IA pour aider l'utilisateur a explorer et choisir la meilleure approche pour son idee ou sa question. C'est un debat purement conceptuel.

Tour actuel : ${roundIndex} sur ${state.maxRounds}.
Tu es l'agent : ${agentId.toUpperCase()}.

`
    : `# Audit Consensus IA - Tour ${roundIndex}

Tu travailles en LECTURE SEULE sur le projet cible :

\`\`\`text
${targetPath}
\`\`\`

Tour actuel : ${roundIndex} sur ${state.maxRounds}.
Tu es l'agent : ${agentId.toUpperCase()}.

`;

  const userSectionTitle = isChatMode ? "## Idee a discuter / Question utilisateur" : "## Demande utilisateur";
  const parts = [header, rolePrompt.trim(), "", userSectionTitle, "", instructions.trim() || "(Aucune instruction specifique fournie par l'utilisateur.)", ""];

  if (previousOpinions) {
    parts.push(previousOpinions);
  } else {
    parts.push("## Tour 0", "", "C'est le premier tour. Donne ton avis initial.", "");
  }

  if (!isChatMode) {
    const scan = (await fileExists(scanPath)) ? await fsp.readFile(scanPath, "utf8") : "";
    parts.push("## Contexte projet (scan)", "", scan.trim() || "(Scan absent)", "");
  }

  parts.push("## Rappel du marqueur de fin OBLIGATOIRE", "");
  parts.push("Termine ta reponse par EXACTEMENT l'un de ces deux blocs :");
  parts.push("");
  parts.push("```\n---\nSTATUT: ACCORD\n```");
  parts.push("");
  parts.push("```\n---\nSTATUT: REVISE\nJE_PROPOSE: <2-3 lignes>\n```");
  parts.push("");
  parts.push("Aucun texte apres le marqueur.");

  return parts.join("\n");
}

async function composeFinalPrompt(state, config) {
  const lastRound = state.rounds[state.rounds.length - 1];
  if (!lastRound) {
    throw new Error("No rounds available for final synthesis.");
  }
  const instructions = await readInstructions();
  const isChatMode = state.mode === "chat";
  const rolePrompt = await fsp.readFile(path.join(promptsDir, "final.md"), "utf8").catch(() => "");

  const blocks = [];
  for (const agentId of state.activeAgents) {
    const info = lastRound.agents[agentId];
    if (!info || !info.relPath) continue;
    const absolute = path.join(projectRoot, info.relPath);
    if (!(await fileExists(absolute))) continue;
    const content = await fsp.readFile(absolute, "utf8");
    blocks.push(`### Avis final de ${agentId.toUpperCase()} (statut ${info.status || "UNKNOWN"})\n\n${content.trim()}\n`);
  }

  const parts = [
    `# Synthese finale Consensus IA${isChatMode ? " (Mode chat)" : ""}`,
    ``,
    `Boucle terminee apres ${state.rounds.length} tour(s). Agents impliques : ${state.activeAgents.join(", ")}.`,
    ``,
    rolePrompt.trim(),
    ``,
    isChatMode ? `## Idee a discuter / Question utilisateur` : `## Demande utilisateur`,
    ``,
    instructions.trim() || "(Aucune)",
    ``,
    `## Avis finaux des IA`,
    ``,
    blocks.join("\n"),
    ``
  ];

  if (!isChatMode) {
    const scan = (await fileExists(scanPath)) ? await fsp.readFile(scanPath, "utf8") : "";
    parts.push(`## Contexte projet (scan)`, ``, scan.trim() || "(Absent)", ``);
  }

  parts.push(`Produit maintenant le rapport de consensus final, en francais.`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// loop runner
// ---------------------------------------------------------------------------

let loopBusy = false;
let loopAbortController = null;

async function runOneRound(state, config, roundIndex) {
  const roundDir = path.join(iterationsRoot, `round-${roundIndex}`);
  await fsp.mkdir(roundDir, { recursive: true });

  const roundEntry = {
    index: roundIndex,
    startedAt: nowIso(),
    finishedAt: null,
    agents: {}
  };
  for (const agentId of state.activeAgents) {
    roundEntry.agents[agentId] = { status: "PENDING", relPath: null, error: "" };
  }
  state.rounds[roundIndex] = roundEntry;
  state.currentRound = roundIndex;
  await writeIterationState(state);

  const mistralKey = loadMistralKey();
  const isChatMode = state.mode === "chat";
  const cliCwd = isChatMode ? chatSandboxDir : path.resolve(config.targetProjectPath || projectRoot);

  const tasks = state.activeAgents.map(async agentId => {
    const agent = config.agents[agentId];
    const promptText = await composeRoundPrompt(state, config, agentId, roundIndex);
    const agentRel = `ai-workflow/iterations/round-${roundIndex}/${agentId}.md`;
    const absolutePath = path.join(projectRoot, agentRel);

    // store the composed prompt next to the output for debugging
    const promptFile = path.join(roundDir, `${agentId}.prompt.md`);
    await fsp.writeFile(promptFile, promptText, "utf8");

    const result = await providers.callAgent(agent, promptText, {
      cwd: cliCwd,
      apiKey: agent.provider === "mistral" ? mistralKey : undefined,
      signal: loopAbortController ? loopAbortController.signal : undefined
    });

    let bodyToWrite;
    let status = "ERROR";
    let errorMessage = "";

    if (result.ok && result.output && result.output.trim()) {
      bodyToWrite = result.output.trim() + "\n";
      status = parseStatus(result.output);
      if (status === "UNKNOWN") {
        // be permissive: assume REVISE if status marker is missing
        status = "REVISE";
        bodyToWrite += "\n---\nSTATUT: REVISE\nJE_PROPOSE: (marqueur ajoute automatiquement, l'IA ne l'a pas fourni)\n";
      }
    } else {
      const detail = result.error || "no output";
      bodyToWrite = `# Erreur agent ${agentId} au tour ${roundIndex}\n\n\`\`\`text\n${detail}\n\`\`\`\n`;
      errorMessage = detail;
    }

    await fsp.writeFile(absolutePath, bodyToWrite, "utf8");

    roundEntry.agents[agentId] = {
      status,
      relPath: agentRel,
      error: errorMessage,
      finishedAt: nowIso()
    };
    await writeIterationState(state);
  });

  await Promise.all(tasks);
  roundEntry.finishedAt = nowIso();
  await writeIterationState(state);

  const statuses = state.activeAgents.map(id => roundEntry.agents[id].status);
  const allAccord = statuses.every(s => s === "ACCORD");
  const allErrored = statuses.every(s => s === "ERROR");

  return { allAccord, allErrored };
}

async function pickConsensusAgent(config) {
  // Priority order: explicit consensusAgent if set, otherwise:
  // 1. Mistral (if enabled AND key present)
  // 2. claude > codex > gemini (CLI headless local) - chosen by enabled flag
  const explicit = config.consensusAgent;
  if (explicit && config.agents[explicit] && config.agents[explicit].enabled !== false) {
    const agent = config.agents[explicit];
    const probe = await providers.probeAgent(agent, {
      apiKey: agent.provider === "mistral" ? loadMistralKey() : undefined
    });
    if (probe.ok) {
      return { id: explicit, agent };
    }
  }

  const preferred = ["mistral", "claude", "codex", "gemini"];
  for (const id of preferred) {
    const agent = config.agents[id];
    if (!agent || agent.enabled === false) continue;
    const probe = await providers.probeAgent(agent, {
      apiKey: agent.provider === "mistral" ? loadMistralKey() : undefined
    });
    if (probe.ok) {
      return { id, agent };
    }
  }
  return null;
}

async function runFinalConsensus(state, config) {
  const picked = await pickConsensusAgent(config);
  if (!picked) {
    const fallback = await composeFinalPrompt(state, config);
    await fsp.writeFile(finalPath, `# Consensus brut (aucun agent disponible)\n\nAucune IA n'est disponible pour generer le consensus final.\nLe prompt ci-dessous peut etre execute manuellement :\n\n\`\`\`\n${fallback}\n\`\`\`\n`, "utf8");
    return { ok: false, reason: "Aucun agent disponible pour la synthese." };
  }

  const prompt = await composeFinalPrompt(state, config);
  const result = await providers.callAgent(picked.agent, prompt, {
    cwd: path.resolve(config.targetProjectPath || projectRoot),
    apiKey: picked.agent.provider === "mistral" ? loadMistralKey() : undefined
  });
  if (!result.ok) {
    await fsp.writeFile(finalPath, `# Consensus - echec de generation (${picked.id})\n\n\`\`\`text\n${result.error || "erreur inconnue"}\n\`\`\`\n`, "utf8");
    return { ok: false, reason: `${picked.id} a echoue: ${result.error || "erreur inconnue"}` };
  }
  const header = `<!-- Consensus genere par : ${picked.id} -->\n\n`;
  await fsp.writeFile(finalPath, header + result.output.trim() + "\n", "utf8");
  return { ok: true, agent: picked.id };
}

async function runLoop(options = {}) {
  if (loopBusy) {
    return { ok: false, error: "Loop already running." };
  }
  loopBusy = true;
  loopAbortController = new AbortController();
  const mode = options.mode === "chat" ? "chat" : "audit";

  try {
    const config = await readConfig();
    const enabledAgents = agentOrder.filter(id => config.agents[id] && config.agents[id].enabled !== false);

    // require minimum agents
    const reachableAgents = [];
    for (const id of enabledAgents) {
      const agent = config.agents[id];
      const probe = await providers.probeAgent(agent, {
        apiKey: agent.provider === "mistral" ? loadMistralKey() : undefined
      });
      if (probe.ok) {
        reachableAgents.push(id);
      }
    }

    // Pacing quota : par defaut Mistral ne debat pas a chaque tour, il ne sert
    // qu'a la synthese finale (pickConsensusAgent le re-sonde independamment).
    const synthesisOnly = config.mistralSynthesisOnly !== false;
    const roundAgents = synthesisOnly
      ? reachableAgents.filter(id => id !== "mistral")
      : reachableAgents;

    if (roundAgents.length < (config.minAgents || 2)) {
      throw new Error(`Pas assez d'IA disponibles pour les tours (${roundAgents.length}). Minimum requis : ${config.minAgents || 2}. Verifie les CLI installees${synthesisOnly ? " (Mistral est reserve a la synthese)" : " et la cle Mistral"}.`);
    }

    // Clean previous run artefacts so old rounds don't leak into the new loop.
    if (await fileExists(iterationsRoot)) {
      try {
        await fsp.rm(iterationsRoot, { recursive: true, force: true });
      } catch (error) {
        console.warn("Could not clean previous iterations:", error.message);
      }
    }
    await fsp.mkdir(iterationsRoot, { recursive: true });

    // Reset the consensus file so the UI shows nothing stale during the new loop.
    try { await fsp.writeFile(finalPath, "", "utf8"); } catch {}

    // Chat mode: ensure the sandbox folder exists and is empty (so CLIs have no files to read).
    if (mode === "chat") {
      try {
        if (await fileExists(chatSandboxDir)) {
          await fsp.rm(chatSandboxDir, { recursive: true, force: true });
        }
      } catch {}
      await fsp.mkdir(chatSandboxDir, { recursive: true });
      // Drop a placeholder so CLIs that refuse empty dirs still find something inert.
      await fsp.writeFile(
        path.join(chatSandboxDir, "README.txt"),
        "Sandbox volontairement vide pour le mode chat de Consensus IA.\nAucun projet a analyser dans ce dossier.\n",
        "utf8"
      );
    }

    // fresh state
    const state = emptyIterationState();
    state.running = true;
    state.startedAt = nowIso();
    state.activeAgents = roundAgents;
    state.maxRounds = config.maxRounds || 5;
    state.mode = mode;
    await writeIterationState(state);

    // run scan first (audit mode only)
    if (mode === "audit") {
      await scanProject(config);
    } else {
      // Chat mode: also remove the scan file so it can't be picked up by stale code paths.
      try { await fsp.writeFile(scanPath, "# Mode chat - pas de scan projet.\n", "utf8"); } catch {}
    }

    let finalReason = "";
    let interrupted = false;
    for (let roundIndex = 0; roundIndex < state.maxRounds; roundIndex++) {
      if (loopAbortController && loopAbortController.signal.aborted) {
        interrupted = true;
        finalReason = "Boucle interrompue par l'utilisateur.";
        break;
      }
      const { allAccord, allErrored } = await runOneRound(state, config, roundIndex);
      if (loopAbortController && loopAbortController.signal.aborted) {
        interrupted = true;
        finalReason = "Boucle interrompue par l'utilisateur pendant le tour " + roundIndex + ".";
        break;
      }
      if (allErrored) {
        finalReason = "Tous les agents ont echoue sur ce tour. Boucle interrompue.";
        break;
      }
      if (allAccord) {
        finalReason = "Tous les agents ont declare ACCORD. Boucle terminee.";
        break;
      }
    }
    if (!finalReason) {
      finalReason = `Maximum de tours atteint (${state.maxRounds}). Boucle terminee.`;
    }

    // final consensus (skip if interrupted)
    const consensus = interrupted
      ? { ok: false, reason: "Synthese ignoree car boucle interrompue." }
      : await runFinalConsensus(state, config);

    const finished = await readIterationState();
    finished.running = false;
    finished.finished = true;
    finished.finishedAt = nowIso();
    finished.finalPath = "ai-workflow/04-decisions-finales.md";
    finished.error = consensus.ok ? "" : (consensus.reason || "");
    finished.note = finalReason + (consensus.ok ? " Consensus genere." : " Consensus non genere.");
    await writeIterationState(finished);
  } catch (error) {
    const current = await readIterationState();
    current.running = false;
    current.finished = true;
    current.finishedAt = nowIso();
    current.error = error.message || String(error);
    await writeIterationState(current);
  } finally {
    loopBusy = false;
    loopAbortController = null;
  }
}

// ---------------------------------------------------------------------------
// state aggregation for UI
// ---------------------------------------------------------------------------

async function readEditableFiles() {
  const files = {};
  for (const file of editableFiles) {
    const resolved = path.resolve(projectRoot, file);
    if (await fileExists(resolved)) {
      files[file] = await fsp.readFile(resolved, "utf8");
    } else {
      files[file] = "";
    }
  }
  // include round outputs as well
  if (await fileExists(iterationsRoot)) {
    const dirs = await fsp.readdir(iterationsRoot, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const roundPath = path.join(iterationsRoot, dir.name);
      const roundFiles = await fsp.readdir(roundPath);
      for (const fileName of roundFiles) {
        if (!fileName.endsWith(".md") || fileName.endsWith(".prompt.md")) continue;
        const rel = `ai-workflow/iterations/${dir.name}/${fileName}`;
        files[rel] = await fsp.readFile(path.join(roundPath, fileName), "utf8");
      }
    }
  }
  return files;
}

async function buildToolStatus(config) {
  const tools = { agents: {} };
  for (const command of ["git", "node"]) {
    const resolved = providers.resolveCommandPath(command);
    tools[command] = { ok: Boolean(resolved), path: resolved || "" };
  }
  const mistralKey = loadMistralKey();
  for (const id of agentOrder) {
    const agent = config.agents[id];
    if (!agent) continue;
    const probe = await providers.probeAgent(agent, {
      apiKey: agent.provider === "mistral" ? mistralKey : undefined
    });
    tools.agents[id] = {
      id,
      label: agent.label,
      role: agent.role,
      type: agent.type,
      provider: agent.provider || null,
      enabled: agent.enabled !== false,
      ok: probe.ok,
      installed: probe.installed,
      detail: probe.detail,
      path: probe.path || "",
      setup: AGENT_SETUP[id] || null
    };
  }
  return tools;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

async function apiState(res) {
  const config = await readConfig();
  const targetPath = path.resolve(config.targetProjectPath || projectRoot);
  const [workflowStatusResult, workflowBranchResult, targetStatusResult, targetBranchResult, tools, files, userInstructions, iterations] = await Promise.all([
    gitStatus(projectRoot),
    gitBranch(projectRoot),
    gitStatus(targetPath),
    gitBranch(targetPath),
    buildToolStatus(config),
    readEditableFiles(),
    readInstructions(),
    readIterationState()
  ]);

  sendJson(res, 200, {
    projectRoot,
    workflowRoot,
    editableFiles,
    config,
    userInstructions,
    git: { status: gitOutput(workflowStatusResult), branch: workflowBranchResult.stdout.trim() },
    targetGit: { status: gitOutput(targetStatusResult), branch: targetBranchResult.stdout.trim(), ok: targetStatusResult.ok },
    tools,
    files,
    iterations,
    mistralKey: maskKey(loadMistralKey())
  });
}

async function apiSave(req, res) {
  const body = JSON.parse(await readBody(req));
  const { normalized, resolved } = normalizeWorkspacePath(body.path);
  await fsp.writeFile(resolved, String(body.content || ""), "utf8");
  sendJson(res, 200, { ok: true, path: normalized });
}

async function apiSettings(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const config = await readConfig();
  const targetProjectPath = String(body.targetProjectPath || config.targetProjectPath || projectRoot).trim();
  const branchName = String(body.branchName || config.branchName || "ai/project-loop").trim();

  if (!targetProjectPath) {
    throw new Error("Target project path is required.");
  }
  const resolvedTarget = path.resolve(targetProjectPath);
  const stat = await fsp.stat(resolvedTarget);
  if (!stat.isDirectory()) {
    throw new Error("Target project path must be a folder.");
  }

  const nextConfig = {
    ...config,
    targetProjectPath: resolvedTarget,
    branchName,
    agents: sanitizeAgents(body.agents || config.agents),
    maxRounds: Number(body.maxRounds || config.maxRounds || 5),
    minAgents: Number(body.minAgents || config.minAgents || 2)
  };
  await writeConfig(nextConfig);

  if (Object.prototype.hasOwnProperty.call(body, "userInstructions")) {
    await fsp.writeFile(instructionsPath, String(body.userInstructions || ""), "utf8");
  }

  sendJson(res, 200, {
    ok: true,
    config: nextConfig,
    userInstructions: await readInstructions()
  });
}

async function apiFolders(req, res, url) {
  const folderPathInput = decodeQueryPath(url.searchParams.get("path"));
  const result = await listFolder(folderPathInput);
  sendJson(res, 200, { ok: true, ...result });
}

async function buildConsensusExport(config) {
  const state = await readIterationState();
  const userQuestion = (await readInstructions()).trim();
  const finalContent = (await fileExists(finalPath)) ? await fsp.readFile(finalPath, "utf8") : "";
  const cleanFinal = finalContent.replace(/^<!--[\s\S]*?-->\n?/m, "").trim();

  const generatedBy = (() => {
    const match = finalContent.match(/<!--\s*Consensus genere par\s*:\s*([^\s>-]+)/i);
    return match ? match[1] : "inconnu";
  })();

  const isChatMode = state.mode === "chat";
  const targetPath = path.resolve(config.targetProjectPath || projectRoot);
  const branch = isChatMode ? "(mode chat - pas de projet)" : ((await gitBranch(targetPath)).stdout.trim() || "inconnue");

  const lastRound = state.rounds && state.rounds.length ? state.rounds[state.rounds.length - 1] : null;
  const finalStatuses = lastRound
    ? (state.activeAgents || []).map(id => {
      const info = lastRound.agents && lastRound.agents[id];
      return `- **${id}** : ${info ? info.status : "inconnu"}${info && info.error ? ` (erreur : ${info.error.slice(0, 200)})` : ""}`;
    }).join("\n")
    : "(Aucun tour execute)";

  const roundsDone = state.rounds ? state.rounds.length : 0;
  const startedAt = state.startedAt || "inconnu";
  const finishedAt = state.finishedAt || "inconnu";

  const sectionLabel = isChatMode ? "Idee a debattre" : "Question d'audit posee a la boucle";
  const projectLine = isChatMode
    ? "- **Mode** : Chat (discussion conceptuelle, aucun projet analyse)"
    : `- **Projet audite** : \`${targetPath}\`\n- **Branche Git** : ${branch}`;

  return `# Consensus IA - Synthese pour Claude Cowork

## Provenance

${projectLine}
- **Date de generation** : ${nowIso()}
- **Boucle demarree le** : ${startedAt}
- **Boucle terminee le** : ${finishedAt}
- **Nombre de tours effectues** : ${roundsDone} / ${state.maxRounds || 5}
- **IA participantes** : ${(state.activeAgents || []).join(", ") || "aucune"}
- **Synthese finale produite par** : ${generatedBy}
- **Source des fichiers** : \`ai-workflow/04-decisions-finales.md\` et \`ai-workflow/iterations/round-*\`

## ${sectionLabel}

${userQuestion || "(Aucune question specifique fournie par l'utilisateur.)"}

## Statut final des IA (dernier tour)

${finalStatuses}

## Consensus final

${cleanFinal || "(Aucun consensus genere.)"}

---

*Genere depuis Consensus IA - cockpit local multi-IA en boucle. Outil developpe pour faire dialoguer Claude Code, Codex, Gemini CLI et Mistral, en lecture seule sur un projet ou en discussion conceptuelle, jusqu'a convergence ou plafond de tours.*
`;
}

async function apiConsensusExport(res) {
  const config = await readConfig();
  const markdown = await buildConsensusExport(config);
  sendJson(res, 200, { ok: true, markdown });
}

async function apiAction(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const action = body.action;
  const config = await readConfig();

  if (action === "workflow-git-status") {
    const result = await gitStatus(projectRoot);
    sendJson(res, 200, { ok: result.ok, output: gitOutput(result) });
    return;
  }

  if (action === "target-git-status") {
    const result = await gitStatus(path.resolve(config.targetProjectPath || projectRoot));
    sendJson(res, 200, { ok: result.ok, output: gitOutput(result) });
    return;
  }

  if (action === "scan-project") {
    const result = await scanProject(config);
    sendJson(res, 200, { ok: true, output: result.output, config: result.config });
    return;
  }

  if (action && action.startsWith("agent-probe-")) {
    const agentId = action.replace("agent-probe-", "");
    const agent = config.agents[agentId];
    if (!agent) {
      sendJson(res, 400, { ok: false, output: "Unknown agent." });
      return;
    }
    const probe = await providers.probeAgent(agent, {
      apiKey: agent.provider === "mistral" ? loadMistralKey() : undefined
    });
    sendJson(res, 200, {
      ok: probe.ok,
      output: `${agent.label}: ${probe.detail}`,
      probe
    });
    return;
  }

  // Test PROFOND (assistant de connexion) : mini-appel reel pour distinguer
  // non installee / installee-non-connectee / prete.
  if (action && action.startsWith("agent-test-")) {
    const agentId = action.replace("agent-test-", "");
    const agent = config.agents[agentId];
    if (!agent) {
      sendJson(res, 400, { ok: false, output: "Unknown agent." });
      return;
    }
    try { await fsp.mkdir(chatSandboxDir, { recursive: true }); } catch {}
    const result = await providers.testAgent(agent, {
      cwd: chatSandboxDir,
      apiKey: agent.provider === "mistral" ? loadMistralKey() : undefined
    });
    sendJson(res, 200, {
      ok: result.ok,
      state: result.state,
      detail: result.detail,
      output: `${agent.label}: ${result.detail}`
    });
    return;
  }

  if (action === "start-loop") {
    if (loopBusy) {
      sendJson(res, 409, { ok: false, output: "Boucle deja en cours." });
      return;
    }
    const mode = body.mode === "chat" ? "chat" : "audit";

    // Garde-fou : la question utilisateur doit etre non vide.
    const question = (await readInstructions()).trim();
    if (!question) {
      sendJson(res, 400, {
        ok: false,
        output: mode === "chat"
          ? "Ajoute ton idee ou ta question dans le champ avant de lancer la discussion."
          : "Ajoute ce que les IA doivent verifier dans le champ avant de lancer l'audit."
      });
      return;
    }

    // fire and forget
    runLoop({ mode }).catch(error => {
      // already handled inside runLoop
      console.error("runLoop crashed:", error);
    });
    sendJson(res, 202, { ok: true, output: `Boucle lancee (mode ${mode}). Suivi via /api/state -> iterations.` });
    return;
  }

  if (action === "stop-loop") {
    if (!loopBusy || !loopAbortController) {
      // Even if the in-memory loop is gone, force the state file to reflect stopped status.
      const current = await readIterationState();
      if (current.running) {
        current.running = false;
        current.finished = true;
        current.finishedAt = nowIso();
        current.error = current.error || "Boucle marquee comme arretee manuellement.";
        await writeIterationState(current);
      }
      sendJson(res, 200, { ok: true, output: "Aucune boucle active. Etat nettoye." });
      return;
    }
    try { loopAbortController.abort(); } catch {}
    sendJson(res, 200, { ok: true, output: "Signal d'arret envoye. La boucle s'interrompt." });
    return;
  }

  if (action === "set-mistral-key") {
    const key = String(body.key || "").trim();
    setMistralKey(key);
    sendJson(res, 200, { ok: true, output: key ? "Cle Mistral enregistree." : "Cle Mistral effacee." });
    return;
  }

  sendJson(res, 400, { ok: false, output: `Unknown action: ${action}` });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routes = {
    "/": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css"
  };
  const fileName = routes[url.pathname];
  if (!fileName) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }
  const filePath = path.join(webRoot, fileName);
  const ext = path.extname(fileName);
  const contentType = ext === ".html"
    ? "text/html; charset=utf-8"
    : ext === ".css"
      ? "text/css; charset=utf-8"
      : "application/javascript; charset=utf-8";
  sendText(res, 200, await fsp.readFile(filePath, "utf8"), contentType);
}

// preload env into process.env so providers can fallback
(function preloadEnv() {
  const env = loadEnvKeys();
  for (const key of Object.keys(env)) {
    if (!process.env[key]) {
      process.env[key] = env[key];
    }
  }
})();

// On startup: wipe ALL traces of previous runs so the UI is fresh.
// User explicitly asked: "Quand je relance le serveur, je vois encore les traces
// de la session precedente". So we delete iterations/, the consensus file, the
// scan file, and reset iterations-state.json to a blank state.
(async function freshStartCleanup() {
  try {
    // 1. Remove the iterations directory entirely.
    if (await fileExists(iterationsRoot)) {
      await fsp.rm(iterationsRoot, { recursive: true, force: true });
    }
    // 2. Reset state to empty (no rounds, not running, no error).
    await writeIterationState(emptyIterationState());
    // 3. Clear the consensus file.
    try { await fsp.writeFile(finalPath, "", "utf8"); } catch {}
    // 4. Clear the project scan (it will be regenerated at next audit run).
    try { await fsp.writeFile(scanPath, "", "utf8"); } catch {}
    // 5. Clear the active prompt (debug file).
    try { await fsp.writeFile(activePromptPath, "", "utf8"); } catch {}
    // 6. Remove the chat sandbox if it was left behind.
    if (await fileExists(chatSandboxDir)) {
      try { await fsp.rm(chatSandboxDir, { recursive: true, force: true }); } catch {}
    }
    console.log("Fresh start: previous run traces cleared.");
  } catch (error) {
    console.warn("Fresh start cleanup failed:", error.message);
  }
})();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/state") {
      await apiState(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/folders") {
      await apiFolders(req, res, url);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/consensus-export") {
      await apiConsensusExport(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/save") {
      await apiSave(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      await apiSettings(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/action") {
      await apiAction(req, res);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Consensus IA web interface running at http://localhost:${port}`);
  console.log(`Project root: ${projectRoot}`);
});
