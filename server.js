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

// ============================================================================
// TOKEN PRODUCTIVO REAL DE MERCADO PAGO CHILE
// ============================================================================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-1407563312667634-102018-ccb148d6ba9cc8b373fd0f32fa70945c-1567019351';

const TRIAL_DAYS = 12;

// ============================================================================
// BASE DE DATOS PERSISTENTE (data/db.json)
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
      whatsappNumber: '+56979429123',
      officialEmail: 'activaciones@app.fullpremiumtvcl.com'
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

function evaluateDeviceStatus(device) {
  const now = Date.now();
  const trialMs = TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const trialEndsAt = device.firstSeenAt + trialMs;

  if (device.blockedManually) {
    return { allowed: false, status: 'BLOCKED_ADMIN', daysLeft: 0, trialEndsAt, licenseEndsAt: device.licenseEndsAt || null };
  }

  if (device.licenseEndsAt && device.licenseEndsAt > now) {
    const daysLeft = Math.ceil((device.licenseEndsAt - now) / (1000 * 60 * 60 * 24));
    return { allowed: true, status: 'LICENSED', daysLeft, trialEndsAt, licenseEndsAt: device.licenseEndsAt };
  }

  if (now <= trialEndsAt) {
    const daysLeft = Math.max(1, Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)));
    return { allowed: true, status: 'TRIAL', daysLeft, trialEndsAt, licenseEndsAt: null };
  }

  return { allowed: false, status: 'EXPIRED_TRIAL', daysLeft: 0, trialEndsAt, licenseEndsAt: device.licenseEndsAt || null };
}

// ============================================================================
// TASA DE CAMBIO DEL DÍA
// ============================================================================
let cachedRates = {
  updatedAt: 0,
  base: 'CLP',
  rates: { CLP: 1, USD: 0.00105, PEN: 0.00395, EUR: 0.00097, ARS: 1.05, COP: 4.45, MXN: 0.021, BRL: 0.0059 }
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
          if (parsed?.rates) {
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

      if (clientHeaders['range']) headers['Range'] = clientHeaders['range'];

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

  // 1. INICIALIZAR Y VERIFICAR DISPOSITIVO
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
          clientType: 'OFFICIAL',
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

  // 2. CREAR PREFERENCIA DE PAGO EN MERCADO PAGO CHILE
  if (pathname === '/api/payment/create-preference' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const deviceId = String(body.deviceId || '').trim().toUpperCase();
      const isOfficial = body.tier === 'OFFICIAL';
      const db = loadDb();
      const price = isOfficial ? db.settings.priceOfficialCLP : db.settings.priceExternalCLP;
      const title = isOfficial
        ? 'Licencia Anual 365 Días — Full Premium TvGo'
        : 'Licencia Anual 365 Días (Lista Propia) — Full Premium TvGo';

      const preferencePayload = JSON.stringify({
        items: [
          {
            title: `${title} [ID: ${deviceId}]`,
            description: `Activación por 1 año para el dispositivo ${deviceId}`,
            quantity: 1,
            currency_id: 'CLP',
            unit_price: Number(price)
          }
        ],
        external_reference: deviceId,
        metadata: {
          device_id: deviceId,
          tier: isOfficial ? 'OFFICIAL' : 'EXTERNAL'
        },
        back_urls: {
          success: `https://${req.headers.host || 'app.fullpremiumtvcl.com'}/?status=success&device=${deviceId}`,
          pending: `https://${req.headers.host || 'app.fullpremiumtvcl.com'}/?status=pending`,
          failure: `https://${req.headers.host || 'app.fullpremiumtvcl.com'}/?status=failure`
        },
        auto_return: 'approved',
        notification_url: `https://${req.headers.host || 'app.fullpremiumtvcl.com'}/api/webhook/mercadopago`
      });

      const mpReq = https.request('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${MP_ACCESS_TOKEN}`
        }
      }, (mpRes) => {
        let data = '';
        mpRes.on('data', chunk => data += chunk);
        mpRes.on('end', () => {
          try {
            const resp = JSON.parse(data);
            if (resp.init_point) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ init_point: resp.init_point }));
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: resp.message || 'Error al conectar con Mercado Pago' }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Respuesta inválida de Mercado Pago' }));
          }
        });
      });

      mpReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });

      mpReq.write(preferencePayload);
      mpReq.end();
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 3. WEBHOOK DE MERCADO PAGO: ACTIVACIÓN AUTOMÁTICA DEL DISPOSITIVO
  if (pathname === '/api/webhook/mercadopago') {
    const paymentId = parsedUrl.searchParams.get('data.id') || parsedUrl.searchParams.get('id');
    const topic = parsedUrl.searchParams.get('type') || parsedUrl.searchParams.get('topic');

    if (paymentId && (topic === 'payment' || !topic)) {
      https.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
      }, (mpRes) => {
        let body = '';
        mpRes.on('data', d => body += d);
        mpRes.on('end', () => {
          try {
            const payment = JSON.parse(body);
            if (payment.status === 'approved') {
              const targetDeviceId = (payment.metadata?.device_id || payment.external_reference || '').toUpperCase();
              if (targetDeviceId) {
                const db = loadDb();
                const now = Date.now();
                if (db.devices[targetDeviceId]) {
                  db.devices[targetDeviceId].licenseEndsAt = now + 365 * 24 * 60 * 60 * 1000;
                  db.devices[targetDeviceId].licenseCode = `MP-${paymentId}`;
                  db.devices[targetDeviceId].blockedManually = false;
                  saveDb(db);
                  console.log(`[PAGO APROBADO] Dispositivo ${targetDeviceId} activado por 365 días vía Mercado Pago #${paymentId}`);
                }
              }
            }
          } catch (_) {}
        });
      }).on('error', () => {});
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ received: true }));
  }

  // 4. ACTIVAR MANUALMENTE CON CÓDIGO
  if (pathname === '/api/license/activate' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const deviceId = String(body.deviceId || '').trim().toUpperCase();
      const code = String(body.code || '').trim().toUpperCase();
      const db = loadDb();
      const lic = db.licenses[code];

      if (!lic) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'El código de licencia ingresado no existe.' }));
      }

      if (lic.usedBy && lic.usedBy !== deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        message: `Licencia activada con éxito por ${durationDays} días.`,
        access: evaluateDeviceStatus(db.devices[deviceId])
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 5. API PRIVADA DE ADMINISTRACIÓN
  if (pathname.startsWith('/api/admin/')) {
    const providedKey = req.headers['x-admin-key'] || parsedUrl.searchParams.get('key');
    if (providedKey !== ADMIN_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Contraseña de administrador incorrecta' }));
    }

    const db = loadDb();

    if (pathname === '/api/admin/overview' && req.method === 'GET') {
      const devicesList = Object.values(db.devices).map((d) => ({
        ...d,
        computed: evaluateDeviceStatus(d)
      })).sort((a, b) => b.lastSeenAt - a.lastSeenAt);

      const licensesList = Object.values(db.licenses).sort((a, b) => b.createdAt - a.createdAt);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ settings: db.settings, devices: devicesList, licenses: licensesList }));
    }

    if (pathname === '/api/admin/generate-license' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const tier = body.tier === 'EXTERNAL' ? 'EXTERNAL' : 'OFFICIAL';
      const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
      const prefix = tier === 'OFFICIAL' ? 'FP4K' : 'FP6K';
      const code = `${prefix}-${rand.slice(0, 4)}-${rand.slice(4, 8)}`;

      db.licenses[code] = {
        code,
        tier,
        priceCLP: tier === 'OFFICIAL' ? db.settings.priceOfficialCLP : db.settings.priceExternalCLP,
        durationDays: 365,
        note: String(body.note || '').trim(),
        createdAt: Date.now(),
        usedBy: null
      };

      saveDb(db);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, license: db.licenses[code] }));
    }

    if (pathname === '/api/admin/device-action' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const deviceId = String(body.deviceId || '').toUpperCase();
      const action = body.action;
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, device: dev }));
    }
  }

  // 6. STREAMING TRANSCODE
  if (pathname === '/transcode') {
    const targetUrl = parsedUrl.searchParams.get('url');
    const audioTrack = parseInt(parsedUrl.searchParams.get('audio') || '0', 10);
    const startTime = parseFloat(parsedUrl.searchParams.get('start') || '0');
    const forceVideoEncode = parsedUrl.searchParams.get('reencode') === '1';

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
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

      ffArgs.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

      const ffProc = spawn(ffmpegPath, ffArgs);
      ffProc.stdout.pipe(res);

      req.on('close', () => {
        try { ffProc.kill('SIGKILL'); } catch (_) {}
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Error de transcodificación: ' + err.message);
      }
    }
    return;
  }

  // 7. PROXY DIRECTO (.TS) CON SOCKET NODELAY
  if (pathname === '/proxy') {
    const targetUrl = parsedUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Falta parámetro url');
    }

    try {
      const { proxyReq, proxyRes } = await resolveRedirects(targetUrl, req.headers);

      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

      ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
        if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
      });

      if (!res.getHeader('content-type')) res.setHeader('content-type', 'video/mp2t');

      res.writeHead(proxyRes.statusCode);
      if (req.socket) req.socket.setNoDelay(true);
      proxyRes.pipe(res);

      req.on('close', () => proxyReq.destroy());
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Error de proxy: ' + err.message);
      }
    }
    return;
  }

  // 8. SERVIR FRONTEND
  if (pathname === '/' || pathname === '/app') pathname = '/index.html';
  const filePath = path.join(__dirname, 'public', pathname);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No encontrado');
    }
    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png'
    };
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`>>> FULL PREMIUM TVGO OPERATIVO CON MERCADO PAGO EN PUERTO ${PORT} <<<`);
});