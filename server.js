'use strict';

// Кейс Арена — публичный API таблицы лидеров и общей ленты дропов без сторонних пакетов.
// Требуется Node.js 18+. Данные сохраняются в JSON-файлы рядом с сервером.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'leaderboard.json');
const DROPS_FILE = path.join(ROOT, 'drops.json');
const INDEX_FILE = path.join(ROOT, 'index.html');
const CATEGORIES = new Set(['earned', 'ads', 'lost', 'wins', 'balance']);
const MAX_BODY = 16 * 1024;
const players = new Map();
const drops = [];
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
try {
  if (fs.existsSync(DROPS_FILE)) {
    const data = JSON.parse(fs.readFileSync(DROPS_FILE, 'utf8'));
    if (Array.isArray(data)) drops.push(...data.slice(0, 200).filter(x => x && typeof x === 'object').map(sanitizeDrop));
  }
} catch (err) {
  console.error('Не удалось прочитать drops.json:', err.message);
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
function safeText(value, fallback, max = 70) {
  const text = String(value || fallback).replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return text || fallback;
}
function safeColor(value) {
  const color = String(value || '');
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#8f9aa6';
}
function sanitizeDrop(raw) {
  return {
    id: safeText(raw.id, `drop-${Date.now()}`, 100),
    playerId: String(raw.playerId || '').slice(0, 100),
    playerName: safeName(raw.playerName),
    caseName: safeText(raw.caseName, 'Кейс', 70),
    itemName: safeText(raw.itemName, 'Предмет', 90),
    price: num(raw.price),
    tierName: safeText(raw.tierName, 'Предмет', 30),
    tierColor: safeColor(raw.tierColor),
    createdAt: num(raw.createdAt) || Date.now()
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
let dropsSaveQueued = false;
function persistDrops() {
  if (dropsSaveQueued) return;
  dropsSaveQueued = true;
  setTimeout(() => {
    dropsSaveQueued = false;
    const temp = DROPS_FILE + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(drops.slice(0, 200), null, 2), 'utf8');
      fs.renameSync(temp, DROPS_FILE);
    } catch (err) {
      console.error('Не удалось сохранить ленту дропов:', err.message);
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
  if (req.method === 'GET' && url.pathname === '/api/drops') {
    const requested = Number.parseInt(url.searchParams.get('limit') || '60', 10);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, requested)) : 60;
    return send(res, 200, { entries: drops.slice(0, limit), total: drops.length });
  }
  if (req.method === 'GET' && url.pathname === '/api/drops/weekly') {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = drops.filter(entry => num(entry.createdAt) >= cutoff);
    const best = recent.reduce((winner, entry) => !winner || num(entry.price) > num(winner.price) ? entry : winner, null);
    return send(res, 200, { best, period: '7d', total: recent.length });
  }
  if (req.method === 'POST' && url.pathname === '/api/drops') {
    try {
      const raw = await readJson(req);
      if (!Array.isArray(raw.drops) || raw.drops.length < 1 || raw.drops.length > 10) {
        return send(res, 400, { error: 'Provide between 1 and 10 drops.' });
      }
      const now = Date.now();
      const fresh = raw.drops.map((entry, index) => sanitizeDrop({
        ...entry,
        id: `drop-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}-${index}`,
        createdAt: now + index
      }));
      drops.unshift(...fresh);
      if (drops.length > 200) drops.length = 200;
      persistDrops();
      return send(res, 201, { ok: true, added: fresh.length, total: drops.length });
    } catch (err) {
      return send(res, err.statusCode || 400, { error: err.statusCode === 413 ? 'Request too large.' : 'Could not read drop data.' });
    }
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
  console.log(`Записей в ленте дропов: ${drops.length}`);
});

function shutdown() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify([...players.values()], null, 2), 'utf8'); } catch {}
  try { fs.writeFileSync(DROPS_FILE, JSON.stringify(drops.slice(0, 200), null, 2), 'utf8'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
