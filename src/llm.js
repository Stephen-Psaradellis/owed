// Provider-pluggable LLM client. Any OpenAI-compatible /chat/completions endpoint works
// (OpenAI, Groq, OpenRouter, Together, Mistral, a local Ollama or LM Studio...), set by
// LLM_BASE_URL / LLM_API_KEY / LLM_MODEL. With none set, a deterministic demo model
// answers instead, and its output goes through the same parser as a real model's.
//
// Every call is traced (task, model, latency, ok) and never throws: a failed call returns
// { ok: false } and the caller uses its deterministic fallback.
import { parseJsonLoose } from './json.js';

export function createLLM({ config, trace = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const cfg = config.llm;
  let calls = 0;

  // LLM_MODEL may list fallbacks ("a,b,c"). A busy or rate-limited reply (429/5xx) is
  // retried, rotating through the list, before the caller's deterministic fallback runs:
  // free tiers return "model is experiencing high demand" often enough to matter.
  const models = String(cfg.model || '').split(',').map(s => s.trim()).filter(Boolean);
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const attempts = Math.max(1, cfg.attempts || 4);
  const retryDelayMs = cfg.retryDelayMs == null ? 700 : cfg.retryDelayMs;

  // The model that answered last is tried first next time, so a model that is down
  // for the day costs one failed attempt per process, not one per call.
  let preferred = 0;
  // When every model in the list is busy, a free tier's per-minute quota is spent: pause
  // the LLM for a while so callers fall back at once instead of each burning its retries.
  const cooldownMs = cfg.cooldownMs == null ? 60000 : cfg.cooldownMs;
  let coolUntil = 0;

  async function liveComplete({ system, user, maxTokens = 700, temperature = 0.2 }) {
    const wait = coolUntil - Date.now();
    if (wait > 0) throw new Error(`LLM paused ${Math.ceil(wait / 1000)}s more: every model was busy or rate-limited`);
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      const idx = (preferred + i) % models.length;
      const model = models[idx];
      if (i > 0 && retryDelayMs) await new Promise(r => setTimeout(r, retryDelayMs * i));
      let res, text;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            // Thinking models (Gemini 2.5+) spend the token budget thinking and can return no
            // content at all; LLM_REASONING_EFFORT=minimal keeps it short where the provider allows.
            ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        // A model that hangs is as busy as one that says so: move on to the next one.
        if (err && err.name === 'TimeoutError') { lastErr = err; continue; }
        throw err;
      }
      if (!res.ok) {
        lastErr = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 160)}`);
        if (RETRYABLE.has(res.status)) continue;
        throw lastErr;
      }
      const data = parseJsonLoose(text) || {};
      const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
      // An empty reply (a thinking model that spent its budget thinking) is worth another model.
      if (typeof content !== 'string' || !content.trim()) { lastErr = new Error('LLM response had no message content'); continue; }
      preferred = idx;
      return { content, usage: data.usage || null, model, attempts: i + 1 };
    }
    if (cooldownMs > 0) coolUntil = Date.now() + cooldownMs;
    throw lastErr;
  }

  // mock(): what the deterministic demo model "says" for this task.
  async function complete({ task, system, user, mock, maxTokens, temperature, runId }) {
    calls++;
    const t0 = Date.now();
    if (cfg.mode !== 'live') {
      const out = typeof mock === 'function' ? mock() : '';
      const content = typeof out === 'string' ? out : '```json\n' + JSON.stringify(out, null, 1) + '\n```';
      trace({ runId, kind: 'llm', task, model: 'demo model (deterministic)', ok: true, ms: Date.now() - t0 });
      return { ok: true, content, source: 'demo' };
    }
    try {
      const { content, usage, model, attempts: tries } = await liveComplete({ system, user, maxTokens, temperature });
      trace({ runId, kind: 'llm', task, model, ok: true, ms: Date.now() - t0, tokens: usage && usage.total_tokens,
        ...(tries > 1 ? { attempts: tries } : {}) });
      return { ok: true, content, source: 'llm' };
    } catch (err) {
      const error = err && err.name === 'TimeoutError' ? `timed out after ${cfg.timeoutMs} ms` : String((err && err.message) || err);
      trace({ runId, kind: 'llm', task, model: cfg.model, ok: false, ms: Date.now() - t0, error });
      return { ok: false, content: null, source: 'llm', error };
    }
  }

  async function json(opts) {
    const r = await complete(opts);
    if (!r.ok) return { ...r, data: null };
    const data = parseJsonLoose(r.content);
    return { ...r, data, ok: data !== null, error: data === null ? 'model output was not valid JSON' : undefined };
  }

  return {
    get mode() {
      return cfg.mode;
    },
    get model() {
      return cfg.mode === 'live' ? cfg.model : 'demo model';
    },
    get calls() {
      return calls;
    },
    complete,
    json,
  };
}
