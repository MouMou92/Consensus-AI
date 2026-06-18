"use strict";

let state = null;
let folderState = { path: "", parent: "", entries: [] };

const projectPath = document.getElementById("projectPath");
const branchName = document.getElementById("branchName");
const instructionBox = document.getElementById("instructionBox");
const agentCards = document.getElementById("agentCards");
const projectStatus = document.getElementById("projectStatus");
const loopStatus = document.getElementById("loopStatus");
const loopHint = document.getElementById("loopHint");
const roundCounter = document.getElementById("roundCounter");
const roundsList = document.getElementById("roundsList");
const saveState = document.getElementById("saveState");
const consoleOut = document.getElementById("consoleOut");
const folderDialog = document.getElementById("folderDialog");
const folderPath = document.getElementById("folderPath");
const folderList = document.getElementById("folderList");
const startLoopBtn = document.getElementById("startLoopBtn");
const stopLoopBtn = document.getElementById("stopLoopBtn");
const modeAuditBtn = document.getElementById("modeAuditBtn");
const modeChatBtn = document.getElementById("modeChatBtn");
const briefTitle = document.getElementById("briefTitle");
const maxRoundsInput = document.getElementById("maxRoundsInput");

let currentMode = "audit";

function setMode(mode) {
  currentMode = mode === "chat" ? "chat" : "audit";
  if (modeAuditBtn) modeAuditBtn.classList.toggle("active", currentMode === "audit");
  if (modeChatBtn) modeChatBtn.classList.toggle("active", currentMode === "chat");
  if (briefTitle) {
    briefTitle.textContent = currentMode === "chat"
      ? "Ton idee a debattre entre IA"
      : "Ce que les IA doivent verifier";
  }
  if (instructionBox) {
    instructionBox.placeholder = currentMode === "chat"
      ? "Exemple : Je veux ajouter du paiement recurrent a mon SaaS. Quelle est la meilleure approche entre Stripe Billing, Paddle et Lemon Squeezy pour un projet francais B2C ?"
      : "Exemple : auditer la qualite generale du code, les risques de securite, la maintenabilite, les tests manquants et les ameliorations prioritaires.";
  }
  document.body.dataset.mode = currentMode;
}

if (modeAuditBtn) modeAuditBtn.addEventListener("click", () => setMode("audit"));
if (modeChatBtn) modeChatBtn.addEventListener("click", () => setMode("chat"));

if (startLoopBtn) {
  startLoopBtn.addEventListener("click", () => {
    runAction("start-loop", { mode: currentMode }).catch(showError);
  });
}

if (maxRoundsInput) {
  maxRoundsInput.addEventListener("change", async () => {
    try {
      await saveSettings();
      // refleter la valeur bornee (1-10) renvoyee par le serveur
      maxRoundsInput.value = (state && state.config && state.config.maxRounds) || 5;
      renderIterations();
    } catch (e) {
      showError(e);
    }
  });
}

const resultEls = {
  claude: document.getElementById("claudeResult"),
  codex: document.getElementById("codexResult"),
  gemini: document.getElementById("geminiResult"),
  mistral: document.getElementById("mistralResult"),
  consensus: document.getElementById("consensusResult")
};

const resultStatusEls = {
  claude: document.querySelector('[data-result-status="claude"]'),
  codex: document.querySelector('[data-result-status="codex"]'),
  gemini: document.querySelector('[data-result-status="gemini"]'),
  mistral: document.querySelector('[data-result-status="mistral"]')
};

function setConsole(text) {
  consoleOut.textContent = text || "";
}

function setSaveState(text) {
  saveState.textContent = text;
}

function placeholderText() {
  return "En attente de resultat...";
}

function findLastAgentFile(agentId) {
  if (!state || !state.iterations || !Array.isArray(state.iterations.rounds)) return null;
  for (let i = state.iterations.rounds.length - 1; i >= 0; i--) {
    const round = state.iterations.rounds[i];
    if (!round || !round.agents || !round.agents[agentId]) continue;
    const info = round.agents[agentId];
    if (info.relPath && state.files[info.relPath]) {
      return {
        roundIndex: round.index,
        status: info.status,
        path: info.relPath,
        content: state.files[info.relPath]
      };
    }
  }
  return null;
}

function renderResults() {
  for (const agentId of ["claude", "codex", "gemini", "mistral"]) {
    const el = resultEls[agentId];
    const statusEl = resultStatusEls[agentId];
    const last = findLastAgentFile(agentId);
    if (last) {
      el.textContent = `[Tour ${last.roundIndex}] ${last.status}\n\n${last.content}`;
      statusEl.textContent = `Tour ${last.roundIndex} - ${last.status}`;
      statusEl.dataset.status = last.status;
    } else {
      el.textContent = placeholderText();
      statusEl.textContent = "";
      statusEl.dataset.status = "";
    }
  }
  const consensus = state && state.files ? state.files["ai-workflow/04-decisions-finales.md"] : "";
  resultEls.consensus.textContent = consensus && consensus.trim() ? consensus : placeholderText();
}

function renderAgents() {
  agentCards.innerHTML = "";
  const order = ["claude", "codex", "gemini", "mistral"];
  for (const id of order) {
    const agent = state.config.agents[id];
    if (!agent) continue;
    const tool = state.tools.agents && state.tools.agents[id] ? state.tools.agents[id] : null;
    const card = document.createElement("article");
    card.className = "agent-card";
    card.dataset.agent = id;

    const title = document.createElement("div");
    title.className = "agent-title";
    const name = document.createElement("strong");
    name.textContent = agent.label || id;
    const badge = document.createElement("span");
    const ready = tool && tool.ok;
    badge.className = ready ? "ok" : "missing";
    badge.textContent = ready ? "Pret" : (agent.type === "api" ? "Cle manquante" : "CLI introuvable");
    title.append(name, badge);

    const typePill = document.createElement("span");
    typePill.className = "type-pill";
    typePill.textContent = agent.type === "api" ? "API" : "CLI headless";

    const role = document.createElement("p");
    role.textContent = agent.role || "";

    const detail = document.createElement("p");
    detail.className = "agent-detail";
    detail.textContent = tool ? tool.detail || "" : "";

    card.append(title, typePill, role, detail);

    if (agent.type === "api" && agent.provider === "mistral") {
      const apiRow = document.createElement("div");
      apiRow.className = "api-row";
      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.placeholder = state.mistralKey ? `Cle actuelle : ${state.mistralKey}` : "Coller la cle API Mistral";
      keyInput.dataset.field = "mistralKey";
      const saveKeyBtn = document.createElement("button");
      saveKeyBtn.type = "button";
      saveKeyBtn.textContent = "Sauver cle";
      saveKeyBtn.addEventListener("click", async () => {
        try {
          setSaveState("Cle en cours");
          await fetch("/api/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "set-mistral-key", key: keyInput.value.trim() })
          });
          keyInput.value = "";
          setSaveState("Cle enregistree");
          await refresh({ quiet: true });
        } catch (error) {
          showError(error);
        }
      });
      apiRow.append(keyInput, saveKeyBtn);
      card.append(apiRow);
    }

    const actions = document.createElement("div");
    actions.className = "agent-actions";
    const enabledLabel = document.createElement("label");
    enabledLabel.className = "agent-enabled";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = agent.enabled !== false;
    enabledInput.dataset.field = "enabled";
    enabledInput.addEventListener("change", async () => {
      try {
        const agents = JSON.parse(JSON.stringify(state.config.agents));
        agents[id].enabled = enabledInput.checked;
        await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agents })
        });
        await refresh({ quiet: true });
      } catch (error) {
        showError(error);
      }
    });
    enabledLabel.append(enabledInput, document.createTextNode(" Active"));

    const probeBtn = document.createElement("button");
    probeBtn.type = "button";
    probeBtn.textContent = "Tester";
    probeBtn.addEventListener("click", () => runAction(`agent-probe-${id}`).catch(showError));

    actions.append(enabledLabel, probeBtn);
    card.append(actions);
    agentCards.appendChild(card);
  }
}

function renderIterations() {
  const it = state && state.iterations ? state.iterations : null;
  if (!it) {
    roundCounter.textContent = "Tour --/--";
    roundsList.innerHTML = "";
    loopStatus.textContent = "Idle";
    loopStatus.dataset.state = "idle";
    loopHint.textContent = "";
    return;
  }

  const maxRounds = it.maxRounds || 5;
  if (it.running) {
    const modeLabel = it.mode === "chat" ? "Chat" : "Audit";
    loopStatus.textContent = `${modeLabel} en cours`;
    loopStatus.dataset.state = "running";
    startLoopBtn.disabled = true;
    if (stopLoopBtn) stopLoopBtn.disabled = false;
    loopHint.textContent = "Boucle en cours - patiente pendant que les IA s'echangent leurs avis.";
  } else if (it.finished) {
    loopStatus.textContent = it.error ? "Erreur" : "Termine";
    loopStatus.dataset.state = it.error ? "error" : "done";
    startLoopBtn.disabled = false;
    if (stopLoopBtn) stopLoopBtn.disabled = true;
    loopHint.textContent = it.note || it.error || "";
  } else {
    loopStatus.textContent = "Idle";
    loopStatus.dataset.state = "idle";
    startLoopBtn.disabled = false;
    if (stopLoopBtn) stopLoopBtn.disabled = true;
    loopHint.textContent = "";
  }

  const currentRound = typeof it.currentRound === "number" ? it.currentRound : -1;
  if (currentRound >= 0) {
    roundCounter.textContent = `Tour ${currentRound + 1} / ${maxRounds}`;
  } else {
    roundCounter.textContent = `Tour --/${maxRounds}`;
  }

  roundsList.innerHTML = "";
  if (Array.isArray(it.rounds)) {
    for (const round of it.rounds) {
      if (!round) continue;
      const item = document.createElement("article");
      item.className = "round-item";
      const head = document.createElement("div");
      head.className = "round-head";
      head.innerHTML = `<strong>Tour ${round.index}</strong><span>${round.finishedAt ? "termine" : "en cours"}</span>`;
      item.appendChild(head);

      const badges = document.createElement("div");
      badges.className = "round-badges";
      for (const agentId of (it.activeAgents || [])) {
        const info = round.agents && round.agents[agentId];
        const badge = document.createElement("span");
        const status = info ? info.status : "PENDING";
        badge.className = `round-badge round-badge--${status}`;
        badge.textContent = `${agentId}: ${status}`;
        if (info && info.error) {
          badge.title = info.error;
        }
        badges.appendChild(badge);
      }
      item.appendChild(badges);
      roundsList.appendChild(item);
    }
  }
}

function renderState() {
  projectPath.value = state.config.targetProjectPath || "";
  branchName.value = state.config.branchName || "ai/project-loop";
  if (maxRoundsInput && document.activeElement !== maxRoundsInput) {
    maxRoundsInput.value = state.config.maxRounds || 5;
  }
  if (document.activeElement !== instructionBox) {
    instructionBox.value = state.userInstructions || "";
  }
  projectStatus.textContent = state.config.lastScanAt
    ? `Dernier scan ${new Date(state.config.lastScanAt).toLocaleTimeString()}`
    : "Projet non scanne";
  renderAgents();
  renderIterations();
  renderResults();
}

async function refresh({ quiet = false } = {}) {
  const response = await fetch("/api/state");
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "Refresh failed");
  }
  state = result;
  renderState();
  if (!quiet) {
    setConsole(state.targetGit && state.targetGit.status ? state.targetGit.status : (state.git && state.git.status) || "");
    setSaveState("Pret");
  }
}

async function saveSettings() {
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetProjectPath: projectPath.value,
      branchName: branchName.value,
      userInstructions: instructionBox.value,
      maxRounds: maxRoundsInput ? Number(maxRoundsInput.value) : undefined
    })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Settings save failed");
  }
  state.config = result.config;
  state.userInstructions = result.userInstructions;
  setSaveState("Enregistre");
}

async function runAction(action, extra = {}) {
  await saveSettings().catch(() => {});
  setSaveState("Action en cours");
  const response = await fetch("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra })
  });
  const result = await response.json();
  setConsole(result.output || result.error || "");
  setSaveState(response.ok && result.ok ? "Action terminee" : "Action en erreur");
  await refresh({ quiet: true });
}

async function loadFolders(p = "") {
  const response = await fetch(`/api/folders?path=${encodeURIComponent(p)}`);
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Folder load failed");
  }
  folderState = result;
  folderPath.value = result.path || "";
  renderFolders();
}

function renderFolders() {
  folderList.innerHTML = "";
  if (!folderState.entries.length) {
    const empty = document.createElement("p");
    empty.className = "folder-empty";
    empty.textContent = "Aucun sous-dossier lisible.";
    folderList.appendChild(empty);
    return;
  }
  for (const entry of folderState.entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = entry.name;
    button.addEventListener("click", () => loadFolders(entry.path).catch(showError));
    folderList.appendChild(button);
  }
}

function showError(error) {
  setSaveState("Erreur");
  setConsole(error.message || String(error));
}

function onClick(id, handler) {
  const element = document.getElementById(id);
  if (element) {
    element.addEventListener("click", handler);
  }
}

onClick("copyConsensusBtn", async () => {
  const feedback = document.getElementById("copyConsensusFeedback");
  feedback.textContent = "Generation...";
  try {
    const response = await fetch("/api/consensus-export");
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Export failed");
    }
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(result.markdown);
      feedback.textContent = "Copie dans le presse-papier";
    } else {
      // fallback : create a hidden textarea and copy
      const ta = document.createElement("textarea");
      ta.value = result.markdown;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      feedback.textContent = "Copie (fallback)";
    }
    setTimeout(() => { feedback.textContent = ""; }, 3500);
  } catch (error) {
    feedback.textContent = `Erreur : ${error.message}`;
    showError(error);
  }
});

onClick("browseBtn", async () => {
  try {
    folderDialog.showModal();
    await loadFolders(projectPath.value);
  } catch (error) {
    showError(error);
  }
});

onClick("closeFolderBtn", () => folderDialog.close());
onClick("folderUpBtn", () => loadFolders(folderState.parent).catch(showError));
onClick("folderGoBtn", () => loadFolders(folderPath.value).catch(showError));

onClick("selectFolderBtn", () => {
  projectPath.value = folderState.path || folderPath.value;
  folderDialog.close();
  saveSettings().catch(showError);
});

document.body.addEventListener("click", event => {
  const action = event.target && event.target.dataset && event.target.dataset.action;
  if (action) {
    runAction(action).catch(showError);
  }
});

/* ---------------------------------------------------------------------------
 * Assistant de connexion des IA (premier lancement)
 * ------------------------------------------------------------------------- */
const onboardingDialog = document.getElementById("onboardingDialog");
const onboardingCards = document.getElementById("onboardingCards");
const onboardingSummary = document.getElementById("onboardingSummary");
const recheckAllBtn = document.getElementById("recheckAllBtn");
const finishOnboardingBtn = document.getElementById("finishOnboardingBtn");

// Resultats des tests profonds, par agent : { state, detail }
let wizardResults = {};

const STATE_PILL = {
  ready:         { label: "Prete", cls: "ok" },
  needs_login:   { label: "A connecter", cls: "warn" },
  not_installed: { label: "Non installee", cls: "missing" },
  no_key:        { label: "Cle manquante", cls: "missing" },
  bad_key:       { label: "Cle invalide", cls: "missing" },
  error:         { label: "A verifier", cls: "warn" },
  unknown:       { label: "Non verifiee", cls: "neutral" },
  testing:       { label: "Test en cours...", cls: "neutral" }
};

function minAgents() {
  return (state && state.config && state.config.minAgents) || 2;
}

function readyCount() {
  return Object.values(wizardResults).filter(r => r && r.state === "ready").length;
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
  if (done) done();
}

function copyToClipboard(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = "Copie !";
    setTimeout(() => { btn.textContent = old; }, 1500);
  };
  if (navigator.clipboard && window.isSecureContext !== false) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function cmdRow(cmd) {
  const row = document.createElement("div");
  row.className = "cmd-row";
  const code = document.createElement("code");
  code.textContent = cmd;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cmd-copy";
  btn.textContent = "Copier";
  btn.addEventListener("click", () => copyToClipboard(cmd, btn));
  row.append(code, btn);
  return row;
}

function buildOnboardingCard(id) {
  const agent = state.config.agents[id];
  const tool = (state.tools && state.tools.agents && state.tools.agents[id]) || {};
  const setup = tool.setup || {};
  const res = wizardResults[id] || { state: "unknown" };
  const pill = STATE_PILL[res.state] || STATE_PILL.unknown;

  const card = document.createElement("article");
  card.className = "onboarding-card";
  card.dataset.state = res.state;

  const head = document.createElement("div");
  head.className = "ob-card-head";
  const name = document.createElement("strong");
  name.textContent = agent ? (agent.label || id) : id;
  const badge = document.createElement("span");
  badge.className = `state-pill ${pill.cls}`;
  badge.textContent = pill.label;
  head.append(name, badge);

  const role = document.createElement("p");
  role.className = "ob-role";
  role.textContent = agent ? (agent.role || "") : "";

  card.append(head, role);

  if (res.detail) {
    const detail = document.createElement("p");
    detail.className = "ob-detail";
    detail.textContent = res.detail;
    card.append(detail);
  }

  const isMistral = agent && agent.type === "api" && agent.provider === "mistral";

  if (isMistral) {
    const apiRow = document.createElement("div");
    apiRow.className = "api-row";
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = state.mistralKey ? `Cle actuelle : ${state.mistralKey}` : "Coller la cle API Mistral";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Sauver & tester";
    saveBtn.addEventListener("click", async () => {
      try {
        saveBtn.disabled = true;
        await fetch("/api/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "set-mistral-key", key: keyInput.value.trim() })
        });
        keyInput.value = "";
        await refresh({ quiet: true });
        await testOneAgent(id);
      } catch (e) {
        showError(e);
      } finally {
        saveBtn.disabled = false;
      }
    });
    apiRow.append(keyInput, saveBtn);
    card.append(apiRow);
    if (setup.keyNote) {
      const note = document.createElement("p");
      note.className = "ob-note";
      note.textContent = setup.keyNote;
      card.append(note);
    }
  } else {
    if (res.state === "not_installed" && setup.installCmd) {
      const lbl = document.createElement("p");
      lbl.className = "ob-step";
      lbl.textContent = "1. Installer (dans un terminal) :";
      card.append(lbl, cmdRow(setup.installCmd));
    }
    if ((res.state === "needs_login" || res.state === "error" || res.state === "not_installed") && setup.loginCmd) {
      const lbl = document.createElement("p");
      lbl.className = "ob-step";
      lbl.textContent = (res.state === "not_installed" ? "2. " : "") + "Se connecter (dans un terminal) :";
      card.append(lbl, cmdRow(setup.loginCmd));
      if (setup.loginNote) {
        const note = document.createElement("p");
        note.className = "ob-note";
        note.textContent = setup.loginNote;
        card.append(note);
      }
    }
  }

  const actions = document.createElement("div");
  actions.className = "ob-actions";
  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.textContent = res.state === "testing" ? "Test..." : "Verifier";
  testBtn.disabled = res.state === "testing";
  testBtn.addEventListener("click", () => testOneAgent(id));
  actions.append(testBtn);
  if (setup.docUrl) {
    const doc = document.createElement("a");
    doc.href = setup.docUrl;
    doc.target = "_blank";
    doc.rel = "noopener";
    doc.className = "ob-doc";
    doc.textContent = "Documentation";
    actions.append(doc);
  }
  card.append(actions);
  return card;
}

function renderOnboarding() {
  if (!onboardingCards || !state || !state.config) return;
  onboardingCards.innerHTML = "";
  for (const id of ["claude", "codex", "gemini", "mistral"]) {
    if (!state.config.agents[id]) continue;
    onboardingCards.appendChild(buildOnboardingCard(id));
  }
  const ready = readyCount();
  const need = minAgents();
  if (onboardingSummary) {
    onboardingSummary.textContent = `${ready} IA prete(s) — il en faut ${need} pour lancer une boucle.`;
    onboardingSummary.dataset.ok = ready >= need ? "1" : "0";
  }
  if (finishOnboardingBtn) finishOnboardingBtn.disabled = ready < need;
}

async function testOneAgent(id) {
  wizardResults[id] = { state: "testing", detail: "" };
  renderOnboarding();
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: `agent-test-${id}` })
    });
    const result = await response.json();
    wizardResults[id] = {
      state: result.state || (result.ok ? "ready" : "error"),
      detail: result.detail || result.output || ""
    };
  } catch (e) {
    wizardResults[id] = { state: "error", detail: e.message || String(e) };
  }
  renderOnboarding();
}

async function recheckAll() {
  if (!state || !state.config) return;
  renderOnboarding();
  await Promise.all(["claude", "codex", "gemini", "mistral"]
    .filter(id => state.config.agents[id])
    .map(id => testOneAgent(id)));
}

function openOnboarding() {
  if (!onboardingDialog || !state) return;
  if (!onboardingDialog.open) onboardingDialog.showModal();
  renderOnboarding();
  recheckAll().catch(showError);
}

function readyCountLightweight() {
  if (!state || !state.tools || !state.tools.agents) return 0;
  return Object.values(state.tools.agents).filter(a => a && a.ok).length;
}

function maybeAutoOpenOnboarding() {
  let done = false;
  try { done = localStorage.getItem("consensus_onboarding_done") === "1"; } catch {}
  if (!done || readyCountLightweight() < minAgents()) {
    openOnboarding();
  }
}

if (recheckAllBtn) recheckAllBtn.addEventListener("click", () => recheckAll().catch(showError));
if (finishOnboardingBtn) {
  finishOnboardingBtn.addEventListener("click", () => {
    try { localStorage.setItem("consensus_onboarding_done", "1"); } catch {}
    if (onboardingDialog) onboardingDialog.close();
  });
}
onClick("closeOnboardingBtn", () => { if (onboardingDialog) onboardingDialog.close(); });
onClick("openOnboardingBtn", () => openOnboarding());

setMode("audit");
refresh().then(() => maybeAutoOpenOnboarding()).catch(showError);
setInterval(() => refresh({ quiet: true }).catch(() => {}), 3000);
