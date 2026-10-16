'use strict';

// Кейс Арена — серверная экономика. Node.js 18+, внешние зависимости не нужны.
// Деньги, инвентарь, ежедневный кейс и игровые результаты определяются только сервером.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, 'index.html');
const CATALOG_FILE = path.join(ROOT, 'catalog.json');
const DATA_DIR = process.env.DATA_DIR || ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });
const ECONOMY_FILE = path.join(DATA_DIR, 'economy.json');
const DROPS_FILE = path.join(DATA_DIR, 'drops.json');
const ECONOMY_VERSION = 1;
const STARTING_BALANCE = 2000;
const MAX_BODY = 64 * 1024;
const MAX_INVENTORY = 2000;
const CATALOG = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
const ITEMS = CATALOG.items;
const CASES = CATALOG.cases;
const DAILY_CASES = CATALOG.daily;
const ITEM_BY_ID = new Map(ITEMS.map(item => [item.id, item]));
const players = new Map();
const drops = [];
const requests = new Map();

function defaultStats() {
  return { opened: 0, spent: 0, best: 0, ads: 0, earned: 0, lost: 0, wins: 0, losses: 0,
    upgrades: 0, upgradeWins: 0, upgradeLosses: 0, contracts: 0, miniGames: 0, miniWins: 0,
    rocketWins: 0, soldItems: 0, soldValue: 0, rpgBest: 0, slotTriples: 0, slotMega: 0 };
}
function safeName(value) {
  const name = String(value || 'Игрок').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 22);
  return name || 'Игрок';
}
function int(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isSafeInteger(Math.floor(n)) && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : min;
}
function makePlayer(id, tokenHash, name) {
  return {
    id, tokenHash, name: safeName(name), balance: STARTING_BALANCE, inv: [], nextUid: 1,
    stats: defaultStats(), seen: [], daily: { last: null, streak: 0, bonus: 0 },
    createdAt: Date.now(), updatedAt: Date.now()
  };
}
function sanitizePlayer(raw) {
  const id = String(raw.id || '');
  const p = makePlayer(id, String(raw.tokenHash || ''), raw.name);
  p.balance = int(raw.balance, 0, 1_000_000_000_000);
  p.inv = Array.isArray(raw.inv) ? raw.inv.slice(0, MAX_INVENTORY).map(e => ({ uid: int(e.uid, 1), id: int(e.id, 0, ITEMS.length - 1) })).filter(e => ITEM_BY_ID.has(e.id)) : [];
  p.nextUid = Math.max(int(raw.nextUid, 1), p.inv.reduce((m, e) => Math.max(m, e.uid + 1), 1));
  p.stats = { ...defaultStats(), ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) };
  for (const key of Object.keys(defaultStats())) p.stats[key] = int(p.stats[key]);
  p.seen = Array.isArray(raw.seen) ? [...new Set(raw.seen.map(v => int(v, 0, ITEMS.length - 1)).filter(v => ITEM_BY_ID.has(v)))].slice(0, ITEMS.length) : [];
  p.daily = raw.daily && typeof raw.daily === 'object' ? { last: typeof raw.daily.last === 'string' ? raw.daily.last : null, streak: int(raw.daily.streak, 0, 7), bonus: 0 } : { last: null, streak: 0, bonus: 0 };
  p.createdAt = int(raw.createdAt, 1) || Date.now();
  p.updatedAt = int(raw.updatedAt, 1) || Date.now();
  return p;
}
function loadData() {
  // Version mismatch deliberately starts a fresh economy: all accounts begin at 2,000 ₽ with empty bags.
  try {
    if (fs.existsSync(ECONOMY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ECONOMY_FILE, 'utf8'));
      if (raw && raw.version === ECONOMY_VERSION && Array.isArray(raw.players)) {
        for (const item of raw.players) {
          if (item && typeof item.id === 'string' && /^[a-zA-Z0-9_-]{6,100}$/.test(item.id)) {
            const p = sanitizePlayer(item); players.set(p.id, p);
          }
        }
      } else console.log('Старая экономика не импортируется: включён новый старт 2 000 ₽ / пустой инвентарь.');
    }
  } catch (error) { console.error('Не удалось прочитать economy.json:', error.message); }
  try {
    if (fs.existsSync(DROPS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DROPS_FILE, 'utf8'));
      if (Array.isArray(raw)) drops.push(...raw.slice(0, 200).filter(x => x && typeof x === 'object').map(sanitizeDrop));
    }
  } catch (error) { console.error('Не удалось прочитать drops.json:', error.message); }
}
function saveData() {
  const temp = ECONOMY_FILE + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: ECONOMY_VERSION, players: [...players.values()] }), 'utf8');
    fs.renameSync(temp, ECONOMY_FILE);
  } catch (error) {
    console.error('Не удалось сохранить экономику:', error.message);
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
  }
}
function saveDrops() {
  const temp = DROPS_FILE + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(drops.slice(0, 200)), 'utf8'); fs.renameSync(temp, DROPS_FILE); }
  catch (error) { console.error('Не удалось сохранить ленту дропов:', error.message); }
}
function safeText(value, fallback, max = 90) {
  const text = String(value || fallback).replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return text || fallback;
}
function safeColor(value) { return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : '#8f9aa6'; }
function sanitizeDrop(raw) {
  return {
    id: safeText(raw.id, `drop-${Date.now()}`, 100), playerId: String(raw.playerId || '').slice(0, 100),
    playerName: safeName(raw.playerName), caseName: safeText(raw.caseName, 'Кейс', 70),
    itemName: safeText(raw.itemName, 'Предмет', 90), price: int(raw.price, 0, 1_000_000_000_000),
    tierName: safeText(raw.tierName, 'Предмет', 30), tierColor: safeColor(raw.tierColor),
    createdAt: int(raw.createdAt, 1) || Date.now()
  };
}
function addDrops(p, caseObj, inventoryEntries) {
  const now = Date.now();
  const found = inventoryEntries.map(entry => ITEM_BY_ID.get(entry.id)).filter(Boolean)
    .filter(item => item.tier >= 3 || item.price >= caseObj.price * 3).sort((a, b) => b.price - a.price).slice(0, 4);
  found.forEach((item, index) => drops.unshift(sanitizeDrop({
    id: `drop-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}-${index}`,
    playerId: p.id, playerName: p.name, caseName: caseObj.name, itemName: item.name, price: item.price,
    tierName: CATALOG.tiers[item.tier]?.n || 'Предмет', tierColor: CATALOG.tiers[item.tier]?.c || '#8f9aa6', createdAt: now + index
  })));
  if (drops.length > 200) drops.length = 200;
  if (found.length) saveDrops();
}
function stateFor(p) {
  return { id: p.id, name: p.name, balance: p.balance, inv: p.inv.map(e => ({ uid: e.uid, id: e.id })),
    nextUid: p.nextUid, stats: { ...p.stats }, seen: [...p.seen], daily: { ...p.daily }, updatedAt: p.updatedAt };
}
function touch(p) { p.updatedAt = Date.now(); }
function syncSeen(p, entries) {
  const set = new Set(p.seen);
  for (const e of entries) set.add(e.id);
  p.seen = [...set].slice(0, ITEMS.length);
}
function getPlayer(req, raw, create = true) {
  const id = String(raw.id || '').trim();
  const token = String(req.headers['x-player-token'] || '');
  if (!/^[a-zA-Z0-9_-]{6,100}$/.test(id)) throw Object.assign(new Error('Неверный ID игрока.'), { statusCode: 400 });
  if (!/^[a-fA-F0-9]{24,128}$/.test(token)) throw Object.assign(new Error('Не найден ключ игрока. Обнови страницу.'), { statusCode: 401 });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let p = players.get(id);
  if (!p) {
    if (!create) throw Object.assign(new Error('Профиль не найден.'), { statusCode: 404 });
    p = makePlayer(id, tokenHash, raw.name); players.set(id, p); saveData();
  } else if (!p.tokenHash) {
    p.tokenHash = tokenHash;
  } else if (!crypto.timingSafeEqual(Buffer.from(p.tokenHash, 'hex'), Buffer.from(tokenHash, 'hex'))) {
    throw Object.assign(new Error('Ключ этого профиля не совпадает. Очистка данных браузера создаёт другой профиль.'), { statusCode: 401 });
  }
  if (raw.name && raw.name !== p.name) p.name = safeName(raw.name);
  return p;
}
function randomItem(caseObj) {
  let roll = Math.random(), band = caseObj.bands[caseObj.bands.length - 1];
  for (const b of caseObj.bands) { roll -= b.prob; if (roll <= 0) { band = b; break; } }
  const ids = band.itemIds;
  return ITEM_BY_ID.get(ids[Math.floor(Math.random() * ids.length)]);
}
function newInventoryEntry(p, item) {
  if (p.inv.length >= MAX_INVENTORY) throw Object.assign(new Error('Инвентарь заполнен. Продай часть предметов.'), { statusCode: 409 });
  const entry = { uid: p.nextUid++, id: item.id }; p.inv.push(entry); return entry;
}
function openCase(p, raw) {
  const isDaily = raw.kind === 'daily';
  let caseObj, qty, cost;
  if (isDaily) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (p.daily.last === today) throw Object.assign(new Error('Ежедневный кейс уже открыт сегодня.'), { statusCode: 409 });
    const streak = p.daily.last === yesterday ? Math.min(7, (p.daily.streak || 0) + 1) : 1;
    caseObj = DAILY_CASES[streak - 1]; qty = 1; cost = 0;
    p.daily = { last: today, streak, bonus: 0 };
  } else {
    const index = int(raw.caseIndex, 0, CASES.length - 1);
    if (index < 0 || index >= CASES.length) throw Object.assign(new Error('Неизвестный кейс.'), { statusCode: 400 });
    caseObj = CASES[index]; qty = int(raw.qty, 1, 10); cost = caseObj.price * qty;
  }
  if (p.balance < cost) throw Object.assign(new Error('Недостаточно средств.'), { statusCode: 409, state: stateFor(p) });
  if (p.inv.length + qty > MAX_INVENTORY) throw Object.assign(new Error('Инвентарь заполнен.'), { statusCode: 409 });
  p.balance -= cost;
  p.stats.opened += qty; p.stats.spent += cost;
  const opened = [];
  for (let i = 0; i < qty; i++) opened.push(newInventoryEntry(p, randomItem(caseObj)));
  const wonItems = opened.map(e => ITEM_BY_ID.get(e.id));
  const total = wonItems.reduce((sum, item) => sum + item.price, 0);
  if (!isDaily) {
    if (total < cost) { p.stats.lost += cost - total; p.stats.losses += 1; }
    else if (total > cost) p.stats.wins += 1;
  }
  p.stats.best = Math.max(p.stats.best, ...wonItems.map(item => item.price));
  syncSeen(p, opened); addDrops(p, caseObj, opened); touch(p); saveData();
  return { ok: true, state: stateFor(p), items: opened, cost, total, case: { name: caseObj.name, price: caseObj.price, daily: isDaily } };
}
function sellItems(p, raw) {
  if (!Array.isArray(raw.uids) || raw.uids.length < 1 || raw.uids.length > MAX_INVENTORY) throw Object.assign(new Error('Передай предметы для продажи.'), { statusCode: 400 });
  const uids = [...new Set(raw.uids.map(v => int(v, 1)))];
  if (uids.length !== raw.uids.length) throw Object.assign(new Error('В списке есть повторяющиеся предметы.'), { statusCode: 400 });
  const wanted = new Set(uids), entries = p.inv.filter(e => wanted.has(e.uid));
  if (entries.length !== wanted.size) throw Object.assign(new Error('Некоторые предметы уже отсутствуют в инвентаре. Обнови страницу.'), { statusCode: 409, state: stateFor(p) });
  const sum = entries.reduce((n, e) => n + ITEM_BY_ID.get(e.id).price, 0);
  p.inv = p.inv.filter(e => !wanted.has(e.uid)); p.balance += sum;
  p.stats.earned += sum; p.stats.soldItems += entries.length; p.stats.soldValue += sum;
  touch(p); saveData();
  return { ok: true, state: stateFor(p), sold: entries.length, amount: sum };
}
function upgradeOdds(stake, targetPrice) {
  const points = [{ m: 1.5, c: .75 }, { m: 2, c: .5 }, { m: 3, c: .3 }, { m: 10, c: .1 }];
  const multiple = targetPrice / stake;
  if (multiple < points[0].m || multiple > points[points.length - 1].m) return 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (multiple <= b.m) return a.c + ((multiple - a.m) / (b.m - a.m)) * (b.c - a.c);
  }
  return points[points.length - 1].c;
}
function upgrade(p, raw) {
  if (!Array.isArray(raw.uids) || raw.uids.length < 1 || raw.uids.length > MAX_INVENTORY) throw Object.assign(new Error('Выбери предметы для ставки.'), { statusCode: 400 });
  const uids = [...new Set(raw.uids.map(v => int(v, 1)))];
  if (uids.length !== raw.uids.length) throw Object.assign(new Error('В ставке есть повторяющиеся предметы.'), { statusCode: 400 });
  const wanted = new Set(uids), entries = p.inv.filter(e => wanted.has(e.uid));
  if (entries.length !== wanted.size) throw Object.assign(new Error('Предметы ставки изменились. Обнови страницу.'), { statusCode: 409, state: stateFor(p) });
  const cash = int(raw.cash, 0, 1_000_000_000_000);
  if (cash > p.balance) throw Object.assign(new Error('Недостаточно денег для доплаты.'), { statusCode: 409 });
  const itemValue = entries.reduce((s, e) => s + ITEM_BY_ID.get(e.id).price, 0);
  const stake = itemValue + cash;
  if (stake <= 0) throw Object.assign(new Error('Ставка должна быть больше нуля.'), { statusCode: 400 });
  const targetId = int(raw.targetId, 0, ITEMS.length - 1), target = ITEM_BY_ID.get(targetId);
  if (!target) throw Object.assign(new Error('Неизвестная цель.'), { statusCode: 400 });
  if (raw.family && raw.family !== 'all') {
    const familyIndex = CATALOG.families.findIndex(f => f.k === raw.family);
    if (familyIndex < 0 || familyIndex !== target.fam) throw Object.assign(new Error('Цель не соответствует выбранному типу.'), { statusCode: 400 });
  }
  const chance = upgradeOdds(stake, target.price);
  if (!chance) throw Object.assign(new Error('Цель должна стоить от 1,5× до 10× общей ставки.'), { statusCode: 400 });
  const win = crypto.randomInt(0, 1_000_000) < Math.floor(chance * 1_000_000);
  p.balance -= cash; p.inv = p.inv.filter(e => !wanted.has(e.uid)); p.stats.upgrades += 1;
  let cashback = 0, awarded = null;
  if (win) {
    if (p.inv.length >= MAX_INVENTORY) throw Object.assign(new Error('Инвентарь заполнен.'), { statusCode: 409 });
    awarded = newInventoryEntry(p, target); p.stats.best = Math.max(p.stats.best, target.price);
    p.stats.upgradeWins += 1; p.stats.wins += 1; syncSeen(p, [awarded]);
  } else {
    cashback = Math.floor(stake * .25); p.balance += cashback;
    p.stats.earned += cashback; p.stats.lost += Math.max(0, stake - cashback);
    p.stats.losses += 1; p.stats.upgradeLosses += 1;
  }
  touch(p); saveData();
  return { ok: true, state: stateFor(p), win, chance, cashback, stake, target: { ...target }, awarded };
}
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Player-Token', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
function rateLimited(req) {
  const now = Date.now(), key = req.socket.remoteAddress || 'unknown';
  const r = requests.get(key) || { start: now, count: 0 };
  if (now - r.start > 60_000) { r.start = now; r.count = 0; }
  r.count++; requests.set(key, r); return r.count > 240;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) { reject(Object.assign(new Error('Запрос слишком большой.'), { statusCode: 413 })); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(Object.assign(new Error('Некорректный JSON.'), { statusCode: 400 })); } });
    req.on('error', reject);
  });
}
function sendError(res, error) {
  const code = error.statusCode || 400;
  return send(res, code, { error: error.message || 'Ошибка операции.', ...(error.state ? { state: error.state } : {}) });
}
loadData();
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Player-Token', 'Access-Control-Max-Age': '86400' }); return res.end();
  }
  if (rateLimited(req)) return send(res, 429, { error: 'Слишком много запросов. Попробуй через минуту.' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, players: players.size, drops: drops.length, economyVersion: ECONOMY_VERSION });
  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    const category = url.searchParams.get('category') || 'earned';
    if (!['earned', 'ads', 'lost', 'wins', 'balance'].includes(category)) return send(res, 400, { error: 'Неизвестный рейтинг.' });
    const metric = p => category === 'balance' ? int(p.balance) : int(p.stats[category]);
    const entries = [...players.values()].sort((a, b) => (metric(b) - metric(a)) || (b.updatedAt - a.updatedAt))
      .slice(0, 50).map(p => ({ id: p.id, name: p.name, balance: p.balance, earned: p.stats.earned, ads: p.stats.ads, lost: p.stats.lost, wins: p.stats.wins, updatedAt: p.updatedAt }));
    return send(res, 200, { category, entries, total: players.size });
  }
  if (req.method === 'GET' && (url.pathname === '/api/drops' || url.pathname === '/api/drops/weekly')) {
    if (url.pathname.endsWith('/weekly')) {
      const cutoff = Date.now() - 7 * 86400000, recent = drops.filter(d => d.createdAt >= cutoff);
      const best = recent.reduce((winner, d) => !winner || d.price > winner.price ? d : winner, null);
      return send(res, 200, { best, period: '7d', total: recent.length });
    }
    const requested = Number.parseInt(url.searchParams.get('limit') || '60', 10), limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, requested)) : 60;
    return send(res, 200, { entries: drops.slice(0, limit), total: drops.length });
  }
  if (req.method === 'POST' && url.pathname === '/api/state') {
    try { const raw = await readJson(req), p = getPlayer(req, raw, true); touch(p); saveData(); return send(res, 200, { ok: true, state: stateFor(p) }); }
    catch (error) { return sendError(res, error); }
  }
  if (req.method === 'POST' && url.pathname === '/api/profile') {
    try { const raw = await readJson(req), p = getPlayer(req, raw, false); p.name = safeName(raw.name || p.name); touch(p); saveData(); return send(res, 200, { ok: true, profile: { id: p.id, name: p.name } }); }
    catch (error) { return sendError(res, error); }
  }
  if (req.method === 'POST' && url.pathname === '/api/economy/open') {
    try { const raw = await readJson(req), p = getPlayer(req, raw, false); return send(res, 200, openCase(p, raw)); }
    catch (error) { return sendError(res, error); }
  }
  if (req.method === 'POST' && url.pathname === '/api/economy/sell') {
    try { const raw = await readJson(req), p = getPlayer(req, raw, false); return send(res, 200, sellItems(p, raw)); }
    catch (error) { return sendError(res, error); }
  }
  if (req.method === 'POST' && url.pathname === '/api/economy/upgrade') {
    try { const raw = await readJson(req), p = getPlayer(req, raw, false); return send(res, 200, upgrade(p, raw)); }
    catch (error) { return sendError(res, error); }
  }
  // Client-made feed entries are blocked. The server publishes only confirmed drops from openCase().
  if (req.method === 'POST' && url.pathname === '/api/drops') return send(res, 405, { error: 'Лента обновляется только после серверного дропа.' });
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(html);
    } catch { return send(res, 500, { error: 'Не найден index.html рядом с server.js.' }); }
  }
  return send(res, 404, { error: 'Not found.' });
});
server.listen(PORT, HOST, () => {
  console.log(`Кейс Арена запущена на ${HOST}:${PORT}`);
  console.log(`Профилей экономики: ${players.size}; подтверждённых дропов: ${drops.length}`);
});
function shutdown() { saveData(); saveDrops(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
