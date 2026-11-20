const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const express = require('express');
const rateLimit = require('express-rate-limit');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (_) {}

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {}

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// Credenciales y secretos exclusivamente desde variables de entorno
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_USER = process.env.EMAIL_USER || 'activaciones@app.fullpremiumtvcl.com';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://app.fullpremiumtvcl.com,http://app.fullpremiumtvcl.com')
  .split(',')
  .map(o => o.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_HOSTS = ALLOWED_ORIGINS.map((o) => {
  try { return new URL(o).host.toLowerCase(); } catch (_) { return ''; }
}).filter(Boolean);

const ADMIN_COOKIE_NAME = 'tvgo_admin_session';
const ADMIN_SESSION_TTL_SEC = 8 * 60 * 60; // 8 horas

function resolveDataDir() {
  if (process.env.DATA_DIR && process.env.DATA_DIR.trim()) {
    return path.resolve(process.env.DATA_DIR.trim());
  }
  if (NODE_ENV === 'production') {
    try {
      const persistentDir = path.join(os.homedir(), '.fullpremiumtvgo-data');
      if (!fs.existsSync(persistentDir)) {
        fs.mkdirSync(persistentDir, { recursive: true });
      }
      const legacyDb = path.join(__dirname, 'data', 'db.json');
      const newDb = path.join(persistentDir, 'db.json');
      if (fs.existsSync(legacyDb) && !fs.existsSync(newDb)) {
        fs.copyFileSync(legacyDb, newDb);
      }
      return persistentDir;
    } catch (_) {}
  }
  return path.join(__dirname, 'data');
}

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!ADMIN_PASSWORD) {
  console.warn('[SECURITY WARNING] ADMIN_PASSWORD no está configurada en process.env. El login de administrador permanecerá deshabilitado.');
}

const mailTransporter = (nodemailer && EMAIL_PASS) ? nodemailer.createTransport({
  host: 'smtp.hostinger.com',
  port: 465,
  secure: true,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
}) : null;

async function sendActivationEmail(toEmail, deviceId, paymentId, tier) {
  if (!mailTransporter || !toEmail) return;
  const price = tier === 'OFFICIAL' ? '$4.000 CLP' : '$6.000 CLP';
  const mailOptions = {
    from: `"Full Premium TvGo" <${EMAIL_USER}>`,
    to: toEmail,
    subject: `Confirmación de Activación — Full Premium TvGo (${deviceId})`,
    html: `
      <div style="font-family: Arial, sans-serif; background-color: #0B0F19; color: #ffffff; padding: 25px; border-radius: 12px; max-width: 550px; margin: auto;">
        <h2 style="color: #8b5cf6; margin-top: 0;">¡Tu Suscripción Anual está Activa! 🎉</h2>
        <p style="font-size: 14px; color: #cbd5e1;">Tu pago ha sido procesado con éxito vía Mercado Pago Chile.</p>
        <div style="background-color: #1e293b; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 5px 0; font-size: 13px;"><strong>ID de Dispositivo:</strong> <code style="color: #a78bfa;">${deviceId}</code></p>
          <p style="margin: 5px 0; font-size: 13px;"><strong>Vigencia:</strong> 365 Días (1 Año Completo)</p>
          <p style="margin: 5px 0; font-size: 13px;"><strong>Plan:</strong> ${tier === 'OFFICIAL' ? 'Cliente Oficial' : 'Lista Propia'} (${price})</p>
          <p style="margin: 5px 0; font-size: 13px;"><strong>ID Pago:</strong> <code style="color: #94a3b8;">${paymentId}</code></p>
        </div>
        <p style="font-size: 11px; color: #64748b; text-align: center;">
          Soporte: +56979429123 | activations@app.fullpremiumtvcl.com
        </p>
      </div>
    `
  };

  try {
    await mailTransporter.sendMail(mailOptions);
  } catch (err) {
    console.error('Error enviando email:', err.message);
  }
}

const defaultDb = {
  settings: {
    priceOfficialCLP: 4000,
    priceExternalCLP: 6000,
    trialDays: 12,
    whatsappNumber: '+56979429123',
    officialEmail: 'activaciones@app.fullpremiumtvcl.com'
  },
  broadcastMessage: {
    text: '',
    active: false,
    updatedAt: Date.now()
  },
  devices: {},
  licenses: {}
};

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb, null, 2));
      return JSON.parse(JSON.stringify(defaultDb));
    }
    const content = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(content);
    return {
      settings: { ...defaultDb.settings, ...(parsed.settings || {}) },
      broadcastMessage: parsed.broadcastMessage || defaultDb.broadcastMessage,
      devices: parsed.devices || {},
      licenses: parsed.licenses || {}
    };
  } catch (err) {
    return JSON.parse(JSON.stringify(defaultDb));
  }
}

function saveDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error al guardar db.json:', err);
  }
}

function computeAccess(device, settings) {
  const now = Date.now();
  const trialDurationMs = (settings.trialDays || 12) * 24 * 60 * 60 * 1000;

  if (device.blockedManually) {
    return { allowed: false, status: 'BLOCKED_ADMIN', daysLeft: 0, expiresAt: null, reason: 'Dispositivo bloqueado.' };
  }

  if (device.licenseEndsAt && device.licenseEndsAt > now) {
    const msLeft = device.licenseEndsAt - now;
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
    return { allowed: true, status: 'LICENSED', daysLeft, expiresAt: device.licenseEndsAt };
  }

  const trialEndsAt = device.firstSeenAt + trialDurationMs;
  if (now < trialEndsAt) {
    const msLeft = trialEndsAt - now;
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
    return { allowed: true, status: 'TRIAL', daysLeft, expiresAt: trialEndsAt };
  }

  return { allowed: false, status: 'EXPIRED_TRIAL', daysLeft: 0, expiresAt: trialEndsAt, reason: 'Periodo de prueba finalizado.' };
}

function safeCompareStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function signAdminJwt() {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(JSON.stringify({
    role: 'ADMIN',
    iat: nowSec,
    exp: nowSec + ADMIN_SESSION_TTL_SEC
  }));
  const signature = crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifyAdminJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  if (!safeCompareStrings(signature, expectedSig)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.role !== 'ADMIN') return null;
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const cookies = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      cookies[k] = decodeURIComponent(v);
    }
  });
  return cookies;
}

function isAdminRequest(req) {
  const cookies = parseCookies(req);
  if (cookies[ADMIN_COOKIE_NAME] && verifyAdminJwt(cookies[ADMIN_COOKIE_NAME])) {
    return true;
  }
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return Boolean(verifyAdminJwt(authHeader.slice(7).trim()));
  }
  return false;
}

function setAdminCookie(req, res, token) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || NODE_ENV === 'production';
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${ADMIN_SESSION_TTL_SEC}`
  ];
  if (isSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAdminCookie(req, res) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || NODE_ENV === 'production';
  const parts = [
    `${ADMIN_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (isSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function isOriginAllowed(originOrReferer) {
  if (!originOrReferer) return false;
  try {
    const parsed = new URL(originOrReferer);
    const origin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    if (NODE_ENV !== 'production' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function isProxyRequestAllowed(req) {
  const secFetchSite = (req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') return false;

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    return isOriginAllowed(origin);
  }

  const referer = req.headers.referer;
  if (referer) {
    return isOriginAllowed(referer);
  }

  // Web Workers (mpegts.js / hls.js en blob:) y <video> en Smart TVs omiten Origin/Referer en peticiones same-origin
  if (secFetchSite === 'same-origin') return true;

  const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (reqHost && ALLOWED_HOSTS.includes(reqHost)) return true;
  if (NODE_ENV !== 'production' && (reqHost.startsWith('localhost') || reqHost.startsWith('127.0.0.1'))) return true;

  return false;
}

function isPrivateOrBlockedHost(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '::1' || lower.endsWith('.local')) return true;
  if (net.isIPv4(lower)) {
    const octets = lower.split('.').map(Number);
    if (octets[0] === 10) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 0) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
  }
  if (net.isIPv6(lower)) {
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
      return true;
    }
  }
  return false;
}

function verifyMercadoPagoSignature(req, dataId) {
  if (!MP_WEBHOOK_SECRET) return true;
  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  if (!xSignature || !xRequestId || !dataId) return false;

  let ts = '';
  let v1 = '';
  xSignature.split(',').forEach((part) => {
    const [k, v] = part.split('=').map(s => s.trim());
    if (k === 'ts') ts = v;
    if (k === 'v1') v1 = v;
  });

  if (!ts || !v1) return false;
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeCompareStrings(v1, expected);
}

function callMercadoPago(apiPath, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    if (!MP_ACCESS_TOKEN) {
      return reject(new Error('MP_ACCESS_TOKEN no configurado en process.env'));
    }
    const bodyStr = data ? JSON.stringify(data) : '';
    const options = {
      hostname: 'api.mercadopago.com',
      port: 443,
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'FullPremiumTvGo/6.0'
      }
    };
    if (data) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const mpReq = https.request(options, (mpRes) => {
      let resBody = '';
      mpRes.on('data', chunk => { resBody += chunk; });
      mpRes.on('end', () => {
        try {
          resolve({ status: mpRes.statusCode, body: JSON.parse(resBody) });
        } catch (_) {
          resolve({ status: mpRes.statusCode, body: resBody });
        }
      });
    });

    mpReq.on('error', reject);
    if (data) mpReq.write(bodyStr);
    mpReq.end();
  });
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// CORS estricto para orígenes permitidos
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Rate limiters anti-fuerza bruta
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos fallidos. Espera 15 minutos antes de volver a intentar.' }
});

const deviceSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones de sincronización.' }
});

function isValidPlaylistObject(pl) {
  if (!pl || typeof pl !== 'object') return false;
  if (pl.type === 'M3U' && typeof pl.m3uUrl === 'string' && pl.m3uUrl.trim().length > 5) return true;
  if (pl.type === 'XTREAM' && typeof pl.host === 'string' && pl.host.trim().length > 5 && typeof pl.username === 'string' && pl.username.trim().length > 0 && typeof pl.password === 'string' && pl.password.trim().length > 0) return true;
  return false;
}

// 1. INICIALIZACIÓN DE LA PANTALLA
app.post('/api/device/init', deviceSyncLimiter, (req, res) => {
  try {
    const payload = req.body || {};
    const deviceId = (payload.deviceId || '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId es requerido' });

    const savedPin = typeof payload.savedPin === 'string' && /^\d{4}$/.test(payload.savedPin.trim())
      ? payload.savedPin.trim()
      : null;
    const savedPlaylist = isValidPlaylistObject(payload.savedPlaylist) ? payload.savedPlaylist : null;

    const db = loadDb();
    let device = db.devices[deviceId];
    const now = Date.now();

    if (!device) {
      const permanentPin = savedPin || Math.floor(1000 + Math.random() * 9000).toString();
      device = {
        deviceId,
        devicePin: permanentPin,
        firstSeenAt: now,
        lastSeenAt: now,
        clientType: payload.clientType === 'EXTERNAL' ? 'EXTERNAL' : 'OFFICIAL',
        providerLabel: payload.providerLabel || 'Full Premium TvGo',
        username: savedPlaylist?.username || payload.username || null,
        deviceModel: payload.deviceModel || 'Smart TV / PC',
        clientNote: payload.clientNote || '',
        playlist: savedPlaylist,
        playlistClearedAt: null,
        licenseCode: null,
        licenseEndsAt: null,
        customMessage: null,
        blockedManually: false
      };
      db.devices[deviceId] = device;
    } else {
      device.lastSeenAt = now;
      if (!device.devicePin) {
        device.devicePin = savedPin || Math.floor(1000 + Math.random() * 9000).toString();
      }
      // Preservar lista cargada en la app si el servidor perdió el registro tras una actualización (y no fue borrada manualmente)
      if (!device.playlist && !device.playlistClearedAt && savedPlaylist) {
        device.playlist = savedPlaylist;
        if (savedPlaylist.username && !device.username) {
          device.username = savedPlaylist.username;
        }
      }
    }

    saveDb(db);
    const access = computeAccess(device, db.settings);

    return res.status(200).json({
      deviceId: device.deviceId,
      devicePin: device.devicePin,
      deviceModel: device.deviceModel,
      clientNote: device.clientNote,
      playlist: device.playlist || null,
      playlistCleared: Boolean(device.playlistClearedAt && !device.playlist),
      access,
      pricing: db.settings,
      adminNotice: device.customMessage ? { text: device.customMessage, active: true, target: 'PRIVATE' } : db.broadcastMessage,
      exchange: {
        base: 'CLP',
        rates: { CLP: 1, PEN: 0.00395, USD: 0.00105, EUR: 0.00097, ARS: 1.05, MXN: 0.021, COP: 4.45, BRL: 0.0059 }
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 2. CONSULTAR CONFIGURACIÓN REMOTA (POLLING DESDE LA TV)
app.get('/api/device/config', deviceSyncLimiter, (req, res) => {
  const deviceId = (req.query.deviceId || '').toString().trim();
  if (!deviceId) return res.status(400).json({ error: 'deviceId es requerido' });

  const db = loadDb();
  const device = db.devices[deviceId];
  if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });

  return res.status(200).json({
    deviceId: device.deviceId,
    devicePin: device.devicePin,
    deviceModel: device.deviceModel,
    clientNote: device.clientNote,
    playlist: device.playlist || null,
    adminNotice: device.customMessage ? { text: device.customMessage, active: true, target: 'PRIVATE' } : db.broadcastMessage,
    access: computeAccess(device, db.settings)
  });
});

// 3A. LOGIN DE ADMINISTRADOR (VALIDACIÓN BACKEND + COOKIE HTTPONLY)
app.post('/api/admin/login', authLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Autenticación de administrador no configurada en el servidor.' });
  }
  const password = ((req.body && req.body.password) || '').toString().trim();
  if (!safeCompareStrings(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Contraseña de administrador incorrecta.' });
  }

  const token = signAdminJwt();
  setAdminCookie(req, res, token);

  const db = loadDb();
  const deviceList = Object.values(db.devices).map(dev => ({
    ...dev,
    computed: computeAccess(dev, db.settings)
  }));

  return res.status(200).json({
    ok: true,
    role: 'ADMIN',
    devices: deviceList,
    settings: db.settings,
    licenses: Object.values(db.licenses)
  });
});

app.get('/api/admin/session', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ ok: false, error: 'Sesión no válida' });
  }
  const db = loadDb();
  const deviceList = Object.values(db.devices).map(dev => ({
    ...dev,
    computed: computeAccess(dev, db.settings)
  }));
  return res.status(200).json({
    ok: true,
    role: 'ADMIN',
    devices: deviceList,
    settings: db.settings,
    licenses: Object.values(db.licenses)
  });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminCookie(req, res);
  return res.status(200).json({ ok: true });
});

// 3B. LOGIN DE CLIENTE (SOLO ID DE PANTALLA + PIN DE 4 DÍGITOS)
app.post('/api/client/login', authLimiter, (req, res) => {
  try {
    const payload = req.body || {};
    const inputId = (payload.deviceId || '').toString().trim();
    const inputPass = (payload.devicePin || '').toString().trim();

    if (!inputId || inputId.toUpperCase() === 'ADMIN') {
      return res.status(400).json({ error: 'Usa el acceso de administrador para ADMIN.' });
    }

    const db = loadDb();
    const device = db.devices[inputId];

    if (!device) {
      return res.status(404).json({ error: 'El ID de dispositivo no existe. Inicia la app en tu TV primero.' });
    }

    if (!safeCompareStrings(device.devicePin || '', inputPass)) {
      return res.status(401).json({ error: 'Clave PIN incorrecta. Revisa el código fijo en tu pantalla.' });
    }

    return res.status(200).json({
      ok: true,
      role: 'CLIENT',
      device: {
        deviceId: device.deviceId,
        devicePin: device.devicePin,
        deviceModel: device.deviceModel,
        clientNote: device.clientNote,
        playlist: device.playlist || null,
        access: computeAccess(device, db.settings)
      },
      pricing: db.settings
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 4. GUARDAR / EDITAR LISTA REMOTAMENTE
app.post('/api/client/save-playlist', (req, res) => {
  try {
    const payload = req.body || {};
    const targetId = (payload.deviceId || '').toString().trim();
    const pin = (payload.devicePin || '').toString().trim();
    const playlist = payload.playlist;
    const clientNote = (payload.clientNote || '').toString().trim();
    const deviceModel = (payload.deviceModel || '').toString().trim();

    const db = loadDb();
    const device = db.devices[targetId];
    if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });

    const adminAuthorized = isAdminRequest(req);
    if (!adminAuthorized && !safeCompareStrings(device.devicePin || '', pin)) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    device.playlist = playlist;
    device.playlistClearedAt = null;
    if (clientNote) device.clientNote = clientNote;
    if (deviceModel) device.deviceModel = deviceModel;
    if (playlist?.username) device.username = playlist.username;

    if (playlist?.type === 'XTREAM' && playlist.host && !playlist.host.includes('aejo-gqa.de')) {
      device.clientType = 'EXTERNAL';
    }

    saveDb(db);
    return res.status(200).json({
      ok: true,
      message: '¡Lista guardada con éxito! Tu pantalla se sincronizará automáticamente.',
      playlist: device.playlist
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 5. ELIMINAR LISTA DE UN DISPOSITIVO (POR CLIENTE O ADMIN)
app.post('/api/client/delete-playlist', (req, res) => {
  try {
    const payload = req.body || {};
    const targetId = (payload.deviceId || '').toString().trim();
    const pin = (payload.devicePin || '').toString().trim();

    const db = loadDb();
    const device = db.devices[targetId];
    if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });

    const adminAuthorized = isAdminRequest(req);
    if (!adminAuthorized && !safeCompareStrings(device.devicePin || '', pin)) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    device.playlist = null;
    device.playlistClearedAt = Date.now();
    saveDb(db);

    return res.status(200).json({ ok: true, message: 'Lista eliminada del dispositivo.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 6. ACCIONES ADMIN (PROTEGIDAS POR SESIÓN ADMIN)
app.post('/api/admin/device-action', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: 'Acceso no autorizado' });
  }

  try {
    const payload = req.body || {};
    const { deviceId, action } = payload;
    const db = loadDb();
    const device = db.devices[deviceId];

    if (!device && action !== 'DELETE') {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    const now = Date.now();
    if (action === 'DELETE') {
      delete db.devices[deviceId];
      saveDb(db);
      return res.status(200).json({ ok: true, message: 'Dispositivo eliminado permanentemente.' });
    } else if (action === 'EDIT_DETAILS') {
      if (payload.clientNote !== undefined) device.clientNote = String(payload.clientNote).trim();
      if (payload.deviceModel !== undefined) device.deviceModel = String(payload.deviceModel).trim();
      if (payload.devicePin !== undefined && String(payload.devicePin).trim()) {
        device.devicePin = String(payload.devicePin).trim();
      }
    } else if (action === 'SEND_MESSAGE') {
      device.customMessage = payload.text ? String(payload.text).trim() : null;
    } else if (action === 'RESET_TRIAL') {
      device.firstSeenAt = now;
      device.licenseEndsAt = null;
      device.blockedManually = false;
    } else if (action === 'ACTIVATE_1Y') {
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      const currentEnd = (device.licenseEndsAt && device.licenseEndsAt > now) ? device.licenseEndsAt : now;
      device.licenseEndsAt = currentEnd + oneYearMs;
      device.blockedManually = false;
    }

    saveDb(db);
    return res.status(200).json({ ok: true, device, access: computeAccess(device, db.settings) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 7. MERCADO PAGO: PREFERENCIA
app.post('/api/payment/create-preference', async (req, res) => {
  try {
    const payload = req.body || {};
    const deviceId = (payload.deviceId || '').toString().trim();
    const tier = payload.tier === 'EXTERNAL' ? 'EXTERNAL' : 'OFFICIAL';

    if (!deviceId) return res.status(400).json({ error: 'deviceId es requerido' });

    const db = loadDb();
    const unitPrice = tier === 'OFFICIAL' ? db.settings.priceOfficialCLP : db.settings.priceExternalCLP;
    const title = tier === 'OFFICIAL'
      ? 'Licencia Anual (365 Días) — Full Premium TvGo Oficial'
      : 'Licencia Anual (365 Días) — Full Premium TvGo (Lista Propia)';

    const host = req.headers.host || 'app.fullpremiumtvcl.com';
    const baseUrl = `https://${host}`;

    const preferenceData = {
      items: [{
        id: `LIC-365-${tier}`,
        title: `${title} [ID: ${deviceId}]`,
        description: `Activación anual para ${deviceId}`,
        quantity: 1,
        currency_id: 'CLP',
        unit_price: Number(unitPrice)
      }],
      payer: { email: payload.email || 'cliente@app.fullpremiumtvcl.com' },
      metadata: { device_id: deviceId, tier },
      back_urls: {
        success: `${baseUrl}/client.html?status=success&device=${encodeURIComponent(deviceId)}`,
        failure: `${baseUrl}/client.html?status=failure&device=${encodeURIComponent(deviceId)}`,
        pending: `${baseUrl}/client.html?status=pending&device=${encodeURIComponent(deviceId)}`
      },
      auto_return: 'approved',
      notification_url: `${baseUrl}/api/webhooks/mercadopago`
    };

    const mpResponse = await callMercadoPago('/checkout/preferences', 'POST', preferenceData);

    if (mpResponse.status >= 200 && mpResponse.status < 300) {
      return res.status(200).json({
        preferenceId: mpResponse.body.id,
        init_point: mpResponse.body.init_point,
        publicKey: MP_PUBLIC_KEY
      });
    }
    return res.status(500).json({ error: 'Error al comunicarse con Mercado Pago', details: mpResponse.body });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 8. WEBHOOK MERCADO PAGO (FIRMA + MONTO + IDEMPOTENCIA)
async function handleMercadoPagoWebhook(req, res) {
  try {
    const paymentId = (
      req.query['data.id'] ||
      req.query.id ||
      req.body?.data?.id ||
      req.body?.id ||
      ''
    ).toString().trim();

    if (!paymentId) {
      return res.status(200).send('OK');
    }

    if (!verifyMercadoPagoSignature(req, paymentId)) {
      console.warn(`[WEBHOOK MP] Firma x-signature inválida para pago ${paymentId}`);
      return res.status(401).send('INVALID_SIGNATURE');
    }

    const mpRes = await callMercadoPago(`/v1/payments/${encodeURIComponent(paymentId)}`);
    if (mpRes.status === 200 && mpRes.body && mpRes.body.status === 'approved') {
      const payment = mpRes.body;
      const targetDeviceId = payment.metadata?.device_id;
      const tier = payment.metadata?.tier === 'EXTERNAL' ? 'EXTERNAL' : 'OFFICIAL';
      const payerEmail = payment.payer?.email;

      const db = loadDb();

      // Idempotencia: evitar acreditar días duplicados ante reintentos
      if (db.licenses[paymentId]) {
        return res.status(200).send('ALREADY_PROCESSED');
      }

      const expectedAmount = Number(
        tier === 'EXTERNAL' ? db.settings.priceExternalCLP : db.settings.priceOfficialCLP
      );
      if (payment.currency_id !== 'CLP' || Number(payment.transaction_amount) < expectedAmount) {
        console.warn(`[WEBHOOK MP] Monto o moneda inválida para pago ${paymentId}: ${payment.transaction_amount} ${payment.currency_id}`);
        return res.status(200).send('AMOUNT_MISMATCH');
      }

      if (targetDeviceId) {
        let device = db.devices[targetDeviceId];
        const oneYearMs = 365 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        if (!device) {
          device = {
            deviceId: targetDeviceId,
            devicePin: Math.floor(1000 + Math.random() * 9000).toString(),
            firstSeenAt: now,
            lastSeenAt: now,
            clientType: tier,
            licenseEndsAt: now + oneYearMs,
            blockedManually: false
          };
          db.devices[targetDeviceId] = device;
        } else {
          const currentEnd = (device.licenseEndsAt && device.licenseEndsAt > now) ? device.licenseEndsAt : now;
          device.licenseEndsAt = currentEnd + oneYearMs;
          device.blockedManually = false;
        }

        db.licenses[paymentId] = {
          paymentId,
          deviceId: targetDeviceId,
          tier,
          amount: Number(payment.transaction_amount),
          currency: payment.currency_id,
          processedAt: now
        };

        saveDb(db);
        sendActivationEmail(payerEmail, targetDeviceId, paymentId, tier);
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[WEBHOOK MP ERROR]', err.message);
    return res.status(200).send('ERROR_HANDLED');
  }
}

app.all('/api/webhooks/mercadopago', handleMercadoPagoWebhook);
app.all('/api/webhook/mercadopago', handleMercadoPagoWebhook);

// 9. GESTOR DE PROCESOS Y PROXY ULTRA RÁPIDO PARA STREAMING
const activeDeviceFfmpeg = new Map();
const activeDeviceLiveProxy = new Map();

function killDeviceFfmpeg(deviceId) {
  if (!deviceId) return;
  const prev = activeDeviceFfmpeg.get(deviceId);
  if (prev && typeof prev === 'function') {
    try { prev(); } catch (_) {}
  }
  activeDeviceFfmpeg.delete(deviceId);
}

function killDeviceLiveProxy(deviceId) {
  if (!deviceId) return;
  const prev = activeDeviceLiveProxy.get(deviceId);
  if (prev && typeof prev === 'function') {
    try { prev(); } catch (_) {}
  }
  activeDeviceLiveProxy.delete(deviceId);
}

app.get('/api/media/stop', (req, res) => {
  const deviceId = (req.query.deviceId || '').toString().trim();
  if (deviceId) {
    killDeviceFfmpeg(deviceId);
    killDeviceLiveProxy(deviceId);
  }
  return res.status(200).json({ ok: true });
});

function handleStreamProxy(req, res) {
  const targetUrl = (req.query.url || '').toString();
  const deviceId = (req.query.deviceId || '').toString().trim();
  if (!targetUrl) {
    return res.status(400).type('text/plain').send('Falta parámetro url');
  }

  const isApiCall = targetUrl.includes('player_api.php') || targetUrl.includes('panel_api.php') || targetUrl.includes('xmltv.php');
  const isLiveStreamReq = !isApiCall && (targetUrl.includes('/live/') || /\.ts(\?|$)/i.test(targetUrl));

  if (!isApiCall && deviceId) {
    // Si el usuario pidió un stream directo por /proxy, cerrar cualquier ffmpeg anterior de ese dispositivo
    killDeviceFfmpeg(deviceId);
    if (isLiveStreamReq) {
      killDeviceLiveProxy(deviceId);
    }
  }

  let activeProxyReq = null;
  let activeProxyRes = null;
  let clientClosed = false;

  const cleanupProxy = () => {
    clientClosed = true;
    if (activeProxyRes) {
      try { activeProxyRes.destroy(); } catch (_) {}
      activeProxyRes = null;
    }
    if (activeProxyReq) {
      try { activeProxyReq.destroy(); } catch (_) {}
      activeProxyReq = null;
    }
  };

  if (isLiveStreamReq && deviceId) {
    activeDeviceLiveProxy.set(deviceId, cleanupProxy);
  }

  res.on('close', () => {
    cleanupProxy();
    if (isLiveStreamReq && deviceId && activeDeviceLiveProxy.get(deviceId) === cleanupProxy) {
      activeDeviceLiveProxy.delete(deviceId);
    }
  });

  const proxyStream = (currentUrl, redirectCount = 0) => {
    if (clientClosed) return;
    if (redirectCount > 6) {
      if (!res.headersSent) res.status(502).type('text/plain').send('Demasiadas redirecciones');
      return;
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(currentUrl);
    } catch (_) {
      if (!res.headersSent) res.status(400).type('text/plain').send('URL inválida');
      return;
    }

    if (!['http:', 'https:'].includes(parsedTarget.protocol) || isPrivateOrBlockedHost(parsedTarget.hostname)) {
      if (!res.headersSent) res.status(403).type('text/plain').send('Destino no permitido');
      return;
    }

    const client = parsedTarget.protocol === 'https:' ? https : http;
    const proxyReq = client.request(currentUrl, {
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Connection': 'close',
        ...(req.headers.range ? { 'Range': req.headers.range } : {})
      }
    }, (proxyRes) => {
      if (clientClosed) {
        try { proxyRes.destroy(); } catch (_) {}
        return;
      }

      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        proxyRes.resume();
        const nextUrl = url.resolve(currentUrl, proxyRes.headers.location);
        return proxyStream(nextUrl, redirectCount + 1);
      }

      activeProxyRes = proxyRes;

      const isLiveStream = currentUrl.includes('/live/') || /\.ts(\?|$)/i.test(currentUrl);
      const isMkv = /\.mkv(\?|$)/i.test(currentUrl);
      const isHls = /\.m3u8(\?|$)/i.test(currentUrl);
      const fallbackMime = isApiCall
        ? 'application/json; charset=utf-8'
        : isHls
          ? 'application/vnd.apple.mpegurl'
          : isLiveStream
            ? 'video/mp2t'
            : isMkv
              ? 'video/x-matroska'
              : 'video/mp4';

      const upstreamType = proxyRes.headers['content-type'];
      const contentType = (upstreamType && upstreamType !== 'application/octet-stream') ? upstreamType : fallbackMime;

      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Accel-Buffering': 'no'
      };

      if (proxyRes.headers['content-length'] && !isLiveStream) {
        responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
      }
      if (proxyRes.headers['content-range']) responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
      if (proxyRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

      if (res.socket) res.socket.setNoDelay(true);

      res.writeHead(proxyRes.statusCode || 200, responseHeaders);
      proxyRes.pipe(res);
    });

    activeProxyReq = proxyReq;

    proxyReq.on('error', (err) => {
      if (clientClosed) return;
      if (!res.headersSent) {
        res.status(502).type('text/plain').send('Error de conexión: ' + err.message);
      }
    });

    if (req.method === 'GET' || req.method === 'HEAD') {
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
  };

  proxyStream(targetUrl);
}

app.get('/proxy', handleStreamProxy);
app.head('/proxy', handleStreamProxy);
app.get('/api/proxy', handleStreamProxy);
app.head('/api/proxy', handleStreamProxy);

// 9B. DETECTOR DE PISTAS DE AUDIO (DUAL AUDIO / MULTI-IDIOMA) CON FFMPEG
const LANG_LABELS = {
  spa: 'Español / Latino',
  es: 'Español / Latino',
  lat: 'Español Latino',
  cast: 'Castellano',
  eng: 'Inglés (Original)',
  en: 'Inglés (Original)',
  por: 'Portugués',
  pt: 'Portugués',
  fra: 'Francés',
  ita: 'Italiano',
  jpn: 'Japonés',
  kor: 'Coreano',
  und: 'Audio'
};

app.get('/api/media/tracks', (req, res) => {
  const targetUrl = (req.query.url || '').toString().trim();
  if (!targetUrl || !ffmpegPath) {
    return res.status(200).json({ ok: false, audioTracks: [] });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (_) {
    return res.status(400).json({ ok: false, audioTracks: [] });
  }
  if (!['http:', 'https:'].includes(parsedTarget.protocol) || isPrivateOrBlockedHost(parsedTarget.hostname)) {
    return res.status(403).json({ ok: false, audioTracks: [] });
  }

  let stderrData = '';
  let finished = false;

  const proc = spawn(ffmpegPath, [
    '-hide_banner',
    '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    '-probesize', '65536',
    '-analyzeduration', '0',
    '-fpsprobesize', '0',
    '-i', targetUrl
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const finishProbe = () => {
    if (finished) return;
    finished = true;
    try { proc.kill('SIGKILL'); } catch (_) {}

    const tracks = [];
    let videoCodec = '';
    let videoWidth = 0;
    let videoHeight = 0;
    let is10Bit = false;
    let hasIncompatibleSubs = false;

    if (/hdmv_pgs_subtitle|dvd_subtitle|Could not find codec parameters for stream/i.test(stderrData)) {
      hasIncompatibleSubs = true;
    }

    const lines = stderrData.split(/\r?\n/);
    let audioIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!videoCodec && /Stream #\d+:\d+.*:\s*Video:\s*([a-zA-Z0-9_]+)/i.test(line) && !/attached_pic|\bpng\b|\bmjpeg\b/i.test(line)) {
        const vm = line.match(/Video:\s*([a-zA-Z0-9_]+)/i);
        if (vm) videoCodec = vm[1].toLowerCase();
        const resM = line.match(/\b(\d{3,4})x(\d{3,4})\b/);
        if (resM) {
          videoWidth = parseInt(resM[1], 10) || 0;
          videoHeight = parseInt(resM[2], 10) || 0;
        }
        if (/yuv420p10|Main 10|bt2020/i.test(line)) {
          is10Bit = true;
        }
      }

      const m = line.match(/Stream #\d+:\d+(?:\(([a-zA-Z0-9_-]+)\))?[^:]*:\s*Audio:\s*([a-zA-Z0-9_]+)/i);
      if (m) {
        const langCode = (m[1] || 'und').toLowerCase();
        const codec = (m[2] || 'aac').toLowerCase();
        let titleMeta = '';
        for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
          if (/Stream #\d+:\d+/.test(lines[j])) break;
          const tm = lines[j].match(/title\s*:\s*(.+)$/i);
          if (tm) {
            titleMeta = tm[1].trim();
            break;
          }
        }
        const baseLang = LANG_LABELS[langCode] || (langCode !== 'und' ? langCode.toUpperCase() : `Pista ${audioIdx + 1}`);
        const label = titleMeta ? `${baseLang} (${titleMeta})` : `${baseLang} — Pista ${audioIdx + 1}`;
        tracks.push({
          index: audioIdx,
          lang: langCode,
          codec,
          label
        });
        audioIdx++;
      }
    }

    return res.status(200).json({
      ok: true,
      videoCodec,
      videoWidth,
      videoHeight,
      is10Bit,
      hasIncompatibleSubs,
      audioTracks: tracks
    });
  };

  const timer = setTimeout(finishProbe, 5500);

  proc.stderr.on('data', (chunk) => {
    stderrData += chunk.toString();
    if (stderrData.includes('At least one output file must be specified')) {
      clearTimeout(timer);
      finishProbe();
    }
  });

  proc.on('error', () => {
    clearTimeout(timer);
    finishProbe();
  });

  proc.on('close', () => {
    clearTimeout(timer);
    finishProbe();
  });
});

// 9C. TRANSCODIFICADOR EN VIVO MPEG-TS (CONVIERTE CANALES MPEG2VIDEO/MP2/AC3 A H.264 + AAC PARA MPEGTS.JS)
app.get('/api/media/live-ts', (req, res) => {
  const targetUrl = (req.query.url || '').toString().trim();
  const deviceId = (req.query.deviceId || '').toString().trim();

  if (!targetUrl) {
    return res.status(400).type('text/plain').send('Falta parámetro url');
  }
  if (!ffmpegPath) {
    return handleStreamProxy(req, res);
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (_) {
    return res.status(400).type('text/plain').send('URL inválida');
  }
  if (!['http:', 'https:'].includes(parsedTarget.protocol) || isPrivateOrBlockedHost(parsedTarget.hostname)) {
    return res.status(403).type('text/plain').send('Destino no permitido');
  }

  if (deviceId) {
    killDeviceLiveProxy(deviceId);
    killDeviceFfmpeg(deviceId);
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-probesize', '131072',
    '-analyzeduration', '200000',
    '-fflags', '+genpts+discardcorrupt',
    '-i', targetUrl,
    '-map', '0:V:0?',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-vf', 'scale=1280:-2,format=yuv420p',
    '-g', '30',
    '-b:v', '2200k',
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-c:a', 'aac',
    '-ac', '2',
    '-ar', '48000',
    '-b:a', '128k',
    '-f', 'mpegts',
    'pipe:1'
  ];

  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'close',
    'X-Accel-Buffering': 'no'
  });

  if (res.socket) res.socket.setNoDelay(true);

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);

  const killProc = () => {
    try { proc.kill('SIGKILL'); } catch (_) {}
  };

  if (deviceId) {
    activeDeviceFfmpeg.set(deviceId, killProc);
  }

  res.on('close', () => {
    killProc();
    if (deviceId && activeDeviceFfmpeg.get(deviceId) === killProc) {
      activeDeviceFfmpeg.delete(deviceId);
    }
  });
  proc.on('error', killProc);
});

// 9D. STREAMING UNIVERSAL REMUX MATROSKA CON FFMPEG (CAMBIO DE PISTA DE AUDIO DUAL / AC3 / COMPATIBILIDAD 4K)
app.get('/api/media/stream', (req, res) => {
  const targetUrl = (req.query.url || '').toString().trim();
  const deviceId = (req.query.deviceId || '').toString().trim();
  const audioTrack = Math.max(0, parseInt(req.query.audioTrack || '0', 10) || 0);
  const startSec = Math.max(0, parseFloat(req.query.start || '0') || 0);
  const transcodeVideo = req.query.transcodeVideo === '1';

  if (!targetUrl) {
    return res.status(400).type('text/plain').send('Falta parámetro url');
  }
  if (!ffmpegPath) {
    return handleStreamProxy(req, res);
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (_) {
    return res.status(400).type('text/plain').send('URL inválida');
  }
  if (!['http:', 'https:'].includes(parsedTarget.protocol) || isPrivateOrBlockedHost(parsedTarget.hostname)) {
    return res.status(403).type('text/plain').send('Destino no permitido');
  }

  if (deviceId) {
    killDeviceLiveProxy(deviceId);
    killDeviceFfmpeg(deviceId);
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-probesize', '65536',
    '-analyzeduration', '0',
    '-fpsprobesize', '0',
    '-fflags', '+genpts+discardcorrupt'
  ];

  if (startSec > 0) {
    args.push('-ss', String(startSec));
  }

  args.push(
    '-i', targetUrl,
    '-map', '0:V:0?',
    '-map', `0:a:${audioTrack}?`,
    '-sn'
  );

  if (transcodeVideo) {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-vf', 'scale=1280:-2,format=yuv420p',
      '-g', '48',
      '-b:v', '2500k',
      '-maxrate', '2800k',
      '-bufsize', '5600k'
    );
  } else {
    args.push('-c:v', 'copy');
  }

  args.push(
    '-c:a', 'aac',
    '-ac', '2',
    '-ar', '48000',
    '-b:a', '160k',
    '-f', 'matroska',
    'pipe:1'
  );

  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': 'video/x-matroska',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'close',
    'X-Accel-Buffering': 'no'
  });

  if (res.socket) res.socket.setNoDelay(true);

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });

  proc.stdout.pipe(res);

  const killProc = () => {
    try { proc.kill('SIGKILL'); } catch (_) {}
  };

  if (deviceId) {
    activeDeviceFfmpeg.set(deviceId, killProc);
  }

  res.on('close', () => {
    killProc();
    if (deviceId && activeDeviceFfmpeg.get(deviceId) === killProc) {
      activeDeviceFfmpeg.delete(deviceId);
    }
  });
  proc.on('error', killProc);
});

// Bloquear panel legado inseguro en public/
app.get('/panel-control-privado-xyz.html', (_req, res) => {
  res.status(404).type('text/plain').send('Not Found');
});

// 10. ARCHIVOS ESTÁTICOS (SIN CACHÉ EN HTML/SW PARA ACTUALIZACIÓN INMEDIATA EN SMART TV)
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path === '/sw.js') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html', etag: false, lastModified: false }));

app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[FULL PREMIUM TVGO] Servidor activo en puerto ${PORT}`);
});
