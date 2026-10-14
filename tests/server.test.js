// HTTP surface: static files, headers, the SSE stream, input limits and rate limiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { makeApp, startServer, call, readSSE } from './helpers.js';

async function withServer(env, fn) {
  const { app } = makeApp({ env });
  const srv = await startServer(app);
  try {
    await fn(srv.url, app);
  } finally {
    await srv.close();
  }
}

test('serves the dashboard with security headers and a demo-mode health report', async () => {
  await withServer({}, async (url) => {
    const page = await call(url + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.text, /<title>Owed<\/title>/);
    assert.match(page.text, /id="demo-banner"/);
    assert.match(page.text, /\/build\/timeline\.js/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const h = await call(url + '/api/health');
    assert.deepEqual(h.json.mode, { paypal: 'mock', llm: 'mock', demo: true, model: 'deterministic demo model' });
    assert.ok(Array.isArray(h.json.samples));
    for (const f of ['/app.js', '/styles.css', '/theme.js', '/favicon.svg']) assert.equal((await call(url + f)).status, 200, f);
  });
});

test('the Bryntum bundle and themes are served when built', { skip: !fs.existsSync(path.join(ROOT, 'public', 'build', 'timeline.js')) && 'run npm run build first' }, async () => {
  await withServer({}, async (url) => {
    const js = await fetch(url + '/build/timeline.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const body = await js.text();
    assert.ok(body.length > 500000, 'bundle contains the scheduler');
    assert.match(body, /OwedTimeline/);
    for (const css of ['/build/bryntum-light.css', '/build/bryntum-dark.css']) {
      const r = await call(url + css);
      assert.equal(r.status, 200);
      assert.match(r.text, /\.b-sch|b-scheduler|b-grid/);
    }
  });
});

test('path traversal and unknown routes are refused', async () => {
  await withServer({}, async (url) => {
    assert.equal((await call(url + '/..%2f..%2fpackage.json')).status, 403);
    assert.equal((await call(url + '/nope.html')).status, 404);
    assert.equal((await call(url + '/api/nope')).status, 404);
    assert.equal((await call(url + '/', 'POST', {})).status, 405);
  });
});

test('bad input: invalid JSON, oversized body, empty brief, unknown invoice', async () => {
  await withServer({}, async (url) => {
    assert.equal((await call(url + '/api/chat', 'POST', '{nope')).status, 400);
    assert.equal((await call(url + '/api/chat', 'POST', { message: 'x'.repeat(70 * 1024) })).status, 413);
    const empty = await call(url + '/api/invoices', 'POST', { text: '  ' });
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /Paste a brief/);
    const missing = await call(url + '/api/invoices', 'POST', { text: 'logo, $300' });
    assert.equal(missing.status, 422);
    assert.deepEqual(missing.json.missing, ['client email', 'client name']);
    assert.equal((await call(url + '/api/invoices/inv_99/remind', 'POST')).status, 404);
    assert.equal((await call(url + '/api/reminders/x', 'PATCH', { date: '2026-10-20' })).status, 404);
  });
});

test('mutating requests are rate limited per client', async () => {
  await withServer({ RATE_LIMIT_PER_MINUTE: '3' }, async (url) => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call(url + '/api/agent/tick', 'POST')).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await call(url + '/api/ledger')).status, 200, 'reads are not limited');
  });
});

test('the SSE stream says hello with the mode and replays recent trace events', async () => {
  await withServer({}, async (url) => {
    await call(url + '/api/demo/seed', 'POST');
    const s = await readSSE(url + '/api/stream', 300);
    assert.equal(s.status, 200);
    assert.match(s.type, /text\/event-stream/);
    assert.match(s.text, /event: hello/);
    const hello = JSON.parse(s.text.split('\n').find((l) => l.startsWith('data: ')).slice(6));
    assert.equal(hello.mode.paypal, 'mock');
    assert.ok(hello.recent.some((e) => e.kind === 'paypal' && e.tool === 'create_invoice' && e.status === 201));
    assert.ok(hello.recent.some((e) => e.kind === 'step' && e.name === 'Plan follow-ups' && e.status === 'ok'));
  });
});

test('full demo over HTTP: seed, ledger, timeline, reschedule, simulate payment, answer', async () => {
  await withServer({}, async (url) => {
    const seed = await call(url + '/api/demo/seed', 'POST');
    assert.equal(seed.json.created, 4);
    const ledger = (await call(url + '/api/ledger')).json;
    assert.equal(ledger.invoices.length, 4);
    const acme = ledger.invoices.find((i) => i.client.name === 'Acme Outfitters');
    const tl = (await call(url + '/api/timeline')).json;
    assert.equal(tl.resources.length, 4);
    const rem = tl.events.find((e) => e.kind === 'reminder' && e.resourceId === acme.id && e.draggable);
    const moved = await call(url + `/api/reminders/${rem.id}`, 'PATCH', { date: '2026-10-27' });
    assert.equal(moved.status, 200, moved.text);
    const bad = await call(url + `/api/reminders/${rem.id}`, 'PATCH', { date: '2020-01-01' });
    assert.equal(bad.status, 422);
    const paid = await call(url + `/api/invoices/${acme.id}/simulate-payment`, 'POST');
    assert.equal(paid.json.status, 'PAID');
    const ans = await call(url + '/api/chat', 'POST', { message: 'Who owes me what?' });
    assert.equal(ans.json.type, 'answer');
    assert.match(ans.json.text, /\$6,900/);
    const reset = await call(url + '/api/demo/reset', 'POST');
    assert.equal(reset.status, 200);
    assert.equal((await call(url + '/api/ledger')).json.invoices.length, 0);
  });
});
