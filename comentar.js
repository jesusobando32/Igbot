require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

// ============================================================================
// Configuración y Constantes Modificables
// ============================================================================
const CONFIG = {
  sessionFile: path.join(__dirname, 'sesion_ig.json'),
  savedUsersFile: path.join(__dirname, 'usuarios_guardados.json'),
  errorScreenshot: path.join(__dirname, 'error_screenshot.png'),
  panelHtmlFile: path.join(__dirname, 'panel.html'),
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

function loadSavedUsers() {
  try {
    if (fs.existsSync(CONFIG.savedUsersFile)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG.savedUsersFile, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {}
  return CONFIG.defaultUsers;
}

function saveUsersToDisk(users) {
  fs.writeFileSync(CONFIG.savedUsersFile, JSON.stringify(users, null, 2), 'utf8');
}

// Argumentos opcionales por CLI
const [, , initialUrl = '', initialComment = ''] = process.argv;

// Registro global de tareas (Multi-Post en paralelo) y logs
let nextJobId = 1;
const ACTIVE_JOBS = new Map(); // jobId -> job object (incluye su propia pestaña `page`)
const GLOBAL_LOGS = [];

// Mutex/Cola para intercalar la escritura entre múltiples posts sin que choquen al teclear
let typingQueue = Promise.resolve();
let lastPublishTimestamp = 0;

/**
 * Garantiza que si hay 2 o más posts corriendo a la vez, solo uno escriba
 * en el teclado en cada instante y deje una separación mínima anti-spam (12-20s)
 * respecto al comentario de otro post.
 */
function acquireTypingTurn(job, taskFn) {
  const run = async () => {
    if (job.cancelRequested) return;

    // Si otro post acaba de publicar hace pocos segundos, esperamos una breve separación
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

// ============================================================================
// Funciones Auxiliares
// ============================================================================

function getRandomInt(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

/**
 * Selecciona `count` usuarios aleatorios de la lista SIN repetir ninguno
 * dentro del mismo comentario (algoritmo Fisher-Yates).
 */
function pickRandomUniqueUsers(users, count, lastKey = '') {
  if (!Array.isArray(users) || users.length === 0 || count <= 0) return [];
  const safeCount = Math.min(count, users.length);

  let picked = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const copy = [...users];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    picked = copy.slice(0, safeCount);
    const currentKey = picked.join(' ');
    if (currentKey !== lastKey || users.length <= safeCount) {
      break;
    }
  }
  return picked;
}

const GIVEAWAY_EMOJIS = [
  '🔥', '🙌', '✨', '👏', '💯', '🚀', '🎉', '🍀', '⚡', '🤩',
  '💪', '🌟', '🥳', '💥', '🤞', '❤️', '🫶', '🎊', '🏆', '💎',
  '👑', '💫', '🌈', '☀️', '🎯', '🥁', '🎁', '🎈', '🥂', '🌠',
];

/**
 * Construye el texto final del comentario:
 * - Si `baseComment` está vacío, devuelve únicamente los usuarios etiquetados.
 * - Si `baseComment` tiene texto, combina el mensaje y los etiquetados.
 * - Si `antiDuplicate` está activo, garantiza mediante un Set por post (`usedSet`)
 *   que NUNCA se envíe dos veces el mismo string exacto (evitando que AppSorteos,
 *   Simpliers o Instagram colapsen o filtren comentarios repetidos).
 */
function buildUniqueGiveawayComment({
  users,
  tagsPerComment,
  baseComment,
  antiDuplicate = true,
  usedSet,
  lastKey = '',
}) {
  const cleanMsg = (baseComment || '').trim();

  // Intentamos hasta 80 candidatos para encontrar una combinación nunca antes enviada en este post
  for (let attempt = 0; attempt < 80; attempt++) {
    const selectedUsers = pickRandomUniqueUsers(users, tagsPerComment, lastKey);
    const tagsPart = selectedUsers.join(' ');

    let coreText = '';
    if (cleanMsg && tagsPart) {
      // En intentos avanzados también podemos alternar orden (mensaje + tags vs tags + mensaje)
      coreText = attempt > 40 && attempt % 2 === 1
        ? `${tagsPart} ${cleanMsg}`
        : `${cleanMsg} ${tagsPart}`;
    } else if (tagsPart) {
      coreText = tagsPart;
    } else {
      coreText = cleanMsg;
    }

    if (!antiDuplicate || !usedSet) {
      return { commentText: coreText, combinationKey: tagsPart };
    }

    // 1. Si la combinación pura aún no ha salido en este post, la usamos limpia primero
    const normalizedCore = coreText.trim().toLowerCase();
    if (!usedSet.has(normalizedCore)) {
      usedSet.add(normalizedCore);
      return { commentText: coreText, combinationKey: tagsPart };
    }

    // 2. Si esa pareja de usuarios ya salió antes, agregamos 1 o 2 emojis aleatorios de sorteo
    const e1 = GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)];
    const e2 = GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)];
    const suffix = attempt < 35 ? e1 : `${e1}${e2}`;
    const candidate = `${coreText} ${suffix}`;
    const normalizedCandidate = candidate.trim().toLowerCase();

    if (!usedSet.has(normalizedCandidate)) {
      usedSet.add(normalizedCandidate);
      return { commentText: candidate, combinationKey: tagsPart };
    }
  }

  // Fallback garantizado único con combinación triple de emojis si se superan cientos de envíos
  const selectedUsers = pickRandomUniqueUsers(users, tagsPerComment, lastKey);
  const tagsPart = selectedUsers.join(' ');
  const base = cleanMsg && tagsPart ? `${cleanMsg} ${tagsPart}` : tagsPart || cleanMsg;
  const e1 = GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)];
  const e2 = GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)];
  const e3 = GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)];
  const fallbackText = `${base} ${e1}${e2}${e3}`;
  if (usedSet) usedSet.add(fallbackText.trim().toLowerCase());
  return { commentText: fallbackText, combinationKey: tagsPart };
}

/**
 * Escribe texto letra por letra usando pressSequentially con un delay
 * aleatorio entre minDelay y maxDelay en cada pulsación.
 */
async function humanType(locator, text, minDelay = 65, maxDelay = 135, shouldCancel = () => false) {
  for (const char of text) {
    if (shouldCancel()) {
      throw new Error('Envío detenido manualmente por el usuario.');
    }
    let delay = getRandomInt(minDelay, maxDelay);
    if (char === ' ' || char === '@') {
      delay += getRandomInt(40, 110);
    }
    await locator.pressSequentially(char, { delay });
  }
}

/**
 * Espera cancelable con cuenta regresiva para un post específico.
 */
async function sleepJobWithCountdown(job, totalSeconds, prefixText) {
  for (let remaining = totalSeconds; remaining > 0; remaining--) {
    if (job.cancelRequested) {
      throw new Error('Envío detenido manualmente por el usuario.');
    }
    job.phaseMessage = `${prefixText} (${remaining}s restantes)...`;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

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

/**
 * Inicio de sesión no bloqueante (nunca cierra el navegador por timeout).
 */
async function startNonBlockingLogin(igPage, context, onAuthenticated) {
  const username = process.env.IG_USERNAME;
  const password = process.env.IG_PASSWORD;
  const hasEnvCredentials =
    username &&
    password &&
    username !== 'tu_usuario_aqui' &&
    password !== 'tu_password_aqui';

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
        console.log('⌨️ Escribiendo usuario y contraseña desde .env...');
        await userInput.click();
        await humanType(userInput, username, 60, 110);

        await passInput.click();
        await humanType(passInput, password, 60, 110);

        const submitButton = igPage.locator(
          'button[type="submit"], ' +
          'div[role="button"]:has-text("Iniciar sesión"), ' +
          'div[role="button"]:has-text("Log in")'
        ).first();

        await submitButton.click();
      }
    } catch (err) {
      console.log(`ℹ️ Autocompletado pausado (${err.message}). Puedes continuar manualmente en la ventana.`);
    }
  }

  console.log(
    '\n⏳ MODO MANUAL ACTIVO (Sin límite de tiempo):\n' +
    '   👉 Completa cualquier verificación, código 2FA o inicio de sesión en la pestaña de Instagram.\n' +
    '   👉 El navegador NO se cerrará solo. Cuando entres al feed, la sesión se guardará automáticamente.\n'
  );

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
          console.log('✅ ¡Sesión detectada en el feed de Instagram! Guardando sesion_ig.json...');
          await dismissPostLoginModals(igPage);
          await context.storageState({ path: CONFIG.sessionFile });
          console.log(`💾 Sesión guardada en: ${CONFIG.sessionFile}`);
          if (onAuthenticated) await onAuthenticated();
          break;
        }
      } catch {}
      await igPage.waitForTimeout(2500).catch(() => {});
    }
  })();
}

/**
 * Publica un único comentario dentro de la pestaña dedicada del post
 * EN SEGUNDO PLANO (sin llamar a bringToFront para no robar el foco de Windows).
 */
async function publicarUnComentarioEnPagina(jobPage, commentToSend, minDelay, maxDelay, shouldCancel) {
  const commentSelector = [
    'textarea[aria-label*="comentario" i]',
    'textarea[aria-label*="comment" i]',
    'textarea[placeholder*="comentario" i]',
    'textarea[placeholder*="comment" i]',
  ].join(', ');

  const commentBox = jobPage.locator(commentSelector).first();
  const isVisible = await commentBox.isVisible({ timeout: 12000 }).catch(() => false);

  if (!isVisible) {
    throw new Error(
      'No se encontró la caja de comentarios. Verifica haber iniciado sesión y que el post permita comentarios.'
    );
  }

  await commentBox.scrollIntoViewIfNeeded();
  await commentBox.click();
  await jobPage.waitForTimeout(350);

  const activeCommentBox = jobPage.locator(commentSelector).first();
  await activeCommentBox.click();
  await activeCommentBox.fill('');

  await humanType(activeCommentBox, commentToSend, minDelay, maxDelay, shouldCancel);
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

  const rateLimitAlert = jobPage.locator(
    'text=/Inténtalo de nuevo más tarde|Try Again Later|Restringimos determinadas actividades|We restrict certain activity|No se pudo publicar el comentario|Couldn\'t post comment/i'
  ).first();

  if (await rateLimitAlert.isVisible({ timeout: 1200 }).catch(() => false)) {
    throw new Error(
      'Instagram mostró un aviso de límite de frecuencia ("Inténtalo de nuevo más tarde"). Se detuvo el envío en este post por seguridad.'
    );
  }
}

/**
 * Crea y ejecuta una tarea independiente para un Post en su propia pestaña,
 * coordinándose automáticamente con otros posts activos.
 */
function crearYEjecutarTareaPost(context, config) {
  const {
    postUrl,
    users = [],
    baseComment = '',
    tagsPerComment = 0,
    totalComments = 100,
    antiDuplicate = true,
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

  const jobId = nextJobId++;
  const job = {
    id: jobId,
    postUrl,
    baseComment,
    tagsPerComment,
    usersCount: users.length,
    running: true,
    cancelRequested: false,
    completed: 0,
    total: totalComments,
    phaseMessage: 'Abriendo pestaña dedicada para este post...',
    error: null,
    page: null,
  };

  ACTIVE_JOBS.set(jobId, job);

  // Ejecución asíncrona independiente para este post
  (async () => {
    try {
      await context.storageState({ path: CONFIG.sessionFile }).catch(() => {});

      const jobPage = await context.newPage();
      job.page = jobPage;

      console.log(`\n🌐 [Post #${jobId}] Abriendo pestaña y navegando a: ${postUrl}`);
      await jobPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await jobPage.waitForTimeout(2200);

      await dismissCookiesModal(jobPage);
      await dismissPostLoginModals(jobPage);

      const unavailableMessage = jobPage.locator(
        'text=/Esta página no está disponible|Sorry, this page isn\'t available|Esta cuenta es privada|This account is private/i'
      ).first();

      if (await unavailableMessage.isVisible({ timeout: 2500 }).catch(() => false)) {
        throw new Error('El post no está disponible, fue eliminado o pertenece a una cuenta privada.');
      }

      let lastCombinationKey = '';
      const usedCommentsSet = new Set();

      for (let i = 1; i <= totalComments; i++) {
        if (job.cancelRequested) {
          throw new Error('Envío detenido manualmente por el usuario.');
        }

        const { commentText: commentToSend, combinationKey } = buildUniqueGiveawayComment({
          users,
          tagsPerComment,
          baseComment,
          antiDuplicate,
          usedSet: usedCommentsSet,
          lastKey: lastCombinationKey,
        });
        lastCombinationKey = combinationKey;

        job.phaseMessage = `⏳ Esperando turno de escritura para comentario #${i}/${totalComments}...`;

        // Adquirir turno exclusivo de teclado para escribir y publicar sin solaparse con otro post
        await acquireTypingTurn(job, async () => {
          job.phaseMessage = `✍️ Escribiendo #${i}/${totalComments}: "${commentToSend}"`;
          console.log(`\n✍️ [Post #${jobId} — ${i}/${totalComments}] Escribiendo: "${commentToSend}"`);

          await publicarUnComentarioEnPagina(
            jobPage,
            commentToSend,
            minDelay,
            maxDelay,
            () => job.cancelRequested
          );
        });

        job.completed = i;
        GLOBAL_LOGS.push({
          jobId,
          index: i,
          time: new Date().toLocaleTimeString(),
          comment: commentToSend,
          postShort: postUrl.replace(/^https?:\/\/(www\.)?instagram\.com/i, ''),
        });

        console.log(`✅ [Post #${jobId} — ${i}/${totalComments}] Comentario publicado.`);

        if (i >= totalComments) {
          break;
        }

        if (batchSize > 0 && i % batchSize === 0) {
          const pauseSeconds = getRandomInt(
            Math.round(minBatchPauseMin * 60),
            Math.round(maxBatchPauseMin * 60)
          );
          console.log(
            `☕ [Post #${jobId}] Lote de ${batchSize} completado (${i}/${totalComments}). Descanso de ${Math.round(
              pauseSeconds / 60
            )} min...`
          );
          await sleepJobWithCountdown(
            job,
            pauseSeconds,
            `☕ Descanso anti-spam tras ${i} comentarios`
          );
        } else {
          const waitSeconds = getRandomInt(minIntervalSec, maxIntervalSec);
          console.log(`⏱️ [Post #${jobId}] Esperando ${waitSeconds}s para el siguiente comentario...`);
          await sleepJobWithCountdown(
            job,
            waitSeconds,
            `⏱️ Esperando para comentario #${i + 1}`
          );
        }
      }

      await context.storageState({ path: CONFIG.sessionFile }).catch(() => {});
      job.phaseMessage = `🎉 ¡Completado! ${job.completed} de ${job.total} comentarios enviados.`;
      console.log(`\n🎉 [Post #${jobId}] ¡Tanda completada exitosamente!`);
    } catch (error) {
      job.error = error.message;
      job.phaseMessage = `🛑 Detenido: ${error.message}`;
      console.error(`\n❌ [Post #${jobId}] Detenido: ${error.message}`);

      if (job.page && !job.page.isClosed()) {
        await job.page.screenshot({ path: CONFIG.errorScreenshot, fullPage: true }).catch(() => {});
      }
    } finally {
      job.running = false;
    }
  })();

  return jobId;
}

/**
 * Minimiza la ventana del navegador a la barra de tareas de Windows usando CDP
 * para que el usuario pueda usar su PC sin interrupciones.
 */
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
// Servidor Local para la Ventana del Panel de Control
// ============================================================================
function startControlServer({ onStartBatch, onStopBatch, onFocusJob, onMinimize, onSaveSession, onFocusIg, onShutdown }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
          const html = fs.readFileSync(CONFIG.panelHtmlFile, 'utf8');
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
            })
          );
          return;
        }

        if (req.method === 'POST' && req.url === '/api/save-users') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const { users } = JSON.parse(body || '{}');
              if (Array.isArray(users)) {
                saveUsersToDisk(users);
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

        if (req.method === 'GET' && req.url === '/api/status') {
          const jobsSummary = Array.from(ACTIVE_JOBS.values())
            .sort((a, b) => b.id - a.id)
            .map((j) => ({
              id: j.id,
              postUrl: j.postUrl,
              baseComment: j.baseComment,
              tagsPerComment: j.tagsPerComment,
              usersCount: j.usersCount,
              running: j.running,
              completed: j.completed,
              total: j.total,
              phaseMessage: j.phaseMessage,
              error: j.error,
            }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jobs: jobsSummary, logs: GLOBAL_LOGS }));
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
              const jobId = onStartBatch(payload);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, jobId }));
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
  let context = null;
  let igPage = null;
  let panelPage = null;
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

    const hasSessionFile = fs.existsSync(CONFIG.sessionFile);
    const contextOptions = {
      viewport: CONFIG.viewport,
    };

    if (hasSessionFile) {
      console.log(`📂 Sesión encontrada (${path.basename(CONFIG.sessionFile)}). Inyectando storageState...`);
      contextOptions.storageState = CONFIG.sessionFile;
    }

    context = await browser.newContext(contextOptions);
    igPage = await context.newPage();

    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });

    const { server, url: panelUrl } = await startControlServer({
      onStartBatch: (payload) => crearYEjecutarTareaPost(context, payload),
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
      onSaveSession: async () => {
        await context.storageState({ path: CONFIG.sessionFile });
        console.log(`💾 Sesión guardada manualmente en: ${CONFIG.sessionFile}`);
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
        await startNonBlockingLogin(igPage, context, async () => {
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
      await startNonBlockingLogin(igPage, context, async () => {
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
      console.error(`📸 Captura de pantalla del error guardada en: ${CONFIG.errorScreenshot}`);
    }
    process.exitCode = 1;
  } finally {
    if (controlServer) {
      controlServer.close();
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      console.log('🔒 Cerrando navegador...');
      await browser.close().catch(() => {});
    }
  }
})();
