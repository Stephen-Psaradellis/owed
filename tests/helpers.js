import http from 'node:http';
import { createApp } from '../src/app.js';

export const NOW = Date.parse('2026-10-13T15:00:00Z');
export const DAY = 86400000;

export function makeClock(start = NOW) {
  let t = start;
  return {
    now: () => t,
    set: (v) => (t = v),
    advanceDays: (n) => (t += n * DAY),
  };
}

export function makeApp({ env = {}, clock = makeClock(), fetchImpl, logs = [] } = {}) {
  const logger = { log: (...a) => logs.push(a.map(String).join(' ')) };
  const app = createApp({ env: { OWED_PERSIST: '0', POLL_INTERVAL_SECONDS: '0', ...env }, now: clock.now, fetchImpl, logger });
  return { app, clock, logs };
}

export async function startServer(app) {
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

export async function call(url, method = 'GET', body, headers = {}) {
  const res = await fetch(url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

// Read a Server-Sent Events stream for `ms` milliseconds and return the raw text.
export async function readSSE(url, ms = 300) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
  } catch {
    /* aborted */
  }
  clearTimeout(timer);
  return { status: res.status, type: res.headers.get('content-type'), text: out };
}
