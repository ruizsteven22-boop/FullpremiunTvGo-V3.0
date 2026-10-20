const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Función que sigue redirecciones 301/302 internamente en el servidor sin perder cabeceras Range
function requestWithRedirects(targetUrl, clientHeaders, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function hop(currentUrl, redirectsLeft) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        return reject(new Error('URL inválida: ' + currentUrl));
      }

      const lib = parsed.protocol === 'https:' ? https : http;
      const headers = {
        'User-Agent': 'IPTVSmartersPlayer',
        'Accept': '*/*',
        'Connection': 'keep-alive',
      };

      // Vital para Películas y Series (.mp4 / .mkv): reenviar Range bytes
      if (clientHeaders['range']) {
        headers['Range'] = clientHeaders['range'];
      }

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      };

      const proxyReq = lib.request(options, (proxyRes) => {
        if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers['location']) {
          proxyRes.resume(); // Descartar cuerpo del redirect
          if (redirectsLeft <= 0) {
            return reject(new Error('Demasiadas redirecciones'));
          }
          const nextUrl = new URL(proxyRes.headers['location'], currentUrl).toString();
          return hop(nextUrl, redirectsLeft - 1);
        }
        resolve({ proxyReq, proxyRes, finalUrl: currentUrl });
      });

      proxyReq.on('error', (err) => reject(err));
      proxyReq.end();
    }

    hop(targetUrl, maxRedirects);
  });
}

http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:' + PORT}`);
  let pathname = parsedUrl.pathname;

  // Cabeceras CORS globales
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, X-Upstream-Status');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. ENDPOINT DE DIAGNÓSTICO RÁPIDO (/probe?url=...)
  if (pathname === '/probe') {
    const targetUrl = parsedUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Falta parámetro url' }));
    }
    try {
      const { proxyReq, proxyRes, finalUrl } = await requestWithRedirects(targetUrl, {});
      let sample = '';
      proxyRes.on('data', (chunk) => {
        if (sample.length < 300) sample += chunk.toString('utf8');
        proxyReq.destroy();
      });
      proxyRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: proxyRes.statusCode,
          contentType: proxyRes.headers['content-type'] || 'desconocido',
          finalUrl,
          preview: sample.slice(0, 200)
        }));
      });
      proxyRes.on('close', () => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            status: proxyRes.statusCode,
            contentType: proxyRes.headers['content-type'] || 'stream-binario',
            finalUrl,
            preview: sample.slice(0, 200)
          }));
        }
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2. ENDPOINT PROXY PRINCIPAL (/proxy?url=...)
  if (pathname === '/proxy') {
    const targetUrl = parsedUrl.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Falta la URL de destino');
    }

    try {
      const { proxyReq, proxyRes } = await requestWithRedirects(targetUrl, req.headers);

      // Desactivar buffering en Hostinger Nginx/LiteSpeed
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('X-Upstream-Status', String(proxyRes.statusCode));

      // Preservar cabeceras clave para Películas (.mp4/.mkv) y Streams (.ts/.m3u8)
      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      forwardHeaders.forEach((h) => {
        if (proxyRes.headers[h]) {
          res.setHeader(h, proxyRes.headers[h]);
        }
      });

      if (!res.getHeader('content-type')) {
        res.setHeader('content-type', 'video/mp2t');
      }

      // Enviar el código real (200 OK, 206 Partial Content para VOD, o 403 si TITAN bloquea)
      res.writeHead(proxyRes.statusCode);
      proxyRes.pipe(res);

      req.on('close', () => {
        proxyReq.destroy();
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error de conexión en proxy: ' + err.message);
      }
    }
    return;
  }

  // 3. SERVIR INTERFAZ WEB SIN CACHÉ (para que siempre tome los cambios al instante)
  if (pathname === '/' || pathname === '/app') pathname = '/index.html';
  const filePath = path.join(__dirname, 'public', pathname);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Archivo no encontrado');
    }
    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`>>> FULL PREMIUM TVGO v3.0 OPERATIVO EN PUERTO ${PORT} <<<`);
});