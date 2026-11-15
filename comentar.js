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
  statsFile: path.join(__dirname, 'estadisticas.json'),
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

const ANALYTICS = {
  sessionComments: 0,
  ...loadStats(),
};

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

  // Mantener miniatura previa si el nuevo patch no trae una
  if (!patch.thumbnail && existing.thumbnail) {
    merged.thumbnail = existing.thumbnail;
  }
  if (!patch.author && existing.author) {
    merged.author = existing.author;
  }
  if (!patch.caption && existing.caption) {
    merged.caption = existing.caption;
  }

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
];

const TEXT_VARIATION_SUFFIXES = [
  '!', '!!', '🙌', '🔥', '✨', '🍀', '👏', '💯', '🚀', '🎉',
];

/**
 * Combina el texto complementario y los usuarios etiquetados cambiando el orden:
 * - modo 0: "@user1 @user2 Texto" (Texto al final)
 * - modo 1: "Texto @user1 @user2" (Texto al principio)
 * - modo 2: "@user1 Texto @user2" (Texto en medio, si hay >= 2 etiquetados)
 */
function combineTextAndTags(phrase, selectedUsers, positionMode = 0) {
  const cleanPhrase = (phrase || '').trim();
  if (!cleanPhrase) {
    return selectedUsers.join(' ');
  }
  if (!selectedUsers || selectedUsers.length === 0) {
    return cleanPhrase;
  }

  const mode = positionMode % (selectedUsers.length >= 2 ? 3 : 2);
  if (mode === 0) {
    // Texto al final: "@jesus @leo SI se puede"
    return `${selectedUsers.join(' ')} ${cleanPhrase}`;
  }
  if (mode === 1) {
    // Texto al principio: "SI se puede @jesus @leo"
    return `${cleanPhrase} ${selectedUsers.join(' ')}`;
  }
  // Texto intercalado: "@jesus SI se puede @leo"
  const [firstUser, ...restUsers] = selectedUsers;
  return `${firstUser} ${cleanPhrase} ${restUsers.join(' ')}`;
}

/**
 * Construye el comentario garantizando:
 * 1. Alternancia del orden del texto complementario (principio, final o medio).
 * 2. Soporte para varias frases separadas por "|" (ej: "SI se puede | Vamos").
 * 3. No repetir el mismo string exacto en el mismo post (`usedSet`).
 * 4. Separación siempre con espacio antes y después de cada @usuario para no afectar regex.
 */
function buildUniqueGiveawayComment({
  users,
  tagsPerComment,
  baseComment,
  antiDuplicate = true,
  allowEmojis = true,
  usedSet,
  lastKey = '',
  commentIndex = 1,
}) {
  // Permitir una frase o varias separadas por "|"
  const phrases = String(baseComment || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  for (let attempt = 0; attempt < 90; attempt++) {
    const selectedUsers = pickRandomUniqueUsers(users, tagsPerComment, lastKey);
    const tagsPart = selectedUsers.join(' ');
    const chosenPhrase =
      phrases.length > 0 ? phrases[(commentIndex + attempt) % phrases.length] : '';

    // Rotamos la posición del texto (principio, final o intercalado)
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

    // Si la combinación + posición ya salió antes, añadimos una variación ligera separada por espacio
    let suffix = '';
    if (allowEmojis) {
      const e1 = GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)];
      suffix = attempt < 45 ? e1 : `${e1} !`;
    } else {
      const punct = ['!', '!!', '!', '...'][attempt % 4];
      suffix = punct;
    }

    // Alternar si el sufijo va al final o al principio (siempre con espacio para proteger el @username)
    const candidate =
      attempt % 2 === 0 ? `${coreText} ${suffix}` : `${suffix} ${coreText}`;
    const normalizedCandidate = candidate.trim().toLowerCase();

    if (!usedSet.has(normalizedCandidate)) {
      usedSet.add(normalizedCandidate);
      return { commentText: candidate, combinationKey: tagsPart, selectedUsers };
    }
  }

  const selectedUsers = pickRandomUniqueUsers(users, tagsPerComment, lastKey);
  const tagsPart = selectedUsers.join(' ');
  const chosenPhrase = phrases.length > 0 ? phrases[0] : '';
  const base = combineTextAndTags(chosenPhrase, selectedUsers, commentIndex % 3);
  const fallbackText = allowEmojis
    ? `${base} ${GIVEAWAY_EMOJIS[getRandomInt(0, GIVEAWAY_EMOJIS.length - 1)]}`
    : `${base} !`;
  if (usedSet) usedSet.add(fallbackText.trim().toLowerCase());
  return { commentText: fallbackText, combinationKey: tagsPart, selectedUsers };
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
 * Extrae el número total de comentarios que tiene el post en Instagram
 * inspeccionando JSON interno de Relay/Polaris, meta tags y nodos del DOM.
 */
async function extractPostCommentCount(page, postUrl = '') {
  try {
    const shortcode = normalizePostKey(postUrl);
    const detected = await page.evaluate((code) => {
      function parseHumanNumber(raw) {
        if (!raw) return null;
        const clean = String(raw).trim().toLowerCase();
        // Soporte para "1,2 mil", "1.5k", "1,234", "1.234"
        if (clean.includes('mil') || clean.endsWith('k')) {
          const num = parseFloat(clean.replace(/[^\d.,]/g, '').replace(',', '.'));
          return Number.isNaN(num) ? null : Math.round(num * 1000);
        }
        const digitsOnly = clean.replace(/[^\d]/g, '');
        return digitsOnly ? parseInt(digitsOnly, 10) : null;
      }

      // 1. Buscar en scripts JSON internos de Instagram (Relay / Polaris store)
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

      // Segunda pasada en cualquier script application/json aunque no tenga el shortcode literal
      for (const s of scripts) {
        const txt = s.textContent || '';
        const match1 = txt.match(/"comment_count"\s*:\s*(\d+)/);
        if (match1) return parseInt(match1[1], 10);
      }

      // 2. Buscar en meta description / og:description ("123 likes, 45 comments" / "45 comentarios")
      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';
      const metaMatch = metaDesc.match(/([\d.,]+\s*(?:mil|k)?)\s+(?:comentarios|comments)/i);
      if (metaMatch) {
        const parsed = parseHumanNumber(metaMatch[1]);
        if (parsed !== null) return parsed;
      }

      // 3. Buscar texto visible "Ver los X comentarios" / "View all X comments"
      const bodyText = document.body ? document.body.innerText : '';
      const viewAllMatch = bodyText.match(
        /(?:Ver los|Ver todos los|View all)\s+([\d.,]+\s*(?:mil|k)?)\s+(?:comentarios|comments)/i
      );
      if (viewAllMatch) {
        const parsed = parseHumanNumber(viewAllMatch[1]);
        if (parsed !== null) return parsed;
      }

      // 4. Buscar contador junto al ícono SVG de Comentario (común en Reels y vista nueva)
      const commentSvg = document.querySelector(
        'svg[aria-label*="Comentario" i], svg[aria-label*="Comment" i]'
      );
      if (commentSvg) {
        const btnContainer = commentSvg.closest('div[role="button"], button, span');
        if (btnContainer && btnContainer.parentElement) {
          const textNear = btnContainer.parentElement.innerText || '';
          const parsed = parseHumanNumber(textNear);
          if (parsed !== null && parsed > 0) return parsed;
        }
      }

      return null;
    }, shortcode);

    return typeof detected === 'number' && !Number.isNaN(detected) ? detected : null;
  } catch {
    return null;
  }
}

/**
 * Extrae metadatos del post (autor, descripción corta) y toma una miniatura
 * en Base64 JPEG de la imagen/video del post para la Galería del Dashboard.
 */
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

      // Intentar obtener autor desde el header del post o desde og:title
      let foundAuthor = '';
      const headerLink = document.querySelector('article header a[href^="/"], main header a[href^="/"]');
      if (headerLink && headerLink.textContent) {
        foundAuthor = '@' + headerLink.textContent.trim().replace(/^@/, '');
      } else if (ogTitle) {
        const m = ogTitle.match(/^([^•(]+?)\s*(?:on Instagram|en Instagram)/i);
        if (m) foundAuthor = m[1].trim();
      }

      // Limpiar descripción corta
      let foundCaption = metaDesc;
      const quoteMatch = metaDesc.match(/:\s*"([^"]+)"/);
      if (quoteMatch) {
        foundCaption = quoteMatch[1];
      } else if (ogTitle) {
        foundCaption = ogTitle;
      }

      return {
        author: foundAuthor.slice(0, 50),
        caption: foundCaption.slice(0, 140),
      };
    });

    author = meta.author || '';
    caption = meta.caption || '';
  } catch {}

  try {
    // Capturar miniatura de la foto/video principal del post o de la parte central de la página
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

/**
 * Calcula el porcentaje bruto y la probabilidad real estimada de ganar en un post.
 */
function calculateWinProbabilities(myCommentsCount, postTotalComments) {
  const myCount = Math.max(0, Number(myCommentsCount) || 0);
  const totalPost = Math.max(myCount, Number(postTotalComments) || 0);

  if (totalPost <= 0 || myCount <= 0) {
    return {
      rawPercent: 0,
      estimatedRealPercent: 0,
      oneInX: null,
    };
  }

  const rawPercent = (myCount / totalPost) * 100;
  // Estimación real: ~25% de los comentarios de otros usuarios suelen ser descartados
  // por las plataformas de sorteos (respuestas anidadas, sin menciones suficientes o duplicados),
  // mientras que tus comentarios llevan validación anti-duplicado.
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

  const postKey = normalizePostKey(postUrl);
  const initialMyCount = ANALYTICS.myCommentsByPost[postKey] || 0;

  upsertPostInCatalog(postUrl, {
    myComments: initialMyCount,
    savedConfig: {
      baseComment,
      tagsPerComment,
      totalComments,
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
    postUrl,
    postKey,
    baseComment,
    tagsPerComment,
    usersCount: users.length,
    running: true,
    cancelRequested: false,
    completed: 0,
    total: totalComments,
    postTotalComments: null,
    myTotalInPost: initialMyCount,
    probabilities: { rawPercent: 0, estimatedRealPercent: 0, oneInX: null },
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

      // Escuchar respuestas de red de Instagram por si viene comment_count en JSON/GraphQL
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

      console.log(`\n🌐 [Post #${jobId}] Abriendo pestaña y navegando a: ${postUrl}`);
      await jobPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await jobPage.waitForTimeout(2500);

      await dismissCookiesModal(jobPage);
      await dismissPostLoginModals(jobPage);

      // Extraer el total de comentarios y los detalles/foto del post para la Galería del Dashboard
      const detectedTotal = await extractPostCommentCount(jobPage, postUrl);
      const details = await extractPostDetailsAndThumbnail(jobPage);

      if (detectedTotal !== null) {
        job.postTotalComments = Math.max(detectedTotal, job.myTotalInPost);
        job.probabilities = calculateWinProbabilities(job.myTotalInPost, job.postTotalComments);
        console.log(
          `📊 [Post #${jobId}] Comentarios totales detectados en el post: ${job.postTotalComments} ` +
          `(Tuyos acumulados: ${job.myTotalInPost} -> Probabilidad actual: ${job.probabilities.estimatedRealPercent}%)`
        );
      }

      upsertPostInCatalog(postUrl, {
        author: details.author,
        caption: details.caption,
        thumbnail: details.thumbnail,
        myComments: job.myTotalInPost,
        postTotalComments: job.postTotalComments,
        probabilities: job.probabilities,
      });

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

        const { commentText: commentToSend, combinationKey, selectedUsers } = buildUniqueGiveawayComment({
          users,
          tagsPerComment,
          baseComment,
          antiDuplicate,
          allowEmojis,
          usedSet: usedCommentsSet,
          lastKey: lastCombinationKey,
          commentIndex: i,
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
        recordCommentAnalytics(selectedUsers, postUrl);
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
// Servidor Local para la Ventana del Panel de Control y el Dashboard
// ============================================================================
function startControlServer({
  onStartBatch,
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
              postTotalComments: j.postTotalComments,
              myTotalInPost: j.myTotalInPost,
              probabilities: j.probabilities,
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
