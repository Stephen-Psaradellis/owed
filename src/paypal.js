// PayPal Invoicing v2 client (sandbox). OAuth 2.0 client credentials, token cached until
// shortly before expiry, one automatic retry on a 401, idempotency keys on every POST.
//
// The transport is injectable: in sandbox mode it is the real fetch against
// api-m.sandbox.paypal.com; in demo mode it is the in-memory fake in mock/paypal-mock.js,
// which serves the same endpoints with the same response shapes. Either way this file
// builds the same requests, so demo mode exercises the real integration code.
//
// Each method is named after the matching PayPal Agent Toolkit / MCP tool, and every
// call is traced as { tool, method, path, status, ms } with no credentials in it.
import { randomUUID } from 'node:crypto';

export class PayPalError extends Error {
  constructor(status, body, tool) {
    const name = (body && (body.name || body.error)) || `HTTP_${status}`;
    const issue = body && Array.isArray(body.details) && body.details[0] ? body.details[0].issue : null;
    const msg = (body && (body.message || body.error_description)) || 'PayPal request failed';
    super(`${tool}: ${status} ${name}${issue ? ` (${issue})` : ''}: ${msg}`);
    this.status = status;
    this.name = 'PayPalError';
    this.paypalName = name;
    this.issue = issue;
    this.debugId = body && body.debug_id;
  }
}

export function createPayPalClient({ baseUrl, clientId, clientSecret, fetchImpl = globalThis.fetch, trace = () => {}, now = () => Date.now() }) {
  let token = null; // { value, expiresAt }

  async function getToken(runId, force = false) {
    if (!force && token && token.expiresAt - 60000 > now()) return token.value;
    const t0 = Date.now();
    const res = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await readBody(res);
    trace({ runId, kind: 'paypal', tool: 'oauth2_token', method: 'POST', path: '/v1/oauth2/token', status: res.status, ms: Date.now() - t0, summary: res.ok ? `access token issued, expires in ${Math.round((body.expires_in || 0) / 3600)} h` : 'authentication failed' });
    if (!res.ok || !body.access_token) throw new PayPalError(res.status, body, 'oauth2_token');
    token = { value: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 };
    return token.value;
  }

  async function call(tool, method, path, { body, query, runId, summarize, prefer = true } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined)).toString() : '';
    const doFetch = async (tok) => {
      const headers = { Authorization: `Bearer ${tok}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method === 'POST') headers['PayPal-Request-Id'] = randomUUID();
      if (prefer) headers.Prefer = 'return=representation';
      return fetchImpl(`${baseUrl}${path}${qs}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    const t0 = Date.now();
    let res = await doFetch(await getToken(runId));
    if (res.status === 401) res = await doFetch(await getToken(runId, true));
    const data = await readBody(res);
    const entry = { runId, kind: 'paypal', tool, method, path: path + qs, status: res.status, ms: Date.now() - t0 };
    if (res.ok) entry.summary = summarize ? summarize(data) : undefined;
    else entry.summary = `${data.name || data.error || 'error'}${data.details && data.details[0] ? ` / ${data.details[0].issue}` : ''}${data.debug_id ? ` (debug_id ${data.debug_id})` : ''}`;
    if (body !== undefined) entry.request = body;
    trace(entry);
    if (!res.ok) throw new PayPalError(res.status, data, tool);
    return data;
  }

  const summarizeInvoice = (inv) => (inv && inv.id ? `${inv.id} ${inv.status} ${inv.amount ? `${inv.amount.value} ${inv.amount.currency_code}` : ''}`.trim() : undefined);

  return {
    baseUrl,
    // create_invoice: POST /v2/invoicing/invoices (draft)
    async createInvoice(payload, { runId } = {}) {
      const data = await call('create_invoice', 'POST', '/v2/invoicing/invoices', { body: payload, runId, summarize: (d) => (d.id ? `draft ${d.id} created` : `created: ${d.href || ''}`) });
      // Without Prefer: return=representation PayPal answers with a link; follow it.
      if (data && data.id) return data;
      const href = data && (data.href || (Array.isArray(data.links) && data.links.find((l) => l.rel === 'self')?.href));
      const id = href ? href.split('/').pop() : null;
      if (!id) throw new PayPalError(500, { name: 'UNEXPECTED_RESPONSE', message: 'create invoice returned no id' }, 'create_invoice');
      return this.getInvoice(id, { runId });
    },
    // send_invoice: POST /v2/invoicing/invoices/{id}/send
    async sendInvoice(id, { subject, note, runId } = {}) {
      return call('send_invoice', 'POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
        body: { send_to_invoicer: true, send_to_recipient: true, ...(subject ? { subject } : {}), ...(note ? { note } : {}) },
        runId,
        prefer: false,
        summarize: (d) => (d && d.links && d.links[0] ? `sent; payer link ${d.links[0].href}` : 'sent'),
      });
    },
    // get_invoice: GET /v2/invoicing/invoices/{id}
    async getInvoice(id, { runId } = {}) {
      return call('get_invoice', 'GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`, { runId, summarize: summarizeInvoice, prefer: false });
    },
    // list_invoices: GET /v2/invoicing/invoices
    async listInvoices({ page = 1, pageSize = 50, runId } = {}) {
      return call('list_invoices', 'GET', '/v2/invoicing/invoices', { query: { page, page_size: pageSize, total_required: true }, runId, prefer: false, summarize: (d) => `${d.total_items ?? (d.items || []).length} invoices` });
    },
    // send_invoice_reminder: POST /v2/invoicing/invoices/{id}/remind (204 No Content)
    async remind(id, { subject, note, runId } = {}) {
      return call('send_invoice_reminder', 'POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
        body: { subject, note, send_to_invoicer: false, send_to_recipient: true },
        runId,
        prefer: false,
        summarize: () => 'reminder emailed to the client by PayPal',
      });
    },
    // record_payment_for_invoice: POST /v2/invoicing/invoices/{id}/payments
    async recordPayment(id, { method = 'BANK_TRANSFER', paymentDate, amount, note, runId } = {}) {
      return call('record_payment_for_invoice', 'POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
        body: { method, ...(paymentDate ? { payment_date: paymentDate } : {}), ...(amount ? { amount } : {}), ...(note ? { note } : {}) },
        runId,
        prefer: false,
        summarize: (d) => `payment recorded ${d.payment_id || ''}`.trim(),
      });
    },
    // POST /v1/notifications/verify-webhook-signature
    async verifyWebhook({ headers, event, webhookId, runId }) {
      const h = (k) => headers[k] || headers[k.toLowerCase()];
      const data = await call('verify_webhook_signature', 'POST', '/v1/notifications/verify-webhook-signature', {
        body: {
          auth_algo: h('paypal-auth-algo'),
          cert_url: h('paypal-cert-url'),
          transmission_id: h('paypal-transmission-id'),
          transmission_sig: h('paypal-transmission-sig'),
          transmission_time: h('paypal-transmission-time'),
          webhook_id: webhookId,
          webhook_event: event,
        },
        runId,
        prefer: false,
        summarize: (d) => `verification ${d.verification_status}`,
      });
      return data.verification_status === 'SUCCESS';
    },
  };
}

async function readBody(res) {
  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}
