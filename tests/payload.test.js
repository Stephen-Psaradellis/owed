import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoicePayload, makeInvoiceNumber, splitName } from '../src/invoice-payload.js';
import { extractDeterministic, termsFromDays, paypalTermType, dueDateFor } from '../src/extract.js';
import { toPayPalValue, formatMoney } from '../src/money.js';

const today = '2026-10-13';
const invoicer = { name: 'Sam Rivera', businessName: 'Rivera Studio' };
const build = (brief, date = today) => buildInvoicePayload({ extraction: extractDeterministic(brief, { today }), invoicer, invoiceNumber: 'OWED-261013-0001', invoiceDate: date });

test('amounts are decimal strings in the invoice currency', () => {
  const { payload, total } = build('Website refresh for Pine Co, $2,150.5 and hosting $249.99, net 30, kim@pine.test');
  assert.deepEqual(payload.items.map((i) => i.unit_amount), [{ currency_code: 'USD', value: '2150.50' }, { currency_code: 'USD', value: '249.99' }]);
  assert.equal(payload.items[0].quantity, '1');
  assert.equal(total, 2400.49);
  assert.equal(payload.detail.currency_code, 'USD');
});

test('hourly items keep quantity and HOURS unit', () => {
  const { payload, total } = build('Logo refresh for Juniper & Rye Bakery - 12.5 hours at $55/hr, net 15, priya@juniperandrye.test');
  assert.equal(payload.items[0].quantity, '12.5');
  assert.equal(payload.items[0].unit_of_measure, 'HOURS');
  assert.equal(payload.items[0].unit_amount.value, '55.00');
  assert.equal(total, 687.5);
});

test('zero-decimal currencies have no decimals', () => {
  assert.equal(toPayPalValue(15000.4, 'JPY'), '15000');
  assert.equal(toPayPalValue(19.999, 'USD'), '20.00');
  assert.equal(formatMoney(1800, 'USD'), '$1,800');
  assert.equal(formatMoney(1800.5, 'EUR'), '€1,800.50');
});

test('PayPal NET terms map to NET_n with the computed due date', () => {
  const { payload, dueDate } = build('Shopify theme for Acme, $1,800, net 15, jo@acme.test');
  assert.deepEqual(payload.detail.payment_term, { term_type: 'NET_15', due_date: '2026-10-28' });
  assert.equal(dueDate, '2026-10-28');
});

test('non-standard day counts become DUE_ON_DATE_SPECIFIED', () => {
  const { payload } = build('Brand kit for Juniper & Rye Bakery, $660, due in 7 days, priya@juniperandrye.test');
  assert.deepEqual(payload.detail.payment_term, { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-20' });
});

test('due on receipt has no due_date; a specific date is kept', () => {
  assert.deepEqual(build('Fix for Pine Co, $90, due on receipt, kim@pine.test').payload.detail.payment_term, { term_type: 'DUE_ON_RECEIPT' });
  assert.deepEqual(build('Fix for Pine Co, $90, due by Dec 1, kim@pine.test').payload.detail.payment_term, { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-12-01' });
});

test('due date is computed from the invoice date, not today (back-dated invoices)', () => {
  const { payload } = build('Retainer for Northwind Labs, $4,500, net 30, ap@northwindlabs.test', '2026-09-23');
  assert.equal(payload.detail.invoice_date, '2026-09-23');
  assert.equal(payload.detail.payment_term.due_date, '2026-10-23');
});

test('term helpers', () => {
  assert.equal(paypalTermType(termsFromDays(30)), 'NET_30');
  assert.equal(paypalTermType(termsFromDays(21)), 'DUE_ON_DATE_SPECIFIED');
  assert.equal(paypalTermType(termsFromDays(0)), 'DUE_ON_RECEIPT');
  assert.equal(dueDateFor(termsFromDays(45), '2026-12-20'), '2027-02-03');
  assert.equal(dueDateFor({ type: 'DUE_ON_DATE', dueDate: '2026-01-01' }, '2026-10-13'), '2026-10-13');
});

test('recipient and invoicer blocks follow the PayPal schema', () => {
  const { payload } = build('Built the Shopify theme for Acme Outfitters, $1,800, net 15, contact jo@acme.test');
  assert.deepEqual(payload.primary_recipients, [{ billing_info: { email_address: 'jo@acme.test', name: { given_name: 'Jo' }, business_name: 'Acme Outfitters' } }]);
  assert.deepEqual(payload.invoicer, { name: { given_name: 'Sam', surname: 'Rivera' }, business_name: 'Rivera Studio' });
  assert.equal(payload.detail.invoice_number, 'OWED-261013-0001');
  assert.equal(payload.configuration.partial_payment.allow_partial_payment, false);
});

test('refuses to build without an email, an amount or a valid date', () => {
  const noEmail = extractDeterministic('logo for Pine Co, $300', { today });
  assert.throws(() => buildInvoicePayload({ extraction: noEmail, invoicer, invoiceNumber: 'X', invoiceDate: today }), /email/);
  const noAmount = { ...extractDeterministic('logo for Pine Co, kim@pine.test', { today }) };
  assert.throws(() => buildInvoicePayload({ extraction: noAmount, invoicer, invoiceNumber: 'X', invoiceDate: today }), /line item/);
  assert.throws(() => buildInvoicePayload({ extraction: noEmail, invoicer, invoiceNumber: 'X', invoiceDate: '13/10/2026' }), /YYYY-MM-DD/);
});

test('helpers: invoice numbers and names', () => {
  assert.equal(makeInvoiceNumber('2026-10-13', 7), 'OWED-261013-0007');
  assert.deepEqual(splitName('Mary Ann Lee'), { given_name: 'Mary', surname: 'Ann Lee' });
  assert.equal(splitName(''), null);
});
