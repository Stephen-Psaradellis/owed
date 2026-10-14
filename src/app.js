// Wiring and HTTP routes. No framework: node:http, JSON in and out, Server-Sent Events
// for the live trace. createApp() is what the tests drive; server.js only listens.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveConfig, publicMode, ROOT } from './config.js';
import { createRedactor } from './redact.js';
import { createBus } from './bus.js';
import { createLLM } from './llm.js';
import { createPayPalClient } from './paypal.js';
import { createMockPayPal } from './mock/paypal-mock.js';
import { createStore } from './ledger.js';
import { createAgent, AgentError } from './agent.js';
import { SAMPLE_PROMPTS } from './demo.js';

const PUBLIC = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://bryntum.com; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function createApp({ env = process.env, now = () => Date.now(), fetchImpl = globalThis.fetch, logger = console } = {}) {
  const config = resolveConfig(env);
  const { redact, redactString } = createRedactor(config.secrets);
  const log = (...args) => logger.log(...args.map((a) => (typeof a === 'string' ? redactString(a) : redact(a))));
  const bus = createBus({ redact });

  const dataFile = (name) => (config.persist ? path.join(config.dataDir, name) : null);
  let mock = null;
  let paypalFetch = fetchImpl;
  const mockFile = dataFile('paypal-mock.json');
  if (config.paypal.mode === 'mock') {
    let state;
    try {
      state = mockFile ? JSON.parse(fs.readFileSync(mockFile, 'utf8')) : undefined;
    } catch {
      state = undefined;
    }
    mock = createMockPayPal({ now, state });
    paypalFetch = mock.fetch;
  }
  const paypal = createPayPalClient({
    baseUrl: config.paypal.baseUrl,
    clientId: config.paypal.mode === 'mock' ? 'demo-client-id' : config.paypal.clientId,
    clientSecret: config.paypal.mode === 'mock' ? 'demo-client-secret' : config.paypal.clientSecret,
    fetchImpl: paypalFetch,
    trace: (e) => bus.trace(e),
    now,
  });
  const llm = createLLM({ config, trace: (e) => bus.trace(e), fetchImpl });
  const store = createStore({ file: dataFile('ledger.json') });
  const agent = createAgent({ config, paypal, llm, store, bus, now, mock });

  let mockTimer = null;
  if (mock && mockFile) {
    bus.on('ledger', () => {
      clearTimeout(mockTimer);
      mockTimer = setTimeout(() => {
        fs.mkdirSync(path.dirname(mockFile), { recursive: true });
        fs.writeFileSync(mockFile + '.tmp', JSON.stringify(mock.state));
        fs.renameSync(mockFile + '.tmp', mockFile);
      }, 100);
      if (mockTimer.unref) mockTimer.unref();
    });
  }

  // ---------- rate limiting (mutating requests, per IP) ----------
  const hits = new Map();
  const limited = (ip) => {
    const minute = Math.floor(now() / 60000);
    const k = `${ip}:${minute}`;
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (hits.size > 5000) for (const key of hits.keys()) if (!key.endsWith(`:${minute}`)) hits.delete(key);
    return n > config.rateLimitPerMinute;
  };

  // ---------- helpers ----------
  const send = (res, status, body, headers = {}) => {
    const text = JSON.stringify(redact(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(text);
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024) req.destroy(); // abusive: drop the connection
        else if (size <= 64 * 1024) chunks.push(c);
      });
      req.on('end', () => {
        if (size > 64 * 1024) return reject(new AgentError('Request body too large (64 KB max)', 413));
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new AgentError('Body must be JSON', 400));
        }
      });
      req.on('error', reject);
    });

  // ---------- static files ----------
  const gzCache = new Map();
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
    let stat;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      return send(res, 404, { error: 'Not found' });
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', ...SECURITY_HEADERS, 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }
    if (gzip) {
      const key = `${file}:${stat.mtimeMs}`;
      let buf = gzCache.get(key);
      if (!buf) {
        buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
        gzCache.set(key, buf);
      }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': buf.length, Vary: 'Accept-Encoding' });
      return res.end(buf);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  }

  // ---------- SSE ----------
  function stream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('hello', { mode: publicMode(config), recent: bus.recent() });
    const offs = [bus.on('trace', (e) => write('trace', e)), bus.on('ledger', (e) => write('ledger', e)), bus.on('clear', () => write('clear', {}))];
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      offs.forEach((off) => off());
    });
  }

  // ---------- routes ----------
  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;
    if (!p.startsWith('/api/')) {
      if (m !== 'GET' && m !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, p);
    }
    if (m !== 'GET' && m !== 'HEAD') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (limited(ip)) return send(res, 429, { error: 'Too many requests; slow down a little.' }, { 'Retry-After': '30' });
    }
    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, app: config.appName, version: config.version, mode: publicMode(config), today: agent.today(), samples: SAMPLE_PROMPTS, pollSeconds: config.pollSeconds });
    if (m === 'GET' && p === '/api/ledger') return send(res, 200, agent.ledger());
    if (m === 'GET' && p === '/api/timeline') return send(res, 200, agent.timeline());
    if (m === 'GET' && p === '/api/trace') return send(res, 200, { events: bus.recent() });
    if (m === 'GET' && p === '/api/stream') return stream(req, res);
    if (m === 'POST' && p === '/api/chat') {
      const b = await readJson(req);
      return send(res, 200, await agent.chat(b.message, { autoSend: b.autoSend === true }));
    }
    if (m === 'POST' && p === '/api/invoices/preview') return send(res, 200, await agent.preview((await readJson(req)).text));
    if (m === 'POST' && p === '/api/invoices') {
      const b = await readJson(req);
      return send(res, 201, await agent.createInvoice({ text: b.text, previewId: b.previewId }));
    }
    let r = p.match(/^\/api\/invoices\/([\w-]+)\/(remind|mark-paid|simulate-payment)$/);
    if (m === 'POST' && r) {
      const b = await readJson(req);
      if (r[2] === 'remind') return send(res, 200, await agent.remindNow(r[1]));
      if (r[2] === 'mark-paid') return send(res, 200, await agent.markPaid(r[1], { method: b.method }));
      return send(res, 200, await agent.simulatePayment(r[1]));
    }
    r = p.match(/^\/api\/reminders\/([\w-]+)$/);
    if (m === 'PATCH' && r) return send(res, 200, await agent.reschedule(r[1], (await readJson(req)).date));
    if (m === 'POST' && p === '/api/agent/tick') return send(res, 200, await agent.tick());
    if (m === 'POST' && p === '/api/demo/seed') return send(res, 200, await agent.seedDemo());
    if (m === 'POST' && p === '/api/demo/reset') {
      await agent.reset();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/webhooks/paypal') return send(res, 200, await agent.handleWebhook(await readJson(req), req.headers));
    return send(res, 404, { error: 'Not found' });
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof AgentError) return send(res, err.status, { error: err.message, ...(err.missing ? { missing: err.missing } : {}) });
      log('[owed] error:', err && err.stack ? err.stack : String(err));
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong on our side. The trace has details.' });
    }
  }

  // ---------- background status checks ----------
  let poller = null;
  function startPolling() {
    if (!config.pollSeconds) return;
    poller = setInterval(() => {
      if (!store.doc.invoices.some((i) => i.status !== 'DRAFT' && !['PAID', 'MARKED_AS_PAID', 'CANCELLED'].includes(i.status))) return;
      agent.tick({ reason: 'auto' }).catch((e) => log('[owed] poll failed:', e.message));
    }, config.pollSeconds * 1000);
    if (poller.unref) poller.unref();
  }

  return {
    config,
    agent,
    bus,
    mock,
    handler,
    startPolling,
    log,
    close() {
      clearInterval(poller);
      store.flush();
    },
  };
}
