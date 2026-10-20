const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (_) {
  ffmpegPath = 'ffmpeg'; // Fallback si está en el sistema
}

const PORT = process.env.PORT || 3000;

// Seguir redirecciones 301/302 internamente y devolver la URL final real o el stream
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

http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:' + PORT}`);
  let pathname = parsedUrl.pathname;

  // CORS global
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // =========================================================================
  // 1. ENDPOINT DE TRANSCODIFICACIÓN / SELECTOR DE PISTA DE AUDIO (/transcode)
  // Sirve para:
  // - Canales HD/FHD con audio AC3 o video pesado que solo daban audio o error
  // - Cambiar el idioma de audio (audioTrack=0, 1, 2) en Películas y Series .mkv
  // =========================================================================
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
      // Resolver token/redirect 302 de Xtream antes de pasarlo a FFmpeg
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

      if (startTime > 0) {
        ffArgs.push('-ss', String(startTime));
      }

      ffArgs.push(
        '-i', finalUrl,
        '-map', '0:v:0',
        '-map', `0:a:${audioTrack}?`
      );

      // Si el canal HD/FHD tiene video HEVC (solo audio en navegador), recodificamos a H.264 ultraligero
      if (forceVideoEncode) {
        ffArgs.push(
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-pix_fmt', 'yuv420p'
        );
      } else {
        ffArgs.push('-c:v', 'copy');
      }

      // Convertimos siempre el audio (AC3/EAC3/DTS) a AAC estéreo compatible con todos los navegadores
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
  // 2. ENDPOINT PROXY DIRECTO (/proxy) - Para API, Canales MPEG-TS y VOD
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

      res.writeHead(proxyRes.statusCode);
      proxyRes.pipe(res);

      req.on('close', () => {
        proxyReq.destroy();
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error de proxy: ' + err.message);
      }
    }
    return;
  }

  // =========================================================================
  // 3. SERVIR INTERFAZ WEB SIN CACHÉ
  // =========================================================================
  if (pathname === '/' || pathname === '/app') pathname = '/index.html';
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
      '.json': 'application/json; charset=utf-8'
    };
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`>>> FULL PREMIUM TVGO v4.0 OPERATIVO EN PUERTO ${PORT} <<<`);
});