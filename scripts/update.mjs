// ブクログ公開本棚 -> カーリル所蔵・貸出状況 -> _site/data.json
// 依存パッケージなし (Node 20+)。環境変数 CALIL_APPKEY が必須。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

const KEY = process.env.CALIL_APPKEY;
if (!KEY) { console.error('CALIL_APPKEY is not set'); process.exit(1); }
const BOOKLOG = process.env.BOOKLOG_BASE || 'https://booklog.jp';
const CALIL = process.env.CALIL_BASE || 'https://api.calil.jp';
const OUT = process.env.OUT_DIR || path.join(root, '_site');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const PREV_URL = process.env.PREV_DATA_URL || (SITE_URL ? SITE_URL + '/data.json' : '');
const POLL_MS = Number(process.env.POLL_MS ?? 2200);
const PAGE_WAIT_MS = Number(process.env.PAGE_WAIT_MS ?? 800);
const NONE_DAYS = cfg.noneRecheckDays ?? 7;
const CHUNK = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => String(s).split(KEY).join('***');

async function getText(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (booklog-library-check)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${mask(url)}`);
      return await r.text();
    } catch (e) {
      if (i >= tries) throw new Error(mask(e.message));
      await sleep(2000 * i);
    }
  }
}

const ENT = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(c) ? String.fromCodePoint(c) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

// ---- 1. ブクログ公開本棚 ----
async function fetchShelf() {
  const books = [];
  const seen = new Set();
  for (let p = 1; p <= 80; p++) {
    const html = await getText(`${BOOKLOG}/users/${encodeURIComponent(cfg.booklogUser)}?page=${p}`);
    let added = 0;
    for (const m of html.matchAll(/data-book='([^']*)'/g)) {
      let o;
      try { o = JSON.parse(decode(m[1])); } catch { continue; }
      if (!o || !o.book_id || seen.has(String(o.book_id))) continue; // ページごとのダミー要素は book_id がない
      seen.add(String(o.book_id));
      added++;
      const it = o.item || {};
      books.push({
        bookId: String(o.book_id),
        status: o.status ? String(o.status) : '0',
        title: o.title || it.title || '',
        authors: Array.isArray(it.authors) ? it.authors : [],
        ean: String(it.EAN || ''),
        asin: String(o.id || it.id || ''),
      });
    }
    console.log(`booklog page ${p}: +${added} (total ${books.length})`);
    if (!added) break;
    await sleep(PAGE_WAIT_MS);
  }
  return books;
}

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
const isOk = (avail) => Array.isArray(avail) && avail.length >= cfg.systems.length && avail.every((a) => a.status === 'OK');
const isNone = (avail) => isOk(avail) && avail.every((a) => a.libs.length === 0);
const ageDays = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

async function loadPrev() {
  const map = new Map();
  let shelfTotal = 0;
  if (!PREV_URL) return { map, shelfTotal };
  try {
    const r = await fetch(PREV_URL + (PREV_URL.includes('?') ? '&' : '?') + 't=' + Date.now());
    if (!r.ok) { console.log(`previous data: none (HTTP ${r.status})`); return { map, shelfTotal }; }
    const d = await r.json();
    shelfTotal = d.shelfTotal || 0;
    for (const b of d.books || []) if (b.isbn) map.set(b.isbn, { avail: b.avail || [], checkedAt: b.checkedAt || '' });
    console.log(`previous data: ${map.size} books`);
  } catch (e) {
    console.log('previous data: unavailable (' + e.message + ')');
  }
  return { map, shelfTotal };
}

// ---- main ----
const shelf = await fetchShelf();
const prev = await loadPrev();
if (!shelf.length) throw new Error('ブクログから1冊も取得できませんでした。公開設定とbooklogUserを確認してください。');
if (prev.shelfTotal && shelf.length < prev.shelfTotal * 0.5) {
  throw new Error(`取得冊数が前回(${prev.shelfTotal})の半分未満(${shelf.length})です。公開データを上書きしません。`);
}

const targetSet = new Set(cfg.targetStatuses.map(String));
const targets = shelf.filter((b) => targetSet.has(b.status));
const hasIsbn = (b) => /^97[89]\d{10}$/.test(b.ean);
const isbns = [...new Set(targets.filter(hasIsbn).map((b) => b.ean))];

const result = new Map(); // isbn -> {avail, checkedAt, stale?}
const todo = [];
let reused = 0;
for (const isbn of isbns) {
  const p = prev.map.get(isbn);
  if (p && isNone(p.avail) && p.checkedAt && ageDays(p.checkedAt) < NONE_DAYS) {
    result.set(isbn, { avail: p.avail, checkedAt: p.checkedAt });
    reused++;
  } else todo.push(isbn);
}
console.log(`shelf ${shelf.length}, targets ${targets.length}, with ISBN ${isbns.length}, reuse(蔵書なし) ${reused}, check ${todo.length}`);

let failed = 0;
for (let i = 0; i < todo.length; i += CHUNK) {
  const chunk = todo.slice(i, i + CHUNK);
  console.log(`calil ${i + 1}-${i + chunk.length} / ${todo.length}`);
  try {
    const res = await calilCheck(chunk);
    const now = new Date().toISOString();
    for (const isbn of chunk) {
      const avail = toAvail(res[isbn]);
      if (isOk(avail)) result.set(isbn, { avail, checkedAt: now });
      else throw new Error(`incomplete response for ${isbn}`);
    }
  } catch (e) {
    console.warn('chunk failed: ' + mask(e.message));
    for (const isbn of chunk) {
      if (result.has(isbn)) continue;
      failed++;
      const p = prev.map.get(isbn);
      if (p && isOk(p.avail)) result.set(isbn, { avail: p.avail, checkedAt: p.checkedAt, stale: true });
      else result.set(isbn, { avail: [{ system: '', status: 'Error', reserveurl: '', libs: [] }], checkedAt: '', stale: true });
    }
  }
  await sleep(500);
}
// 全件失敗なら公開データを壊さないよう異常終了
if (todo.length && failed === todo.length) throw new Error('カーリルの照合がすべて失敗しました。');

const books = targets.map((b) => {
  const ok = hasIsbn(b);
  const r = ok ? result.get(b.ean) : null;
  return {
    title: b.title, authors: b.authors, isbn: ok ? b.ean : '', asin: b.asin, status: b.status, hasIsbn: ok,
    avail: r ? r.avail : [], checkedAt: r ? r.checkedAt : '', ...(r && r.stale ? { stale: true } : {}),
  };
});
const data = {
  generated: new Date().toISOString(),
  user: cfg.booklogUser,
  shelfTotal: shelf.length,
  systems: cfg.systems,
  books,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data));
fs.copyFileSync(path.join(root, 'web', 'index.html'), path.join(OUT, 'index.html'));
const held = books.filter((b) => b.avail.some((a) => a.libs.length)).length;
console.log(`done: ${books.length} books, held ${held}, failed ${failed} -> ${path.join(OUT, 'data.json')}`);
