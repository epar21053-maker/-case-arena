'use strict';

// Кейс Арена — сервер сайта: отдаёт index.html, ведёт таблицу лидеров и общую ленту дропов.
// Без сторонних пакетов, нужен Node.js 18+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const WebSocket = require('ws');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
// На Render: подключи Disk, смонтируй в /var/data и задай переменную DATA_DIR=/var/data,
// иначе рейтинг стирается при каждом перезапуске/деплое (на бесплатном тарифе диск временный).
const DATA_DIR = process.env.DATA_DIR || ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'leaderboard.json');
const DROPS_FILE = path.join(DATA_DIR, 'drops.json');
const INDEX_FILE = path.join(ROOT, 'index.html');
// Каталог предметов и кейсов (сделан из игры). Нужен, чтобы лента дропов не принимала выдуманные предметы.
let CAT = null;
try { CAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8')); } catch { console.error('Нет catalog.json: лента дропов отключена, пока файл не загружен.'); }
const REF_FILE = path.join(DATA_DIR, 'referrals.json');

const CATEGORIES = new Set(['earned', 'ads', 'lost', 'wins', 'balance', 'rogue', 'daily', 'weekly', 'depth']);
const utcDay = () => new Date().toISOString().slice(0, 10);
const MAX_BODY = 16 * 1024;
const MAX_PLAYERS = 5000;
const MAX_DROPS = 200;
// Игрок исчезает из рейтинга, если не заходил в игру 3 дня (каждый заход в игру обновляет профиль).
const PRUNE_AFTER_MS = 3 * 24 * 3600 * 1000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 240); // запросов в минуту с одного IP
// Цвета и названия редкостей должны совпадать с TIERS в index.html.
const TIERS = [
  ['Ширпотреб', '#8f9aa6'], ['Обычный', '#6fb1e0'], ['Армейский', '#4a7cff'], ['Редкий', '#9a68ff'], ['Мистический', '#d84fe0'],
  ['Легендарный', '#ff4d6a'], ['Тайный', '#ff8a3a'], ['Золотой', '#ffc83a'], ['Космический', '#37e0cf'], ['Запредельный', '#f2f6ff']
];
const MAX_DROP_PRICE = 2_000_000;

// Пригласительные бонусы: порог = награда, платится и пригласившему, и приглашённому.
const REF_TH = [500, 5000, 50000, 500000, 1200000];
const REF_RW = [500, 5000, 25000, 250000, 600000]; // награда каждому: 100%, 100%, затем 50% от порога
const REF_AGE = [0, 5, 30, 60, 120]; // минимальный возраст приглашённого профиля (минут) для каждой ступени
const MAX_REFS = 20000, MAX_INVITES = 30;
const refs = new Map(); // id приглашённого -> { inv, invName, base, at, prog, name, a:[], b:[] }

const players = new Map(); // id -> профиль (id игрока наружу не отдаётся)
const drops = [];
const hits = new Map();
const dropHits = new Map();

/* ---------- утилиты ---------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pidOf = (id) => sha('pid:' + id).slice(0, 12);
function num(value, max = 1e12) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : 0;
}
function cleanText(value, fallback, max) {
  const t = String(value == null ? '' : value).replace(/[<>\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return t || fallback;
}
const ipHash = (req) => sha('ip:' + clientIp(req)).slice(0, 16);
function clientIp(req) {
  // Render стоит за Cloudflare: заголовок cf-connecting-ip выставляет он сам и клиент его подделать не может.
  // Запасные варианты нужны только если сайт поставят за другой прокси. Чужой X-Forwarded-For слева подделывается,
  // поэтому важные проверки (создание профилей) не опираются только на IP.
  const h = req.headers;
  const cf = String(h['cf-connecting-ip'] || h['true-client-ip'] || '').trim();
  if (cf) return cf.slice(0, 64);
  const xff = String(h['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return (xff[0] || req.socket.remoteAddress || 'unknown').slice(0, 64);
}
function rateLimited(req) {
  const now = Date.now(), ip = clientIp(req);
  let cur = hits.get(ip);
  if (!cur || now - cur.start > 60_000) { cur = { start: now, count: 0 }; hits.set(ip, cur); }
  cur.count++;
  return cur.count > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now - v.start > 120_000) hits.delete(k);
  for (const [k, v] of dropHits) if (now - v.start > 120_000) dropHits.delete(k);
}, 60_000).unref();

/* ---------- загрузка ---------- */
function sanitizeStored(raw) {
  return {
    id: String(raw.id || '').slice(0, 100),
    h: typeof raw.h === 'string' ? raw.h.slice(0, 64) : '',
    name: cleanText(raw.name, 'Игрок', 22),
    balance: num(raw.balance), earned: num(raw.earned), ads: num(raw.ads, 1e7), lost: num(raw.lost), wins: num(raw.wins, 1e9), rogue: num(raw.rogue, 2000), rd: num(raw.rd, 2000), depth: num(raw.depth, 200), rdd: /^\d{4}-\d\d-\d\d$/.test(raw.rdd || '') ? raw.rdd : '', rw: num(raw.rw, 2000), rwk: /^\d{1,6}$/.test(String(raw.rwk || '')) ? String(raw.rwk) : '',
    ip: typeof raw.ip === 'string' ? raw.ip.slice(0, 16) : '',
    created: num(raw.created, 4e12) || undefined, syncs: raw.syncs === undefined ? undefined : num(raw.syncs, 1e9),
    updatedAt: num(raw.updatedAt, 4e12) || Date.now()
  };
}
function sanitizeDropStored(raw) {
  const tier = Math.max(0, Math.min(TIERS.length - 1, num(raw.tier, 99)));
  return {
    id: cleanText(raw.id, 'd-' + Date.now(), 60),
    pid: cleanText(raw.pid, '', 16),
    playerName: cleanText(raw.playerName, 'Игрок', 22),
    caseName: cleanText(raw.caseName, 'Кейс', 70),
    itemName: cleanText(raw.itemName, 'Предмет', 90),
    price: num(raw.price, MAX_DROP_PRICE),
    tierName: TIERS[tier][0], tierColor: TIERS[tier][1],
    createdAt: num(raw.createdAt, 4e12) || Date.now()
  };
}
try {
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(data)) for (const p of data) if (p && typeof p.id === 'string') players.set(p.id, sanitizeStored(p));
  }
} catch (err) { console.error('Не удалось прочитать leaderboard.json:', err.message); }
try {
  if (fs.existsSync(REF_FILE)) {
    const data = JSON.parse(fs.readFileSync(REF_FILE, 'utf8'));
    if (data && typeof data === 'object') for (const [k, r] of Object.entries(data).slice(0, MAX_REFS)) {
      if (!r || typeof r.inv !== 'string') continue;
      const flags = (v) => REF_TH.map((_, i) => (Array.isArray(v) && v[i] ? 1 : 0));
      refs.set(k.slice(0, 100), { inv: r.inv.slice(0, 16), invName: cleanText(r.invName, 'Игрок', 22), base: num(r.base), at: num(r.at, 4e12), prog: num(r.prog), name: cleanText(r.name, 'Игрок', 22), a: flags(r.a), b: flags(r.b) });
    }
  }
} catch (err) { console.error('Не удалось прочитать referrals.json:', err.message); }
try {
  if (fs.existsSync(DROPS_FILE)) {
    const data = JSON.parse(fs.readFileSync(DROPS_FILE, 'utf8'));
    if (Array.isArray(data)) {
      for (const x of data.slice(0, MAX_DROPS)) {
        if (!x || typeof x !== 'object') continue;
        const d = sanitizeDropStored(x);
        if (!d.pid && x.playerId) d.pid = pidOf(String(x.playerId));
        drops.push(d);
      }
    }
  }
} catch (err) { console.error('Не удалось прочитать drops.json:', err.message); }

/* ---------- запись на диск ---------- */
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); }
  catch (err) { console.error('Не удалось сохранить', path.basename(file) + ':', err.message); try { fs.unlinkSync(tmp); } catch {} }
}
let saveTimer = null, dropsTimer = null, refTimer = null;
const persist = () => { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; atomicWrite(DATA_FILE, JSON.stringify([...players.values()])); }, 1500); };
const persistRefs = () => { if (!refTimer) refTimer = setTimeout(() => { refTimer = null; atomicWrite(REF_FILE, JSON.stringify(Object.fromEntries(refs))); }, 1500); };
const persistDrops = () => { if (!dropsTimer) dropsTimer = setTimeout(() => { dropsTimer = null; atomicWrite(DROPS_FILE, JSON.stringify(drops.slice(0, MAX_DROPS))); }, 1500); };

/* ---------- HTTP ---------- */
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN'
};
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', ...SEC, ...headers
  });
  res.end(body);
}
function readJson(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.removeAllListeners('data'); req.resume(); reject(Object.assign(new Error('too large'), { statusCode: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}
// Проверка «личности» игрока: при первом обращении сервер запоминает хэш секрета, дальше он должен совпадать.
// Так чужой id нельзя перезаписать, зная только его.
const newByIp = new Map(); // ip -> времена создания профилей
let newGlobal = [];
function allowNewProfile(req) {
  const now = Date.now(), ip = clientIp(req), hour = 3600_000;
  newGlobal = newGlobal.filter((t) => now - t < hour);
  const mine = (newByIp.get(ip) || []).filter((t) => now - t < hour);
  if (newGlobal.length >= 150 || mine.length >= 6) return false;
  mine.push(now); newByIp.set(ip, mine); newGlobal.push(now);
  return true;
}
function authPlayer(id, token, req) {
  if (!/^[a-zA-Z0-9_-]{6,100}$/.test(id)) return { error: 'Invalid profile id.' };
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) return { error: 'Missing player token.' };
  const h = sha('tok:' + token);
  let p = players.get(id);
  if (!p) {
    if (req && !allowNewProfile(req)) return { error: 'Too many new profiles from this network; try later.', code: 429 };
    if (players.size >= MAX_PLAYERS && !evictFresh()) return { error: 'Server is full; try later.', code: 503 };
    p = { id, h, name: 'Игрок', balance: 0, earned: 0, ads: 0, lost: 0, wins: 0, updatedAt: Date.now(), created: Date.now(), syncs: 0, fresh: true };
    players.set(id, p);
  } else if (!p.h) { p.h = h; }
  else if (p.h !== h) return { error: 'Profile belongs to another player.', code: 403 };
  return { player: p };
}
// Освобождаем место только за счёт профилей, которые ни разу не присылали данные игры. Настоящих игроков не вытесняем.
function evictFresh() {
  let worst = null;
  for (const p of players.values()) if (p.fresh && (!worst || p.updatedAt < worst.updatedAt)) worst = p;
  if (worst) { players.delete(worst.id); return true; }
  return false;
}
function pruneOld() {
  const limit = Date.now() - PRUNE_AFTER_MS; let n = 0;
  const freshLimit = Date.now() - 30 * 60 * 1000;
  for (const [id, p] of players) if (p.updatedAt < limit || (p.fresh && p.updatedAt < freshLimit)) { players.delete(id); dropHits.delete(id); n++; }
  if (n) { persist(); console.log('Удалено неактивных профилей:', n); }
}
pruneOld();
setInterval(pruneOld, 30 * 60 * 1000).unref();

// Игра работает в браузере, поэтому присланным цифрам нельзя верить до конца. Ограничиваем скорость роста,
// чтобы одним запросом нельзя было вписать себя на первое место.
const BURST = 10e6, FIRST = 30e6, REFILL = 1e6; // запас роста: 10 млн, у нового профиля 30 млн, +1 млн в минуту
function applyProfile(p, raw) {
  const now = Date.now();
  const first = !!p.fresh;
  const minutes = first ? 0 : Math.max(0, (now - p.updatedAt) / 60000);
  const bk = p.bk || (p.bk = { balance: first ? FIRST : BURST, earned: first ? FIRST : BURST, lost: first ? FIRST : BURST });
  const grow = (key, want) => {
    bk[key] = Math.min(BURST, bk[key] + REFILL * minutes);
    const prev = first ? 0 : p[key] || 0;
    const gain = Math.max(0, want - prev), ok = Math.min(gain, first ? FIRST : bk[key]);
    if (!first) bk[key] -= ok;
    return want >= prev ? prev + ok : want;
  };
  const next = {
    balance: grow('balance', num(raw.balance)),
    earned: grow('earned', num(raw.earned)),
    lost: grow('lost', num(raw.lost)),
    ads: Math.min(num(raw.ads, 1e7), first ? 50 : p.ads + 2 + Math.floor(minutes / 1.5)),
    wins: Math.min(num(raw.wins, 1e9), first ? 500 : p.wins + 60 + Math.floor(minutes * 60)),
    rogue: Math.max(p.rogue || 0, Math.min(num(raw.rogue, 2000), 2000)),
    depth: Math.max(p.depth || 0, Math.min(num(raw.depth, 200), 200))
  };
  { // рейтинг «Забега дня»: только за сегодняшнюю дату (UTC), в пределах одной попытки
    const today = utcDay(), want = raw.rdd === today ? Math.min(num(raw.rd, 2000), 2000) : 0;
    if (want > 0) { next.rdd = today; next.rd = p.rdd === today ? Math.max(p.rd || 0, want) : want; }
  }
  { // рейтинг недели (события): неделя считается от понедельника, UTC
    const wk = String(Math.floor((Date.now() / 864e5 + 3) / 7)), wantW = String(raw.rwk) === wk ? Math.min(num(raw.rw, 2000), 2000) : 0;
    if (wantW > 0) { next.rwk = wk; next.rw = p.rwk === wk ? Math.max(p.rw || 0, wantW) : wantW; }
  }
  Object.assign(p, next, { name: cleanText(raw.name, p.name || 'Игрок', 22), updatedAt: now, syncs: (p.syncs || 0) + 1 });
  delete p.fresh;
}
// В рейтинг попадают профили, которые прислали данные минимум 3 раза и существуют больше двух минут.
const eligible = (x) => !x.fresh && (x.syncs === undefined || (x.syncs >= 3 && Date.now() - (x.created || 0) >= 120_000));

const ETAG_CACHE = { mtime: 0, buf: null, gz: null, etag: '' };
function loadIndex() {
  const st = fs.statSync(INDEX_FILE);
  if (st.mtimeMs !== ETAG_CACHE.mtime) {
    const buf = fs.readFileSync(INDEX_FILE);
    ETAG_CACHE.buf = buf; ETAG_CACHE.gz = zlib.gzipSync(buf, { level: 9 });
    ETAG_CACHE.etag = '"' + sha(buf).slice(0, 20) + '"'; ETAG_CACHE.mtime = st.mtimeMs;
  }
  return ETAG_CACHE;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Player-Token', 'Access-Control-Max-Age': '86400'
      });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // Страница и проверка живости не считаются в лимит: так хостинг и пользователи не блокируются.
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) {
      const f = loadIndex();
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding', ...SEC };
      if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); return res.end(f.gz); }
      res.writeHead(200, headers); return res.end(f.buf);
    }
    if (req.method === 'GET' && (p === '/healthz' || p === '/api/health')) return send(res, 200, { ok: true, players: players.size });
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\nDisallow: /api/\n'); }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    if (rateLimited(req)) return send(res, 429, { error: 'Too many requests; try again in a minute.' }, { 'Retry-After': '30' });

    if (req.method === 'GET' && p === '/api/leaderboard') {
      const category = url.searchParams.get('category') || 'earned';
      if (!CATEGORIES.has(category)) return send(res, 400, { error: 'Unknown leaderboard category.' });
      const today = utcDay(), isDaily = category === 'daily', isWeekly = category === 'weekly', wkNow = String(Math.floor((Date.now() / 864e5 + 3) / 7));
      const val = (x) => isDaily ? (x.rdd === today ? x.rd || 0 : 0) : isWeekly ? (x.rwk === wkNow ? x.rw || 0 : 0) : (x[category] || 0);
      const entries = [...players.values()].filter((x) => eligible(x) && x.updatedAt > Date.now() - PRUNE_AFTER_MS && ((!isDaily && !isWeekly) || val(x) > 0))
        .sort((a, b) => (val(b) - val(a)) || (b.updatedAt - a.updatedAt)).slice(0, 50)
        .map((x) => ({ pid: pidOf(x.id), name: x.name, balance: x.balance, earned: x.earned, ads: x.ads, lost: x.lost, wins: x.wins, rogue: x.rogue || 0, depth: x.depth || 0, daily: val(x), weekly: val(x) }));
      return send(res, 200, { category, entries, total: players.size });
    }
    if (req.method === 'GET' && p === '/api/drops') {
      const requested = Number.parseInt(url.searchParams.get('limit') || '60', 10);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, requested)) : 60;
      return send(res, 200, { entries: drops.slice(0, limit).map(({ pid, ...d }) => d), total: drops.length });
    }
    if (req.method === 'POST' && p === '/api/drops') {
      const raw = await readJson(req, res);
      const id = String(raw.id || '').trim();
      const a = authPlayer(id, req.headers['x-player-token'], req);
      if (a.error) return send(res, a.code || 400, { error: a.error });
      if (!CAT) return send(res, 503, { error: 'Drop feed is not configured.' });
      if (!Array.isArray(raw.drops) || raw.drops.length < 1 || raw.drops.length > 6) return send(res, 400, { error: 'Provide between 1 and 6 drops.' });
      const now = Date.now();
      let q = dropHits.get(id);
      if (!q || now - q.start > 60_000) { q = { start: now, count: 0 }; dropHits.set(id, q); }
      if (q.count + raw.drops.length > 24) return send(res, 429, { error: 'Too many drops.' });
      q.count += raw.drops.length;
      const pid = pidOf(id), name = cleanText(raw.name, 'Игрок', 22);
      const fresh = [];
      raw.drops.forEach((e, i) => {
        const it = e && CAT.items[num(e.itemId, 1e6)], cn = e && CAT.cases.includes(String(e.caseName)) ? String(e.caseName) : 'Кейс';
        if (!it) return;
        fresh.push(sanitizeDropStored({ id: now.toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '-' + i, pid, playerName: name,
          caseName: cn, itemName: it[0], price: Math.min(it[1], MAX_DROP_PRICE), tier: it[2], createdAt: now + i }));
      });
      if (!fresh.length) return send(res, 400, { error: 'No valid drops.' });
      drops.unshift(...fresh);
      if (drops.length > MAX_DROPS) drops.length = MAX_DROPS;
      persistDrops();
      return send(res, 201, { ok: true, added: fresh.length });
    }
    if (req.method === 'POST' && p === '/api/profile') {
      const raw = await readJson(req, res);
      const id = String(raw.id || '').trim();
      const a = authPlayer(id, req.headers['x-player-token'], req);
      if (a.error) return send(res, a.code || 400, { error: a.error });
      applyProfile(a.player, raw);
      a.player.ip = ipHash(req);
      const rr = refs.get(id);
      if (rr) { rr.prog = Math.max(rr.prog, a.player.earned - rr.base); rr.name = a.player.name; persistRefs(); }
      persist();
      return send(res, 200, { ok: true, pid: pidOf(id), cap: a.player.balance + 12e6 });
    }
    if (req.method === 'POST' && p === '/api/ref') {
      const raw = await readJson(req, res);
      const id = String(raw.id || '').trim();
      const a = authPlayer(id, req.headers['x-player-token'], req);
      if (a.error) return send(res, a.code || 400, { error: a.error });
      const me = a.player, myPid = pidOf(id), now = Date.now();
      me.ip = ipHash(req);
      let joinError = null;
      if (raw.ref && !refs.has(id)) {
        const code = String(raw.ref).toLowerCase();
        let inviter = null;
        if (/^[0-9a-f]{12}$/.test(code) && code !== myPid) for (const x of players.values()) if (pidOf(x.id) === code) { inviter = x; break; }
        if (code === myPid) joinError = 'self';
        else if (!inviter || inviter.fresh) joinError = 'unknown';
        else if (me.fresh) joinError = 'retry';
        else if (me.earned > 2000 || me.ads > 20) joinError = 'old';
        else if (inviter.ip && inviter.ip === me.ip) joinError = 'same_network';
        else if (refs.size >= MAX_REFS || [...refs.values()].filter((r) => r.inv === code).length >= MAX_INVITES) joinError = 'full';
        else {
          refs.set(id, { inv: code, invName: inviter.name, base: me.earned, at: now, prog: 0, name: me.name, a: REF_TH.map(() => 0), b: REF_TH.map(() => 0) });
          persistRefs();
        }
      }
      const ready = (r, i) => r.prog >= REF_TH[i] && now - r.at >= REF_AGE[i] * 60000;
      let claimed = 0;
      const mine = refs.get(id);
      const invitees = [...refs.entries()].filter(([, r]) => r.inv === myPid);
      if (raw.claim) {
        if (mine) REF_TH.forEach((t, i) => { if (!mine.b[i] && ready(mine, i)) { mine.b[i] = 1; claimed += REF_RW[i]; } });
        for (const [, r] of invitees) REF_TH.forEach((t, i) => { if (!r.a[i] && ready(r, i)) { r.a[i] = 1; claimed += REF_RW[i]; } });
        if (claimed) persistRefs();
      }
      let pending = 0;
      if (mine) REF_TH.forEach((t, i) => { if (!mine.b[i] && ready(mine, i)) pending += REF_RW[i]; });
      for (const [, r] of invitees) REF_TH.forEach((t, i) => { if (!r.a[i] && ready(r, i)) pending += REF_RW[i]; });
      const view = (r, got) => ({ name: r.name, prog: r.prog, age: Math.floor((now - r.at) / 60000), got: [...got], ready: REF_TH.map((_, i) => ready(r, i)) });
      return send(res, 200, {
        ok: true, code: myPid, th: REF_TH, rw: REF_RW, minAge: REF_AGE, joinError, claimed, pending,
        me: mine ? { ...view(mine, mine.b), inviter: mine.invName } : null,
        invitees: invitees.map(([, r]) => view(r, r.a))
      });
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (err) {
    if (err && err.statusCode) return send(res, err.statusCode, { error: err.statusCode === 413 ? 'Request too large.' : 'Could not read request.' }, { Connection: 'close' });
    console.error(err);
    if (!res.headersSent) return send(res, 500, { error: 'Server error.' });
  }
});
/* ---------- WebSocket rooms for the 3D shooter ----------
 * The host browser runs the authoritative simulation. This server only routes
 * room messages; players should open the same site through the host's Radmin IP.
 */
const wss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 });
const netRooms = new Map();
const NET_MAX_PLAYERS = 10;
function wsSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}
function netName(v) {
  return cleanText(v, 'Игрок', 22);
}
function netSettings(raw, prev) {
  raw = raw && typeof raw === 'object' ? raw : {};
  prev = prev && typeof prev === 'object' ? prev : {};
  const mode = raw.mode === 'dm' ? 'dm' : (raw.mode === 'bomb' ? 'bomb' : (prev.mode === 'dm' ? 'dm' : 'bomb'));
  const map = typeof raw.map === 'string' && /^[a-z0-9_-]{1,24}$/i.test(raw.map) ? raw.map : (prev.map || 'canyon');
  const team = ['ct', 't', 'rand'].includes(raw.team) ? raw.team : (prev.team || 'ct');
  const botsEnabled = raw.botsEnabled === undefined ? (prev.botsEnabled !== false) : !!raw.botsEnabled;
  const botsPerTeam = Math.max(0, Math.min(5, Number.isFinite(+raw.botsPerTeam) ? Math.floor(+raw.botsPerTeam) : (Number.isFinite(+prev.botsPerTeam) ? Math.floor(+prev.botsPerTeam) : 2)));
  return { map, mode, diff: Math.max(0, Math.min(2, Number.isFinite(+raw.diff) ? Math.floor(+raw.diff) : (prev.diff || 1))), to: [3, 5, 8].includes(+raw.to) ? +raw.to : ([3, 5, 8].includes(+prev.to) ? +prev.to : 5), team, botsEnabled: botsEnabled && botsPerTeam > 0, botsPerTeam };
}
function publicRoom(room) {
  return {
    room: room.code,
    hostId: room.hostId,
    started: room.started,
    settings: room.settings,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, role: p.role, team: p.team || null }))
  };
}
function roomBroadcast(room, obj, except) {
  for (const p of room.players.values()) if (p.ws !== except) wsSend(p.ws, obj);
}
function roomUpdate(room) { roomBroadcast(room, Object.assign({ type: 'roomUpdate' }, publicRoom(room))); }
function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
    if (!netRooms.has(code)) return code;
  }
  throw new Error('No free room codes');
}
function detachSocket(ws) {
  const meta = ws.netMeta;
  if (!meta) return;
  ws.netMeta = null;
  const room = netRooms.get(meta.room);
  if (!room) return;
  const player = room.players.get(meta.id);
  if (!player) return;
  room.players.delete(meta.id);
  if (player.role === 'host') {
    roomBroadcast(room, { type: 'closed', message: 'Хост отключился.' });
    for (const p of room.players.values()) { p.ws.netMeta = null; try { p.ws.close(1000, 'Host left'); } catch {} }
    netRooms.delete(room.code);
    return;
  }
  roomBroadcast(room, { type: 'playerLeft', playerId: meta.id, players: publicRoom(room).players });
  roomUpdate(room);
  if (!room.players.size) netRooms.delete(room.code);
}
server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  ws.netMeta = null;
  ws.lastInputAt = 0;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch { wsSend(ws, { type: 'error', message: 'Некорректное сообщение.' }); return; }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (!ws.netMeta) {
      if (m.type === 'create') {
        try {
          const code = randomRoomCode();
          const id = crypto.randomBytes(9).toString('base64url');
          const settings = netSettings(m.settings, { map: 'canyon', mode: 'bomb', diff: 1, to: 5, team: 'ct', botsEnabled: false, botsPerTeam: 0 });
          const room = { code, hostId: id, players: new Map(), settings, started: false, createdAt: Date.now() };
          const player = { id, name: netName(m.name), role: 'host', team: null, ws };
          room.players.set(id, player); netRooms.set(code, room); ws.netMeta = { room: code, id, role: 'host' };
          wsSend(ws, Object.assign({ type: 'created', selfId: id, role: 'host' }, publicRoom(room)));
          roomUpdate(room);
        } catch { wsSend(ws, { type: 'error', message: 'Не удалось создать комнату.' }); }
        return;
      }
      if (m.type === 'join') {
        const code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        const room = netRooms.get(code);
        if (!room) { wsSend(ws, { type: 'error', message: 'Комната не найдена. Проверь код и адрес сервера.' }); return; }
        if (room.started) { wsSend(ws, { type: 'error', message: 'Матч уже начался. Попроси хоста создать новую комнату.' }); return; }
        if (room.players.size >= NET_MAX_PLAYERS) { wsSend(ws, { type: 'error', message: 'Комната заполнена (максимум 10 игроков).' }); return; }
        const id = crypto.randomBytes(9).toString('base64url');
        room.players.set(id, { id, name: netName(m.name), role: 'player', team: null, ws });
        ws.netMeta = { room: code, id, role: 'player' };
        wsSend(ws, Object.assign({ type: 'joined', selfId: id, role: 'player' }, publicRoom(room)));
        roomUpdate(room);
        return;
      }
      if (m.type !== 'ping') wsSend(ws, { type: 'error', message: 'Сначала создай комнату или подключись по коду.' });
      return;
    }
    const meta = ws.netMeta, room = netRooms.get(meta.room), player = room && room.players.get(meta.id);
    if (!room || !player) { wsSend(ws, { type: 'error', message: 'Комната больше не существует.' }); return; }
    if (m.type === 'leave') { detachSocket(ws); try { ws.close(1000, 'Left room'); } catch {} return; }
    if (m.type === 'settings') {
      if (player.role !== 'host' || room.started) return;
      room.settings = netSettings(m.settings, room.settings); roomUpdate(room); return;
    }
    if (m.type === 'start') {
      if (player.role !== 'host' || room.started) return;
      room.settings = netSettings(m.settings, room.settings);
      let hostTeam = room.settings.team;
      if (hostTeam === 'rand') hostTeam = Math.random() < 0.5 ? 'ct' : 't';
      const counts = { ct: 0, t: 0 };
      player.team = hostTeam; counts[hostTeam]++;
      for (const p of room.players.values()) {
        if (p.id === room.hostId) continue;
        p.team = counts.ct <= counts.t ? 'ct' : 't'; counts[p.team]++;
      }
      room.started = true;
      roomBroadcast(room, Object.assign({ type: 'start' }, publicRoom(room)));
      return;
    }
    if (m.type === 'input' && player.role !== 'host' && !room.started) return;
    if (m.type === 'input' && player.role !== 'host') {
      const now = Date.now(); if (now - ws.lastInputAt < 15) return; ws.lastInputAt = now;
      const q = m.input && typeof m.input === 'object' ? m.input : {};
      const clean = {
        yaw: Number.isFinite(+q.yaw) ? Math.max(-1000, Math.min(1000, +q.yaw)) : 0,
        pitch: Number.isFinite(+q.pitch) ? Math.max(-1.45, Math.min(1.45, +q.pitch)) : 0,
        mx: Number.isFinite(+q.mx) ? Math.max(-1, Math.min(1, +q.mx)) : 0,
        mz: Number.isFinite(+q.mz) ? Math.max(-1, Math.min(1, +q.mz)) : 0,
        sp: Number.isFinite(+q.sp) ? Math.max(0, Math.min(1.5, +q.sp)) : 1,
        walk: !!q.walk, fire: !!q.fire, fireP: !!q.fireP, crouch: !!q.crouch, use: !!q.use
      };
      const host = room.players.get(room.hostId); wsSend(host && host.ws, { type: 'remoteInput', playerId: player.id, input: clean }); return;
    }
    if (m.type === 'action' && player.role !== 'host') {
      const allowed = new Set(['reload', 'weapon', 'cycle', 'grenade', 'lastweapon', 'scope', 'buy', 'skipFreeze']);
      if (!allowed.has(String(m.action || ''))) return;
      const host = room.players.get(room.hostId);
      wsSend(host && host.ws, { type: 'remoteAction', playerId: player.id, action: String(m.action), value: typeof m.value === 'string' ? m.value.slice(0, 32) : (Number.isFinite(+m.value) ? +m.value : null) }); return;
    }
    if (m.type === 'snapshot' && player.role === 'host' && room.started && m.state && typeof m.state === 'object') {
      roomBroadcast(room, { type: 'snapshot', state: m.state }, ws); return;
    }
    if (m.type === 'matchEnd' && player.role === 'host' && room.started && m.state && typeof m.state === 'object') {
      roomBroadcast(room, { type: 'matchEnd', state: m.state }, ws); room.started = false; roomUpdate(room); return;
    }
    if (m.type === 'ping') wsSend(ws, { type: 'pong', at: Date.now() });
  });
  ws.on('close', () => detachSocket(ws));
  ws.on('error', () => detachSocket(ws));
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

server.listen(PORT, HOST, () => {
  console.log(`Кейс Арена запущена: http://localhost:${PORT}`);
  console.log(`Профилей в рейтинге: ${players.size}, дропов в ленте: ${drops.length}, данные: ${DATA_DIR}`);
});

function shutdown() {
  atomicWrite(DATA_FILE, JSON.stringify([...players.values()]));
  atomicWrite(DROPS_FILE, JSON.stringify(drops.slice(0, MAX_DROPS)));
  atomicWrite(REF_FILE, JSON.stringify(Object.fromEntries(refs)));
  for (const room of netRooms.values()) roomBroadcast(room, { type: 'closed', message: 'Сервер выключается.' });
  try { wss.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
