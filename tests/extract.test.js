import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDeterministic, validateExtraction, missingFields, findMoney, parseTerms, extractPrompt, isInvoicer } from '../src/extract.js';
import { parseJsonLoose } from '../src/json.js';
import { parseLooseDate } from '../src/dates.js';
import { DEMO_CLIENTS } from '../src/demo.js';

const today = '2026-10-13';
const ex = (t, o = {}) => extractDeterministic(t, { today, ...o });

test('one-line brief: client, contact, email, item, amount, terms', () => {
  const x = ex('Built the Shopify theme for Acme Outfitters, $1,800, net 15, contact jo@acme.test');
  assert.equal(x.client.name, 'Acme Outfitters');
  assert.equal(x.client.contact, 'Jo');
  assert.equal(x.client.email, 'jo@acme.test');
  assert.deepEqual(x.items.map((i) => [i.name, i.quantity, i.unitAmount]), [['Shopify theme', 1, 1800]]);
  assert.equal(x.total, 1800);
  assert.equal(x.currency, 'USD');
  assert.deepEqual([x.terms.type, x.terms.days, x.terms.assumed], ['NET', 15, false]);
});

test('email thread: sender is the client, company found in the signature, two line items', () => {
  const x = ex(DEMO_CLIENTS[1].brief);
  assert.equal(x.client.name, 'Brightline Dental');
  assert.equal(x.client.contact, 'Dana Whitfield');
  assert.equal(x.client.email, 'dana@brightlinedental.test');
  assert.deepEqual(x.items.map((i) => [i.name, i.unitAmount]), [['Website refresh', 2150], ['Hosting setup', 250]]);
  assert.equal(x.items[0].description, '6 pages + booking widget');
  assert.equal(x.total, 2400);
  assert.equal(x.terms.days, 30);
});

test('hourly work becomes quantity x rate; "due in N days" terms', () => {
  const x = ex(DEMO_CLIENTS[2].brief);
  assert.equal(x.client.name, 'Juniper & Rye Bakery');
  assert.deepEqual(x.items.map((i) => [i.quantity, i.unitAmount, i.unit]), [[12, 55, 'HOURS']]);
  assert.equal(x.total, 660);
  assert.deepEqual([x.terms.type, x.terms.days], ['NET', 7]);
});

test('contact in parentheses after a generic AP mailbox', () => {
  const x = ex(DEMO_CLIENTS[3].brief);
  assert.equal(x.client.name, 'Northwind Labs');
  assert.equal(x.client.contact, 'Marcus Lee');
  assert.equal(x.client.email, 'ap@northwindlabs.test');
  assert.equal(x.items[0].name, 'October retainer');
});

test('currency codes, a specific due date and a PO reference', () => {
  const x = ex('Invoice Blue Heron Films for color grading, EUR 900 plus 3 hours at €80/hr, due by Nov 20. PO 4471-B. marta@blueheron.test');
  assert.equal(x.client.name, 'Blue Heron Films');
  assert.equal(x.currency, 'EUR');
  assert.equal(x.total, 1140);
  assert.deepEqual([x.terms.type, x.terms.dueDate], ['DUE_ON_DATE', '2026-11-20']);
  assert.equal(x.reference, '4471-B');
});

test('bare numbers are not money; k suffix and words are', () => {
  assert.deepEqual(findMoney('6 pages, net 15, 12 hours').map((m) => m.value), []);
  assert.deepEqual(findMoney('$2k for design and 300 bucks for hosting').map((m) => m.value), [2000, 300]);
  assert.deepEqual(findMoney('£450.50').map((m) => [m.value, m.currency]), [[450.5, 'GBP']]);
});

test('deposits already paid and stated totals are not line items', () => {
  const x = ex('Mural for Oak & Ash Cafe, $3,000; deposit of $1,000 already paid. Net 10. owner@oakandash.test');
  assert.deepEqual(x.items.map((i) => i.unitAmount), [3000]);
  const y = ex('Design $400, dev $600, total $1,000, due on receipt, a@b.test for Pine Co');
  assert.deepEqual(y.items.map((i) => i.unitAmount), [400, 600]);
  assert.equal(y.total, 1000);
  assert.equal(y.terms.type, 'DUE_ON_RECEIPT');
});

test('the freelancer’s own email is never the billing email', () => {
  const x = ex('From: me@rivera.test\nTo: kim@client.test\nLogo for Client Co, $500', { invoicerEmail: 'me@rivera.test' });
  assert.equal(x.client.email, 'kim@client.test');
});

test('missing terms are assumed Net 15 and flagged; missing email is reported', () => {
  const x = ex('logo for my cousin, 300 bucks');
  assert.equal(x.terms.assumed, true);
  assert.match(x.warnings.join(' '), /assumed Net 15/);
  assert.deepEqual(missingFields(x), ['client email', 'client name']);
  assert.deepEqual(missingFields(ex('hello there')), ['amount', 'client email', 'client name']);
});

test('terms parser covers the usual phrasings', () => {
  assert.equal(parseTerms('payment within 2 weeks', today).days, 14);
  assert.equal(parseTerms('Net-30', today).days, 30);
  assert.equal(parseTerms('due upon receipt', today).type, 'DUE_ON_RECEIPT');
  assert.equal(parseTerms('due on October 30', today).dueDate, '2026-10-30');
  assert.equal(parseLooseDate('Jan 5', today), '2027-01-05');
  assert.equal(parseLooseDate('10/30/2026', today), '2026-10-30');
  assert.equal(parseLooseDate('Feb 30', today), null);
});

// ---- the LLM path ----

const brief = 'Built the Shopify theme for Acme Outfitters, $1,800, net 15, contact jo@acme.test';

test('valid model JSON is accepted field by field', () => {
  const raw = { client: { name: 'Acme Outfitters Inc.', contact: 'Jo Park', email: 'jo@acme.test' }, items: [{ name: 'Shopify theme build', description: 'Custom theme', quantity: 1, unit_amount: 1800 }], currency: 'USD', terms: { type: 'NET', days: 15 }, note: 'Thanks, Jo!' };
  const { extraction, problems } = validateExtraction(raw, { text: brief, today });
  assert.deepEqual(problems, []);
  assert.equal(extraction.client.name, 'Acme Outfitters Inc.');
  assert.equal(extraction.items[0].name, 'Shopify theme build');
  assert.equal(extraction.total, 1800);
  assert.equal(extraction.sources.items, 'llm');
  assert.equal(extraction.note, 'Thanks, Jo!');
});

test('an amount the model invented is rejected and the reader’s items are kept', () => {
  const raw = { client: { name: 'Acme', email: 'jo@acme.test' }, items: [{ name: 'Theme', quantity: 1, unit_amount: 18000 }], currency: 'USD' };
  const { extraction, problems } = validateExtraction(raw, { text: brief, today });
  assert.equal(extraction.total, 1800);
  assert.equal(extraction.sources.items, 'fallback');
  assert.match(problems.join(' '), /18000 is not in the brief/);
});

test('an email the model invented is rejected', () => {
  const raw = { client: { name: 'Acme', email: 'billing@acme.com' }, items: [{ name: 'Theme', quantity: 1, unit_amount: 1800 }] };
  const { extraction, problems } = validateExtraction(raw, { text: brief, today });
  assert.equal(extraction.client.email, 'jo@acme.test');
  assert.match(problems.join(' '), /not in the brief/);
});

test('garbage from the model falls back to the rule-based reader entirely', () => {
  for (const raw of [null, 'nope', [], 42]) {
    const { extraction, problems } = validateExtraction(raw, { text: brief, today });
    assert.equal(extraction.total, 1800);
    assert.equal(extraction.client.email, 'jo@acme.test');
    assert.ok(problems.length > 0);
  }
});

test('hourly item from the model passes when rate x hours matches the brief', () => {
  const t = 'Logo refresh for Juniper & Rye Bakery - 12 hours at $55/hr. priya@juniperandrye.test';
  const { extraction } = validateExtraction({ items: [{ name: 'Logo refresh', quantity: 12, unit_amount: 55, unit: 'HOURS' }] }, { text: t, today });
  assert.equal(extraction.sources.items, 'llm');
  assert.equal(extraction.total, 660);
});

test('tolerant JSON parsing: fences, prose, trailing commas, smart quotes, truncation', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! Here it is: {"a": {"b": "c}"}} hope that helps'), { a: { b: 'c}' } });
  assert.deepEqual(parseJsonLoose('{"a": [1, 2,], }'), { a: [1, 2] });
  assert.deepEqual(parseJsonLoose('{“a”: “b”}'), { a: 'b' });
  assert.equal(parseJsonLoose('{"a": [1, 2'), null);
  assert.equal(parseJsonLoose('no json'), null);
  assert.equal(parseJsonLoose(''), null);
});

test('the invoicer is never the client contact (Hi Sam -> not "Sam")', () => {
  const text = 'Hi Sam, thanks for the logo work. Please bill $600, net 15. - Priya, priya@lumen.test';
  const opts = { text, today, invoicerName: 'Sam Rivera', invoicerBusiness: 'Rivera Studio' };
  const { extraction, problems } = validateExtraction({ client: { name: 'Sam Rivera', contact: 'Sam', email: 'priya@lumen.test' } }, opts);
  assert.equal(extraction.client.contact, 'Priya');
  assert.notEqual(extraction.client.name, 'Sam Rivera');
  assert.ok(problems.some((p) => p.includes('contact "Sam" is the invoicer')));
  assert.ok(isInvoicer('rivera', 'Sam Rivera'));
  assert.ok(!isInvoicer('Samantha', 'Sam Rivera'));
  assert.equal(ex('Logo, $600, net 15, contact sam@lumen.test', { invoicerName: 'Sam Rivera' }).client.contact, null);
  assert.match(extractPrompt(text, today, opts), /invoicer .* is Sam Rivera of Rivera Studio/);
});
