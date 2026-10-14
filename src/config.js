// Runtime configuration. Everything comes from environment variables (optionally a local
// .env file); nothing secret is ever exported to the browser. See .env.example.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_NAME = 'Owed';
export const VERSION = '1.0.0';

// PayPal sandbox only. This app never talks to the live PayPal API: the base URL is
// pinned to the sandbox host (or a localhost stub for tests).
export const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

// Minimal .env loader (no dependency). Existing process env always wins.
export function loadDotEnv(file = path.join(ROOT, '.env'), target = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in target)) target[key] = val;
  }
  return true;
}

export function sandboxBaseUrl(value) {
  const v = String(value || '').trim().replace(/\/+$/, '');
  if (!v) return PAYPAL_SANDBOX_BASE;
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error('PAYPAL_BASE_URL is not a valid URL');
  }
  const host = u.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (!local && !/(^|\.)sandbox\.paypal\.com$/.test(host)) {
    throw new Error('PAYPAL_BASE_URL must be the PayPal sandbox (api-m.sandbox.paypal.com). Owed never uses live PayPal.');
  }
  return v;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function resolveConfig(env = process.env) {
  const forceMock = env.OWED_MOCK === '1';
  const clientId = String(env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(env.PAYPAL_CLIENT_SECRET || '').trim();
  const paypalMode = !forceMock && clientId && clientSecret ? 'sandbox' : 'mock';

  const llmBase = String(env.LLM_BASE_URL || '').trim().replace(/\/+$/, '');
  const llmModel = String(env.LLM_MODEL || '').trim();
  const llmKey = String(env.LLM_API_KEY || '').trim();
  const llmMode = !forceMock && llmBase && llmModel ? 'live' : 'mock';

  const invoicerName = String(env.INVOICER_NAME || 'Sam Rivera').trim();
  const [given, ...rest] = invoicerName.split(/\s+/);

  return {
    appName: APP_NAME,
    version: VERSION,
    port: num(env.PORT, 3000),
    host: env.HOST || (env.RENDER ? '0.0.0.0' : '127.0.0.1'),
    paypal: {
      mode: paypalMode,
      baseUrl: paypalMode === 'sandbox' ? sandboxBaseUrl(env.PAYPAL_BASE_URL) : PAYPAL_SANDBOX_BASE,
      clientId,
      clientSecret,
      webhookId: String(env.PAYPAL_WEBHOOK_ID || '').trim(),
    },
    llm: {
      mode: llmMode,
      baseUrl: llmBase,
      model: llmModel || 'owed-demo-model',
      apiKey: llmKey,
      timeoutMs: num(env.LLM_TIMEOUT_MS, 25000),
      attempts: num(env.LLM_ATTEMPTS, 4),
      retryDelayMs: num(env.LLM_RETRY_DELAY_MS, 700),
      reasoningEffort: String(env.LLM_REASONING_EFFORT || '').trim(),
      cooldownMs: num(env.LLM_COOLDOWN_MS, 60000),
    },
    invoicer: {
      name: invoicerName,
      givenName: given || 'Sam',
      surname: rest.join(' '),
      businessName: String(env.INVOICER_BUSINESS || 'Rivera Studio').trim(),
      email: String(env.INVOICER_EMAIL || '').trim(),
    },
    currency: String(env.DEFAULT_CURRENCY || 'USD').trim().toUpperCase(),
    pollSeconds: Math.max(0, num(env.POLL_INTERVAL_SECONDS, 60)),
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(ROOT, 'data'),
    persist: env.OWED_PERSIST !== '0',
    rateLimitPerMinute: Math.max(1, num(env.RATE_LIMIT_PER_MINUTE, 60)),
    demo: paypalMode === 'mock' || llmMode === 'mock',
    // Values that must never appear in a response, a stream or a log line.
    secrets: [clientId, clientSecret, llmKey].filter((s) => s && s.length >= 4),
  };
}

// The browser-safe view of the configuration.
export function publicMode(config) {
  return {
    paypal: config.paypal.mode,
    llm: config.llm.mode,
    demo: config.demo,
    model: config.llm.mode === 'live' ? config.llm.model : 'deterministic demo model',
  };
}
