// Hosted demo: the same Owed app (src/app.js) on Cloudflare Workers.
// Static files come from Workers Static Assets (../public); every /api/* request goes to
// ONE Durable Object, so the ledger, the PayPal client and the live trace stream (SSE)
// share one in-memory instance the way they do under `npm start`. The node:http handler
// is driven through a small req/res adapter instead of being rewritten.
// The LLM is this account's Workers AI, reached through the llm-relay handler in-process
// (no network hop, no shared secret to store): the relay gets a per-boot random token.
import { Readable } from 'node:stream';
import { DurableObject } from 'cloudflare:workers';
import { createApp } from '../src/app.js';
import { handle as relay } from '../llm-relay/src/worker.js';

const RELAY_BASE = 'https://owed-llm.internal/v1';

export function toNodeReq(request, body) {
  const url = new URL(request.url);
  const req = Readable.from(body && body.length ? [body] : []);
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v]));
  req.socket = { remoteAddress: request.headers.get('cf-connecting-ip') || 'unknown' };
  return req;
}

// A node ServerResponse look-alike that resolves to a streaming Response at writeHead.
export function toNodeRes(req) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let resolve;
  const response = new Promise((r) => (resolve = r));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    req.emit('close');
  };
  const res = {
    statusCode: 200,
    headersSent: false,
    response,
    writeHead(status, headers = {}) {
      if (res.headersSent) return res;
      res.statusCode = status;
      res.headersSent = true;
      const h = new Headers();
      for (const [k, v] of Object.entries(headers)) {
        if (!['content-length', 'connection'].includes(k.toLowerCase())) h.set(k, String(v));
      }
      const empty = status === 204 || status === 304 || req.method === 'HEAD';
      resolve(new Response(empty ? null : readable, { status, headers: h }));
      return res;
    },
    write(chunk) {
      if (closed) return false;
      if (!res.headersSent) res.writeHead(res.statusCode);
      writer.write(typeof chunk === 'string' ? enc.encode(chunk) : chunk).catch(close);
      return true;
    },
    end(chunk) {
      if (!res.headersSent) res.writeHead(res.statusCode);
      if (chunk != null && !closed) writer.write(typeof chunk === 'string' ? enc.encode(chunk) : chunk).catch(close);
      writer.close().catch(() => {});
      closed = true;
    },
  };
  return res;
}

export class OwedDemo extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const token = crypto.randomUUID();
    const relayEnv = { AI: env.AI, RELAY_TOKEN: token };
    const fetchImpl = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith(RELAY_BASE)) return relay(new Request(url, init), relayEnv);
      return fetch(input, init);
    };
    const appEnv = {
      PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
      LLM_BASE_URL: env.AI ? RELAY_BASE : '',
      LLM_MODEL: env.LLM_MODEL || 'llama-3.3-70b,llama-3.1-8b',
      LLM_API_KEY: token,
      LLM_TIMEOUT_MS: env.LLM_TIMEOUT_MS || '20000',
      INVOICER_NAME: env.INVOICER_NAME || 'Sam Rivera',
      INVOICER_BUSINESS: env.INVOICER_BUSINESS || 'Rivera Studio',
      POLL_INTERVAL_SECONDS: env.POLL_INTERVAL_SECONDS || '60',
      RATE_LIMIT_PER_MINUTE: env.RATE_LIMIT_PER_MINUTE || '30',
      OWED_PERSIST: '0',
    };
    this.app = createApp({ env: appEnv, fetchImpl });
    this.app.startPolling();
  }

  async fetch(request) {
    const body = ['GET', 'HEAD'].includes(request.method) ? null : new Uint8Array(await request.arrayBuffer());
    const req = toNodeReq(request, body);
    const res = toNodeRes(req);
    request.signal?.addEventListener('abort', () => req.emit('close'));
    this.app.handler(req, res);
    return res.response;
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return env.OWED.get(env.OWED.idFromName('demo')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
