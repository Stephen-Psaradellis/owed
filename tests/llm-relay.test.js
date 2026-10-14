import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, resolveModel, sameToken } from '../llm-relay/src/worker.js';

const env = (run = async () => ({ response: 'hi there' })) => ({ RELAY_TOKEN: 'tok-123', AI: { run } });
const req = (body, { token = 'tok-123', path = '/v1/chat/completions', method = 'POST' } = {}) =>
  new Request(`https://relay.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];

test('refuses a missing or wrong token', async () => {
  assert.equal((await handle(req({ messages: msgs }, { token: '' }), env())).status, 401);
  assert.equal((await handle(req({ messages: msgs }, { token: 'tok-124' }), env())).status, 401);
  assert.equal((await handle(req({ messages: msgs }), { AI: env().AI })).status, 401, 'no secret set = closed');
});

test('answers in OpenAI chat format with the model that ran', async () => {
  let seen;
  const res = await handle(req({ model: 'llama-3.1-8b', messages: msgs, max_tokens: 99999 }), env(async (id, input) => { seen = { id, input }; return { response: 'ok' }; }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].message.content, 'ok');
  assert.equal(data.model, 'llama-3.1-8b');
  assert.equal(seen.id, '@cf/meta/llama-3.1-8b-instruct-fast');
  assert.equal(seen.input.max_tokens, 2048, 'max_tokens is capped');
});

test('unknown model is refused, not swapped', async () => {
  assert.equal((await handle(req({ model: 'gpt-4o', messages: msgs }), env())).status, 400);
  assert.equal(resolveModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast').name, 'llama-3.3-70b');
  assert.equal(resolveModel(undefined).name, 'llama-3.3-70b');
});

test('a Workers AI failure is a retryable 503', async () => {
  const res = await handle(req({ messages: msgs }), env(async () => { throw new Error('capacity'); }));
  assert.equal(res.status, 503);
});

test('object responses are passed as JSON text', async () => {
  const res = await handle(req({ messages: msgs }), env(async () => ({ response: { a: 1 } })));
  assert.equal((await res.json()).choices[0].message.content, '{"a":1}');
});

test('token compare', () => {
  assert.ok(sameToken('abc', 'abc'));
  assert.ok(!sameToken('abc', 'abd'));
  assert.ok(!sameToken('', ''));
});
