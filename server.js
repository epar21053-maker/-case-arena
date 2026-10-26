'use strict';

// Кейс Арена — сервер сайта: отдаёт index.html, ведёт таблицу лидеров и общую ленту дропов.
// Без сторонних пакетов, нужен Node.js 18+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { URL } = require('node:url');

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
    if (req.method === 'GET' && p === '/api/lan') return send(res, 200, { port: PORT, addrs: mpAddrs() });
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
/* ===== Сетевая игра «Штурм»: WebSocket-реле с комнатами (без зависимостей) ===== */
const os = require('node:os');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_MSG = 96 * 1024;
const MP_MAX_ROOMS = 200, MP_MAX_PEERS = 600, MP_PER_IP = 24;
const mpRooms = new Map();
const mpPeers = new Map();
let mpNextId = 1;
const mpIps = new Map();

function wsFrame(op, payload) {
  const len = payload.length;
  let h;
  if (len < 126) h = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
  return Buffer.concat([h, payload]);
}

class MpPeer {
  constructor(socket, ip) {
    this.id = mpNextId++;
    this.socket = socket;
    this.ip = ip;
    this.name = 'Игрок';
    this.room = null;
    this.alive = true;
    this.closed = false;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.rate = 0;
    this.rateT = Date.now();
    mpPeers.set(this.id, this);
    mpIps.set(ip, (mpIps.get(ip) || 0) + 1);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
    this.send({ t: 'hi', id: this.id });
  }
  sendRaw(op, payload) {
    if (this.closed) return;
    try { this.socket.write(wsFrame(op, payload)); } catch (e) { this.kill(); }
  }
  send(obj) { this.sendRaw(1, Buffer.from(JSON.stringify(obj))); }
  sendStr(s) { this.sendRaw(1, Buffer.from(s)); }
  kill(code) {
    if (this.closed) return;
    try { const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0); this.socket.write(wsFrame(8, p)); } catch (e) {}
    try { this.socket.end(); } catch (e) {}
    setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 400).unref();
    this.onClose();
  }
  onData(d) {
    this.alive = true;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2 && !this.closed) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 128), op = b0 & 15, masked = !!(b1 & 128);
      let len = b1 & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) > 0) return this.kill(1009);
        len = this.buf.readUInt32BE(6); off = 10;
      }
      if (len > WS_MAX_MSG || !masked) return this.kill(masked ? 1009 : 1002);
      if (this.buf.length < off + 4 + len) return;
      const mk = this.buf.subarray(off, off + 4);
      const pl = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) pl[i] = this.buf[off + 4 + i] ^ mk[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 8) return this.kill(1000);
      if (op === 9) { this.sendRaw(10, pl); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) {
        if (!fin) { this.frag = [pl]; this.fragOp = op; continue; }
        this.onMsg(pl, op);
      } else if (op === 0) {
        if (!this.frag) return this.kill(1002);
        this.frag.push(pl);
        if (this.frag.reduce((a, b) => a + b.length, 0) > WS_MAX_MSG) return this.kill(1009);
        if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.onMsg(all, this.fragOp); }
      } else return this.kill(1002);
    }
  }
  onMsg(pl, op) {
    if (op !== 1) return;
    const now = Date.now();
    if (now - this.rateT > 1000) { this.rateT = now; this.rate = 0; }
    if (++this.rate > 400) return;
    let m;
    try { m = JSON.parse(pl.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ping': this.send({ t: 'pong', ts: m.ts }); break;
      case 'name': this.name = cleanName(m.name); break;
      case 'list': this.send({ t: 'rooms', rooms: roomList() }); break;
      case 'create': this.create(m); break;
      case 'join': this.join(m); break;
      case 'leave': this.leave(); break;
      case 'meta': {
        const r = this.room;
        if (r && r.host === this.id && m.meta && typeof m.meta === 'object') {
          const mt = {};
          for (const k of ['map', 'mode', 'st', 'diff', 'to', 'bots', 'per']) if (m.meta[k] !== undefined) mt[k] = String(m.meta[k]).slice(0, 24);
          r.meta = Object.assign(r.meta, mt);
        }
        break;
      }
      case 'to': this.relay(m, pl); break;
    }
  }
  create(m) {
    if (this.room) this.leave();
    if (mpRooms.size >= MP_MAX_ROOMS) return this.send({ t: 'err', m: 'busy' });
    this.name = cleanName(m.name);
    let c;
    for (let i = 0; i < 40; i++) { c = genCode(); if (!mpRooms.has(c)) break; c = null; }
    if (!c) return this.send({ t: 'err', m: 'busy' });
    const max = Math.max(2, Math.min(10, (m.max | 0) || 10));
    const r = { c, name: cleanName(m.rname || (this.name + ': комната'), 28), host: this.id, peers: new Map(), max, priv: !!m.priv, meta: { st: 'lobby' }, created: Date.now() };
    r.peers.set(this.id, this);
    mpRooms.set(c, r);
    this.room = r;
    this.send({ t: 'joined', c, me: this.id, host: this.id, max, peers: peerList(r) });
  }
  join(m) {
    const c = String(m.c || '').toUpperCase().trim();
    this.name = cleanName(m.name);
    const r = mpRooms.get(c);
    if (!r) return this.send({ t: 'err', m: 'no_room' });
    if (r.peers.size >= r.max) return this.send({ t: 'err', m: 'full' });
    if (this.room) { if (this.room === r) return; this.leave(); }
    r.peers.set(this.id, this);
    this.room = r;
    this.send({ t: 'joined', c, me: this.id, host: r.host, max: r.max, peers: peerList(r) });
    bcast(r, { t: 'peer', id: this.id, name: this.name }, this.id);
  }
  leave() {
    const r = this.room;
    if (!r) return;
    this.room = null;
    r.peers.delete(this.id);
    if (r.host === this.id) {
      for (const p of r.peers.values()) { p.room = null; p.send({ t: 'closed', why: 'host' }); }
      r.peers.clear();
      mpRooms.delete(r.c);
    } else {
      bcast(r, { t: 'gone', id: this.id });
    }
  }
  relay(m, raw) {
    const r = this.room;
    if (!r || m.d === undefined) return;
    const out = JSON.stringify({ t: 'm', f: this.id, d: m.d });
    const drop = (p) => m.u && p.socket.writableLength > 262144;
    if (m.to === '*') {
      for (const p of r.peers.values()) if (p !== this && !drop(p)) p.sendStr(out);
    } else {
      const to = m.to === 'host' ? r.host : (m.to | 0);
      const p = r.peers.get(to);
      if (p && p !== this && !drop(p)) p.sendStr(out);
    }
  }
  onClose() {
    if (this.closedDone) return;
    this.closedDone = true;
    this.closed = true;
    this.leave();
    mpPeers.delete(this.id);
    const n = (mpIps.get(this.ip) || 1) - 1;
    if (n <= 0) mpIps.delete(this.ip); else mpIps.set(this.ip, n);
  }
}
function cleanName(s, max) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, max || 16);
  return s || 'Игрок';
}
function genCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[crypto.randomInt(A.length)];
  return s;
}
function peerList(r) { return [...r.peers.values()].map((p) => ({ id: p.id, name: p.name })); }
function bcast(r, obj, except) {
  const s = JSON.stringify(obj);
  for (const p of r.peers.values()) if (p.id !== except) p.sendStr(s);
}
function roomList() {
  const out = [];
  for (const r of mpRooms.values()) {
    if (r.priv) continue;
    const h = r.peers.get(r.host);
    out.push({ c: r.c, name: r.name, host: h ? h.name : '', n: r.peers.size, max: r.max, meta: r.meta });
  }
  return out.slice(0, 60);
}
function mpUpgrade(req, socket) {
  try {
    const u = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (u.pathname !== '/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
    const ip = String(String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.remoteAddress || '');
    if (mpPeers.size >= MP_MAX_PEERS || (mpIps.get(ip) || 0) >= MP_PER_IP) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const acc = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    socket.setNoDelay(true);
    socket.setTimeout(0);
    new MpPeer(socket, ip);
  } catch (e) { try { socket.destroy(); } catch (x) {} }
}
setInterval(() => {
  for (const p of mpPeers.values()) {
    if (!p.alive) { p.kill(1001); continue; }
    p.alive = false;
    p.sendRaw(9, Buffer.alloc(0));
  }
}, 12000).unref();
function mpAddrs() {
  const list = [];
  try {
    for (const [name, arr] of Object.entries(os.networkInterfaces())) {
      for (const a of arr || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        const tag = /^26\./.test(a.address) ? 'Radmin VPN' : /^25\./.test(a.address) ? 'Hamachi' : /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address) ? 'локальная сеть' : name;
        list.push({ ip: a.address, tag });
      }
    }
  } catch (e) {}
  return list;
}
function mpPrintAddrs() {
  const list = mpAddrs();
  if (list.length) {
    console.log('Сетевая игра «Штурм»: друзья открывают в браузере один из адресов:');
    for (const a of list) console.log(`   http://${a.ip}:${PORT}   (${a.tag})`);
  }
}

server.on('upgrade', (req, socket) => mpUpgrade(req, socket));
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

server.listen(PORT, HOST, () => {
  mpPrintAddrs();
  console.log(`Кейс Арена запущена: http://localhost:${PORT}`);
  console.log(`Профилей в рейтинге: ${players.size}, дропов в ленте: ${drops.length}, данные: ${DATA_DIR}`);
});

function shutdown() {
  atomicWrite(DATA_FILE, JSON.stringify([...players.values()]));
  atomicWrite(DROPS_FILE, JSON.stringify(drops.slice(0, MAX_DROPS)));
  atomicWrite(REF_FILE, JSON.stringify(Object.fromEntries(refs)));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
