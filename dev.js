#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const envPath = path.resolve(__dirname, '.env.local');
  let raw;
  try { raw = fs.readFileSync(envPath, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvLocal();

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const API_DIR = path.resolve(__dirname, 'api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon'
};

function sendStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.end(data);
  });
}

// API handlers are re-imported on each request with a cache-busting URL so
// edits to api/*.js take effect without restarting the dev server.
async function loadApiHandler(name) {
  const file = path.join(API_DIR, `${name}.js`);
  if (!fs.existsSync(file)) return null;
  const url = `file://${file}?t=${Date.now()}`;
  const mod = await import(url);
  return mod.default || null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(obj));
    return res;
  };
  req.query = Object.fromEntries(u.searchParams);

  const startedAt = Date.now();
  const finish = () => {
    const ms = Date.now() - startedAt;
    console.log(`  ${req.method} ${u.pathname}${u.search}  ${res.statusCode}  ${ms}ms`);
  };
  res.on('finish', finish);

  const apiMatch = u.pathname.match(/^\/api\/([a-z0-9_-]+)\/?$/i);
  if (apiMatch) {
    try {
      const handler = await loadApiHandler(apiMatch[1]);
      if (!handler) {
        res.status(404).json({ error: 'API not found' });
        return;
      }
      await handler(req, res);
    } catch (e) {
      console.error('[api error]', e);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Server error', detail: String(e?.message || e) });
      }
    }
    return;
  }

  let pathname = u.pathname === '/' ? '/index.html' : u.pathname;
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  sendStatic(res, filePath);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  TBD dev server');
  console.log(`  → app:  http://localhost:${PORT}/`);
  console.log(`  → api:  http://localhost:${PORT}/api/<name>`);
  console.log('');
  console.log('  Ctrl+C to stop');
  console.log('');
});
