// Scheduled sync job: reads a list of search terms from an endpoint and, for each term, collects public iTunes data:
//  - the result order of the iTunes Search API (up to 200 ids)
//  - for terms marked "pop": the shortest typed prefix for which the store's search suggestions contain the term
// and posts the raw data back. Endpoint and key come from repository secrets. Logs show counts only.
const BASE = (process.env.SYNC_URL || '').replace(/\/$/, '');
const KEY = process.env.SYNC_KEY || '';
const JOB = +(process.env.JOB_ID || 0);
const LIMIT = +(process.env.LIMIT || 700);
const PAUSE = +(process.env.PAUSE_MS || 3000);
const HINT_PAUSE = +(process.env.HINT_PAUSE_MS || 1500);
if (!BASE || !KEY) { console.error('Missing configuration'); process.exit(1); }

const FRONTS = { us: 143441, gb: 143444, ca: 143455, au: 143460, in: 143467, pk: 143477, ae: 143481, sa: 143479,
  de: 143443, fr: 143442, br: 143503, id: 143476, ph: 143474, tr: 143480 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const headers = { 'x-runner-key': KEY, 'content-type': 'application/json' };
const api = (path, body) => fetch(BASE + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers }).then(r => r.json());

// Up to 200 result ids for one term, or null when the API did not answer.
async function search(term, country) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&country=${country}&limit=200`;
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(1200 * i + Math.random() * 1500);
    try {
      const r = await fetch(url);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d.results)) return d.results.map(a => String(a.trackId)); }
    } catch { /* retry */ }
  }
  return null;
}

// Search suggestions for a typed prefix (cached for the whole run), or null when the endpoint did not answer.
const cache = new Map();
let hintCalls = 0;
async function suggestions(prefix, country) {
  const key = country + '|' + prefix;
  if (cache.has(key)) return cache.get(key);
  const url = 'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=' + encodeURIComponent(prefix);
  let list = null;
  for (let i = 0; i < 3 && !list; i++) {
    if (i) await sleep(2000 * i);
    try {
      const r = await fetch(url, { headers: { 'X-Apple-Store-Front': `${FRONTS[country] || 143441}-1,29` } });
      if (r.ok) list = [...(await r.text()).matchAll(/<key>term<\/key>\s*<string>([^<]*)<\/string>/g)].map(m => norm(m[1]));
    } catch { /* retry */ }
  }
  hintCalls++;
  await sleep(HINT_PAUSE);
  if (list) cache.set(key, list);
  return list;
}

// { n, pos } = first prefix length whose suggestions contain the term and its position; pos -1 = only suggested for
// the full term; null = never suggested; undefined = endpoint did not answer.
async function firstPrefix(term, country) {
  const L = term.length, maxN = Math.min(L, 14);
  for (let n = 2; n <= maxN; n++) {
    if (term[n - 1] === ' ') continue;
    const s = await suggestions(term.slice(0, n), country);
    if (!s) return undefined;
    const pos = s.indexOf(term);
    if (pos >= 0) return { n, pos };
  }
  if (maxN < L) {
    const s = await suggestions(term, country);
    if (!s) return undefined;
    if (s.includes(term)) return { n: L, pos: -1 };
  }
  return null;
}

const due = await api(JOB ? `/api/runner/job/${JOB}` : `/api/runner/due?limit=${LIMIT}`);
if (!Array.isArray(due.rows)) { console.error('No list received'); process.exit(1); }
console.log(`${JOB ? 'On-demand' : 'Scheduled'} run: ${due.rows.length} terms`);

let batch = [], ok = 0, failed = 0, streak = 0;
const flush = async () => {
  if (!batch.length) return;
  await api('/api/runner/serp', { day: due.day, job: JOB || undefined, items: batch });
  batch = [];
};
for (const row of due.rows) {
  const term = norm(row.kw);
  const item = { kw: row.kw, country: row.country };
  const ids = await search(term, row.country);
  if (ids) item.ids = ids;
  if (row.pop) { const h = await firstPrefix(term, row.country); if (h !== undefined) item.hint = h; }
  if (!ids && !('hint' in item)) {
    failed++; streak++;
    if (streak >= 10) { console.log('10 failures in a row, stopping.'); break; }
    await sleep(PAUSE * 3);
  } else { streak = 0; ok++; }
  batch.push(item);
  if (batch.length >= 10) { await flush(); console.log(`  ${ok} done`); }
  await sleep(PAUSE);
}
await flush();
console.log(`Finished: ${ok} ok, ${failed} failed, ${hintCalls} suggestion calls.`);
if (JOB && !ok) await api('/api/runner/fail', { job: JOB });
if (!ok && due.rows.length) process.exit(1);
