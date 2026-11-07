// Scheduled sync job: reads a list of search terms from an endpoint, gets the public iTunes Search API result order
// for each term and posts the result id lists back. Endpoint and key come from repository secrets.
// Logs show counts only.
const BASE = (process.env.SYNC_URL || '').replace(/\/$/, '');
const KEY = process.env.SYNC_KEY || '';
const JOB = +(process.env.JOB_ID || 0);
const LIMIT = +(process.env.LIMIT || 700);
const PAUSE = +(process.env.PAUSE_MS || 3000);
if (!BASE || !KEY) { console.error('Missing configuration'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const ids = await search(row.kw, row.country);
  if (!ids) {
    failed++; streak++;
    if (streak >= 10) { console.log('10 failures in a row, stopping.'); break; }
    await sleep(PAUSE * 3);
    continue;
  }
  streak = 0; ok++;
  batch.push({ kw: row.kw, country: row.country, ids });
  if (batch.length >= 20) { await flush(); console.log(`  ${ok} done`); }
  await sleep(PAUSE);
}
await flush();
console.log(`Finished: ${ok} ok, ${failed} failed.`);
if (JOB && !ok) await api('/api/runner/fail', { job: JOB });
if (!ok && due.rows.length) process.exit(1);
