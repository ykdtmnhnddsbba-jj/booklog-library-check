// data/shelf.json (ブクログ本棚の書き出し) -> カーリル所蔵・貸出状況 -> _site/data.json
// ブクログはGitHubのサーバーからのアクセスをボット判定ではじくため、本棚の一覧はブラウザで書き出して
// data/shelf.json に置く(公開ページの「更新のしかた」参照)。ここでは貸出状況の取得と差分再利用だけを行う。
// 依存パッケージなし (Node 20+)。環境変数 CALIL_APPKEY が必須。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const shelfFile = process.env.SHELF_FILE || path.join(root, 'data', 'shelf.json');

const KEY = process.env.CALIL_APPKEY;
if (!KEY) { console.error('CALIL_APPKEY is not set'); process.exit(1); }
const CALIL = process.env.CALIL_BASE || 'https://api.calil.jp';
const OUT = process.env.OUT_DIR || path.join(root, '_site');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const PREV_URL = process.env.PREV_DATA_URL || (SITE_URL ? SITE_URL + '/data.json' : '');
const POLL_MS = Number(process.env.POLL_MS ?? 2200);
const NONE_DAYS = cfg.noneRecheckDays ?? 7;
const CHUNK = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => String(s).split(KEY).join('***');

async function getText(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${mask(url)}`);
      return await r.text();
    } catch (e) {
      if (i >= tries) throw new Error(mask(e.message));
      await sleep(2000 * i);
    }
  }
}

// ---- 1. 本棚の書き出し ----
const shelf = JSON.parse(fs.readFileSync(shelfFile, 'utf8'));
if (!Array.isArray(shelf.books) || !shelf.books.length) throw new Error('data/shelf.json に本がありません。');
console.log(`shelf.json: ${shelf.books.length} books (total ${shelf.total}), exported ${shelf.fetchedAt}`);

// ---- 2. カーリル ----
async function calilCheck(isbns) {
  const sys = cfg.systems.map((s) => s.id).join(',');
  const base = `${CALIL}/check?appkey=${KEY}`;
  let j = JSON.parse(await getText(`${base}&isbn=${isbns.join(',')}&systemid=${sys}&format=json&callback=no`));
  for (let n = 0; j.continue && n < 40; n++) {
    await sleep(POLL_MS);
    j = JSON.parse(await getText(`${base}&session=${j.session}&format=json&callback=no`));
  }
  if (j.continue) throw new Error('Calil did not finish in time');
  return j.books || {};
}
function toAvail(entry) {
  return Object.entries(entry || {}).map(([system, d]) => ({
    system,
    status: d.status || '',
    reserveurl: d.reserveurl || '',
    libs: Object.entries(d.libkey || {}).map(([name, state]) => ({ name, state })),
  }));
}
// カーリルは直前の問い合わせ結果を status "Cache" で返すことがある(正常な応答)
const okStatus = (st) => st === 'OK' || st === 'Cache';
const isOk = (avail) => Array.isArray(avail) && avail.length >= cfg.systems.length && avail.every((a) => okStatus(a.status));
const isNone = (avail) => isOk(avail) && avail.every((a) => a.libs.length === 0);
const ageDays = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

async function loadPrev() {
  const map = new Map();
  if (!PREV_URL) return map;
  try {
    const r = await fetch(PREV_URL + (PREV_URL.includes('?') ? '&' : '?') + 't=' + Date.now());
    if (!r.ok) { console.log(`previous data: none (HTTP ${r.status})`); return map; }
    const d = await r.json();
    for (const b of d.books || []) if (b.isbn) map.set(b.isbn, { avail: b.avail || [], checkedAt: b.checkedAt || '' });
    console.log(`previous data: ${map.size} books`);
  } catch (e) {
    console.log('previous data: unavailable (' + e.message + ')');
  }
  return map;
}

// ---- main ----
const prev = await loadPrev();
const targetSet = new Set(cfg.targetStatuses.map(String));
const targets = shelf.books.filter((b) => targetSet.has(String(b.status || '0')));
const hasIsbn = (b) => /^97[89]\d{10}$/.test(b.ean || '');
const isbns = [...new Set(targets.filter(hasIsbn).map((b) => b.ean))];

const result = new Map(); // isbn -> {avail, checkedAt, stale?}
const todo = [];
let reused = 0;
for (const isbn of isbns) {
  const p = prev.get(isbn);
  if (p && isNone(p.avail) && p.checkedAt && ageDays(p.checkedAt) < NONE_DAYS) {
    result.set(isbn, { avail: p.avail, checkedAt: p.checkedAt });
    reused++;
  } else todo.push(isbn);
}
console.log(`targets ${targets.length}, with ISBN ${isbns.length}, reuse(蔵書なし) ${reused}, check ${todo.length}`);

let failed = 0;
let shown = 0;
function fallback(isbn) {
  failed++;
  const p = prev.get(isbn);
  if (p && isOk(p.avail)) result.set(isbn, { avail: p.avail, checkedAt: p.checkedAt, stale: true });
  else result.set(isbn, { avail: [{ system: '', status: 'Error', reserveurl: '', libs: [] }], checkedAt: '', stale: true });
}
for (let i = 0; i < todo.length; i += CHUNK) {
  const chunk = todo.slice(i, i + CHUNK);
  console.log(`calil ${i + 1}-${i + chunk.length} / ${todo.length}`);
  try {
    const res = await calilCheck(chunk);
    const now = new Date().toISOString();
    for (const isbn of chunk) {
      const avail = toAvail(res[isbn]);
      if (isOk(avail)) result.set(isbn, { avail, checkedAt: now });
      else {
        if (shown++ < 3) console.warn(`incomplete response for ${isbn}: ${JSON.stringify(res[isbn])}`);
        fallback(isbn);
      }
    }
  } catch (e) {
    console.warn('chunk failed: ' + mask(e.message));
    for (const isbn of chunk) if (!result.has(isbn)) fallback(isbn);
  }
  await sleep(500);
}
// 全件失敗なら公開データを壊さないよう異常終了
if (todo.length && failed === todo.length) throw new Error('カーリルの照合がすべて失敗しました。');

const books = targets.map((b) => {
  const ok = hasIsbn(b);
  const r = ok ? result.get(b.ean) : null;
  return {
    title: b.title, authors: b.authors || [], isbn: ok ? b.ean : '', asin: b.asin || '', image: b.image || '', status: String(b.status || '0'), hasIsbn: ok,
    avail: r ? r.avail : [], checkedAt: r ? r.checkedAt : '', ...(r && r.stale ? { stale: true } : {}),
  };
});
const data = {
  generated: new Date().toISOString(),
  shelfExported: shelf.fetchedAt || '',
  user: shelf.user || cfg.booklogUser,
  shelfTotal: shelf.total || shelf.books.length,
  systems: cfg.systems,
  books,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data));
fs.copyFileSync(path.join(root, 'web', 'index.html'), path.join(OUT, 'index.html'));
const held = books.filter((b) => b.avail.some((a) => a.libs.length)).length;
console.log(`done: ${books.length} books, held ${held}, failed ${failed} -> ${path.join(OUT, 'data.json')}`);
