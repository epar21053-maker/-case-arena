'use strict';

// Кейс Арена — небольшой публичный API таблицы лидеров без сторонних пакетов.
// Требуется Node.js 18+. Данные сохраняются в leaderboard.json рядом с сервером.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'leaderboard.json');
const INDEX_FILE = path.join(ROOT, 'index.html');
const CATEGORIES = new Set(['earned', 'ads', 'lost', 'wins', 'balance']);
const MAX_BODY = 16 * 1024;
const players = new Map();
const requests = new Map();

try {
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(data)) {
      for (const p of data) if (p && typeof p.id === 'string') players.set(p.id, sanitizeProfile(p));
    }
  }
} catch (err) {
  console.error('Не удалось прочитать leaderboard.json:', err.message);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1e15, Math.floor(n))) : 0;
}
function safeName(value) {
  const name = String(value || 'Игрок').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 22);
  return name || 'Игрок';
}
function sanitizeProfile(raw) {
  return {
    id: String(raw.id || '').slice(0, 100),
    name: safeName(raw.name),
    balance: num(raw.balance),
    earned: num(raw.earned),
    ads: num(raw.ads),
    lost: num(raw.lost),
    wins: num(raw.wins),
    updatedAt: num(raw.updatedAt) || Date.now()
  };
}
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}
function rateLimited(req) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  const current = requests.get(ip) || { start: now, count: 0 };
  if (now - current.start > 60_000) { current.start = now; current.count = 0; }
  current.count++;
  requests.set(ip, current);
  return current.count > 180;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}
let saveQueued = false;
function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    const temp = DATA_FILE + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify([...players.values()], null, 2), 'utf8');
      fs.renameSync(temp, DATA_FILE);
    } catch (err) {
      console.error('Не удалось сохранить таблицу лидеров:', err.message);
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    }
  }, 80);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }
  if (rateLimited(req)) return send(res, 429, { error: 'Too many requests; try again in a minute.' });

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, players: players.size, server: 'case-arena' });
  }
  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    const category = url.searchParams.get('category') || 'earned';
    if (!CATEGORIES.has(category)) return send(res, 400, { error: 'Unknown leaderboard category.' });
    const entries = [...players.values()]
      .sort((a, b) => (num(b[category]) - num(a[category])) || (b.updatedAt - a.updatedAt))
      .slice(0, 50);
    return send(res, 200, { category, entries, total: players.size });
  }
  if (req.method === 'POST' && url.pathname === '/api/profile') {
    try {
      const raw = await readJson(req);
      const id = String(raw.id || '').trim();
      if (!/^[a-zA-Z0-9_-]{6,100}$/.test(id)) return send(res, 400, { error: 'Invalid profile id.' });
      const profile = sanitizeProfile({ ...raw, id, updatedAt: Date.now() });
      players.set(id, profile);
      persist();
      return send(res, 200, { ok: true, profile: { id: profile.id, name: profile.name } });
    } catch (err) {
      return send(res, err.statusCode || 400, { error: err.statusCode === 413 ? 'Request too large.' : 'Could not read profile.' });
    }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(html);
    } catch (err) {
      return send(res, 500, { error: 'index.html not found next to server.js.' });
    }
  }
  return send(res, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Кейс Арена запущена: http://localhost:${PORT}`);
  console.log(`API готов: http://localhost:${PORT}/api/health`);
  console.log(`Профилей в рейтинге: ${players.size}`);
});

function shutdown() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify([...players.values()], null, 2), 'utf8'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
