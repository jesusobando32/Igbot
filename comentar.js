require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { chromium } = require('playwright');

// ============================================================================
// Configuración y Rutas de Archivos
// ============================================================================
const SESSIONS_DIR = path.join(__dirname, 'sesiones');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const CONFIG = {
  sessionFile: path.join(__dirname, 'sesion_ig.json'),
  sessionsDir: SESSIONS_DIR,
  savedUsersFile: path.join(__dirname, 'usuarios_guardados.json'),
  statsFile: path.join(__dirname, 'estadisticas.json'),
  panelConfigFile: path.join(__dirname, 'config_panel.json'),
  errorScreenshot: path.join(__dirname, 'error_screenshot.png'),
  panelHtmlFile: path.join(__dirname, 'panel.html'),
  dashboardHtmlFile: path.join(__dirname, 'dashboard.html'),
  loginUrl: 'https://www.instagram.com/accounts/login/',
  homeUrl: 'https://www.instagram.com/',
  viewport: { width: 1366, height: 768 },
  defaultMinDelay: 65,
  defaultMaxDelay: 135,
  defaultUsers: [
    '@jesus__obando',
    '@ypetto',
    '@leoibarrap',
    '@leydimar_obando',
    '@daveecr_',
    '@sebastian_llambi',
    '@caraujo_210',
  ],
};

// ============================================================================
// Persistencia de Configuración del Panel (Multicuentas + Telegram)
// ============================================================================
function loadPanelConfig() {
  const defaultCfg = {
    accounts: [
      {
        id: 'principal',
        label: 'Cuenta Principal',
        sessionPath: CONFIG.sessionFile,
      },
    ],
    telegram: {
      botToken: '',
      chatId: '',
      enabled: false,
    },
  };

  try {
    if (fs.existsSync(CONFIG.panelConfigFile)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG.panelConfigFile, 'utf8'));
      const accounts = Array.isArray(parsed.accounts) && parsed.accounts.length > 0
        ? parsed.accounts
        : defaultCfg.accounts;
      // Garantizar que siempre exista la cuenta principal
      if (!accounts.some((a) => a.id === 'principal')) {
        accounts.unshift(defaultCfg.accounts[0]);
      }
      return {
        accounts,
        telegram: { ...defaultCfg.telegram, ...(parsed.telegram || {}) },
      };
    }
  } catch {}
  return defaultCfg;
}

function savePanelConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG.panelConfigFile, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {}
}

let PANEL_CONFIG = loadPanelConfig();

function getAccountStatusList() {
  PANEL_CONFIG = loadPanelConfig();
  return PANEL_CONFIG.accounts.map((acc) => ({
    id: acc.id,
    label: acc.label,
    sessionPath: acc.sessionPath,
    hasSession: fs.existsSync(acc.sessionPath),
  }));
}

// ============================================================================
// Persistencia de Estadísticas y Catálogo/Galería de Posts
// ============================================================================
function loadStats() {
  try {
    if (fs.existsSync(CONFIG.statsFile)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG.statsFile, 'utf8'));
      return {
        totalHistoricalComments: Number(parsed.totalHistoricalComments) || 0,
        tagCounts: parsed.tagCounts && typeof parsed.tagCounts === 'object' ? parsed.tagCounts : {},
        myCommentsByPost:
          parsed.myCommentsByPost && typeof parsed.myCommentsByPost === 'object'
            ? parsed.myCommentsByPost
            : {},
        postsCatalog:
          parsed.postsCatalog && typeof parsed.postsCatalog === 'object'
            ? parsed.postsCatalog
            : {},
      };
    }
  } catch {}
  return { totalHistoricalComments: 0, tagCounts: {}, myCommentsByPost: {}, postsCatalog: {} };
}

const ANALYTICS = {
  sessionComments: 0,
  ...loadStats(),
};

function saveStats() {
  try {
    fs.writeFileSync(
      CONFIG.statsFile,
      JSON.stringify(
        {
          totalHistoricalComments: ANALYTICS.totalHistoricalComments,
          tagCounts: ANALYTICS.tagCounts,
          myCommentsByPost: ANALYTICS.myCommentsByPost,
          postsCatalog: ANALYTICS.postsCatalog,
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {}
}

function normalizePostKey(url) {
  const match = String(url || '').match(/instagram\.com\/(?:p|reel|tv)\/([\w-]+)/i);
  return match ? match[1] : String(url || '').trim();
}

function upsertPostInCatalog(postUrl, patch = {}) {
  const key = normalizePostKey(postUrl);
  if (!key) return null;
  const existing = ANALYTICS.postsCatalog[key] || {
    postKey: key,
    postUrl,
    author: '',
    caption: '',
    thumbnail: '',
    myComments: ANALYTICS.myCommentsByPost[key] || 0,
    postTotalComments: null,
    probabilities: { rawPercent: 0, estimatedRealPercent: 0, oneInX: null },
    detectedRules: null,
    savedConfig: {},
    updatedAt: new Date().toISOString(),
  };

  const merged = {
    ...existing,
    ...patch,
    postKey: key,
    postUrl: postUrl || existing.postUrl,
    savedConfig: {
      ...(existing.savedConfig || {}),
      ...(patch.savedConfig || {}),
    },
    updatedAt: new Date().toISOString(),
  };

  if (!patch.thumbnail && existing.thumbnail) merged.thumbnail = existing.thumbnail;
  if (!patch.author && existing.author) merged.author = existing.author;
  if (!patch.caption && existing.caption) merged.caption = existing.caption;
  if (!patch.detectedRules && existing.detectedRules) merged.detectedRules = existing.detectedRules;

  ANALYTICS.postsCatalog[key] = merged;
  saveStats();
  return merged;
}

function recordCommentAnalytics(taggedUsers = [], postUrl = '') {
  ANALYTICS.sessionComments += 1;
  ANALYTICS.totalHistoricalComments += 1;
  for (const rawUser of taggedUsers) {
    const u = rawUser.startsWith('@') ? rawUser.toLowerCase() : `@${rawUser.toLowerCase()}`;
    ANALYTICS.tagCounts[u] = (ANALYTICS.tagCounts[u] || 0) + 1;
  }
  if (postUrl) {
    const key = normalizePostKey(postUrl);
    ANALYTICS.myCommentsByPost[key] = (ANALYTICS.myCommentsByPost[key] || 0) + 1;
    if (ANALYTICS.postsCatalog[key]) {
      ANALYTICS.postsCatalog[key].myComments = ANALYTICS.myCommentsByPost[key];
      ANALYTICS.postsCatalog[key].updatedAt = new Date().toISOString();
    }
  }
  saveStats();
}

function resetAnalytics() {
  ANALYTICS.sessionComments = 0;
  ANALYTICS.totalHistoricalComments = 0;
  ANALYTICS.tagCounts = {};
  ANALYTICS.myCommentsByPost = {};
  for (const key of Object.keys(ANALYTICS.postsCatalog)) {
    ANALYTICS.postsCatalog[key].myComments = 0;
    ANALYTICS.postsCatalog[key].probabilities = { rawPercent: 0, estimatedRealPercent: 0, oneInX: null };
  }
  saveStats();
}

// ============================================================================
// Persistencia de Usuarios (2 Grupos: Frecuentes 5x vs Ocasionales 1x + Cooldown)
// ============================================================================
function normalizeHandle(raw) {
  const clean = String(raw || '').trim().replace(/\s+/g, '');
  if (!clean) return '';
  return clean.startsWith('@') ? clean.toLowerCase() : `@${clean.toLowerCase()}`;
}

function loadSavedUsersGroups() {
  try {
    if (fs.existsSync(CONFIG.savedUsersFile)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG.savedUsersFile, 'utf8'));
      if (Array.isArray(parsed)) {
        return {
          frequentUsers: parsed.slice(0, 4).map(normalizeHandle).filter(Boolean),
          occasionalUsers: parsed.slice(4).map(normalizeHandle).filter(Boolean),
          penalizedUsers: {},
        };
      }
      if (parsed && typeof parsed === 'object') {
        return {
          frequentUsers: Array.isArray(parsed.frequentUsers)
            ? [...new Set(parsed.frequentUsers.map(normalizeHandle).filter(Boolean))]
            : CONFIG.defaultUsers.slice(0, 4),
          occasionalUsers: Array.isArray(parsed.occasionalUsers)
            ? [...new Set(parsed.occasionalUsers.map(normalizeHandle).filter(Boolean))]
            : CONFIG.defaultUsers.slice(4),
          penalizedUsers:
            parsed.penalizedUsers && typeof parsed.penalizedUsers === 'object'
              ? parsed.penalizedUsers
              : {},
        };
      }
    }
  } catch {}
  return {
    frequentUsers: CONFIG.defaultUsers.slice(0, 4),
    occasionalUsers: CONFIG.defaultUsers.slice(4),
    penalizedUsers: {},
  };
}

function saveUsersGroupsToDisk(groups) {
  const current = loadSavedUsersGroups();
  const frequentUsers = Array.isArray(groups.frequentUsers)
    ? [...new Set(groups.frequentUsers.map(normalizeHandle).filter(Boolean))]
    : current.frequentUsers;
  const occasionalSet = new Set(
    (Array.isArray(groups.occasionalUsers) ? groups.occasionalUsers : current.occasionalUsers)
      .map(normalizeHandle)
      .filter((u) => u && !frequentUsers.includes(u))
  );
  const penalizedUsers =
    groups.penalizedUsers !== undefined ? groups.penalizedUsers : current.penalizedUsers;

  const dataToSave = {
    frequentUsers,
    occasionalUsers: [...occasionalSet],
    penalizedUsers,
  };
  fs.writeFileSync(CONFIG.savedUsersFile, JSON.stringify(dataToSave, null, 2), 'utf8');
  return dataToSave;
}

function demoteUserToOccasionalMinWeight(rawUser, reason = 'Restricción/bloqueo detectado en IG') {
  const u = normalizeHandle(rawUser);
  if (!u) return null;
  const groups = loadSavedUsersGroups();

  groups.frequentUsers = groups.frequentUsers.filter((item) => item !== u);
  if (!groups.occasionalUsers.includes(u)) {
    groups.occasionalUsers.push(u);
  }

  const prev = groups.penalizedUsers[u] || { strikes: 0 };
  groups.penalizedUsers[u] = {
    weight: 0.15,
    strikes: (prev.strikes || 0) + 1,
    reason,
    updatedAt: new Date().toISOString(),
  };

  saveUsersGroupsToDisk(groups);
  const msg = `⚠️ [Contingencia] Usuario ${u} movido automáticamente a Ocasionales con peso mínimo (0.15x). Motivo: ${reason}`;
  console.warn(msg);
  sendTelegramNotification(msg);
  return groups;
}

function loadSavedUsers() {
  const { frequentUsers, occasionalUsers } = loadSavedUsersGroups();
  return [...frequentUsers, ...occasionalUsers];
}

// ============================================================================
// Notificaciones y Control Remoto por Telegram (Desde tu Teléfono)
// ============================================================================
let lastTelegramUpdateId = 0;

function telegramApiRequest(botToken, method, payload = null) {
  return new Promise((resolve) => {
    if (!botToken) return resolve(null);
    const bodyData = payload ? JSON.stringify(payload) : null;
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/${method}`,
        method: payload ? 'POST' : 'GET',
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyData),
            }
          : {},
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function sendTelegramNotification(text, forceToken = null, forceChatId = null) {
  const cfg = PANEL_CONFIG.telegram || {};
  const token = forceToken || cfg.botToken;
  const chatId = forceChatId || cfg.chatId;
  if (!token || !chatId) return { ok: false, error: 'Falta Bot Token o Chat ID' };
  if (!forceToken && !cfg.enabled) return { ok: false, error: 'Notificaciones desactivadas' };

  const res = await telegramApiRequest(token, 'sendMessage', {
    chat_id: chatId,
    text,
  });
  return res && res.ok ? { ok: true } : { ok: false, error: res?.description || 'Error en API de Telegram' };
}

function startTelegramRemoteControlLoop(onRemoteStartPost, onRemoteStopAll) {
  setInterval(async () => {
    const cfg = PANEL_CONFIG.telegram || {};
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return;

    const data = await telegramApiRequest(
      cfg.botToken,
      `getUpdates?offset=${lastTelegramUpdateId + 1}&timeout=1`
    );
    if (!data || !data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      lastTelegramUpdateId = Math.max(lastTelegramUpdateId, update.update_id);
      const msg = update.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== String(cfg.chatId).trim()) continue;

      const text = msg.text.trim();

      if (text === '/estado' || text === '/status') {
        const activeList = Array.from(ACTIVE_JOBS.values());
        const summary =
          activeList.length === 0
            ? '📭 No hay sorteos activos en este momento.'
            : activeList
                .map(
                  (j) =>
                    `${j.running ? '🔄' : '✅'} Post #${j.id} (${j.accountLabel}): ${j.completed}/${j.total} — Prob: ${
                      j.probabilities?.estimatedRealPercent || 0
                    }%\n   ${j.phaseMessage}`
                )
                .join('\n\n');
        await sendTelegramNotification(
          `📊 ESTADO DEL BOT:\n• Sesión: ${ANALYTICS.sessionComments} msjs\n• Histórico: ${ANALYTICS.totalHistoricalComments} msjs\n\n${summary}`,
          cfg.botToken,
          cfg.chatId
        );
      } else if (text === '/detener' || text === '/stop') {
        onRemoteStopAll();
        await sendTelegramNotification('⏹️ Todos los posts activos han sido detenidos desde tu teléfono.', cfg.botToken, cfg.chatId);
      } else if (/instagram\.com\/(p|reel|tv)\//i.test(text)) {
        // Si el usuario envía un link de Instagram desde el teléfono: "https://instagram.com/p/XXXX/ Mi mensaje opcional"
        const parts = text.split(/\s+/);
        const urlPart = parts.find((p) => /instagram\.com\/(p|reel|tv)\//i.test(p));
        const customMsg = parts.filter((p) => p !== urlPart).join(' ').trim();

        await sendTelegramNotification(
          `📲 Link recibido desde tu teléfono:\n${urlPart}\n🔍 Analizando reglas del sorteo e iniciando automáticamente...`,
          cfg.botToken,
          cfg.chatId
        );
        onRemoteStartPost(urlPart, customMsg);
      } else if (text === '/ayuda' || text === '/start') {
        await sendTelegramNotification(
          '🤖 Comandos de Control Remoto:\n' +
          '• Envíame cualquier link de un post/reel de Instagram (opcionalmente seguido de un mensaje) y lo iniciaré automáticamente.\n' +
          '• /estado — Ver progreso y probabilidad de ganar\n' +
          '• /detener — Detener todas las tandas activas',
          cfg.botToken,
          cfg.chatId
        );
      }
    }
  }, 4000);
}

// ============================================================================
// Estado Global de Tareas y Coordinador de Turnos (Mutex)
// ============================================================================
const [, , initialUrl = '', initialComment = ''] = process.argv;
let nextJobId = 1;
const ACTIVE_JOBS = new Map();
const GLOBAL_LOGS = [];
const ACCOUNT_CONTEXTS = new Map(); // accountId -> { context, loginPage, label, sessionPath }

let typingQueue = Promise.resolve();
let lastPublishTimestamp = 0;

function acquireTypingTurn(job, taskFn) {
  const run = async () => {
    if (job.cancelRequested) return;

    const elapsedMs = Date.now() - lastPublishTimestamp;
    const minGapMs = getRandomInt(12000, 20000);
    if (lastPublishTimestamp > 0 && elapsedMs < minGapMs) {
      const waitGapSec = Math.ceil((minGapMs - elapsedMs) / 1000);
      await sleepJobWithCountdown(
        job,
        waitGapSec,
        `🛡️ Separación anti-spam tras envío en otro post`
      );
    }

    if (job.cancelRequested) return;
    await taskFn();
    lastPublishTimestamp = Date.now();
  };

  const queued = typingQueue.then(run, run);
  typingQueue = queued.catch(() => {});
  return queued;
}

function getRandomInt(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

// ============================================================================
// Algoritmo de Muestreo Ponderado + Cooldown + Rotación de Orden
// ============================================================================
function pickWeightedUniqueUsers({
  frequentUsers = [],
  occasionalUsers = [],
  penalizedUsers = {},
  count = 2,
  recentTurnMap = new Map(),
  currentTurn = 1,
  cooldownTurns = 4,
  excludedInTurn = new Set(),
  lastKey = '',
}) {
  const allCandidates = [...new Set([...frequentUsers, ...occasionalUsers])]
    .map(normalizeHandle)
    .filter((u) => u && !excludedInTurn.has(u));

  if (allCandidates.length === 0 || count <= 0) return [];
  const safeCount = Math.min(count, allCandidates.length);
  const freqSet = new Set(frequentUsers.map(normalizeHandle));

  let bestPicked = [];

  for (let attempt = 0; attempt < 6; attempt++) {
    const pool = [...allCandidates];
    const picked = [];

    for (let k = 0; k < safeCount; k++) {
      const weights = pool.map((u) => {
        if (penalizedUsers && penalizedUsers[u]) {
          return Number(penalizedUsers[u].weight) || 0.15;
        }
        if (freqSet.has(u)) {
          return 5.0;
        }
        const lastUsedTurn = recentTurnMap.get(u);
        if (lastUsedTurn !== undefined && currentTurn - lastUsedTurn <= cooldownTurns) {
          return 0.18;
        }
        return 1.0;
      });

      const totalWeight = weights.reduce((acc, w) => acc + w, 0);
      let r = Math.random() * totalWeight;
      let chosenIdx = 0;

      for (let idx = 0; idx < pool.length; idx++) {
        r -= weights[idx];
        if (r <= 0) {
          chosenIdx = idx;
          break;
        }
      }

      picked.push(pool[chosenIdx]);
      pool.splice(chosenIdx, 1);
    }

    bestPicked = picked;
    const currentKey = picked.join(' ');
    if (currentKey !== lastKey || allCandidates.length <= safeCount) {
      break;
    }
  }

  return bestPicked;
}

const GIVEAWAY_EMOJIS = [
  '🔥', '🙌', '✨', '👏', '💯', '🚀', '🎉', '🍀', '⚡', '🤩',
  '💪', '🌟', '🥳', '💥', '🤞', '❤️', '🫶', '🎊', '🏆', '💎',
];

function combineTextAndTags(phrase, selectedUsers, positionMode = 0) {
  const cleanPhrase = (phrase || '').trim();
  if (!cleanPhrase) return selectedUsers.join(' ');
  if (!selectedUsers || selectedUsers.length === 0) return cleanPhrase;

  const mode = positionMode % (selectedUsers.length >= 2 ? 3 : 2);
  if (mode === 0) return `${selectedUsers.join(' ')} ${cleanPhrase}`;
  if (mode === 1) return `${cleanPhrase} ${selectedUsers.join(' ')}`;
  const [firstUser, ...restUsers] = selectedUsers;
  return `${firstUser} ${cleanPhrase} ${restUsers.join(' ')}`;
}

function buildUniqueGiveawayComment({
  frequentUsers = [],
  occasionalUsers = [],
  penalizedUsers = {},
  recentTurnMap = new Map(),
  cooldownTurns = 4,
  excludedInTurn = new Set(),
  tagsPerComment,
  baseComment,
  antiDuplicate = true,
  allowEmojis = true,
  usedSet,
  lastKey = '',
  commentIndex = 1,
}) {
  const phrases = String(baseComment || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  for (let attempt = 0; attempt < 90; attempt++) {
    const selectedUsers = pickWeightedUniqueUsers({
      frequentUsers,
      occasionalUsers,
      penalizedUsers,
      count: tagsPerComment,
      recentTurnMap,
      currentTurn: commentIndex,
      cooldownTurns,
      excludedInTurn,
      lastKey,
    });
    const tagsPart = selectedUsers.join(' ');
    const chosenPhrase =
      phrases.length > 0 ? phrases[(commentIndex + attempt) % phrases.length] : '';

    const positionMode = (commentIndex + attempt) % 3;
    const coreText = combineTextAndTags(chosenPhrase, selectedUsers, positionMode);

    if (!antiDuplicate || !usedSet) {
      return { commentText: coreText, combinationKey: tagsPart, selectedUsers };
    }

    const normalizedCore = coreText.trim().toLowerCase();
    if (!usedSet.has(normalizedCore)) {
      usedSet.add(normalizedCore);
      return { commentText: coreText, combinationKey: tagsPart, selectedUsers };
    }

    let suffix = '';
    if (allowEmojis) {
      const e1 = GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)];
      suffix = attempt < 45 ? e1 : `${e1} !`;
    } else {
      const punct = ['!', '!!', '!', '...'][attempt % 4];
      suffix = punct;
    }

    const candidate =
      attempt % 2 === 0 ? `${coreText} ${suffix}` : `${suffix} ${coreText}`;
    const normalizedCandidate = candidate.trim().toLowerCase();

    if (!usedSet.has(normalizedCandidate)) {
      usedSet.add(normalizedCandidate);
      return { commentText: candidate, combinationKey: tagsPart, selectedUsers };
    }
  }

  const selectedUsers = pickWeightedUniqueUsers({
    frequentUsers,
    occasionalUsers,
    penalizedUsers,
    count: tagsPerComment,
    recentTurnMap,
    currentTurn: commentIndex,
    cooldownTurns,
    excludedInTurn,
    lastKey,
  });
  const tagsPart = selectedUsers.join(' ');
  const chosenPhrase = phrases.length > 0 ? phrases[0] : '';
  const base = combineTextAndTags(chosenPhrase, selectedUsers, commentIndex % 3);
  const fallbackText = allowEmojis
    ? `${base} ${GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)]}`
    : `${base} !`;
  if (usedSet) usedSet.add(fallbackText.trim().toLowerCase());
  return { commentText: fallbackText, combinationKey: tagsPart, selectedUsers };
}

// ============================================================================
// Simulación Humana Avanzada: Typos + Backspace y Micro-Movimientos / Scroll
// ============================================================================
const QWERTY_NEIGHBORS = {
  a: 'sq', b: 'vn', c: 'xv', d: 'sf', e: 'wr', f: 'dg', g: 'fh', h: 'gj',
  i: 'uo', j: 'hk', k: 'jl', l: 'k', m: 'n', n: 'bm', o: 'ip', p: 'o',
  q: 'wa', r: 'et', s: 'ad', t: 'ry', u: 'yi', v: 'cb', w: 'qe', x: 'zc',
  y: 'tu', z: 'x',
};

/**
 * Escribe texto carácter por carácter con simulación humana avanzada:
 * - Delay variable por tecla (65ms-135ms) y pausas naturales en espacios y '@'.
 * - Si `simulateTypos` está activo, en letras normales (fuera de @usernames)
 *   ocasionalmente comete un error humano con una tecla vecina, hace una breve
 *   pausa, presiona Backspace y escribe la letra correcta.
 */
async function humanType(
  locator,
  text,
  minDelay = 65,
  maxDelay = 135,
  shouldCancel = () => false,
  simulateTypos = true
) {
  let insideHandle = false;

  for (let i = 0; i < text.length; i++) {
    if (shouldCancel()) {
      throw new Error('Envío detenido manualmente por el usuario.');
    }

    const char = text[i];
    if (char === '@') insideHandle = true;
    if (char === ' ') insideHandle = false;

    const lower = char.toLowerCase();
    // Simular typo humano (~6% de probabilidad en letras fuera de @usuario) y corregirlo con Backspace
    if (
      simulateTypos &&
      !insideHandle &&
      QWERTY_NEIGHBORS[lower] &&
      Math.random() < 0.06
    ) {
      const neighbors = QWERTY_NEIGHBORS[lower];
      const wrongChar = neighbors[Math.floor(Math.random() * neighbors.length)];
      await locator.pressSequentially(wrongChar, { delay: getRandomInt(minDelay, maxDelay) });
      await new Promise((r) => setTimeout(r, getRandomInt(140, 260)));
      await locator.press('Backspace');
      await new Promise((r) => setTimeout(r, getRandomInt(90, 170)));
    }

    let delay = getRandomInt(minDelay, maxDelay);
    if (char === ' ' || char === '@') {
      delay += getRandomInt(40, 110);
    }
    await locator.pressSequentially(char, { delay });
  }
}

/**
 * Durante los tiempos de espera entre comentarios, realiza ocasionalmente
 * un micro-movimiento de mouse o pequeño scroll suave para simular lectura humana.
 */
async function performMicroHumanIdleAction(page) {
  try {
    if (!page || page.isClosed()) return;
    if (Math.random() < 0.5) {
      const x = getRandomInt(280, 920);
      const y = getRandomInt(200, 620);
      await page.mouse.move(x, y, { steps: getRandomInt(4, 10) });
    } else {
      const deltaY = getRandomInt(-110, 140);
      await page.mouse.wheel(0, deltaY);
    }
  } catch {}
}

async function sleepJobWithCountdown(job, totalSeconds, prefixText) {
  for (let remaining = totalSeconds; remaining > 0; remaining--) {
    if (job.cancelRequested) {
      throw new Error('Envío detenido manualmente por el usuario.');
    }
    job.phaseMessage = `${prefixText} (${remaining}s restantes)...`;
    if (remaining % 18 === 0 && job.page) {
      await performMicroHumanIdleAction(job.page);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ============================================================================
// Auto-Detector de Reglas del Sorteo, Fechas de Cierre ("hasta el tal día") y Auto-Like
// ============================================================================
const MONTHS_ES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

const WORD_NUMBERS_ES = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  one: 1, two: 2, three: 3, four: 4, five: 5,
};

/**
 * Analiza el texto/descripción de un post de sorteo para detectar:
 * 1. Cuántos amigos pide etiquetar (`detectedTagsCount`).
 * 2. Si pide comentar una palabra o frase específica (`detectedKeyword`).
 * 3. Si el sorteo ya fue anunciado como cerrado (`isClosed`, `closeReason`).
 * 4. Si menciona fecha límite ("hasta el 20 de noviembre", "sorteo el 18/11") y si ya venció.
 */
function parseGiveawayRulesFromCaption(captionText = '') {
  const clean = String(captionText || '');
  const result = {
    detectedTagsCount: null,
    detectedKeyword: '',
    isClosed: false,
    closeReason: '',
    deadlineText: '',
    deadlineIso: '',
    summary: [],
  };

  if (!clean) return result;

  // 1. Verificar frases explícitas de sorteo cerrado / finalizado
  const closedRegex =
    /(?:sorteo\s+cerrado|concurso\s+cerrado|sorteo\s+finalizado|giveaway\s+closed|ganador(?:es)?\s*:\s*@|ya\s+tenemos\s+ganador|sorteo\s+realizado)/i;
  const closedMatch = clean.match(closedRegex);
  if (closedMatch) {
    result.isClosed = true;
    result.closeReason = `La descripción indica "${closedMatch[0].trim()}"`;
    result.summary.push(`🛑 ${result.closeReason}`);
  }

  // 2. Detectar fecha límite ("hasta el 20 de noviembre", "cierra el 15 de noviembre", "finaliza el 22/11")
  const now = new Date();
  const currentYear = now.getFullYear();

  const dateEsRegex =
    /(?:hasta\s+el|cierra\s+el|finaliza\s+el|termina\s+el|sorteo\s+el|ganador(?:es)?\s+el|anunciamos\s+el|válido\s+hasta\s+el)\s+(?:día\s+|lunes\s+|martes\s+|miércoles\s+|miercoles\s+|jueves\s+|viernes\s+|sábado\s+|sabado\s+|domingo\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de(?:l)?\s+(\d{4}))?/i;

  const dateEsMatch = clean.match(dateEsRegex);
  if (dateEsMatch) {
    const day = parseInt(dateEsMatch[1], 10);
    const monthName = dateEsMatch[2].toLowerCase();
    const monthIdx = MONTHS_ES[monthName];
    const year = dateEsMatch[3] ? parseInt(dateEsMatch[3], 10) : currentYear;

    if (monthIdx !== undefined && day >= 1 && day <= 31) {
      const deadlineDate = new Date(year, monthIdx, day, 23, 59, 59);
      result.deadlineText = `${day} de ${monthName} de ${year}`;
      result.deadlineIso = deadlineDate.toISOString();

      if (deadlineDate.getTime() < now.getTime()) {
        result.isClosed = true;
        result.closeReason = `La fecha límite del sorteo venció el ${result.deadlineText}`;
        result.summary.push(`🛑 Sorteo vencido (${result.deadlineText})`);
      } else {
        result.summary.push(`📅 Fecha límite detectada: hasta el ${result.deadlineText}`);
      }
    }
  } else {
    // Formato numérico: "hasta el 25/11" o "finaliza el 25/11/2026"
    const numericDateRegex =
      /(?:hasta\s+el|cierra\s+el|finaliza\s+el|termina\s+el|sorteo\s+el)\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i;
    const numMatch = clean.match(numericDateRegex);
    if (numMatch) {
      const day = parseInt(numMatch[1], 10);
      const monthIdx = parseInt(numMatch[2], 10) - 1;
      let year = numMatch[3] ? parseInt(numMatch[3], 10) : currentYear;
      if (year < 100) year += 2000;

      if (monthIdx >= 0 && monthIdx <= 11 && day >= 1 && day <= 31) {
        const deadlineDate = new Date(year, monthIdx, day, 23, 59, 59);
        result.deadlineText = `${day}/${monthIdx + 1}/${year}`;
        result.deadlineIso = deadlineDate.toISOString();

        if (deadlineDate.getTime() < now.getTime()) {
          result.isClosed = true;
          result.closeReason = `La fecha límite del sorteo venció el ${result.deadlineText}`;
          result.summary.push(`🛑 Sorteo vencido (${result.deadlineText})`);
        } else {
          result.summary.push(`📅 Fecha límite detectada: hasta el ${result.deadlineText}`);
        }
      }
    }
  }

  // 3. Detectar cuántos amigos pide etiquetar ("etiqueta a 2 amigos", "menciona a tres personas", "tag 2 friends")
  const mentionRuleRegex =
    /(?:etiqueta(?:r|ndo)?|menciona(?:r|ndo)?|tag(?:gear|ging)?|comenta(?:r)?\s+etiquetando)\s+(?:a\s+)?(\d+|un|uno|una|dos|tres|cuatro|cinco|one|two|three|four|five)\s+(?:amigo|persona|cuenta|usuario|friend|people)/i;
  const mentionMatch = clean.match(mentionRuleRegex);
  if (mentionMatch) {
    const rawNum = mentionMatch[1].toLowerCase();
    const count = WORD_NUMBERS_ES[rawNum] || parseInt(rawNum, 10);
    if (count >= 1 && count <= 10) {
      result.detectedTagsCount = count;
      result.summary.push(`👤 Pide etiquetar a ${count} amigo(s)`);
    }
  }

  // 4. Detectar si pide comentar una palabra clave entre comillas ('comenta la palabra "QUIERO"')
  const keywordRegex =
    /(?:comenta(?:r)?|escribe|escribir|pon(?:er)?)\s+(?:la\s+palabra\s+|la\s+frase\s+)?["“«']([^"”»'\n]{2,28})["”»']/i;
  const kwMatch = clean.match(keywordRegex);
  if (kwMatch) {
    result.detectedKeyword = kwMatch[1].trim();
    result.summary.push(`💬 Pide comentar: "${result.detectedKeyword}"`);
  }

  return result;
}

/**
 * Extrae la descripción completa del post en la página actual y analiza las reglas del sorteo.
 */
async function extractAndAnalyzeGiveawayRules(page) {
  try {
    const fullCaption = await page.evaluate(() => {
      const metaDesc =
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        '';
      const articleText = document.querySelector('article, main')?.innerText || '';
      return `${metaDesc}\n${articleText.slice(0, 3500)}`;
    });

    return parseGiveawayRulesFromCaption(fullCaption);
  } catch {
    return parseGiveawayRulesFromCaption('');
  }
}

/**
 * Da Like ❤️ automáticamente al post (si aún no tiene Like) y sigue a la cuenta organizadora
 * si aparece el botón "Seguir" / "Follow" en la cabecera del post.
 */
async function performAutoLikeAndFollow(page) {
  const actionsDone = [];
  try {
    // 1. Verificar si aún no le hemos dado Like (si ya tiene Like el aria-label cambia a "Ya no me gusta" o "Unlike")
    const likeSvg = page.locator(
      'article section svg[aria-label="Me gusta"], ' +
      'article section svg[aria-label="Like"], ' +
      'main section svg[aria-label="Me gusta"], ' +
      'main section svg[aria-label="Like"]'
    ).first();

    if (await likeSvg.isVisible({ timeout: 2500 }).catch(() => false)) {
      const likeBtn = likeSvg.locator('xpath=ancestor::div[@role="button" or self::button][1]').first();
      if (await likeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await likeBtn.click().catch(() => {});
        actionsDone.push('❤️ Like dado al post');
        await page.waitForTimeout(900);
      }
    }
  } catch {}

  try {
    // 2. Verificar si en el header del post aparece el botón "Seguir" / "Follow" del organizador
    const followBtn = page.locator(
      'article header button:text-is("Seguir"), ' +
      'article header button:text-is("Follow"), ' +
      'article header div[role="button"]:text-is("Seguir"), ' +
      'article header div[role="button"]:text-is("Follow"), ' +
      'main header button:text-is("Seguir"), ' +
      'main header button:text-is("Follow")'
    ).first();

    if (await followBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await followBtn.click().catch(() => {});
      actionsDone.push('➕ Siguiendo al organizador');
      await page.waitForTimeout(900);
    }
  } catch {}

  return actionsDone;
}

// ============================================================================
// Funciones de Modales, Conteo de Comentarios y Miniaturas
// ============================================================================
async function dismissCookiesModal(page) {
  try {
    const cookieButton = page.locator(
      'button:has-text("Permitir todas las cookies"), ' +
      'button:has-text("Allow all cookies"), ' +
      'button:has-text("Permitir cookies esenciales y opcionales"), ' +
      'button:has-text("Allow essential and optional cookies"), ' +
      'button:has-text("Aceptar todas")'
    ).first();

    if (await cookieButton.isVisible({ timeout: 2000 })) {
      await cookieButton.click();
      await page.waitForTimeout(800);
    }
  } catch {}
}

async function dismissPostLoginModals(page) {
  for (let i = 0; i < 2; i++) {
    try {
      const notNowButton = page.locator(
        'div[role="button"]:has-text("Ahora no"), ' +
        'button:has-text("Ahora no"), ' +
        'div[role="button"]:has-text("Not now"), ' +
        'button:has-text("Not now"), ' +
        'button:has-text("Not Now")'
      ).first();

      if (await notNowButton.isVisible({ timeout: 2000 })) {
        await notNowButton.click();
        await page.waitForTimeout(900);
      }
    } catch {}
  }
}

async function startNonBlockingLogin(igPage, context, sessionSavePath, onAuthenticated) {
  const username = process.env.IG_USERNAME;
  const password = process.env.IG_PASSWORD;
  const hasEnvCredentials =
    username &&
    password &&
    username !== 'tu_usuario_aqui' &&
    password !== 'tu_password_aqui' &&
    sessionSavePath === CONFIG.sessionFile;

  console.log('🔐 Abriendo página de inicio de sesión de Instagram...');
  await igPage.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await dismissCookiesModal(igPage);

  if (hasEnvCredentials) {
    try {
      const userInput = igPage.locator(
        'input[name="username"], input[name="email"], input[aria-label*="usuario" i], input[aria-label*="username" i]'
      ).first();
      const passInput = igPage.locator(
        'input[name="password"], input[name="pass"], input[type="password"]'
      ).first();

      if (await userInput.isVisible({ timeout: 6000 })) {
        await userInput.click();
        await humanType(userInput, username, 60, 110, () => false, false);
        await passInput.click();
        await humanType(passInput, password, 60, 110, () => false, false);

        const submitButton = igPage.locator(
          'button[type="submit"], ' +
          'div[role="button"]:has-text("Iniciar sesión"), ' +
          'div[role="button"]:has-text("Log in")'
        ).first();

        await submitButton.click();
      }
    } catch {}
  }

  (async () => {
    const authenticatedIndicator = igPage.locator(
      'svg[aria-label="Inicio"], ' +
      'svg[aria-label="Home"], ' +
      'svg[aria-label="Buscar"], ' +
      'svg[aria-label="Search"], ' +
      'a[href="/explore/"]'
    ).first();

    while (!igPage.isClosed()) {
      try {
        if (await authenticatedIndicator.isVisible({ timeout: 2000 })) {
          await dismissPostLoginModals(igPage);
          await context.storageState({ path: sessionSavePath });
          console.log(`💾 Sesión guardada automáticamente en: ${sessionSavePath}`);
          if (onAuthenticated) await onAuthenticated();
          break;
        }
      } catch {}
      await igPage.waitForTimeout(2500).catch(() => {});
    }
  })();
}

async function extractPostCommentCount(page, postUrl = '') {
  try {
    const shortcode = normalizePostKey(postUrl);
    const detected = await page.evaluate((code) => {
      function parseHumanNumber(raw) {
        if (!raw) return null;
        const clean = String(raw).trim().toLowerCase();
        if (clean.includes('mil') || clean.endsWith('k')) {
          const num = parseFloat(clean.replace(/[^\d.,]/g, '').replace(',', '.'));
          return Number.isNaN(num) ? null : Math.round(num * 1000);
        }
        const digitsOnly = clean.replace(/[^\d]/g, '');
        return digitsOnly ? parseInt(digitsOnly, 10) : null;
      }

      const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (code && !txt.includes(code)) continue;
        const match1 = txt.match(/"comment_count"\s*:\s*(\d+)/);
        if (match1) return parseInt(match1[1], 10);
        const match2 = txt.match(/"edge_media_to_parent_comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
        if (match2) return parseInt(match2[1], 10);
        const match3 = txt.match(/"edge_media_to_comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
        if (match3) return parseInt(match3[1], 10);
      }

      for (const s of scripts) {
        const txt = s.textContent || '';
        const match1 = txt.match(/"comment_count"\s*:\s*(\d+)/);
        if (match1) return parseInt(match1[1], 10);
      }

      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';
      const metaMatch = metaDesc.match(/([\d.,]+\s*(?:mil|k)?)\s+(?:comentarios|comments)/i);
      if (metaMatch) {
        const parsed = parseHumanNumber(metaMatch[1]);
        if (parsed !== null) return parsed;
      }

      const bodyText = document.body ? document.body.innerText : '';
      const viewAllMatch = bodyText.match(
        /(?:Ver los|Ver todos los|View all)\s+([\d.,]+\s*(?:mil|k)?)\s+(?:comentarios|comments)/i
      );
      if (viewAllMatch) {
        const parsed = parseHumanNumber(viewAllMatch[1]);
        if (parsed !== null) return parsed;
      }

      return null;
    }, shortcode);

    return typeof detected === 'number' && !Number.isNaN(detected) ? detected : null;
  } catch {
    return null;
  }
}

async function extractPostDetailsAndThumbnail(page) {
  let author = '';
  let caption = '';
  let thumbnail = '';

  try {
    const meta = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';

      let foundAuthor = '';
      const headerLink = document.querySelector('article header a[href^="/"], main header a[href^="/"]');
      if (headerLink && headerLink.textContent) {
        foundAuthor = '@' + headerLink.textContent.trim().replace(/^@/, '');
      } else if (ogTitle) {
        const m = ogTitle.match(/^([^•(]+?)\s*(?:on Instagram|en Instagram)/i);
        if (m) foundAuthor = m[1].trim();
      }

      let foundCaption = metaDesc;
      const quoteMatch = metaDesc.match(/:\s*"([^"]+)"/);
      if (quoteMatch) {
        foundCaption = quoteMatch[1];
      } else if (ogTitle) {
        foundCaption = ogTitle;
      }

      return {
        author: foundAuthor.slice(0, 50),
        caption: foundCaption.slice(0, 160),
      };
    });

    author = meta.author || '';
    caption = meta.caption || '';
  } catch {}

  try {
    const mediaLocator = page.locator('article img, article video, main img, main video').first();
    if (await mediaLocator.isVisible({ timeout: 2500 }).catch(() => false)) {
      const buf = await mediaLocator.screenshot({ type: 'jpeg', quality: 55 });
      thumbnail = `data:image/jpeg;base64,${buf.toString('base64')}`;
    } else {
      const buf = await page.screenshot({
        type: 'jpeg',
        quality: 50,
        clip: { x: 80, y: 70, width: 600, height: 450 },
      });
      thumbnail = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
  } catch {}

  return { author, caption, thumbnail };
}

function calculateWinProbabilities(myCommentsCount, postTotalComments) {
  const myCount = Math.max(0, Number(myCommentsCount) || 0);
  const totalPost = Math.max(myCount, Number(postTotalComments) || 0);

  if (totalPost <= 0 || myCount <= 0) {
    return { rawPercent: 0, estimatedRealPercent: 0, oneInX: null };
  }

  const rawPercent = (myCount / totalPost) * 100;
  const otherComments = Math.max(0, totalPost - myCount);
  const validOtherComments = otherComments * 0.75;
  const estimatedRealPercent = (myCount / (myCount + validOtherComments)) * 100;
  const oneInX = Number((100 / estimatedRealPercent).toFixed(1));

  return {
    rawPercent: Number(rawPercent.toFixed(2)),
    estimatedRealPercent: Number(estimatedRealPercent.toFixed(2)),
    oneInX,
  };
}

// ============================================================================
// Manejo de Contingencias / Alertas en Instagram y Publicación
// ============================================================================
async function dismissUnexpectedInstagramAlerts(page) {
  try {
    const closeAlertBtn = page.locator(
      'div[role="dialog"] button:has-text("Aceptar"), ' +
      'div[role="dialog"] button:has-text("OK"), ' +
      'div[role="dialog"] button:has-text("Cerrar"), ' +
      'div[role="dialog"] button:has-text("Close"), ' +
      'div[role="dialog"] button:has-text("Ahora no"), ' +
      'div[role="dialog"] button:has-text("Not now"), ' +
      'div[role="dialog"] div[role="button"]:has-text("Aceptar"), ' +
      'div[role="dialog"] div[role="button"]:has-text("OK"), ' +
      'div[role="dialog"] div[role="button"]:has-text("Cerrar")'
    ).first();

    if (await closeAlertBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
      await closeAlertBtn.click().catch(() => {});
      await page.waitForTimeout(700);
      return true;
    }
  } catch {}
  return false;
}

async function inspectAndDismissPublishAlert(page, selectedUsers = []) {
  try {
    const alertInfo = await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"], div[role="alert"]');
      const dialogText = dialog ? dialog.innerText || '' : '';
      const bodyText = document.body ? document.body.innerText || '' : '';
      return {
        hasDialog: Boolean(dialog),
        dialogText: dialogText.slice(0, 500),
        bodySnippet: bodyText.slice(0, 2500),
      };
    });

    const combinedText = `${alertInfo.dialogText}\n${alertInfo.bodySnippet}`;

    // Verificar si los comentarios fueron cerrados o el sorteo finalizó en vivo
    if (/(?:Se han limitado los comentarios|Comments on this post have been limited|Se desactivaron los comentarios)/i.test(combinedText)) {
      return {
        type: 'giveaway_closed',
        alertText: 'El organizador limitó o cerró los comentarios de este post.',
      };
    }

    const mentionBlockRegex =
      /(?:no se puede mencionar|can't mention|no permite que|doesn't allow|restringi|restricted|no puedes mencionar|cannot mention)/i;

    if (mentionBlockRegex.test(combinedText)) {
      const explicitUsers = [];
      for (const u of selectedUsers) {
        const bareName = u.replace(/^@/, '').toLowerCase();
        if (bareName && combinedText.toLowerCase().includes(bareName)) {
          explicitUsers.push(u);
        }
      }

      await dismissUnexpectedInstagramAlerts(page);
      await page.keyboard.press('Escape').catch(() => {});

      return {
        type: 'mention_blocked',
        alertText: alertInfo.dialogText || 'Restricción de mención detectada en Instagram',
        explicitUsers,
      };
    }

    const rateLimitRegex =
      /(?:Inténtalo de nuevo más tarde|Try Again Later|Restringimos determinadas actividades|We restrict certain activity)/i;

    if (rateLimitRegex.test(combinedText)) {
      await dismissUnexpectedInstagramAlerts(page);
      await page.keyboard.press('Escape').catch(() => {});
      return {
        type: 'rate_limit',
        alertText: alertInfo.dialogText || 'Aviso temporal de frecuencia en Instagram',
      };
    }

    const genericFailRegex = /(?:No se pudo publicar el comentario|Couldn't post comment)/i;
    if (genericFailRegex.test(combinedText)) {
      await dismissUnexpectedInstagramAlerts(page);
      await page.keyboard.press('Escape').catch(() => {});
      return {
        type: 'generic_post_fail',
        alertText: 'No se pudo publicar el comentario en este intento',
      };
    }

    if (alertInfo.hasDialog) {
      await dismissUnexpectedInstagramAlerts(page);
    }
  } catch {}

  return { type: 'none' };
}

async function publicarUnComentarioEnPagina(
  jobPage,
  commentToSend,
  selectedUsers,
  minDelay,
  maxDelay,
  shouldCancel,
  simulateTypos = true
) {
  await dismissUnexpectedInstagramAlerts(jobPage);

  const commentSelector = [
    'textarea[aria-label*="comentario" i]',
    'textarea[aria-label*="comment" i]',
    'textarea[placeholder*="comentario" i]',
    'textarea[placeholder*="comment" i]',
  ].join(', ');

  let commentBox = jobPage.locator(commentSelector).first();
  let isVisible = await commentBox.isVisible({ timeout: 10000 }).catch(() => false);

  if (!isVisible) {
    console.warn('🔄 [Contingencia] Caja de comentarios no visible. Recargando pestaña del post...');
    await jobPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await jobPage.waitForTimeout(2500);
    await dismissCookiesModal(jobPage);
    await dismissPostLoginModals(jobPage);
    await dismissUnexpectedInstagramAlerts(jobPage);

    // Verificar si el sorteo se cerró en la descripción al recargar
    const liveRules = await extractAndAnalyzeGiveawayRules(jobPage);
    if (liveRules.isClosed) {
      return {
        type: 'giveaway_closed',
        alertText: liveRules.closeReason || 'El sorteo figura como cerrado.',
      };
    }

    commentBox = jobPage.locator(commentSelector).first();
    isVisible = await commentBox.isVisible({ timeout: 10000 }).catch(() => false);
    if (!isVisible) {
      throw new Error(
        'No se encontró la caja de comentarios (posiblemente cerraron los comentarios del sorteo).'
      );
    }
  }

  await commentBox.scrollIntoViewIfNeeded();
  await commentBox.click();
  await jobPage.waitForTimeout(350);

  const activeCommentBox = jobPage.locator(commentSelector).first();
  await activeCommentBox.click();
  await activeCommentBox.fill('');

  await humanType(activeCommentBox, commentToSend, minDelay, maxDelay, shouldCancel, simulateTypos);
  await jobPage.waitForTimeout(500);

  const publishButton = jobPage.locator(
    'form div[role="button"]:has-text("Publicar"), ' +
    'form div[role="button"]:has-text("Post"), ' +
    'form button:has-text("Publicar"), ' +
    'form button:has-text("Post"), ' +
    'div[role="button"]:text-is("Publicar"), ' +
    'div[role="button"]:text-is("Post")'
  ).first();

  if (await publishButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await publishButton.click();
  } else {
    await activeCommentBox.press('Enter');
  }

  await jobPage.waitForTimeout(getRandomInt(4500, 6500));

  const alertResult = await inspectAndDismissPublishAlert(jobPage, selectedUsers);
  if (alertResult.type !== 'none') {
    await activeCommentBox.fill('').catch(() => {});
    return alertResult;
  }

  const remainingValue = await activeCommentBox.inputValue().catch(() => '');
  if (remainingValue && remainingValue.trim().length > 0) {
    await activeCommentBox.fill('').catch(() => {});
    return {
      type: 'mention_blocked',
      alertText: 'El comentario no se envió (posible mención restringida o bloqueada)',
      explicitUsers: [],
    };
  }

  return { type: 'none' };
}

// ============================================================================
// Gestor de Contextos por Cuenta (Multicuentas)
// ============================================================================
async function getOrCreateAccountContext(browser, accountId = 'principal') {
  if (ACCOUNT_CONTEXTS.has(accountId)) {
    return ACCOUNT_CONTEXTS.get(accountId);
  }

  PANEL_CONFIG = loadPanelConfig();
  const accInfo =
    PANEL_CONFIG.accounts.find((a) => a.id === accountId) || PANEL_CONFIG.accounts[0];

  const contextOptions = { viewport: CONFIG.viewport };
  if (fs.existsSync(accInfo.sessionPath)) {
    contextOptions.storageState = accInfo.sessionPath;
  }

  const ctx = await browser.newContext(contextOptions);
  const entry = {
    id: accInfo.id,
    label: accInfo.label,
    sessionPath: accInfo.sessionPath,
    context: ctx,
    loginPage: null,
  };
  ACCOUNT_CONTEXTS.set(accInfo.id, entry);
  return entry;
}

// ============================================================================
// Ejecución de Tarea de Post (Con Modo Francotirador, Auto-Reglas y Auto-Like)
// ============================================================================
function crearYEjecutarTareaPost(browser, config) {
  const savedGroups = loadSavedUsersGroups();
  const {
    postUrl,
    accountId = 'principal',
    frequentUsers = savedGroups.frequentUsers,
    occasionalUsers = savedGroups.occasionalUsers,
    cooldownTurns = 4,
    baseComment = '',
    tagsPerComment = 0,
    totalComments = 100,
    scheduledStartTime = '',
    autoDetectRules = true,
    autoLikeFollow = true,
    simulateTypos = true,
    antiDuplicate = true,
    allowEmojis = true,
    minDelay = 65,
    maxDelay = 135,
    minIntervalSec = 38,
    maxIntervalSec = 75,
    batchSize = 10,
    minBatchPauseMin = 4,
    maxBatchPauseMin = 7,
  } = config;

  const igPostRegex = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+\/?/i;
  if (!igPostRegex.test(postUrl)) {
    throw new Error('La URL no es válida. Debe ser un enlace de post o reel (ej. https://www.instagram.com/p/XXXX/).');
  }

  PANEL_CONFIG = loadPanelConfig();
  const accMeta = PANEL_CONFIG.accounts.find((a) => a.id === accountId) || PANEL_CONFIG.accounts[0];

  const totalUniqueUsersCount = new Set([...frequentUsers, ...occasionalUsers]).size;
  const postKey = normalizePostKey(postUrl);
  const initialMyCount = ANALYTICS.myCommentsByPost[postKey] || 0;

  upsertPostInCatalog(postUrl, {
    myComments: initialMyCount,
    savedConfig: {
      baseComment,
      tagsPerComment,
      totalComments,
      cooldownTurns,
      autoDetectRules,
      autoLikeFollow,
      simulateTypos,
      antiDuplicate,
      allowEmojis,
      minDelay,
      maxDelay,
      minIntervalSec,
      maxIntervalSec,
      batchSize,
      minBatchPauseMin,
      maxBatchPauseMin,
    },
  });

  const jobId = nextJobId++;
  const job = {
    id: jobId,
    accountId: accMeta.id,
    accountLabel: accMeta.label,
    postUrl,
    postKey,
    baseComment,
    tagsPerComment,
    usersCount: totalUniqueUsersCount,
    running: true,
    cancelRequested: false,
    completed: 0,
    total: totalComments,
    postTotalComments: null,
    myTotalInPost: initialMyCount,
    probabilities: { rawPercent: 0, estimatedRealPercent: 0, oneInX: null },
    detectedRulesSummary: '',
    phaseMessage: 'Preparando tarea...',
    error: null,
    page: null,
  };

  ACTIVE_JOBS.set(jobId, job);

  (async () => {
    try {
      // 1. Modo Francotirador: Si tiene fecha/hora programada en el futuro, esperar hasta ese momento
      if (scheduledStartTime) {
        const targetMs = new Date(scheduledStartTime).getTime();
        if (!Number.isNaN(targetMs) && targetMs > Date.now()) {
          const waitSec = Math.ceil((targetMs - Date.now()) / 1000);
          const targetReadable = new Date(targetMs).toLocaleString();
          console.log(`🎯 [Post #${jobId}] Modo Francotirador programado para: ${targetReadable}`);
          await sleepJobWithCountdown(
            job,
            waitSec,
            `🎯 Francotirador esperando hora de inicio (${targetReadable})`
          );
        }
      }

      const accEntry = await getOrCreateAccountContext(browser, accMeta.id);
      const { context, sessionPath } = accEntry;

      const jobPage = await context.newPage();
      job.page = jobPage;

      jobPage.on('response', async (response) => {
        try {
          const url = response.url();
          if (url.includes('graphql') || url.includes('/api/v1/media/') || url.includes('/comments/')) {
            const text = await response.text();
            const m =
              text.match(/"comment_count"\s*:\s*(\d+)/) ||
              text.match(/"edge_media_to_parent_comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
            if (m) {
              const count = parseInt(m[1], 10);
              if (!Number.isNaN(count) && count > 0) {
                job.postTotalComments = Math.max(count, job.myTotalInPost);
                job.probabilities = calculateWinProbabilities(job.myTotalInPost, job.postTotalComments);
              }
            }
          }
        } catch {}
      });

      console.log(`\n🌐 [Post #${jobId} — ${accMeta.label}] Abriendo post: ${postUrl}`);
      await jobPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await jobPage.waitForTimeout(2500);

      await dismissCookiesModal(jobPage);
      await dismissPostLoginModals(jobPage);

      const unavailableMessage = jobPage.locator(
        'text=/Esta página no está disponible|Sorry, this page isn\'t available|Esta cuenta es privada|This account is private/i'
      ).first();

      if (await unavailableMessage.isVisible({ timeout: 2500 }).catch(() => false)) {
        throw new Error('El post no está disponible, fue eliminado o pertenece a una cuenta privada.');
      }

      // 2. Analizar Reglas del Sorteo y Fecha Límite ("hasta el tal día")
      const rules = await extractAndAnalyzeGiveawayRules(jobPage);
      if (rules.summary.length > 0) {
        job.detectedRulesSummary = rules.summary.join(' | ');
        console.log(`🔍 [Post #${jobId}] Reglas detectadas: ${job.detectedRulesSummary}`);
      }

      if (rules.isClosed) {
        throw new Error(`Sorteo finalizado detectado automáticamente: ${rules.closeReason}`);
      }

      let effectiveTagsPerComment = tagsPerComment;
      let effectiveBaseComment = baseComment;

      if (autoDetectRules) {
        if (rules.detectedTagsCount !== null && rules.detectedTagsCount <= totalUniqueUsersCount) {
          effectiveTagsPerComment = rules.detectedTagsCount;
          job.tagsPerComment = effectiveTagsPerComment;
        }
        if (!effectiveBaseComment && rules.detectedKeyword) {
          effectiveBaseComment = rules.detectedKeyword;
          job.baseComment = effectiveBaseComment;
        }
      }

      // 3. Auto-Like ❤️ al Post y Seguir al Organizador si está activado
      if (autoLikeFollow) {
        const socialActions = await performAutoLikeAndFollow(jobPage);
        if (socialActions.length > 0) {
          console.log(`✨ [Post #${jobId}] Acciones automáticas: ${socialActions.join(', ')}`);
        }
      }

      // 4. Extraer Comentarios Totales y Miniatura para el Dashboard
      const detectedTotal = await extractPostCommentCount(jobPage, postUrl);
      const details = await extractPostDetailsAndThumbnail(jobPage);

      if (detectedTotal !== null) {
        job.postTotalComments = Math.max(detectedTotal, job.myTotalInPost);
        job.probabilities = calculateWinProbabilities(job.myTotalInPost, job.postTotalComments);
      }

      upsertPostInCatalog(postUrl, {
        author: details.author,
        caption: details.caption,
        thumbnail: details.thumbnail,
        myComments: job.myTotalInPost,
        postTotalComments: job.postTotalComments,
        probabilities: job.probabilities,
        detectedRules: rules,
      });

      await sendTelegramNotification(
        `🚀 Sorteo Iniciado (Post #${jobId} — ${accMeta.label})\n` +
        `🔗 ${postUrl}\n` +
        `${job.detectedRulesSummary ? '🔍 ' + job.detectedRulesSummary + '\n' : ''}` +
        `💬 Comentarios en el post: ${job.postTotalComments || 'Detectando...'}`
      );

      let lastCombinationKey = '';
      const usedCommentsSet = new Set();
      const recentTurnMap = new Map();
      const suspicionStrikesMap = new Map();
      let consecutiveRateLimits = 0;

      for (let i = 1; i <= totalComments; i++) {
        if (job.cancelRequested) {
          throw new Error('Envío detenido manualmente por el usuario.');
        }

        // Cada 15 comentarios verificamos si el organizador editó la descripción a "SORTEO CERRADO"
        if (i > 1 && i % 15 === 0) {
          const checkRules = await extractAndAnalyzeGiveawayRules(jobPage);
          if (checkRules.isClosed) {
            throw new Error(`El sorteo acaba de cerrar (${checkRules.closeReason}). Deteniendo post.`);
          }
        }

        let publishedSuccessfully = false;
        let finalCommentSent = '';
        let finalSelectedUsers = [];
        const excludedInTurn = new Set();

        for (let retry = 0; retry < 3 && !publishedSuccessfully; retry++) {
          const liveGroups = loadSavedUsersGroups();
          const activeFrequent = liveGroups.frequentUsers.length > 0 ? liveGroups.frequentUsers : frequentUsers;
          const activeOccasional = liveGroups.occasionalUsers.length > 0 ? liveGroups.occasionalUsers : occasionalUsers;
          const activePenalized = liveGroups.penalizedUsers || {};

          const { commentText: commentToSend, combinationKey, selectedUsers } = buildUniqueGiveawayComment({
            frequentUsers: activeFrequent,
            occasionalUsers: activeOccasional,
            penalizedUsers: activePenalized,
            recentTurnMap,
            cooldownTurns,
            excludedInTurn,
            tagsPerComment: effectiveTagsPerComment,
            baseComment: effectiveBaseComment,
            antiDuplicate,
            allowEmojis,
            usedSet: usedCommentsSet,
            lastKey: lastCombinationKey,
            commentIndex: i,
          });

          job.phaseMessage = `⏳ Esperando turno de escritura para comentario #${i}/${totalComments}...`;

          let publishOutcome = { type: 'none' };

          await acquireTypingTurn(job, async () => {
            job.phaseMessage = `✍️ Escribiendo #${i}/${totalComments} (${accMeta.label}): "${commentToSend}"`;
            console.log(`\n✍️ [Post #${jobId} (${accMeta.label}) — ${i}/${totalComments}] Escribiendo: "${commentToSend}"`);

            publishOutcome = await publicarUnComentarioEnPagina(
              jobPage,
              commentToSend,
              selectedUsers,
              minDelay,
              maxDelay,
              () => job.cancelRequested,
              simulateTypos
            );
          });

          if (publishOutcome.type === 'none') {
            publishedSuccessfully = true;
            finalCommentSent = commentToSend;
            finalSelectedUsers = selectedUsers;
            lastCombinationKey = combinationKey;
            consecutiveRateLimits = 0;

            for (const u of selectedUsers) {
              recentTurnMap.set(normalizeHandle(u), i);
            }
          } else if (publishOutcome.type === 'giveaway_closed') {
            throw new Error(publishOutcome.alertText);
          } else if (
            publishOutcome.type === 'mention_blocked' ||
            publishOutcome.type === 'generic_post_fail'
          ) {
            console.warn(
              `⚠️ [Post #${jobId}] Contingencia al etiquetar (${selectedUsers.join(', ')}): ${publishOutcome.alertText}`
            );

            if (publishOutcome.explicitUsers && publishOutcome.explicitUsers.length > 0) {
              for (const culprit of publishOutcome.explicitUsers) {
                demoteUserToOccasionalMinWeight(culprit, publishOutcome.alertText);
                excludedInTurn.add(normalizeHandle(culprit));
              }
            } else if (selectedUsers.length === 1) {
              demoteUserToOccasionalMinWeight(selectedUsers[0], publishOutcome.alertText);
              excludedInTurn.add(normalizeHandle(selectedUsers[0]));
            } else {
              for (const candidateUser of selectedUsers) {
                const normU = normalizeHandle(candidateUser);
                const strikes = (suspicionStrikesMap.get(normU) || 0) + 1;
                suspicionStrikesMap.set(normU, strikes);
                excludedInTurn.add(normU);

                if (strikes >= 2) {
                  demoteUserToOccasionalMinWeight(
                    normU,
                    'Restricción/bloqueo confirmado tras 2 fallos de mención'
                  );
                }
              }
            }

            job.phaseMessage = `🛡️ Alerta de mención sorteada. Reintentando comentario #${i} con otros usuarios...`;
            await jobPage.waitForTimeout(2500);
          } else if (publishOutcome.type === 'rate_limit') {
            consecutiveRateLimits += 1;
            if (consecutiveRateLimits >= 3) {
              throw new Error(
                'Instagram mantuvo el aviso de límite de frecuencia tras 3 pausas seguidas. Se detuvo por seguridad.'
              );
            }
            const recoverySec = getRandomInt(300, 420);
            await sleepJobWithCountdown(
              job,
              recoverySec,
              `🛡️ Enfriamiento automático tras alerta temporal de IG`
            );
          }
        }

        if (!publishedSuccessfully) {
          continue;
        }

        job.completed = i;
        recordCommentAnalytics(finalSelectedUsers, postUrl);
        job.myTotalInPost = ANALYTICS.myCommentsByPost[postKey] || job.completed;

        if (job.postTotalComments !== null) {
          job.postTotalComments += 1;
        } else {
          const refreshedCount = await extractPostCommentCount(jobPage, postUrl);
          job.postTotalComments = refreshedCount !== null
            ? Math.max(refreshedCount, job.myTotalInPost)
            : job.myTotalInPost;
        }

        job.probabilities = calculateWinProbabilities(job.myTotalInPost, job.postTotalComments);
        upsertPostInCatalog(postUrl, {
          myComments: job.myTotalInPost,
          postTotalComments: job.postTotalComments,
          probabilities: job.probabilities,
        });

        GLOBAL_LOGS.push({
          jobId,
          accountLabel: accMeta.label,
          index: i,
          time: new Date().toLocaleTimeString(),
          comment: finalCommentSent,
          postShort: postUrl.replace(/^https?:\/\/(www\.)?instagram\.com/i, ''),
        });

        if (i >= totalComments) break;

        if (batchSize > 0 && i % batchSize === 0) {
          const pauseSeconds = getRandomInt(
            Math.round(minBatchPauseMin * 60),
            Math.round(maxBatchPauseMin * 60)
          );
          await sleepJobWithCountdown(
            job,
            pauseSeconds,
            `☕ Descanso anti-spam tras ${i} comentarios`
          );
        } else {
          const waitSeconds = getRandomInt(minIntervalSec, maxIntervalSec);
          await sleepJobWithCountdown(
            job,
            waitSeconds,
            `⏱️ Esperando para comentario #${i + 1}`
          );
        }
      }

      await context.storageState({ path: sessionPath }).catch(() => {});
      job.phaseMessage = `🎉 ¡Completado! ${job.completed} de ${job.total} comentarios enviados.`;

      await sendTelegramNotification(
        `🎉 ¡Tanda Finalizada! (Post #${jobId} — ${accMeta.label})\n` +
        `✅ Enviados: ${job.completed}/${job.total}\n` +
        `🎟️ Tus boletos en el post: ${job.myTotalInPost}\n` +
        `🎯 Probabilidad real de ganar: ${job.probabilities.estimatedRealPercent}%`
      );
    } catch (error) {
      job.error = error.message;
      job.phaseMessage = `🛑 Detenido: ${error.message}`;
      console.error(`\n❌ [Post #${jobId}] Detenido: ${error.message}`);

      await sendTelegramNotification(`🛑 Post #${jobId} (${accMeta.label}) detenido:\n${error.message}`);

      if (job.page && !job.page.isClosed()) {
        await job.page.screenshot({ path: CONFIG.errorScreenshot, fullPage: true }).catch(() => {});
      }
    } finally {
      job.running = false;
    }
  })();

  return jobId;
}

async function minimizeBrowserWindow(page) {
  try {
    if (!page || page.isClosed()) return;
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
    await cdp.detach().catch(() => {});
  } catch {}
}

// ============================================================================
// Servidor Local para la Ventana del Panel de Control y el Dashboard
// ============================================================================
function startControlServer({
  browser,
  onStartBatch,
  onAnalyzePostUrl,
  onAddAccountAndLogin,
  onSaveAccountSession,
  onDeleteAccount,
  onStopBatch,
  onFocusJob,
  onOpenDashboard,
  onOpenPanel,
  onMinimize,
  onSaveSession,
  onFocusIg,
  onShutdown,
}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
          const html = fs.readFileSync(CONFIG.panelHtmlFile, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (req.method === 'GET' && (req.url === '/dashboard' || req.url.startsWith('/dashboard?'))) {
          const html = fs.readFileSync(CONFIG.dashboardHtmlFile, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        if (req.method === 'GET' && req.url === '/api/init') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              initialUrl,
              initialComment,
              hasSession: fs.existsSync(CONFIG.sessionFile),
              savedUsers: loadSavedUsers(),
              userGroups: loadSavedUsersGroups(),
              accounts: getAccountStatusList(),
              telegram: PANEL_CONFIG.telegram,
            })
          );
          return;
        }

        if (req.method === 'POST' && req.url === '/api/save-users') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const payload = JSON.parse(body || '{}');
              const saved = saveUsersGroupsToDisk({
                frequentUsers: payload.frequentUsers,
                occasionalUsers: payload.occasionalUsers,
                penalizedUsers: payload.penalizedUsers,
              });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, userGroups: saved }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url === '/api/clear-penalty') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const { username } = JSON.parse(body || '{}');
              const groups = loadSavedUsersGroups();
              if (username) {
                delete groups.penalizedUsers[normalizeHandle(username)];
              } else {
                groups.penalizedUsers = {};
              }
              saveUsersGroupsToDisk(groups);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, userGroups: groups }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        // Endpoint para analizar reglas y fecha límite de un post con 1 clic en el Panel
        if (req.method === 'POST' && req.url === '/api/analyze-post') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const { postUrl } = JSON.parse(body || '{}');
              const analysis = await onAnalyzePostUrl(postUrl);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, analysis }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        // Endpoints de Multicuentas desde el Panel de Control
        if (req.method === 'POST' && req.url === '/api/accounts/add') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const { label } = JSON.parse(body || '{}');
              const result = await onAddAccountAndLogin(label);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ...result, accounts: getAccountStatusList() }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url === '/api/accounts/save-session') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const { accountId } = JSON.parse(body || '{}');
              await onSaveAccountSession(accountId);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, accounts: getAccountStatusList() }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url === '/api/accounts/delete') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const { accountId } = JSON.parse(body || '{}');
              await onDeleteAccount(accountId);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, accounts: getAccountStatusList() }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        // Endpoints de Telegram desde el Panel de Control
        if (req.method === 'POST' && req.url === '/api/telegram/save') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const { botToken, chatId, enabled, sendTest } = JSON.parse(body || '{}');
              PANEL_CONFIG.telegram = {
                botToken: String(botToken || '').trim(),
                chatId: String(chatId || '').trim(),
                enabled: Boolean(enabled),
              };
              savePanelConfig(PANEL_CONFIG);

              if (sendTest) {
                const testRes = await sendTelegramNotification(
                  '✅ ¡Conexión exitosa con tu Instagram Multi-Post Bot!\nYa puedes recibir alertas y enviar links de sorteos por aquí.',
                  PANEL_CONFIG.telegram.botToken,
                  PANEL_CONFIG.telegram.chatId
                );
                if (!testRes.ok) {
                  throw new Error(testRes.error);
                }
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, telegram: PANEL_CONFIG.telegram }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        if (req.method === 'GET' && req.url === '/api/status') {
          const jobsSummary = Array.from(ACTIVE_JOBS.values())
            .sort((a, b) => b.id - a.id)
            .map((j) => ({
              id: j.id,
              accountId: j.accountId,
              accountLabel: j.accountLabel,
              postUrl: j.postUrl,
              baseComment: j.baseComment,
              tagsPerComment: j.tagsPerComment,
              usersCount: j.usersCount,
              running: j.running,
              completed: j.completed,
              total: j.total,
              postTotalComments: j.postTotalComments,
              myTotalInPost: j.myTotalInPost,
              probabilities: j.probabilities,
              detectedRulesSummary: j.detectedRulesSummary,
              phaseMessage: j.phaseMessage,
              error: j.error,
            }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jobs: jobsSummary,
              logs: GLOBAL_LOGS,
              analytics: ANALYTICS,
              savedUsers: loadSavedUsers(),
              userGroups: loadSavedUsersGroups(),
              accounts: getAccountStatusList(),
            })
          );
          return;
        }

        if (req.method === 'POST' && req.url === '/api/delete-post') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const { postKey } = JSON.parse(body || '{}');
              if (postKey && ANALYTICS.postsCatalog[postKey]) {
                delete ANALYTICS.postsCatalog[postKey];
                saveStats();
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url === '/api/open-dashboard') {
          await onOpenDashboard();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'POST' && req.url === '/api/open-panel') {
          await onOpenPanel();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'POST' && req.url === '/api/reset-stats') {
          resetAnalytics();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, analytics: ANALYTICS }));
          return;
        }

        if (req.method === 'POST' && req.url === '/api/save-session') {
          await onSaveSession();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'POST' && req.url === '/api/start-batch') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const payload = JSON.parse(body || '{}');
              const jobIds = onStartBatch(payload);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, jobId: jobIds[0], jobIds }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url === '/api/stop-batch') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const payload = JSON.parse(body || '{}');
              onStopBatch(payload);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url === '/api/focus-job') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const { jobId } = JSON.parse(body || '{}');
              await onFocusJob(jobId);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        if (req.method === 'POST' && req.url === '/api/focus-ig') {
          await onFocusIg();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'POST' && req.url === '/api/minimize') {
          await onMinimize();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'POST' && req.url === '/api/shutdown') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          onShutdown();
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });

    server.on('error', reject);
  });
}

// ============================================================================
// Flujo Principal
// ============================================================================
(async () => {
  let browser = null;
  let igPage = null;
  let panelPage = null;
  let dashboardPage = null;
  let controlServer = null;

  try {
    console.log('🚀 Iniciando navegador (Optimizado para ejecución en segundo plano)...');

    const bgLaunchArgs = [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];

    try {
      browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: bgLaunchArgs,
      });
      console.log('🌐 Usando navegador Google Chrome del sistema.');
    } catch {
      browser = await chromium.launch({
        headless: false,
        args: bgLaunchArgs,
      });
      console.log('🌐 Usando navegador Chromium de Playwright.');
    }

    const mainAccount = await getOrCreateAccountContext(browser, 'principal');
    const context = mainAccount.context;
    igPage = await context.newPage();
    mainAccount.loginPage = igPage;

    const hasSessionFile = fs.existsSync(CONFIG.sessionFile);

    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });

    const launchBatchWithAccounts = (payload) => {
      const targetAccount = payload.accountId || 'principal';
      if (targetAccount === 'ALL') {
        const connectedAccounts = getAccountStatusList().filter((a) => a.hasSession);
        const accountsToRun = connectedAccounts.length > 0 ? connectedAccounts : [{ id: 'principal' }];
        return accountsToRun.map((acc) =>
          crearYEjecutarTareaPost(browser, { ...payload, accountId: acc.id })
        );
      }
      return [crearYEjecutarTareaPost(browser, payload)];
    };

    const { server, url: panelUrl } = await startControlServer({
      browser,
      onStartBatch: launchBatchWithAccounts,
      onAnalyzePostUrl: async (postUrl) => {
        const tempPage = await context.newPage();
        try {
          await tempPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await tempPage.waitForTimeout(2000);
          const rules = await extractAndAnalyzeGiveawayRules(tempPage);
          const totalComments = await extractPostCommentCount(tempPage, postUrl);
          return { ...rules, postTotalComments: totalComments };
        } finally {
          await tempPage.close().catch(() => {});
        }
      },
      onAddAccountAndLogin: async (rawLabel) => {
        const cleanLabel = String(rawLabel || '').trim() || `Cuenta ${PANEL_CONFIG.accounts.length + 1}`;
        const slug = cleanLabel.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now().toString().slice(-4);
        const sessionPath = path.join(CONFIG.sessionsDir, `sesion_${slug}.json`);

        PANEL_CONFIG.accounts.push({
          id: slug,
          label: cleanLabel,
          sessionPath,
        });
        savePanelConfig(PANEL_CONFIG);

        const accEntry = await getOrCreateAccountContext(browser, slug);
        const loginTab = await accEntry.context.newPage();
        accEntry.loginPage = loginTab;
        await loginTab.bringToFront();
        await startNonBlockingLogin(loginTab, accEntry.context, sessionPath);

        return { accountId: slug, label: cleanLabel };
      },
      onSaveAccountSession: async (accountId = 'principal') => {
        const accEntry = await getOrCreateAccountContext(browser, accountId);
        await accEntry.context.storageState({ path: accEntry.sessionPath });
        console.log(`💾 Sesión guardada para cuenta "${accEntry.label}": ${accEntry.sessionPath}`);
      },
      onDeleteAccount: async (accountId) => {
        if (!accountId || accountId === 'principal') {
          throw new Error('La cuenta principal no se puede eliminar.');
        }
        PANEL_CONFIG.accounts = PANEL_CONFIG.accounts.filter((a) => a.id !== accountId);
        savePanelConfig(PANEL_CONFIG);
        if (ACCOUNT_CONTEXTS.has(accountId)) {
          const entry = ACCOUNT_CONTEXTS.get(accountId);
          await entry.context.close().catch(() => {});
          ACCOUNT_CONTEXTS.delete(accountId);
        }
      },
      onStopBatch: ({ jobId, all }) => {
        if (all) {
          for (const job of ACTIVE_JOBS.values()) {
            job.cancelRequested = true;
          }
        } else if (jobId && ACTIVE_JOBS.has(jobId)) {
          ACTIVE_JOBS.get(jobId).cancelRequested = true;
        }
      },
      onFocusJob: async (jobId) => {
        const job = ACTIVE_JOBS.get(Number(jobId));
        if (job && job.page && !job.page.isClosed()) {
          await job.page.bringToFront().catch(() => {});
        }
      },
      onOpenDashboard: async () => {
        if (!dashboardPage || dashboardPage.isClosed()) {
          dashboardPage = await context.newPage();
          await dashboardPage.goto(`${panelUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
        } else {
          await dashboardPage.bringToFront().catch(() => {});
        }
      },
      onOpenPanel: async () => {
        if (panelPage && !panelPage.isClosed()) {
          await panelPage.bringToFront().catch(() => {});
        }
      },
      onSaveSession: async () => {
        await context.storageState({ path: CONFIG.sessionFile });
        console.log(`💾 Sesión principal guardada en: ${CONFIG.sessionFile}`);
      },
      onFocusIg: async () => {
        if (igPage && !igPage.isClosed()) {
          await igPage.bringToFront().catch(() => {});
        }
      },
      onMinimize: async () => {
        await minimizeBrowserWindow(panelPage || igPage);
      },
      onShutdown: () => {
        for (const job of ACTIVE_JOBS.values()) {
          job.cancelRequested = true;
        }
        resolveExit();
      },
    });
    controlServer = server;

    // Iniciar bucle de control remoto por Telegram si el usuario lo activa
    startTelegramRemoteControlLoop(
      (remoteUrl, remoteMsg) => {
        const groups = loadSavedUsersGroups();
        launchBatchWithAccounts({
          postUrl: remoteUrl,
          accountId: 'ALL',
          frequentUsers: groups.frequentUsers,
          occasionalUsers: groups.occasionalUsers,
          baseComment: remoteMsg || '',
          tagsPerComment: 2,
          totalComments: 100,
          autoDetectRules: true,
          autoLikeFollow: true,
          simulateTypos: true,
          antiDuplicate: true,
          allowEmojis: true,
        });
      },
      () => {
        for (const job of ACTIVE_JOBS.values()) {
          job.cancelRequested = true;
        }
      }
    );

    panelPage = await context.newPage();
    await panelPage.goto(panelUrl, { waitUntil: 'domcontentloaded' });

    panelPage.on('close', () => resolveExit());
    browser.on('disconnected', () => resolveExit());

    if (hasSessionFile) {
      console.log('🌐 Verificando sesión en Instagram...');
      await igPage.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await igPage.waitForTimeout(2000);

      if (igPage.url().includes('/accounts/login')) {
        console.warn('⚠️ La sesión guardada expiró. Abriendo pestaña de Instagram para iniciar sesión...');
        await igPage.bringToFront();
        await startNonBlockingLogin(igPage, context, CONFIG.sessionFile, async () => {
          if (panelPage && !panelPage.isClosed()) {
            await panelPage.reload().catch(() => {});
            await panelPage.bringToFront().catch(() => {});
          }
        });
      } else {
        await dismissCookiesModal(igPage);
        await dismissPostLoginModals(igPage);
        console.log('✅ Sesión de Instagram activa.');
        await panelPage.bringToFront();
      }
    } else {
      await igPage.bringToFront();
      await startNonBlockingLogin(igPage, context, CONFIG.sessionFile, async () => {
        if (panelPage && !panelPage.isClosed()) {
          await panelPage.reload().catch(() => {});
          await panelPage.bringToFront().catch(() => {});
        }
      });
    }

    await exitPromise;
  } catch (error) {
    console.error(`\n❌ Error crítico: ${error.message}`);
    if (igPage && !igPage.isClosed()) {
      await igPage.screenshot({ path: CONFIG.errorScreenshot, fullPage: true }).catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    if (controlServer) {
      controlServer.close();
    }
    for (const entry of ACCOUNT_CONTEXTS.values()) {
      await entry.context.close().catch(() => {});
    }
    if (browser) {
      console.log('🔒 Cerrando navegador...');
      await browser.close().catch(() => {});
    }
  }
})();
