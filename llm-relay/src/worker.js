// owed-llm: a minimal OpenAI-compatible /v1/chat/completions endpoint over Workers AI.
// Owed's llm.js speaks the OpenAI chat format to any provider; this Worker lets it use the
// Cloudflare account's own Workers AI models, so a demo run never depends on a free tier's
// per-minute quota elsewhere. Access needs a bearer token equal to the RELAY_TOKEN secret.

export const MODELS = {
  'llama-3.3-70b': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'llama-3.1-8b': '@cf/meta/llama-3.1-8b-instruct-fast',
};
export const DEFAULT_MODEL = 'llama-3.3-70b';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const err = (status, message) => json({ error: { message, type: 'relay_error' } }, status);

export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Accepts our short names or a full @cf/ id that is on the list; anything else is refused
// rather than silently swapped, so the trace in Owed names the model that really answered.
export function resolveModel(name) {
  const n = String(name || DEFAULT_MODEL).trim();
  if (MODELS[n]) return { name: n, id: MODELS[n] };
  const hit = Object.entries(MODELS).find(([, id]) => id === n);
  return hit ? { name: hit[0], id: hit[1] } : null;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (request.method === 'GET' && (path === '' || path === '/health')) return json({ ok: true, models: Object.keys(MODELS) });

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.RELAY_TOKEN || !sameToken(token, env.RELAY_TOKEN)) return err(401, 'missing or wrong bearer token');

  if (request.method === 'GET' && path === '/v1/models') {
    return json({ object: 'list', data: Object.keys(MODELS).map(id => ({ id, object: 'model', owned_by: 'workers-ai' })) });
  }
  if (path !== '/v1/chat/completions') return err(404, 'not found');
  if (request.method !== 'POST') return err(405, 'POST only');

  let body;
  try { body = await request.json(); } catch { return err(400, 'body is not JSON'); }
  const model = resolveModel(body.model);
  if (!model) return err(400, `unknown model ${JSON.stringify(body.model)}; use one of ${Object.keys(MODELS).join(', ')}`);
  const messages = Array.isArray(body.messages)
    ? body.messages.filter(m => m && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content }))
    : [];
  if (!messages.length) return err(400, 'messages must be a non-empty array of {role, content}');

  const maxTokens = Math.min(Math.max(1, Number(body.max_tokens) || 700), 2048);
  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2;

  let out;
  try {
    out = await env.AI.run(model.id, { messages, max_tokens: maxTokens, temperature });
  } catch (e) {
    // Workers AI capacity errors are worth a retry on Owed's side, so say 503, not 500.
    return err(503, `workers ai: ${String(e && e.message || e).slice(0, 200)}`);
  }
  const resp = out && out.response;
  const content = typeof resp === 'string' ? resp : resp == null ? '' : JSON.stringify(resp);
  return json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model.name,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: out && out.usage ? out.usage : null,
  });
}

export default { fetch: (request, env) => handle(request, env) };
