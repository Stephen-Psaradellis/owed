// Secrets never leave the server: not in API responses, the SSE trace, error messages or
// logs. Runs the app in *sandbox* mode (real PayPal client code path) with fake
// credentials, PayPal served by the in-memory fake, and a fake LLM that even tries to
// echo its own API key back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockPayPal } from '../src/mock/paypal-mock.js';
import { sandboxBaseUrl, resolveConfig, publicMode } from '../src/config.js';
import { createRedactor } from '../src/redact.js';
import { makeApp, startServer, call, readSSE, NOW } from './helpers.js';

const CLIENT_ID = 'AeTestClientId1234567890abcdef';
const CLIENT_SECRET = 'EKtestSecretValue-0987654321-zyxw';
const LLM_KEY = 'sk-test-llm-key-5555-aaaa-bbbb';

function fakes() {
  const paypal = createMockPayPal({ now: () => NOW });
  const seen = { llmAuth: [], paypalBasic: [], llmBodies: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api-m.sandbox.paypal.com')) {
      const auth = (init.headers && init.headers.Authorization) || '';
      if (auth.startsWith('Basic ')) seen.paypalBasic.push(u);
      return paypal.fetch(url, init);
    }
    if (u.startsWith('https://llm.test/v1/chat/completions')) {
      seen.llmAuth.push(init.headers.Authorization);
      seen.llmBodies.push(String(init.body));
      // A misbehaving model that leaks the key in its output.
      return new Response(JSON.stringify({ choices: [{ message: { content: `{"client":{"name":"Leaky ${LLM_KEY}"},"note":"key ${LLM_KEY} secret ${CLIENT_SECRET}"}` } }] }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + u);
  };
  return { paypal, seen, fetchImpl };
}

const env = { PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: CLIENT_SECRET, LLM_BASE_URL: 'https://llm.test/v1', LLM_MODEL: 'test-model', LLM_API_KEY: LLM_KEY };

function assertClean(label, text, tokens = []) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  for (const s of [CLIENT_ID, CLIENT_SECRET, LLM_KEY, basic, ...tokens]) assert.ok(!String(text).includes(s), `${label} leaked ${s.slice(0, 6)}...`);
}

test('no secret in any response, stream or log across a full run', async () => {
  const { paypal, seen, fetchImpl } = fakes();
  const logs = [];
  const { app } = makeApp({ env, fetchImpl, logs });
  assert.equal(app.config.paypal.mode, 'sandbox');
  assert.equal(app.config.llm.mode, 'live');
  const srv = await startServer(app);
  const bodies = [];
  const hit = async (...a) => {
    const r = await call(srv.url + a[0], ...a.slice(1));
    bodies.push(r.text);
    return r;
  };
  try {
    await hit('/api/health');
    const seed = await hit('/api/demo/seed', 'POST');
    assert.equal(seed.status, 200, seed.text);
    await hit('/api/chat', 'POST', { message: 'Who owes me what?' });
    const pv = await hit('/api/invoices/preview', 'POST', { text: 'Logo for Pine Co, $800, net 10, kim@pine.test' });
    const created = await hit('/api/invoices', 'POST', { previewId: pv.json.previewId });
    assert.equal(created.status, 201, created.text);
    await hit(`/api/invoices/${created.json.id}/remind`, 'POST');
    await hit(`/api/invoices/${created.json.id}/mark-paid`, 'POST', { method: 'CASH' });
    await hit(`/api/invoices/${created.json.id}/simulate-payment`, 'POST');
    await hit('/api/agent/tick', 'POST');
    await hit('/api/ledger');
    await hit('/api/timeline');
    await hit('/api/trace');
    await hit('/api/webhooks/paypal', 'POST', { event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'x' } });
    await hit('/api/nope');
    const sse = await readSSE(srv.url + '/api/stream', 300);
    bodies.push(sse.text);
    const tokens = Object.keys(paypal.state.tokens);
    assert.ok(tokens.length > 0);
    for (const b of bodies) assertClean('response', b, tokens);
    assertClean('logs', logs.join('\n'), tokens);
    // the leaked key really was in the model output, and was scrubbed
    assert.ok(bodies.join('').includes('[redacted]'));
  } finally {
    await srv.close();
  }
  // Credentials went only where they belong.
  assert.ok(seen.llmAuth.length > 0 && seen.llmAuth.every((h) => h === `Bearer ${LLM_KEY}`));
  assert.ok(seen.llmBodies.every((b) => !b.includes(CLIENT_SECRET) && !b.includes(CLIENT_ID)), 'PayPal credentials never go to the LLM');
  assert.ok(seen.paypalBasic.every((u) => u.endsWith('/v1/oauth2/token')));
});

test('PayPal errors that echo a credential are redacted before reaching the browser', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/v1/oauth2/token')) return new Response(JSON.stringify({ error: 'invalid_client', error_description: `Client Authentication failed for ${CLIENT_ID} / ${CLIENT_SECRET}` }), { status: 401 });
    throw new Error('unexpected');
  };
  const logs = [];
  const { app } = makeApp({ env: { PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: CLIENT_SECRET }, fetchImpl, logs });
  const srv = await startServer(app);
  try {
    const r = await call(srv.url + '/api/invoices', 'POST', { text: 'Logo for Pine Co, $800, net 10, kim@pine.test' });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /invalid_client/);
    assertClean('error', r.text);
    assertClean('trace', (await call(srv.url + '/api/trace')).text);
    assertClean('logs', logs.join('\n'));
  } finally {
    await srv.close();
  }
});

test('health and the browser-safe mode expose no configuration secrets', () => {
  const cfg = resolveConfig(env);
  const pub = JSON.stringify(publicMode(cfg));
  assertClean('publicMode', pub);
  assert.deepEqual(Object.keys(publicMode(cfg)).sort(), ['demo', 'llm', 'model', 'paypal']);
});

test('only the PayPal sandbox is ever used', () => {
  assert.equal(sandboxBaseUrl(''), 'https://api-m.sandbox.paypal.com');
  assert.equal(sandboxBaseUrl('https://api-m.sandbox.paypal.com/'), 'https://api-m.sandbox.paypal.com');
  assert.throws(() => sandboxBaseUrl('https://api-m.paypal.com'), /sandbox/);
  assert.throws(() => sandboxBaseUrl('https://evil.example/sandbox.paypal.com'), /sandbox/);
  assert.throws(() => resolveConfig({ PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b', PAYPAL_BASE_URL: 'https://api-m.paypal.com' }), /never uses live PayPal/);
});

test('demo mode when credentials are missing or OWED_MOCK=1', () => {
  assert.equal(resolveConfig({}).paypal.mode, 'mock');
  assert.equal(resolveConfig({ PAYPAL_CLIENT_ID: 'a' }).paypal.mode, 'mock');
  assert.equal(resolveConfig({ ...env, OWED_MOCK: '1' }).paypal.mode, 'mock');
  assert.equal(resolveConfig({ ...env, OWED_MOCK: '1' }).llm.mode, 'mock');
  assert.equal(resolveConfig({}).demo, true);
});

test('redactor scrubs bearer and basic headers and access tokens', () => {
  const { redact } = createRedactor(['topsecretvalue']);
  const out = JSON.stringify(redact({ a: 'Bearer A21AAabcdefghijklmnop', b: 'Basic QWxhZGRpbjpvcGVuc2VzYW1l', c: '{"access_token":"xyz123456"}', d: 'x topsecretvalue y' }));
  assert.doesNotMatch(out, /A21AAabcdef|QWxhZGRpbjpv|xyz123456|topsecretvalue/);
});
