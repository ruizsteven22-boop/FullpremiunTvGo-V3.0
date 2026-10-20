const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (_) {
  ffmpegPath = 'ffmpeg';
}

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_KEY || 'FullPremium2026*';
const OFFICIAL_HOST = 'http://st.xn--aejo-gqa.de:80';
const TRIAL_DAYS = 12;

// ============================================================================
// BASE DE DATOS PERSISTENTE DE DISPOSITIVOS Y LICENCIAS (data/db.json)
// ============================================================================
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (_) {}
  return {
    settings: {
      priceOfficialCLP: 4000,
      priceExternalCLP: 6000,
      trialDays: 12,
      whatsappNumber: '+56900000000',
      paymentInstructions: 'Transferencia Bancaria / Yape / MercadoPago / PayPal'
    },
    devices: {},
    licenses: {}
  };
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando DB:', e.message);
  }
}

// Evaluar estado de los 12 días de prueba o licencia anual de un dispositivo
function evaluateDeviceStatus(device) {
  const now = Date.now();
  const trialMs = TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const trialEndsAt = device.firstSeenAt + trialMs;

  if (device.blockedManually) {
    return {
      allowed: false,
      status: 'BLOCKED_ADMIN',
      daysLeft: 0,
      trialEndsAt,
      licenseEndsAt: device.licenseEndsAt || null
    };
  }

  if (device.licenseEndsAt && device.licenseEndsAt > now) {
    const daysLeft = Math.ceil((device.licenseEndsAt - now) / (1000 * 60 * 60 * 24));
    return {
      allowed: true,
      status: 'LICENSED',
      daysLeft,
      trialEndsAt,
      licenseEndsAt: device.licenseEndsAt
    };
  }

  if (now <= trialEndsAt) {
    const daysLeft = Math.max(1, Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)));
    return {
      allowed: true,
      status: 'TRIAL',
      daysLeft,
      trialEndsAt,
      licenseEndsAt: null
    };
  }

  return {
    allowed: false,
    status: 'EXPIRED_TRIAL',
    daysLeft: 0,
    trialEndsAt,
    licenseEndsAt: device.licenseEndsAt || null
  };
}

// ============================================================================
// TIPO DE CAMBIO DEL DÍA (Caché de 6 horas con respaldo automático)
// ============================================================================
let cachedRates = {
  updatedAt: 0,
  base: 'CLP',
  rates: {
    CLP: 1,
    USD: 0.00105,
    PEN: 0.00395,
    EUR: 0.00097,
    ARS: 1.05,
    COP: 4.45,
    MXN: 0.021,
    BRL: 0.0059
  }
};

function fetchExchangeRates() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (now - cachedRates.updatedAt < 6 * 3600 * 1000) {
      return resolve(cachedRates);
    }
    https.get('https://open.er-api.com/v6/latest/CLP', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.rates) {
            cachedRates = {
              updatedAt: now,
              base: 'CLP',
              rates: {
                CLP: 1,
                USD: parsed.rates.USD || 0.00105,
                PEN: parsed.rates.PEN || 0.00395,
                EUR: parsed.rates.EUR || 0.00097,
                ARS: parsed.rates.ARS || 1.05,
                COP: parsed.rates.COP || 4.45,
                MXN: parsed.rates.MXN || 0.021,
                BRL: parsed.rates.BRL || 0.0059
              }
            };
          }
        } catch (_) {}
        resolve(cachedRates);
      });
    }).on('error', () => resolve(cachedRates));
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ============================================================================
// RESOLUCIÓN DE REDIRECCIONES PARA STREAMING
// ============================================================================
function resolveRedirects(targetUrl, clientHeaders = {}, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    function hop(currentUrl, left) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        return reject(new Error('URL inválida: ' + currentUrl));
      }

      const lib = parsed.protocol === 'https:' ? https : http;
      const headers = {
        'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
        'Accept': '*/*',
        'Connection': 'keep-alive'
      };

      if (clientHeaders['range']) {
        headers['Range'] = clientHeaders['range'];
      }

      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers['location']) {
          res.resume();
          if (left <= 0) return reject(new Error('Demasiadas redirecciones'));
          const nextUrl = new URL(res.headers['location'], currentUrl).toString();
          return hop(nextUrl, left - 1);
        }
        resolve({ proxyReq: req, proxyRes: res, finalUrl: currentUrl });
      });

      req.on('error', reject);
      req.end();
    }
    hop(targetUrl, maxRedirects);
  });
}

// ============================================================================
// SERVIDOR HTTP PRINCIPAL
// ============================================================================
http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:' + PORT}`);
  let pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin, X-Admin-Key');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. API: ESTADO DEL DISPOSITIVO, 12 DÍAS DE PRUEBA Y TIPO DE CAMBIO (/api/device/init)
  if (pathname === '/api/device/init' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const deviceId = String(body.deviceId || '').trim().toUpperCase();
      if (!deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Falta deviceId' }));
      }

      const db = loadDb();
      const now = Date.now();

      if (!db.devices[deviceId]) {
        db.devices[deviceId] = {
          deviceId,
          firstSeenAt: now,
          lastSeenAt: now,
          clientType: 'OFFICIAL', // 'OFFICIAL' ($4000 CLP) | 'EXTERNAL' ($6000 CLP)
          providerLabel: 'Full Premium TvGo Oficial',
          username: '',
          licenseCode: null,
          licenseEndsAt: null,
          blockedManually: false,
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
        };
      } else {
        db.devices[deviceId].lastSeenAt = now;
        if (body.clientType) db.devices[deviceId].clientType = body.clientType;
        if (body.providerLabel) db.devices[deviceId].providerLabel = body.providerLabel;
        if (body.username) db.devices[deviceId].username = body.username;
      }

      saveDb(db);
      const evaluation = evaluateDeviceStatus(db.devices[deviceId]);
      const exchange = await fetchExchangeRates();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        device: db.devices[deviceId],
        access: evaluation,
        pricing: db.settings,
        exchange
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 2. API: ACTIVAR CÓDIGO DE LICENCIA ANUAL (/api/license/activate)
  if (pathname === '/api/license/activate' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const deviceId = String(body.deviceId || '').trim().toUpperCase();
      const code = String(body.code || '').trim().toUpperCase();

      const db = loadDb();
      const lic = db.licenses[code];

      if (!lic) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'El código de licencia ingresado no existe.' }));
      }

      if (lic.usedBy && lic.usedBy !== deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: `Esta licencia ya fue activada en otro dispositivo (${lic.usedBy}).` }));
      }

      const now = Date.now();
      const durationDays = lic.durationDays || 365;
      const licenseEndsAt = (lic.activatedAt || now) + durationDays * 24 * 60 * 60 * 1000;

      lic.usedBy = deviceId;
      lic.activatedAt = lic.activatedAt || now;
      lic.expiresAt = licenseEndsAt;

      if (!db.devices[deviceId]) {
        db.devices[deviceId] = {
          deviceId,
          firstSeenAt: now,
          lastSeenAt: now,
          clientType: lic.tier === 'OFFICIAL' ? 'OFFICIAL' : 'EXTERNAL',
          providerLabel: '',
          username: ''
        };
      }

      db.devices[deviceId].licenseCode = code;
      db.devices[deviceId].licenseEndsAt = licenseEndsAt;
      db.devices[deviceId].blockedManually = false;

      saveDb(db);
      const evaluation = evaluateDeviceStatus(db.devices[deviceId]);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        message: `Licencia activada con éxito por ${durationDays} días.`,
        access: evaluation,
        device: db.devices[deviceId]
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 3. API PANEL DE ADMINISTRACIÓN (/api/admin/*)
  if (pathname.startsWith('/api/admin/')) {
    const providedKey = req.headers['x-admin-key'] || parsedUrl.searchParams.get('key');
    if (providedKey !== ADMIN_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Contraseña de administrador incorrecta' }));
    }

    const db = loadDb();

    if (pathname === '/api/admin/overview' && req.method === 'GET') {
      const devicesList = Object.values(db.devices).map((d) => ({
        ...d,
        computed: evaluateDeviceStatus(d)
      })).sort((a, b) => b.lastSeenAt - a.lastSeenAt);

      const licensesList = Object.values(db.licenses).sort((a, b) => b.createdAt - a.createdAt);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        settings: db.settings,
        devices: devicesList,
        licenses: licensesList
      }));
    }

    if (pathname === '/api/admin/generate-license' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const tier = body.tier === 'EXTERNAL' ? 'EXTERNAL' : 'OFFICIAL'; // OFFICIAL ($4000) | EXTERNAL ($6000)
      const durationDays = Number(body.durationDays) || 365;
      const note = String(body.note || '').trim();

      const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
      const prefix = tier === 'OFFICIAL' ? 'FP4K' : 'FP6K';
      const code = `${prefix}-${rand.slice(0, 4)}-${rand.slice(4, 8)}`;

      db.licenses[code] = {
        code,
        tier,
        priceCLP: tier === 'OFFICIAL' ? db.settings.priceOfficialCLP : db.settings.priceExternalCLP,
        durationDays,
        note,
        createdAt: Date.now(),
        usedBy: null,
        activatedAt: null,
        expiresAt: null
      };

      saveDb(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, license: db.licenses[code] }));
    }

    if (pathname === '/api/admin/device-action' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const deviceId = String(body.deviceId || '').toUpperCase();
      const action = body.action; // 'ACTIVATE_1Y' | 'RESET_TRIAL' | 'BLOCK' | 'UNBLOCK'

      const dev = db.devices[deviceId];
      if (!dev) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Dispositivo no encontrado' }));
      }

      const now = Date.now();
      if (action === 'ACTIVATE_1Y') {
        dev.licenseEndsAt = now + 365 * 24 * 60 * 60 * 1000;
        dev.blockedManually = false;
        dev.licenseCode = dev.licenseCode || 'ADMIN-DIRECT-1Y';
      } else if (action === 'RESET_TRIAL') {
        dev.firstSeenAt = now;
        dev.licenseEndsAt = null;
        dev.blockedManually = false;
      } else if (action === 'BLOCK') {
        dev.blockedManually = true;
      } else if (action === 'UNBLOCK') {
        dev.blockedManually = false;
      }

      saveDb(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, device: dev }));
    }

    if (pathname === '/api/admin/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      db.settings = {
        ...db.settings,
        priceOfficialCLP: Number(body.priceOfficialCLP) || 4000,
        priceExternalCLP: Number(body.priceExternalCLP) || 6000,
        whatsappNumber: String(body.whatsappNumber || db.settings.whatsappNumber),
        paymentInstructions: String(body.paymentInstructions || db.settings.paymentInstructions)
      };
      saveDb(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, settings: db.settings }));
    }
  }

  // 4. ENDPOINT DE TRANSCODIFICACIÓN / SELECTOR DE AUDIO (/transcode)
  if (pathname === '/transcode') {
    const targetUrl = parsedUrl.searchParams.get('url');
    const audioTrack = parseInt(parsedUrl.searchParams.get('audio') || '0', 10);
    const startTime = parseFloat(parsedUrl.searchParams.get('start') || '0');
    const forceVideoEncode = parsedUrl.searchParams.get('reencode') === '1';

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Falta parámetro url');
    }

    try {
      const { proxyReq, proxyRes, finalUrl } = await resolveRedirects(targetUrl, {});
      proxyRes.resume();
      proxyReq.destroy();

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive'
      });

      const ffArgs = [
        '-hide_banner',
        '-loglevel', 'error',
        '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5'
      ];

      if (startTime > 0) ffArgs.push('-ss', String(startTime));

      ffArgs.push('-i', finalUrl, '-map', '0:v:0', '-map', `0:a:${audioTrack}?`);

      if (forceVideoEncode) {
        ffArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p');
      } else {
        ffArgs.push('-c:v', 'copy');
      }

      ffArgs.push(
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '160k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1'
      );

      const ffProc = spawn(ffmpegPath, ffArgs);
      ffProc.stdout.pipe(res);

      req.on('close', () => {
        try { ffProc.kill('SIGKILL'); } catch (_) {}
      });

      ffProc.on('error', () => {
        if (!res.headersSent) res.writeHead(500).end('FFmpeg no disponible');
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error al iniciar transcodificación: ' + err.message);
      }
    }
    return;
  }

  // =========================================================================
  // 5. ENDPOINT PROXY DIRECTO (/proxy)
  // =========================================================================
  if (pathname === '/proxy') {
    const targetUrl = parsedUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Falta parámetro url');
    }

    try {
      const { proxyReq, proxyRes } = await resolveRedirects(targetUrl, req.headers);

      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      forwardHeaders.forEach((h) => {
        if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
      });

      if (!res.getHeader('content-type')) {
        res.setHeader('content-type', 'video/mp2t');
      }

      // Enviar paquetes al cliente sin delay TCP
      res.writeHead(proxyRes.statusCode);
      if (req.socket) req.socket.setNoDelay(true);
      proxyRes.pipe(res);

      req.on('close', () => proxyReq.destroy());
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error de proxy: ' + err.message);
      }
    }
    return;
  }
  // 6. SERVIR ARCHIVOS ESTÁTICOS Y PWA
  if (pathname === '/' || pathname === '/app' || pathname === '/admin') pathname = '/index.html';
  const filePath = path.join(__dirname, 'public', pathname);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`>>> FULL PREMIUM TVGO v5.0 COMERCIAL OPERATIVO EN PUERTO ${PORT} <<<`);
});