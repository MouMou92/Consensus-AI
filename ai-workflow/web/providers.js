"use strict";

const { spawn, exec: execChildProcess } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    // taskkill /F /T /PID <pid> kills the process and its whole tree.
    try {
      execChildProcess(`taskkill /F /T /PID ${pid}`, { windowsHide: true }, () => {});
    } catch {
      // ignored
    }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

const isWindows = process.platform === "win32";

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const text = fs.readFileSync(envPath, "utf8");
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function saveEnv(envPath, vars) {
  const lines = Object.entries(vars)
    .filter(([key]) => key)
    .map(([key, value]) => `${key}=${String(value || "")}`);
  fs.writeFileSync(envPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
}

// Dossiers d'install courants des CLI agentiques quand le PATH n'est pas (encore)
// configure. Permet de retrouver `agy` (Antigravity), `gemini`, etc. meme si
// l'utilisateur n'a pas fait l'etape PATH de l'installeur.
function extraCommandDirs() {
  if (!isWindows) {
    const home = process.env.HOME || "";
    return [home && path.join(home, ".local", "bin")].filter(Boolean);
  }
  const LA = process.env.LOCALAPPDATA || "";
  const UP = process.env.USERPROFILE || "";
  return [
    LA && path.join(LA, "agy", "bin"),
    LA && path.join(LA, "Antigravity"),
    LA && path.join(LA, "Antigravity", "bin"),
    LA && path.join(LA, "Antigravity", "staging"),
    LA && path.join(LA, "Programs", "Antigravity"),
    UP && path.join(UP, ".antigravity", "bin"),
    UP && path.join(UP, ".local", "bin"),
    LA && path.join(LA, "Microsoft", "WinGet", "Links")
  ].filter(Boolean);
}

function resolveCommandPath(command) {
  if (!command) {
    return null;
  }
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command) ? command : null;
  }
  const extensions = isWindows ? [".cmd", ".exe", ".ps1", ".bat", ""] : [""];
  const separator = isWindows ? ";" : ":";
  const searchDirs = [
    ...String(process.env.PATH || "").split(separator),
    ...extraCommandDirs()
  ];
  for (const folder of searchDirs) {
    if (!folder) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(folder, command + extension);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function callCliHeadless(agent, prompt, options = {}) {
  return new Promise(resolve => {
    const resolved = resolveCommandPath(agent.command);
    if (!resolved) {
      resolve({
        ok: false,
        output: "",
        error: `Command not found in PATH: ${agent.command}. Install the CLI then restart the web server.`
      });
      return;
    }
    if (options.signal && options.signal.aborted) {
      resolve({ ok: false, output: "", error: "Aborted before spawn." });
      return;
    }

    const baseArgs = Array.isArray(agent.args) ? [...agent.args] : [];
    const timeoutMs = Number(agent.timeoutMs || 300000);

    // Mode de transmission du prompt :
    //  - "stdin" (defaut) : le prompt est ecrit sur stdin (claude, codex, gemini).
    //  - "arg"            : le prompt est passe en ARGUMENT (Antigravity `agy`,
    //                       dont `-p`/`--print` EXIGE une valeur et ne lit pas stdin).
    // Mode de CAPTURE de la reponse :
    //  - "stdout" (defaut) : on lit la reponse sur la sortie standard.
    //  - "file"            : on demande a l'agent d'ECRIRE sa reponse dans un
    //                        fichier qu'on relit ensuite. Contourne le bug
    //                        "stdout vide en non-TTY" de agy sur Windows.
    const promptMode = agent.promptMode === "arg" ? "arg" : "stdin";
    const captureMode = agent.captureMode === "file" ? "file" : "stdout";
    let tempDirToClean = null;
    let outputFilePath = null;
    const ensureTempDir = () => {
      if (!tempDirToClean) {
        tempDirToClean = fs.mkdtempSync(path.join(os.tmpdir(), "consensus-agy-"));
      }
      return tempDirToClean;
    };

    let effectivePrompt = prompt;

    // Capture par fichier : prepare le fichier de reponse + ajoute la consigne
    // d'ecriture a la fin du prompt.
    if (captureMode === "file") {
      try {
        const dir = ensureTempDir();
        outputFilePath = path.join(dir, "answer.md");
        fs.writeFileSync(outputFilePath, "", "utf8");
        effectivePrompt = `${prompt}\n\n## SORTIE OBLIGATOIRE (mode automatise)\nTa sortie console est IGNOREE par l'outil appelant. Ecris ta reponse COMPLETE et finale (y compris le marqueur de fin STATUT) en UTF-8 dans CE fichier exact, en ecrasant tout contenu existant, et n'ecris AUCUN autre fichier :\n${outputFilePath}\nN'affiche rien d'autre.`;
      } catch (error) {
        resolve({ ok: false, output: "", error: `Preparation du fichier de sortie impossible : ${error.message}` });
        return;
      }
    }

    // Transmission du prompt.
    if (promptMode === "arg") {
      const promptBytes = Buffer.byteLength(effectivePrompt, "utf8");
      // Marge sous la limite de ligne de commande Windows (~32767 caracteres).
      const argSafeLimit = isWindows ? 28000 : 120000;
      if (promptBytes <= argSafeLimit) {
        baseArgs.push(effectivePrompt);
      } else {
        // Prompt trop volumineux (ex. audit avec gros scan) : on l'ecrit dans le
        // dossier temporaire et on le fait lire via la syntaxe @fichier.
        try {
          const dir = ensureTempDir();
          const promptFilePath = path.join(dir, "prompt.md");
          fs.writeFileSync(promptFilePath, effectivePrompt, "utf8");
          baseArgs.unshift("--add-dir", dir);
          baseArgs.push(`Lis INTEGRALEMENT le fichier @${promptFilePath} puis suis EXACTEMENT ses instructions.`);
        } catch (error) {
          resolve({ ok: false, output: "", error: `Prompt trop volumineux pour la ligne de commande et fallback fichier impossible : ${error.message}` });
          return;
        }
      }
    }

    // Capture fichier : le dossier temp doit etre dans le workspace de l'agent
    // pour qu'il puisse y ecrire (si pas deja ajoute par le fallback ci-dessus).
    if (captureMode === "file" && tempDirToClean && !baseArgs.includes("--add-dir")) {
      baseArgs.unshift("--add-dir", tempDirToClean);
    }

    const isCmdShim = isWindows && /\.(cmd|bat)$/i.test(resolved);
    const isPs1 = isWindows && /\.ps1$/i.test(resolved);

    let spawnCommand;
    let spawnArgs;
    let verbatim = false;
    if (isCmdShim) {
      // Manual cmd.exe quoting so multi-word args like '-p "Analyse le projet"' arrive intact.
      // Rule: with /s/c, cmd.exe strips the first and last quote of the line. So we wrap the whole
      // command in OUTER double quotes, and quote each piece (command path + args) INSIDE.
      const quote = value => `"${String(value).replace(/"/g, '\\"')}"`;
      const innerParts = [quote(resolved), ...baseArgs.map(quote)].join(" ");
      spawnCommand = "cmd.exe";
      spawnArgs = ["/d", "/s", "/c", `"${innerParts}"`];
      verbatim = true;
    } else if (isPs1) {
      spawnCommand = "powershell.exe";
      spawnArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...baseArgs];
    } else {
      spawnCommand = resolved;
      spawnArgs = baseArgs;
    }

    // Env transmis a la CLI : process.env (qui contient deja les cles chargees
    // depuis .env au demarrage du serveur) + cles specifiques de l'agent
    // (agent.env) + override eventuel par appel (options.env). C'est par ce biais
    // que GEMINI_API_KEY / ANTIGRAVITY_API_KEY arrivent jusqu'a `agy` / `gemini`.
    const childEnv = { ...process.env, ...(agent.env || {}), ...(options.env || {}) };

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd: options.cwd || process.cwd(),
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ ok: false, output: "", error: `spawn failed: ${error.message}` });
      return;
    }

    let stdoutChunks = [];
    let stderrChunks = [];
    let stdoutBytes = 0;
    const maxBytes = 8 * 1024 * 1024;
    let killed = false;
    let aborted = false;
    let settled = false;

    const finish = result => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (options.signal && abortListener) {
        try { options.signal.removeEventListener("abort", abortListener); } catch {}
      }
      if (tempDirToClean) {
        try { fs.rmSync(tempDirToClean, { recursive: true, force: true }); } catch {}
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    let abortListener = null;
    if (options.signal) {
      abortListener = () => {
        aborted = true;
        killProcessTree(child.pid);
      };
      options.signal.addEventListener("abort", abortListener, { once: true });
    }

    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr.on("data", chunk => {
      if (stderrChunks.reduce((sum, item) => sum + item.length, 0) < 256 * 1024) {
        stderrChunks.push(chunk);
      }
    });

    child.on("error", error => {
      finish({
        ok: false,
        output: Buffer.concat(stdoutChunks).toString("utf8"),
        error: error.message
      });
    });

    child.on("close", code => {
      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      // Capture fichier : la vraie reponse est dans le fichier ecrit par l'agent,
      // pas sur stdout (qui peut etre vide a cause du bug non-TTY de agy).
      if (captureMode === "file" && outputFilePath) {
        try {
          const fileOut = fs.readFileSync(outputFilePath, "utf8");
          if (fileOut && fileOut.trim()) {
            stdout = fileOut;
          }
        } catch {}
      }
      if (aborted) {
        finish({ ok: false, output: stdout, error: "Interrompu par l'utilisateur." });
        return;
      }
      if (killed) {
        finish({ ok: false, output: stdout, error: `Timeout after ${timeoutMs} ms. ${stderr.slice(0, 500)}` });
        return;
      }
      if (typeof code === "number" && code !== 0) {
        finish({
          ok: false,
          output: stdout,
          error: `Exit code ${code}. ${stderr.slice(0, 1500)}`.trim()
        });
        return;
      }
      finish({ ok: true, output: stdout, error: stderr.trim() ? stderr.slice(0, 1500) : undefined });
    });

    try {
      if (promptMode === "stdin" && agent.stdinMode !== false) {
        child.stdin.on("error", () => {
          // some CLIs close stdin early
        });
        child.stdin.end(effectivePrompt, "utf8");
      } else {
        // Mode "arg" (ou stdin desactive) : on ferme stdin vide, le prompt est
        // deja passe en argument.
        child.stdin.end();
      }
    } catch (error) {
      finish({ ok: false, output: "", error: `stdin write failed: ${error.message}` });
    }
  });
}

// Parse a Retry-After header (delta-seconds OR HTTP-date) into milliseconds.
function parseRetryAfter(headerValue) {
  if (!headerValue) {
    return null;
  }
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

// Abortable sleep. Rejects if the signal aborts during the wait.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("Interrompu par l'utilisateur."));
      return;
    }
    let onAbort = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        try { signal.removeEventListener("abort", onAbort); } catch {}
      }
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Interrompu par l'utilisateur."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// Single HTTP attempt to Mistral. Resolves:
//   { ok:true, output }                                     on 2xx
//   { ok:false, retryable, status, retryAfterMs, error }    otherwise
function mistralRequestOnce(endpoint, body, apiKey, timeoutMs, signal) {
  return new Promise(resolve => {
    if (signal && signal.aborted) {
      resolve({ ok: false, retryable: false, error: "Aborted before request." });
      return;
    }

    const req = https.request({
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: endpoint.pathname + (endpoint.search || ""),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "authorization": `Bearer ${apiKey}`,
        "content-length": Buffer.byteLength(body, "utf8")
      },
      timeout: timeoutMs
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
          // 429 (rate limit) and 5xx are transient → worth retrying.
          const retryable = status === 429 || (status >= 500 && status <= 504);
          resolve({
            ok: false,
            retryable,
            status,
            retryAfterMs: parseRetryAfter(res.headers["retry-after"]),
            error: `Mistral HTTP ${status}: ${text.slice(0, 600)}`
          });
          return;
        }
        try {
          const parsed = JSON.parse(text);
          const message = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
          const content = message && typeof message.content === "string" ? message.content : null;
          if (!content) {
            resolve({ ok: false, retryable: false, error: `Unexpected Mistral response: ${text.slice(0, 400)}` });
            return;
          }
          resolve({ ok: true, output: content });
        } catch (error) {
          resolve({ ok: false, retryable: false, error: `Parse error: ${error.message}` });
        }
      });
    });

    req.on("error", error => {
      // Network-level failures (reset, DNS hiccup, timeout) are transient.
      resolve({ ok: false, retryable: true, error: error.message });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Mistral timeout after ${timeoutMs} ms`));
    });

    let onAbort = null;
    if (signal) {
      onAbort = () => {
        try { req.destroy(new Error("Interrompu par l'utilisateur.")); } catch {}
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    req.write(body);
    req.end();
  });
}

async function callMistralApi(agent, prompt, options = {}) {
  const apiKey = options.apiKey || process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    return { ok: false, output: "", error: "MISTRAL_API_KEY missing. Add the key in the web UI and try again." };
  }

  let endpoint;
  try {
    endpoint = new URL(agent.endpoint || "https://api.mistral.ai/v1/chat/completions");
  } catch (error) {
    return { ok: false, output: "", error: `Invalid Mistral endpoint: ${error.message}` };
  }

  const body = JSON.stringify({
    model: agent.model || "mistral-large-latest",
    messages: [{ role: "user", content: prompt }],
    temperature: typeof agent.temperature === "number" ? agent.temperature : 0.3
  });

  const timeoutMs = Number(agent.timeoutMs || 120000);
  const maxAttempts = Math.max(1, Number(agent.maxAttempts || 4));     // 1 essai + 3 retries
  const baseDelayMs = Math.max(200, Number(agent.retryBaseMs || 1000));
  const maxDelayMs = Math.max(baseDelayMs, Number(agent.retryMaxMs || 60000));
  const signal = options.signal;

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal && signal.aborted) {
      return { ok: false, output: "", error: "Aborted before request." };
    }

    last = await mistralRequestOnce(endpoint, body, apiKey, timeoutMs, signal);
    if (last.ok) {
      return last;
    }

    const canRetry = last.retryable && attempt < maxAttempts;
    if (!canRetry) {
      const note = attempt > 1 ? ` (apres ${attempt} tentatives)` : "";
      return { ok: false, output: "", error: `${last.error}${note}` };
    }

    // Backoff : respecter Retry-After si fourni, sinon exponentiel + jitter, plafonne.
    let waitMs = (typeof last.retryAfterMs === "number" && last.retryAfterMs >= 0)
      ? last.retryAfterMs
      : baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
    waitMs = Math.min(waitMs, maxDelayMs);

    try {
      await delay(waitMs, signal);
    } catch {
      return { ok: false, output: "", error: "Interrompu par l'utilisateur." };
    }
  }

  return { ok: false, output: "", error: last ? last.error : "Mistral: erreur inconnue" };
}

// Classe le message d'erreur d'une CLI en etat exploitable par l'assistant.
function classifyCliError(errText) {
  const e = String(errText || "").toLowerCase();
  if (/not found in path|command not found|introuvable|enoent/.test(e)) {
    return "not_installed";
  }
  if (/log ?in|sign ?in|authenticat|oauth|unauthorized|\b401\b|not signed in|credential|api key|cancelled by user|fatalcancellation|please run|connect/.test(e)) {
    return "needs_login";
  }
  return "error";
}

// Test PROFOND d'un agent (a la demande, pas a chaque /api/state) : distingue
// "non installee" / "installee mais non connectee" / "prete". Fait un mini-appel reel.
// Retourne { ok, state, detail }. state ∈ ready|not_installed|needs_login|no_key|bad_key|error
async function testAgent(agent, options = {}) {
  if (!agent || typeof agent !== "object") {
    return { ok: false, state: "error", detail: "Agent invalide." };
  }

  if (agent.type === "api") {
    if (agent.provider === "mistral") {
      const apiKey = options.apiKey || process.env.MISTRAL_API_KEY;
      if (!apiKey) {
        return { ok: false, state: "no_key", detail: "Aucune cle API Mistral enregistree." };
      }
      const res = await callMistralApi(
        { ...agent, maxAttempts: 1, timeoutMs: Number(options.timeoutMs || 20000) },
        "Reponds uniquement: OK",
        { apiKey, signal: options.signal }
      );
      if (res.ok) {
        return { ok: true, state: "ready", detail: "Cle valide, API Mistral joignable." };
      }
      if (/http 401|unauthorized|invalid api key|invalid_api_key/i.test(res.error || "")) {
        return { ok: false, state: "bad_key", detail: "Cle refusee par Mistral (401)." };
      }
      return { ok: false, state: "error", detail: (res.error || "Echec de l'appel Mistral.").slice(0, 300) };
    }
    return { ok: false, state: "error", detail: `Provider API inconnu : ${agent.provider}` };
  }

  // CLI headless
  const resolved = resolveCommandPath(agent.command);
  if (!resolved) {
    return { ok: false, state: "not_installed", detail: `Commande "${agent.command}" introuvable dans le PATH.` };
  }
  const res = await callCliHeadless(
    { ...agent, timeoutMs: Number(options.timeoutMs || 45000) },
    "Reponds uniquement par: OK",
    { cwd: options.cwd, signal: options.signal }
  );
  if (res.ok && res.output && res.output.trim()) {
    return { ok: true, state: "ready", detail: "Installee et connectee." };
  }
  if (res.ok) {
    // Exit 0 mais stdout vide : typiquement le bug "non-TTY stdout drop" de
    // Antigravity (agy) quand il est lance par un process (pipe) plutot que par
    // un vrai terminal. La CLI marche en interactif mais ne rend rien en headless.
    return {
      ok: false,
      state: "error",
      detail: "La CLI repond mais ne renvoie aucune sortie (exit 0, stdout vide). Connu avec Antigravity (agy) en headless sur Windows. Plan B : basculer ce siege sur 'gemini' + une cle GEMINI_API_KEY dans .env."
    };
  }
  const state = classifyCliError(res.error);
  const detail = state === "needs_login"
    ? "Installee mais non connectee : lance la commande de connexion une fois dans un terminal."
    : (res.error || "Echec du test.").slice(0, 300);
  return { ok: false, state, detail };
}

async function callAgent(agent, prompt, options = {}) {
  if (!agent || typeof agent !== "object") {
    return { ok: false, output: "", error: "Invalid agent definition" };
  }
  if (agent.type === "api") {
    if (agent.provider === "mistral") {
      return callMistralApi(agent, prompt, options);
    }
    return { ok: false, output: "", error: `Unsupported API provider: ${agent.provider}` };
  }
  return callCliHeadless(agent, prompt, options);
}

async function probeAgent(agent, options = {}) {
  if (!agent || typeof agent !== "object") {
    return { ok: false, detail: "Invalid agent" };
  }
  if (agent.type === "api") {
    if (agent.provider === "mistral") {
      const present = Boolean(options.apiKey || process.env.MISTRAL_API_KEY);
      return {
        ok: present,
        detail: present ? "Cle API Mistral chargee" : "Cle API Mistral manquante",
        installed: present
      };
    }
    return { ok: false, detail: `Unknown API provider: ${agent.provider}`, installed: false };
  }
  const resolved = resolveCommandPath(agent.command);
  return {
    ok: Boolean(resolved),
    detail: resolved || `Commande ${agent.command} introuvable dans le PATH`,
    installed: Boolean(resolved),
    path: resolved || ""
  };
}

module.exports = {
  callAgent,
  probeAgent,
  testAgent,
  resolveCommandPath,
  loadEnv,
  saveEnv
};
