import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../src/llm.js';

function fakeFetch(statuses) {
  const seen = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    const status = statuses.shift();
    const text = status === 200
      ? JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } })
      : JSON.stringify({ error: { code: status, message: 'busy' } });
    return { ok: status === 200, status, text: async () => text };
  };
  return { impl, seen };
}

const cfg = (extra = {}) => ({ llm: { mode: 'live', baseUrl: 'https://llm.test/v1', model: 'a,b', apiKey: 'k',
  timeoutMs: 5000, attempts: 4, retryDelayMs: 0, cooldownMs: 0, ...extra } });

test('a busy model is retried on the next model in the list, and the trace names the one that answered', async () => {
  const traces = [];
  const { impl, seen } = fakeFetch([503, 429, 200]);
  const llm = createLLM({ config: cfg(), fetchImpl: impl, trace: (e) => traces.push(e) });
  const r = await llm.complete({ task: 't', system: 's', user: 'u' });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['a', 'b', 'a']);
  assert.equal(traces.at(-1).model, 'a');
  assert.equal(traces.at(-1).attempts, 3);
});

test('a non-retryable error fails at once, and repeated busy replies give up after the attempt cap', async () => {
  let f = fakeFetch([400, 200]);
  let r = await createLLM({ config: cfg(), fetchImpl: f.impl }).complete({ task: 't', system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.equal(f.seen.length, 1);
  f = fakeFetch([503, 503, 503, 503, 200]);
  r = await createLLM({ config: cfg(), fetchImpl: f.impl }).complete({ task: 't', system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.match(r.error, /503/);
  assert.equal(f.seen.length, 4);
});

test('a model that hangs past the timeout is skipped for the next one, not given up on', async () => {
  const seen = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    if (body.model === 'a') {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const r = await createLLM({ config: cfg(), fetchImpl: impl }).complete({ task: 't', system: 's', user: 'u' });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['a', 'b']);
});

test('the model that answered last is tried first on the next call', async () => {
  const f = fakeFetch([503, 200, 200]);
  const llm = createLLM({ config: cfg(), fetchImpl: f.impl });
  await llm.complete({ task: 't', system: 's', user: 'u' });
  await llm.complete({ task: 't', system: 's', user: 'u' });
  assert.deepEqual(f.seen, ['a', 'b', 'b']);
});

test('an empty reply moves on to the next model, and LLM_REASONING_EFFORT is sent only when set', async () => {
  const bodies = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const content = body.model === 'a' ? '' : 'ok';
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
  const r = await createLLM({ config: cfg({ reasoningEffort: 'minimal' }), fetchImpl: impl }).complete({ task: 't', system: 's', user: 'u' });
  assert.equal(r.ok, true);
  assert.equal(r.content, 'ok');
  assert.deepEqual(bodies.map(b => b.model), ['a', 'b']);
  assert.equal(bodies[0].reasoning_effort, 'minimal');
  bodies.length = 0;
  await createLLM({ config: cfg(), fetchImpl: impl }).complete({ task: 't', system: 's', user: 'u' });
  assert.equal('reasoning_effort' in bodies[0], false);
});

test('once every model is busy the LLM pauses, so the next call falls back at once without a request', async () => {
  const f = fakeFetch([429, 429, 429, 429, 200]);
  const llm = createLLM({ config: cfg({ cooldownMs: 60000 }), fetchImpl: f.impl });
  let r = await llm.complete({ task: 't', system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.equal(f.seen.length, 4);
  r = await llm.complete({ task: 't', system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.match(r.error, /paused/);
  assert.equal(f.seen.length, 4);
});
