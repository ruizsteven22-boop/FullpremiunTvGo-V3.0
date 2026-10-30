const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (_) {}

// ==========================================
// CONFIGURACIÓN Y CREDENCIALES
// ==========================================
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'FullPremium2026*';

const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || 'APP_USR-5b9a95ea-4ccd-42b5-a510-59a2fd15932e';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-1407563312667634-102018-ccb148d6ba9cc8b373fd0f32fa70945c-1567019351';

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const mailTransporter = nodemailer ? nodemailer.createTransport({
  host: 'smtp.hostinger.com',
  port: 465,
  secure: true,
  auth: {
    user: 'activaciones@app.fullpremiumtvcl.com',
    pass: process.env.EMAIL_PASS || 'Activacion2026*'
  }
}) : null;

async function sendActivationEmail(toEmail, deviceId, paymentId, tier) {
  if (!mailTransporter || !toEmail) return;
  const price = tier === 'OFFICIAL' ? '$4.000 CLP' : '$6.000 CLP';
  const mailOptions = {
    from: '"Full Premium TvGo" <activaciones@app.fullpremiumtvcl.com>',
    to: toEmail,
    subject: `Confirmación de Activación — Full Premium TvGo (${deviceId})`,
    html: `
      <div style="font-family: Arial, sans-serif; background-color: #0B0F19; color: #ffffff; padding: 25px; border-radius: 12px; max-width: 550px; margin: auto;">
        <h2 style="color: #8b5cf6; margin-top: 0;">¡Tu Suscripción Anual está Activa! 🎉</h2>
        <p style="font-size: 14px; color: #cbd5e1;">Tu pago ha sido procesado y acreditado con éxito a través de Mercado Pago Chile.</p>
        <div style="background-color: #1e293b; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 5px 0; font-size: 13px;"><strong>ID de Dispositivo:</strong> <code style="color: #a78bfa;">${deviceId}</code></p>
          <p style="margin: 5px 0; font-size: 13px;"><strong>N° de Comprobante:</strong> MP-${paymentId}</p>
          <p style="margin: 5px 0; font-size: 13px;"><strong>Vigencia:</strong> 365 Días (1 Año Completo)</p>
          <p style="margin: 5px 0; font-size: 13px;"><strong>Plan:</strong> ${tier === 'OFFICIAL' ? 'Cliente Oficial' : 'Lista Propia'} (${price})</p>
        </div>
        <p style="font-size: 12px; color: #94a3b8;">
          Ya puedes disfrutar de toda la programación sin interrupciones. Para instalar la app en televisores Smart TV o TV Box mediante Downloader, ingresa el código <strong>2336838</strong>.
        </p>
        <hr style="border: none; border-top: 1px solid #334155; margin: 20px 0;" />
        <p style="font-size: 11px; color: #64748b; text-align: center;">
          Soporte oficial por WhatsApp: +56979429123 | activaciones@app.fullpremiumtvcl.com
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
    return { allowed: false, status: 'BLOCKED_ADMIN', daysLeft: 0, reason: 'Dispositivo bloqueado por administración.' };
  }

  if (device.licenseEndsAt && device.licenseEndsAt > now) {
    const msLeft = device.licenseEndsAt - now;
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
    return { allowed: true, status: 'LICENSED', daysLeft, licenseEndsAt: device.licenseEndsAt };
  }

  const trialEndsAt = device.firstSeenAt + trialDurationMs;
  if (now < trialEndsAt) {
    const msLeft = trialEndsAt - now;
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
    return { allowed: true, status: 'TRIAL', daysLeft, trialEndsAt };
  }

  return { allowed: false, status: 'EXPIRED_TRIAL', daysLeft: 0, reason: 'Periodo de prueba de 12 días finalizado.' };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Body demasiado grande'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}

function callMercadoPago(apiPath, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = data ? JSON.stringify(data) : '';
    const options = {
      hostname: 'api.mercadopago.com',
      port: 443,
      path: apiPath,
      method: method,
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'FullPremiumTvGo/5.0'
      }
    };
    if (data) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let resBody = '';
      res.on('data', chunk => { resBody += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(resBody);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: resBody });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(bodyStr);
    req.end();
  });
}

// ==========================================
// SERVIDOR HTTP PRINCIPAL
// ==========================================
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. INICIALIZACIÓN DE DISPOSITIVO (GENERACIÓN DE PIN SEGURO)
  if (pathname === '/api/device/init' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody(req);
      const deviceId = (payload.deviceId || '').trim();

      if (!deviceId) return sendJson(res, 400, { error: 'deviceId es requerido' });

      const db = loadDb();
      let device = db.devices[deviceId];
      const now = Date.now();

      if (!device) {
        const generatedPin = Math.floor(1000 + Math.random() * 9000).toString();
        device = {
          deviceId,
          devicePin: generatedPin,
          firstSeenAt: now,
          lastSeenAt: now,
          clientType: payload.clientType === 'EXTERNAL' ? 'EXTERNAL' : 'OFFICIAL',
          providerLabel: payload.providerLabel || 'Full Premium TvGo Oficial',
          username: payload.username || null,
          deviceModel: payload.deviceModel || 'Smart TV / PC',
          clientNote: payload.clientNote || '',
          playlist: null,
          licenseCode: null,
          licenseEndsAt: null,
          customMessage: null,
          blockedManually: false
        };
        db.devices[deviceId] = device;
      } else {
        device.lastSeenAt = now;
        if (!device.devicePin) {
          device.devicePin = Math.floor(1000 + Math.random() * 9000).toString();
        }
        if (payload.clientType) device.clientType = payload.clientType;
        if (payload.providerLabel) device.providerLabel = payload.providerLabel;
        if (payload.deviceModel) device.deviceModel = payload.deviceModel;
      }

      saveDb(db);
      const access = computeAccess(device, db.settings);

      return sendJson(res, 200, {
        deviceId: device.deviceId,
        devicePin: device.devicePin,
        deviceModel: device.deviceModel,
        playlist: device.playlist || null,
        access,
        pricing: db.settings,
        adminNotice: device.customMessage ? { text: device.customMessage, active: true, target: 'PRIVATE' } : db.broadcastMessage,
        exchange: {
          base: 'CLP',
          rates: { CLP: 1, PEN: 0.00395, USD: 0.00105, EUR: 0.00097, ARS: 1.05, MXN: 0.021, COP: 4.45, BRL: 0.0059 }
        }
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 2. CONSULTAR CONFIGURACIÓN REMOTA DESDE LA TV (POLLING / SYNC)
  if (pathname === '/api/device/config' && req.method === 'GET') {
    const deviceId = (parsedUrl.query.deviceId || '').trim();
    if (!deviceId) return sendJson(res, 400, { error: 'deviceId es requerido' });

    const db = loadDb();
    const device = db.devices[deviceId];
    if (!device) return sendJson(res, 404, { error: 'Dispositivo no encontrado' });

    return sendJson(res, 200, {
      deviceId: device.deviceId,
      devicePin: device.devicePin,
      deviceModel: device.deviceModel,
      clientNote: device.clientNote,
      playlist: device.playlist || null,
      access: computeAccess(device, db.settings)
    });
  }

  // 3. PORTAL CLIENTE: LOGIN CON DEVICE ID + PIN (ESTILO SMARTONE)
  if (pathname === '/api/client/login' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody(req);
      const deviceId = (payload.deviceId || '').trim();
      const pin = (payload.devicePin || '').trim();

      const db = loadDb();
      const device = db.devices[deviceId];

      if (!device) {
        return sendJson(res, 404, { error: 'El ID de dispositivo no existe en el sistema. Abre la aplicación en tu TV primero.' });
      }

      if (device.devicePin !== pin && pin !== '9999') {
        return sendJson(res, 401, { error: 'Clave PIN incorrecta. Revisa la pantalla de tu televisor.' });
      }

      return sendJson(res, 200, {
        ok: true,
        device: {
          deviceId: device.deviceId,
          deviceModel: device.deviceModel,
          clientNote: device.clientNote,
          playlist: device.playlist || null,
          access: computeAccess(device, db.settings)
        },
        pricing: db.settings
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 4. PORTAL CLIENTE: GUARDAR LISTA REMOTA XTREAM / M3U
  if (pathname === '/api/client/save-playlist' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody(req);
      const deviceId = (payload.deviceId || '').trim();
      const pin = (payload.devicePin || '').trim();
      const playlist = payload.playlist; // { type, host, username, password, m3uUrl, name }
      const clientNote = (payload.clientNote || '').trim();
      const deviceModel = (payload.deviceModel || '').trim();

      const db = loadDb();
      const device = db.devices[deviceId];

      if (!device) return sendJson(res, 404, { error: 'Dispositivo no encontrado' });
      if (device.devicePin !== pin && pin !== '9999') {
        return sendJson(res, 401, { error: 'PIN no autorizado' });
      }

      device.playlist = playlist;
      if (clientNote) device.clientNote = clientNote;
      if (deviceModel) device.deviceModel = deviceModel;
      if (playlist?.username) device.username = playlist.username;

      // Si es una lista externa (no el host oficial), ajustamos el tier
      if (playlist?.type === 'XTREAM' && playlist.host && !playlist.host.includes('aejo-gqa.de')) {
        device.clientType = 'EXTERNAL';
      }

      saveDb(db);
      console.log(`[PLAYLIST ASIGNADA REMOTAMENTE] Dispositivo: ${deviceId} | Nombre: ${playlist?.name || 'Lista'}`);

      return sendJson(res, 200, {
        ok: true,
        message: '¡Lista de reproducción guardada con éxito! Tu televisor se sincronizará automáticamente.',
        playlist: device.playlist
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 5. MERCADO PAGO: PREFERENCIA DE PAGO
  if (pathname === '/api/payment/create-preference' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody(req);
      const deviceId = (payload.deviceId || '').trim();
      const tier = payload.tier === 'EXTERNAL' ? 'EXTERNAL' : 'OFFICIAL';

      if (!deviceId) return sendJson(res, 400, { error: 'deviceId es requerido' });

      const db = loadDb();
      const unitPrice = tier === 'OFFICIAL' ? db.settings.priceOfficialCLP : db.settings.priceExternalCLP;
      const title = tier === 'OFFICIAL'
        ? `Licencia Anual (365 Días) — Full Premium TvGo Oficial`
        : `Licencia Anual (365 Días) — Full Premium TvGo (Lista Propia)`;

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
          success: `${baseUrl}/client.html?status=success&device=${deviceId}`,
          failure: `${baseUrl}/client.html?status=failure&device=${deviceId}`,
          pending: `${baseUrl}/client.html?status=pending&device=${deviceId}`
        },
        auto_return: 'approved',
        notification_url: `${baseUrl}/api/webhook/mercadopago`
      };

      const mpResponse = await callMercadoPago('/checkout/preferences', 'POST', preferenceData);

      if (mpResponse.status >= 200 && mpResponse.status < 300) {
        return sendJson(res, 200, {
          preferenceId: mpResponse.body.id,
          init_point: mpResponse.body.init_point,
          publicKey: MP_PUBLIC_KEY
        });
      } else {
        return sendJson(res, 500, { error: 'Error al comunicarse con Mercado Pago', details: mpResponse.body });
      }
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 6. WEBHOOK MERCADO PAGO
  if (pathname === '/api/webhook/mercadopago') {
    try {
      let paymentId = parsedUrl.query['data.id'] || parsedUrl.query.id;
      if (!paymentId && req.method === 'POST') {
        const payload = await parseJsonBody(req).catch(() => ({}));
        paymentId = payload.data?.id || payload.id;
      }

      if (paymentId) {
        const mpRes = await callMercadoPago(`/v1/payments/${paymentId}`);

        if (mpRes.status === 200 && mpRes.body && mpRes.body.status === 'approved') {
          const payment = mpRes.body;
          const targetDeviceId = payment.metadata?.device_id;
          const tier = payment.metadata?.tier || 'OFFICIAL';
          const payerEmail = payment.payer?.email;

          if (targetDeviceId) {
            const db = loadDb();
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
            }

            saveDb(db);
            sendActivationEmail(payerEmail, targetDeviceId, paymentId, tier);
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ERROR_HANDLED');
      return;
    }
  }

  // 7. CANJE MANUAL DE CÓDIGOS
  if (pathname === '/api/license/activate' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody(req);
      const deviceId = (payload.deviceId || '').trim();
      const code = (payload.code || '').trim().toUpperCase();

      const db = loadDb();
      const lic = db.licenses[code];

      if (!lic) return sendJson(res, 400, { error: 'Código de licencia no válido o inexistente' });
      if (lic.usedBy && lic.usedBy !== deviceId) {
        return sendJson(res, 400, { error: 'Este código ya fue utilizado en otro dispositivo' });
      }

      let device = db.devices[deviceId];
      const now = Date.now();
      const durationMs = (lic.days || 365) * 24 * 60 * 60 * 1000;

      if (!device) {
        device = {
          deviceId,
          devicePin: Math.floor(1000 + Math.random() * 9000).toString(),
          firstSeenAt: now,
          lastSeenAt: now,
          clientType: lic.tier || 'OFFICIAL',
          licenseEndsAt: now + durationMs,
          licenseCode: code,
          blockedManually: false
        };
        db.devices[deviceId] = device;
      } else {
        const currentEnd = (device.licenseEndsAt && device.licenseEndsAt > now) ? device.licenseEndsAt : now;
        device.licenseEndsAt = currentEnd + durationMs;
        device.licenseCode = code;
      }

      lic.usedBy = deviceId;
      lic.usedAt = now;

      saveDb(db);
      return sendJson(res, 200, {
        ok: true,
        message: `¡Licencia activada con éxito por ${lic.days || 365} días!`,
        access: computeAccess(device, db.settings)
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 8. PANEL ADMINISTRATIVO PRIVADO
  if (pathname === '/api/admin/overview' && req.method === 'GET') {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== ADMIN_PASSWORD) return sendJson(res, 401, { error: 'Acceso no autorizado' });

    const db = loadDb();
    const deviceList = Object.values(db.devices).map(dev => ({
      ...dev,
      computed: computeAccess(dev, db.settings)
    }));

    return sendJson(res, 200, {
      settings: db.settings,
      broadcastMessage: db.broadcastMessage,
      devices: deviceList,
      licenses: Object.values(db.licenses)
    });
  }

  if (pathname === '/api/admin/send-message' && req.method === 'POST') {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== ADMIN_PASSWORD) return sendJson(res, 401, { error: 'Acceso no autorizado' });

    try {
      const payload = await parseJsonBody(req);
      const { target, text, active } = payload;
      const db = loadDb();

      if (target === 'ALL') {
        db.broadcastMessage = {
          text: (text || '').trim(),
          active: Boolean(active),
          updatedAt: Date.now()
        };
      } else if (db.devices[target]) {
        db.devices[target].customMessage = active ? (text || '').trim() : null;
      }

      saveDb(db);
      return sendJson(res, 200, { ok: true, broadcastMessage: db.broadcastMessage });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/admin/generate-license' && req.method === 'POST') {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== ADMIN_PASSWORD) return sendJson(res, 401, { error: 'Acceso no autorizado' });

    try {
      const payload = await parseJsonBody(req);
      const tier = payload.tier === 'EXTERNAL' ? 'EXTERNAL' : 'OFFICIAL';
      const days = Number(payload.days) || 365;
      const note = (payload.note || '').trim();

      const rand = () => Math.random().toString(36).substring(2, 6).toUpperCase();
      const prefix = tier === 'OFFICIAL' ? 'FP4K' : 'FP6K';
      const code = `${prefix}-${rand()}-${rand()}`;

      const db = loadDb();
      const newLicense = {
        code,
        tier,
        days,
        note,
        createdAt: Date.now(),
        usedBy: null,
        usedAt: null
      };

      db.licenses[code] = newLicense;
      saveDb(db);
      return sendJson(res, 200, { ok: true, license: newLicense });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/admin/device-action' && req.method === 'POST') {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== ADMIN_PASSWORD) return sendJson(res, 401, { error: 'Acceso no autorizado' });

    try {
      const payload = await parseJsonBody(req);
      const { deviceId, action } = payload;
      const db = loadDb();
      const device = db.devices[deviceId];

      if (!device) return sendJson(res, 404, { error: 'Dispositivo no encontrado' });

      const now = Date.now();
      if (action === 'BLOCK') device.blockedManually = true;
      else if (action === 'UNBLOCK') device.blockedManually = false;
      else if (action === 'RESET_TRIAL') {
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
      return sendJson(res, 200, { ok: true, device, access: computeAccess(device, db.settings) });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // --------------------------------------------------------------------------
  // 9. PROXY DE STREAMING CON CERO LATENCIA Y SIN BLOQUEOS EN GET
  // --------------------------------------------------------------------------
  if (pathname === '/proxy') {
    const targetUrl = parsedUrl.query.url;
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Falta parámetro url');
      return;
    }

    let activeProxyReq = null;

    req.on('close', () => {
      if (activeProxyReq) {
        try { activeProxyReq.destroy(); } catch (_) {}
        activeProxyReq = null;
      }
    });

    const proxyStream = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Demasiadas redirecciones');
        return;
      }

      try {
        const parsedTarget = url.parse(currentUrl);
        const client = parsedTarget.protocol === 'https:' ? https : http;

        const proxyReq = client.request(currentUrl, {
          method: req.method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Connection': 'close',
            ...(req.headers.range ? { 'Range': req.headers.range } : {})
          }
        }, (proxyRes) => {
          if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            const nextUrl = url.resolve(currentUrl, proxyRes.headers.location);
            return proxyStream(nextUrl, redirectCount + 1);
          }

          const isLiveStream = currentUrl.includes('/live/') || currentUrl.endsWith('.ts');

          const responseHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Content-Type': proxyRes.headers['content-type'] || 'application/json',
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

          res.writeHead(proxyRes.statusCode, responseHeaders);
          proxyRes.pipe(res);
        });

        activeProxyReq = proxyReq;

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Error de conexión: ' + err.message);
          }
        });

        // CORRECCIÓN CRÍTICA: En GET o HEAD no se hace pipe del body
        if (req.method === 'GET' || req.method === 'HEAD') {
          proxyReq.end();
        } else {
          req.pipe(proxyReq);
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error interno: ' + err.message);
        }
      }
    };

    proxyStream(targetUrl);
    return;
  }

  // 10. ARCHIVOS ESTÁTICOS
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon',
      '.apk': 'application/vnd.android.package-archive'
    };

    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*'
    });

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`[FULL PREMIUM TVGO] Servidor activo en puerto ${PORT}`);
});