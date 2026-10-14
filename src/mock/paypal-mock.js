// An in-memory fake of the PayPal endpoints Owed uses, exposed as a fetch() function so
// the real client in paypal.js runs unchanged against it. It follows PayPal's Invoicing
// v2 contract for those endpoints: OAuth token, create draft (201, full representation
// with Prefer: return=representation, a self link otherwise), send (200 with the payer
// link), get, list (paged), remind (204), record payment, PayPal-style error bodies
// (name / message / debug_id / details[].issue) and status rules such as "a paid invoice
// cannot be reminded". Demo mode only; nothing here talks to the network.
import { randomBytes, randomUUID } from 'node:crypto';
import { toISODate } from '../dates.js';

const BASE = 'https://api-m.sandbox.paypal.com';
const WEB = 'https://www.sandbox.paypal.com';
const OPEN = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID']);
const TERM_DAYS = { NET_10: 10, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60, NET_90: 90 };
const METHODS = new Set(['BANK_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD', 'DEBIT_CARD', 'PAYPAL', 'WIRE_TRANSFER', 'OTHER']);

const alnum = (n) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(n)].map((b) => chars[b % chars.length]).join('');
};
const debugId = () => randomBytes(7).toString('hex').slice(0, 13);

function json(status, body, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function error(status, name, message, issue, description, field) {
  return json(status, {
    name,
    message,
    debug_id: debugId(),
    ...(issue ? { details: [{ ...(field ? { field, location: 'body' } : {}), issue, description: description || issue }] } : {}),
    links: [{ href: `https://developer.paypal.com/docs/api/invoicing/v2/#error-${issue || name}`, rel: 'information_link', method: 'GET' }],
  });
}

const money = (currency_code, value) => ({ currency_code, value });
const fmt = (n, cur) => (['JPY', 'HUF', 'TWD'].includes(cur) ? Math.round(n).toFixed(0) : (Math.round(n * 100) / 100).toFixed(2));

export function createMockPayPal({ now = () => Date.now(), state: initial } = {}) {
  const state = initial || { invoices: {}, order: [], tokens: {}, numbers: {}, reminders: [] };

  const today = () => toISODate(now());
  const links = (inv) => {
    const self = `${BASE}/v2/invoicing/invoices/${inv.id}`;
    const l = [{ href: self, rel: 'self', method: 'GET' }];
    if (inv.status === 'DRAFT') l.push({ href: `${self}/send`, rel: 'send', method: 'POST' }, { href: self, rel: 'replace', method: 'PUT' }, { href: self, rel: 'delete', method: 'DELETE' });
    if (OPEN.has(inv.status)) l.push({ href: `${self}/remind`, rel: 'remind', method: 'POST' }, { href: `${self}/cancel`, rel: 'cancel', method: 'POST' });
    if (inv.status !== 'CANCELLED' && inv.status !== 'PAID' && inv.status !== 'MARKED_AS_PAID') l.push({ href: `${self}/payments`, rel: 'record-payment', method: 'POST' });
    return l;
  };
  const view = (inv) => {
    const { _internal, ...pub } = inv;
    return { ...structuredClone(pub), links: links(inv) };
  };

  function validateCreate(p) {
    if (!p || typeof p !== 'object') return ['/', 'MALFORMED_REQUEST_JSON'];
    const d = p.detail || {};
    if (!/^[A-Z]{3}$/.test(d.currency_code || '')) return ['/detail/currency_code', 'MISSING_REQUIRED_PARAMETER'];
    if (d.invoice_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.invoice_date)) return ['/detail/invoice_date', 'INVALID_PARAMETER_SYNTAX'];
    const pt = d.payment_term;
    if (pt && pt.term_type && !['DUE_ON_RECEIPT', 'DUE_ON_DATE_SPECIFIED', ...Object.keys(TERM_DAYS)].includes(pt.term_type)) return ['/detail/payment_term/term_type', 'INVALID_PARAMETER_VALUE'];
    if (pt && pt.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(pt.due_date)) return ['/detail/payment_term/due_date', 'INVALID_PARAMETER_SYNTAX'];
    if (!Array.isArray(p.items) || !p.items.length) return ['/items', 'MISSING_REQUIRED_PARAMETER'];
    for (let i = 0; i < p.items.length; i++) {
      const it = p.items[i];
      if (!it.name) return [`/items/${i}/name`, 'MISSING_REQUIRED_PARAMETER'];
      if (!/^\d+(\.\d{1,5})?$/.test(String(it.quantity))) return [`/items/${i}/quantity`, 'INVALID_PARAMETER_SYNTAX'];
      if (!it.unit_amount || !/^\d+(\.\d{1,2})?$/.test(String(it.unit_amount.value))) return [`/items/${i}/unit_amount/value`, 'INVALID_PARAMETER_SYNTAX'];
      if (it.unit_amount.currency_code !== d.currency_code) return [`/items/${i}/unit_amount/currency_code`, 'CURRENCY_MISMATCH'];
    }
    const r = p.primary_recipients && p.primary_recipients[0] && p.primary_recipients[0].billing_info;
    if (r && r.email_address && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email_address)) return ['/primary_recipients/0/billing_info/email_address', 'INVALID_PARAMETER_SYNTAX'];
    return null;
  }

  function create(p, prefer) {
    const bad = validateCreate(p);
    if (bad) return error(400, 'INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', bad[1], `Invalid value at ${bad[0]}`, bad[0]);
    const d = p.detail;
    if (d.invoice_number && state.numbers[d.invoice_number]) return error(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', 'DUPLICATE_INVOICE_NUMBER', 'Invoice number already exists.');
    const id = `INV2-${alnum(4)}-${alnum(4)}-${alnum(4)}-${alnum(4)}`;
    const invoiceDate = d.invoice_date || today();
    const pt = d.payment_term ? { ...d.payment_term } : undefined;
    if (pt && pt.term_type in TERM_DAYS && !pt.due_date) {
      const due = new Date(invoiceDate + 'T00:00:00Z');
      due.setUTCDate(due.getUTCDate() + TERM_DAYS[pt.term_type]);
      pt.due_date = toISODate(due);
    }
    if (pt && pt.due_date && pt.due_date < invoiceDate) return error(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', 'INVALID_DUE_DATE', 'Due date cannot be earlier than the invoice date.');
    const cur = d.currency_code;
    const total = p.items.reduce((s, it) => s + Number(it.quantity) * Number(it.unit_amount.value), 0);
    const nowIso = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const inv = {
      id,
      status: 'DRAFT',
      detail: {
        ...structuredClone(d),
        invoice_number: d.invoice_number || String(1000 + state.order.length + 1),
        invoice_date: invoiceDate,
        ...(pt ? { payment_term: pt } : {}),
        metadata: { create_time: nowIso, last_update_time: nowIso, created_by_flow: 'REGULAR_SINGLE', recipient_view_url: `${WEB}/invoice/p/#${id}`, invoicer_view_url: `${WEB}/invoice/details/${id}`, invoicer_view_url_template: `${WEB}/invoice/details/${id}` },
      },
      invoicer: structuredClone(p.invoicer || {}),
      primary_recipients: structuredClone(p.primary_recipients || []),
      items: p.items.map((it) => ({ id: `ITEM-${alnum(17)}`, ...structuredClone(it) })),
      configuration: structuredClone(p.configuration || {}),
      amount: { ...money(cur, fmt(total, cur)), breakdown: { item_total: money(cur, fmt(total, cur)) } },
      due_amount: money(cur, fmt(total, cur)),
      unilateral: false,
      _internal: { total },
    };
    state.invoices[id] = inv;
    state.order.unshift(id);
    state.numbers[inv.detail.invoice_number] = id;
    if (prefer === 'return=representation') return json(201, view(inv));
    return json(201, { rel: 'self', href: `${BASE}/v2/invoicing/invoices/${id}`, method: 'GET' });
  }

  function find(id) {
    return state.invoices[id] || null;
  }
  const notFound = () => error(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.', 'INVALID_RESOURCE_ID', 'Requested resource ID was not found.');
  const unprocessable = (issue, description) => error(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', issue, description);

  function send(inv, body) {
    if (inv.status !== 'DRAFT' && inv.status !== 'SCHEDULED') return unprocessable('CANNOT_SEND_INVOICE', `Invoice in ${inv.status} status cannot be sent.`);
    const r = inv.primary_recipients[0] && inv.primary_recipients[0].billing_info;
    if ((body.send_to_recipient ?? true) && !(r && r.email_address)) return unprocessable('MISSING_RECIPIENT_EMAIL', 'A recipient email address is required to send the invoice.');
    const ts = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    inv.status = 'SENT';
    Object.assign(inv.detail.metadata, { first_sent_time: inv.detail.metadata.first_sent_time || ts, last_sent_time: ts, last_update_time: ts, last_sent_by: 'invoicer' });
    const payerView = { href: inv.detail.metadata.recipient_view_url, rel: 'payer-view', method: 'GET' };
    return body.send_to_recipient === false ? json(202, { links: [payerView] }) : json(200, { links: [payerView] });
  }

  function remind(inv, body) {
    if (!OPEN.has(inv.status)) return unprocessable('INVALID_INVOICE_STATUS', `A reminder cannot be sent for an invoice in ${inv.status} status.`);
    const ts = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    inv.detail.metadata.last_update_time = ts;
    state.reminders.push({ id: inv.id, at: ts, subject: body.subject || null, note: body.note || null });
    return json(204, null);
  }

  function addPayment(inv, { method, payment_date, amount, note }, type) {
    const cur = inv.detail.currency_code;
    const due = Number(inv.due_amount.value);
    const value = amount && amount.value ? Number(amount.value) : due;
    const tx = { payment_id: type === 'PAYPAL' ? alnum(17) : `EXTR-${alnum(16)}`, payment_date: payment_date || today(), method, type, amount: money(cur, fmt(value, cur)), ...(note ? { note } : {}) };
    const prevPaid = inv.payments ? Number(inv.payments.paid_amount.value) : 0;
    inv.payments = { paid_amount: money(cur, fmt(prevPaid + value, cur)), transactions: [...(inv.payments ? inv.payments.transactions : []), tx] };
    const left = Math.max(0, due - value);
    inv.due_amount = money(cur, fmt(left, cur));
    inv.status = left > 0.004 ? 'PARTIALLY_PAID' : type === 'PAYPAL' ? 'PAID' : 'MARKED_AS_PAID';
    inv.detail.metadata.last_update_time = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return tx;
  }

  function recordPayment(inv, body) {
    if (!body || !METHODS.has(body.method)) return error(400, 'INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', 'INVALID_PARAMETER_VALUE', 'method is required and must be a supported payment method.', '/method');
    if (['PAID', 'MARKED_AS_PAID', 'CANCELLED', 'REFUNDED'].includes(inv.status)) return unprocessable('INVALID_INVOICE_STATUS', `A payment cannot be recorded for an invoice in ${inv.status} status.`);
    if (body.amount && Number(body.amount.value) > Number(inv.due_amount.value) + 0.004) return unprocessable('PAYMENT_AMOUNT_EXCEEDS_DUE', 'The payment amount exceeds the amount due.');
    const tx = addPayment(inv, body, 'EXTERNAL');
    return json(200, { payment_id: tx.payment_id });
  }

  function list(url) {
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const size = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') || 20)));
    const ids = state.order.slice((page - 1) * size, page * size);
    const total = state.order.length;
    const body = { items: ids.map((id) => view(state.invoices[id])), links: [{ href: `${BASE}/v2/invoicing/invoices?page=${page}&page_size=${size}`, rel: 'self', method: 'GET' }] };
    if (url.searchParams.get('total_required') === 'true') Object.assign(body, { total_items: total, total_pages: Math.ceil(total / size) });
    return json(200, body);
  }

  async function mockFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const path = url.pathname;

    if (path === '/v1/oauth2/token' && method === 'POST') {
      const auth = headers.authorization || '';
      const decoded = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
      if (!decoded.includes(':') || decoded.startsWith(':') || decoded.endsWith(':')) return json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      if (!String(init.body || '').includes('grant_type=client_credentials')) return json(400, { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' });
      const tok = `A21AA${randomBytes(24).toString('base64url')}`;
      state.tokens[tok] = now() + 32400 * 1000;
      return json(200, { scope: 'https://uri.paypal.com/services/invoicing openid', access_token: tok, token_type: 'Bearer', app_id: 'APP-80W284485P519543T', expires_in: 32400, nonce: `${new Date(now()).toISOString()}${randomUUID().slice(0, 8)}` });
    }

    const bearer = (headers.authorization || '').replace(/^Bearer\s+/, '');
    if (!bearer || !(state.tokens[bearer] > now())) return json(401, { error: 'invalid_token', error_description: 'Token signature verification failed' });

    let body = {};
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        return error(400, 'INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', 'MALFORMED_REQUEST_JSON', 'The request JSON is not well formed.');
      }
    }

    if (path === '/v1/notifications/verify-webhook-signature' && method === 'POST') {
      return json(200, { verification_status: body.transmission_sig === 'mock-signature' ? 'SUCCESS' : 'FAILURE' });
    }

    if (path === '/v2/invoicing/invoices') {
      if (method === 'POST') return create(body, headers.prefer);
      if (method === 'GET') return list(url);
    }
    const m = path.match(/^\/v2\/invoicing\/invoices\/([A-Z0-9-]+)(?:\/(send|remind|payments))?$/);
    if (m) {
      const inv = find(m[1]);
      if (!inv) return notFound();
      if (!m[2] && method === 'GET') return json(200, view(inv));
      if (m[2] === 'send' && method === 'POST') return send(inv, body);
      if (m[2] === 'remind' && method === 'POST') return remind(inv, body);
      if (m[2] === 'payments' && method === 'POST') return recordPayment(inv, body);
    }
    return error(404, 'NOT_FOUND', 'The specified resource does not exist.', 'INVALID_RESOURCE_ID', `No route for ${method} ${path}`);
  }

  return {
    fetch: mockFetch,
    state,
    // Demo-only: the client pays the invoice through the PayPal payer page.
    simulatePayerPayment(id, { amount } = {}) {
      const inv = find(id);
      if (!inv) throw new Error('No such invoice in the PayPal mock');
      if (!OPEN.has(inv.status)) throw new Error(`Invoice is ${inv.status}; only a sent, unpaid invoice can be paid`);
      return addPayment(inv, { method: 'PAYPAL', amount: amount ? { value: String(amount) } : undefined }, 'PAYPAL');
    },
    // Demo-only: the webhook PayPal would POST when an invoice is paid.
    webhookEvent(id, type = 'INVOICING.INVOICE.PAID') {
      const inv = find(id);
      return { id: `WH-${alnum(17)}`, event_version: '1.0', create_time: new Date(now()).toISOString(), resource_type: 'invoices', event_type: type, summary: `An invoice was ${type.split('.').pop().toLowerCase()}`, resource: { invoice: inv ? view(inv) : { id } } };
    },
    remindersSent(id) {
      return state.reminders.filter((r) => r.id === id);
    },
    reset() {
      for (const k of Object.keys(state)) state[k] = Array.isArray(state[k]) ? [] : {};
    },
  };
}
