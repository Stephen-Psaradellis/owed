// The PayPal fake's contract, and the agent end to end against it:
// create -> send -> remind -> paid stops reminders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockPayPal } from '../src/mock/paypal-mock.js';
import { createPayPalClient, PayPalError } from '../src/paypal.js';
import { makeApp, makeClock, NOW } from './helpers.js';

const BASE = 'https://api-m.sandbox.paypal.com';
const payload = (n = 'T-1') => ({
  detail: { invoice_number: n, invoice_date: '2026-10-13', currency_code: 'USD', payment_term: { term_type: 'NET_15' } },
  primary_recipients: [{ billing_info: { email_address: 'jo@acme.test' } }],
  items: [{ name: 'Theme', quantity: '2', unit_amount: { currency_code: 'USD', value: '900.00' } }],
});

function client(mock, trace = () => {}) {
  return createPayPalClient({ baseUrl: BASE, clientId: 'id', clientSecret: 'secret', fetchImpl: mock.fetch, trace, now: () => NOW });
}

test('PayPal fake: OAuth is required and checked', async () => {
  const mock = createMockPayPal({ now: () => NOW });
  const noAuth = await mock.fetch(`${BASE}/v2/invoicing/invoices`, { method: 'GET' });
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json()).error, 'invalid_token');
  const badClient = await mock.fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(':').toString('base64') }, body: 'grant_type=client_credentials' });
  assert.equal(badClient.status, 401);
  const tok = await (await mock.fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('a:b').toString('base64') }, body: 'grant_type=client_credentials' })).json();
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(tok.expires_in, 32400);
});

test('PayPal fake: create (both Prefer modes), send, get, list, remind, record payment', async () => {
  const mock = createMockPayPal({ now: () => NOW });
  const calls = [];
  const pp = client(mock, (e) => calls.push(e));
  const inv = await pp.createInvoice(payload());
  assert.match(inv.id, /^INV2(-[A-Z0-9]{4}){4}$/);
  assert.equal(inv.status, 'DRAFT');
  assert.equal(inv.amount.value, '1800.00');
  assert.equal(inv.detail.payment_term.due_date, '2026-10-28');
  assert.equal(inv.detail.metadata.recipient_view_url, `https://www.sandbox.paypal.com/invoice/p/#${inv.id}`);

  // Without Prefer: return=representation PayPal answers with a self link.
  const tok = await (await mock.fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('a:b').toString('base64') }, body: 'grant_type=client_credentials' })).json();
  const minimal = await mock.fetch(`${BASE}/v2/invoicing/invoices`, { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify(payload('T-2')) });
  assert.equal(minimal.status, 201);
  const link = await minimal.json();
  assert.equal(link.rel, 'self');
  assert.match(link.href, /\/v2\/invoicing\/invoices\/INV2-/);

  const sent = await pp.sendInvoice(inv.id);
  assert.equal(sent.links[0].rel, 'payer-view');
  assert.equal((await pp.getInvoice(inv.id)).status, 'SENT');

  const list = await pp.listInvoices({ pageSize: 1 });
  assert.equal(list.total_items, 2);
  assert.equal(list.total_pages, 2);
  assert.equal(list.items.length, 1);

  assert.deepEqual(await pp.remind(inv.id, { subject: 's', note: 'n' }), {});
  assert.equal(mock.remindersSent(inv.id).length, 1);

  const pay = await pp.recordPayment(inv.id, { method: 'BANK_TRANSFER', amount: { currency_code: 'USD', value: '1800.00' } });
  assert.match(pay.payment_id, /^EXTR-/);
  const paid = await pp.getInvoice(inv.id);
  assert.equal(paid.status, 'MARKED_AS_PAID');
  assert.equal(paid.due_amount.value, '0.00');
  assert.equal(paid.payments.transactions[0].type, 'EXTERNAL');

  // every call is traced, with the toolkit tool names, and the token call first
  assert.equal(calls[0].tool, 'oauth2_token');
  assert.ok(['create_invoice', 'send_invoice', 'get_invoice', 'list_invoices', 'send_invoice_reminder', 'record_payment_for_invoice'].every((t) => calls.some((c) => c.tool === t)));
});

test('PayPal fake: business rules and error shapes', async () => {
  const mock = createMockPayPal({ now: () => NOW });
  const pp = client(mock);
  const inv = await pp.createInvoice(payload());
  await assert.rejects(pp.remind(inv.id, {}), (e) => e instanceof PayPalError && e.status === 422 && e.issue === 'INVALID_INVOICE_STATUS');
  await assert.rejects(pp.createInvoice(payload()), (e) => e.status === 422 && e.issue === 'DUPLICATE_INVOICE_NUMBER');
  await assert.rejects(pp.getInvoice('INV2-NOPE-NOPE-NOPE-NOPE'), (e) => e.status === 404 && e.paypalName === 'RESOURCE_NOT_FOUND' && /^[0-9a-f]{13}$/.test(e.debugId));
  const bad = payload('T-9');
  bad.items[0].unit_amount.value = '9.999';
  await assert.rejects(pp.createInvoice(bad), (e) => e.status === 400 && e.issue === 'INVALID_PARAMETER_SYNTAX');
  const mismatch = payload('T-10');
  mismatch.items[0].unit_amount.currency_code = 'EUR';
  await assert.rejects(pp.createInvoice(mismatch), (e) => e.issue === 'CURRENCY_MISMATCH');
  await pp.sendInvoice(inv.id);
  await assert.rejects(pp.sendInvoice(inv.id), (e) => e.issue === 'CANNOT_SEND_INVOICE');
  mock.simulatePayerPayment(inv.id);
  assert.equal((await pp.getInvoice(inv.id)).status, 'PAID');
  await assert.rejects(pp.remind(inv.id, {}), (e) => e.status === 422);
  await assert.rejects(pp.recordPayment(inv.id, { method: 'CASH' }), (e) => e.status === 422);
});

test('end to end: create -> send -> remind -> client pays -> reminders stop', async () => {
  const clock = makeClock();
  const { app } = makeApp({ clock });
  const { agent, mock } = app;
  const v = await agent.createInvoice({ text: 'Built the Shopify theme for Acme Outfitters, $1,800, net 15, contact jo@acme.test' });
  assert.equal(v.status, 'SENT');
  assert.equal(mock.state.invoices[v.paypalId].status, 'SENT');
  assert.equal(v.dueDate, '2026-10-28');
  assert.deepEqual(v.reminders.map((r) => [r.stage, r.status]), [['polite', 'planned'], ['firm', 'planned'], ['final', 'planned']]);
  assert.ok(v.reminders.every((r) => r.subject && r.body.includes(v.number)));

  // Nothing is due today.
  let t = await agent.tick();
  assert.equal(t.remindersSent.length, 0);

  // Polite reminder date arrives.
  clock.set(Date.parse(v.reminders[0].scheduledAt + 'T09:00:00Z'));
  t = await agent.tick();
  assert.deepEqual(t.remindersSent.map((r) => r.stage), ['polite']);
  assert.equal(mock.remindersSent(v.paypalId).length, 1);
  assert.match(mock.remindersSent(v.paypalId)[0].subject, /Friendly reminder/);

  // A second tick on the same day sends nothing more.
  t = await agent.tick();
  assert.equal(t.remindersSent.length, 0);

  // The client pays on PayPal; the agent learns it from get_invoice and stops the rest.
  mock.simulatePayerPayment(v.paypalId);
  clock.set(Date.parse(v.reminders[1].scheduledAt + 'T09:00:00Z'));
  t = await agent.tick();
  assert.equal(t.paid.length, 1);
  assert.equal(t.paid[0].stopped, 2);
  assert.equal(t.remindersSent.length, 0);
  const after = agent.ledger().invoices[0];
  assert.equal(after.status, 'PAID');
  assert.deepEqual(after.reminders.map((r) => r.status), ['sent', 'cancelled', 'cancelled']);
  assert.equal(after.display.code, 'paid');

  // Final date: still nothing, and PayPal saw exactly one reminder in total.
  clock.set(Date.parse(v.reminders[2].scheduledAt + 'T09:00:00Z'));
  await agent.tick();
  assert.equal(mock.remindersSent(v.paypalId).length, 1);
});

test('a late tick sends only the most advanced due stage, reworded for today', async () => {
  const clock = makeClock();
  const { app } = makeApp({ clock });
  const v = await app.agent.createInvoice({ text: 'Logo for Pine Co, $800, net 10, kim@pine.test' });
  clock.advanceDays(40); // the server was off for weeks
  const t = await app.agent.tick();
  assert.deepEqual(t.remindersSent.map((r) => r.stage), ['final']);
  assert.equal(app.mock.remindersSent(v.paypalId).length, 1);
  const inv = app.agent.ledger().invoices[0];
  assert.deepEqual(inv.reminders.map((r) => r.status), ['skipped', 'skipped', 'sent']);
  assert.match(inv.reminders[2].body, /30 days overdue/);
});

test('mark paid records the payment on PayPal and stops reminders', async () => {
  const { app } = makeApp();
  const v = await app.agent.createInvoice({ text: 'Logo for Pine Co, $800, net 10, kim@pine.test' });
  const out = await app.agent.markPaid(v.id, { method: 'CHECK' });
  assert.equal(out.status, 'MARKED_AS_PAID');
  assert.ok(out.reminders.every((r) => r.status === 'cancelled'));
  assert.equal(app.mock.state.invoices[v.paypalId].payments.transactions[0].method, 'CHECK');
  await assert.rejects(app.agent.markPaid(v.id), /already/);
});

test('remind now sends the next stage early and refuses once paid', async () => {
  const { app } = makeApp();
  const v = await app.agent.createInvoice({ text: 'Logo for Pine Co, $800, net 10, kim@pine.test' });
  const out = await app.agent.remindNow(v.id);
  assert.deepEqual(out.reminders.map((r) => r.status), ['sent', 'planned', 'planned']);
  assert.equal(app.mock.remindersSent(v.paypalId).length, 1);
  app.mock.simulatePayerPayment(v.paypalId);
  await assert.rejects(app.agent.remindNow(v.id), /already paid/);
  assert.equal(app.mock.remindersSent(v.paypalId).length, 1);
});

test('rescheduling (the timeline drag) validates and rewrites the draft', async () => {
  const { app } = makeApp();
  const v = await app.agent.createInvoice({ text: 'Built the Shopify theme for Acme Outfitters, $1,800, net 15, contact jo@acme.test' });
  const polite = v.reminders[0];
  assert.match(polite.body, /in 2 days/);
  const out = await app.agent.reschedule(polite.id, '2026-10-30');
  const moved = out.reminders[0];
  assert.equal(moved.scheduledAt, '2026-10-30');
  assert.equal(moved.moved, true);
  assert.match(moved.body, /2 days overdue/);
  await assert.rejects(app.agent.reschedule(polite.id, '2026-10-01'), /past/);
  await assert.rejects(app.agent.reschedule('nope', '2026-10-20'), /not found/);
  const tl = app.agent.timeline();
  const ev = tl.events.find((e) => e.id === polite.id);
  assert.equal(ev.startDate, '2026-10-30');
  assert.equal(ev.draggable, true);
});

test('webhook: the agent confirms with PayPal before acting', async () => {
  const { app } = makeApp();
  const v = await app.agent.createInvoice({ text: 'Logo for Pine Co, $800, net 10, kim@pine.test' });
  // A forged "paid" event for an invoice PayPal still shows as SENT changes nothing.
  const forged = await app.agent.handleWebhook(app.mock.webhookEvent(v.paypalId));
  assert.equal(forged.status, 'SENT');
  assert.equal(app.agent.ledger().invoices[0].reminders.filter((r) => r.status === 'planned').length, 3);
  app.mock.simulatePayerPayment(v.paypalId);
  const real = await app.agent.handleWebhook(app.mock.webhookEvent(v.paypalId));
  assert.equal(real.status, 'PAID');
  assert.equal(real.stopped, 3);
  assert.deepEqual(await app.agent.handleWebhook({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'x' } }), { ignored: true });
});

test('chat: briefs preview then create, questions get answers, missing facts are asked for', async () => {
  const { app } = makeApp();
  const p = await app.agent.chat('Built a landing page for Fernhill Yoga, $950, due in 10 days, contact mia@fernhillyoga.test');
  assert.equal(p.type, 'preview');
  assert.equal(p.data.extraction.total, 950);
  assert.equal(p.data.dueDate, '2026-10-23');
  assert.equal(app.agent.ledger().invoices.length, 0, 'preview must not bill');
  const created = await app.agent.createInvoice({ previewId: p.data.previewId });
  assert.equal(created.client.name, 'Fernhill Yoga');
  await assert.rejects(app.agent.createInvoice({ previewId: p.data.previewId }), /expired/);

  const need = await app.agent.chat('Website for my neighbour, $400, net 15');
  assert.equal(need.type, 'needs_input');
  assert.match(need.text, /client email/);

  const a = await app.agent.chat('Who owes me what?');
  assert.equal(a.type, 'answer');
  assert.match(a.text, /\$950/);

  const paid = await app.agent.chat('Fernhill paid me by bank transfer');
  assert.equal(paid.type, 'action');
  assert.equal(app.agent.ledger().invoices[0].status, 'MARKED_AS_PAID');
});

test('Run demo: four clients, one overdue reminder sent, one payment detected', async () => {
  const { app } = makeApp();
  const r = await app.agent.seedDemo();
  assert.equal(r.created, 4);
  assert.deepEqual(r.tick.remindersSent.map((x) => [x.client, x.stage]), [['Brightline Dental', 'firm']]);
  assert.deepEqual(r.tick.paid.map((x) => x.client), ['Juniper & Rye Bakery']);
  const { totals, invoices } = app.agent.ledger();
  assert.equal(totals.primary.owed, 8700);
  assert.equal(totals.primary.overdue, 2400);
  assert.equal(totals.primary.paid, 660);
  assert.equal(invoices[0].client.name, 'Brightline Dental', 'overdue first');
  const tl = app.agent.timeline();
  assert.equal(tl.resources.length, 4);
  assert.ok(tl.events.some((e) => e.kind === 'overdue'));
  assert.ok(tl.events.some((e) => e.kind === 'paid'));
  assert.ok(tl.events.filter((e) => e.kind === 'reminder' && e.draggable).length >= 6);
  // Running it again starts clean.
  await app.agent.seedDemo();
  assert.equal(app.agent.ledger().invoices.length, 4);
});

test('a live LLM answer that cites a figure not in the ledger is replaced by the computed one', async () => {
  const fakeLLM = async (url) => {
    assert.match(String(url), /llm\.test/);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'You are owed $9,999 by everyone.' } }] }), { status: 200 });
  };
  const { app } = makeApp({ env: { LLM_BASE_URL: 'https://llm.test/v1', LLM_MODEL: 'm' }, fetchImpl: fakeLLM });
  // the fake model cannot extract either, so the rule-based reader bills the brief
  const v = await app.agent.createInvoice({ text: 'Logo for Pine Co, $800, net 10, kim@pine.test' });
  assert.equal(v.amount, 800);
  const a = await app.agent.answer('who owes me?');
  assert.doesNotMatch(a.text, /9,999/);
  assert.match(a.text, /\$800/);
});
